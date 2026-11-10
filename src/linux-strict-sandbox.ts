import { lstatSync, realpathSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";

export interface LinuxSandboxPolicy {
	readPaths: string[];
	writePaths: string[];
	denyWrite: string[];
}

interface ExistingPath {
	path: string;
	isDirectory: boolean;
}

const KNOWN_SYMLINK_ALIASES = [
	"/bin", "/sbin", "/lib", "/lib64",
	"/etc/resolv.conf", "/etc/localtime", "/etc/ssl/cert.pem",
] as const;
const PROTECTED_MOUNTS = ["/proc", "/dev", "/sys"] as const;

function pathDepth(path: string): number {
	return path.split("/").filter(Boolean).length;
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function hasGlob(path: string): boolean {
	// policy.ts gives wildcard semantics only to '*'; all other characters are
	// ordinary Linux filename characters and are passed literally to bwrap.
	return path.includes("*");
}

function validatePath(path: string, description: string): void {
	if (hasGlob(path)) {
		throw new Error(`Linux strict sandbox does not support glob ${description}: ${path}`);
	}
	if (
		!isAbsolute(path) ||
		path.includes("\0") ||
		posix.normalize(path) !== path
	) {
		throw new Error(`${description} must be a canonical absolute path: ${path}`);
	}
}

function assertCanonicalExistingPath(path: string, description: string): ExistingPath | undefined {
	try {
		const actual = realpathSync.native(path);
		if (actual !== path) {
			throw new Error(`${description} must be canonical (real path is ${actual}): ${path}`);
		}
		return { path, isDirectory: statSync(path).isDirectory() };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
			(error as NodeJS.ErrnoException).code === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
}

function isReservedHostMount(path: string): boolean {
	return PROTECTED_MOUNTS.some((mount) => isWithin(path, mount));
}

function sortedPaths(paths: Iterable<string>): string[] {
	return [...paths].sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b));
}

/**
 * Build bwrap argv for a deliberately empty-root Linux sandbox. The only host
 * filesystems mounted are the supplied rules (plus minimal /proc and /dev);
 * ancestor directories are empty scaffolds and the root is made read-only.
 * Paths must already be canonical absolute paths, as produced by the caller's
 * policy resolver. The caller remains responsible for locating bwrap itself.
 */
export function buildLinuxSandboxArgs(
	policy: LinuxSandboxPolicy,
	command: string,
	shell: string,
	cwd: string,
): string[] {
	validatePath(cwd, "working directory");
	validatePath(shell, "shell path");

	const checkRules = (paths: string[], description: string) => {
		for (const path of paths) validatePath(path, description);
	};
	checkRules(policy.readPaths, "read rule");
	checkRules(policy.writePaths, "write rule");
	checkRules(policy.denyWrite, "denyWrite rule");

	const reads = new Map<string, ExistingPath>();
	for (const path of new Set(policy.readPaths)) {
		if (path === "/") throw new Error("Linux strict sandbox will not bind the host root as a read path");
		if (isReservedHostMount(path)) {
			throw new Error(`Linux strict sandbox reserves ${path}; host /proc, /dev, and /sys are never bound`);
		}
		const existing = assertCanonicalExistingPath(path, "Read path");
		if (existing) reads.set(path, existing);
	}

	const writes = new Map<string, ExistingPath>();
	for (const path of new Set(policy.writePaths)) {
		if (path === "/") throw new Error("Linux strict sandbox will not bind the host root as a write path");
		if (isReservedHostMount(path)) {
			throw new Error(`Linux strict sandbox reserves ${path}; host /proc, /dev, and /sys are never bound`);
		}
		const existing = assertCanonicalExistingPath(path, "Write path");
		if (!existing) {
			throw new Error(`Write path does not exist; create it before granting access: ${path}`);
		}
		writes.set(path, existing);
	}

	const denies = new Map<string, ExistingPath>();
	for (const path of new Set(policy.denyWrite)) {
		if (isReservedHostMount(path)) {
			throw new Error(`Linux strict sandbox reserves ${path}; host /proc, /dev, and /sys are never bound`);
		}
		const existing = assertCanonicalExistingPath(path, "denyWrite path");
		if (!existing) throw new Error(`denyWrite path does not exist: ${path}`);
		denies.set(path, existing);
	}

	// A write grant is also readable. Exact duplicate read/write entries are
	// represented by the writable bind; only read paths outside write grants
	// need a separate read-only mount.
	const mounts = new Map<string, { entry: ExistingPath; writable: boolean }>();
	for (const [path, entry] of writes) mounts.set(path, { entry, writable: true });
	for (const [path, entry] of reads) {
		// A write grant includes reads and writes below it. Do not add a nested
		// read-only bind that would accidentally revoke the broader write grant.
		if (![...writes.keys()].some((writePath) => isWithin(path, writePath))) {
			mounts.set(path, { entry, writable: false });
		}
	}
	// Anchor writable ancestors of denied paths as mountpoints. A read-only
	// file bind alone is insufficient: moving its unmounted parent could move
	// the protection away and allow recreating the original denied pathname.
	for (const deniedPath of denies.keys()) {
		let ancestor = dirname(deniedPath);
		while (ancestor !== "/") {
			if ([...writes.keys()].some((writePath) => isWithin(ancestor, writePath)) && !mounts.has(ancestor)) {
				const entry = assertCanonicalExistingPath(ancestor, "denyWrite ancestor");
				if (!entry?.isDirectory) throw new Error(`denyWrite ancestor is not a directory: ${ancestor}`);
				mounts.set(ancestor, { entry, writable: true });
			}
			ancestor = dirname(ancestor);
		}
	}
	const mountPaths = sortedPaths(mounts.keys());
	const safeAliases: Array<{ alias: string; target: string }> = [];
	for (const alias of KNOWN_SYMLINK_ALIASES) {
		// If a policy bind already exposes the alias location, it is visible as-is;
		// --symlink there would attempt to modify a read-only host mount.
		if (mountPaths.some((mountPath) => isWithin(alias, mountPath))) continue;
		try {
			if (!lstatSync(alias).isSymbolicLink()) continue;
			const linkTarget = readlinkSync(alias);
			const targetPath = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(alias), linkTarget);
			const target = realpathSync.native(targetPath);
			if (mountPaths.some((mountPath) => isWithin(target, mountPath))) {
				safeAliases.push({ alias, target });
			}
		} catch {
			// Aliases are optional and only restored when their target is explicitly allowed.
		}
	}

	const args = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--die-with-parent",
		"--new-session",
		"--disable-userns",
		"--cap-drop", "ALL",
		"--tmpfs", "/",
		"--proc", "/proc",
		"--dev", "/dev",
	];

	// Build only empty mountpoint scaffolds. For file binds, bwrap creates the
	// final file mountpoint; for directory binds it must be a directory.
	const scaffolds = new Set<string>();
	for (const path of mountPaths) {
		let parent = dirname(path);
		while (parent !== "/") {
			scaffolds.add(parent);
			parent = dirname(parent);
		}
		if (mounts.get(path)!.entry.isDirectory) scaffolds.add(path);
	}
	for (const { alias } of safeAliases) {
		let parent = dirname(alias);
		while (parent !== "/") {
			scaffolds.add(parent);
			parent = dirname(parent);
		}
	}
	// A cwd outside every explicit mount remains an empty directory scaffold:
	// this lets shell builtins run without making its host contents visible.
	if (!mountPaths.some((path) => isWithin(cwd, path))) {
		let scaffold = cwd;
		while (scaffold !== "/") {
			scaffolds.add(scaffold);
			scaffold = dirname(scaffold);
		}
	}
	for (const path of sortedPaths(scaffolds)) args.push("--dir", path);

	for (const path of mountPaths) {
		const mount = mounts.get(path)!;
		args.push(mount.writable ? "--bind" : "--ro-bind", path, path);
	}

	// Only this small known set of OS aliases is reconstructed. User-defined
	// symlinks never grant filesystem access implicitly.
	for (const { alias, target } of safeAliases) args.push("--symlink", target, alias);

	// A deny beneath any allowed mount is re-bound read-only at that exact
	// existing path, then remounted read-only. This only narrows a path already
	// visible through a rule. If a deny is an ancestor of a write mount but is
	// not itself visible, remount the explicit child mount instead.
	const denyRemounts = new Set<string>();
	const denyOverlays: string[] = [];
	for (const deniedPath of denies.keys()) {
		if (mountPaths.some((mountPath) => isWithin(deniedPath, mountPath))) {
			denyOverlays.push(deniedPath);
		}
		// A deny ancestor can contain explicit write submounts. Remount every
		// covered write mount after all overlays so nested binds cannot remain RW.
		for (const [mountPath, mount] of mounts) {
			if (mount.writable && isWithin(mountPath, deniedPath)) denyRemounts.add(mountPath);
		}
	}

	const minimalDenyOverlays = sortedPaths(denyOverlays).filter(
		(path, index, paths) => !paths.slice(0, index).some((parent) => isWithin(path, parent)),
	);
	for (const path of minimalDenyOverlays) {
		args.push("--ro-bind", path, path);
		denyRemounts.add(path);
	}
	// A parent overlay can hide earlier nested bind mountpoints. Re-establish
	// covered write/anchor mounts as read-only before remounting them; never
	// assume they survived the parent bind, or leave a writable child behind.
	for (const path of sortedPaths(denyRemounts)) {
		if (!minimalDenyOverlays.includes(path)) args.push("--ro-bind", path, path);
	}

	// Remount the empty root after every mount operation. Child bind mounts retain
	// their individual modes; deny remounts below enforce denyWrite precedence.
	args.push("--remount-ro", "/");
	for (const path of sortedPaths(denyRemounts)) args.push("--remount-ro", path);

	args.push("--chdir", cwd, "--", shell, "-c", command);
	return args;
}

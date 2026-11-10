import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { canonicalizePath, expandFilesystemPattern, filesystemPatternRegex } from "./policy.ts";
import { buildLinuxSandboxArgs } from "./linux-strict-sandbox.ts";

/** OS code/data needed to start a shell. Never infer grants from PATH or HOME. */
export function getBashRuntimeReadPaths(platform: NodeJS.Platform = process.platform): string[] {
	const common = [
		"/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec",
		"/usr/share/locale", "/usr/share/zoneinfo", "/usr/share/terminfo",
		"/etc/localtime", "/etc/hosts", "/etc/resolv.conf", "/etc/services",
		"/etc/ssl/certs", "/etc/ssl/cert.pem", "/dev/null", "/dev/random", "/dev/urandom",
	];
	const platformPaths = platform === "darwin"
		? [
			"/System/Library", "/private/var/db/dyld", "/private/var/db/timezone",
			"/System/Volumes/Preboot/Cryptexes/OS/usr/lib",
			"/System/Volumes/Preboot/Cryptexes/OS/System/Library",
		]
		: platform === "linux"
			? ["/lib", "/lib64", "/usr/share/ca-certificates", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/nsswitch.conf"]
			: [];
	return [...new Set([...common, ...platformPaths]
		// Linux creates a fresh minimal /dev, never binds host devices.
		.filter((path) => platform !== "linux" || !path.startsWith("/dev/"))
		.filter(existsSync).map(canonicalizePath))];
}

/** Only process I/O devices, never runtime-supplied temp or home directories. */
export const BASH_RUNTIME_WRITE_PATHS = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd"];

export interface StrictFilesystemPolicy {
	readPaths: string[];
	writePaths: string[];
	denyWrite: string[];
}

export function getStrictFilesystemPolicy(config: SandboxRuntimeConfig): StrictFilesystemPolicy {
	return {
		readPaths: [...new Set([...(config.filesystem.allowRead ?? []), ...config.filesystem.allowWrite])],
		writePaths: config.filesystem.allowWrite,
		denyWrite: config.filesystem.denyWrite,
	};
}

function seatbeltMatcher(pattern: string): string {
	if (pattern.includes("*")) return `(regex #${JSON.stringify(filesystemPatternRegex(pattern).source)})`;
	return `(subpath ${JSON.stringify(canonicalizePath(pattern))})`;
}

/**
 * Own the filesystem rules instead of using the runtime's deny-based reads,
 * implicit home/temp writes, or mandatory write exclusions. A '*' has exactly
 * the same meaning here as in matchesPattern (including across separators).
 */
export function buildMacSandboxProfile(policy: StrictFilesystemPolicy): string {
	const rules = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow process-info* (target same-sandbox))",
		"(allow signal (target same-sandbox))",
		`(allow sysctl-read ${[
			"hw.activecpu", "hw.availcpu", "hw.byteorder", "hw.cachelinesize", "hw.cpufamily",
			"hw.cpusubtype", "hw.cputype", "hw.logicalcpu", "hw.logicalcpu_max",
			"hw.machine", "hw.memsize", "hw.model", "hw.ncpu", "hw.optional.arm64",
			"hw.optional.neon", "hw.pagesize", "hw.physicalcpu", "hw.physicalcpu_max",
			"kern.argmax", "kern.hostname", "kern.maxfiles", "kern.maxfilesperproc",
			"kern.osproductversion", "kern.osrelease", "kern.ostype", "kern.osversion",
			"kern.usrstack64", "kern.version", "machdep.cpu.brand_string", "sysctl.proc_translated",
		].map((name) => `(sysctl-name ${JSON.stringify(name)})`).join(" ")})`,
		"(allow mach-lookup (global-name \"com.apple.system.logger\")",
		"  (global-name \"com.apple.system.opendirectoryd.libinfo\")",
		"  (global-name \"com.apple.system.opendirectoryd.membership\")",
		"  (global-name \"com.apple.logd\")",
		"  (global-name \"com.apple.bsd.dirhelper\")",
		"  (global-name \"com.apple.securityd.xpc\")",
		"  (global-name \"com.apple.trustd.agent\")",
		"  (global-name \"com.apple.SystemConfiguration.configd\"))",
		"(allow ipc-posix-shm)",
		"(allow ipc-posix-sem)",
		// This extension deliberately does not restrict network access.
		"(allow network*)",
		"(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
		// Traversal/stat of directory ancestors must not expose file contents.
		"(allow file-read-metadata (vnode-type DIRECTORY))",
		"(allow file-read-metadata (vnode-type SYMLINK))",
		"(allow file-read* (literal \"/\"))",
	];
	for (const path of policy.readPaths) rules.push(`(allow file-read* ${seatbeltMatcher(path)})`);
	const exclusions = policy.denyWrite.map((path) => `(require-not ${seatbeltMatcher(path)})`);
	const writeMatcher = (path: string) => exclusions.length
		? `(require-all ${seatbeltMatcher(path)} ${exclusions.join(" ")})`
		: seatbeltMatcher(path);
	for (const path of BASH_RUNTIME_WRITE_PATHS) {
		rules.push(`(allow file-read* file-ioctl ${seatbeltMatcher(path)})`);
		rules.push(`(allow file-write* ${writeMatcher(path)})`);
	}
	for (const path of policy.writePaths) rules.push(`(allow file-write* ${writeMatcher(path)})`);
	for (const path of policy.denyWrite) {
		rules.push(`(deny file-write* ${seatbeltMatcher(path)})`);
		// Protect ancestors from rename/replacement, including not-yet-existing
		// deny targets. Otherwise moving their parent could evade a path denial.
		const expanded = expandFilesystemPattern(path);
		const prefix = expanded.slice(0, expanded.indexOf("*"));
		let ancestor = expanded.includes("*")
			? canonicalizePath(prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix))
			: dirname(canonicalizePath(path));
		while (ancestor !== "/") {
			rules.push(`(deny file-write-unlink file-write-create (literal ${JSON.stringify(ancestor)}))`);
			ancestor = dirname(ancestor);
		}
	}
	return rules.join("\n");
}

/** Fail closed: no uninitialized manager or unsupported platform fallback. */
export function buildStrictSandboxSpawn(
	config: SandboxRuntimeConfig | undefined,
	command: string,
	shell: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
	if (!config) throw new Error("Sandbox is not initialized; refusing unsandboxed bash execution.");
	if (config.filesystem.disabled === true) return { file: shell, args: ["-c", command] };
	const policy = getStrictFilesystemPolicy(config);
	if (platform === "darwin") {
		return { file: "/usr/bin/sandbox-exec", args: ["-p", buildMacSandboxProfile(policy), shell, "-c", command] };
	}
	if (platform === "linux") {
		return {
			file: config.bwrapPath ?? "bwrap",
			args: buildLinuxSandboxArgs(policy, command,
				canonicalizePath(shell === "sh" && existsSync("/bin/sh") ? "/bin/sh" : shell), canonicalizePath(cwd)),
		};
	}
	throw new Error(`Strict filesystem sandboxing is unsupported on ${platform}.`);
}

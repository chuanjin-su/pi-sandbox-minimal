import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildLinuxSandboxArgs } from "../src/linux-strict-sandbox.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const path = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-linux-sandbox-")));
	temporaryDirectories.push(path);
	return path;
}

function hasPair(args: string[], first: string, second: string): boolean {
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] === first && args[index + 1] === second) return true;
	}
	return false;
}

function hasTriplet(args: string[], first: string, second: string, third: string): boolean {
	for (let index = 0; index < args.length - 2; index++) {
		if (args[index] === first && args[index + 1] === second && args[index + 2] === third) {
			return true;
		}
	}
	return false;
}

describe("buildLinuxSandboxArgs", () => {
	it("starts empty and lets write grants subsume nested read grants", () => {
		const root = temporaryDirectory();
		const readonly = join(root, "readonly");
		const denied = join(root, "secret.txt");
		mkdirSync(readonly);
		writeFileSync(denied, "secret");

		const args = buildLinuxSandboxArgs(
			{ readPaths: [root, readonly], writePaths: [root], denyWrite: [denied] },
			"echo test",
			"/bin/sh",
			root,
		);

		ok(hasPair(args, "--tmpfs", "/"));
		ok(hasPair(args, "--proc", "/proc"));
		ok(hasPair(args, "--dev", "/dev"));
		ok(args.includes("--unshare-user"));
		ok(args.includes("--unshare-pid"));
		ok(args.includes("--unshare-ipc"));
		ok(args.includes("--die-with-parent"));
		ok(args.includes("--new-session"));
		ok(args.includes("--disable-userns"));
		ok(hasPair(args, "--cap-drop", "ALL"));
		ok(!args.includes("--unshare-net"));
		ok(!hasTriplet(args, "--ro-bind", "/", "/"));
		ok(hasTriplet(args, "--bind", root, root));
		ok(!hasTriplet(args, "--ro-bind", readonly, readonly));
		ok(hasTriplet(args, "--ro-bind", denied, denied));

		const rootMountIndex = args.indexOf("--remount-ro");
		strictEqual(args[rootMountIndex + 1], "/");
		ok(args.indexOf("--remount-ro", rootMountIndex + 2) > rootMountIndex);
		deepStrictEqual(args.slice(-6), ["--chdir", root, "--", "/bin/sh", "-c", "echo test"]);
	});

	it("omits missing reads and fails closed for missing writes and deny rules", () => {
		const root = temporaryDirectory();
		const missing = join(root, "missing");
		const args = buildLinuxSandboxArgs(
			{ readPaths: [missing], writePaths: [], denyWrite: [] },
			"true", "/bin/sh", root,
		);
		ok(!args.includes(missing));

		throws(
			() => buildLinuxSandboxArgs(
				{ readPaths: [], writePaths: [missing], denyWrite: [] },
				"true", "/bin/sh", root,
			),
			/write path does not exist/i,
		);
		throws(
			() => buildLinuxSandboxArgs(
				{ readPaths: [], writePaths: [], denyWrite: [missing] },
				"true", "/bin/sh", root,
			),
			/denyWrite path does not exist/i,
		);
	});

	it("rejects globs, host root binds, and host kernel mounts", () => {
		const root = temporaryDirectory();
		throws(
			() => buildLinuxSandboxArgs(
				{ readPaths: [join(root, "*")], writePaths: [], denyWrite: [] },
				"true", "/bin/sh", root,
			),
			/does not support glob/i,
		);
		throws(
			() => buildLinuxSandboxArgs(
				{ readPaths: ["/"], writePaths: [], denyWrite: [] },
				"true", "/bin/sh", root,
			),
			/will not bind the host root/i,
		);
		throws(
			() => buildLinuxSandboxArgs(
				{ readPaths: ["/sys"], writePaths: [], denyWrite: [] },
				"true", "/bin/sh", root,
			),
			/host \/proc, \/dev, and \/sys are never bound/i,
		);
		throws(
			() => buildLinuxSandboxArgs(
				{ readPaths: [], writePaths: [], denyWrite: ["/dev/null"] },
				"true", "/bin/sh", root,
			),
			/host \/proc, \/dev, and \/sys are never bound/i,
		);
	});

	it("scaffolds an unbound cwd and remounts nested writes under a deny parent", () => {
		const root = temporaryDirectory();
		const denied = join(root, "denied");
		const nestedWrite = join(denied, "nested");
		mkdirSync(nestedWrite, { recursive: true });
		const cwd = join(root, "empty-cwd");
		const args = buildLinuxSandboxArgs(
			{ readPaths: [], writePaths: [denied, nestedWrite], denyWrite: [denied] },
			"true", "/bin/sh", cwd,
		);

		ok(hasPair(args, "--dir", cwd));
		ok(hasTriplet(args, "--bind", nestedWrite, nestedWrite));
		const rootRemount = args.findIndex((arg, index) => arg === "--remount-ro" && args[index + 1] === "/");
		ok(rootRemount >= 0);
		ok(args.indexOf("--remount-ro", rootRemount + 2) > rootRemount);
		ok(args.indexOf(nestedWrite, rootRemount + 2) > rootRemount);
	});

	it("anchors writable ancestors so nested denyWrite paths cannot be relocated", () => {
		const root = temporaryDirectory();
		const parent = join(root, "private");
		const nested = join(parent, "nested");
		mkdirSync(nested, { recursive: true });
		const denied = join(nested, "key");
		writeFileSync(denied, "KEEP");
		const args = buildLinuxSandboxArgs(
			{ readPaths: [root], writePaths: [root], denyWrite: [denied] },
			"true", "/bin/sh", root,
		);
		ok(hasTriplet(args, "--bind", parent, parent));
		ok(hasTriplet(args, "--bind", nested, nested));
		ok(hasTriplet(args, "--ro-bind", denied, denied));
	});

	it("treats non-star glob characters literally", () => {
		const root = temporaryDirectory();
		const literal = join(root, "name[1]?{x}.txt");
		writeFileSync(literal, "literal");
		const args = buildLinuxSandboxArgs(
			{ readPaths: [literal], writePaths: [], denyWrite: [] },
			"true", "/bin/sh", root,
		);
		ok(hasTriplet(args, "--ro-bind", literal, literal));
	});

	it("passes the shell and command as separate sandbox argv entries", () => {
		const root = temporaryDirectory();
		const args = buildLinuxSandboxArgs(
			{ readPaths: [], writePaths: [], denyWrite: [] },
			"echo 'a b'", "/opt/custom shell", root,
		);
		deepStrictEqual(args.slice(-6), ["--chdir", root, "--", "/opt/custom shell", "-c", "echo 'a b'"]);
		strictEqual(args.at(-1), "echo 'a b'");
		ok(!args.includes("/opt"));
	});
});

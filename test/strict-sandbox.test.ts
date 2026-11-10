import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ISandboxManager, SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { canonicalizePath, filesystemPatternRegex } from "../src/policy.ts";
import { buildRuntimeConfig, createSandboxedBashOps } from "../src/sandbox-runtime.ts";
import {
	BASH_RUNTIME_WRITE_PATHS,
	buildMacSandboxProfile,
	buildStrictSandboxSpawn,
	getBashRuntimeReadPaths,
} from "../src/strict-sandbox.ts";

const policy = { readPaths: ["/workspace"], writePaths: ["/workspace"], denyWrite: [] };

describe("strict macOS filesystem policy", () => {
	it("defaults to denied reads and writes, with explicit grants only", () => {
		const profile = buildMacSandboxProfile(policy);
		ok(profile.includes("(deny default)"));
		ok(!profile.includes("(allow file-read*)"));
		ok(!profile.includes("(allow file-write*)"));
		ok(profile.includes('(allow file-read* (subpath "/workspace"))'));
		ok(profile.includes('(allow file-write* (subpath "/workspace"))'));
		for (const hiddenGrant of ["/tmp/claude", "/private/tmp/claude", ".npm/_logs", ".claude/debug"]) {
			ok(!profile.includes(hiddenGrant));
		}
		for (const hiddenDeny of [".bashrc", ".mcp.json", ".env", "*.pem"]) ok(!profile.includes(hiddenDeny));
	});

	it("excludes explicit write denials from grants and protects ancestor renames", () => {
		const profile = buildMacSandboxProfile({ ...policy, denyWrite: ["/workspace/private/key"] });
		ok(profile.includes('(require-not (subpath "/workspace/private/key"))'));
		ok(profile.includes('(deny file-write* (subpath "/workspace/private/key"))'));
		ok(profile.includes('(deny file-write-unlink file-write-create (literal "/workspace/private"))'));
		ok(profile.includes('(deny file-write-unlink file-write-create (literal "/workspace"))'));
	});

	it("uses the file-tool wildcard compiler rather than runtime glob semantics", () => {
		const pattern = "/workspace/nested/*.pem";
		const profile = buildMacSandboxProfile({ ...policy, denyWrite: [pattern] });
		ok(profile.includes(`(regex #${JSON.stringify(filesystemPatternRegex(pattern).source)})`));
		ok(profile.includes('(deny file-write-unlink file-write-create (literal "/workspace/nested"))'));
		ok(filesystemPatternRegex(pattern).test("/workspace/nested/deeper/private.pem"));
	});

	it("an empty write allowlist adds only process I/O devices, not writable host directories", () => {
		const profile = buildMacSandboxProfile({ readPaths: [], writePaths: [], denyWrite: [] });
		const writeGrants = profile.split("\n").filter((line) => line.startsWith("(allow file-write*"));
		strictEqual(writeGrants.length, BASH_RUNTIME_WRITE_PATHS.length);
		for (const line of writeGrants) ok(line.includes("/dev/"));
	});
});

describe("strict sandbox launch", () => {
	it("passes all command bytes only to the sandboxed shell, without an outer shell", () => {
		const command = "printf '%s' \"a'b\"; $(touch /outside); echo \\\nnext";
		const launch = buildStrictSandboxSpawn(buildRuntimeConfig(DEFAULT_CONFIG), command, "/bin/bash", process.cwd(), "darwin");
		strictEqual(launch.file, "/usr/bin/sandbox-exec");
		deepStrictEqual(launch.args.slice(-3), ["/bin/bash", "-c", command]);
		strictEqual(launch.args[0], "-p");
		ok(!launch.args[1]!.includes(command));
	});

	it("compiles the Linux default without hidden writable host paths or host device binds", () => {
		const launch = buildStrictSandboxSpawn(buildRuntimeConfig(DEFAULT_CONFIG, undefined, "linux"),
			":", "/bin/bash", process.cwd(), "linux");
		const writable = launch.args.flatMap((arg, index) => arg === "--bind" ? [launch.args[index + 1]] : []);
		deepStrictEqual(writable, [canonicalizePath(".")]);
		ok(!launch.args.includes("/sys"));
		ok(!getBashRuntimeReadPaths("linux").some((path) => path.startsWith("/dev/")));
	});

	it("fails closed with no initialized config or on unsupported platforms", () => {
		throws(() => buildStrictSandboxSpawn(undefined, "echo unsafe", "/bin/bash", "."), /not initialized/);
		throws(() => buildStrictSandboxSpawn(buildRuntimeConfig(DEFAULT_CONFIG), "true", "/bin/bash", ".", "win32"), /unsupported/);
	});

	it("only bypasses enforcement when filesystem.disabled is explicitly configured", () => {
		const config = buildRuntimeConfig({ filesystem: { disabled: true } });
		deepStrictEqual(buildStrictSandboxSpawn(config, "echo explicit", "/bin/bash", "."), {
			file: "/bin/bash", args: ["-c", "echo explicit"],
		});
	});

	it("bash operations reject an uninitialized manager rather than executing locally", async () => {
		const manager = { getConfig: () => undefined } as unknown as ISandboxManager;
		await rejects(createSandboxedBashOps(manager, "/bin/bash").exec("echo unsafe", process.cwd(), {
			onData() {},
		}), /not initialized/);
	});

	it("rejects literal-star symlink targets instead of turning them into broader wildcard grants", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-literal-rule-"));
		try {
			const target = join(root, "literal*directory");
			const alias = join(root, "alias");
			mkdirSync(target);
			symlinkSync(target, alias);
			throws(() => buildRuntimeConfig({ filesystem: { allowRead: [alias] } }), /literal path containing '\*'/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runtime read baseline never infers grants from HOME or PATH", () => {
		const paths = getBashRuntimeReadPaths("darwin");
		ok(paths.includes(canonicalizePath("/bin")));
		for (const path of paths) {
			ok(!path.startsWith("/Users/"));
			ok(!path.startsWith("/home/"));
			ok(!path.startsWith("/opt/homebrew"));
			ok(!path.startsWith("/tmp"));
			ok(!path.startsWith("/private/tmp"));
		}
	});
});

function sandboxCapability(): string | undefined {
	if (process.platform === "darwin") {
		const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 5000 });
		return probe.status === 0 ? undefined : `sandbox-exec unavailable: ${probe.error?.message ?? probe.stderr.trim()}`;
	}
	if (process.platform === "linux") {
		const probe = spawnSync("bwrap", ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "/bin/true"], { encoding: "utf8", timeout: 5000 });
		return probe.status === 0 ? undefined : `bubblewrap/user namespaces unavailable: ${probe.error?.message ?? probe.stderr.trim()}`;
	}
	return "strict sandbox supports macOS and Linux only";
}

const unavailable = sandboxCapability();
if (unavailable && process.env.PI_SANDBOX_REQUIRE_NATIVE_TESTS === "1") throw new Error(unavailable);

describe("native strict bash enforcement", { skip: unavailable }, () => {
	it("allows workspace CRUD but blocks outside data, symlinks, and subprocess bypasses", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-strict-native-"));
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		mkdirSync(workspace);
		mkdirSync(outside);
		const secret = join(outside, "secret.txt");
		writeFileSync(secret, "OUTSIDE_SECRET");
		writeFileSync(join(workspace, "inside.txt"), "INSIDE");
		symlinkSync(secret, join(workspace, "link"));
		const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
		const config = buildRuntimeConfig({ ...DEFAULT_CONFIG, filesystem: {
			allowRead: [workspace], allowWrite: [workspace], denyRead: [], denyWrite: [],
		} });
		const run = (command: string, currentConfig: SandboxRuntimeConfig = config) => {
			const launch = buildStrictSandboxSpawn(currentConfig, command, "/bin/bash", workspace);
			return spawnSync(launch.file, launch.args, { cwd: workspace, encoding: "utf8", timeout: 10000 });
		};
		try {
			const crud = run("cat inside.txt; printf OK > created; mv created moved; cat moved; rm moved; printf OK > .bashrc");
			strictEqual(crud.status, 0, crud.stderr);
			match(crud.stdout, /INSIDEOK/);
			strictEqual(readFileSync(join(workspace, ".bashrc"), "utf8"), "OK");
			for (const command of [`cat ${quote(secret)}`, "cat link", "cat /etc/passwd", `/bin/sh -c ${quote(`cat ${quote(secret)}`)}`]) {
				const result = run(command);
				ok(result.status !== 0, `Unexpected read success: ${command}`);
				ok(!result.stdout.includes("OUTSIDE_SECRET"));
			}
			ok(run(`printf BAD > ${quote(secret)}`).status !== 0);
			strictEqual(readFileSync(secret, "utf8"), "OUTSIDE_SECRET");
			const granted = buildRuntimeConfig({ filesystem: { allowRead: [workspace, secret], allowWrite: [workspace] } });
			const grantedRead = run(`cat ${quote(secret)}`, granted);
			strictEqual(grantedRead.status, 0, grantedRead.stderr);
			strictEqual(grantedRead.stdout, "OUTSIDE_SECRET");
			strictEqual(run("cat link", granted).stdout, "OUTSIDE_SECRET");
			const grantedWrite = buildRuntimeConfig({ filesystem: {
				allowRead: [workspace], allowWrite: [workspace, outside],
			} });
			strictEqual(run(`printf UPDATED > ${quote(secret)}`, grantedWrite).status, 0);
			strictEqual(readFileSync(secret, "utf8"), "UPDATED");
			ok(run(`cat ${quote(secret)}`).status !== 0, "a prior command's grant must not leak into the next policy");
			const denied = buildRuntimeConfig({ filesystem: { allowRead: [workspace], allowWrite: [workspace], denyWrite: [join(workspace, "inside.txt")] } });
			ok(run("printf BAD > inside.txt", denied).status !== 0);
			strictEqual(readFileSync(join(workspace, "inside.txt"), "utf8"), "INSIDE");
			const readOnly = buildRuntimeConfig({ filesystem: { allowRead: [workspace], allowWrite: [] } });
			ok(run("printf BAD > inside.txt", readOnly).status !== 0);
			const noData = buildRuntimeConfig({ filesystem: { allowRead: [], allowWrite: [] } });
			ok(run("cat inside.txt", noData).status !== 0);
			strictEqual(run("printf OK", noData).stdout, "OK");
			// Startup scripts must be read by the sandboxed shell, never by an
			// unrestricted outer shell before the OS policy is installed.
			const startup = join(outside, "startup.sh");
			const marker = join(outside, "startup-ran");
			writeFileSync(startup, `printf BAD > ${quote(marker)}`);
			const launch = buildStrictSandboxSpawn(config, ":", "/bin/bash", workspace);
			spawnSync(launch.file, launch.args, { cwd: workspace, encoding: "utf8", timeout: 10000,
				env: { ...process.env, BASH_ENV: startup },
			});
			ok(!existsSync(marker), "BASH_ENV must not execute outside the sandbox");
			// Writable directories with the old runtime's log/temp names are
			// still outside the policy; names must not grant implicit access.
			for (const relative of ["claude", ".npm/_logs", ".claude/debug"]) {
				const dir = join(outside, relative);
				mkdirSync(dir, { recursive: true });
				const target = join(dir, "leak");
				ok(run(`printf BAD > ${quote(target)}`).status !== 0);
				ok(!existsSync(target));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("protects a denied file against writes, atomic replacement, and ancestor renames", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-strict-deny-"));
		const privateDir = join(root, "private");
		mkdirSync(privateDir);
		const key = join(privateDir, "key");
		writeFileSync(key, "KEEP");
		const config = buildRuntimeConfig({ filesystem: {
			allowRead: [root], allowWrite: [root], denyWrite: [key],
		} });
		const run = (command: string) => {
			const launch = buildStrictSandboxSpawn(config, command, "/bin/bash", root);
			return spawnSync(launch.file, launch.args, { cwd: root, encoding: "utf8", timeout: 10000 });
		};
		try {
			for (const command of ["printf BAD > private/key", "printf BAD > replacement; mv replacement private/key",
				"mv private moved", "rm private/key", "chmod 777 private/key"]) {
				const result = run(command);
				ok(result.status !== 0, `Unexpected write success: ${command}`);
				strictEqual(readFileSync(key, "utf8"), "KEEP");
			}
			strictEqual(run("printf OK > private/other; cat private/other").stdout, "OK");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

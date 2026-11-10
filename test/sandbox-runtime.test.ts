import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, type SandboxConfig } from "../src/config.ts";
import { canonicalizePath, decideWritePolicy, matchesPattern } from "../src/policy.ts";
import { getSystemTempPaths } from "../src/system-temp.ts";
import { getBashRuntimeReadPaths } from "../src/strict-sandbox.ts";
import {
	buildRuntimeConfig,
	extractBlockedReadPath,
	extractBlockedWritePath,
	resolveAllowances,
	type SessionAllowances,
} from "../src/sandbox-runtime.ts";

describe("resolveAllowances", () => {
	it("defaults to only the working directory for file-tool reads and writes", () => {
		const effective = resolveAllowances(DEFAULT_CONFIG);
		deepStrictEqual(effective, { readPaths: ["."], writePaths: ["."] });
		for (const path of [".env", ".env.local", "cert.pem", "private.key", "nested/file"]) {
			ok(matchesPattern(path, effective.readPaths));
			strictEqual(decideWritePolicy(path, effective.writePaths,
				DEFAULT_CONFIG.filesystem?.denyWrite ?? []), "allow");
		}
		ok(!matchesPattern("../outside", effective.readPaths));
		strictEqual(decideWritePolicy("../outside", effective.writePaths, []), "prompt");
	});

	it("does not add temp allowances unless explicitly enabled", () => {
		for (const allowSystemTemp of [undefined, false, "true" as unknown as boolean]) {
			deepStrictEqual(resolveAllowances({ allowSystemTemp, filesystem: { allowWrite: [] } }), {
				readPaths: [], writePaths: [],
			});
		}
	});

	it("adds system temp to both tool allowances without mutating configured arrays", () => {
		const config: SandboxConfig = {
			allowSystemTemp: true,
			filesystem: { allowRead: [], allowWrite: [] },
		};
		const effective = resolveAllowances(config);
		deepStrictEqual(effective.writePaths, getSystemTempPaths());
		deepStrictEqual(effective.readPaths, effective.writePaths);
		for (const dir of getSystemTempPaths()) {
			ok(matchesPattern(`${dir}/browser/socket`, effective.readPaths));
			strictEqual(decideWritePolicy(`${dir}/browser/socket`, effective.writePaths, []), "allow");
		}
		deepStrictEqual(config.filesystem?.allowWrite, []);
		deepStrictEqual(config.filesystem?.allowRead, []);
	});
	it("combines config paths with session allowances", () => {
		const config: SandboxConfig = {
			...DEFAULT_CONFIG,
			filesystem: { ...DEFAULT_CONFIG.filesystem, allowWrite: ["/project"] },
		};
		const allowances: SessionAllowances = { readPaths: ["/docs"], writePaths: ["/notes"] };
		const effective = resolveAllowances(config, allowances);
		ok(effective.writePaths.includes("/project"));
		ok(effective.writePaths.includes("/notes"));
		ok(effective.readPaths.includes("/docs"));
		// write implies read
		ok(effective.readPaths.includes("/notes"));
		ok(effective.readPaths.includes("/project"));
	});
});

describe("buildRuntimeConfig", () => {
	it("compiles default user allowances plus the explicit OS read baseline", () => {
		const runtime = buildRuntimeConfig(DEFAULT_CONFIG, undefined, "darwin");
		deepStrictEqual(runtime.filesystem, {
			disabled: undefined,
			denyRead: ["/"],
			allowRead: [...new Set([canonicalizePath("."), ...getBashRuntimeReadPaths("darwin")])],
			allowWrite: [canonicalizePath(".")],
			denyWrite: [],
		});
	});

	it("ignores the removed browser-process option without affecting system-temp access", () => {
		const legacyConfig: SandboxConfig = {
			// @ts-expect-error Old JSON may contain this, but it is no longer a supported option.
			allowBrowserProcess: true,
			allowSystemTemp: true,
		};
		const runtime = buildRuntimeConfig(legacyConfig);
		strictEqual("allowBrowserProcess" in runtime, false);
		deepStrictEqual(runtime.filesystem!.allowWrite, getSystemTempPaths());
	});

	it("includes system temp in runtime read/write rules and preserves denyWrite precedence", () => {
		const denied = `${getSystemTempPaths()[0]}/private-file`;
		const config: SandboxConfig = {
			allowSystemTemp: true,
			filesystem: { allowWrite: [], denyWrite: [denied] },
		};
		const runtime = buildRuntimeConfig(config);
		for (const dir of getSystemTempPaths()) {
			ok(runtime.filesystem!.allowWrite.includes(dir));
			ok(runtime.filesystem!.allowRead!.includes(dir));
		}
		strictEqual(decideWritePolicy(denied, runtime.filesystem!.allowWrite,
			runtime.filesystem!.denyWrite), "deny");
	});

	it("uses the requested platform for temp discovery", () => {
		const runtime = buildRuntimeConfig({ allowSystemTemp: true }, undefined, "linux");
		deepStrictEqual(runtime.filesystem!.allowWrite, getSystemTempPaths({ platform: "linux" }));
	});
	it("omits network.allowedDomains so the runtime applies no network restriction", () => {
		const runtime = buildRuntimeConfig(DEFAULT_CONFIG, undefined, "darwin");
		// The runtime treats `network.allowedDomains === undefined` as
		// "no network config" → (allow network*), no proxy routing.
		strictEqual(runtime.network.allowedDomains, undefined);
	});

	it("canonicalizes filesystem patterns into the runtime config", () => {
		const config: SandboxConfig = {
			...DEFAULT_CONFIG,
			filesystem: {
				denyRead: ["/Users"],
				allowRead: ["."],
				allowWrite: ["."],
				denyWrite: [".env"],
			},
		};
		const runtime = buildRuntimeConfig(config, undefined, "darwin");
		ok(runtime.filesystem!.denyRead.every((path) => path.startsWith("/")));
		ok(runtime.filesystem!.allowWrite.every((path) => path.startsWith("/")));
		ok(!runtime.filesystem!.allowWrite.includes("."));
	});

	it("session allowances are included and write implies read", () => {
		const config: SandboxConfig = { ...DEFAULT_CONFIG };
		const runtime = buildRuntimeConfig(
			config,
			{ readPaths: ["/docs"], writePaths: ["/notes"] },
			"darwin",
		);
		ok(runtime.filesystem!.allowRead?.some((path) => path.endsWith("/docs")) ?? false);
		ok(runtime.filesystem!.allowWrite.some((path) => path.endsWith("/notes")));
		ok(runtime.filesystem!.allowRead?.some((path) => path.endsWith("/notes")) ?? false);
		deepStrictEqual(runtime.network, {});
	});
});

describe("extractBlockedReadPath", () => {
	it("recognizes denied and hidden read paths without classifying write errors as reads", () => {
		strictEqual(extractBlockedReadPath("cat: /outside/secret: Operation not permitted"), "/outside/secret");
		strictEqual(extractBlockedReadPath("/bin/cat: '/outside/a b': Permission denied"), "/outside/a b");
		strictEqual(extractBlockedReadPath("cat: /outside/secret: No such file or directory"), "/outside/secret");
		strictEqual(extractBlockedReadPath("bash: line 12: /outside/secret: Operation not permitted"), null);
		strictEqual(extractBlockedReadPath("arbitrary stderr"), null);
	});
});

describe("extractBlockedWritePath", () => {
	it("extracts the path from a bash Operation not permitted message", () => {
		strictEqual(
			extractBlockedWritePath("bash: line 1: /etc/hosts: Operation not permitted"),
			"/etc/hosts",
		);
		strictEqual(extractBlockedWritePath("sh: /etc/hosts: Operation not permitted"), "/etc/hosts");
		strictEqual(extractBlockedWritePath("bash: line 12: /outside/a b: Permission denied"), "/outside/a b");
	});

	it("recognizes BSD/GNU touch diagnostics and relative redirections", () => {
		for (const [output, path] of [
			["touch: ../created: Operation not permitted", "../created"],
			["/usr/bin/touch: ../a b: Permission denied", "../a b"],
			["touch: cannot touch '../created': Permission denied", "../created"],
			['touch: cannot touch "../a b": Read-only file system', "../a b"],
			["touch: cannot touch '/outside/created': No such file or directory", "/outside/created"],
			["touch: setting times of '../existing': Operation not permitted", "../existing"],
			["bash: line 12: ../created: Operation not permitted", "../created"],
			["/bin/sh: ../a b: Read-only file system", "../a b"],
		]) strictEqual(extractBlockedWritePath(output!), path);
	});

	it("returns null for unrelated or read-only diagnostics", () => {
		strictEqual(extractBlockedWritePath("total 0\ndrwxr-xr-x  ."), null);
		strictEqual(extractBlockedWritePath("cat: ../secret: Operation not permitted"), null);
		strictEqual(extractBlockedWritePath("touch: invalid option -- x"), null);
		strictEqual(extractBlockedWritePath("unknown: ../created: Permission denied"), null);
	});
});

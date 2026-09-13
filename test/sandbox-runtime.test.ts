import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, type SandboxConfig } from "../src/config.ts";
import {
	buildRuntimeConfig,
	extractBlockedWritePath,
	resolveAllowances,
	type SessionAllowances,
} from "../src/sandbox-runtime.ts";

describe("resolveAllowances", () => {
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

describe("extractBlockedWritePath", () => {
	it("extracts the path from a bash Operation not permitted message", () => {
		strictEqual(
			extractBlockedWritePath("bash: line 1: /etc/hosts: Operation not permitted"),
			"/etc/hosts",
		);
		strictEqual(extractBlockedWritePath("sh: /etc/hosts: Operation not permitted"), "/etc/hosts");
	});

	it("returns null for unrelated output", () => {
		strictEqual(extractBlockedWritePath("total 0\ndrwxr-xr-x  ."), null);
	});
});

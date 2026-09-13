import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";

import {
	DEFAULT_CONFIG,
	addReadPathToConfig,
	addWritePathToConfig,
	getConfigPaths,
	getRawConfiguredEntries,
	loadConfig,
	mergeConfigLayers,
	readConfigFile,
	removeFromConfigs,
	setScalarInConfig,
	writeConfigContent,
} from "../src/config.ts";

const tempDirs: string[] = [];

// Isolate tests from the real global config (~/.pi/agent/sandbox.json).
before(() => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-minimal-agent-"));
	tempDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (dir !== process.env.PI_CODING_AGENT_DIR) rmSync(dir, { recursive: true, force: true });
	}
});

function tempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-minimal-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("mergeConfigLayers", () => {
	it("scalar settings: project takes precedence over global", () => {
		const merged = mergeConfigLayers(DEFAULT_CONFIG, { sandboxUserShell: false }, { sandboxUserShell: true });
		strictEqual(merged.sandboxUserShell, true);
	});

	it("arrays from both files are combined and deduplicated", () => {
		const merged = mergeConfigLayers(
			DEFAULT_CONFIG,
			{ filesystem: { allowWrite: ["/global"] } },
			{ filesystem: { allowWrite: ["/project", "/project"] } },
		);
		// Once an array is configured in any file, ONLY the combined file entries
		// are used — built-in defaults no longer apply (pi-sandbox semantics).
		deepStrictEqual(merged.filesystem?.allowWrite, ["/global", "/project"]);
	});

	it("explicit empty array disables built-in defaults", () => {
		const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, { filesystem: { denyWrite: [] } });
		deepStrictEqual(merged.filesystem?.denyWrite, []);
	});

	it("unconfigured arrays keep their defaults", () => {
		const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});
		deepStrictEqual(merged.filesystem?.allowWrite, DEFAULT_CONFIG.filesystem?.allowWrite);
	});
});

describe("loadConfig / getConfigPaths", () => {
	it("returns defaults when no config files exist", () => {
		const config = loadConfig(tempProject());
		strictEqual(config.enabled, true);
		ok(config.filesystem?.allowWrite?.includes("."));
		ok(config.filesystem?.allowWrite?.includes("/tmp"));
	});

	it("reads project config from .pi/sandbox.json", () => {
		const cwd = tempProject();
		writeConfigContent(join(cwd, ".pi", "sandbox.json"), '{"filesystem":{"allowWrite":["/extra"]}}');
		const config = loadConfig(cwd);
		ok(config.filesystem?.allowWrite?.includes("/extra"));
	});
});

describe("config file helpers", () => {
	it("writeConfigContent rejects invalid JSON without writing", () => {
		const path = join(tempProject(), "sandbox.json");
		strictEqual(writeConfigContent(path, "{not json").ok, false);
		strictEqual(existsSync(path), false);
	});

	it("writeConfigContent accepts valid JSON objects", () => {
		const path = join(tempProject(), "sandbox.json");
		strictEqual(writeConfigContent(path, '{"enabled": false}').ok, true);
		strictEqual(JSON.parse(readFileSync(path, "utf-8")).enabled, false);
	});

	it("add/remove read and write paths round-trip", () => {
		const cwd = tempProject();
		const { projectPath } = getConfigPaths(cwd);
		addReadPathToConfig(projectPath, "~/docs");
		addWritePathToConfig(projectPath, "~/notes");
		let entries = getRawConfiguredEntries(cwd);
		deepStrictEqual(entries.readPaths, ["~/docs"]);
		deepStrictEqual(entries.writePaths, ["~/notes"]);
		removeFromConfigs(cwd, "read", "~/docs");
		removeFromConfigs(cwd, "write", "~/notes");
		entries = getRawConfiguredEntries(cwd);
		deepStrictEqual(entries.readPaths, []);
		deepStrictEqual(entries.writePaths, []);
	});

	it("setScalarInConfig persists booleans", () => {
		const path = join(tempProject(), "sandbox.json");
		setScalarInConfig(path, "sandboxUserShell", false);
		strictEqual(JSON.parse(readFileSync(path, "utf-8")).sandboxUserShell, false);
	});

	it("readConfigFile returns {} for missing files", () => {
		strictEqual(readConfigFile(join(tmpdir(), "definitely-missing-sandbox.json")), "{}");
	});
});

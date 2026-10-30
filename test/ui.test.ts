import { ok } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { getSystemTempPaths } from "../src/system-temp.ts";
import { formatSandboxConfiguration } from "../src/ui.ts";

const paths = { globalPath: "/config/global.json", projectPath: "/config/project.json" };
const allowances = { readPaths: [], writePaths: [] };

describe("sandbox status", () => {
	it("shows system temp access off by default", () => {
		const status = formatSandboxConfiguration(true, true, DEFAULT_CONFIG, paths, allowances);
		ok(status.includes("System temp access:     off"));
		ok(!status.includes("System temp read/write:"));
	});

	it("shows the resolved read/write directories when enabled", () => {
		const status = formatSandboxConfiguration(true, true,
			{ ...DEFAULT_CONFIG, allowSystemTemp: true }, paths, allowances);
		ok(status.includes("System temp access:     read/write"));
		ok(status.includes(`System temp read/write: ${getSystemTempPaths().join(", ")}`));
	});
});

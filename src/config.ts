import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Extension configuration. Filesystem-only sandboxing: the network section of
 * the runtime config is intentionally left without allowedDomains so the
 * runtime applies no network restrictions to sandboxed bash commands.
 * Non-network runtime options (allowBrowserProcess, allowPty, credentials,
 * ignoreViolations, ...) are passed through when configured.
 */
export type SandboxConfig = Omit<SandboxRuntimeConfig, "network" | "filesystem"> & {
	enabled?: boolean;
	sandboxUserShell?: boolean;
	permissionPromptTimeoutSeconds?: number;
	filesystem?: Partial<SandboxRuntimeConfig["filesystem"]>;
};

export type SandboxConfigFile = SandboxConfig;

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	sandboxUserShell: true,
	permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
	filesystem: {
		denyRead: ["/Users", "/home"],
		allowRead: [".", "~/.config", "~/.local", "Library"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
	return {
		...base,
		...overrides,
		filesystem: overrides.filesystem
			? { ...base.filesystem, ...overrides.filesystem }
			: base.filesystem,
	};
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return value;
}

function mergeConfiguredArray(
	fallback: string[] | undefined,
	globalValue: unknown,
	projectValue: unknown,
): string[] | undefined {
	const globalEntries = stringArray(globalValue);
	const projectEntries = stringArray(projectValue);
	if (globalEntries === undefined && projectEntries === undefined) return fallback;
	return [...new Set([...(globalEntries ?? []), ...(projectEntries ?? [])])];
}

export function mergeConfigLayers(
	defaults: SandboxConfig,
	globalConfig: SandboxConfigFile,
	projectConfig: SandboxConfigFile,
): SandboxConfig {
	const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);

	return {
		...merged,
		filesystem: {
			...merged.filesystem,
			denyRead:
				mergeConfiguredArray(
					defaults.filesystem?.denyRead,
					globalConfig.filesystem?.denyRead,
					projectConfig.filesystem?.denyRead,
				) ?? [],
			allowRead: mergeConfiguredArray(
				defaults.filesystem?.allowRead,
				globalConfig.filesystem?.allowRead,
				projectConfig.filesystem?.allowRead,
			),
			allowWrite:
				mergeConfiguredArray(
					defaults.filesystem?.allowWrite,
					globalConfig.filesystem?.allowWrite,
					projectConfig.filesystem?.allowWrite,
				) ?? [],
			denyWrite:
				mergeConfiguredArray(
					defaults.filesystem?.denyWrite,
					globalConfig.filesystem?.denyWrite,
					projectConfig.filesystem?.denyWrite,
				) ?? [],
		},
	};
}

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
	if (!existsSync(configPath)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("configuration must be a JSON object");
		}
		return parsed as SandboxConfigFile;
	} catch (error) {
		if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
		return {};
	}
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
	return {
		globalPath: join(getAgentDir(), "sandbox.json"),
		projectPath: join(cwd, ".pi", "sandbox.json"),
	};
}

export function loadConfig(cwd: string): SandboxConfig {
	const { globalPath, projectPath } = getConfigPaths(cwd);
	const globalConfig = readJsonConfig(globalPath, true);
	const projectConfig = readJsonConfig(projectPath, true);
	return mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig);
}

function writeConfigFile(configPath: string, config: SandboxConfigFile): void {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(config, null, "\t") + "\n", "utf-8");
}

/** Write a full project/global config file (used by the settings editor). */
export function writeConfigContent(
	configPath: string,
	content: string,
): { ok: true } | { ok: false; error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : error}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "Configuration must be a JSON object." };
	}
	writeConfigFile(configPath, parsed as SandboxConfigFile);
	return { ok: true };
}

/** Raw file content of a config file, or "{}" when it does not exist. */
export function readConfigFile(configPath: string): string {
	try {
		return readFileSync(configPath, "utf-8");
	} catch {
		return "{}";
	}
}

export interface RawConfiguredEntries {
	readPaths: string[];
	writePaths: string[];
}

/**
 * Entries explicitly configured in the global/project config files (defaults
 * excluded, since removing a default requires overriding the array instead).
 */
export function getRawConfiguredEntries(cwd: string): RawConfiguredEntries {
	const { globalPath, projectPath } = getConfigPaths(cwd);
	const globalConfig = readJsonConfig(globalPath, false);
	const projectConfig = readJsonConfig(projectPath, false);
	const collect = (key: "allowRead" | "allowWrite"): string[] => {
		const values = [
			...stringArray((globalConfig.filesystem as Record<string, unknown> | undefined)?.[key]) ?? [],
			...stringArray((projectConfig.filesystem as Record<string, unknown> | undefined)?.[key]) ?? [],
		];
		return [...new Set(values)];
	};
	return {
		readPaths: collect("allowRead"),
		writePaths: collect("allowWrite"),
	};
}

/** Remove an entry from the relevant allow list in every config file that has it. */
export function removeFromConfigs(
	cwd: string,
	kind: "read" | "write",
	value: string,
): void {
	const { globalPath, projectPath } = getConfigPaths(cwd);
	for (const configPath of [projectPath, globalPath]) {
		if (kind === "read") removeReadPathFromConfig(configPath, value);
		else removeWritePathFromConfig(configPath, value);
	}
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
	updateArrayInConfig(configPath, "allowRead", (existing) =>
		existing.includes(pathToAdd) ? existing : [...existing, pathToAdd],
	);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
	updateArrayInConfig(configPath, "allowWrite", (existing) =>
		existing.includes(pathToAdd) ? existing : [...existing, pathToAdd],
	);
}

export function removeReadPathFromConfig(configPath: string, pathToRemove: string): void {
	const config = readJsonConfig(configPath, false);
	const existing =
		stringArray((config.filesystem as Record<string, unknown> | undefined)?.["allowRead"]) ?? [];
	if (!existing.includes(pathToRemove)) return;
	updateArrayInConfig(configPath, "allowRead", (current) =>
		current.filter((entry) => entry !== pathToRemove),
	);
}

export function removeWritePathFromConfig(configPath: string, pathToRemove: string): void {
	const config = readJsonConfig(configPath, false);
	const existing =
		stringArray((config.filesystem as Record<string, unknown> | undefined)?.["allowWrite"]) ?? [];
	if (!existing.includes(pathToRemove)) return;
	updateArrayInConfig(configPath, "allowWrite", (current) =>
		current.filter((entry) => entry !== pathToRemove),
	);
}

function updateArrayInConfig(
	configPath: string,
	key: "allowRead" | "allowWrite",
	update: (existing: string[]) => string[],
): void {
	const config = readJsonConfig(configPath, false);
	const existing =
		stringArray((config.filesystem as Record<string, unknown> | undefined)?.[key]) ?? [];
	const updated = update(existing);
	config.filesystem = {
		...(config.filesystem as Record<string, unknown> | undefined),
		[key]: updated,
	} as SandboxConfigFile["filesystem"];
	writeConfigFile(configPath, config);
}

export function setScalarInConfig(configPath: string, key: string, value: unknown): void {
	const config = readJsonConfig(configPath, false) as Record<string, unknown>;
	config[key] = value;
	writeConfigFile(configPath, config);
}

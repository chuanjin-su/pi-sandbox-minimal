import { existsSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	getConfigPaths,
	getRawConfiguredEntries,
	readConfigFile,
	removeFromConfigs,
	setScalarInConfig,
	writeConfigContent,
	type SandboxConfig,
} from "./config.ts";
import { canonicalizePath } from "./policy.ts";
import type { SessionAllowances } from "./sandbox-runtime.ts";
import { formatSandboxConfiguration, showPermissionPrompt } from "./ui.ts";

export type AllowKind = "read" | "write";

/** What the menu needs from the extension's live sandbox state. */
export interface SandboxController {
	isEnabled(): boolean;
	isInitialized(): boolean;
	getAllowances(): SessionAllowances;
	getConfig(): SandboxConfig;
	enable(ctx: ExtensionContext): Promise<boolean>;
	disable(ctx: ExtensionContext): Promise<boolean>;
	/** Re-read config from disk and re-apply it to the running sandbox. */
	refresh(ctx: ExtensionContext): Promise<void>;
	/** Record a granted permission (session and/or persistent config) and re-apply. */
	applyChoice(
		choice: "session" | "project" | "global",
		kind: AllowKind,
		value: string,
		cwd: string,
	): Promise<void>;
	/** Drop a session-only allowance and re-apply the sandbox config. */
	removeSessionAllowance(kind: AllowKind, value: string, cwd: string): Promise<void>;
}

const KIND_LABELS: Record<AllowKind, string> = {
	read: "read path",
	write: "write path",
};

const KIND_CONFIG_KEY: Record<AllowKind, string> = {
	read: "allowRead",
	write: "allowWrite",
};

function allowancesList(allowances: SessionAllowances, kind: AllowKind): string[] {
	return kind === "read" ? allowances.readPaths : allowances.writePaths;
}

async function editConfigFile(ctx: ExtensionContext, label: string, path: string): Promise<void> {
	const edited = await ctx.ui.editor(`${label} — ${path}`, readConfigFile(path));
	if (edited === undefined) {
		ctx.ui.notify("Config edit cancelled", "info");
		return;
	}
	const content = edited.trim().length === 0 ? "{}" : edited;
	const result = writeConfigContent(path, content);
	if (!result.ok) {
		ctx.ui.notify(`Config NOT saved — ${result.error}`, "error");
		return;
	}
	ctx.ui.notify(`Saved ${path}`, "info");
}

async function promptAddRule(
	controller: SandboxController,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	kind: AllowKind,
): Promise<void> {
	const kindLabel = KIND_LABELS[kind];
	const raw = await ctx.ui.input(`New ${kindLabel}:`, "~/path");
	if (raw === undefined || raw.trim().length === 0) return;

	const value = canonicalizePath(raw.trim());
	const choice = await showPermissionPrompt(
		pi,
		ctx,
		`Add ${value} to ${KIND_CONFIG_KEY[kind]}?`,
		value,
		(ruleValue) => (ruleValue.trim().length === 0 ? "Rule cannot be empty." : null),
	);
	if (choice.action === "abort") {
		ctx.ui.notify("Not added", "info");
		return;
	}
	await controller.applyChoice(choice.action, kind, choice.value, ctx.cwd);
	ctx.ui.notify(`Added ${choice.value} to ${KIND_CONFIG_KEY[kind]}`, "info");
}

async function promptRemoveRule(
	controller: SandboxController,
	ctx: ExtensionContext,
	kind: AllowKind,
): Promise<void> {
	const kindLabel = KIND_LABELS[kind];
	const configured = getRawConfiguredEntries(ctx.cwd);
	const allowances = controller.getAllowances();
	const entries = [
		...new Set([
			...(kind === "read" ? configured.readPaths : configured.writePaths),
			...allowancesList(allowances, kind),
		]),
	];
	if (entries.length === 0) {
		ctx.ui.notify(
			`No configured ${kindLabel}s to remove (built-in defaults are overridden by editing a config file).`,
			"info",
		);
		return;
	}

	const selected = await ctx.ui.select(`Remove which ${kindLabel}?`, [...entries, "(cancel)"]);
	if (selected === undefined || selected === "(cancel)") return;

	removeFromConfigs(ctx.cwd, kind, selected);
	if (allowancesList(allowances, kind).includes(selected)) {
		await controller.removeSessionAllowance(kind, selected, ctx.cwd);
	} else {
		await controller.refresh(ctx);
	}
	ctx.ui.notify(`Removed ${selected}`, "info");
}

async function toggleUserShellSandboxing(
	controller: SandboxController,
	ctx: ExtensionContext,
): Promise<void> {
	const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
	// Scalar settings: the project config takes precedence when it exists.
	const target = existsSync(projectPath) ? projectPath : globalPath;
	const current = controller.getConfig().sandboxUserShell ?? true;
	setScalarInConfig(target, "sandboxUserShell", !current);
	await controller.refresh(ctx);
	ctx.ui.notify(`sandboxUserShell ${!current ? "enabled" : "disabled"} in ${target}`, "info");
}

async function settingsMenu(
	controller: SandboxController,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const TOGGLES = ["Sandbox ! commands: on (toggle)", "Sandbox ! commands: off (toggle)"];
	for (;;) {
		const userShell = controller.getConfig().sandboxUserShell === false ? "off" : "on";
		const action = await ctx.ui.select("Sandbox settings", [
			`Sandbox ! commands: ${userShell} (toggle)`,
			"Add read path",
			"Add write path",
			"Remove read path",
			"Remove write path",
			"Edit project config",
			"Edit global config",
			"Back",
		]);
		if (action === undefined || action === "Back") return;

		if (TOGGLES.includes(action)) {
			await toggleUserShellSandboxing(controller, ctx);
		} else if (action === "Add read path") {
			await promptAddRule(controller, pi, ctx, "read");
		} else if (action === "Add write path") {
			await promptAddRule(controller, pi, ctx, "write");
		} else if (action === "Remove read path") {
			await promptRemoveRule(controller, ctx, "read");
		} else if (action === "Remove write path") {
			await promptRemoveRule(controller, ctx, "write");
		} else if (action === "Edit project config") {
			const { projectPath } = getConfigPaths(ctx.cwd);
			await editConfigFile(ctx, "Project sandbox config", projectPath);
			await controller.refresh(ctx);
		} else if (action === "Edit global config") {
			const { globalPath } = getConfigPaths(ctx.cwd);
			await editConfigFile(ctx, "Global sandbox config", globalPath);
			await controller.refresh(ctx);
		}
	}
}

export async function runSandboxMenu(
	controller: SandboxController,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	for (;;) {
		const enabled = controller.isEnabled();
		const toggleLabel = enabled ? "Disable (this session)" : "Enable (this session)";
		const action = await ctx.ui.select("Sandbox", [
			"Show status",
			toggleLabel,
			"Settings…",
			"Reload config from disk",
			"Exit",
		]);
		if (action === undefined || action === "Exit") return;

		if (action === "Show status") {
			ctx.ui.notify(
				formatSandboxConfiguration(
					enabled,
					controller.isInitialized(),
					controller.getConfig(),
					getConfigPaths(ctx.cwd),
					controller.getAllowances(),
				),
				"info",
			);
		} else if (action === "Disable (this session)") {
			if (await controller.disable(ctx)) ctx.ui.notify("Sandbox disabled", "info");
		} else if (action === "Enable (this session)") {
			if (await controller.enable(ctx)) ctx.ui.notify("Sandbox enabled", "info");
		} else if (action === "Settings…") {
			await settingsMenu(controller, pi, ctx);
		} else if (action === "Reload config from disk") {
			await controller.refresh(ctx);
			ctx.ui.notify("Sandbox config reloaded", "info");
		}
	}
}

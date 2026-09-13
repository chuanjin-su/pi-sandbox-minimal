import { createSandboxManager } from "@carderne/sandbox-runtime";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	isToolCallEventType,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
	addReadPathToConfig,
	addWritePathToConfig,
	getConfigPaths,
	loadConfig,
} from "./config.ts";
import {
	canonicalizePath,
	matchesPattern,
	resolveWritePermission,
} from "./policy.ts";
import {
	createSandboxedBashOps,
	extractBlockedWritePath,
	initializeSandbox,
	resolveAllowances,
	updateSandboxConfig,
	type SessionAllowances,
} from "./sandbox-runtime.ts";
import {
	formatSandboxConfiguration,
	promptReadBlock,
	promptWriteBlock,
} from "./ui.ts";
import { installSandboxFooter, requestFooterRender } from "./footer.ts";
import { runSandboxMenu, type AllowKind, type SandboxController } from "./menu.ts";

export default function (pi: ExtensionAPI) {
	const sandboxManager = createSandboxManager();
	pi.registerFlag("no-sandbox", {
		description: "Disable filesystem sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const userShellPath = SettingsManager.create(localCwd).getShellPath();
	const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

	let sandboxEnabled = false;
	let sandboxInitialized = false;
	const allowances: SessionAllowances = { readPaths: [], writePaths: [] };
	let sessionWritePathCount = 0;

	const effectiveReadPaths = (cwd: string) => resolveAllowances(loadConfig(cwd), allowances).readPaths;
	const effectiveWritePaths = (cwd: string) =>
		resolveAllowances(loadConfig(cwd), allowances).writePaths;

	function updateStatus(): void {
		// The footer shows the sandbox state inline on its first line (footer.ts);
		// no ctx.ui.setStatus segment is used, so nothing blanks when disabled.
		sessionWritePathCount = effectiveWritePaths(localCwd).length;
		requestFooterRender();
	}

	async function refreshSandbox(cwd: string): Promise<void> {
		if (!sandboxInitialized) return;
		try {
			updateSandboxConfig(sandboxManager, loadConfig(cwd), allowances);
		} catch (error) {
			console.error(`Warning: Failed to update sandbox configuration: ${error}`);
		}
	}

	async function applyChoice(
		choice: "session" | "project" | "global",
		kind: AllowKind,
		value: string,
		cwd: string,
	): Promise<void> {
		const { globalPath, projectPath } = getConfigPaths(cwd);
		const target = choice === "project" ? projectPath : globalPath;

		if (kind === "read") {
			if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
			if (choice !== "session") addReadPathToConfig(target, value);
		} else {
			if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
			if (choice !== "session") addWritePathToConfig(target, value);
		}
		await refreshSandbox(cwd);
		updateStatus();
	}

	async function removeSessionAllowance(kind: AllowKind, value: string, cwd: string): Promise<void> {
		if (kind === "read") {
			allowances.readPaths = allowances.readPaths.filter((entry) => entry !== value);
		} else {
			allowances.writePaths = allowances.writePaths.filter((entry) => entry !== value);
		}
		await refreshSandbox(cwd);
		updateStatus();
	}

	async function enableSandbox(ctx: ExtensionContext): Promise<boolean> {
		if (sandboxEnabled) {
			ctx.ui.notify("Sandbox is already enabled", "info");
			return false;
		}

		const config = loadConfig(ctx.cwd);
		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return false;
		}

		try {
			await initializeSandbox(sandboxManager, config, allowances);
			sandboxEnabled = true;
			sandboxInitialized = true;
			updateStatus();
			return true;
		} catch (error) {
			sandboxEnabled = false;
			ctx.ui.notify(
				`Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
				"error",
			);
			return false;
		}
	}

	async function disableSandbox(ctx: ExtensionContext): Promise<boolean> {
		if (!sandboxEnabled) {
			ctx.ui.notify("Sandbox is already disabled", "info");
			return false;
		}

		if (sandboxInitialized) {
			try {
				await sandboxManager.reset();
			} catch {
				// Ignore cleanup errors.
			}
		}
		sandboxEnabled = false;
		sandboxInitialized = false;
		updateStatus();
		return true;
	}

	const controller: SandboxController = {
		isEnabled: () => sandboxEnabled,
		isInitialized: () => sandboxInitialized,
		getAllowances: () => allowances,
		getConfig: () => loadConfig(localCwd),
		enable: enableSandbox,
		disable: disableSandbox,
		async refresh(ctx) {
			if (!sandboxEnabled) return;
			if (!sandboxInitialized) {
				// Enabled but never initialized (e.g. dependencies were missing at
				// session_start): clear the flag so enableSandbox does a full init.
				sandboxEnabled = false;
				await enableSandbox(ctx);
				return;
			}
			await refreshSandbox(ctx.cwd);
			updateStatus();
		},
		applyChoice,
		removeSessionAllowance,
	};

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const runBash = () => {
				if (!sandboxEnabled || !sandboxInitialized) {
					return localBash.execute(id, params, signal, onUpdate, ctx);
				}
				return createBashToolDefinition(localCwd, {
					operations: createSandboxedBashOps(sandboxManager, userShellPath),
					shellPath: userShellPath,
				}).execute(id, params, signal, onUpdate, ctx);
			};

			let result: AgentToolResult<any>;
			try {
				result = await runBash();
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
					throw error;
				}
				result = {
					content: [
						{
							type: "text",
							text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
						},
					],
					details: {},
				};
			}

			if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
				const output = result.content
					.filter((content: any) => content.type === "text")
					.map((content: any) => content.text)
					.join("\n");
				const blockedPath = extractBlockedWritePath(output);

				if (blockedPath) {
					const path = canonicalizePath(blockedPath);
					const config = loadConfig(ctx.cwd);
					const writePermission = await resolveWritePermission({
						path,
						allowWrite: effectiveWritePaths(ctx.cwd),
						denyWrite: config.filesystem?.denyWrite ?? [],
						prompt: (path) => promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
						saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
					});
					if (writePermission.action === "deny") {
						return result;
					}
					if (writePermission.action === "allow") {
						await refreshSandbox(ctx.cwd);
						return runBash();
					}
					if (writePermission.action === "granted") {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `\n--- Write access granted for "${writePermission.value}", retrying ---\n`,
								},
							],
							details: {},
						});
						return runBash();
					}
				}
			}
			return result;
		},
	});

	pi.on("user_bash", async (event, ctx) => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		if (loadConfig(ctx.cwd).sandboxUserShell === false) return;
		return {
			operations: createSandboxedBashOps(sandboxManager, userShellPath),
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!sandboxEnabled) return;
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;
		const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

		// Read-family tools: read, ls, grep, find (path defaults to the project).
		const readPath = isToolCallEventType("read", event)
			? event.input.path
			: isToolCallEventType("ls", event)
				? (event.input.path ?? ".")
				: isToolCallEventType("grep", event)
					? (event.input.path ?? ".")
					: isToolCallEventType("find", event)
						? (event.input.path ?? ".")
						: undefined;

		if (readPath !== undefined) {
			const path = canonicalizePath(readPath);
			if (!matchesPattern(path, effectiveReadPaths(ctx.cwd))) {
				const choice = await promptReadBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds);
				if (choice.action === "abort") {
					return {
						block: true,
						reason:
							`Sandbox: read access denied for "${path}" via ${event.toolName} ` +
							`(not in allowRead). To allow it, use /sandbox → Settings or edit:\n` +
							`  ${projectPath}\n  ${globalPath}`,
					};
				}
				await applyChoice(choice.action, "read", choice.value, ctx.cwd);
			}
			return;
		}

		// Write-family tools: write, edit.
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = canonicalizePath((event.input as { path: string }).path);
			const writePermission = await resolveWritePermission({
				path,
				allowWrite: effectiveWritePaths(ctx.cwd),
				denyWrite: config.filesystem?.denyWrite ?? [],
				prompt: (path) => promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
				saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
			});
			if (writePermission.action === "deny") {
				return {
					block: true,
					reason:
						`Sandbox: write access denied for "${path}" (in denyWrite). ` +
						`To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
				};
			}
			if (writePermission.action === "abort") {
				return {
					block: true,
					reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
				};
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Custom footer with the sandbox state inline on the first line. Re-registered
		// per session_start so ctx stays fresh across session switches/reloads.
		installSandboxFooter(pi, ctx, () => ({ enabled: sandboxEnabled, writePathCount: sessionWritePathCount }));

		if (pi.getFlag("no-sandbox") as boolean) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}
		if (!loadConfig(ctx.cwd).enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}
		await enableSandbox(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (!sandboxInitialized) return;
		try {
			await sandboxManager.reset();
		} catch {
			// Ignore cleanup errors.
		}
	});

	pi.registerCommand("sandbox", {
		description: "Open the sandbox menu: status, enable/disable, settings",
		handler: async (_args, ctx) => {
			await runSandboxMenu(controller, pi, ctx);
		},
	});
}

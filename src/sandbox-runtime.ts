import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import type { ISandboxManager, SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import type { SandboxConfig } from "./config.ts";
import { canonicalizePath } from "./policy.ts";
import { getSystemTempPaths } from "./system-temp.ts";
import { buildStrictSandboxSpawn, getBashRuntimeReadPaths } from "./strict-sandbox.ts";

export interface SessionAllowances {
	readPaths: string[];
	writePaths: string[];
}

export interface EffectiveAllowances {
	readPaths: string[];
	writePaths: string[];
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

const canonicalizeFilesystemPattern = (path: string) => {
	if (path.includes("*")) return path;
	const canonical = canonicalizePath(path);
	if (canonical.includes("*")) {
		throw new Error(`A literal path containing '*' cannot be safely compiled as a sandbox rule: ${path}`);
	}
	return canonical;
};

const canonicalizeFilesystemPatterns = (paths: string[]) =>
	unique(paths.map(canonicalizeFilesystemPattern));

export function resolveAllowances(
	config: SandboxConfig,
	allowances?: SessionAllowances,
	platform: NodeJS.Platform = process.platform,
): EffectiveAllowances {
	const writePaths = unique([
		...(config.filesystem?.allowWrite ?? []),
		...(allowances?.writePaths ?? []),
		...(config.allowSystemTemp === true ? getSystemTempPaths({ platform }) : []),
	]);

	return {
		readPaths: unique([
			...(config.filesystem?.allowRead ?? []),
			...(allowances?.readPaths ?? []),
			...writePaths,
		]),
		writePaths,
	};
}

/**
 * Compile the shared user-data allowances plus explicit bash OS dependencies.
 * Omitting network.allowedDomains prevents the lifecycle manager from starting
 * proxies. The owned strict adapter (not runtime.wrapWithSandbox) enforces the
 * filesystem policy and deliberately leaves network access unrestricted.
 */
export function buildRuntimeConfig(
	config: SandboxConfig,
	allowances?: SessionAllowances,
	platform: NodeJS.Platform = process.platform,
): SandboxRuntimeConfig {
	const effective = resolveAllowances(config, allowances, platform);

	return {
		// Omitting network.allowedDomains disables all network restriction.
		network: {},
		filesystem: {
			disabled: config.filesystem?.disabled,
			// Explicit read allowances override denyRead, just as for file tools.
			// The adapter always enforces an allowlist, even with no public denies.
			denyRead: ["/"],
			allowRead: canonicalizeFilesystemPatterns([
				...effective.readPaths,
				...getBashRuntimeReadPaths(platform),
			]),
			allowWrite: canonicalizeFilesystemPatterns(effective.writePaths),
			denyWrite: canonicalizeFilesystemPatterns(config.filesystem?.denyWrite ?? []),
		},
		ignoreViolations: config.ignoreViolations,
		enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
		allowPty: config.allowPty,
		bwrapPath: config.bwrapPath,
	} as SandboxRuntimeConfig;
}

export async function initializeSandbox(
	manager: ISandboxManager,
	config: SandboxConfig,
	allowances?: SessionAllowances,
): Promise<void> {
	const runtimeConfig = buildRuntimeConfig(config, allowances);
	// Validate before activation, not after a command has already started.
	buildStrictSandboxSpawn(runtimeConfig, ":", getShellConfig().shell, process.cwd());
	await manager.initialize(runtimeConfig);
}

export function updateSandboxConfig(
	manager: ISandboxManager,
	config: SandboxConfig,
	allowances: SessionAllowances,
): void {
	// Permission updates must not tear down infrastructure used by concurrent
	// commands. New commands snapshot filesystem rules when spawned.
	const runtimeConfig = buildRuntimeConfig(config, allowances);
	buildStrictSandboxSpawn(runtimeConfig, ":", getShellConfig().shell, process.cwd());
	manager.updateConfig(runtimeConfig);
}

function unquoteDiagnosticPath(path: string): string {
	return /^(['"]).*\1$/.test(path) ? path.slice(1, -1) : path;
}

export function extractBlockedWritePath(output: string): string | null {
	// Shell redirections report the path as written, including relative paths.
	const shellMatch = output.match(
		/^(?:\/[^\n:]*\/)?(?:bash|sh): (?:line \d+: )?(.+?): (?:Operation not permitted|Permission denied|Read-only file system)$/m,
	);
	if (shellMatch) return unquoteDiagnosticPath(shellMatch[1]!);

	// BSD touch: "touch: ../file: Operation not permitted"
	// GNU touch: "touch: cannot touch '../file': Permission denied"
	const touchMatch = output.match(
		/^(?:\/[^\n:]*\/)?touch: (?:cannot touch |setting times of )?(.+?): (?:Operation not permitted|Permission denied|Read-only file system|No such file or directory)$/m,
	);
	return touchMatch ? unquoteDiagnosticPath(touchMatch[1]!) : null;
}

/** Only recognized read-command diagnostics; never infer permission from code. */
export function extractBlockedReadPath(output: string): string | null {
	const match = output.match(
		/^(?:\/[^\n:]*\/)?(?:cat|head|tail|ls|grep|find|wc|stat|less|sed): (.+?): (?:Operation not permitted|Permission denied|No such file or directory)$/m,
	);
	if (!match) return null;
	return unquoteDiagnosticPath(match[1]!);
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) finalize(exitCode);
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

export function createSandboxedBashOps(
	manager: ISandboxManager,
	shellPath?: string,
): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

			if (signal?.aborted) throw new Error("aborted");
			const { shell } = getShellConfig(shellPath);
			const launch = buildStrictSandboxSpawn(manager.getConfig(), command, shell, cwd);

			// Spawn the sandbox directly. Never evaluate the command (or BASH_ENV)
			// in an unsandboxed outer shell.
			const child = spawn(launch.file, launch.args, {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			const killProcessGroup = () => {
				if (!child.pid) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			};

			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					killProcessGroup();
				}, timeout * 1000);
			}

			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			signal?.addEventListener("abort", killProcessGroup, { once: true });

			try {
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", killProcessGroup);
			}
		},
	};
}

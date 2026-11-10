import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export function expandFilesystemPattern(filePath: string): string {
	return resolve(filePath.replace(/^~(?=$|\/)/, homedir()));
}

/** Shared wildcard compiler for file-tool checks and the macOS OS policy. */
export function filesystemPatternRegex(pattern: string): RegExp {
	const escaped = expandFilesystemPattern(pattern)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function canonicalizePath(filePath: string): string {
	const absolutePath = expandFilesystemPattern(filePath);
	try {
		return realpathSync.native(absolutePath);
	} catch {
		const tail: string[] = [];
		let probe = absolutePath;
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) return absolutePath;
			tail.unshift(basename(probe));
			probe = parent;
		}
		try {
			return resolve(realpathSync.native(probe), ...tail);
		} catch {
			return absolutePath;
		}
	}
}

export function matchesPattern(filePath: string, patterns: string[]): boolean {
	const absolutePath = canonicalizePath(filePath);
	return patterns.some((pattern) => {
		if (pattern.includes("*")) return filesystemPatternRegex(pattern).test(absolutePath);
		const absolutePattern = canonicalizePath(pattern);
		const separator = absolutePattern.endsWith("/") ? "" : "/";
		return absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + separator);
	});
}

export type WritePolicy = "allow" | "prompt" | "deny";

export function decideWritePolicy(
	path: string,
	allowWrite: string[],
	denyWrite: string[],
): WritePolicy {
	if (matchesPattern(path, denyWrite)) return "deny";
	if (allowWrite.length === 0 || !matchesPattern(path, allowWrite)) return "prompt";
	return "allow";
}

export interface WritePermissionResult {
	action: "allow" | "deny" | "granted" | "abort";
	value?: string;
}

/**
 * Write permission resolution with pi-sandbox semantics: denyWrite hard-blocks,
 * anything not in allowWrite is prompted, and a granted prompt is persisted
 * (session and/or config) by the caller via saveWritePermission.
 */
export async function resolveWritePermission({
	path,
	allowWrite,
	denyWrite,
	prompt,
	saveWritePermission,
}: {
	path: string;
	allowWrite: string[];
	denyWrite: string[];
	prompt: (path: string) => Promise<{
		action: "abort" | "session" | "project" | "global";
		value: string;
	}>;
	saveWritePermission: (
		choice: "session" | "project" | "global",
		value: string,
	) => Promise<void>;
}): Promise<WritePermissionResult> {
	const policy = decideWritePolicy(path, allowWrite, denyWrite);
	if (policy !== "prompt") return { action: policy };

	const choice = await prompt(path);
	if (choice.action === "abort") return { action: "abort", value: choice.value };

	await saveWritePermission(choice.action, choice.value);
	return { action: "granted", value: choice.value };
}

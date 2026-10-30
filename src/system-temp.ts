import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, parse } from "node:path";

import { canonicalizePath } from "./policy.ts";

let darwinTempDir: string | undefined;
let darwinTempError: Error | undefined;
const reportedWarnings = new Set<string>();

function warnOnce(message: string): void {
	if (reportedWarnings.has(message)) return;
	reportedWarnings.add(message);
	console.warn(message);
}

function readDarwinTempDir(): string {
	// Unlike TMPDIR, this is the per-user directory native macOS APIs use.
	// It is stable for this process/user; avoid spawning getconf per tool call.
	if (darwinTempError) throw darwinTempError;
	try {
		return (darwinTempDir ??= execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
			maxBuffer: 4096,
		}).trim());
	} catch (error) {
		darwinTempError = error instanceof Error ? error : new Error(String(error));
		throw darwinTempError;
	}
}

/** Resolve exact temp directories, never the whole macOS /var/folders tree. */
export function getSystemTempPaths({
	platform = process.platform,
	tempDir = tmpdir(),
	getDarwinTempDir = readDarwinTempDir,
	warn = warnOnce,
}: {
	platform?: NodeJS.Platform;
	tempDir?: string;
	getDarwinTempDir?: () => string;
	warn?: (message: string) => void;
} = {}): string[] {
	const paths = [tempDir];
	if (platform === "darwin" || platform === "linux") paths.push("/tmp");
	if (platform === "darwin") {
		try {
			paths.push(getDarwinTempDir().trim());
		} catch (error) {
			// Keep the sandbox active with fewer grants if discovery is unavailable.
			warn(`Sandbox: cannot discover macOS system temp directory; no grant added: ${error}`);
		}
	}

	const canonicalPaths: string[] = [];
	for (const path of paths) {
		// Never turn an empty value into cwd, a root into unrestricted access,
		// or a literal directory into a wildcard rule. Skip unsafe candidates
		// rather than throwing into the extension's initialization error path.
		if (!isAbsolute(path) || path.includes("*")) {
			warn(`Sandbox: ignoring invalid system temporary directory: ${JSON.stringify(path)}`);
			continue;
		}
		const canonical = canonicalizePath(path);
		if (canonical === parse(canonical).root) {
			warn(`Sandbox: ignoring filesystem root as system temporary directory: ${path}`);
			continue;
		}
		canonicalPaths.push(canonical);
	}
	return [...new Set(canonicalPaths)];
}

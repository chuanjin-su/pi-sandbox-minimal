import { deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";

import { canonicalizePath } from "../src/policy.ts";
import { getSystemTempPaths } from "../src/system-temp.ts";

const canonicalPaths = (paths: string[]) => [...new Set(paths.map(canonicalizePath))];

describe("getSystemTempPaths", () => {
	it("discovers macOS native temp even when TMPDIR points elsewhere", () => {
		const paths = getSystemTempPaths({
			platform: "darwin",
			tempDir: "/tmp/custom-temp",
			getDarwinTempDir: () => "/var/folders/test/user/T/\n",
		});
		deepStrictEqual(paths, canonicalPaths([
			"/tmp/custom-temp", "/tmp", "/var/folders/test/user/T",
		]));
		ok(!paths.includes(canonicalizePath("/var/folders")));
		ok(!paths.includes(canonicalizePath("/var/folders/test/user/C")));
	});

	it("uses runtime temp and /tmp on Linux without calling getconf", () => {
		deepStrictEqual(getSystemTempPaths({
			platform: "linux",
			tempDir: "/custom-runtime-temp",
			getDarwinTempDir: () => { throw new Error("must not query macOS on Linux"); },
		}), canonicalPaths(["/custom-runtime-temp", "/tmp"]));
	});

	it("canonicalizes and deduplicates directory aliases", () => {
		deepStrictEqual(getSystemTempPaths({
			platform: "darwin",
			tempDir: "/tmp/",
			getDarwinTempDir: () => "/tmp",
		}), [canonicalizePath("/tmp")]);
	});

	it("keeps valid grants and warns without throwing if macOS discovery fails", () => {
		const warnings: string[] = [];
		deepStrictEqual(getSystemTempPaths({
			platform: "darwin",
			tempDir: "/tmp",
			getDarwinTempDir: () => { throw new Error("getconf failed"); },
			warn: (message) => warnings.push(message),
		}), [canonicalizePath("/tmp")]);
		ok(warnings.some((message) => message.includes("getconf failed")));
	});

	it("omits empty, relative, root, and wildcard discovered paths with a warning", () => {
		for (const invalid of ["", "relative/T", "/", "/tmp/..", "/var/folders/*/T"]) {
			const warnings: string[] = [];
			deepStrictEqual(getSystemTempPaths({
				platform: "darwin", tempDir: "/tmp", getDarwinTempDir: () => invalid,
				warn: (message) => warnings.push(message),
			}), [canonicalizePath("/tmp")]);
			ok(warnings.length > 0);
		}
	});

	it("also omits unsafe runtime temp paths without disabling other grants", () => {
		const warnings: string[] = [];
		deepStrictEqual(getSystemTempPaths({
			platform: "linux", tempDir: "/", warn: (message) => warnings.push(message),
		}), [canonicalizePath("/tmp")]);
		ok(warnings.some((message) => message.includes("filesystem root")));
	});
});

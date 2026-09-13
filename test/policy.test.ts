import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	canonicalizePath,
	decideWritePolicy,
	matchesPattern,
	resolveWritePermission,
} from "../src/policy.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
	// Canonicalize: on macOS /tmp is a symlink to /private/tmp.
	const dir = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-minimal-")));
	tempDirs.push(dir);
	return dir;
}

describe("canonicalizePath", () => {
	it("resolves relative paths against cwd", () => {
		ok(canonicalizePath("./src").startsWith(process.cwd()));
	});

	it("expands ~", () => {
		ok(canonicalizePath("~").startsWith("/"));
	});

	it("resolves symlinks for existing paths and keeps non-existing tails", () => {
		const real = tempRoot();
		strictEqual(canonicalizePath(join(real, "new", "file")), join(real, "new", "file"));
	});
});

describe("matchesPattern", () => {
	it("matches by prefix (directory scope)", () => {
		ok(matchesPattern("/tmp/a/b.txt", ["/tmp"]));
		ok(matchesPattern("/tmp/a/b.txt", ["/tmp/"]));
		ok(!matchesPattern("/tmpx/a", ["/tmp"]));
	});

	it("resolves relative patterns against cwd", () => {
		const cwd = process.cwd();
		ok(matchesPattern(join(cwd, ".env"), [".env"]));
		ok(!matchesPattern("/elsewhere/.env", [".env"]));
	});

	it("supports wildcards", () => {
		const cwd = process.cwd();
		ok(matchesPattern(join(cwd, "cert.pem"), ["*.pem"]));
		ok(matchesPattern(join(cwd, ".env.local"), [".env.*"]));
		ok(!matchesPattern("/elsewhere/cert.pem", ["*.pem"]));
	});

	it("supports ~ in patterns", () => {
		ok(matchesPattern(canonicalizePath("~/.ssh/id_ed25519"), ["~/.ssh"]));
		ok(!matchesPattern("/etc/passwd", ["~/.ssh"]));
	});

	it("matches exact paths exactly", () => {
		strictEqual(matchesPattern("/tmp/file", ["/tmp/file"]), true);
		strictEqual(matchesPattern("/tmp/filex", ["/tmp/file"]), false);
	});
});

describe("decideWritePolicy", () => {
	it("denyWrite wins over allowWrite", () => {
		strictEqual(decideWritePolicy("/tmp/file", ["/tmp"], ["/tmp/file"]), "deny");
	});

	it("empty allowWrite prompts for everything", () => {
		strictEqual(decideWritePolicy("/tmp/file", [], []), "prompt");
	});

	it("paths inside allowWrite are allowed", () => {
		strictEqual(decideWritePolicy("/tmp/file", ["/tmp"], []), "allow");
	});

	it("paths outside allowWrite are prompted", () => {
		strictEqual(decideWritePolicy("/tmp/file", ["/var"], []), "prompt");
	});
});

describe("resolveWritePermission", () => {
	const calls: string[] = [];

	afterEach(() => {
		calls.length = 0;
	});

	it("returns deny without prompting when path is in denyWrite", async () => {
		const result = await resolveWritePermission({
			path: "/tmp/file",
			allowWrite: ["/tmp"],
			denyWrite: ["/tmp/file"],
			prompt: async () => {
				calls.push("prompted");
				return { action: "session", value: "/tmp/file" };
			},
			saveWritePermission: async () => {
				calls.push("saved");
			},
		});
		strictEqual(result.action, "deny");
		deepStrictEqual(calls, []);
	});

	it("persists granted prompts via saveWritePermission", async () => {
		const result = await resolveWritePermission({
			path: "/elsewhere/x",
			allowWrite: ["/tmp"],
			denyWrite: [],
			prompt: async () => ({ action: "project", value: "/elsewhere" }),
			saveWritePermission: async (choice, value) => {
				calls.push(`${choice}:${value}`);
			},
		});
		strictEqual(result.action, "granted");
		strictEqual(result.value, "/elsewhere");
		deepStrictEqual(calls, ["project:/elsewhere"]);
	});

	it("returns allow without prompting when allowed", async () => {
		const result = await resolveWritePermission({
			path: "/tmp/x",
			allowWrite: ["/tmp"],
			denyWrite: [],
			prompt: async () => {
				calls.push("prompted");
				return { action: "abort", value: "/tmp/x" };
			},
			saveWritePermission: async () => {
				calls.push("saved");
			},
		});
		strictEqual(result.action, "allow");
		deepStrictEqual(calls, []);
	});

	it("returns abort when the user aborts the prompt", async () => {
		const result = await resolveWritePermission({
			path: "/elsewhere/x",
			allowWrite: ["/tmp"],
			denyWrite: [],
			prompt: async () => ({ action: "abort", value: "/elsewhere/x" }),
			saveWritePermission: async () => {
				calls.push("saved");
			},
		});
		strictEqual(result.action, "abort");
		deepStrictEqual(calls, []);
	});
});

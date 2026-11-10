import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerSandbox from "../src/extension.ts";
import { canonicalizePath } from "../src/policy.ts";

it("does not let agent edits to project config self-grant access or disable file checks", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-policy-snapshot-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	const configDir = join(workspace, ".pi");
	mkdirSync(configDir, { recursive: true });
	mkdirSync(agentDir);
	const configPath = join(configDir, "sandbox.json");
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "OUTSIDE_SECRET");
	writeFileSync(configPath, JSON.stringify({ filesystem: {
		allowRead: [workspace], allowWrite: [workspace], denyRead: [], denyWrite: [],
	} }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const events = new Map<string, Function>();
	const tools = new Map<string, any>();
	const pi = {
		on(name: string, callback: Function) { events.set(name, callback); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerFlag() {},
		registerCommand() {},
		getFlag() { return false; },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: workspace, mode: "json", hasUI: false, ui: { notify() {} },
		sessionManager: { getSessionId: () => "policy-test", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	try {
		registerSandbox(pi);
		await events.get("session_start")!({}, ctx);
		const read = () => events.get("tool_call")!({ toolName: "read", input: { path: outside } }, ctx);
		strictEqual((await read()).block, true);
		// The file is writable by policy, but changing it isn't permission to
		// install a new policy. Only a human reload/enable action can do that.
		writeFileSync(configPath, JSON.stringify({ filesystem: {
			disabled: true, allowRead: ["/"], allowWrite: ["/"],
		} }));
		strictEqual((await read()).block, true);
		try {
			const result = await tools.get("bash").execute("test", {
				command: `/bin/cat '${outside}'`, timeout: 5,
			}, undefined, undefined, ctx);
			ok(!result.content.some((item: any) => item.text?.includes("OUTSIDE_SECRET")));
		} catch (error) {
			// Hosts without a usable sandbox must fail closed, never run locally.
			ok(String(error).includes("Refusing unsandboxed"), String(error));
		}
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

it("prompts for touch ../file, honors abort/denyWrite, and retries after a session grant", async (t) => {
	const probe = process.platform === "darwin"
		? spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 5000 })
		: process.platform === "linux"
			? spawnSync("bwrap", ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "/bin/true"], { encoding: "utf8", timeout: 5000 })
			: undefined;
	if (!probe || probe.status !== 0) {
		const reason = `Native sandbox unavailable: ${probe?.error?.message ?? probe?.stderr ?? process.platform}`;
		if (process.env.PI_SANDBOX_REQUIRE_NATIVE_TESTS === "1") throw new Error(reason);
		t.skip(reason);
		return;
	}

	const root = mkdtempSync(join(tmpdir(), "pi-touch-prompt-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	const configDir = join(workspace, ".pi");
	mkdirSync(configDir, { recursive: true });
	mkdirSync(agentDir);
	const target = join(root, "created file");
	const denied = join(root, "denied file");
	writeFileSync(denied, "KEEP");
	utimesSync(denied, 1, 1);
	// Linux file bind grants require an existing target. macOS also exercises
	// creation of a new file outside the workspace after the grant.
	if (process.platform === "linux") {
		writeFileSync(target, "EXISTING");
		utimesSync(target, 1, 1);
	}
	writeFileSync(join(configDir, "sandbox.json"), JSON.stringify({
		permissionPromptTimeoutSeconds: 0,
		filesystem: { allowRead: ["."], allowWrite: ["."], denyWrite: [denied] },
	}));
	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(workspace);
	const events = new Map<string, Function>();
	const tools = new Map<string, any>();
	const titles: string[] = [];
	let approve = false;
	const pi = {
		on(name: string, callback: Function) { events.set(name, callback); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerFlag() {}, registerCommand() {}, getFlag() { return false; },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		ui: {
			notify() {}, setFooter() {},
			custom(factory: Function) {
				return new Promise((done) => {
					const component = factory({ requestRender() {} }, { fg: (_color: string, value: string) => value }, undefined, done);
					titles.push(component.render(1000)[0]);
					component.handleInput(approve ? "\r" : "\x1b");
					component.dispose?.();
				});
			},
		},
		sessionManager: { getSessionId: () => "touch-test", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	try {
		registerSandbox(pi);
		await events.get("session_start")!({}, ctx);
		const touch = (name: string) => tools.get("bash").execute("touch-test", {
			command: `/usr/bin/touch '../${name}'`, timeout: 5,
		}, undefined, undefined, ctx);

		const blocked = await touch("created file");
		strictEqual(titles.length, 1, `touch denial must open the write permission prompt: ${JSON.stringify(blocked)}`);
		ok(titles[0]!.includes("Write blocked"));
		ok(titles[0]!.includes(canonicalizePath(target)));
		ok(blocked.content.some((item: any) => /(?:permitted|denied|Read-only)/.test(item.text ?? "")));
		if (process.platform === "darwin") ok(!existsSync(target));
		else strictEqual(statSync(target).mtimeMs, 1000);

		approve = true;
		await touch("created file");
		strictEqual(titles.length, 2);
		ok(existsSync(target));
		ok(statSync(target).mtimeMs > 1000, "approved touch must execute successfully");
		await touch("created file");
		strictEqual(titles.length, 2, "session grant must prevent repeated prompts");

		approve = false;
		await touch("ungranted sibling");
		strictEqual(titles.length, 3, "a file grant must not grant its parent directory");
		ok(!existsSync(join(root, "ungranted sibling")));

		await touch("denied file");
		strictEqual(titles.length, 3, "denyWrite must remain a hard block without prompting");
		strictEqual(statSync(denied).mtimeMs, 1000);
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { runSandboxMenu, type SandboxController } from "../src/menu.ts";
import { SandboxStatusView, showSandboxStatus } from "../src/status-view.ts";

const status = "Sandbox Status\n" + Array.from({ length: 60 }, (_, index) => `Row ${String(index).padStart(2, "0")} value`).join("\n");
const theme = { fg: (_color: string, text: string) => text };

function harness(text = status, keys = new KeybindingsManager(TUI_KEYBINDINGS)) {
	const terminal = { rows: 20 };
	let renders = 0;
	let closes = 0;
	const tui = { terminal: terminal as TUI["terminal"], requestRender() { renders++; } };
	const view = new SandboxStatusView(text, tui, theme, keys, () => { closes++; });
	return { view, terminal, tui, keys, renders: () => renders, closes: () => closes };
}

describe("SandboxStatusView", () => {
	it("scrolls by lines/pages and supports Home/End without changing status text", () => {
		const { view, renders } = harness();
		const first = view.render(80).join("\n");
		ok(first.includes("Sandbox Status"));
		ok(first.includes("Row 00"));
		ok(!first.includes("Row 59"));
		ok(first.includes("Enter/Esc close"));
		strictEqual(view.capturesViewportInput, true);

		view.handleInput("\x1b[B");
		ok(!view.render(80).join("\n").includes("Row 00"));
		view.handleInput("\x1b[6~");
		ok(!view.render(80).join("\n").includes("Row 01"));
		view.handleInput("\x1b[F");
		ok(view.render(80).join("\n").includes("Row 59"));
		view.handleInput("\x1b[5~");
		ok(!view.render(80).join("\n").includes("Row 59"));
		view.handleInput("\x1b[H");
		ok(view.render(80).join("\n").includes("Row 00"));
		view.handleInput("\x1b[A");
		ok(view.render(80).join("\n").includes("Row 00"));
		ok(renders() > 0);
	});

	it("honors injected keybindings and dismisses exactly once", () => {
		const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.down": "j", "tui.select.confirm": "x", "tui.select.cancel": "z",
		});
		const { view, closes } = harness(status, keys);
		ok(view.render(80).join("\n").includes("x/z close"));
		view.handleInput("j");
		ok(!view.render(80).join("\n").includes("Row 00"));
		view.handleInput("\r");
		strictEqual(closes(), 0);
		view.handleInput("z");
		view.handleInput("x");
		strictEqual(closes(), 1);
	});

	it("supports Enter, Escape, and Ctrl+C dismissal with default bindings", () => {
		for (const key of ["\r", "\x1b", "\x03"]) {
			const { view, closes } = harness();
			view.handleInput(key);
			strictEqual(closes(), 1);
		}
	});

	it("fits short/narrow terminals and clamps scrolling after resize", () => {
		const { view, terminal } = harness("Sandbox Status\n" + "目录/📁/very-long-path/".repeat(20));
		for (const rows of [1, 2, 3, 4, 8, 24]) {
			terminal.rows = rows;
			for (const width of [1, 2, 3, 6, 12, 40, 100]) {
				const lines = view.render(width);
				ok(lines.length <= Math.max(1, Math.floor(rows * 0.9)), `${width}×${rows}: too many rows`);
				for (const line of lines) ok(visibleWidth(line) <= width, `${width}×${rows}: line overflow`);
			}
		}
		const resized = harness();
		resized.view.render(80);
		resized.view.handleInput("\x1b[F");
		resized.terminal.rows = 200;
		const expanded = resized.view.render(100).join("\n");
		ok(expanded.includes("Row 00"));
		ok(expanded.includes("Row 59"));
	});

	it("wraps complete long paths instead of discarding their tails", () => {
		const path = "/long/" + "nested-directory/".repeat(30) + "final-file.json";
		const { view, terminal } = harness(`Sandbox Status\n${path}`);
		terminal.rows = 200;
		const lines = view.render(24);
		const reconstructed = lines.slice(1, -2).map((line) => line.slice(2, -2).trimEnd()).join("");
		strictEqual(reconstructed, path);
	});

	it("rebuilds themed output on invalidation", () => {
		const { tui, keys } = harness();
		let color = "\x1b[31m";
		const view = new SandboxStatusView(status, tui, {
			fg: (_color: string, text: string) => color + text + "\x1b[0m",
		}, keys, () => {});
		ok(view.render(80).join("").includes("\x1b[31m"));
		color = "\x1b[34m";
		view.invalidate();
		const updated = view.render(80).join("");
		ok(updated.includes("\x1b[34m"));
		ok(!updated.includes("\x1b[31m"));
	});
});

describe("status dialog integration", () => {
	it("uses a selection dialog outside TUI without emitting notifications", async () => {
		const selections: unknown[] = [];
		const ctx = {
			mode: "rpc", hasUI: true,
			ui: {
				async select(title: string, options: string[]) { selections.push([title, options]); return "Back"; },
				custom() { throw new Error("RPC must not use custom TUI"); },
				notify() { throw new Error("Status must not be printed"); },
			},
		} as unknown as ExtensionContext;
		await showSandboxStatus(ctx, status);
		deepStrictEqual(selections, [[status, ["Back"]]]);
	});

	it("does nothing without UI", async () => {
		await showSandboxStatus({ hasUI: false } as ExtensionContext, status);
	});

	it("awaits overlay dismissal before returning to the sandbox menu, without a status notification", async () => {
		const events: string[] = [];
		const choices = ["Show status", "Exit"];
		const { tui, keys } = harness();
		const ctx = {
			cwd: process.cwd(), mode: "tui", hasUI: true,
			ui: {
				async select() { events.push("menu"); return choices.shift(); },
				async custom(factory: Function, options: any) {
					strictEqual(options.overlay, true);
					strictEqual(options.overlayOptions.anchor, "center");
					return new Promise((resolve) => {
						const view = factory(tui, theme, keys, () => { events.push("close"); resolve(undefined); });
						events.push("status");
						ok(view.render(100).join("\n").includes("Enabled (this session): yes"));
						view.handleInput("\x1b");
					});
				},
				notify() { throw new Error("Status must not be printed"); },
			},
		} as unknown as ExtensionContext;
		const controller = {
			isEnabled: () => true, isInitialized: () => true,
			getConfig: () => DEFAULT_CONFIG, getAllowances: () => ({ readPaths: [], writePaths: [] }),
		} as unknown as SandboxController;
		await runSandboxMenu(controller, {} as ExtensionAPI, ctx);
		deepStrictEqual(events, ["menu", "status", "close", "menu"]);
	});
});

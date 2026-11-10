import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	ScrollView,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

const KEY_LABELS: Record<string, string> = {
	enter: "Enter", escape: "Esc", up: "↑", down: "↓", pageUp: "PgUp", pageDown: "PgDn",
};

/** A read-only status snapshot; closing it returns to the sandbox menu. */
export class SandboxStatusView implements Component {
	readonly capturesViewportInput = true;
	private readonly text: Text;
	private readonly scroll: ScrollView;
	private closed = false;

	constructor(
		status: string,
		private readonly tui: Pick<TUI, "terminal" | "requestRender">,
		private readonly theme: Pick<Theme, "fg">,
		private readonly keys: Pick<KeybindingsManager, "matches" | "getKeys">,
		private readonly done: () => void,
	) {
		// The panel border supplies the title; retain every other status line.
		this.text = new Text(status.replace(/^Sandbox Status\n/, ""), 0, 0);
		this.scroll = new ScrollView(this.text);
	}

	invalidate(): void {
		this.scroll.invalidate();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "tui.select.confirm") || this.keys.matches(data, "tui.select.cancel")) {
			this.closed = true;
			this.done();
			return;
		}
		if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
		else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
		else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
		else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
		else return;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent) {
		if (this.closed || event.type !== "wheel") return undefined;
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		this.tui.requestRender();
		return { handled: true };
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const maxHeight = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9));
		const framed = width >= 6 && maxHeight >= 4;
		const footerRows = framed ? 3 : maxHeight > 1 ? 1 : 0;
		const contentWidth = Math.max(1, width - (framed ? 4 : 0));
		const lines = this.text.render(contentWidth);
		const height = Math.min(lines.length, Math.max(1, maxHeight - footerRows));
		this.scroll.updateLayout(lines.length, height, () => this.tui.requestRender());
		const top = this.scroll.scrollTop;
		const visible = lines.slice(top, top + height);
		const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => {
			const binding = this.keys.getKeys(action)[0];
			return binding ? KEY_LABELS[binding] ?? binding : "—";
		};
		const hint = `${key("tui.select.confirm")}/${key("tui.select.cancel")} close · ` +
			`${key("tui.select.up")}${key("tui.select.down")} scroll · ` +
			`${key("tui.select.pageUp")}/${key("tui.select.pageDown")} page · Home/End`;
		const fit = (line: string, size = width) => truncateToWidth(line, size, "", true);
		if (!framed) {
			return [...visible, ...(footerRows ? [this.theme.fg("dim", hint)] : [])].map((line) => fit(line));
		}

		const border = (line: string) => this.theme.fg("border", line);
		const title = truncateToWidth(` Sandbox Status ${top + 1}–${top + height}/${lines.length} `, width - 2, "");
		const row = (line: string) => border("│") + " " + fit(line, contentWidth) + " " + border("│");
		return [
			border("╭") + this.theme.fg("accent", title) + border("─".repeat(width - 2 - visibleWidth(title)) + "╮"),
			...visible.map((line) => row(this.theme.fg("text", line))),
			row(this.theme.fg("dim", hint)),
			border("╰" + "─".repeat(width - 2) + "╯"),
		];
	}
}

export async function showSandboxStatus(ctx: ExtensionContext, status: string): Promise<void> {
	if (!ctx.hasUI) return;
	if (ctx.mode !== "tui") {
		await ctx.ui.select(status, ["Back"]);
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keys, done) => new SandboxStatusView(status, tui, theme, keys, () => done()),
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } },
	);
}

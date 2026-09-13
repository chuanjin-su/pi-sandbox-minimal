import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Nerd Font glyphs: nf-fa-lock / nf-fa-lock_open. */
const LOCK = "\uf023";
const LOCK_OPEN = "\uf2fc";

export interface SandboxFooterState {
	/** Session-level sandbox toggle (enable/disable). */
	enabled: boolean;
	/** Effective write paths (config + session allowances) shown as the count. */
	writePathCount: number;
}

type RenderHook = () => void;

let requestRender: RenderHook | undefined;

/** Ask the TUI to redraw the footer (called when sandbox state changes). */
export function requestFooterRender(): void {
	requestRender?.();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Replace the home directory with ~ (mirrors pi's built-in footer). */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function collectUsageTotals(entries: SessionEntry[]): {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
} {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as AssistantMessage).usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost?.total ?? 0;
			const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate =
				latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			const usage = entry.message.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost?.total ?? 0;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			const usage = entry.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost?.total ?? 0;
		}
	}

	return { totals, latestCacheHitRate };
}

/**
 * Replace the built-in footer with one that shows the sandbox state inline on
 * the first line, next to the cwd/branch:
 *
 *   ~/Workspace/project (main) [<LOCK> 3 write paths]
 *   ↑1.2k ↓3.4k R12k $0.123 42.1%/200k       model • high
 *
 * Line 1 mirrors pi's built-in footer (cwd, git branch, session name) with the
 * sandbox segment inserted: `[<LOCK> N write paths]` while enabled (N = effective
 * write paths incl. session allowances), `[<LOCK_OPEN> Sandbox off]` when off.
 * The lock glyphs are Nerd Font glyphs (nf-fa-lock \uf023, nf-fa-lock_open
 * \uf2fc) and require a Nerd Font terminal.
 * Line 2 replicates pi's token/context stats; other extensions' statuses stay
 * on their own trailing line.
 */
export function installSandboxFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	getState: () => SandboxFooterState,
): void {
	if (ctx.mode !== "tui") return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		const myRenderHook: RenderHook = () => tui.requestRender();
		requestRender = myRenderHook;

		return {
			invalidate() {},
			dispose() {
				unsub();
				if (requestRender === myRenderHook) requestRender = undefined;
			},
			render(width: number): string[] {
				const state = getState();
				const { totals, latestCacheHitRate } = collectUsageTotals(ctx.sessionManager.getEntries());

				// ---- Line 1: pwd (branch) [sandbox] • sessionName ----
				let pwd = formatCwdForFooter(
					ctx.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				const branch = footerData.getGitBranch();
				if (branch) {
					pwd = `${pwd} (${branch})`;
				}
				const sandboxSegment = state.enabled
					? ` [${LOCK} ${state.writePathCount} write paths]`
					: ` [${LOCK_OPEN} Sandbox off]`;
				const sessionName = ctx.sessionManager.getSessionName();
				const sessionSegment = sessionName ? ` • ${sessionName}` : "";
				const pwdLine = truncateToWidth(
					theme.fg("dim", pwd) + theme.fg("dim", sandboxSegment) + theme.fg("dim", sessionSegment),
					width,
					theme.fg("dim", "..."),
				);

				// ---- Line 2: token/context stats, model right-aligned ----
				const statsParts: string[] = [];
				if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
				if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
				if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
				if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
				if (
					(totals.cacheRead > 0 || totals.cacheWrite > 0) &&
					latestCacheHitRate !== undefined
				) {
					statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				const usingSubscription = ctx.model?.provider === "kimi-coding";
				if (totals.cost || usingSubscription) {
					statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
				}

				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercentValue = contextUsage?.percent ?? 0;
				const contextPercent =
					contextUsage?.percent !== null && contextUsage?.percent !== undefined
						? contextPercentValue.toFixed(1)
						: "?";
				const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
				if (contextPercentValue > 90) {
					statsParts.push(theme.fg("error", contextPercentDisplay));
				} else if (contextPercentValue > 70) {
					statsParts.push(theme.fg("warning", contextPercentDisplay));
				} else {
					statsParts.push(contextPercentDisplay);
				}

				let statsLeft = statsParts.join(" ");
				let statsLeftWidth = visibleWidth(statsLeft);
				if (statsLeftWidth > width) {
					statsLeft = truncateToWidth(statsLeft, width, "...");
					statsLeftWidth = visibleWidth(statsLeft);
				}

				const minPadding = 2;
				const modelName = ctx.model?.id || "no-model";
				let rightSide = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel() ?? "off";
					rightSide =
						thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
				}
				if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
					const withProvider = `(${ctx.model.provider}) ${rightSide}`;
					if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
						rightSide = withProvider;
					}
				}
				const rightSideWidth = visibleWidth(rightSide);
				const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
				let statsLine: string;
				if (totalNeeded <= width) {
					const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
					statsLine = statsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - minPadding;
					if (availableForRight > 0) {
						const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						const truncatedRightWidth = visibleWidth(truncatedRight);
						const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
						statsLine = statsLeft + padding + truncatedRight;
					} else {
						statsLine = statsLeft;
					}
				}

				// Dim each part separately (statsLeft may contain colored context %).
				const dimStatsLeft = theme.fg("dim", statsLeft);
				const remainder = statsLine.slice(statsLeft.length);
				const dimRemainder = theme.fg("dim", remainder);

				const lines = [pwdLine, dimStatsLeft + dimRemainder];

				// ---- Line 3: other extensions' statuses (pi renders these from
				// ctx.ui.setStatus; ours is inline on line 1 instead) ----
				const extensionStatuses = footerData.getExtensionStatuses();
				if (extensionStatuses.size > 0) {
					const sortedStatuses = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text));
					lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
				}

				return lines;
			},
		};
	});
}

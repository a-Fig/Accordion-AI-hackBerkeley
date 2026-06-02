/**
 * Accordion Context Extension  (proof-of-concept)
 * =================================================
 * Continuous, reversible, turn-level context compression for pi.
 *
 * Idea
 * ----
 * Instead of one slow, destructive `/compact` that rewrites your whole history
 * into a single summary, the accordion keeps the most-recent slice of the
 * conversation at FULL fidelity and folds everything older into a compact
 * digest -- per turn, like accordion pleats. The fold is REVERSIBLE: nothing is
 * destroyed, so any folded turn can be expanded back to full fidelity on demand.
 *
 * Why this is cheap / safe to do
 * ------------------------------
 * The `context` event hands us a DEEP COPY of the message array that is about to
 * be sent to the model, and lets us return a replacement. pi's on-disk session
 * log (sessionManager) still retains every original entry. So:
 *   - Folding  = replace old turns with a digest in THIS call only.
 *   - Expanding = simply don't fold that turn on the next call.
 * The only state we persist is tiny: where the rolling fold-boundary sits, and
 * which turns the user has manually pinned open.
 *
 * What's implemented in this POC
 * ------------------------------
 *   - Rolling, automatic compression with a hysteresis band:
 *       keep the live (uncompressed) tail under CEILING; once it crosses,
 *       fold oldest turns until the tail is back under FLOOR.
 *   - MANUAL expansion: `/expand <turn#>` pins a folded turn open again.
 *   - `/accordion` status table, `/collapse <turn#>` to re-fold.
 *   - pi's native compaction is suppressed while the accordion is active.
 *
 * Deliberately NOT yet implemented (future work):
 *   - LLM-generated summaries (this POC uses a deterministic structured digest
 *     so behaviour is reproducible and debuggable).
 *   - Intra-turn folding (a single huge turn is never split).
 *   - Automatic / relevance-based expansion.
 *
 * Output shape mirrors pi's own native compaction exactly -- a single
 * `compactionSummary` message at the front, followed by real messages starting
 * at a user turn -- which is provider-safe by construction and never splits a
 * tool-call from its tool-result (we only ever move WHOLE turns).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config -- edit these and run /reload to retune. (token counts are estimates)
// ---------------------------------------------------------------------------
const RECENT_CEILING_TOKENS = 150_000; // start folding once the live tail exceeds this
const RECENT_FLOOR_TOKENS = 25_000; //   ...and fold down until the tail is under this
const CHARS_PER_TOKEN = 4; //            crude token estimator (good enough for boundary logic)
const STATE_TYPE = "accordion-state"; // custom session-entry type used to persist state

// ---------------------------------------------------------------------------
// Persisted state (reconstructed from the session log on session_start)
// ---------------------------------------------------------------------------
let boundaryTurn = 0; // turns with index <= boundaryTurn are folded (0 = nothing folded)
let expanded = new Set<number>(); // turn indices the user manually pinned open

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const truncate = (s: string, n: number): string =>
	s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";

function getText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b && b.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join(" ");
	}
	return "";
}

/** Crude per-message token estimate. Uniform + cheap; only used for boundary math. */
function estimateTokens(m: any): number {
	let chars = 0;
	if (typeof m.summary === "string") chars += m.summary.length; // compaction/branch summaries
	const content = m.content;
	if (typeof content === "string") {
		chars += content.length;
	} else if (Array.isArray(content)) {
		for (const b of content as any[]) {
			if (b?.type === "text") chars += (b.text?.length ?? 0);
			else if (b?.type === "thinking") chars += (b.thinking?.length ?? 0);
			else if (b?.type === "toolCall") chars += (b.name?.length ?? 0) + JSON.stringify(b.input ?? {}).length;
			else if (b?.type === "image") chars += 1500 * CHARS_PER_TOKEN; // rough flat cost for an image
			else chars += JSON.stringify(b ?? {}).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + 4; // +4 per-message overhead
}

// ---------------------------------------------------------------------------
// Turn segmentation. A "turn" starts at a user message and runs until the next
// user message (so it contains the assistant reply + any tool calls/results).
// Cutting only at user-message boundaries guarantees we never orphan a
// tool-call / tool-result pair when we fold.
// ---------------------------------------------------------------------------
interface Turn {
	index: number; // 1-based, stable from the start of the conversation
	messages: AgentMessage[];
	tokens: number;
}

function segment(messages: AgentMessage[]): { preamble: AgentMessage[]; turns: Turn[] } {
	const preamble: AgentMessage[] = [];
	const turns: Turn[] = [];
	let current: AgentMessage[] | null = null;

	const flush = () => {
		if (current) {
			const tokens = current.reduce((s, m) => s + estimateTokens(m), 0);
			turns.push({ index: turns.length + 1, messages: current, tokens });
			current = null;
		}
	};

	for (const m of messages) {
		if ((m as any).role === "user") {
			flush();
			current = [m];
		} else if (current === null) {
			preamble.push(m); // anything before the first user message (rare)
		} else {
			current.push(m);
		}
	}
	flush();
	return { preamble, turns };
}

function firstUserLine(t: Turn): string {
	const u = t.messages.find((m: any) => m.role === "user");
	return getText((u as any)?.content).split("\n")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Deterministic per-turn digest (placeholder for a future LLM summary).
// ---------------------------------------------------------------------------
function turnDigest(t: Turn): string {
	const parts: string[] = [];
	for (const m of t.messages as any[]) {
		if (m.role === "user") {
			parts.push(`USER: ${truncate(getText(m.content), 280)}`);
		} else if (m.role === "assistant") {
			const txt = getText(m.content).trim();
			if (txt) parts.push(`ASSISTANT: ${truncate(txt, 220)}`);
			const calls = (Array.isArray(m.content) ? m.content : [])
				.filter((b: any) => b?.type === "toolCall")
				.map((b: any) => `${b.name}(${truncate(JSON.stringify(b.input ?? {}), 80)})`);
			if (calls.length) parts.push(`  ↳ tools: ${calls.join(", ")}`);
		} else if (m.role === "toolResult") {
			const flag = m.isError ? " ERROR" : "";
			parts.push(`  RESULT[${m.toolName}${flag}]: ${truncate(getText(m.content), 140)}`);
		}
	}
	return parts.join("\n");
}

function buildSummaryMessage(compressed: Turn[]): AgentMessage {
	const totalTok = compressed.reduce((s, t) => s + t.tokens, 0);
	const idxs = compressed.map((t) => t.index);
	const range = idxs.length === 1 ? `${idxs[0]}` : `${Math.min(...idxs)}–${Math.max(...idxs)}`;
	const pinned = [...expanded].filter((i) => i <= boundaryTurn).sort((a, b) => a - b);

	const header =
		`[ACCORDION — COMPRESSED HISTORY]\n` +
		`The earliest ${compressed.length} turn(s) (turns ${range}, ~${totalTok.toLocaleString()} tokens) ` +
		`are folded into the digest below to conserve context.` +
		(pinned.length
			? ` Turns ${pinned.join(", ")} were manually expanded and appear IN FULL after this digest.`
			: ``) +
		`\nEach bullet is one turn; full fidelity can be restored on request (user runs /expand <turn#>).`;

	const body = compressed.map((t) => `\n— Turn ${t.index} (~${t.tokens} tok) —\n${turnDigest(t)}`).join("\n");

	const maxTs = compressed
		.flatMap((t) => t.messages.map((m: any) => (typeof m.timestamp === "number" ? m.timestamp : 0)))
		.reduce((a, b) => Math.max(a, b), 0);

	return {
		role: "compactionSummary",
		summary: `${header}\n${body}`,
		tokensBefore: totalTok,
		timestamp: maxTs || Date.now(),
	} as unknown as AgentMessage;
}

// ---------------------------------------------------------------------------
// Rolling boundary with hysteresis. Boundary only moves FORWARD (folding more),
// which is what makes the compression "rolling". Manual /expand overrides it for
// specific turns without moving the boundary back.
// ---------------------------------------------------------------------------
function recomputeBoundary(turns: Turn[]): boolean {
	const liveTail = () => turns.filter((t) => t.index > boundaryTurn).reduce((s, t) => s + t.tokens, 0);
	let changed = false;
	if (liveTail() > RECENT_CEILING_TOKENS) {
		// fold oldest live turns until the tail is back under the floor,
		// but always keep at least the most-recent turn live.
		while (liveTail() > RECENT_FLOOR_TOKENS && boundaryTurn < turns.length - 1) {
			boundaryTurn++;
			changed = true;
		}
	}
	return changed;
}

function persist(pi: ExtensionAPI): void {
	pi.appendEntry(STATE_TYPE, { boundaryTurn, expanded: [...expanded] });
}

function liveMessages(ctx: ExtensionContext): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type === "message") out.push(entry.message);
	}
	return out;
}

// ===========================================================================
export default function accordionExtension(pi: ExtensionAPI): void {
	// --- restore persisted state for this branch -----------------------------
	pi.on("session_start", (_event, ctx) => {
		boundaryTurn = 0;
		expanded = new Set();
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data) {
				boundaryTurn = entry.data.boundaryTurn ?? 0;
				expanded = new Set<number>(entry.data.expanded ?? []);
			}
		}
		ctx.ui.setStatus("accordion", ctx.ui.theme.fg("accent", "\u{1FA97} accordion"));
	});

	// --- the engine: rewrite the outgoing message array every LLM call -------
	pi.on("context", (event, ctx) => {
		const { preamble, turns } = segment(event.messages);
		if (turns.length === 0) return; // nothing to do

		if (recomputeBoundary(turns)) persist(pi);
		if (boundaryTurn <= 0) return; // under the ceiling -> pass through untouched

		const compressed = turns.filter((t) => t.index <= boundaryTurn && !expanded.has(t.index));
		if (compressed.length === 0) return; // everything foldable is pinned open -> pass through

		const out: AgentMessage[] = [...preamble, buildSummaryMessage(compressed)];
		for (const t of turns) {
			const folded = t.index <= boundaryTurn && !expanded.has(t.index);
			if (!folded) out.push(...t.messages); // expanded + live tail, in chronological order
		}
		return { messages: out };
	});

	// --- suppress pi's native compaction while the accordion is driving ------
	pi.on("session_before_compact", (_event, ctx) => {
		ctx.ui.notify("Accordion active — native compaction suppressed.", "info");
		return { cancel: true };
	});

	// --- /accordion : status table -------------------------------------------
	pi.registerCommand("accordion", {
		description: "Show accordion compression status (folded vs live turns)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const { turns } = segment(liveMessages(ctx));
			const tailTok = turns.filter((t) => t.index > boundaryTurn).reduce((s, t) => s + t.tokens, 0);
			const foldTok = turns
				.filter((t) => t.index <= boundaryTurn && !expanded.has(t.index))
				.reduce((s, t) => s + t.tokens, 0);

			const lines = [
				`Accordion — ${turns.length} turns | boundary=${boundaryTurn} | band ${RECENT_FLOOR_TOKENS / 1000}k–${RECENT_CEILING_TOKENS / 1000}k`,
				`live tail ~${tailTok.toLocaleString()} tok | folded ~${foldTok.toLocaleString()} tok | pinned-open: [${[...expanded].sort((a, b) => a - b).join(",") || "none"}]`,
				...turns.map((t) => {
					const state =
						t.index > boundaryTurn ? "LIVE" : expanded.has(t.index) ? "EXPANDED" : "folded";
					return `  #${String(t.index).padStart(3)}  ${state.padEnd(8)} ~${String(t.tokens).padStart(6)} tok  ${truncate(firstUserLine(t), 56)}`;
				}),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// --- /expand <n> : pin a folded turn open --------------------------------
	pi.registerCommand("expand", {
		description: "Expand a folded turn back to full fidelity: /expand <turn#>",
		getArgumentCompletions: (prefix: string) => {
			const n = prefix.trim();
			const cands: number[] = [];
			for (let i = 1; i <= boundaryTurn; i++) if (!expanded.has(i)) cands.push(i);
			return cands
				.filter((i) => String(i).startsWith(n))
				.map((i) => ({ value: String(i), label: `turn ${i}` }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const n = parseInt(args.trim(), 10);
			if (!Number.isFinite(n)) {
				ctx.ui.notify("Usage: /expand <turn#>  (see /accordion for numbers)", "warning");
				return;
			}
			expanded.add(n);
			persist(pi);
			ctx.ui.notify(`Turn ${n} pinned open — shown in full on the next message.`, "info");
		},
	});

	// --- /collapse <n> : re-fold a previously expanded turn ------------------
	pi.registerCommand("collapse", {
		description: "Re-fold a previously expanded turn: /collapse <turn#>",
		getArgumentCompletions: (prefix: string) => {
			const n = prefix.trim();
			return [...expanded]
				.sort((a, b) => a - b)
				.filter((i) => String(i).startsWith(n))
				.map((i) => ({ value: String(i), label: `turn ${i}` }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const n = parseInt(args.trim(), 10);
			if (!Number.isFinite(n) || !expanded.has(n)) {
				ctx.ui.notify("Usage: /collapse <turn#>  (must be a currently-expanded turn)", "warning");
				return;
			}
			expanded.delete(n);
			persist(pi);
			ctx.ui.notify(`Turn ${n} re-folded.`, "info");
		},
	});
}

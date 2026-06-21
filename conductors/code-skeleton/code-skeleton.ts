/*
 * code-skeleton.ts — the Code-skeleton conductor.
 *
 * The idea: a big code-file READ is the single most compressible thing in an agent's
 * context. The agent rarely needs every line of a 5,000-token file it read forty turns
 * ago — it needs the file's SHAPE: its imports/exports, types, class & function
 * signatures, docstrings. So instead of folding such a block to a generic one-line recap
 * ("Read → 412 lines, ~5000 tok"), this conductor replaces it with a structural
 * SKELETON — the file's interface, bodies elided — at roughly a fifth of the tokens.
 *
 * Why this is more than a fancy digest: the skeleton is RECOVERABLE. Each replacement
 * carries the engine's `{#code FOLDED}` tag (via `ReplaceCommand.recoverable`), so the
 * agent can `unfold`/`recall` any skeletonized file back to its full source on demand.
 * The folded view is lossy-by-display but lossless-by-reference — the exact opposite of
 * naive compaction, which discards the original. Progressive disclosure for code:
 * navigate by skeleton, drill into a body when you actually need it.
 *
 *   CLASSIFY  (`classify.ts`)   — which tool_results are large code-file reads? Gated on
 *                                 tool family (read / single-file `cat`), a code file
 *                                 extension, and code-shaped content — so a grep dump, a
 *                                 base64 image, a README, or a JSON blob is never mistaken
 *                                 for source. Strips `cat -n` line numbers + `exec_command`
 *                                 headers so the skeletonizer sees clean code.
 *   SKELETON  (`skeletonize.ts`) — deterministic, dependency-free structural compression
 *                                 (mask-based brace/indent tracking; per-language). Same
 *                                 input ⇒ byte-identical output, so a skeletonized prefix
 *                                 stays cache-warm between passes.
 *
 * Budget discipline (three passes, best-effort like the built-in):
 *   1. skeletonize eligible code reads oldest-first — the PREFERRED, contract-preserving
 *      fold — until live ≤ budget;
 *   2. if still over, generic-fold the remaining foldable blocks (engine digest, also
 *      reversible), built-in order — exactly the built-in's fallback;
 *   3. if STILL over, downgrade the oldest skeletons to plain digests for the extra saving,
 *      so this conductor never leaves more on the table than the built-in would. The hard
 *      floor (protected tail + provider-validity) is the host's, never ours.
 *
 * It is COLLABORATIVE — no involvement locks (ADR 0011). Skeletonizing is a relevance
 * call, not a claim of authority: a human pin keeps a file open, a manual unfold restores
 * it, and the next pass leaves that held block alone (its `held` flag drops it from every
 * candidate set, and the host would clamp a `replace` on it regardless). Under budget →
 * `[]` (raw), matching every shipped in-process conductor. See ADR 0016.
 *
 * Host use is light and synchronous: `countTokens` to size skeletons against the engine's
 * own tokenizer, and `setStatus` for a visible "skeletonized N files, saved ~Xk" readout.
 * No `host.complete` — the compression is rules-based, never an LLM call, so `conduct()`
 * stays synchronous and free.
 */
import type { Command, Conductor, ConductorHost, ConductorView, ViewBlock } from "../contract";
import { FOLD_RANK } from "../builtin/builtin";
import { classifyCodeRead } from "./classify";
import { detectLang, skeletonize } from "./skeletonize";

/** Don't bother skeletonizing a read smaller than this — the fixed header/tag overhead and
 *  the kept signatures wouldn't shrink a small file enough to be worth the lossy view. */
const MIN_SKELETON_TOKENS = 1500;

/** A skeleton must cost no more than this fraction of the full block to be worth replacing.
 *  A file that is already mostly signatures (little body to elide) fails this and is left
 *  for the generic fold instead. */
const MAX_SKELETON_RATIO = 0.6;

/** Rough token cost of the engine's `{#code FOLDED}` tag + per-block overhead that the host
 *  adds on top of the skeleton body we supply. Used only to keep the saving estimate honest
 *  (slightly conservative); the engine does the real accounting. */
const TAG_OVERHEAD_TOKENS = 10;

/** A computed skeleton for one block, memoized by block id (block text is immutable per id). */
interface Skeleton {
	/** The body the agent will see (header + structural skeleton). The host prepends the tag. */
	content: string;
	/** Estimated token cost of the substitution (body + tag + overhead). */
	skeletonTokens: number;
	/** Estimated tokens saved versus the full block (`block.tokens - skeletonTokens`). */
	saved: number;
}

export class CodeSkeletonConductor implements Conductor {
	readonly id = "code-skeleton";
	readonly label = "Code skeleton";
	// Collaborative — no `locks`.

	private host: ConductorHost | null = null;
	/**
	 * Memo: block id → its skeleton, or `null` if the block is not a worthwhile code read.
	 * A block's `text` is fixed at parse time and never mutated in place, so the skeleton is
	 * invariant for the block's lifetime; caching it keeps `conduct()` cheap across the many
	 * passes a session triggers. Cleared on attach/detach.
	 */
	private cache = new Map<string, Skeleton | null>();

	attach(host: ConductorHost): void {
		this.host = host;
		this.cache.clear();
	}

	detach(): void {
		this.host?.setStatus(null);
		this.host = null;
		this.cache.clear();
	}

	conduct(view: ConductorView): Command[] {
		// Under budget → raw, nothing to do (and clear any stale status).
		if (view.liveTokens <= view.budget) {
			this.host?.setStatus(null);
			return [];
		}

		// callId → tool_call block, so the classifier can recover each read's file path/command.
		const callById = new Map<string, ViewBlock>();
		for (const b of view.blocks) {
			if (b.kind === "tool_call" && b.callId) callById.set(b.callId, b);
		}

		// The candidate gate every conductor respects: foldable (would actually shrink),
		// not human-held, not protected, not already inside a folded group.
		const foldable = view.blocks.filter(
			(b) => !b.held && !b.protected && !b.grouped && b.foldedTokens < b.tokens,
		);

		let live = view.liveTokens;

		// ── Pass 1: skeletonize eligible code reads, oldest-first — the preferred,
		//    contract-preserving fold. ──
		const replaces = new Map<string, Command>();
		const skTokens = new Map<string, number>();
		const codeReads = foldable
			.filter((b) => b.kind === "tool_result" && b.tokens >= MIN_SKELETON_TOKENS)
			.sort((a, b) => a.order - b.order);
		for (const b of codeReads) {
			if (live <= view.budget) break;
			const sk = this.skeletonFor(b, callById);
			if (!sk) continue;
			replaces.set(b.id, { kind: "replace", id: b.id, content: sk.content, recoverable: true });
			skTokens.set(b.id, sk.skeletonTokens);
			live -= sk.saved;
		}

		// ── Pass 2: still over budget → generic-fold the remaining foldable blocks (engine
		//    digest, also reversible), in the built-in's kind-rank then conversation order. ──
		const foldIds: string[] = [];
		if (live > view.budget) {
			const rest = foldable
				.filter((b) => !replaces.has(b.id))
				.sort((a, b) => FOLD_RANK[a.kind] - FOLD_RANK[b.kind] || a.order - b.order);
			for (const b of rest) {
				if (live <= view.budget) break;
				foldIds.push(b.id);
				live += b.foldedTokens - b.tokens;
			}
		}

		// ── Pass 3 (last resort): still over → downgrade the oldest skeletons to plain digests
		//    for the extra saving, so we never leave more on the table than the built-in would.
		//    A skeleton (~signatures) costs more than a one-line digest; trading it back is the
		//    only lever left once every other foldable block is already folded. ──
		if (live > view.budget) {
			for (const b of foldable) {
				if (live <= view.budget) break;
				if (!replaces.has(b.id)) continue;
				replaces.delete(b.id);
				foldIds.push(b.id);
				live -= skTokens.get(b.id)! - b.foldedTokens; // additional saving over the skeleton
			}
		}

		const cmds: Command[] = [...replaces.values()];
		if (foldIds.length) cmds.push({ kind: "fold", ids: foldIds });

		this.publishStatus(replaces.size, foldIds.length, live, view);
		return cmds;
	}

	/** Compute (memoized) the skeleton for a code-read block, or null if it isn't a worthwhile one. */
	private skeletonFor(b: ViewBlock, callById: Map<string, ViewBlock>): Skeleton | null {
		const cached = this.cache.get(b.id);
		if (cached !== undefined) return cached;
		const computed = this.compute(b, callById);
		this.cache.set(b.id, computed);
		return computed;
	}

	private compute(b: ViewBlock, callById: Map<string, ViewBlock>): Skeleton | null {
		const info = classifyCodeRead(b, callById);
		if (!info) return null; // not a code-file read (grep dump, markdown, image, JSON, …)

		const lang = detectLang(info.path, info.source);
		const sk = skeletonize(info.source, lang);
		if (sk.elidedLines === 0) return null; // nothing to elide → no point

		const header = `⟨code skeleton · ${info.path ?? "file"} · ${sk.totalLines}L → ${sk.keptLines}L · ${sk.elidedLines} elided · call unfold for full source⟩`;
		const content = `${header}\n${sk.skeleton}`;

		const skeletonTokens = this.countTokens(content) + TAG_OVERHEAD_TOKENS;
		const saved = b.tokens - skeletonTokens;
		// Worth it only if the skeleton is meaningfully smaller than the original.
		if (saved <= 0 || skeletonTokens > b.tokens * MAX_SKELETON_RATIO) return null;

		return { content, skeletonTokens, saved };
	}

	/** Token count via the host's tokenizer when available; else the engine's chars/4 estimate. */
	private countTokens(text: string): number {
		if (this.host?.can("countTokens")) return this.host.countTokens(text);
		return Math.ceil(text.length / 4);
	}

	private publishStatus(skeletons: number, folds: number, liveAfter: number, view: ConductorView): void {
		if (!this.host) return;
		const saved = view.liveTokens - liveAfter;
		const over = liveAfter > view.budget;
		const parts: string[] = [];
		if (skeletons) parts.push(`${skeletons} skeleton${skeletons === 1 ? "" : "s"}`);
		if (folds) parts.push(`${folds} fold${folds === 1 ? "" : "s"}`);
		const head = parts.length ? parts.join(" + ") : "no foldable blocks";
		const savedK = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : `${Math.max(0, saved)}`;
		this.host.setStatus(`${head} · saved ~${savedK} tok${over ? " · still over budget" : ""}`, {
			skeletons,
			generic_folds: folds,
			tokens_saved: saved,
			live_tokens: liveAfter,
			budget: view.budget,
		});
	}
}

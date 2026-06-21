/*
 * keel.ts — the Keel conductor, Phase 2 (Keel-llm): deterministic core + off-path LLM deep-zone
 * digest (ADR 0017 §14, §9 — "LLM digest (L3/L4 deep)" row).
 *
 * "Preserve the load-bearing structure of the agent's own work, reversibly compress everything
 * else, never destroy anything the agent can't get back." Phase 2 adds recoverable LLM digests for
 * the genuinely cold DEEP region only, via an off-path `host.complete` call (fire-and-forget;
 * conduct() stays synchronous throughout). Phase 3 (Keel-bear2) will add Bear-2 comment squeeze.
 *
 * Per-pass synchronous pipeline (§5):
 *   0. Bookkeeping — prune stale ids; update ACT-R warmth from the tail.
 *   1. ROOTS (§6) — user/spec + first-user + protected + currently-held + fact sources.
 *   2. RELEVANCE (§5.2) — entity-reachability gate + risk stickiness + ACT-R cold order.
 *   3. EPOCH gate (§10) — HOLD the stable fold set while projected ≤ 0.9·cap (cache-warm);
 *      else open an epoch and re-plan down to 0.7·cap.
 *   4. ROUTE each cold unit by CONTENT TYPE → fidelity level (§7): code read → Skeleton (L1);
 *      long prose → Trim (L2); LLM deep digest (L3-llm) if cached, else generic Digest (L3).
 *   4b. LLM DEEP GROUP — if a cached LLM digest exists for this epoch's deep zone, collapse the
 *      deep-zone contiguous run(s) into ONE summary `group` each, BUT ONLY where the group is a NET
 *      TOKEN SAVE vs the run's deterministic fold (Σ foldedTokens). Projection is updated honestly
 *      before the floor runs so the cap guarantee holds.
 *   5. BUDGET LADDER + FLOOR — deepen coldest-first to the epoch target; then the hard-cap floor
 *      GUARANTEES projected ≤ cap (force-fold → force-group → drop).
 *   6. EMIT — coalesce; HOLD (suppress) if the plan signature is unchanged (cache-warm).
 *      After emit: if the deep zone needs an LLM digest and none is cached, fire a background
 *      completion (host.complete off-path) and return null to HOLD while inflight.
 *
 * ASYNC PATTERN (Phase 2):
 *   - `conduct()` is and stays SYNCHRONOUS.
 *   - When the deep region needs LLM text and it is not cached: fire `launchDeepDigest()` in the
 *     background, return the current plan as-is (HOLD). The deep-region blocks fall back to the
 *     deterministic digestLevel (fold) this pass.
 *   - On resolve: stash the LLM text in `llmCache` keyed by the deep-region signature; call
 *     `host.requestRerun()`. On the next pass, `conduct()` finds the cached text and collapses the
 *     deep-zone run(s) into ONE LLM-summary `group` per net-winning contiguous run, instead of the
 *     plain per-block folds.
 *   - On reject: clear inflight; set `lastAttemptKey` so the same region is not retried until its
 *     signature genuinely changes (new blocks age in). Retry-storm prevention.
 *   - Stale guard: if the deep-region signature changed between launch and resolve (new blocks
 *     aged in), the cached text is keyed to the old sig and is never applied — it is silently
 *     discarded on the next epoch rather than written to `llmCache`. The new sig triggers a fresh
 *     launch on the next epoch.
 *   - detach() aborts any in-flight completion via AbortController so post-detach `requestRerun`
 *     never fires.
 *
 * GRACEFUL DEGRADATION (§9):
 *   - If `host.can("complete")` is false (headless tests, demo sessions, read-only transcripts,
 *     no live model link): `launchDeepDigest` is never called. `route()` falls through to
 *     `digestLevel()` exactly as in Phase 1. Behavior is byte-identical to Phase 1. The golden
 *     test is unaffected.
 *
 * REVERSIBILITY (§16):
 *   The L1/L2 ladder (skeleton/trim) emits `replace(recoverable:true)` — content substitution that
 *   keeps the agent's `{#code FOLDED}` unfold/recall handle, valid because Keel never discards the
 *   originals. The L3-deep LLM digest is DIFFERENT: a custom LLM summary text can only be carried
 *   by a `group` (a 1:N region summary; `replace` is 1:1 and `fold` uses the engine digest, not
 *   custom text). A `group` with a non-empty digest is NOT recoverable — the host adds no tag (see
 *   `GroupCommand`). This is the SAME non-recoverable L4 lever the hard-cap floor already uses, and
 *   it is gated to the genuinely-cold deep zone only, AND only when it is a NET TOKEN SAVE over the
 *   deterministic fold of the same run. So the deep region trades its unfold handle for a higher-
 *   quality, strictly-cheaper summary — never a token regression. RESIDUAL: the deep zone loses
 *   unfold/recall on a cache hit. Recovering a custom-text region summary reversibly is not
 *   expressible in the current command vocabulary; if that matters, add `recoverable` to
 *   `GroupCommand` so the host tags region summaries too.
 *
 * COLLABORATIVE — NO LOCKS (§11). Respects the protected tail and held blocks; human/agent
 * overrides always win. Obeys every rule in preview/read-only identically. A PURE function of the
 * view PLUS instance memory (recalls / epoch fold set / llmCache) pruned each pass. Held blocks
 * (human pin or agent unfold) are protected as roots WHILE OPEN per the live `held` flag — once
 * the override is removed they become foldable again; there is no permanent keep-live state.
 * Types only from `../contract` + sibling conductor helpers; no Svelte, no `$state`, no Node/Tauri APIs.
 */
import type { Command, Conductor, ConductorHost, ConductorView, ViewBlock } from "../contract";
import { FOLDABLE_KINDS, type ScoreCtx } from "../cold-score/score";
import { extractIdentifiers, matchBlocks } from "../cold-score/lexical";
import { buildTailText, currentTurn } from "../cold-score/cold-score";
import { identifyRoots } from "./roots";
import { rankCandidates } from "./relevance";
import {
	trySkeleton, tryBear2, tryTrim, digestLevel,
	detectCommentSpans,
	BEAR2_MIN_COMMENT_RATIO, BEAR2_MIN_COMMENT_TOKENS,
	type LevelResult, type CountTokens,
} from "./ladder";
import { harvestFacts } from "./ledger";
import { EPOCH_BAND, effectiveCap, hardCapFloor } from "./budget";
import { blockLabel } from "../compaction-naive/compaction-naive";

/**
 * Phase 2: max output tokens for the deep-zone LLM digest. Sized for the cold-zone job:
 * 3–15 ancient blocks, each already once-triaged (not skeleton-eligible, not trim-eligible).
 * 600 tok is generous for a structured digest while keeping the overall deep-zone cost small —
 * the point of the deep digest is compression, not an exhaustive briefing. The host clamps this
 * to the model's own ceiling if the model's max is lower (safe — the host handles the cap).
 * Justification vs compaction-naive's 8000: compaction-naive summarizes the whole aged region in
 * one pass (potentially 200k tokens of history); Keel's deep zone is only the coldest few blocks
 * that skeleton+trim couldn't fit — much smaller input, proportionally smaller output cap.
 */
const MAX_DEEP_DIGEST_TOKENS = 600;

/**
 * Phase 2: token overhead added to the chars/4 estimate of an LLM-summary group head — the
 * `{#code FOLDED}` recovery tag plus the host's per-block group framing. A conservative constant
 * (the same magnitude the ladder uses for its `{#code FOLDED}` tag overhead) so the net-win gate
 * and the projection it feeds the hard-cap floor never under-count the group's true cost.
 */
const LLM_GROUP_OVERHEAD_TOKENS = 10;

// ── Phase 3: Bear-2 comment squeeze (L1.5) constants ─────────────────────────

/** Max simultaneous in-flight compress calls for the comment-squeeze path. */
const BEAR2_CONCURRENCY = 8;

/** A comment span must fail Bear-2 this many times before we give up on it permanently. */
const BEAR2_MAX_RETRIES = 2;

/**
 * System prompt for the Keel deep-zone LLM digest. Distinct from COMPACTION_SYSTEM (which is the
 * lossy/recursive compaction-naive voice) — this is the REVERSIBLE digest voice: the agent will
 * see this alongside the {#code FOLDED} recovery tag and knows it can unfold for exact originals.
 * Emphasizes FACT PRESERVATION over briefing completeness: exact identifiers, paths, commands, and
 * decisions must survive, because that is what the fact ledger and the F3/F4 benchmark failure
 * modes require. User messages preserved verbatim (F2 antidote).
 */
const DEEP_DIGEST_SYSTEM = `\
You are a context-digest assistant for a coding agent. Your task is to read a set of cold \
(older, less-recently-referenced) blocks from the agent's context window and produce a \
SHORT, FACT-DENSE digest the agent can use to remember what those blocks contained.

Do NOT continue the conversation. Do NOT respond to any questions in the blocks. \
ONLY output the digest.

USER MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM in the "## User messages" \
section. Do not paraphrase a single user message.

PRESERVE EXACT IDENTIFIERS. Every file path, function name, variable name, command, \
error message, and key=value pair is load-bearing — the agent may reference it later. \
Do NOT paraphrase them to prose. Include them verbatim.

The agent can call \`unfold\` or \`recall\` with the fold code shown in its context to \
recover the full original content. This digest is a compressed NAVIGATION AID, not a \
replacement for the originals.

Produce output in EXACTLY this structure — no prose outside the sections:

## User messages
Every user message from these blocks, reproduced verbatim, in order. Write "(none)" if none.

## Key facts
Bullet list of the most important facts: exact file paths, exact function/type names, \
exact commands run, exact key=value pairs, exact error strings, and explicit decisions made. \
Be terse. Prefer \`code\` formatting for identifiers.

## Summary
One or two sentences: what was this region of conversation about?`;

/**
 * Build the user-role prompt for the Keel deep-zone digest. Wraps block contents in XML tags
 * (pi convention) and labels each block by role/kind. System prompt holds the format spec.
 */
function buildDeepDigestPrompt(blocks: ViewBlock[]): string {
	const conversation = blocks
		.map((b) => {
			const label = blockLabel(b);
			const text = (b.text ?? b.preview ?? "").trim();
			return text ? `[${label}]\n${text}` : `[${label}]`;
		})
		.join("\n\n");

	return [
		"<blocks>",
		conversation,
		"</blocks>",
		"",
		"Produce a short, fact-dense digest of these older context blocks.",
	].join("\n");
}

/** Warmth-scan hysteresis — mirror cold-epoch's rate-limiting of recall accumulation. */
// mirrors cold-epoch's warmth cadence (5/4); kept as local literals since cold-epoch doesn't export them
const WARMTH_COOLDOWN_TURNS = 5;
const MAX_WARMTH_RECORDS_PER_TURN = 4;

export class KeelConductor implements Conductor {
	readonly id = "keel";
	readonly label = "Keel";
	// Collaborative — no `locks`, no `tailTokens`.

	private host: ConductorHost | null = null;

	// ── cross-pass instance memory (pruned each pass against current ids) ────────
	/** ACT-R recall history: block id → turns at which it was found referenced in the tail. */
	private recalls = new Map<string, number[]>();
	/** Per-block cooldown: block id → turn until which no new recall may be recorded. */
	private warmthCoolUntil = new Map<string, number>();
	/** The last emitted command batch (re-returned verbatim on the epoch HOLD so the prefix stays cache-warm). */
	private lastPlan: Command[] = [];
	/** id → emitted substitution tokens last pass — drives the cache-warm HOLD projection. */
	private lastEmittedTokens = new Map<string, number>();

	// ── Phase 2: LLM deep-zone digest (async, fire-and-forget) ──────────────────
	/**
	 * Cache of LLM digests for the deep zone. Keyed by the deep-region SIGNATURE
	 * (a deterministic sorted join of the block ids in the deep zone). Populated on
	 * completion resolve; cleared on detach. A cached entry is used on the NEXT pass
	 * when the same deep-region sig is selected — the block gets a recoverable `replace`
	 * instead of a plain engine digest.
	 */
	private llmCache = new Map<string, string>(); // sig → LLM digest text
	/**
	 * AbortController for the current in-flight deep-zone completion, or null when idle.
	 * Aborted in `detach()` so post-detach `requestRerun` never fires.
	 */
	private llmInflight: AbortController | null = null;
	/**
	 * The deep-region signature of the most recently ATTEMPTED completion (whether it
	 * succeeded or failed). Used to prevent retry-storms: if the same deep-zone sig is
	 * selected again after a failed completion, we do NOT re-launch. Only a CHANGED sig
	 * (new blocks aged into the deep zone) allows a new launch. Cleared on attach.
	 */
	private llmLastAttemptKey = "";

	// ── Phase 3: Bear-2 comment squeeze (L1.5, async, fire-and-forget) ──────────
	/**
	 * Cache of Bear-2 compressed text for comment/docstring spans. Keyed by the ORIGINAL
	 * comment span text (deterministic: same span → same compressed output → cached forever).
	 * Once a span is compressed, the result is valid for any block that contains the same
	 * comment text. Cleared on detach.
	 */
	private bear2Cache = new Map<string, string>(); // spanText → compressed text
	/**
	 * In-flight Bear-2 compress calls, keyed by the ORIGINAL span text. Prevents launching
	 * the same span twice simultaneously. Bounded by BEAR2_CONCURRENCY.
	 */
	private bear2InFlight = new Set<string>(); // spanText currently being compressed
	/**
	 * Per-span retry counter. A span that fails BEAR2_MAX_RETRIES times is cached to its
	 * ORIGINAL text (no savings) and never retried — avoids hammering a broken backend.
	 * Cleared on detach.
	 */
	private bear2Retries = new Map<string, number>(); // spanText → fail count
	/**
	 * When true, Bear-2 has hard-failed too many times. The whole L1.5 path is frozen:
	 * `route()` falls back to plain L1 silently. The conductor itself does NOT freeze (only
	 * L1.5 is affected — the deterministic core continues). Stays failed until detach.
	 */
	private bear2Failed = false;

	attach(host: ConductorHost): void {
		this.host = host;
		this.lastPlan = [];
		this.lastEmittedTokens = new Map();
		this.llmCache.clear();
		this.llmInflight = null;
		this.llmLastAttemptKey = "";
		// Phase 3: Bear-2 state reset on attach (new session; don't inherit stale cache).
		this.bear2Cache.clear();
		this.bear2InFlight.clear();
		this.bear2Retries.clear();
		this.bear2Failed = false;
	}

	detach(): void {
		// Abort any in-flight completion so a stale result can't call requestRerun() after detach.
		if (this.llmInflight) {
			this.llmInflight.abort();
			this.llmInflight = null;
		}
		this.host?.setStatus(null);
		this.host = null;
		this.recalls.clear();
		this.warmthCoolUntil.clear();
		this.lastPlan = [];
		this.lastEmittedTokens = new Map();
		this.llmCache.clear();
		this.llmLastAttemptKey = "";
		// Phase 3: Bear-2 state cleared on detach (in-flight guards use host-identity check).
		this.bear2Cache.clear();
		this.bear2InFlight.clear();
		this.bear2Retries.clear();
		this.bear2Failed = false;
	}

	conduct(view: ConductorView): Command[] {
		const blocks = view.blocks;
		const byId = new Map(blocks.map((b) => [b.id, b]));

		// ── 0. Bookkeeping: prune stale ids ─────────────────────────────────────
		for (const id of [...this.recalls.keys()]) if (!byId.has(id)) this.recalls.delete(id);
		for (const id of [...this.warmthCoolUntil.keys()]) if (!byId.has(id)) this.warmthCoolUntil.delete(id);

		const T = currentTurn(blocks);

		// Update ACT-R warmth from the protected tail every turn (continuous accumulation).
		this.updateWarmth(blocks, T);

		// Under budget → raw, nothing to do. Clear the held plan so a later epoch re-plans fresh.
		if (view.liveTokens <= view.budget) {
			this.lastPlan = [];
			this.host?.setStatus(null);
			return [];
		}

		// ── 1. ROOTS ─────────────────────────────────────────────────────────────
		// Roots include every CURRENTLY-held block (human pin / agent unfold) per the live `held`
		// flag — protected while the override stands, foldable again once it is removed. No
		// permanent keep-live set: the view has no provenance to distinguish a pin from an unfold.
		const roots = identifyRoots(blocks);

		// ── 2. RELEVANCE: ordered cold→hot candidate list ───────────────────────
		const tailCallIds = new Set<string>();
		for (const b of blocks) if (b.protected && b.callId) tailCallIds.add(b.callId);
		const ctx: ScoreCtx = { currentTurn: T, recalls: this.recalls, tailCallIds };
		const ranked = rankCandidates(blocks, roots, ctx);

		// ── 3. EPOCH gate ────────────────────────────────────────────────────────
		const cap = effectiveCap(view.budget, view.contextWindow);
		const highTok = EPOCH_BAND.high * cap;
		const lowTok = EPOCH_BAND.low * cap;

		// Projection with the held epoch fold set re-applied. The host clears every pass, so the
		// held plan re-folds the same blocks; we project using the ACTUAL emitted substitution
		// tokens recorded last pass (skeleton/trim cost, not the generic digest), per held block
		// that is still present and still host-foldable (a block the human has since taken over is
		// dropped from the held set — its override wins).
		let projectedHeld = view.liveTokens;
		let heldCount = 0;
		for (const [id, emitted] of this.lastEmittedTokens) {
			const b = byId.get(id);
			if (!b || b.folded || b.held || b.protected || b.grouped) continue;
			projectedHeld += emitted - b.tokens;
			heldCount++;
		}

		// HOLD while the held plan keeps us in band (≤ 0.9·cap) AND under hard budget. Re-emit the
		// last plan byte-for-byte so the prefix stays cache-warm — only re-plan at a real epoch.
		if (heldCount > 0 && projectedHeld <= highTok && projectedHeld <= view.budget && this.lastPlan.length > 0) {
			this.publishStatus(blocks, heldCount, 0, [], projectedHeld, view, /*held*/ true);
			return this.lastPlan;
		}

		// ── 4 + 5. EPOCH: route + deepen coldest-first to the low-water target, then floor ──
		// Target: fold down to 0.7·cap, but never leave us over hard budget.
		const target = Math.min(lowTok, view.budget);

		const callById = new Map<string, ViewBlock>();
		for (const b of blocks) if (b.kind === "tool_call" && b.callId) callById.set(b.callId, b);
		const count: CountTokens = (text) =>
			this.host?.can("countTokens") ? this.host.countTokens(text) : Math.ceil(text.length / 4);

		let projected = view.liveTokens;
		const replaceById = new Map<string, Command>(); // id → ladder `replace` command
		const foldIds: string[] = [];
		const laddered = new Set<string>(); // ids the ladder substituted via `replace`
		const currentTokens = new Map<string, number>(); // id → current contribution (for the floor)
		const emitted = new Map<string, number>(); // id → emitted substitution tokens (for HOLD projection)
		/** Blocks that fell through to plain digestLevel (L3 fold) — the deep-zone candidates. */
		const deepZoneBlocks: ViewBlock[] = [];

		for (const cand of ranked) {
			if (projected <= target) break;
			const b = cand.block;
			const routed = this.route(b, callById, count);
			if (!routed) continue;
			if (routed.command.kind === "replace") {
				replaceById.set(b.id, routed.command);
				laddered.add(b.id);
			} else {
				// Plain fold (digestLevel). Track as a deep-zone candidate for Phase-2 LLM digest.
				foldIds.push(b.id);
				deepZoneBlocks.push(b);
			}
			currentTokens.set(b.id, routed.tokens);
			emitted.set(b.id, routed.tokens);
			// Projection delta: substitution tokens replace the block's full tokens.
			projected -= b.tokens - routed.tokens;
		}

		// Phase 2: after routing, check whether a cached LLM digest exists for this epoch's deep zone.
		// On a cache hit, collapse the deep-zone run(s) into ONE recoverable `group` per contiguous run
		// whose digest is the LLM summary — but ONLY where that is a NET TOKEN SAVE vs the deterministic
		// fold of the same blocks. If no cache, launch a completion.
		//
		// Design notes:
		//   - The LLM cache check is POST-LOOP so the routing loop stays purely deterministic (Phase 1
		//     behavior — same fold SELECTION whether or not a cached digest exists; only digest TEXT is
		//     nondeterministic).
		//   - ALL blocks in the deep zone share ONE sig → ONE cached text → ONE completion call per epoch.
		//   - NET-WIN INVARIANT (the reason this is a group, not N per-block replaces): an LLM summary
		//     (~MAX_DEEP_DIGEST_TOKENS) applied to a single block already folded to ~40 tok is a TOKEN
		//     LOSS. The summary only earns its tokens at the RUN level — one group head replacing a run
		//     whose summed deterministic fold (Σ foldedTokens) is >> the summary. We emit the group ONLY
		//     when groupCost < the run's deterministic fold cost; otherwise the run keeps its plain folds.
		//     The emitted cost for the covered region is therefore ALWAYS ≤ the deterministic fallback.
		//   - PROJECTION HONESTY: when we collapse a run, we update `projected` (and remove the run's
		//     blocks from the floor's foldable consideration via `llmGrouped`) so the hard-cap floor sees
		//     the TRUE post-group contribution and can still deepen/group/drop elsewhere to hold cap.
		//   - STALE guard: the sig is determined AFTER the routing loop. If the deep zone changes
		//     between epochs (new blocks aged in), the sig changes → old cache entry mismatches →
		//     no upgrade → fresh launch. The old cached text is never applied to the new region.
		const llmGroups: Command[] = []; // LLM-summary groups, one per net-winning deep run
		const llmGrouped = new Set<string>(); // ids collapsed into an llmGroup (excluded from the floor)
		if (this.host?.can("complete") && deepZoneBlocks.length > 0) {
			// Sig is the sorted deep-zone id set. Block ids are durable AND content-stable in this
			// engine (an id encodes message location and never re-points at different content), so an
			// id-only sig is content-safe; a content hash would be redundant here.
			const deepSig = deepZoneBlocks.map((b) => b.id).sort().join("\0");
			const cachedText = this.llmCache.get(deepSig)?.trim();
			if (cachedText) {
				// Cost of ONE group head carrying the LLM summary (chars/4 + tag/overhead). A group head
				// over a contiguous run costs roughly the same regardless of run length: the digest text
				// dominates. Compare it to the run's deterministic fold cost (Σ foldedTokens).
				const groupCost = Math.ceil(cachedText.length / 4) + LLM_GROUP_OVERHEAD_TOKENS;
				// Partition the deep zone into contiguous runs by conversation `order` (a group command
				// must cover a contiguous run; the host snaps otherwise). Cold ranking is not contiguous,
				// so several runs are possible.
				for (const run of contiguousRuns(deepZoneBlocks)) {
					let detCost = 0;
					for (const b of run) detCost += b.foldedTokens;
					// NET-WIN gate: only collapse when the LLM group is strictly cheaper than the plain
					// deterministic fold for this run. A LOSS (run too small) keeps its plain folds.
					if (groupCost >= detCost) continue;
					const ids = run.map((b) => b.id);
					// A `group` with a non-empty custom digest is NOT recoverable (the host adds no
					// `{#code FOLDED}` tag — see GroupCommand doc). This is the SAME non-recoverable L4
					// lever the hard-cap floor already uses; it is accepted for the genuinely-cold deep
					// zone (double-gated cold), trading the deep region's unfold/recall handle for a
					// net-win custom summary. The reversible L1/L2 ladder (skeleton/trim) is unaffected.
					llmGroups.push({ kind: "group", ids, digest: cachedText });
					for (const b of run) {
						llmGrouped.add(b.id);
						// Projection honesty: the run's blocks were projected at foldedTokens each; the
						// group replaces all of them with ONE head. Reclaim the difference NOW so the
						// floor sees the true contribution. The head cost is attributed to the first id;
						// the rest contribute 0 (they live inside the group).
						projected -= b.foldedTokens;
					}
					projected += groupCost;
				}
				// Drop the now-grouped ids from the plain fold list (single disposition).
				if (llmGrouped.size > 0) {
					for (let i = foldIds.length - 1; i >= 0; i--) {
						if (llmGrouped.has(foldIds[i])) foldIds.splice(i, 1);
					}
				}
			} else if (deepSig !== this.llmLastAttemptKey && this.llmInflight === null) {
				// No cached text and this sig hasn't been attempted (or failed) → launch.
				this.launchDeepDigest(deepZoneBlocks, deepSig);
			}
			// If deepSig === llmLastAttemptKey: retry-storm prevention — same region, don't re-launch.
			// If llmInflight !== null: already inflight — don't launch a second.
		}

		// ── Hard-cap FLOOR — guarantee projected ≤ cap ──────────────────────────
		// Blocks already collapsed into an LLM-summary group this pass are out of the floor's reach:
		// they carry their group disposition already, so the floor must never fold/group/drop them
		// again (single disposition). Excluding them keeps the floor's projection honest — `projected`
		// already reflects the group head cost reclaimed above.
		const isFoldableForFloor = (b: ViewBlock): boolean =>
			!b.held && !b.protected && !b.grouped && !llmGrouped.has(b.id) && b.foldedTokens < b.tokens && FOLDABLE_KINDS.has(b.kind);
		const floor = hardCapFloor(blocks, cap, projected, currentTokens, laddered, roots, isFoldableForFloor);

		// Apply floor force-folds: new generic digests.
		for (const id of floor.foldIds) {
			foldIds.push(id);
			const b = byId.get(id);
			if (b) emitted.set(id, b.foldedTokens);
		}
		// Apply floor DOWNGRADES: a ladder `replace` the floor deepened to a plain digest. Drop the
		// replace, emit a fold instead — the reversible skeleton/trim gives way to the smaller digest.
		for (const id of floor.downgraded) {
			replaceById.delete(id);
			laddered.delete(id);
			foldIds.push(id);
			const b = byId.get(id);
			if (b) emitted.set(id, b.foldedTokens);
		}
		projected = floor.projected;

		// SINGLE DISPOSITION: any id the floor swept into a group/drop run must NOT also carry a
		// `fold`/`replace` — the run's group command is its sole disposition (a member may have been
		// force-folded in stage 1 or ladder-substituted earlier; grouping reclaims that residue).
		// Strip every regrouped id from both the fold list and the replace map so no id appears in
		// two commands (a "view lies about folds" violation the host would otherwise see as a
		// double-command). Order: groups own the block; fold/replace yield to them.
		const regrouped = new Set(floor.regrouped);
		const finalFoldIds = foldIds.filter((id) => !regrouped.has(id));
		for (const id of regrouped) replaceById.delete(id);

		// ── 6. EMIT ──────────────────────────────────────────────────────────────
		const replaces = [...replaceById.values()];
		const cmds: Command[] = [...replaces];
		if (finalFoldIds.length) cmds.push({ kind: "fold", ids: finalFoldIds });
		for (const g of llmGroups) cmds.push(g);
		for (const g of floor.groups) cmds.push(g);

		// Record emitted-token map for next pass's HOLD projection — but only when NO group/drop
		// fired (groups break byte-stability and re-grouping every pass is not a clean hold). When a
		// group/drop is in the plan — from the floor OR an LLM-summary group — clear the held map so
		// the next pass always re-plans deliberately.
		this.lastEmittedTokens = floor.groups.length === 0 && llmGroups.length === 0 ? emitted : new Map();
		this.lastPlan = cmds;

		this.publishStatus(blocks, finalFoldIds.length, replaces.length, floor.dropped, projected, view, false);
		return cmds;
	}

	/**
	 * Route a block to its fidelity level (§7): code read → Skeleton (L1 / L1.5); long
	 * prose/thinking/non-code result → Trim (L2); Digest (L3). Always returns a result
	 * (digestLevel is the floor for any foldable block).
	 *
	 * L1.5 Bear-2 comment squeeze (Phase 3):
	 *   After a successful L1 skeleton, check whether the skeleton is comment-heavy and
	 *   whether any comment spans have a cached Bear-2 result. If yes → return the
	 *   compressed skeleton (L1.5). Otherwise, fire Bear-2 for the eligible comment spans
	 *   (fire-and-forget; async) and return plain L1. On the next pass (after requestRerun),
	 *   the cache is populated and L1.5 upgrades the replace. PROJECTION HONESTY: until
	 *   compressed text is cached, the block is projected at L1 cost.
	 *
	 * The LLM deep-zone cache check (Phase 2) is NOT done here — it lives in a post-loop
	 * pass in `conduct()` that runs after the full deep zone is known.
	 */
	private route(b: ViewBlock, callById: Map<string, ViewBlock>, count: CountTokens): LevelResult | null {
		// L1: code skeleton (highest fidelity, reversible).
		const sk = trySkeleton(b, callById, count);
		if (sk) {
			// L1.5 Bear-2 comment squeeze — Phase 3.
			// Attempt only when: host has compress capability, Bear-2 not hard-failed,
			// and skeletonMeta is available (always true for L1 results from trySkeleton).
			const meta = sk.skeletonMeta;
			if (
				meta &&
				!this.bear2Failed &&
				this.host?.can("compress") &&
				typeof this.host.compress === "function"
			) {
				// Try to build the L1.5 result from cached compressed spans. Pass the precomputed
				// string-literal-aware mask so a comment marker inside a string can never start a span.
				const b2 = tryBear2(sk, meta.skeletonText, meta.lang, this.bear2Cache, count, meta.headerPrefix, meta.skeletonMask);
				if (b2) return b2; // L1.5 cached result — use it.

				// Not cached yet (or under-commented). Check if this skeleton is comment-heavy
				// enough to be worth launching Bear-2 calls for.
				const spans = detectCommentSpans(meta.skeletonText, meta.lang, meta.skeletonMask);
				const skeletonTokens = count(meta.skeletonText);
				let commentTokens = 0;
				for (const s of spans) {
					if (s.kind === "comment") commentTokens += count(s.text);
				}
				const isCommentHeavy =
					commentTokens >= BEAR2_MIN_COMMENT_TOKENS &&
					skeletonTokens > 0 &&
					commentTokens / skeletonTokens >= BEAR2_MIN_COMMENT_RATIO;

				if (isCommentHeavy) {
					// Launch Bear-2 for uncached comment spans (fire-and-forget).
					this.launchBear2Spans(spans.filter((s) => s.kind === "comment").map((s) => s.text));
				}
			}
			return sk; // plain L1 while inflight or not comment-heavy
		}
		// L2: deterministic trim for long prose/thinking/non-code result.
		const tr = tryTrim(b, count);
		if (tr) return tr;
		// L3: deterministic engine digest. The Phase-2 LLM upgrade collapses these deep-zone folds
		// into recoverable summary groups post-loop in conduct() when a net-win group is cached.
		return digestLevel(b);
	}

	/**
	 * Fire-and-forget: launch Bear-2 compress calls for each uncached, non-in-flight comment
	 * span text. Results are stored in `bear2Cache` (keyed by original span text); on resolve
	 * `host.requestRerun()` is called so the next `conduct()` pass can build L1.5 results.
	 *
	 * ASYNC SAFETY:
	 *   - `bear2InFlight` prevents duplicate launches for the same span text.
	 *   - `BEAR2_CONCURRENCY` caps the number of simultaneous in-flight calls.
	 *   - On resolve: cache the result (or the original text if no saving), call requestRerun.
	 *   - On reject: increment retry counter; if ≥ BEAR2_MAX_RETRIES for ANY span, set
	 *     `bear2Failed` = true so L1.5 is frozen (deterministic core is unaffected).
	 *   - Stale guard: if host has changed (detach/re-attach), `this.host !== capturedHost` →
	 *     do NOT touch any instance state.
	 *   - Bear-2 is deterministic: same span text → same output → cache forever.
	 */
	private launchBear2Spans(spanTexts: string[]): void {
		const capturedHost = this.host;
		if (!capturedHost?.compress) return;

		for (const spanText of spanTexts) {
			if (this.bear2InFlight.size >= BEAR2_CONCURRENCY) break;
			if (this.bear2Cache.has(spanText)) continue; // already cached
			if (this.bear2InFlight.has(spanText)) continue; // already inflight
			if ((this.bear2Retries.get(spanText) ?? 0) >= BEAR2_MAX_RETRIES) continue; // too many failures

			this.bear2InFlight.add(spanText);

			capturedHost.compress(spanText).then(
				(compressed) => {
					// STALE guard: if conductor was detached (or re-attached), host has changed.
					// Do NOT mutate instance state — it belongs to the new session now.
					if (this.host !== capturedHost) return;
					this.bear2InFlight.delete(spanText);

					// Only cache if it genuinely shrinks (Bear-2 may no-op on very short or structured text).
					// Cache the original if no saving so we never re-call for this span.
					const out = (compressed ?? "").trim();
					// Compare token counts using chars/4 (no host access needed — both are prose).
					const origTokens = Math.ceil(spanText.length / 4);
					const compTokens = Math.ceil(out.length / 4);
					if (out.length > 0 && compTokens < origTokens) {
						this.bear2Cache.set(spanText, out);
					} else {
						// No useful compression — cache the original so we never re-call.
						this.bear2Cache.set(spanText, spanText);
					}
					this.bear2Retries.delete(spanText);
					capturedHost.requestRerun();
				},
				(_err) => {
					// STALE guard.
					if (this.host !== capturedHost) return;
					this.bear2InFlight.delete(spanText);
					const next = (this.bear2Retries.get(spanText) ?? 0) + 1;
					this.bear2Retries.set(spanText, next);
					if (next >= BEAR2_MAX_RETRIES) {
						// Hard-fail this span: cache the original text (no savings) so it is never retried.
						// Freeze the entire L1.5 path — too many failures suggests a broken backend.
						this.bear2Cache.set(spanText, spanText);
						this.bear2Failed = true;
					}
					// Ask the host to rerun so the HOLD is broken and the next pass can see updated state.
					capturedHost.requestRerun();
				},
			);
		}
	}

	/**
	 * Fire-and-forget: build a structured deep-zone digest prompt and launch an off-path
	 * `host.complete()` call. `conduct()` returns IMMEDIATELY after calling this; the LLM result
	 * arrives asynchronously via the resolve handler which calls `host.requestRerun()`.
	 *
	 * @param deepBlocks - SNAPSHOT of the deep-zone blocks at launch time (don't use the view later).
	 * @param deepSig    - The sorted-join signature of the deep-zone block ids; used as the cache key
	 *                     and as the stale-guard. If the sig has changed by resolve time (new blocks
	 *                     aged in), the result is stored under the OLD key and will NOT match the new
	 *                     epoch's sig — it is silently ignored on the next pass (no cache hit for the
	 *                     new sig), and the new sig triggers a fresh launch.
	 *
	 * Async safety properties:
	 *   - Only ONE in-flight completion at a time (`llmInflight` guard at call site).
	 *   - `lastAttemptKey` prevents re-launching for the SAME deep-region sig after a reject.
	 *   - A changed sig on the next epoch (new blocks) generates a new key → new launch allowed.
	 *   - `detach()` aborts via the AbortController → post-detach resolve/reject is a no-op
	 *     (the `this.llmInflight !== controller` stale guard catches it).
	 *   - On empty result: treat as reject (preserve prior state, wait for new epoch).
	 *
	 * Prompt shape (Keel deep-zone, not compaction-naive):
	 *   Same structured sections as COMPACTION_SYSTEM but framed as a DIGEST (the agent will see
	 *   this alongside the `{#code FOLDED}` tag and can unfold for the originals). User messages
	 *   preserved verbatim. Fact markers (paths/commands/values/decisions) emphasized so identifiers
	 *   survive the digest. maxOutputTokens: 600 — tight to keep the deep digest small (the whole
	 *   point is to shrink a cold zone; we don't want a 8k summary of 5 ancient blocks). A cold
	 *   deep zone is typically 3–15 blocks of old tool output; 600 tok is generous for a digest but
	 *   keeps the overall context cost proportionate. The host clamps to the model's ceiling if needed.
	 */
	private launchDeepDigest(deepBlocks: ViewBlock[], deepSig: string): void {
		// Defensive: only one in-flight at a time (the call site also guards, but be safe).
		if (this.llmInflight !== null) return;
		if (!this.host) return;

		// Record the attempt key NOW (before the async call). This prevents a second launch if
		// conduct() is called again before the first one resolves (the call site checks `llmInflight`
		// for that case, but the attempt key is the retry-storm guard for reject).
		this.llmLastAttemptKey = deepSig;

		const prompt = buildDeepDigestPrompt(deepBlocks);
		const controller = new AbortController();
		this.llmInflight = controller;

		this.host.complete({
			system: DEEP_DIGEST_SYSTEM,
			prompt,
			maxOutputTokens: MAX_DEEP_DIGEST_TOKENS,
			signal: controller.signal,
		}).then(
			(result) => {
				// Stale-completion guard: if this conductor was detached (or re-attached, creating a
				// new controller), `this.llmInflight` no longer points at OUR controller. Bail without
				// touching any instance state — a stale result must never overwrite the new session.
				if (this.llmInflight !== controller) return;
				this.llmInflight = null;

				const text = result.text.trim();
				if (!text) {
					// Empty output — treat as failure. Preserve prior state; wait for a new epoch
					// with a changed deep-region sig before retrying. `lastAttemptKey` is already set.
					this.host?.setStatus("Keel deep digest: model returned an empty summary", {
						deep_zone_blocks: deepBlocks.length,
					});
					return;
				}

				// Success: stash under the deep-region sig. On the next pass, the post-loop upgrade
				// checks llmCache for the current deep-region sig and upgrades folds to replaces.
				// NOTE: if the deep-region sig changed while we were inflight (new blocks aged in),
				// the old sig is stored here. The new epoch's sig won't match → no cache hit → fresh
				// launch. This is the stale-guard by construction: we store under the OLD sig.
				this.llmCache.set(deepSig, text);

				// CRITICAL: break the epoch HOLD on the next conduct() pass so the cache hit is
				// applied immediately. The HOLD path re-returns lastPlan (plain folds); clearing
				// it forces a full re-plan that discovers the cached LLM digest.
				this.lastPlan = [];

				// Ask the host to re-run conduct() so the cached digest takes effect immediately.
				this.host?.requestRerun();
			},
			(_err) => {
				// Stale-completion guard (see resolve handler above).
				if (this.llmInflight !== controller) return;
				// Rejected (abort, network error, unknown model): clear inflight. `lastAttemptKey`
				// is already set — the SAME deep-region sig will not be retried until the sig changes
				// (new blocks age in). This prevents a tight model-hammering loop on persistent failures.
				this.llmInflight = null;
				// Break the epoch HOLD so the next conduct() sees any new blocks that aged in.
				// Without this, the HOLD re-returns lastPlan and never discovers a changed deep zone.
				this.lastPlan = [];
			},
		);
	}

	/** Update ACT-R recall warmth from the protected tail (continuous, rate-limited). */
	private updateWarmth(blocks: ViewBlock[], T: number): void {
		const tailText = buildTailText(blocks);
		const tailIds = extractIdentifiers(tailText);
		if (tailIds.size === 0) return;
		const cands = blocks.filter((b) => FOLDABLE_KINDS.has(b.kind) && !b.held && !b.protected && !b.grouped);
		let recorded = 0;
		for (const bid of matchBlocks(tailIds, cands).keys()) {
			if (recorded >= MAX_WARMTH_RECORDS_PER_TURN) break;
			if ((this.warmthCoolUntil.get(bid) ?? 0) > T) continue;
			const arr = this.recalls.get(bid);
			if (!arr) this.recalls.set(bid, [T]);
			else if (!arr.includes(T)) arr.push(T);
			this.warmthCoolUntil.set(bid, T + WARMTH_COOLDOWN_TURNS);
			recorded++;
		}
	}

	/** Surface the fidelity ladder + epoch + fact ledger + any drops to the human (display-only). */
	private publishStatus(
		blocks: ViewBlock[],
		folds: number,
		skeletonsAndTrims: number,
		dropped: string[],
		projected: number,
		view: ConductorView,
		held: boolean,
	): void {
		if (!this.host) return;
		const saved = view.liveTokens - projected;
		const cap = effectiveCap(view.budget, view.contextWindow);
		// HONEST INVARIANT (ADR 0017 §10/§16): Keel guarantees projected ≤ cap UNLESS the
		// irreducible floor — roots (every user/spec + held) plus the protected working tail —
		// alone exceeds cap. Those blocks are host-absolute and cannot be folded, so Keel folds
		// everything it IS allowed to and then announces the overage rather than falsely claiming
		// it met budget. `irreducible` is exactly the floor Keel cannot get below.
		const over = projected > cap;
		const irreducible = this.irreducibleFloor(blocks);
		const parts: string[] = [];
		if (held) parts.push("hold");
		if (skeletonsAndTrims) parts.push(`${skeletonsAndTrims} skeleton/trim`);
		if (folds) parts.push(`${folds} fold`);
		if (dropped.length) parts.push(`${dropped.length} DROPPED`);
		const head = parts.length ? parts.join(" + ") : "raw";
		const savedK = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : `${Math.max(0, saved)}`;
		// When the irreducible floor alone is over cap, say so explicitly (the honest conditional);
		// otherwise the generic "still over budget" suffices (rare — the floor should reach ≤ cap).
		const overMsg = over
			? irreducible > cap
				? " · OVER BUDGET: protected tail/roots exceed cap"
				: " · still over budget"
			: "";
		this.host.setStatus(
			`${head} · saved ~${savedK} tok${overMsg}${dropped.length ? " · irreversible drop announced" : ""}`,
			{
				folds,
				substitutions: skeletonsAndTrims,
				dropped: dropped.length,
				tokens_saved: saved,
				live_tokens: projected,
				budget: view.budget,
				cap,
				irreducible_floor: irreducible,
				over_budget: over,
			},
			{
				factLedger: harvestFacts(blocks).map((f) => ({
					category: f.category,
					value: f.value,
					turn: f.turn ?? null,
					sourceId: f.sourceId ?? null,
				})),
			},
		);
	}

	/**
	 * The IRREDUCIBLE FLOOR: the full-token sum of everything Keel can never fold — every user/spec
	 * block, every protected-tail block, and every human/agent-held block. If this alone exceeds the
	 * cap, no fold/group/drop Keel is allowed to make can bring the context to ≤ cap; the honest
	 * guarantee is conditional on this fitting (ADR 0017 §10/§16). Counted as full `tokens` (these
	 * blocks are never substituted). A block counted once even if it satisfies several predicates.
	 */
	private irreducibleFloor(blocks: ViewBlock[]): number {
		let n = 0;
		for (const b of blocks) {
			if (b.kind === "user" || b.protected || b.held) n += b.tokens;
		}
		return n;
	}
}

/**
 * Partition a set of blocks into maximal CONTIGUOUS runs by conversation `order`. The deep-zone
 * candidates are selected by cold-ranking (not contiguity), so they may form several disjoint runs;
 * a `group` command must cover a contiguous run, so we emit one group per run. Input is sorted by
 * `order` first (the caller passes a cold-ranked array); two blocks are contiguous iff their orders
 * are adjacent integers. Deterministic — the ordering is by the engine's stable `order` field.
 */
function contiguousRuns(blocks: ViewBlock[]): ViewBlock[][] {
	const sorted = [...blocks].sort((a, b) => a.order - b.order);
	const runs: ViewBlock[][] = [];
	let run: ViewBlock[] = [];
	for (const b of sorted) {
		if (run.length === 0 || b.order === run[run.length - 1].order + 1) {
			run.push(b);
		} else {
			runs.push(run);
			run = [b];
		}
	}
	if (run.length) runs.push(run);
	return runs;
}


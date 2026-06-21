/*
 * relevance.ts — Keel's fold-candidate RANKING (Phase 1, ADR 0017 §5 step 2).
 *
 * Produces the cold→hot ordered list of fold candidates: the coldest (fold-first) block is at
 * index 0. Three deterministic signals compose, in priority order:
 *
 *   1. ENTITY REACHABILITY (garbage-collector). Build the reference graph (entity / causal /
 *      message edges) and mark everything reachable from the roots. UNREACHABLE blocks are
 *      semantically dead — fold them FIRST. Reachable blocks fold only as a budget fallback.
 *   2. RISK STICKINESS (the-conductor's risk floors, native). A block carrying load-bearing
 *      facts (paths/commands/values/decisions) is stickier — it folds LATER within its
 *      reachability tier. More risk flags ⇒ stickier.
 *   3. ACT-R COLD SCORE (cold-score). Within equal reachability + stickiness, the power-law
 *      forgetting score orders coldest-first; ties broken by conversation order (oldest first)
 *      for byte-stable determinism.
 *
 * Candidates EXCLUDE roots (held at full fidelity) and anything the host won't fold (held /
 * protected / grouped / non-foldable kind / wouldn't shrink). Pure & deterministic — imports
 * the shared garbage-collector + cold-score helpers; no new graph/score logic invented here.
 */
import type { ViewBlock } from "../contract";
import { buildGraph, markReachable } from "../garbage-collector/edges";
import { coldScore, FOLDABLE_KINDS, type ScoreCtx } from "../cold-score/score";
import { riskFlags } from "./ledger";

export interface RankedCandidate {
	block: ViewBlock;
	reachable: boolean;
	riskCount: number;
	cold: number;
}

/**
 * Rank the fold candidates coldest-first (index 0 = fold first).
 *
 *   - `roots` are excluded entirely (full fidelity).
 *   - the host candidate gate (foldable kind, not held/protected/grouped, would shrink) is
 *     applied so every emitted op survives the host floor without a clamp.
 *   - ordering key: unreachable-first, then fewer-risk-flags-first, then coldest ACT-R,
 *     then oldest `order`.
 */
export function rankCandidates(view: ViewBlock[], roots: Set<string>, ctx: ScoreCtx): RankedCandidate[] {
	// Mark reachable from the roots through the reference graph.
	const marked = markReachable(buildGraph(view), roots);

	const candidates = view.filter(
		(b) =>
			!roots.has(b.id) &&
			!b.held &&
			!b.protected &&
			!b.grouped &&
			b.foldedTokens < b.tokens &&
			FOLDABLE_KINDS.has(b.kind),
	);

	const ranked: RankedCandidate[] = candidates.map((block) => ({
		block,
		reachable: marked.has(block.id),
		riskCount: block.text !== undefined ? riskFlags(block.text).length : 0,
		cold: coldScore(block, ctx),
	}));

	ranked.sort((a, b) => {
		// Unreachable first (semantically dead).
		if (a.reachable !== b.reachable) return a.reachable ? 1 : -1;
		// Fewer risk flags first (risk-bearing blocks are stickier).
		if (a.riskCount !== b.riskCount) return a.riskCount - b.riskCount;
		// Coldest ACT-R first.
		if (a.cold !== b.cold) return a.cold - b.cold;
		// Stable tiebreak: oldest conversation order first.
		return a.block.order - b.block.order;
	});

	return ranked;
}

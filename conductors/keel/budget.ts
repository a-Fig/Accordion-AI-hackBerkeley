/*
 * budget.ts — Keel's EPOCH MODEL + HARD-CAP FLOOR (Phase 1, ADR 0017 §10).
 *
 * Two deterministic, model-free mechanisms that together make the budget guarantee hold while
 * keeping the folded prefix cache-warm:
 *
 *   EPOCH HOLD BAND (cold-epoch). cap = min(budget, contextWindow ?? budget). While projected
 *   visible tokens ≤ 0.9·cap, HOLD the current fold set unchanged (byte-stable prefix → warm KV
 *   cache). When projection crosses 0.9·cap, open an epoch and fold down to 0.7·cap in one
 *   deliberate cache-miss, then hold again. ~20% hysteresis ⇒ at most one cache-miss per epoch.
 *
 *   HARD-CAP FLOOR (thermocline). The last resort, run after the reversible ladder if it couldn't
 *   fit. A monotone deterministic loop over THREE stages, each operating on the running digest
 *   RESIDUE of the blocks below it:
 *     1. force-fold the biggest still-reducible block to its engine digest (reversible). A block's
 *        live contribution after this is its `foldedTokens`.
 *     2. if STILL over, force-GROUP the oldest contiguous run of foldable blocks. The run's members
 *        may ALREADY be force-folded (stage 1) or ladder-substituted — grouping reclaims their
 *        residue down to ONE conservative group head. A grouped/dropped block is pulled OUT of the
 *        fold/replace sets (single disposition) by the caller, so no id ever carries two commands.
 *     3. if STILL over, DROP the oldest contiguous run (group digest:null) — the only irreversible
 *        rung, on oldest non-root content, always surfaced via status.
 *   The loop is monotone (each step strictly shrinks projection or removes a candidate) so it
 *   always terminates ≤ cap whenever the foldable content can achieve it. The TRUE guarantee is
 *   conditional: if the irreducible floor (roots + protected tail) alone exceeds cap, the loop
 *   reduces everything it is allowed to and ends as low as possible — but cannot reach ≤ cap. The
 *   caller checks `projected > cap` and announces "over budget" rather than claiming the contrary.
 *
 * Pure & deterministic. Types only from `../contract`. The caller owns the projection bookkeeping
 * and the command list; this module supplies the cap math, the band predicate, and the floor.
 */
import type { ViewBlock, GroupCommand } from "../contract";

/** The hysteresis band as fractions of the effective cap. */
export const EPOCH_BAND = {
	high: 0.9, // cross this (projected) → open an epoch
	low: 0.7, // an epoch folds down to roughly here
};

/** The effective cap: the smaller of the budget and the model's context window. */
export function effectiveCap(budget: number, contextWindow: number | null): number {
	return Math.min(budget, contextWindow ?? budget);
}

/** Outcome of the floor pass: extra commands to append, and whether any DROP (irreversible) fired. */
export interface FloorResult {
	/** Ids to force-fold to the engine digest (append to / create a fold command). */
	foldIds: string[];
	/** Ladder-substituted ids DOWNGRADED to a plain fold (the caller drops their `replace`). */
	downgraded: string[];
	/** Group commands (force-group reversible, or DROP with digest:null) to append. */
	groups: GroupCommand[];
	/** Ids hard-dropped (irreversible) — surfaced via status, never silent. */
	dropped: string[];
	/**
	 * Ids that ended up inside a GROUP or DROP run — the caller MUST remove these from every
	 * `fold`/`replace` command so each block carries EXACTLY ONE disposition on the wire (a block
	 * grouped/dropped here may have been force-folded in stage 1 or ladder-substituted earlier).
	 */
	regrouped: string[];
	/** Projected live tokens after the floor (≤ cap whenever achievable; may exceed cap if the
	 * irreducible floor alone does — the caller announces "over budget" in that case). */
	projected: number;
}

/**
 * A CONSERVATIVE upper bound on the token cost of the surviving group HEAD the store will emit for
 * `run`. The store's real cost is `groupDigestTokens(group, members) = ceil(groupDigest.length/4)
 * + BLOCK_OVERHEAD` (digest.ts), where `groupDigest` names every member kind with a count, the
 * turn span, the total token sum, and a ≤70-char user quote. We over-estimate every component so
 * the result is provably ≥ the store's real head cost (over-counting only makes the floor
 * fold/drop slightly MORE, never less — keeping the loop monotone and the guarantee sound). We do
 * NOT use `min(member.foldedTokens)`, which the store does not honour and which under-counts.
 */
function groupHeadCost(run: ViewBlock[]): number {
	// `{#xxxxxx FOLDED} group · <N> blocks · turns <lo>–<hi> · ~<T> tok` — a fixed skeleton plus
	// the digit-length of the block count and the token sum. Pad generously.
	let totalTok = 0;
	let lo = Infinity;
	let hi = -Infinity;
	let hasUser = false;
	const kinds = new Set<string>();
	for (const b of run) {
		totalTok += b.tokens;
		if (b.turn < lo) lo = b.turn;
		if (b.turn > hi) hi = b.turn;
		kinds.add(b.kind);
		if (b.kind === "user") hasUser = true;
	}
	// Generous fixed header skeleton incl. the {#code FOLDED} tag + " group · N blocks · turns … · ~T tok".
	let chars = 64;
	chars += String(run.length).length; // block count digits
	chars += String(Math.max(0, totalTok)).length; // token-sum digits
	chars += String(Math.max(0, isFinite(hi) ? hi : 0)).length * 2; // turn span digits (lo + hi)
	// Breakdown: at most 5 kinds, each "<count> <noun>, " — bound each clause at 24 chars.
	chars += kinds.size * 24;
	// A user quote ` · "<≤70 chars>"` — bound at 80 chars when a user block is present.
	if (hasUser) chars += 80;
	// chars/4 token estimate + a generous BLOCK_OVERHEAD margin (real BLOCK_OVERHEAD is 4).
	return Math.ceil(chars / 4) + 8;
}

/**
 * Run the monotone hard-cap floor — the budget GUARANTEE (conditional on the irreducible floor
 * fitting). `projected` is the live-token projection after the reversible ladder. `currentTokens`
 * maps every block id to its CURRENT contribution (ladder substitution tokens for a substituted
 * block, full tokens otherwise); `laddered` is the set of ids the ladder substituted via a
 * `replace` (trim/skeleton). The floor may DEEPEN a ladder substitution to the engine digest
 * (downgrade) when budget demands. `excluded` is the hard root set (never touched).
 *
 * Three monotone stages over the running digest residue, each strictly shrinking projection or
 * removing a candidate so the loop always terminates:
 *   1. force-fold/deepen the biggest reducible block to its engine digest (reversible);
 *   2. force-GROUP the oldest contiguous run (default digest — reversible recap), reclaiming the
 *      residue of already-folded members down to one conservative head;
 *   3. DROP the oldest contiguous run (group digest:null — irreversible last resort).
 *
 * A block swept into a group/drop run (stage 2/3) is recorded in `regrouped` so the caller strips
 * it out of any `fold`/`replace` it had — guaranteeing EXACTLY ONE disposition per block.
 */
export function hardCapFloor(
	view: ViewBlock[],
	cap: number,
	projected: number,
	currentTokens: Map<string, number>,
	laddered: Set<string>,
	excluded: Set<string>,
	isFoldable: (b: ViewBlock) => boolean,
): FloorResult {
	const foldIds: string[] = [];
	const downgraded: string[] = [];
	const groups: GroupCommand[] = [];
	const dropped: string[] = [];
	const regrouped: string[] = [];

	// `grouped` = blocks already swept into a group/drop run; no later run may re-take them, and
	// the caller strips them from fold/replace. `forcedFold` = blocks this floor force-folded in
	// stage 1 (their live contribution becomes `foldedTokens`). A force-folded block is STILL
	// eligible to join a later GROUP run — grouping reclaims its digest residue.
	const grouped = new Set<string>();
	const forcedFold = new Set<string>();
	const contribution = (b: ViewBlock): number =>
		forcedFold.has(b.id) ? b.foldedTokens : currentTokens.get(b.id) ?? b.tokens;

	// A block is unavailable to a GROUP run ONLY if it already carries a group/drop this pass.
	// A force-fold or a surviving ladder `replace` does NOT block grouping — its residue is just
	// reclaimed and the caller pulls the now-redundant fold/replace out (single disposition).
	const groupBlocked = (id: string): boolean => grouped.has(id);

	// Stage 1: deepen the biggest reducible block to its engine digest. A block is reducible if its
	// current contribution exceeds its digest — this catches BOTH un-touched full blocks AND
	// ladder-substituted blocks whose trim/skeleton is still bigger than a digest (which it forces
	// down, downgrading the substitution). Reversible. Repeat until ≤ cap or none remain.
	for (;;) {
		if (projected <= cap) break;
		let best: ViewBlock | null = null;
		let bestSaving = 0;
		for (const b of view) {
			if (grouped.has(b.id) || forcedFold.has(b.id) || excluded.has(b.id)) continue;
			if (!isFoldable(b)) continue;
			const saving = contribution(b) - b.foldedTokens;
			if (saving > bestSaving) {
				best = b;
				bestSaving = saving;
			}
		}
		if (!best || bestSaving <= 0) break;
		forcedFold.add(best.id);
		if (laddered.has(best.id)) downgraded.push(best.id);
		else foldIds.push(best.id);
		projected -= bestSaving;
	}

	// Stage 2: still over → force-GROUP the oldest contiguous run of uncommitted foldable blocks
	// (default digest — reversible recap). One run per iteration; monotone because each run
	// collapses ≥ 2 blocks (whose residue still exceeds the conservative head) into one summary
	// head and commits them out of every later run.
	for (;;) {
		if (projected <= cap) break;
		const run = oldestContiguousRun(view, groupBlocked, excluded, isFoldable);
		if (run.length < 2) break;
		let runLive = 0;
		for (const b of run) runLive += contribution(b);
		const headCost = groupHeadCost(run);
		const saving = runLive - headCost;
		// Always mark the run committed so the search advances past it (monotone). A run whose
		// residue can't beat the conservative head saves nothing — block it from future runs but
		// emit NO group, and leave its members' fold/replace untouched (don't claim them regrouped).
		for (const b of run) grouped.add(b.id);
		if (saving <= 0) continue;
		groups.push({ kind: "group", ids: run.map((b) => b.id) });
		for (const b of run) regrouped.push(b.id);
		projected -= saving;
	}

	// Stage 3 (last resort): still over → DROP the oldest contiguous run (group digest:null).
	// Irreversible. Oldest non-excluded foldable content only. Surfaced via status by the caller.
	for (;;) {
		if (projected <= cap) break;
		const run = oldestContiguousRun(view, groupBlocked, excluded, isFoldable);
		if (run.length < 1) break;
		groups.push({ kind: "group", ids: run.map((b) => b.id), digest: null });
		let runLive = 0;
		for (const b of run) {
			runLive += contribution(b);
			dropped.push(b.id);
			grouped.add(b.id);
			regrouped.push(b.id);
		}
		projected -= runLive; // dropped content contributes nothing
		if (runLive <= 0) break; // guard against a zero-saving stall
	}

	return { foldIds, downgraded, groups, dropped, regrouped, projected };
}

/**
 * Find the oldest contiguous run (by conversation order) of foldable, ungrouped, non-excluded
 * blocks. A "run" is a maximal stretch of consecutive eligible blocks; an ineligible block (a
 * root, a non-foldable kind, an already-grouped block) breaks contiguity. Returns the FIRST such
 * run, or [] if none. Note: a force-folded or ladder-substituted block is STILL eligible to join a
 * group run (it is addressable and re-grouping it reclaims its residue); only an already-grouped /
 * dropped block is not.
 */
function oldestContiguousRun(
	view: ViewBlock[],
	blocked: (id: string) => boolean,
	excluded: Set<string>,
	isFoldable: (b: ViewBlock) => boolean,
): ViewBlock[] {
	const eligible = (b: ViewBlock): boolean =>
		!blocked(b.id) && !excluded.has(b.id) && isFoldable(b);

	const run: ViewBlock[] = [];
	for (const b of view) {
		if (eligible(b)) {
			run.push(b);
		} else if (run.length > 0) {
			return run; // first maximal run found
		}
	}
	return run;
}

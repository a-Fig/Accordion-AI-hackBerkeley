/*
 * sliding-window.ts — "summarize the oldest slice when the window fills" conductor.
 *
 * The dead-simple sliding window:
 *  - Trigger: liveTokens > budget * 0.90
 *  - Action: walk the non-protected blocks oldest-first, accumulating token cost until
 *    it reaches ~20% of budget, then emit ONE group over that oldest run. The host
 *    snaps it to whole messages and folds it to a single summary entry.
 *  - State: none. Recomputed from the raw baseline every pass (the host clears prior
 *    conductor state before each call, so `liveTokens` is always the unfolded size).
 *    Once over 90% the oldest ~20%-of-budget stays grouped; once the protected tail
 *    alone fits under threshold it clears back to raw.
 *
 * No ranking, no kind-skipping, no self-bookkeeping — just "summarize the oldest 20%."
 */
import type { Conductor, ConductorView, Command } from "../contract";

/** Fraction of budget that triggers the fold. */
const TRIGGER_RATIO = 0.9;
/** Fraction of budget worth of oldest tokens to group. */
const CHOP_RATIO = 0.2;

export class SlidingWindowConductor implements Conductor {
	readonly id = "sliding-window";
	readonly label = "Sliding window";

	conduct(view: ConductorView): Command[] {
		if (view.budget <= 0 || view.blocks.length === 0) return [];

		// Under the threshold → nothing folded (clear to raw).
		if (view.liveTokens <= view.budget * TRIGGER_RATIO) return [];

		// Only the blocks older than the protected tail are foldable. A group needs ≥2.
		const eligible = view.blocks.slice(0, view.protectedFromIndex);
		if (eligible.length < 2) return [];

		// Walk oldest-first, accumulating token cost until we've covered ~20% of budget.
		const chopTarget = view.budget * CHOP_RATIO;
		let recovered = 0;
		let last = 0;
		for (let i = 0; i < eligible.length; i++) {
			recovered += eligible[i].tokens;
			last = i;
			if (recovered >= chopTarget) break;
		}
		// A group needs ≥2 members; if the very oldest block alone hit the target, still
		// take the first two. The host snaps the [first, last] range outward to whole
		// messages and folds it to one summary.
		if (last < 1) last = 1;

		return [{ kind: "group", ids: [eligible[0].id, eligible[last].id] }];
	}
}

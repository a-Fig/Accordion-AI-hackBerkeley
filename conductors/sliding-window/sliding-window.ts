/*
 * sliding-window.ts — summarize the oldest content to keep the live window under budget.
 *
 * The dead-simple sliding window:
 *  - Trigger: liveTokens > budget * 0.90
 *  - Action: walk the non-protected blocks oldest-first, accumulating token cost until
 *    enough is covered to bring the live window back down to ~70% of budget, then emit
 *    ONE group over that oldest run [eligible[0] .. eligible[last]]. The host snaps it to
 *    whole messages and folds it to a single summary entry.
 *  - Sliding: the group is always anchored at the oldest block and EXTENDS forward as the
 *    conversation grows. Each pass the remove-target (liveTokens − 70% budget) gets bigger,
 *    so `last` advances and more of the old content is summarized — the live window stays
 *    near budget instead of folding once and giving up.
 *  - State: none. Recomputed from the raw baseline every pass (the host clears prior
 *    conductor state before each call, so `liveTokens` is always the unfolded size). Once
 *    the protected tail alone fits under threshold, it clears back to raw.
 *
 * At the 90% trigger point the gap down to 70% is exactly 20% of budget, so the first chop
 * frees ~20%; past that it frees as much as needed to get back to 70%.
 */
import type { Conductor, ConductorView, Command } from "../contract";

/** Fraction of budget that triggers the fold. */
const TRIGGER_RATIO = 0.9;
/** Fraction of budget the live window is trimmed back down to. */
const TARGET_RATIO = 0.7;

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

		// Remove enough of the oldest tokens to bring the live window down to ~70% of
		// budget. (Group-summary residual is ignored — small, and folding slightly less
		// than computed just means the next pass trims a touch more.)
		const removeTarget = view.liveTokens - view.budget * TARGET_RATIO;
		let removed = 0;
		let last = 0;
		for (let i = 0; i < eligible.length; i++) {
			removed += eligible[i].tokens;
			last = i;
			if (removed >= removeTarget) break;
		}
		// A group needs ≥2 members; if the very oldest block alone hit the target, still
		// take the first two. The host snaps [first, last] outward to whole messages.
		if (last < 1) last = 1;

		return [{ kind: "group", ids: [eligible[0].id, eligible[last].id] }];
	}
}

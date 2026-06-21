/*
 * roots.ts — Keel's ROOT SET (Phase 1, ADR 0017 §6).
 *
 * Before any compression Keel marks a permanent root set held at full fidelity regardless of
 * age or score — the F2/F4 antidote. A root block is NEVER a fold candidate. Roots are:
 *
 *   1. Every `user`/spec message (verbatim, permanent). On the benchmark each checkpoint's
 *      spec arrives as a user turn; losing one IS the regression cascade. (user blocks are
 *      non-foldable on the wire anyway — this also keeps Keel from *grouping* them away.)
 *   2. The original task — the FIRST user block (the founding intent; also a GC root).
 *   3. The protected working tail (host-absolute; Keel is collaborative and respects it).
 *   4. Held blocks — any human/agent override that owns a block, FOR AS LONG AS IT STANDS.
 *      `held` covers a human pin/manual-fold/manual-unfold AND an agent self-unfold uniformly;
 *      the public `ViewBlock` carries no provenance, so the two are indistinguishable from the
 *      view — and that is correct. A held-open block is protected while the override is in place;
 *      once the human unpins (or the agent re-folds), the `held` flag clears and the block becomes
 *      a fold candidate again. There is NO permanent keep-live set: a per-pass `held` check is the
 *      only determinism-stable signal (a permanent set would turn a transient pin into a
 *      forever-root and introduce cross-pass drift — the exact bug ADR-0017's review caught).
 *   5. Fact-ledger source spans — blocks dense with load-bearing facts are STICKY (they fold
 *      last) but are NOT hard roots. Making every fact-bearing block inviolable would let a
 *      fact-dense session defeat the budget guarantee; instead, stickiness is applied as a
 *      SOFT signal in `relevance.ts` (more risk flags ⇒ later in the fold order) and the
 *      hard-cap floor may still fold a fact source as a reversible last resort. The hard root
 *      set below is exactly the set the host would clamp anyway — specs, protected, held — so
 *      Keel never *tries* to fold something the wire would refuse.
 *
 * Pure & deterministic. Types only from `../contract`.
 */
import type { ViewBlock } from "../contract";

/**
 * Identify the HARD root set for a view: every block held at full fidelity, excluded from every
 * fold-candidate list AND from the floor. This is exactly the set the host floor protects —
 * specs (user), protected tail, and currently-held — so Keel's candidate list matches the wire's
 * foldability gate (no command is emitted that the host would clamp). Held status is read PER PASS
 * from the live `held` flag, never accumulated, so an unpinned block becomes foldable again the
 * next pass. Fact-source stickiness is a SOFT signal handled in `relevance.ts`, not a hard root.
 */
export function identifyRoots(view: ViewBlock[]): Set<string> {
	const ids = new Set<string>();

	for (const b of view) {
		// 1 + 2: every user/spec message (the first user block is the original task; all user
		// turns are durable verbatim). user blocks are non-foldable on the wire anyway.
		if (b.kind === "user") ids.add(b.id);

		// 3 + 4: protected tail and any CURRENTLY human/agent-held block (pin / manual fold /
		// manual unfold / agent self-unfold — all surface as `held`). Read fresh each pass: the
		// moment the override is removed the block is a candidate again. No permanent state.
		if (b.protected || b.held) ids.add(b.id);
	}

	return ids;
}

# Keel — design plan for Accordion's strongest general-purpose conductor

**Status:** Plan / proposed. Would land as **ADR 0017** when accepted.
**Author:** design pass, 2026-06-21.
**One-line thesis:** *Preserve the load-bearing structure of the agent's own work, reversibly compress everything else, and never destroy anything the agent can't get back.* Keel is the deterministic, structure-first answer to naive compaction.

---

## 0. Honesty notes up front

- **Benchmark specifics are post-cutoff.** SlopCodeBench (researched: arXiv 2603.24755, scbench.ai, SprocketLab) is dated March 2026, past my January 2026 knowledge cutoff. I could not independently verify its exact metric definitions. This plan optimizes for the benchmark's **stated thesis**, which is robust even if the precise scoring numbers differ: *agents degrade over long-horizon iterative coding because they re-ingest their own growing/bloating code and lose the thread of prior specs.* If the real metric weights differ, the design still holds — it targets the failure mechanism, not a leaderboard quirk.
- **Power is decided head-to-head vs naive compaction.** Every design choice below is justified by "does this beat `compaction-naive` on *better, faster, cheaper*?" — not by novelty.
- **Complexity is rationed.** The user asked for *mostly deterministic, robust, basic logic*, with complex ideas only where justified. Section 9 is an explicit **complexity budget**: every non-deterministic / model / GPU layer must earn its place against the deterministic core, and each one is off-by-default or gated.

---

## 1. What we are optimizing (the target)

SlopCodeBench runs an agent through a *sequence of checkpoints*. Each checkpoint hands the agent (a) an updated prose spec and (b) **its own prior code** — nothing else. Pressure is **longitudinal**: the codebase the agent must read-understand-extend grows every checkpoint. Documented failure modes:

| # | Failure mode | What it is | What context management can do |
|---|---|---|---|
| F1 | **Function bloat / erosion** | Agent patches new features into the already-largest function (CC 29 → 285). | Keep the agent's own *structure* (signatures, module map) live and legible so it sees where logic belongs. |
| F2 | **Regression cascade** | Agent loses sight of earlier specs/requirements; early errors compound; strict pass-rate collapses. | Preserve every spec and the original task **verbatim, permanently**. |
| F3 | **Duplication / verbosity** | Agent re-implements boilerplate instead of reusing its own helpers. | Keep exact identifiers + helper signatures discoverable, not summarized into prose. |
| F4 | **Selective amnesia** | Agent ignores its own prior code and re-implements it *wrong*. | Never destroy code; keep it one `unfold`/`recall` away with exact bytes. |
| F5 | **Cost growth (2.9× with zero quality gain)** | Late checkpoints burn tokens re-reading redundant code. | Compress redundant reads; keep the KV-cache prefix warm so cached tokens are cheap. |

**Reading of the target:** the single highest-leverage property a conductor can have on this benchmark is **lossless-by-reference compression of the agent's own code**. Naive compaction does the exact opposite — it shreds the code into lossy prose. That is why this benchmark is almost adversarially designed against `compaction-naive`, and why a structure-preserving reversible conductor should win decisively.

---

## 2. Why naive compaction loses (the foil we must beat)

`compaction-naive` (ADR 0014): at 90% of the visible window it sends the aged region to an LLM, gets back one prose briefing, and collapses the whole region into a single `group(digest: summary)` — **irreversible** (`recoverable: false`, no fold tag, the agent cannot unfold). It re-reads only newly-aged blocks + the prior summary each pass: **recursive amnesia**.

On SlopCodeBench this is a worst-case strategy:

- **F4 amnesia, directly caused.** The agent's prior code becomes prose like "implemented a CLI parser with subcommands." The agent then re-implements it — wrong, duplicated (F3), regressing prior checkpoints (F2).
- **No recovery path.** `recoverable: false` means even a perfectly-aware agent *cannot* pull the exact code back. The information is gone from the wire.
- **Cache-hostile.** Every compaction rewrites the aged prefix into a brand-new summary string → the KV cache for everything after the compaction point is invalidated → slower prefill, more uncached (expensive) input tokens. Worse on *faster* and *cheaper*, not just *better*.
- **Lossy on exactly the wrong content.** Code is the least summarizable content type — every identifier is load-bearing. Prose summarization of code is maximal information loss per token saved.

Keel's entire identity is the negation of these four properties: **reversible, structure-preserving, cache-stable, content-type-aware.**

---

## 3. Design thesis / north star

> Treat the context as a building. The **keel/skeleton** (specs, interfaces, signatures, exact identifiers, decisions) is load-bearing and must never be lost. The **fill** (bodies, verbose prose, stale tool noise, superseded reasoning) is compressible — and every compression must be *reversible by reference* so the agent can drill back to exact bytes on demand.

Three hard rules Keel never breaks:

1. **Never destroy what the agent might need.** Default to `recoverable: true` substitutions and tagged folds. Hard `drop` (`group(digest: null)`) is the *last* rung of the budget ladder, used only on genuinely cold, doubly-gated, oldest content, and **announced** in status — never silent.
2. **Compress by content type, not by age alone.** A code read becomes a skeleton; verbose prose becomes a trim/digest; redundant tool noise gets folded; the spec stays verbatim. Age only orders *within* a type.
3. **Decide rarely, hold stably.** Fold sets change only at deliberate epochs inside a hysteresis band, so the KV-cache prefix stays byte-stable between epochs. Cheaper + faster fall out of this for free.

---

## 4. What Keel steals from each existing conductor

This is the "pick and choose" the user asked for. Each lift is justified.

| Source conductor | What we take | Why |
|---|---|---|
| **builtin** | `FOLD_RANK` kind prior (tool_result → thinking → text → tool_call → user); "filter → sort → greedy walk" skeleton. | Correct kind asymmetry; proven structural backbone. Keel degrades *to* builtin when nothing fancier applies. |
| **code-skeleton** | The whole content-type router: `classify.ts` gating + `skeletonize.ts` mask-based structural skeletonizer + `ReplaceCommand.recoverable`. | This *is* the headline weapon for F1/F3/F4. Deterministic, byte-stable, reversible. |
| **garbage-collector** | Entity-reachability gate: keep any block whose rare identifiers (paths/symbols) are referenced by the working tail; first `user` block as a permanent root. | Deterministic semantic relevance with zero model calls. Directly protects "the file I'm actively editing." |
| **cold-score** | ACT-R power-law cold scoring with kind-specific decay; lexical pre-unfold with rarity guard; warmth/cooldown hysteresis. | Free, tunable, history-aware "how forgotten is this" ranking that improves over a session. |
| **cold-epoch** | Epoch model with 0.9/0.7 high/low water marks; **continuous** warmth accumulation (every turn, not just when over budget); monotone fold set between epochs. | KV-cache warmth — the core *faster/cheaper* lever. |
| **thermocline** | The **budget-invariant hard-cap floor** (force-fold → force-group → drop, monotone, deterministic); double-buffered prepare/commit so LLM latency never blocks; persist the irreversible deep zone across reconnect. | Makes "≤ cap" a *guarantee* (conditional on the irreducible floor fitting — see §10), and makes any LLM use latency-safe. |
| **the-conductor (v1/v2)** | Extractive **Trim** as a first-class level; **risk-category unfold floors** (commands/paths/values/decisions get lower fold thresholds); the **fact ledger** (deterministic harvest of critical facts); TCP-style self-calibrating fold target; `cap/request` host-native summaries. | Risk floors + fact ledger are purpose-built for F2/F3/F4. Trim is the right middle rung. Calibrator adapts aggressiveness to the session. |
| **tiered-relevance** | Dual-anchor relevance (`max(sim(block, goal), sim(block, trajectory))`); graded fidelity ladder; float-up (resurface a block when the trajectory pivots toward it). | *If* we turn on embeddings (optional), this is the right shape. Float-up is anticipatory unfold. |
| **attention-folder** | Agent-self-unfold as a permanent "keep live" signal (`respectLive`); epoch-stable monotone fold sets; the GPU attention probe — **kept as an optional escape hatch, not the default.** | `respectLive` is the cleanest "the agent told us this matters" signal. The probe is high-friction; justified only for very long sessions where lexical overlap fails (§9). |
| **bear2-hybrid** | Recency-graded treatment (different fidelity at different ages) + `host.compress` (Bear-2) as a tool — applied **only to prose spans** (§8), not code. | Realizes the user's "compress twice" idea safely. |
| **sliding-window** | Hysteresis evaluated against the **visible** window, not raw `liveTokens`; collapse a sparse committed set into contiguous group runs. | Correct stateful-trigger math; avoids re-firing every pass. |
| **recency-folder** | (Protocol demo only — nothing strategic.) | — |
| **compaction-naive** | **The foil.** We take its *failure* as the spec for what not to do, plus one good idea: **user/spec messages preserved verbatim.** | Verbatim spec preservation is the F2 antidote. |

---

## 5. Architecture overview

Keel is an **in-process** conductor (`conductors/keel/`), registered in `conductors/index.ts`. In-process because the deterministic core needs no external process, and the two model-backed capabilities it *can* use — `host.complete` (LLM digest) and `host.compress` (Bear-2) — are both available in-process in the desktop app. (A GPU-probe variant would be a WS sibling; deferred — §9.)

Each `conduct(view)` pass runs a synchronous pipeline. Async work (LLM/Bear-2) is fire-and-forget with `requestRerun()`, exactly like thermocline/bear2-hybrid.

```
conduct(view):
  0.  Update bookkeeping        — prune stale ids; update ACT-R warmth from tail (every turn).
  1.  Identify ROOTS            — first user block + every spec/user message (verbatim, permanent);
                                   protected tail; currently-held (per-pass `held`); fact-ledger source blocks.
  2.  Build RELEVANCE           — entity-reachability graph from tail (GC); ACT-R cold score (cold-score);
                                   risk-category floors (the-conductor). [optional: embeddings — §9]
  3.  EPOCH gate                — HOLD stable fold set if projected visible <= 0.9*cap (cache-warm);
                                   else open an epoch and re-plan down to 0.7*cap.
  4.  ROUTE each cold unit by CONTENT TYPE → assign a fidelity LEVEL (§7):
                                   code read → Skeleton; long prose/thinking → Trim → Digest;
                                   redundant tool noise → generic Fold; nothing → leave Full.
  5.  BUDGET LADDER             — deepen coldest-first until projected <= target; then the
                                   thermocline hard-cap floor guarantees we end <= cap.
  6.  EMIT commands             — fold/replace(recoverable)/group; coalesce contiguous runs;
                                   suppress emit if plan signature unchanged (cache-warm hold).
```

---

## 6. Roots — what is *never* compressed (the F2/F4 antidote)

Before any compression, Keel marks a permanent **root set** that is held at full fidelity regardless of age or score:

1. **Every `user` / spec message, verbatim.** On SlopCodeBench each checkpoint's spec arrives as a user turn. Losing a spec *is* the regression cascade (F2). User blocks are non-foldable on the wire anyway; Keel additionally never *groups* them away. (Naive compaction bakes them verbatim into its summary; Keel keeps them as live blocks — strictly better, since they stay individually addressable.)
2. **The original task** (first user block) — permanent root, per GC.
3. **The protected working tail** — host-absolute; Keel respects it (collaborative, §11).
4. **Currently-held blocks** — any block standing open by an override RIGHT NOW (`held`): a human pin/manual-fold/manual-unfold OR an agent self-unfold/recall, treated uniformly. The public `ViewBlock` carries no provenance, so Keel cannot (and must not try to) tell a pin from an agent unfold — and doesn't need to: a held-open block is a root *while the override stands*, and becomes a candidate again the moment it is removed. This is read **per pass** from the live `held` flag; Keel keeps **no permanent keep-live set** (an earlier design accumulated agent-unfolds into a forever-root `respectLive` set, but since a human pin is *also* `held && !folded`, that turned a transient pin into a permanent root and added cross-pass drift — ADR-0017's review caught it, and the per-pass check is the correct, simpler, determinism-stable replacement).
5. **Fact-ledger source spans** — see below.

### The fact ledger (deterministic, zero-latency)

Every pass, Keel harvests high-value tokens across *all* blocks (the-conductor's `buildFactLedger`): exact `key=value` pairs, shell commands, file paths, error strings, and decision markers. This is pure regex/string work — no model. Two uses:

- **Risk floors:** a block containing ledger-category content gets its fold threshold lowered (harder to fold, easier to resurface). A block with a shell command *and* a path is much stickier than generic prose.
- **Survival guarantee:** even if a block is eventually digested or grouped, its ledger facts are preserved in the digest/group header (unioned salience markers), so exact identifiers survive compression. This is the F3/F4 backstop: *the agent can always see the names of things it has, even when the bodies are folded.*

---

## 7. The fidelity ladder (content-type routing)

The core insight Keel takes from `code-skeleton` and generalizes: **route each block to the compressor that fits its content**, then pick the *shallowest* level that meets budget. Levels, cheapest-saving → deepest:

| Level | Name | What it does | Reversible? | Applies to |
|---|---|---|---|---|
| L0 | **Full** | No change. | — | roots, hot blocks, protected tail |
| L1 | **Skeleton** | Mask-based structural skeleton: imports/exports, types, signatures, docstrings; bodies elided. ~1/5 tokens. | **Yes** (`replace`, `recoverable:true` → `{#code FOLDED}` tag). | code-file `tool_result` reads that pass `classify.ts` |
| L1.5 | **Skeleton+** (the user's idea) | Skeleton, then Bear-2 applied **only to the docstring/comment prose spans** of the skeleton. | Yes (recoverable). | docstring-heavy code reads only (§8) |
| L2 | **Trim** | Query-aware extractive excerpt (~25%): head/tail anchored + segments scored by relevance + salience; risk-bearing segments kept unconditionally. | Yes (recoverable). | long prose `text` / `thinking` / non-code `tool_result` |
| L3 | **Digest** | Short summary. Deterministic digest by default (engine's per-kind digest + fact markers); **LLM digest only when justified** (§9), always `recoverable:true` so unfold/recall returns exact bytes. | Yes (recoverable). | cold prose units the trim didn't shrink enough |
| L4 | **Group** | Contiguous run of L3 units collapsed into one summary-on-head group, ledger markers unioned. Default digest, or LLM holistic summary for the deep zone. | Recoverable if tagged; the *deep zone* may be irreversible (announced). | contiguous cold runs |
| L5 | **Drop** | `group(digest: null)` hard delete. | **No** — last resort only. | oldest, doubly-gated-cold, non-root content when the hard-cap floor demands it |

**Routing rule:** a block is assigned the *shallowest* level that (a) matches its content type and (b) is needed to hit the epoch's token target. A code read defaults to L1 (Skeleton) — never L3/L4 prose digest — because skeleton is both higher-fidelity *and* reversible. Prose defaults to L2 (Trim) before L3. The deep, irreversible rungs (L4-LLM, L5) are reached only by the budget ladder under genuine pressure.

This ladder is why Keel beats naive compaction on *better*: naive compaction sends every aged block straight to L4-irreversible-prose; Keel keeps code at reversible L1 and prose at reversible L2/L3, and only the genuinely-ancient tail ever reaches the lossy rungs.

---

## 8. The "compress twice" idea — honest evaluation

The user's idea: for code, compress twice — Bear-2 on comments, and skeleton — maybe in either order.

**Verdict: yes, but narrowly, and order matters.** Here is the candid reasoning.

- The two passes attack **orthogonal redundancy**, which is exactly why they compose:
  - **Skeleton removes *implementation* redundancy** — bodies, duplicated logic. This is the bulk of the savings on SlopCodeBench, because the agent's own bloated code is mostly duplicated bodies (F3), not comments.
  - **Bear-2 removes *prose* redundancy** — verbose docstrings/comments. This is the bulk of the savings on *library/dependency* reads, which are heavily documented.
- **Order: skeleton first, then Bear-2 — not the reverse.** Three reasons:
  1. Skeleton is deterministic and free; it removes the bulk (bodies) so Bear-2 then runs on *far less text* → fewer/cheaper API calls.
  2. Running Bear-2 first wastes calls compressing bodies the skeleton will delete anyway.
  3. Confines Bear-2's risk (below) to the small prose remainder.
- **The hard safety boundary: Bear-2 must NEVER touch code identifiers.** Bear-2 is an *extractive token-deletion* compressor — it drops "low-signal" tokens. On code, every token is load-bearing: dropping a token from `getUserById` or a type name corrupts the contract the agent is relying on, which is catastrophic on a benchmark that scores exact behavior. So L1.5 applies Bear-2 **only to the docstring/comment spans** the skeletonizer already isolates (it keeps docstrings verbatim today; the mask already knows where comments are). Signatures, types, imports, identifiers pass through untouched.
- **Honest cost/benefit:** the marginal gain of L1.5 over L1 is **meaningful only for docstring-heavy files** (well-documented libraries) and **near-zero for the agent's own under-commented code** (the common SlopCodeBench case). So L1.5 is **opt-in, gated on `host.can("compress")`, and only fires when the comment/docstring mass of a skeleton exceeds a threshold** (say ≥ 30% of skeleton tokens and ≥ ~150 tokens of comments). Otherwise Keel stays at L1. This respects the idea without overselling it: it's a real win in a real sub-case, not a universal one.

Net: the user's instinct is sound — it's a genuine two-axis compressor — but the disciplined form is *skeleton (always) → Bear-2 on comment spans only (when comment-heavy)*, never Bear-2 over code.

---

## 9. The complexity budget (when/why each non-trivial layer)

The user was explicit: mostly deterministic, complex only when justified. Here is every layer above plain deterministic logic, with its trigger and its justification. **Everything in this section degrades gracefully to the deterministic core if its dependency is absent.**

| Layer | Deterministic? | Default | Cost | Justified when | If absent |
|---|---|---|---|---|---|
| Skeletonizer (L1) | **Yes** | **On** | ~0 | Always — it's the headline weapon. | n/a (pure) |
| Entity reachability (GC) | **Yes** | **On** | ~0 | Always. | n/a |
| ACT-R cold score | **Yes** | **On** | ~0 | Always. | n/a |
| Fact ledger + risk floors | **Yes** | **On** | ~0 | Always. | n/a |
| Epoch / hysteresis hold | **Yes** | **On** | ~0 | Always — the cache-warmth lever. | n/a |
| Hard-cap budget floor | **Yes** | **On** | ~0 | Always — the invariant. | n/a |
| **Bear-2 comment squeeze (L1.5)** | Yes (deterministic given input) | **Off** unless comment-heavy + key present | 1 API call / eligible block (cached forever) | Docstring-heavy code reads only. | Stay at L1 skeleton. |
| **LLM digest (L3/L4 deep)** | **No** | **Off** until the budget ladder reaches the deep zone | 1 `host.complete` / epoch, off-path | Only the genuinely-ancient region that skeleton+trim couldn't fit, AND only `recoverable:true`. The one place lossy-prose is acceptable — and even here it's reversible by reference. | Deterministic digest / group (engine default). Keel still works, just less eloquent in the deep zone. |
| **Embeddings (dual-anchor relevance)** | No | **Off** | in-process ONNX, CPU, ~0 GPU | Long sessions where lexical/entity overlap misses semantic relatives (e.g. a renamed concept). Only flips a decision when embedding relevance and lexical relevance *disagree*; otherwise it's wasted. | Keyword/entity relevance (already strong for code, where identifiers are literal). |
| **GPU attention probe** | No | **Off (WS sibling, deferred)** | external Python + CUDA, 18-43s/epoch | Very long sessions (tens of thousands of tokens of aged prose) where even embeddings can't rank what the model actually attends to. **Not recommended for the benchmark run** — its latency and dependency friction outweigh its marginal ranking gain over deterministic entity+ACT-R for code, where relevance is mostly *lexical* (you reference a file by its exact name). | Everything above it. |

**The guiding principle:** on *code*, relevance is unusually *lexical and structural* — you reference a function by its exact name, you re-read a file by its exact path. That is why the deterministic entity-reachability + ACT-R + fact-ledger core is genuinely strong here and the heavy semantic machinery (embeddings, attention) is **marginal, not foundational**. I'm being candid: for prose-heavy assistants the probe earns its keep; for SlopCodeBench's code-extension loop it mostly doesn't, and I'd run the benchmark with it **off**.

---

## 10. The epoch model + budget invariant (the *faster/cheaper* engine)

Lifted from cold-epoch + thermocline, because this is where *faster* and *cheaper* are won.

- **Hold band.** While projected visible tokens ≤ `0.9 × cap` (`cap = min(budget, contextWindow)`), Keel returns its **stable** fold set unchanged (suppress-emit if the plan signature is identical). The folded prefix is byte-stable → the provider KV cache stays hot → cached input tokens (≈10× cheaper) + faster prefill. This is the direct antidote to naive compaction's cache-thrashing.
- **Epoch.** When projection crosses 0.9, open one epoch: re-plan the fold set down to `0.7 × cap` in a single deliberate cache-miss, then hold again. ~20% hysteresis band = at most one cache-miss per epoch instead of churn every turn.
- **Double-buffered prepare/commit.** If the epoch needs LLM digests (deep zone) or Bear-2, those fire in the background at a `0.8` warm-water mark *before* the 0.9 trigger, so the commit never blocks on model latency. An EMERGENCY deterministic path (skeleton/trim/drop only, no model) fires instantly if projection ever exceeds 1.0. `conduct()` stays synchronous; results land via `requestRerun()`.
- **Hard-cap floor (the *conditional* guarantee).** The last rung is thermocline's monotone, fully-deterministic loop, run on the **running digest residue** of the blocks below it: force-fold the biggest reducible block to its digest → force-GROUP the oldest contiguous run (reclaiming even already-folded members down to one conservative group head) → DROP the oldest run (irreversible, announced). Each stage assigns **exactly one disposition per block** — an id swept into a group/drop is pulled out of any fold/replace, so the emitted plan never names the same block twice (no "view lies about folds"). The group-head cost is estimated **conservatively** (≥ the store's real `groupDigest` cost) so over-counting only ever folds/drops *more*, keeping the loop monotone and termination sound.

  **The guarantee is conditional, and we state it honestly: Keel ends ≤ cap UNLESS the *irreducible floor* — the roots (every user/spec block + every human/agent-held block) plus the host's protected working tail — alone exceeds cap.** Those blocks are host-absolute: protection is unconditional and `user`/held kinds are never foldable, so no fold/group/drop Keel is allowed to make can bring the context below that floor. When the irreducible floor is over cap, Keel reduces everything it *is* allowed to and then **announces "OVER BUDGET: protected tail/roots exceed cap" via `host.setStatus`** (with `irreducible_floor`/`cap`/`over_budget` metrics) — it never claims it met budget when it did not. This is a real limitation, not a footnote: a session whose *unfoldable* content (long verbatim user specs + a wide protected tail) is itself larger than the window cannot be folded into the window by any reversible compressor, Keel included. Naive compaction "solves" this only by destroying user content (which Keel refuses to do); the honest answer is that the cap is genuinely unreachable and the human/operator must raise the budget, shrink the protected tail, or accept the overage. With or without any model, and whenever the irreducible floor fits, Keel ends ≤ cap.
- **Deep-zone persistence.** Any irreversible deep-zone group is written atomically to `~/.accordion/conductors/keel-state-<sessionKey>.json` and restored on reconnect (thermocline pattern), so a reconnect mid-benchmark doesn't re-pay or re-lose the deep zone.

---

## 11. Locks / mode — collaborative, and why

Keel declares **no locks** (collaborative). Reasoning, candidly:

- The benchmark agent is **unattended** — there is no human to override, so locking `human-steering` buys nothing and only adds a consent gate (ADR 0011).
- **`agent-unfold` must stay open.** The agent recalling its own code is the *entire point* (F4). Locking it would defeat the design. (recall is sacred/unlockable anyway, but unfold should be open too so the agent can make a block *standing-open*.)
- **`tail-size`:** Keel respects the host's protected tail rather than seizing it. The tail floor protects the agent's most recent reasoning, which is exactly what we want; the host-absolute tail is a feature here, not a constraint to lift. (If a future variant wants to compress into recent reasoning it can take the lock, but the default robust form does not.)

So Keel is collaborative and obeys every rule in preview/read-only identically (per the project's "preview is not a more permissive mode" invariant). Nothing in this design relaxes when no one is watching.

---

## 12. Host capabilities used

- `countTokens` — exact skeleton/trim/digest sizing (fallback: `len/4`).
- `digestOf` — engine per-kind digest for deterministic L3.
- `complete` — LLM deep-zone digests (off-path, recoverable, deep zone only).
- `compress` — Bear-2 for L1.5 comment squeeze (gated, comment-heavy only).
- `setStatus` — surface the fidelity ladder, epoch state, fact ledger, and any `drop`s to the human (full `ConductorDiagnostics`: `health`, `unitTrace`, `factLedger`, `relevanceTOC`).
- `requestRerun` — re-plan after async work lands.

Always gated on `can(...)`; every capability has a deterministic fallback, so Keel runs fully in a headless test harness with no keys.

---

## 13. How Keel wins *better / faster / cheaper* vs naive compaction

| Axis | Naive compaction | Keel | Mechanism |
|---|---|---|---|
| **Better** (strict pass, low erosion/verbosity) | Shreds code to lossy prose → amnesia, duplication, regression. | Code stays as reversible skeletons; specs verbatim; exact identifiers in the fact ledger; agent can recall exact bytes. | F1-F4 all directly mitigated; the agent sees its own structure → less bloat, fewer re-implements. |
| **Faster** (wall-clock/checkpoint) | Cache-thrash every compaction; agent wastes turns re-deriving lost info. | Epoch-stable prefix → warm KV cache → fast prefill; reversible recall avoids re-derivation turns. | §10 hold band; reversibility. |
| **Cheaper** (cost/checkpoint) | 2.9× cost growth; uncached prefix; re-reads redundant code. | Warm cache = cheap cached tokens; skeleton cuts code reads ~5×; one LLM call per epoch at most, vs naive's one-per-compaction on a churning window. | §10 + §7. |

The asymmetry is structural, not marginal: the benchmark's failure mechanism *is* code-as-context loss, and Keel's defining property is *not losing code*.

---

## 14. Implementation plan

**Directory:** `conductors/keel/`, registered one line in `conductors/index.ts` (`IN_PROCESS_CONDUCTORS`).

Reuse aggressively — most pieces already exist and are exported:

- `code-skeleton/classify.ts` + `skeletonize.ts` — import directly for L1; extend the skeletonizer to expose comment/docstring spans for L1.5.
- `cold-score/score.ts` (ACT-R) + `lexical.ts` (identifier extraction, rarity guard) — import for ranking and entity edges.
- `garbage-collector/` reachability — import or re-derive the graph (it already uses `cold-score/lexical.ts`).
- `the-conductor/strategy.ts` — lift `buildFactLedger`, `parseRiskFlags`/risk floors, `trimmedText` (L2), `calibrateFoldTarget`, `planSignature`.
- `thermocline/` — lift the budget-ladder floor, double-buffer prepare/commit, and state persistence.
- `compaction-naive`'s `COMPACTION_SYSTEM` prompt shape for the deep-zone LLM digest (but `recoverable: true`).

**Phasing (each phase independently testable, each strictly ≥ builtin at meeting budget):**

1. **Keel-det** — deterministic core only: roots + fact ledger + entity reachability + ACT-R rank + content router (L0/L1/L2 + deterministic L3/L4) + epoch hold + hard-cap floor. **No model, no GPU.** This alone should beat naive compaction on the benchmark; ship and measure here first.
2. **Keel-llm** — add off-path recoverable LLM digest for the deep zone (L3/L4-LLM) via `host.complete`, double-buffered.
3. **Keel-bear2** — add L1.5 comment squeeze via `host.compress`, gated on comment-heavy.
4. **Keel-embed (optional)** — dual-anchor embeddings, only if Phase-1 measurement shows lexical relevance missing real relatives.
5. **Keel-probe (deferred)** — WS sibling with the GPU attention probe. Only if a very-long-session regime demands it.

**Stop after the phase that wins.** I expect Phase 1 (+ maybe 2) to be enough; that's the honest, robust, mostly-deterministic conductor the user asked for. Phases 4-5 are there only if data says so.

---

## 15. Testing & evaluation

- **Golden determinism test.** Phase-1 Keel must be byte-stable: same view + same history → same commands. Pin a golden like `conductor.builtin.test.ts`.
- **End-to-end through `AccordionStore.applyCommands`** — not just a `MockHost` unit test. (Project lesson: MockHost misses host clamps like `not-foldable`/`protected`.) Verify every emitted command survives the host floor without clamps in the common case.
- **Reversibility invariant test.** For every L1/L2/L3 substitution, assert the `{#code FOLDED}` tag is present and `unfold`/`recall` returns the original bytes. Assert L5 `drop` only ever fires on non-root, doubly-cold, oldest content and is logged.
- **Budget invariant test.** Adversarial views (huge single block, all-code, all-prose, tail bigger than budget) must all end ≤ cap via the hard-cap floor.
- **Benchmark harness (the real verdict).** Two agents on a SlopCodeBench subset (Python track), identical model: one with `compaction-naive`, one with Keel. Measure strict/ISO pass rate, structural erosion, verbosity, **and** tokens + wall-clock + cost per checkpoint. Keel wins on the quality axes by construction; the token/cost/time win comes from the epoch cache-warmth and skeleton compression. Report all axes honestly, including any regression.

---

## 16. Risks & open questions (candid)

- **The budget guarantee is CONDITIONAL — say it plainly.** Keel ends ≤ cap **only when the irreducible floor fits**: roots (every user/spec block + every human/agent-held block) plus the host's protected working tail. Those are host-absolute and unfoldable, so if they alone exceed cap, *no reversible compressor can reach the cap*, Keel included. In that case Keel folds/groups/drops everything it is allowed to and **announces the overage via `host.setStatus` ("OVER BUDGET: protected tail/roots exceed cap")** rather than falsely reporting success. The mitigations are operator-level: raise the budget, shrink the protected tail (`protectTokens`), or accept the overage — Keel will not buy the cap by deleting user intent (that is naive compaction's bargain, which Keel exists to avoid). See §10. The Phase-1 tests cover this case (`protected tail > cap` asserts no false ≤cap claim + an over-budget status).
- **Skeleton recovery depends on the agent actually using `unfold`/`recall`.** If the agent never recalls, a skeletonized body is effectively a high-quality lossy digest. That's still strictly better than naive prose, but the full F4 win requires the agent to know it *can* recall — the `{#code FOLDED}` tag + the `accordion-context-folding` skill exist for exactly this. Worth verifying the benchmark agent has the skill exposed.
- **`ViewBlock.text` presence.** Entity edges, fact ledger, and skeletonization all need `text`. In-process views have it; this is an in-process conductor, so fine — but a future wire variant would lose them. Noted.
- **Embedding/probe marginality is an assumption, not a measurement.** I claim deterministic relevance is near-sufficient for code. Phase-1 benchmark data should confirm or refute before investing in Phases 4-5. If it refutes, the embedding layer is already designed (tiered-relevance) and slots in.
- **LLM deep-zone digest is the one irreversible-ish path.** It's `recoverable: true`, but if the original was already dropped at L5 the handle dangles. Rule: never tag-as-recoverable a block whose original the host no longer holds (the contract already warns about this for naive compaction). Keep L4/L5 strictly ordered after all reversible rungs.
- **Benchmark specifics unverified (cutoff).** As flagged in §0 — design targets the mechanism, not exact metric weights.

---

## 17. What I deliberately left out (and why)

- **A custom relevance LLM / fine-tune** — over-engineering; the deterministic core + optional small embeddings cover it.
- **Non-contiguous semantic grouping** — Accordion's `group` requires contiguous runs; the fact ledger + entity edges already preserve the cross-turn relationships that grouping would have captured.
- **Locking anything** — §11; buys nothing on an unattended benchmark, adds friction.
- **Making the GPU probe the default** — §9; high friction, marginal for code, against the "mostly deterministic / robust" mandate.
- **A new wire primitive to inject an agent-facing context header** (the original the_conductor's fact-strip-to-agent) — the command contract has no insert; the fact ledger reaches the human via status, and the agent gets identifiers via the in-place ledger markers in digests. Good enough; a real insert primitive is a separate, larger change.

---

### TL;DR

Keel = **code-skeleton's reversible structural compression** as the headline, wrapped in **garbage-collector + cold-score + fact-ledger** deterministic relevance, held stable by **cold-epoch's cache-warm epochs**, kept ≤ cap by **thermocline's hard-cap floor** (whenever the irreducible roots+tail floor fits — §10/§16), with **the-conductor's risk floors / trim / calibration** for finesse — and **LLM/Bear-2/embeddings/GPU kept as justified, off-by-default escape hatches**. It beats naive compaction because the benchmark's failure mode is *losing the agent's own code*, and Keel's one inviolable rule is *never lose the code*.

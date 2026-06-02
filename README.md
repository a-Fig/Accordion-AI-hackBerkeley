<div align="center">

# 🪗 Accordion

### Your agent's memory shouldn't have to forget to keep going.

**Continuous, reversible, turn-level context compression for AI coding agents.**

*Stop throwing away your context. Start folding it.*

</div>

---

## The problem everyone has but nobody fixes

Every long-running agent hits the same wall: the context window fills up.

Today there are exactly two answers, and both are bad:

1. **Compaction** (`/compact`) — blast your entire history into one lossy summary. It's **slow** (a giant blocking LLM call right when you're in flow), it's **destructive** (the originals are gone — that detail from 40 turns ago you suddenly need? vaporized), and it's **all-or-nothing** (you can't compact *some* of it).
2. **Sliding window** — just drop the oldest tokens. Cheap, and catastrophically dumb. The agent simply forgets.

Both treat context like a buffer to be flushed. We think that's the original sin.

## The insight

> **Context isn't a buffer. It's an accordion.**

You don't *delete* the old part of the conversation. You **fold** it — compress each section into a compact digest that stays in the model's view — and you keep the ability to **unfold any section back to full fidelity, instantly, at any time.**

The breakthrough that makes this practically free: in a modern agent runtime, the message array sent to the model is just a *view*. The full history already lives on disk, immutable. So:

- **Folding** = swap a section for its summary *in the outgoing view only*.
- **Unfolding** = stop swapping. The original was never gone.

That single observation collapses what sounds like a hard "reversible compression" problem into a pure function over an array. No vector DB. No separate memory store. No retrieval pipeline to babysit. **Reversibility costs nothing because nothing was ever destroyed.**

And it unlocks a design freedom no compaction scheme has ever had: because any detail is one unfold away, **summaries can be aggressive.** Lossiness stops being a risk and becomes a lever.

## How it works

Accordion sits between your agent and the model and continuously reshapes the context:

```
┌─────────────────────────────────────────────────────────┐
│  🪗 FOLDED  ·  turns 1–38 compressed into a live digest   │  ← summarized, ~3k tokens
│             ·  any turn one command away from full detail │
├─────────────────────────────────────────────────────────┤
│  ▢ EXPANDED ·  turn 12 (you pinned it open)               │  ← full fidelity, on demand
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ▣ LIVE     ·  turns 39–47, full fidelity                 │  ← the recent working set
│             ·  always uncompressed                        │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

- **A rolling boundary with hysteresis.** The most recent slice of conversation always stays at full fidelity (a configurable band — e.g. keep the live tail under 150k tokens; once it crosses, fold the oldest sections until it's back under 25k). No thrashing, no per-turn churn.
- **Section-level granularity.** Each section folds and unfolds *independently* — that's the accordion. Not one monolithic summary; many addressable pleats.
- **Tool-call safety by construction.** Accordion only ever folds whole turns, so a tool call is never severed from its result. The folded view is byte-for-byte the shape the runtime already trusts — provider-safe, no special-casing.
- **Summaries are computed once and cached forever**, because folded history is immutable. You never pay to summarize the same turn twice.

The result: compaction that is **continuous instead of catastrophic**, **reversible instead of destructive**, and **free of the dreaded mid-task stall.**

## Why this wins

| | Sliding window | `/compact` | RAG / external memory | **🪗 Accordion** |
|---|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ if retrieved | ✅ |
| **Reversible** (restore full detail) | ❌ | ❌ | ❌ | ✅ |
| No mid-task blocking stall | ✅ | ❌ | ✅ | ✅ |
| Per-section, not all-or-nothing | ❌ | ❌ | ⚠️ | ✅ |
| No extra infra (no vector DB) | ✅ | ✅ | ❌ | ✅ |
| Transparent to the model | ✅ | ✅ | ❌ | ✅ |

MemGPT made the agent manage its own paging. Accordion makes paging **invisible** — the model just sees a coherent, well-sized context, and the system quietly handles fidelity behind it.

## Status

Accordion ships today as a working extension for [**pi**](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), the coding agent. The core fold/expand engine is implemented and running; summarization is moving from a deterministic structured digest to LLM-generated summaries with a quality eval harness behind it.

> **Tested in anger across long agent sessions.** The architecture is deliberately runtime-agnostic — the core is a pure transform over a message array, so porting it to other agent frameworks is a matter of adapters, not rewrites.

### Commands

| Command | What it does |
|---|---|
| `/accordion` | Status table — every section, its state (LIVE / folded / EXPANDED) and token weight |
| `/expand <n>` | Unfold a section back to full fidelity |
| `/collapse <n>` | Re-fold it |

## Quickstart

```bash
# Drop the extension into pi's auto-discovery directory
cp src/accordion.ts ~/.pi/agent/extensions/accordion.ts

# Start pi — Accordion loads automatically. Tune the band at the top of the file.
pi
```

Then just... work. When your context gets long, Accordion folds the old sections for you. Need something back? `/expand`.

## Roadmap

- [x] Core fold/expand engine (pure, reversible, tool-pair safe)
- [x] Rolling boundary with hysteresis
- [x] Manual expansion + status UI
- [ ] LLM-generated summaries with caching (in progress)
- [ ] Recall/faithfulness eval harness
- [ ] **Hierarchical folding** — fold the folds; a true multi-level accordion for million-turn sessions
- [ ] **Relevance-driven auto-expansion** — the system unfolds what the current task needs, before you ask
- [ ] Adapters for additional agent runtimes

## Why now

Agents are getting longer-horizon by the month, and context windows — even the big ones — are the binding constraint on how far a single session can go. The industry's answer has been "summarize harder." We think the answer is to **stop deleting in the first place.** Make context elastic, not disposable. Fold, don't forget.

🪗

---

<sub>An experiment in context engineering. Contributions, ideas, and benchmarks welcome.</sub>

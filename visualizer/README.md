# 🪗 Accordion Visualizer (demo)

A standalone window that renders a real agent **context window** and lets you fold,
unfold, pin, and peek it — a working demo of the [VISION](../VISION.md), driven by
saved session transcripts.

It loads a transcript, groups it into **sections** (one per turn), and shows the
whole context as a readable document with a live token-budget bar. You can fold
sections to a summary, pin them open, peek inside without changing anything, and
let the **Conductor** (automatic mode) fold/unfold to keep the live context inside
the window. Folds nest into **groups** ("fold the folds").

> This is a demo: it simulates the accordion over a *saved* session. It does not
> yet hook into a live agent.

## Run it

```bash
node serve.js          # then open http://localhost:8080
```

Serving (rather than double-clicking) lets the page fetch the bundled sample. You
can also just open `index.html` directly — it falls back to a small embedded
sample, and drag-and-drop still works.

## Load your own session

Drag a `.jsonl` transcript onto the window, or use **open file…**. Supported formats:

| Source | Where its sessions live |
|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` |
| **pi** | `~/.pi/agent/sessions/**/*.jsonl` |
| **OMP** (Oh-My-Pi) | `~/.omp/agent/sessions/**/*.jsonl` |

To auto-load a real session on startup, drop a copy at
`samples/local/real-omp.jsonl` or `samples/local/real-claude.jsonl`
(`samples/local/` is git-ignored — real transcripts never get committed).

## Controls

| Control | What it does |
|---|---|
| **▶ Conductor** | Auto-fold/unfold so the live context fits the window |
| **🗂 group folds** | Fold the leading run of folded sections into one group |
| **fold cold** / **expand all** | Fold everything but the recent tail / unfold everything |
| **▶ replay** | Watch the session grow turn-by-turn while the Conductor keeps it in budget |
| **window** slider | Resize the context window — drag it down and watch sections fold |
| **fold / unfold / pin / peek** | Per-section, on each card (peek = read-only, no context change) |

## Privacy

Everything runs locally in your browser. Sessions you load are never uploaded and
never committed — the repo ships only a synthetic sample.

## Files

`index.html` · `styles.css` · `serve.js` · `js/{parse,model,render,app,sample}.js`
— zero dependencies, no build step.

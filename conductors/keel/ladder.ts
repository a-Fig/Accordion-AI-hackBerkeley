/*
 * ladder.ts — Keel's FIDELITY LADDER (Phase 1, ADR 0017 §7).
 *
 * Route a cold block to the compressor that fits its CONTENT TYPE, picking the shallowest
 * level that meets budget. Levels (cheapest-saving → deepest):
 *
 *   L0 Full      — no change (roots / hot / protected).
 *   L1 Skeleton  — code-file read → structural skeleton (imports/types/signatures, bodies
 *                  elided). REVERSIBLE: `replace` with `recoverable:true` → the engine bakes the
 *                  `{#code FOLDED}` tag, agent can unfold/recall the full source. (code-skeleton)
 *   L1.5 Skeleton+ — INERT in Phase 1: `tryBear2()` always returns null (Phase 3 fills it).
 *   L2 Trim      — long prose/thinking/non-code result → deterministic extractive excerpt
 *                  (~25%, head/tail anchored + risk-flag lines kept). REVERSIBLE (recoverable).
 *   L3 Digest    — short summary via the engine digest (fold, no conductor digest). The Phase-2
 *                  LLM deep digest is a REGION-level group built in keel.ts, not a per-unit level.
 *   L4 Group     — contiguous run collapsed into one group (default digest, or a custom LLM summary
 *                  for the deep zone). Host machinery; non-recoverable.
 *   L5 Drop      — group(digest:null) hard delete; last resort, owned by the budget floor.
 *
 * This module is the per-unit ROUTER: given a block + a desired level it returns the Command (or
 * null if the level doesn't apply / wouldn't help). Budget orchestration (which level, how deep)
 * lives in budget.ts + keel.ts. Pure & deterministic. Skeletons are memoized by block id by the
 * caller. Imports the code-skeleton classifier/skeletonizer; the trim is native here.
 */
import type { Command, ViewBlock } from "../contract";
import { classifyCodeRead } from "../code-skeleton/classify";
import { detectLang, skeletonize, maskSource, MASK_OPTS, type Lang } from "../code-skeleton/skeletonize";
import { riskFlags } from "./ledger";

/** Don't skeletonize a read smaller than this (header/tag overhead wouldn't pay off). */
const MIN_SKELETON_TOKENS = 1500;
/** A skeleton must cost ≤ this fraction of the full block to be worth it. */
const MAX_SKELETON_RATIO = 0.6;
/** Rough cost of the `{#code FOLDED}` tag + per-block overhead the host adds on top. */
const TAG_OVERHEAD_TOKENS = 10;

/** Don't trim a block smaller than this. */
const MIN_TRIM_TOKENS = 600;
/** Extractive excerpt target — keep roughly this fraction of the original. */
const TRIM_TARGET_RATIO = 0.25;
/** A trim must cost ≤ this fraction of the full block to be worth it. */
const MAX_TRIM_RATIO = 0.6;

const ELL = "…";

export interface LevelResult {
	command: Command;
	/** Estimated tokens of the substitution (for budget projection). */
	tokens: number;
	/**
	 * Present only for L1 skeleton results. Carries the data needed by L1.5 `tryBear2`:
	 * the raw skeleton body text (without the header line), its structural MASK (string/comment
	 * interiors blanked to spaces, positions preserved 1:1 — the single source of truth for
	 * "is this byte inside a string literal?"), the language, and the header prefix string. The
	 * caller in `keel.ts` uses these to run STRING-LITERAL-AWARE comment-span detection and
	 * reassembly without re-running the skeletonizer.
	 */
	skeletonMeta?: {
		skeletonText: string;
		/** Mask of `skeletonText` (same length; string/comment interiors → spaces). */
		skeletonMask: string;
		lang: Lang;
		headerPrefix: string;
	};
}

/** A token-counting function (host tokenizer or chars/4 fallback). */
export type CountTokens = (text: string) => number;

/**
 * L1 — skeletonize a code-file read. Returns a recoverable `replace`, or null if the block
 * isn't a worthwhile code read (not code, too small, or wouldn't shrink enough).
 */
export function trySkeleton(
	block: ViewBlock,
	callById: Map<string, ViewBlock>,
	count: CountTokens,
): LevelResult | null {
	if (block.kind !== "tool_result") return null;
	if (block.tokens < MIN_SKELETON_TOKENS) return null;
	const info = classifyCodeRead(block, callById);
	if (!info) return null;

	const lang = detectLang(info.path, info.source);
	const sk = skeletonize(info.source, lang);
	if (sk.elidedLines === 0) return null;

	const header = `⟨code skeleton · ${info.path ?? "file"} · ${sk.totalLines}L → ${sk.keptLines}L · ${sk.elidedLines} elided · call unfold for full source⟩`;
	const content = `${header}\n${sk.skeleton}`;
	const tokens = count(content) + TAG_OVERHEAD_TOKENS;
	const saved = block.tokens - tokens;
	if (saved <= 0 || tokens > block.tokens * MAX_SKELETON_RATIO) return null;

	// Mask the EMITTED skeleton text (NOT the original source): comment detection runs over the
	// skeleton bytes the agent will actually see, and the mask blanks every string/comment INTERIOR
	// so a comment marker inside a string literal (`"http://…"`, `"/* x */"`, `"#fff"`) cannot start
	// a span. This is the single source of truth that makes the Bear-2 safety boundary airtight.
	const skeletonMask = maskSource(sk.skeleton, MASK_OPTS[lang]);

	return {
		command: { kind: "replace", id: block.id, content, recoverable: true },
		tokens,
		skeletonMeta: { skeletonText: sk.skeleton, skeletonMask, lang, headerPrefix: header },
	};
}

// ── L1.5 Bear-2 comment squeeze ──────────────────────────────────────────────

/**
 * Minimum fraction of skeleton tokens that must be in comment/docstring spans to justify a
 * Bear-2 call (saves near-zero on under-commented code; only docstring-heavy library reads
 * benefit meaningfully).
 */
export const BEAR2_MIN_COMMENT_RATIO = 0.3;

/**
 * Minimum absolute skeleton-token count of comment/docstring spans. Guards against calling
 * the API for trivially small comment regions (e.g. one "// TODO" line).
 */
export const BEAR2_MIN_COMMENT_TOKENS = 150;

/**
 * Span record: a contiguous region of the skeleton text that is either a comment/docstring
 * (kind "comment") or code (kind "code"). Bear-2 is applied ONLY to comment spans; code
 * spans pass through byte-identical.
 */
export interface SkeletonSpan {
	kind: "comment" | "code";
	text: string; // exact bytes from the skeleton
}

/** True if the elided structural region the skeletonizer inserted starts at `mask`/`text[i]`. */
function isElisionMarkerStart(text: string, mask: string, i: number, lang: Lang): boolean {
	// The skeletonizer inserts tiny STRUCTURAL markers that LOOK like comments but are not prose:
	//   brace langs / css / svelte:  `/* … N lines */`, `/* … */`, `/* … N lines */<closer>`
	//   python:                       `...  # … N lines` (a `#` marker, NOT a docstring)
	// Compressing them is pointless (they carry no information Bear-2 can shrink) and could mangle
	// a structural glyph, so we classify them as CODE. We only need to recognise the comment-marker
	// SHAPES the skeletonizer emits; a real `/* … */` written by a human is vanishingly unlikely to
	// match the exact `… N lines`/`…` body and stays a normal comment if it doesn't.
	if (lang === "python") {
		// `# … N lines` / `# …` (the `...  #` stub). Marker bodies always begin with the ellipsis.
		if (mask[i] === "#") {
			const body = text.slice(i + 1).replace(/^\s+/, "");
			// The caller advances `i` to the `\n` when this returns true; the top-of-loop `i++` then skips past it cleanly.
			return body.startsWith("…");
		}
		return false;
	}
	// C-family / css block-style marker. `/* … */` possibly with `N lines` and a trailing closer.
	if (mask[i] === "/" && mask[i + 1] === "*") {
		const end = text.indexOf("*/", i + 2);
		if (end === -1) return false;
		const inner = text.slice(i + 2, end).trim();
		// `…`, `… 12 lines`, `… 1 line` — the exact shapes ELL_MARK emits.
		return inner === "…" || /^…\s+\d+\s+lines?$/.test(inner);
	}
	return false;
}

/**
 * Detect comment/docstring spans in a skeleton text, per language. Returns an ordered list
 * of spans whose text concatenates exactly to the input skeleton.
 *
 * STRING-LITERAL AWARENESS (the safety boundary). Detection runs over the structural MASK of the
 * skeleton — a same-length copy in which every string-literal and comment INTERIOR is blanked to
 * spaces (positions preserved 1:1). A `//`, `/*`, `#`, or `"""` that lives inside a string literal
 * is therefore NOT present in the mask to start a span, so it can never be misread as a comment.
 * Once a genuine comment START is confirmed on the mask, the span's END is found by the syntactic
 * terminator (newline, the block-comment closer, the matching triple-quote) and the span TEXT is
 * sliced from the ORIGINAL skeleton (byte-exact). If the caller does not supply a precomputed mask,
 * one is built here.
 *
 * SAFETY BOUNDARY: Bear-2 is applied ONLY to spans with kind="comment". Code spans (including any
 * string literal that contains comment-looking bytes) are NEVER sent to Bear-2 — their bytes are
 * forwarded unchanged. The safety test is: join(spans.map(s => s.text)) === skeleton (byte-exact
 * round-trip) AND every comment span is, in the mask, a genuine comment region.
 *
 * Languages and their comment syntaxes:
 *   ts/js/svelte/rust/go/java/c: line comments ("//"), block comments (slash-star ... star-slash), JSDoc
 *   python:                       "#" line, triple-quote strings ("""...""" or '''...''') in DOCSTRING
 *                                 POSITION ONLY (the masked line, left-stripped, must START with the
 *                                 triple-quote). An assignment RHS like `X = """const"""` is a code
 *                                 string, not a docstring → it stays code.
 *   css:                          block comments (slash-star ... star-slash) only
 *   generic/json:                 no comments detected — returns a single code span
 *   svelte: the script block is skeletonized as TS (same // and slash-star rules); template
 *           and style blocks are already collapsed by skeletonize; treat skeleton as TS.
 *
 * Conservative: when in doubt, a region stays "code". Prefer false-negative (miss a comment
 * region → it stays code → Bear-2 skips it → slight under-compression) over false-positive
 * (mark code as comment → Bear-2 might drop a load-bearing token).
 *
 * @param skeleton The skeleton text (bytes the agent sees; spans slice from here).
 * @param lang     The file language (selects comment syntax + mask options).
 * @param mask     Optional precomputed `maskSource(skeleton, MASK_OPTS[lang])`. Built internally
 *                 when omitted, so callers with only (skeleton, lang) still get string-aware
 *                 detection. The mask MUST be the mask of THIS skeleton (same length).
 */
export function detectCommentSpans(skeleton: string, lang: Lang, mask?: string): SkeletonSpan[] {
	// Languages with no parseable comment syntax → single code span.
	if (lang === "json" || lang === "generic") {
		return skeleton.length > 0 ? [{ kind: "code", text: skeleton }] : [];
	}

	const n = skeleton.length;
	// The mask is the single source of truth for "is this byte inside a string?". Build it if the
	// caller didn't supply one (e.g. unit tests passing only skeleton + lang).
	const m = mask && mask.length === n ? mask : maskSource(skeleton, MASK_OPTS[lang]);

	const spans: SkeletonSpan[] = [];
	let i = 0;

	// Track start of the current "code" accumulation so we can flush it as a code span.
	let codeStart = 0;

	const flushCode = (end: number): void => {
		if (end > codeStart) spans.push({ kind: "code", text: skeleton.slice(codeStart, end) });
	};

	// Column where the current (masked) line begins — used for the Python docstring-position rule.
	let lineStart = 0;

	while (i < n) {
		if (skeleton[i] === "\n") {
			lineStart = i + 1;
			i++;
			continue;
		}

		// A structural elision marker inserted by the skeletonizer is code, not prose — skip it so
		// it is never sent to compress (secondary requirement). We still must advance i; treat the
		// marker bytes as ordinary code (they stay in the code accumulation).
		if (isElisionMarkerStart(skeleton, m, i, lang)) {
			// Advance past the marker so its own `#`/`/*` doesn't re-trigger comment detection.
			if (lang === "python") {
				const lineEnd = skeleton.indexOf("\n", i);
				i = lineEnd === -1 ? n : lineEnd; // stop before the newline (handled at loop top)
			} else {
				const end = skeleton.indexOf("*/", i + 2);
				i = end === -1 ? n : end + 2;
			}
			continue;
		}

		if (lang === "python") {
			// Python: triple-quote DOCSTRING (docstring position only) or "#" line comments.
			// A triple-quote starts a docstring ONLY when the masked line, left-stripped, BEGINS
			// with it — i.e. true module/class/def docstring position. An assignment RHS such as
			// `X = """value"""` is a load-bearing string CONSTANT, never a docstring → leave as code.
			if (
				(m[i] === '"' && m[i + 1] === '"' && m[i + 2] === '"') ||
				(m[i] === "'" && m[i + 1] === "'" && m[i + 2] === "'")
			) {
				const lineHead = m.slice(lineStart, i); // masked text before the triple-quote, this line
				const atDocstringPos = lineHead.trim().length === 0;
				if (atDocstringPos) {
					const quote = skeleton.slice(i, i + 3);
					// Find the CLOSING triple-quote on the ORIGINAL (safe: we've confirmed via the mask
					// that we're at a genuine string boundary, so the next matching triple closes it).
					const end = skeleton.indexOf(quote, i + 3);
					if (end === -1) break; // unterminated — treat the rest as code (conservative)
					const commentEnd = end + 3;
					flushCode(i);
					spans.push({ kind: "comment", text: skeleton.slice(i, commentEnd) });
					codeStart = commentEnd;
					i = commentEnd;
					continue;
				}
				// Not docstring position: a code string CONSTANT (e.g. `X = """value"""`). Skip its
				// FULL extent — including a multi-line body — so its closing triple-quote (which, on
				// its own line, would have an empty masked line-head and be misread as a docstring
				// OPEN) is never re-scanned. Update `lineStart` for any newlines spanned.
				const q = skeleton.slice(i, i + 3);
				const close = skeleton.indexOf(q, i + 3);
				const past = close === -1 ? n : close + 3;
				for (let k = i; k < past; k++) if (skeleton[k] === "\n") lineStart = k + 1;
				i = past;
				continue;
			}
			if (m[i] === "#") {
				const lineEnd = skeleton.indexOf("\n", i);
				const commentEnd = lineEnd === -1 ? n : lineEnd + 1;
				flushCode(i);
				spans.push({ kind: "comment", text: skeleton.slice(i, commentEnd) });
				codeStart = commentEnd;
				// commentEnd lands at or after a newline; lineStart is refreshed at the loop top.
				if (lineEnd !== -1) lineStart = commentEnd;
				i = commentEnd;
				continue;
			}
		} else {
			// C-family (ts/js/svelte/rust/go/java/c) and css:
			//   `//`  line comment (not css)
			//   `/* */`  block comment (all)
			// Markers are read from the MASK: a `//` or `/*` inside a string literal is blanked in
			// the mask and so is invisible here — it stays in the code accumulation.
			if (lang !== "css" && m[i] === "/" && m[i + 1] === "/") {
				const lineEnd = skeleton.indexOf("\n", i);
				const commentEnd = lineEnd === -1 ? n : lineEnd + 1;
				flushCode(i);
				spans.push({ kind: "comment", text: skeleton.slice(i, commentEnd) });
				codeStart = commentEnd;
				if (lineEnd !== -1) lineStart = commentEnd;
				i = commentEnd;
				continue;
			}
			if (m[i] === "/" && m[i + 1] === "*") {
				// End on the ORIGINAL: the mask blanks the closing `*/`, so scan the skeleton for it.
				// Safe because the mask already confirmed this `/*` is a genuine comment opener.
				const end = skeleton.indexOf("*/", i + 2);
				if (end === -1) break; // unterminated block comment — conservative: rest stays code
				const commentEnd = end + 2;
				// Consume trailing newline if present (keeps it with the comment span, cleaner).
				const withNewline = commentEnd < n && skeleton[commentEnd] === "\n" ? commentEnd + 1 : commentEnd;
				flushCode(i);
				spans.push({ kind: "comment", text: skeleton.slice(i, withNewline) });
				codeStart = withNewline;
				if (withNewline > commentEnd) lineStart = withNewline;
				i = withNewline;
				continue;
			}
		}

		// Not a comment start — advance one character (stays in the code accumulation).
		i++;
	}

	// Flush any trailing code.
	flushCode(n);
	return spans;
}

/**
 * Given pre-computed skeleton spans and a map of compressed comment texts (keyed by the
 * comment span's original text), reassemble the skeleton with comments replaced by their
 * Bear-2 output. Code spans pass through BYTE-IDENTICAL.
 *
 * If a comment span's text is NOT in the cache (compress hasn't resolved yet), the ORIGINAL
 * comment text is used — projection stays honest: we never claim a saving we haven't realised.
 */
export function reassembleWithCompressedComments(
	spans: SkeletonSpan[],
	compressedBySpanText: ReadonlyMap<string, string>,
): string {
	return spans
		.map((s) => {
			if (s.kind === "code") return s.text; // BYTE-IDENTICAL — never touched
			return compressedBySpanText.get(s.text) ?? s.text; // comment: replaced or original
		})
		.join("");
}

/**
 * L1.5 — Bear-2 comment squeeze on a skeleton.
 *
 * Given:
 *   - `skeletonResult` — the plain L1 skeleton (command + tokens) already computed
 *   - `skeletonText`   — the raw skeleton text (before the header line is prepended)
 *   - `lang`           — the file language (for comment detection)
 *   - `compressedBySpanText` — cache: comment-span-text → Bear-2 compressed text (keyed by
 *     the original comment text, not by block id, so the same comment in different blocks shares
 *     the same compressed form if it was already resolved)
 *   - `count`          — token estimator
 *   - `headerPrefix`   — the header line prepended in trySkeleton (`"⟨code skeleton · …⟩"`)
 *
 * Returns:
 *   - A new LevelResult (level 1.5) with the compressed content and its token cost, if
 *     Bear-2 is worth calling AND at least some compressed text is available.
 *   - `null` if the comment mass is under-threshold, no compressed text is available yet,
 *     or reassembly wouldn't shrink the skeleton (e.g. all comments too short for Bear-2).
 *
 * PROJECTION HONESTY: until compressed text is cached, returns null (L1 is used). Once
 * the compressed text is available and IS shorter, returns a new LevelResult. The caller
 * must already have the L1 result as a fallback.
 *
 * GATING:
 *   - Only fires when the COMMENT mass ≥ BEAR2_MIN_COMMENT_RATIO of skeleton tokens AND
 *     ≥ BEAR2_MIN_COMMENT_TOKENS absolute tokens of comments.
 *   - Only fires if at least one comment span has a cached compressed version that is
 *     SHORTER than the original (saves tokens).
 *
 * The `recoverable:true` flag is set: the store keeps the ORIGINAL full source bytes and the
 * agent can unfold/recall the full source. The skeleton+compressed-comments is a lossy
 * display-only stand-in — lossless by reference.
 */
export function tryBear2(
	skeletonResult: LevelResult,
	skeletonText: string,
	lang: Lang,
	compressedBySpanText: ReadonlyMap<string, string>,
	count: CountTokens,
	headerPrefix: string,
	skeletonMask?: string,
): LevelResult | null {
	// Quick check: do we have enough comment mass to justify a Bear-2 call?
	// We use the skeleton's raw token count (without the header) as the denominator.
	const skeletonTokens = count(skeletonText);
	if (skeletonTokens === 0) return null;

	const spans = detectCommentSpans(skeletonText, lang, skeletonMask);

	// Measure comment mass.
	let commentTokens = 0;
	for (const s of spans) {
		if (s.kind === "comment") commentTokens += count(s.text);
	}

	if (
		commentTokens < BEAR2_MIN_COMMENT_TOKENS ||
		commentTokens / skeletonTokens < BEAR2_MIN_COMMENT_RATIO
	) {
		return null; // under-commented — not worth Bear-2
	}

	// Check whether we have at least one cached compressed result that is shorter.
	let hasAnyCompressed = false;
	let hasSaving = false;
	for (const s of spans) {
		if (s.kind !== "comment") continue;
		const compressed = compressedBySpanText.get(s.text);
		if (compressed !== undefined) {
			hasAnyCompressed = true;
			if (count(compressed) < count(s.text)) hasSaving = true;
		}
	}

	// If no compressed text is available yet, return null (HOLD — projection stays at L1 cost).
	// If we have cached results but none save tokens, also return null (no benefit).
	if (!hasAnyCompressed || !hasSaving) return null;

	// Reassemble: code spans byte-identical; comment spans replaced where cached.
	const compressedBody = reassembleWithCompressedComments(spans, compressedBySpanText);

	// Original command's content was `header + "\n" + skeletonText`.
	// We rebuild with the same header + the compressed body.
	const newContent = `${headerPrefix}\n${compressedBody}`;
	const newTokens = count(newContent) + TAG_OVERHEAD_TOKENS;

	// Guard: only return if the result is actually smaller than plain L1.
	if (newTokens >= skeletonResult.tokens) return null;

	// skeletonResult is always an L1 `replace` (the caller guarantees this), so the `id` field
	// is present. The type union requires us to check kind defensively; in practice this branch
	// is always taken (the only path to this function goes through trySkeleton → replace).
	const blockId = skeletonResult.command.kind === "replace" ? skeletonResult.command.id : "";
	return {
		command: { kind: "replace", id: blockId, content: newContent, recoverable: true },
		tokens: newTokens,
	};
}

/**
 * L2 — deterministic extractive TRIM of a long prose/thinking/non-code result. Keeps the head,
 * the tail, and any line carrying a risk-flag identifier (path/command/value/decision)
 * unconditionally; fills the rest of the ~25% budget with the longest remaining lines. The
 * result is REVERSIBLE (`recoverable:true`) — the agent can unfold to the original bytes.
 *
 * No embeddings, no model, no query: this is the deterministic Phase-1 trim. Returns null if
 * the block is too small or the trim wouldn't shrink it enough.
 */
export function tryTrim(block: ViewBlock, count: CountTokens): LevelResult | null {
	if (block.text === undefined) return null;
	if (block.tokens < MIN_TRIM_TOKENS) return null;

	const content = buildTrim(block.text, block.turn);
	const tokens = count(content) + TAG_OVERHEAD_TOKENS;
	const saved = block.tokens - tokens;
	if (saved <= 0 || tokens > block.tokens * MAX_TRIM_RATIO) return null;

	return { command: { kind: "replace", id: block.id, content, recoverable: true }, tokens };
}

/**
 * Build the deterministic extractive excerpt. Line-based (deterministic, no NLP):
 *   - target ≈ 25% of the original character length (floor 240 chars);
 *   - head 2 lines + tail 2 lines anchored unconditionally (serial-position effect);
 *   - every line containing a risk-flag identifier kept unconditionally;
 *   - remaining budget filled by longest lines (most information per line);
 *   - gaps between kept lines marked with an elision count, preserving order.
 */
function buildTrim(text: string, turn: number): string {
	const lines = text.split("\n");
	const n = lines.length;
	const budgetChars = Math.max(240, Math.floor(text.length * TRIM_TARGET_RATIO));

	if (n <= 4) {
		const clipped = text.length > budgetChars ? text.slice(0, budgetChars - 1).trimEnd() + ELL : text;
		return `⟦trim t${turn}⟧ ${clipped}`;
	}

	const keep = new Set<number>();
	let used = 0;
	const tryAdd = (i: number): void => {
		if (i < 0 || i >= n || keep.has(i)) return;
		const len = lines[i].length + 1;
		if (keep.size > 0 && used + len > budgetChars) return;
		keep.add(i);
		used += len;
	};

	// 1. Risk-bearing lines kept unconditionally (load-bearing identifiers).
	for (let i = 0; i < n; i++) {
		if (lines[i].length > 0 && riskFlags(lines[i]).length > 0) tryAdd(i);
	}
	// 2. Anchor head and tail.
	tryAdd(0);
	tryAdd(1);
	tryAdd(n - 1);
	tryAdd(n - 2);
	// 3. Fill remaining budget by longest line first (stable index tiebreak).
	const byLen = lines
		.map((line, i) => ({ i, len: line.length }))
		.sort((a, b) => b.len - a.len || a.i - b.i);
	for (const { i } of byLen) {
		if (used >= budgetChars) break;
		tryAdd(i);
	}

	const order = [...keep].sort((a, b) => a - b);
	const parts: string[] = [];
	let prev = -1;
	for (const i of order) {
		if (prev >= 0 && i > prev + 1) parts.push(`⟪${ELL} ${i - prev - 1} more ${ELL}⟫`);
		parts.push(lines[i]);
		prev = i;
	}
	if (prev >= 0 && prev < n - 1) parts.push(`⟪${ELL}⟫`);
	const body = parts.join("\n");
	const capped = body.length > budgetChars ? body.slice(0, budgetChars - 3).trimEnd() + "..." : body;
	return `⟦trim t${turn}⟧ ${capped}`;
}

/**
 * L3 — DIGEST. Deterministic: fold the block to the engine's per-kind digest (which already carries
 * the `{#code FOLDED}` recovery tag for foldable kinds). Returns a `fold` with no `digest` so the
 * host applies its own. The Phase-2 LLM deep digest is NOT a per-unit level: a custom LLM summary
 * is carried by a region `group` built in `keel.ts` (net-win-gated), not a per-block replace —
 * applying a ~600-tok summary to a single block already folded to ~40 tok would be a token loss.
 *
 * `foldedTokens` is the host-supplied digest cost for the block — no recompute needed.
 */
export function digestLevel(block: ViewBlock): LevelResult {
	return { command: { kind: "fold", ids: [block.id] }, tokens: block.foldedTokens };
}

/*
 * tokens.ts — crude, uniform token estimation.
 *
 * Bare-bones: ~4 chars per token. Good enough to drive the budget bar and the
 * fold boundary. A real per-model tokenizer is deferred (see VISION roadmap);
 * everything downstream reads from estTokens so swapping it is a one-line change.
 */

const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead (role tags, delimiters). */
export const BLOCK_OVERHEAD = 4;

export function estTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function clip(s: string, n: number): string {
	const m = Math.max(1, n);
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= m ? t : t.slice(0, m - 1).trimEnd() + "…";
}

export function firstLine(s: string, n = 100): string {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}


/**
 * Reduction percentage of a fold: the whole-percent of tokens REMOVED from the
 * wire (saved / full x 100). Pure - no store access; callers supply the full and
 * live token counts. Returns 0 for a zero-token block (divide-by-zero guard ->
 * renders no tag, since nothing was removed). The Map header already reports
 * "saves X tok", so "% removed" reads as the fold's aggressiveness and stays
 * consistent with that existing copy.
 */
export function reductionPct(full: number, live: number): number {
	if (full <= 0) return 0;
	// Clamp to [0, 100]: a conductor substitution can be LARGER than the original
	// block, which would otherwise yield a negative "tokens removed" and render as
	// a stray minus sign on every fold surface. 0 = nothing removed, 100 = fully gone.
	const pct = Math.round(((full - live) / full) * 100);
	return Math.max(0, Math.min(100, pct));
}

/**
 * Reduction as a single decile digit (0-9): drop the ones place, keep the tens
 * digit of reductionPct. Used only for the compact badge stamped directly on a
 * folded tile — a coarser, faster-to-scan signal than the precise "-X%" text
 * shown in tooltips/Transcript/Inspector. Clamped to 9 so a 100% (fully
 * removed) fold doesn't overflow to two digits.
 */
export function reductionDigit(pct: number): number {
	return Math.min(9, Math.max(0, Math.floor(pct / 10)));
}

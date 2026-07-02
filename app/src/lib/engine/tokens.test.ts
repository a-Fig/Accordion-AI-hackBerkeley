import { describe, it, expect } from "vitest";
import { estTokens, BLOCK_OVERHEAD, clip, firstLine, reductionPct, reductionDigit } from "./tokens";

// ---------------------------------------------------------------------------
// reductionPct — fold aggressiveness as whole-percent of tokens removed
// ---------------------------------------------------------------------------

describe("reductionPct", () => {
	it("returns the rounded whole-percent of tokens removed", () => {
		// 1000 full, 250 live -> 750 saved -> 75%
		expect(reductionPct(1000, 250)).toBe(75);
	});

	it("rounds to the nearest whole percent", () => {
		// 1000 full, 333 live -> 667 saved -> 66.7% -> 67%
		expect(reductionPct(1000, 333)).toBe(67);
		// 1000 full, 334 live -> 666 saved -> 66.6% -> 67%
		expect(reductionPct(1000, 334)).toBe(67);
		// 1000 full, 336 live -> 664 saved -> 66.4% -> 66%
		expect(reductionPct(1000, 336)).toBe(66);
	});

	it("returns 100 when everything was removed (drop group / empty digest)", () => {
		expect(reductionPct(500, 0)).toBe(100);
	});

	it("returns 0 when nothing was removed (live == full)", () => {
		expect(reductionPct(500, 500)).toBe(0);
	});

	it("returns 0 for a zero-token block (divide-by-zero guard)", () => {
		expect(reductionPct(0, 0)).toBe(0);
		expect(reductionPct(0, 5)).toBe(0);
	});

	it("clamps to 0 if live exceeds full (oversized substitution)", () => {
		// A conductor replacement larger than the original must never render as a
		// negative "tokens removed" value; clamp to the documented [0, 100] range.
		expect(reductionPct(100, 150)).toBe(0);
		expect(reductionPct(100, 101)).toBe(0);
	});

	it("clamps to 100 (drop group / fully removed)", () => {
		expect(reductionPct(100, 0)).toBe(100);
		expect(reductionPct(100, -5)).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// reductionDigit — decile bucket (0-9) for the compact on-tile badge
// ---------------------------------------------------------------------------

describe("reductionDigit", () => {
	it("drops the ones place and keeps the tens digit", () => {
		expect(reductionDigit(73)).toBe(7);
		expect(reductionDigit(40)).toBe(4);
		expect(reductionDigit(99)).toBe(9);
	});

	it("floors any 1-9% reduction to 0 (still shown, not hidden)", () => {
		expect(reductionDigit(1)).toBe(0);
		expect(reductionDigit(9)).toBe(0);
	});

	it("floors an exact 0% reduction to 0", () => {
		expect(reductionDigit(0)).toBe(0);
	});

	it("clamps a 100% (fully removed) reduction to 9, not 10", () => {
		expect(reductionDigit(100)).toBe(9);
		expect(reductionDigit(90)).toBe(9);
	});
});

// ---------------------------------------------------------------------------
// estTokens — smoke-check the existing exports still work (regression guard)
// ---------------------------------------------------------------------------

describe("estTokens (regression)", () => {
	it("estimates ~4 chars per token with overhead-aware ceil", () => {
		expect(estTokens("")).toBe(0);
		expect(estTokens("abcd")).toBe(1);
		expect(estTokens("abcde")).toBe(2); // ceil(5/4)
	});
	it("exports BLOCK_OVERHEAD", () => {
		expect(BLOCK_OVERHEAD).toBe(4);
	});
});

describe("clip / firstLine (regression)", () => {
	it("clip trims and ellipsizes", () => {
		expect(clip("hello world", 5)).toBe("hell…");
		expect(clip("hi", 5)).toBe("hi");
	});
	it("firstLine returns the first non-blank line, clipped", () => {
		expect(firstLine("\n\n  hello world\nsecond", 5)).toBe("hell…");
	});
});

import { describe, it, expect } from "vitest";
import { estTokens, BLOCK_OVERHEAD, clip, firstLine, remainingPct, remainingDigit } from "./tokens";

// ---------------------------------------------------------------------------
// remainingPct — how much of a fold's original content is still on the wire
// ---------------------------------------------------------------------------

describe("remainingPct", () => {
	it("returns the rounded whole-percent of tokens still live", () => {
		// 1000 full, 250 live -> 25%
		expect(remainingPct(1000, 250)).toBe(25);
	});

	it("rounds to the nearest whole percent", () => {
		// 1000 full, 333 live -> 33.3% -> 33%
		expect(remainingPct(1000, 333)).toBe(33);
		// 1000 full, 334 live -> 33.4% -> 33%
		expect(remainingPct(1000, 334)).toBe(33);
		// 1000 full, 336 live -> 33.6% -> 34%
		expect(remainingPct(1000, 336)).toBe(34);
	});

	it("returns 0 when everything was removed (drop group / empty digest)", () => {
		expect(remainingPct(500, 0)).toBe(0);
	});

	it("returns 100 when nothing was removed (live == full)", () => {
		expect(remainingPct(500, 500)).toBe(100);
	});

	it("returns 100 for a zero-token block (divide-by-zero guard)", () => {
		expect(remainingPct(0, 0)).toBe(100);
		expect(remainingPct(0, 5)).toBe(100);
	});

	it("clamps to 100 if live exceeds full (oversized substitution)", () => {
		// A conductor replacement larger than the original must never render as a
		// >100% remaining value; clamp to the documented [0, 100] range.
		expect(remainingPct(100, 150)).toBe(100);
		expect(remainingPct(100, 101)).toBe(100);
	});

	it("clamps to 0 (drop group / fully removed)", () => {
		expect(remainingPct(100, 0)).toBe(0);
		expect(remainingPct(100, -5)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// remainingDigit — decile bucket (0-9) for the compact on-tile badge
// ---------------------------------------------------------------------------

describe("remainingDigit", () => {
	it("drops the ones place and keeps the tens digit", () => {
		expect(remainingDigit(73)).toBe(7);
		expect(remainingDigit(40)).toBe(4);
		expect(remainingDigit(99)).toBe(9);
	});

	it("floors any 1-9% remaining to 0 (still shown — almost nothing left)", () => {
		expect(remainingDigit(1)).toBe(0);
		expect(remainingDigit(9)).toBe(0);
	});

	it("floors an exact 0% remaining to 0", () => {
		expect(remainingDigit(0)).toBe(0);
	});

	it("clamps a 100% (fully intact) value to 9, not 10", () => {
		expect(remainingDigit(100)).toBe(9);
		expect(remainingDigit(90)).toBe(9);
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

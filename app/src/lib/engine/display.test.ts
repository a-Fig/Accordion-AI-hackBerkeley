import { describe, it, expect } from "vitest";
import { buildDisplay, segmentDisplay } from "./display";
import type { Block, Group } from "./types";

function blk(id: string): Block {
	return { id, kind: "text", turn: 1, order: 0, text: "x", tokens: 100, override: null, autoFolded: false, by: null };
}
const ids = (rows: ReturnType<typeof buildDisplay>) =>
	rows.map((r) => (r.type === "block" ? `b:${r.block.id}` : `${r.type}:${r.group.id}(${r.members.length})`));

describe("buildDisplay", () => {
	const blocks = ["a", "b", "c", "d", "e"].map(blk);

	it("maps blocks 1:1 when there are no groups", () => {
		expect(ids(buildDisplay(blocks, []))).toEqual(["b:a", "b:b", "b:c", "b:d", "b:e"]);
	});

	it("a folded group becomes ONE row at its first member and hides the rest of the range", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		expect(ids(buildDisplay(blocks, [g]))).toEqual(["b:a", "group:g:b(3)", "b:e"]);
	});

	it("an unfolded group becomes a groupOpen row carrying its members (rendered inline)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: false };
		expect(ids(buildDisplay(blocks, [g]))).toEqual(["b:a", "groupOpen:g:b(3)", "b:e"]);
	});

	it("preserves order across two groups", () => {
		const g1: Group = { id: "g:a", memberIds: ["a", "b"], folded: true };
		const g2: Group = { id: "g:d", memberIds: ["d", "e"], folded: false };
		expect(ids(buildDisplay(blocks, [g1, g2]))).toEqual(["group:g:a(2)", "b:c", "groupOpen:g:d(2)"]);
	});

	// ---- three-state peek model (the redesign) ----------------------------------
	it("a folded group NOT in `peeked` stays COLLAPSED (one tile)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		const rows = buildDisplay(blocks, [g], new Set());
		expect(ids(rows)).toEqual(["b:a", "group:g:b(3)", "b:e"]);
		expect(rows[1].type).toBe("group");
	});

	it("PEEK: a folded group IN `peeked` emits groupOpen with live=false (dull preview)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		const rows = buildDisplay(blocks, [g], new Set(["g:b"]));
		expect(ids(rows)).toEqual(["b:a", "groupOpen:g:b(3)", "b:e"]);
		const open = rows[1];
		expect(open.type).toBe("groupOpen");
		if (open.type === "groupOpen") expect(open.live).toBe(false);
	});

	it("UNFOLDED: an unfolded group emits groupOpen with live=true (members live)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: false };
		const rows = buildDisplay(blocks, [g], new Set());
		const open = rows[1];
		expect(open.type).toBe("groupOpen");
		if (open.type === "groupOpen") expect(open.live).toBe(true);
	});

	it("precedence: folded=false ALWAYS wins → live=true even if the id is also peeked", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: false };
		// Peeked AND unfolded: unfold wins (you can't preview a group that's already live).
		const rows = buildDisplay(blocks, [g], new Set(["g:b"]));
		const open = rows[1];
		expect(open.type).toBe("groupOpen");
		if (open.type === "groupOpen") expect(open.live).toBe(true);
	});

	it("peek defaults to empty when omitted (back-compat with existing callers)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		expect(buildDisplay(blocks, [g])[1].type).toBe("group");
	});

	it("drops a group whose first member is absent (invariant already broken) rather than emitting strays", () => {
		// 'b' missing from the slice: the group's first member 'a' is present, so it still
		// renders with the members it can resolve. But if the FIRST member is gone, nothing emits.
		const g: Group = { id: "g:x", memberIds: ["x", "c"], folded: true };
		expect(ids(buildDisplay(blocks, [g]))).toEqual(["b:a", "b:b", "b:c", "b:d", "b:e"]);
	});
});

// ---- segmentDisplay: open groups break the grid into stacked segments -----------
describe("segmentDisplay", () => {
	const blocks = ["a", "b", "c", "d", "e"].map(blk);
	const kinds = (segs: ReturnType<typeof segmentDisplay>) => segs.map((s) => s.kind);

	it("no groups → a single tiles segment holding every block", () => {
		const segs = segmentDisplay(buildDisplay(blocks, []));
		expect(kinds(segs)).toEqual(["tiles"]);
		expect(segs[0].kind === "tiles" && segs[0].rows.length).toBe(5);
	});

	it("a COLLAPSED group stays INSIDE the tile grid (one square, no band)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		const segs = segmentDisplay(buildDisplay(blocks, [g]));
		expect(kinds(segs)).toEqual(["tiles"]); // a:tile, group:tile, e:tile — all one grid
	});

	it("an OPEN group splits the run into grid · band · grid", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: false };
		const segs = segmentDisplay(buildDisplay(blocks, [g]));
		expect(kinds(segs)).toEqual(["tiles", "band", "tiles"]);
		expect(segs[1].kind === "band" && segs[1].row.group.id).toBe("g:b");
	});

	it("a PEEKED group also splits into a band (it renders open)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		const segs = segmentDisplay(buildDisplay(blocks, [g], new Set(["g:b"])));
		expect(kinds(segs)).toEqual(["tiles", "band", "tiles"]);
	});

	it("an open group at the very start emits no leading empty tiles segment", () => {
		const g: Group = { id: "g:a", memberIds: ["a", "b"], folded: false };
		const segs = segmentDisplay(buildDisplay(blocks, [g]));
		expect(kinds(segs)).toEqual(["band", "tiles"]); // no empty tiles before the band
	});

	it("two open groups produce alternating bands with no empty segments between adjacent ones", () => {
		const g1: Group = { id: "g:a", memberIds: ["a", "b"], folded: false };
		const g2: Group = { id: "g:c", memberIds: ["c", "d"], folded: false };
		// rows: open(a,b), open(c,d), block(e) → band, band, tiles (no empty tiles between bands)
		const segs = segmentDisplay(buildDisplay(blocks, [g1, g2]));
		expect(kinds(segs)).toEqual(["band", "band", "tiles"]);
	});
});

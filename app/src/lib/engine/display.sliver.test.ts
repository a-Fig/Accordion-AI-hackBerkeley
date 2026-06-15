/**
 * display.sliver.test.ts — unit tests for buildLane (sliver mode lane grouping).
 *
 * Tests the pure grouping logic: live tiles, folded clusters, group items, and
 * cluster boundary rules (a group or live block breaks a folded run).
 */

import { describe, it, expect } from "vitest";
import { buildLane, type LaneItem } from "./display";
import type { Block, Group } from "./types";
import type { DisplayRow } from "./display";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeBlock(kind: Block["kind"] = "text", tokens = 100): Block {
	return {
		id: `b${++_idCounter}`,
		kind,
		turn: _idCounter,
		order: _idCounter,
		text: "test",
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeGroup(memberIds: string[]): Group {
	return {
		id: `g${++_idCounter}`,
		memberIds,
		folded: true,
		by: "auto",
	};
}

function blockRow(block: Block): DisplayRow {
	return { type: "block", block };
}

function groupRow(group: Group, members: Block[]): DisplayRow {
	return { type: "group", group, members };
}

// Predicate: always live (not folded)
const neverFolded = (_b: Block) => false;
// Predicate: always folded
const alwaysFolded = (_b: Block) => true;
// Predicate: folded by id set
const foldedSet =
	(ids: Set<string>) =>
	(b: Block) =>
		ids.has(b.id);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLane", () => {
	it("all-live → all tiles", () => {
		const b1 = makeBlock();
		const b2 = makeBlock();
		const b3 = makeBlock();
		const rows: DisplayRow[] = [blockRow(b1), blockRow(b2), blockRow(b3)];

		const items = buildLane(rows, neverFolded);

		expect(items).toHaveLength(3);
		expect(items[0]).toEqual({ kind: "tile", block: b1 });
		expect(items[1]).toEqual({ kind: "tile", block: b2 });
		expect(items[2]).toEqual({ kind: "tile", block: b3 });
	});

	it("one folded → one cluster of 1", () => {
		const b1 = makeBlock();
		const rows: DisplayRow[] = [blockRow(b1)];

		const items = buildLane(rows, alwaysFolded);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("cluster");
		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toHaveLength(1);
			expect(items[0].blocks[0]).toBe(b1);
		}
	});

	it("a run of 4 folded → one cluster of 4", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock(), makeBlock()];
		const rows: DisplayRow[] = blocks.map(blockRow);

		const items = buildLane(rows, alwaysFolded);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("cluster");
		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toHaveLength(4);
			expect(items[0].blocks).toEqual(blocks);
		}
	});

	it("two non-adjacent folded runs → two clusters split by a tile", () => {
		const b1 = makeBlock(); // folded
		const b2 = makeBlock(); // folded
		const b3 = makeBlock(); // live
		const b4 = makeBlock(); // folded
		const b5 = makeBlock(); // folded
		const rows: DisplayRow[] = [b1, b2, b3, b4, b5].map(blockRow);
		const folded = foldedSet(new Set([b1.id, b2.id, b4.id, b5.id]));

		const items = buildLane(rows, folded);

		expect(items).toHaveLength(3);
		expect(items[0].kind).toBe("cluster");
		expect(items[1].kind).toBe("tile");
		expect(items[2].kind).toBe("cluster");

		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toHaveLength(2);
			expect(items[0].blocks[0]).toBe(b1);
			expect(items[0].blocks[1]).toBe(b2);
		}
		if (items[1].kind === "tile") {
			expect(items[1].block).toBe(b3);
		}
		if (items[2].kind === "cluster") {
			expect(items[2].blocks).toHaveLength(2);
			expect(items[2].blocks[0]).toBe(b4);
			expect(items[2].blocks[1]).toBe(b5);
		}
	});

	it("a group row between folded blocks breaks the run into two clusters", () => {
		const b1 = makeBlock(); // folded
		const b2 = makeBlock(); // group member
		const b3 = makeBlock(); // folded
		const g = makeGroup([b2.id]);
		const rows: DisplayRow[] = [
			blockRow(b1),
			groupRow(g, [b2]),
			blockRow(b3),
		];
		const folded = foldedSet(new Set([b1.id, b3.id]));

		const items = buildLane(rows, folded);

		expect(items).toHaveLength(3);
		expect(items[0].kind).toBe("cluster");
		expect(items[1].kind).toBe("group");
		expect(items[2].kind).toBe("cluster");

		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toHaveLength(1);
			expect(items[0].blocks[0]).toBe(b1);
		}
		if (items[1].kind === "group") {
			expect(items[1].group).toBe(g);
			expect(items[1].members).toHaveLength(1);
			expect(items[1].members[0]).toBe(b2);
		}
		if (items[2].kind === "cluster") {
			expect(items[2].blocks).toHaveLength(1);
			expect(items[2].blocks[0]).toBe(b3);
		}
	});

	it("all folded → one cluster", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock()];
		const rows: DisplayRow[] = blocks.map(blockRow);

		const items = buildLane(rows, alwaysFolded);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("cluster");
		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toEqual(blocks);
		}
	});

	it("folded run then a tile then folded run", () => {
		const b1 = makeBlock(); // folded
		const b2 = makeBlock(); // folded
		const b3 = makeBlock(); // live
		const b4 = makeBlock(); // folded
		const rows: DisplayRow[] = [b1, b2, b3, b4].map(blockRow);
		const folded = foldedSet(new Set([b1.id, b2.id, b4.id]));

		const items = buildLane(rows, folded);

		expect(items).toHaveLength(3);
		expect(items[0].kind).toBe("cluster");
		expect(items[1].kind).toBe("tile");
		expect(items[2].kind).toBe("cluster");

		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toHaveLength(2);
			expect(items[0].blocks[0]).toBe(b1);
			expect(items[0].blocks[1]).toBe(b2);
		}
		if (items[2].kind === "cluster") {
			expect(items[2].blocks).toHaveLength(1);
			expect(items[2].blocks[0]).toBe(b4);
		}
	});

	it("cluster membership order is preserved (conversation order)", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock(), makeBlock(), makeBlock()];
		const rows: DisplayRow[] = blocks.map(blockRow);

		const items = buildLane(rows, alwaysFolded);

		expect(items).toHaveLength(1);
		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toEqual(blocks);
		}
	});

	it("empty rows → empty items", () => {
		const items = buildLane([], neverFolded);
		expect(items).toHaveLength(0);
	});

	// ---- edge cases added per adversarial review ----

	it("(a) leading group row then folded run → group item then cluster", () => {
		const bMember = makeBlock();
		const g = makeGroup([bMember.id]);
		const b2 = makeBlock();
		const b3 = makeBlock();
		const rows: DisplayRow[] = [
			groupRow(g, [bMember]),
			blockRow(b2),
			blockRow(b3),
		];
		const folded = foldedSet(new Set([b2.id, b3.id]));

		const items = buildLane(rows, folded);

		expect(items).toHaveLength(2);
		expect(items[0].kind).toBe("group");
		expect(items[1].kind).toBe("cluster");
		if (items[0].kind === "group") {
			expect(items[0].group).toBe(g);
			expect(items[0].members).toHaveLength(1);
			expect(items[0].members[0]).toBe(bMember);
		}
		if (items[1].kind === "cluster") {
			expect(items[1].blocks).toHaveLength(2);
			expect(items[1].blocks[0]).toBe(b2);
			expect(items[1].blocks[1]).toBe(b3);
		}
	});

	it("(b) two adjacent group rows → two group items, no cluster", () => {
		const bm1 = makeBlock();
		const bm2 = makeBlock();
		const g1 = makeGroup([bm1.id]);
		const g2 = makeGroup([bm2.id]);
		const rows: DisplayRow[] = [
			groupRow(g1, [bm1]),
			groupRow(g2, [bm2]),
		];

		const items = buildLane(rows, neverFolded);

		expect(items).toHaveLength(2);
		expect(items[0].kind).toBe("group");
		expect(items[1].kind).toBe("group");
		if (items[0].kind === "group") expect(items[0].group).toBe(g1);
		if (items[1].kind === "group") expect(items[1].group).toBe(g2);
	});

	it("(c) [group, folded, folded, group] → group, cluster(2), group", () => {
		const bm1 = makeBlock();
		const bm2 = makeBlock();
		const g1 = makeGroup([bm1.id]);
		const g2 = makeGroup([bm2.id]);
		const bf1 = makeBlock();
		const bf2 = makeBlock();
		const rows: DisplayRow[] = [
			groupRow(g1, [bm1]),
			blockRow(bf1),
			blockRow(bf2),
			groupRow(g2, [bm2]),
		];
		const folded = foldedSet(new Set([bf1.id, bf2.id]));

		const items = buildLane(rows, folded);

		expect(items).toHaveLength(3);
		expect(items[0].kind).toBe("group");
		expect(items[1].kind).toBe("cluster");
		expect(items[2].kind).toBe("group");
		if (items[1].kind === "cluster") {
			expect(items[1].blocks).toHaveLength(2);
			expect(items[1].blocks[0]).toBe(bf1);
			expect(items[1].blocks[1]).toBe(bf2);
		}
	});

	it("(d) folded run, group, folded run → cluster, group, cluster", () => {
		const bf1 = makeBlock();
		const bf2 = makeBlock();
		const bm = makeBlock();
		const g = makeGroup([bm.id]);
		const bf3 = makeBlock();
		const rows: DisplayRow[] = [
			blockRow(bf1),
			blockRow(bf2),
			groupRow(g, [bm]),
			blockRow(bf3),
		];
		const folded = foldedSet(new Set([bf1.id, bf2.id, bf3.id]));

		const items = buildLane(rows, folded);

		expect(items).toHaveLength(3);
		expect(items[0].kind).toBe("cluster");
		expect(items[1].kind).toBe("group");
		expect(items[2].kind).toBe("cluster");
		if (items[0].kind === "cluster") {
			expect(items[0].blocks).toHaveLength(2);
			expect(items[0].blocks[0]).toBe(bf1);
			expect(items[0].blocks[1]).toBe(bf2);
		}
		if (items[1].kind === "group") {
			expect(items[1].group).toBe(g);
		}
		if (items[2].kind === "cluster") {
			expect(items[2].blocks).toHaveLength(1);
			expect(items[2].blocks[0]).toBe(bf3);
		}
	});
});

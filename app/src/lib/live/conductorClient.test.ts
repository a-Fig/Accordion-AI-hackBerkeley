import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RemoteRunner } from "./conductorClient.svelte";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, ParsedSession } from "../engine/types";
import type { ConductorEntry } from "./registry";
import { estTokens } from "../engine/tokens";

/*
 * Round-trip the RemoteRunner against a fake WebSocket — the integration proof that an
 * out-of-process conductor can drive the store over the wire: receive context, send
 * commands, get clamp feedback, and answer capability requests. No real socket; we drive
 * the message pump by hand (the pattern extension/smoke.mjs uses against a real WS).
 */

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 3;
	static last: FakeWebSocket | null = null;

	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];

	constructor(public url: string) {
		FakeWebSocket.last = this;
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
	// --- test drivers ---
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	emit(obj: unknown): void {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
	/** All parsed frames the host sent, in order. */
	frames(): any[] {
		return this.sent.map((s) => JSON.parse(s));
	}
	framesOfType(t: string): any[] {
		return this.frames().filter((f) => f.type === t);
	}
}

function blk(i: number, kind: Block["kind"] = "text", tokens = 1000): Block {
	return {
		id: `m${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(n: number): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "live", cwd: "/tmp", model: "m" },
		blocks: Array.from({ length: n }, (_, i) => blk(i)),
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

const ENTRY: ConductorEntry = {
	registryProtocol: 1,
	conductorProtocol: 1,
	id: "remote-test",
	label: "Remote Test",
	url: "ws://127.0.0.1:9999",
	pid: 0,
	startedAt: 0,
	heartbeatAt: 0,
};

let savedWS: unknown;
beforeEach(() => {
	savedWS = (globalThis as any).WebSocket;
	(globalThis as any).WebSocket = FakeWebSocket;
	FakeWebSocket.last = null;
});
afterEach(() => {
	(globalThis as any).WebSocket = savedWS;
});

function connectRunner(store: AccordionStore): { runner: RemoteRunner; ws: FakeWebSocket } {
	const runner = new RemoteRunner(ENTRY, store);
	store.attach(runner);
	runner.connect();
	const ws = FakeWebSocket.last!;
	ws.open(); // → host/hello + initial context/update
	return { runner, ws };
}

describe("RemoteRunner — handshake & context push", () => {
	it("sends host/hello then a context/update on open", () => {
		const { ws } = connectRunner(makeStore(3));
		const hello = ws.framesOfType("host/hello");
		expect(hello).toHaveLength(1);
		expect(hello[0].conductorProtocol).toBe(1);

		const updates = ws.framesOfType("context/update");
		expect(updates.length).toBeGreaterThanOrEqual(1);
		const u = updates[updates.length - 1];
		expect(u.blocks).toHaveLength(3);
		expect(u.blocks[0].text).toBeDefined(); // wants defaults to "full"
	});
});

describe("RemoteRunner — commands drive the store", () => {
	it("applies a fold and reports no clamp for a valid command", () => {
		const store = makeStore(3);
		const { ws } = connectRunner(store);
		ws.emit({ type: "conductor/commands", rev: 1, commands: [{ kind: "fold", ids: ["m0:p0"] }] });

		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);
		expect(store.get("m0:p0")!.by).toBe("conductor");

		const results = ws.framesOfType("host/commandResult");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[results.length - 1].reports).toEqual([]);
	});

	it("replaces content and round-trips a clamp report for an unknown id", () => {
		const store = makeStore(3);
		const { ws } = connectRunner(store);
		ws.emit({
			type: "conductor/commands",
			rev: 2,
			commands: [
				{ kind: "replace", id: "m1:p0", content: "summarized" },
				{ kind: "fold", ids: ["ghost:p0"] },
			],
		});

		expect(store.digestOf(store.get("m1:p0")!)).toBe("summarized");
		const result = ws.framesOfType("host/commandResult").pop();
		expect(result.reports.some((r: any) => r.reason === "unknown-id")).toBe(true);
	});

	it("holds the last command set when the conductor goes silent", () => {
		const store = makeStore(3);
		const { ws } = connectRunner(store);
		ws.emit({ type: "conductor/commands", commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);

		// New context arrives, conductor says nothing → fold held, new block raw.
		store.appendBlocks([blk(9)]);
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);
		expect(store.isFolded(store.get("m9:p0")!)).toBe(false);
	});
});

describe("RemoteRunner — capabilities", () => {
	it("answers countTokens from the host tokenizer", () => {
		const { ws } = connectRunner(makeStore(2));
		ws.emit({ type: "cap/request", reqId: "c1", capability: "countTokens", text: "hello world" });
		const res = ws.framesOfType("cap/result").pop();
		expect(res.reqId).toBe("c1");
		expect(res.ok).toBe(true);
		expect(res.value).toBe(estTokens("hello world"));
	});

	it("answers getContent and errors on an unknown block", () => {
		const store = makeStore(2);
		const { ws } = connectRunner(store);
		ws.emit({ type: "cap/request", reqId: "c2", capability: "getContent", ids: ["m0:p0"] });
		ws.emit({ type: "cap/request", reqId: "c3", capability: "getContent", ids: ["nope"] });
		const [ok, bad] = ws.framesOfType("cap/result").slice(-2);
		expect(ok.value).toBe(store.get("m0:p0")!.text);
		expect(bad.ok).toBe(false);
		expect(bad.error).toContain("nope");
	});
});

describe("RemoteRunner — host events", () => {
	it("forwards an agent-unfold notification", () => {
		const { runner, ws } = connectRunner(makeStore(2));
		runner.notifyEvent("agentUnfold", ["abc123"], "agent unfolded 1 block(s)");
		const ev = ws.framesOfType("host/event").pop();
		expect(ev.event).toBe("agentUnfold");
		expect(ev.ids).toEqual(["abc123"]);
	});
});

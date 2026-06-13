/*
 * conductorClient.svelte.ts — Accordion's side of the conductor wire (ADR 0007).
 *
 * Turns an out-of-process conductor (a WebSocket endpoint) into something the engine can
 * `attach()`: a `RemoteRunner` that implements the in-process `Conductor` interface. The
 * trick is bridging async ↔ sync. The store calls `conduct()` synchronously on every
 * context change and must never block on a model call; the remote answers whenever it
 * likes. So:
 *
 *   - `conduct(snapshot)` PUSHES the snapshot to the remote (fire-and-forget) and returns
 *     the conductor's LAST known desired commands (or `null` = hold) — it never waits.
 *   - When the remote later sends `conductor/commands`, the runner caches them and pokes
 *     the store (`refold()`), which re-enters `conduct()`, reads the fresh cache, and the
 *     host applies it. ClampReports flow back as `host/commandResult`.
 *
 * "GUI drives, conductor is thin" in reverse: here the conductor drives, and this client
 * is the thin adapter that keeps the engine's safety floor (it never bypasses
 * `applyCommands`, which clamps every command to provider-validity).
 */
import type { AccordionStore } from "../engine/store.svelte";
import type { Conductor, ContextSnapshot, Command } from "../engine/conductor";
import { BuiltinConductor } from "../engine/conductor.builtin";
import { digest } from "../engine/digest";
import { estTokens, firstLine } from "../engine/tokens";
import type { ConductorEntry } from "./registry";
import {
	CONDUCTOR_PROTOCOL_VERSION,
	isHostMessage, // (re-exported for symmetry/tests; host parses conductor msgs)
	type BlockView,
	type ContentMode,
	type ConductorMessage,
	type HostHelloMessage,
	type ContextUpdateMessage,
} from "./conductorProtocol";

void isHostMessage; // referenced to keep the import meaningful for downstream consumers

/** The well-known id of the in-process default conductor. */
export const BUILTIN_ID = "builtin";
/** The well-known id meaning "no conductor" — raw, un-managed context. */
export const NONE_ID = "none";

/** Connection status of the active remote conductor, surfaced to the UI. */
export const conductorLink = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string }>({
	status: "idle",
	detail: "",
});

/**
 * A conductor that lives in another process, reached over a WebSocket. Implements
 * `Conductor` so the engine can attach it like any other strategy; all the async lives
 * here, behind a synchronous `conduct()`.
 */
export class RemoteRunner implements Conductor {
	readonly id: string;
	readonly label: string;

	private ws: WebSocket | null = null;
	private manualClose = false;
	/** The conductor's last desired command set; `null` until it has ever spoken (⇒ hold/raw). */
	private desired: Command[] | null = null;
	private wants: ContentMode = "full";
	private rev = 0;
	private lastRev = 0;
	/** Set when WE triggered the refold (applying just-received commands) so we don't echo a redundant context/update. */
	private suppressUpdate = false;
	/** True once `conductor/hello` has arrived — we hold the first context push until then so
	 * a `wants:"shape"/"onDemand"` conductor never receives one full-text frame it didn't ask for. */
	private greeted = false;

	constructor(
		private entry: ConductorEntry,
		private store: AccordionStore,
	) {
		this.id = entry.id;
		this.label = entry.label;
	}

	// ---- Conductor interface ----------------------------------------------
	conduct(snap: ContextSnapshot): Command[] | null {
		if (this.suppressUpdate) this.suppressUpdate = false;
		else if (this.greeted) this.pushContext(snap); // hold the first push until wants is known
		return this.desired;
	}

	// ---- lifecycle --------------------------------------------------------
	connect(): void {
		if (typeof WebSocket === "undefined") return;
		this.manualClose = false;
		conductorLink.status = "connecting";
		conductorLink.detail = this.entry.url;
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.entry.url);
		} catch (e) {
			conductorLink.status = "error";
			conductorLink.detail = e instanceof Error ? e.message : String(e);
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			if (this.ws !== ws) return;
			const hello: HostHelloMessage = {
				type: "host/hello",
				conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
				session: { title: this.store.meta.title, model: this.store.meta.model, cwd: this.store.meta.cwd },
				budget: this.store.budget,
				contextWindow: this.store.contextWindow,
			};
			this.send(hello);
			conductorLink.status = "connected";
			conductorLink.detail = this.entry.label;
			// Do NOT push context yet — wait for conductor/hello to learn `wants`, then push.
		};
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return;
			let msg: unknown;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				return;
			}
			this.handle(msg);
		};
		ws.onerror = () => {
			if (this.ws !== ws) return;
			conductorLink.status = "error";
			conductorLink.detail = `cannot reach ${this.entry.url}`;
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			if (!this.manualClose && conductorLink.status !== "error") {
				conductorLink.status = "idle";
				conductorLink.detail = "disconnected";
			}
		};
	}

	close(): void {
		this.manualClose = true;
		const ws = this.ws;
		this.ws = null;
		conductorLink.status = "idle";
		conductorLink.detail = "";
		try {
			ws?.close();
		} catch {
			/* already gone */
		}
	}

	// ---- inbound ----------------------------------------------------------
	private handle(msg: unknown): void {
		if (!msg || typeof msg !== "object") return;
		const m = msg as ConductorMessage;
		switch (m.type) {
			case "conductor/hello":
				if (m.conductorProtocol !== CONDUCTOR_PROTOCOL_VERSION) {
					conductorLink.status = "error";
					conductorLink.detail = `protocol mismatch — conductor v${m.conductorProtocol}, app v${CONDUCTOR_PROTOCOL_VERSION}`;
					this.close();
					return;
				}
				if (m.wants?.content) this.wants = m.wants.content;
				this.greeted = true;
				this.store.refold(); // first context push, now honouring the declared `wants`
				break;
			case "conductor/commands": {
				this.desired = Array.isArray(m.commands) ? m.commands : [];
				this.lastRev = m.rev ?? this.rev;
				// Apply now. We poke the store, which re-enters conduct(); suppress the
				// redundant context/update that re-entry would otherwise emit.
				this.suppressUpdate = true;
				this.store.refold();
				// Report back exactly what the host had to clamp.
				this.send({ type: "host/commandResult", rev: this.lastRev, reports: this.store.lastReports });
				break;
			}
			case "cap/request":
				this.serveCapability(m);
				break;
		}
	}

	/** Answer a capability request from the conductor (the host owns the engine + tokenizer). */
	private serveCapability(m: Extract<ConductorMessage, { type: "cap/request" }>): void {
		const id = m.ids?.[0];
		const b = id ? this.store.get(id) : undefined;
		let value: string | number | undefined;
		let ok = true;
		let error: string | undefined;
		switch (m.capability) {
			case "countTokens":
				value = estTokens(m.text ?? "");
				break;
			case "getContent":
				if (b) value = b.text;
				else ((ok = false), (error = `no block ${id}`));
				break;
			case "summarize": {
				// A group head (id `g:…`) summarizes to the group recap; a plain block to its digest.
				const g = id ? this.store.groupById(id) : undefined;
				if (g) value = this.store.groupSummary(g);
				else if (b) value = digest(b);
				else ((ok = false), (error = `no block ${id}`));
				break;
			}
			case "getDigest":
				if (b) value = digest(b);
				else ((ok = false), (error = `no block ${id}`));
				break;
			default:
				ok = false;
				error = `unknown capability ${m.capability}`;
		}
		this.send({ type: "cap/result", reqId: m.reqId, ok, value, error });
	}

	// ---- outbound ---------------------------------------------------------
	/** Tell the conductor about a host-side event it didn't initiate (agent unfold / human override). */
	notifyEvent(event: "agentUnfold" | "humanOverride", ids: string[], detail?: string): void {
		this.send({ type: "host/event", event, ids, detail });
	}

	private pushContext(snap: ContextSnapshot): void {
		const update: ContextUpdateMessage = {
			type: "context/update",
			rev: ++this.rev,
			budget: snap.budget,
			contextWindow: snap.contextWindow,
			protectedFromIndex: snap.protectedFromIndex,
			blocks: snap.blocks.map((b, i) => this.toView(b, i, snap)),
		};
		this.send(update);
	}

	private toView(b: ContextSnapshot["blocks"][number], i: number, snap: ContextSnapshot): BlockView {
		const folded = b.override === "folded" || snap.isInFoldedGroup(b.id);
		const view: BlockView = {
			id: b.id,
			kind: b.kind,
			turn: b.turn,
			order: b.order,
			tokens: b.tokens,
			toolName: b.toolName,
			callId: b.callId,
			isError: b.isError,
			folded,
			protected: i >= snap.protectedFromIndex,
		};
		if (this.wants === "full") view.text = b.text;
		else view.preview = firstLine(b.text, 100);
		return view;
	}

	private send(msg: object): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* socket gone — a later context/update will retry */
		}
	}
}

// ─── the attach manager ────────────────────────────────────────────────────────
// One remote runner at a time is attached to the active session's store. The manager
// builds the right Conductor for the selected id and swaps it in, tearing down any prior
// remote connection so a switch never leaves two sockets open.

let activeRemote: RemoteRunner | null = null;
// What we last attached, so a re-invocation that asks for the SAME thing is a no-op (a
// discovery poll refreshing the list must never tear down and reconnect a healthy remote).
let lastStore: AccordionStore | null = null;
let lastId: string | null = null;

/** The remote runner currently attached, if any (so callers can route host events to it). */
export function activeRemoteRunner(): RemoteRunner | null {
	return activeRemote;
}

/**
 * Attach the conductor identified by `id` to `store`. `null`/`"none"` ⇒ detach (raw);
 * `"builtin"` ⇒ the in-process default folder; anything else ⇒ a remote runner dialed at
 * the matching discovered/configured `ConductorEntry` (falling back to the built-in if the
 * entry isn't available *yet*, so the view is never stranded). Safe to call from an effect
 * that tracks the available list: it is IDEMPOTENT — if we are already correctly attached to
 * `id` on `store` it returns untouched (no reconnect on list churn / heartbeat refresh), and
 * a vanished-but-still-connected remote is left alone; only a genuine change swaps.
 */
export function attachConductor(store: AccordionStore, id: string | null, available: ConductorEntry[]): void {
	const norm = id ?? NONE_ID;
	const isRemoteId = norm !== BUILTIN_ID && norm !== NONE_ID;
	// Already correctly attached? For a remote that means the live runner's id matches; for
	// builtin/none, just the id+store. (A remote id that fell back to built-in last time has
	// activeRemote === null, so this is false → we retry now that it may have appeared.)
	const alreadyCorrect =
		store === lastStore && norm === lastId && (isRemoteId ? activeRemote?.id === norm : true);
	if (alreadyCorrect) return;

	if (activeRemote) {
		activeRemote.close();
		activeRemote = null;
	}
	store.onHumanOverride = null;
	lastStore = store;
	lastId = norm;

	if (norm === NONE_ID) {
		store.detach();
		return;
	}
	if (norm === BUILTIN_ID) {
		store.attach(new BuiltinConductor());
		return;
	}
	const entry = available.find((e) => e.id === norm);
	if (!entry) {
		store.attach(new BuiltinConductor()); // selected remote not available yet — fall back
		return;
	}
	const runner = new RemoteRunner(entry, store);
	activeRemote = runner;
	// Tell the remote when the human overrides by hand (ADR 0007 host/event: humanOverride).
	store.onHumanOverride = (ids, action) => runner.notifyEvent("humanOverride", ids, action);
	store.attach(runner); // conduct() returns null until commands arrive ⇒ raw meanwhile
	runner.connect();
}

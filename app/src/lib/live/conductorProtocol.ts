/*
 * conductorProtocol.ts — the Accordion ↔ Conductor WIRE (ADR 0007).
 *
 * The in-process contract is `engine/conductor.ts` (`conduct(snapshot) → Command[]`).
 * This file is its cross-process form: the JSON messages a conductor running as its own
 * process — in any language — exchanges with Accordion over a WebSocket.
 *
 * Topology: the CONDUCTOR hosts the WebSocket endpoint and Accordion connects to it as a
 * CLIENT. (The app is a webview; it cannot host a server. It is already a client to the
 * pi extension — this mirrors that.) A local conductor advertises its `ws://` URL in
 * `~/.accordion/conductors/<id>.json` (see `registry.ts`); a remote one is a URL the user
 * configures. Either way Accordion dials out.
 *
 * The command vocabulary (`Command`) and clamp reports (`ClampReport`) are imported from
 * the engine contract so the wire and the in-process apply path share ONE definition —
 * there is no separate wire representation of a fold to drift out of sync.
 *
 * Keep this dependency-free and runtime-pure (type-only imports, erased at build): a
 * stranger writing a conductor copies these shapes; they should not have to vendor the
 * whole engine. See `docs/conductor-protocol.md` for a copy-paste reference conductor.
 */
import type { Command, ClampReport } from "../engine/conductor";
import type { BlockKind } from "../engine/types";

/** Bumped on any breaking change to the messages below. Independent of the pi wire's PROTOCOL_VERSION. */
export const CONDUCTOR_PROTOCOL_VERSION = 1;

/**
 * How much of each block's content a conductor wants to receive (declared in
 * `conductor/hello`). Trust is full once connected, so this is a bandwidth/own-preference
 * choice, NOT a security boundary:
 *  - "full"     — every block's complete text (the default; most conductors want this).
 *  - "shape"    — structure only: kind, tokens, a one-line preview. No full text.
 *  - "onDemand" — structure only, and fetch full text per block via the `getContent` capability.
 */
export type ContentMode = "full" | "shape" | "onDemand";

/**
 * One block as the conductor sees it. A serializable projection of an engine `Block`:
 * never carries fold-control state the conductor owns (it decides that), but DOES report
 * the block's current `folded`/`protected` status so the conductor can reason about where
 * things stand. `text` is present only under `wants:"full"`; otherwise `preview` (a short
 * first-line taste) stands in and full text is fetched on demand.
 */
export interface BlockView {
	id: string;
	kind: BlockKind;
	turn: number;
	order: number;
	/** Full token cost of the block at full fidelity. */
	tokens: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	/** Currently folded in the host view (by a prior command or a human). */
	folded: boolean;
	/** Inside the host's protected working tail (host policy; folding here may be healed). */
	protected: boolean;
	/** Full content — present only when the conductor asked for `wants:"full"`. */
	text?: string;
	/** One-line taste — present under `wants:"shape"`/`"onDemand"` in place of `text`. */
	preview?: string;
}

// ─── host → conductor ────────────────────────────────────────────────────────

/** First frame Accordion sends after connecting: who it is and what session it's steering. */
export interface HostHelloMessage {
	type: "host/hello";
	conductorProtocol: number;
	session: { title: string; model: string; cwd: string };
	budget: number;
	contextWindow: number | null;
}

/**
 * The context changed (a block streamed in, the budget or protect tail moved). Carries the
 * full block list each time — the conductor's complete field of view — plus a monotonic
 * `rev` it should echo in its reply so the host can spot a reply to a stale snapshot.
 */
export interface ContextUpdateMessage {
	type: "context/update";
	rev: number;
	budget: number;
	contextWindow: number | null;
	/** First protected-tail index (host policy the conductor may honour or ignore). */
	protectedFromIndex: number;
	blocks: BlockView[];
}

/** What the host clamped from the conductor's last batch (provider-validity floor). */
export interface CommandResultMessage {
	type: "host/commandResult";
	rev: number;
	reports: ClampReport[];
}

/** Answer to a `cap/request`. `ok:false` carries an `error` string instead of `value`. */
export interface CapResultMessage {
	type: "cap/result";
	reqId: string;
	ok: boolean;
	value?: string | number;
	error?: string;
}

/**
 * Something happened that the conductor should know about but did not initiate:
 *  - "agentUnfold"   — the live agent called `unfold` and pulled blocks back to full;
 *  - "humanOverride" — the human pinned/folded/unfolded by hand (their choice always wins).
 */
export interface HostEventMessage {
	type: "host/event";
	event: "agentUnfold" | "humanOverride";
	ids: string[];
	detail?: string;
}

export type HostMessage =
	| HostHelloMessage
	| ContextUpdateMessage
	| CommandResultMessage
	| CapResultMessage
	| HostEventMessage;

// ─── conductor → host ────────────────────────────────────────────────────────

/** The conductor's opening frame: identity + what content it wants. */
export interface ConductorHelloMessage {
	type: "conductor/hello";
	conductorProtocol: number;
	id: string;
	label: string;
	wants?: { content: ContentMode };
}

/**
 * The conductor's complete desired state, as imperative commands. The host resets to the
 * raw baseline and applies this batch, so each message is a full intention (not a diff).
 * `rev` (if set) is the `context/update` it is responding to.
 */
export interface ConductorCommandsMessage {
	type: "conductor/commands";
	rev?: number;
	commands: Command[];
}

/**
 * Ask the host to do something only it can (it owns the engine + tokenizer). The host
 * answers with a `cap/result` carrying the same `reqId`.
 *  - "summarize"   — engine digest for `ids` (a single block, or a group head).
 *  - "countTokens" — token estimate for `text`.
 *  - "getContent"  — full text of block `ids[0]` (for `wants:"onDemand"`).
 *  - "getDigest"   — the engine's per-kind folded digest for block `ids[0]` (incl. the {#code FOLDED} tag).
 */
export interface CapRequestMessage {
	type: "cap/request";
	reqId: string;
	capability: "summarize" | "countTokens" | "getContent" | "getDigest";
	ids?: string[];
	text?: string;
}

export type ConductorMessage =
	| ConductorHelloMessage
	| ConductorCommandsMessage
	| CapRequestMessage;

// ─── guards ───────────────────────────────────────────────────────────────────

export function isConductorMessage(m: unknown): m is ConductorMessage {
	if (!m || typeof m !== "object") return false;
	const t = (m as { type?: unknown }).type;
	return t === "conductor/hello" || t === "conductor/commands" || t === "cap/request";
}

export function isHostMessage(m: unknown): m is HostMessage {
	if (!m || typeof m !== "object") return false;
	const t = (m as { type?: unknown }).type;
	return (
		t === "host/hello" ||
		t === "context/update" ||
		t === "host/commandResult" ||
		t === "cap/result" ||
		t === "host/event"
	);
}

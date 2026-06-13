/*
 * conductor.ts — the Accordion ↔ Conductor contract (ADR 0007).
 *
 * A "conductor" is an interchangeable context-management strategy. Today the engine
 * has exactly one — the built-in auto-folder (`conductor.builtin.ts`). Tomorrow a
 * stranger on the internet writes their own, in any language, and slots it in over a
 * WebSocket. Both sides of that wire (and the in-process built-in) speak the SAME
 * vocabulary, defined here.
 *
 * The whole contract is the in-process shape of one pure idea:
 *
 *     conduct(snapshot) → Command[]
 *
 * The host hands the conductor a read-only SNAPSHOT of the context; the conductor
 * replies with COMMANDS describing the context it wants. The host clamps those
 * commands to the one floor it enforces — provider-validity, "the message must always
 * stay sendable" — applies them, and reports back anything it had to clamp.
 *
 * This module is deliberately dependency-free and runes-free (it imports only the
 * `Block` type). It must be importable by the engine, by the live wire layer, and —
 * via the shared `conductorProtocol.ts` — by an out-of-process conductor. Keep it that
 * way: no Svelte, no `$state`, no Node/Tauri APIs.
 */
import type { Block } from "./types";

/**
 * A read-only view of the context the conductor reasons over. The host owns the
 * objects; a conductor MUST treat everything here as immutable (mutating a `Block`
 * reaches into the live store and is out of contract).
 */
export interface ContextSnapshot {
	/** Every block, in conversation order. The conductor's whole field of view. */
	readonly blocks: readonly Block[];
	/** Token budget for the live context window. */
	readonly budget: number;
	/** The model's total context window as reported by the host, or null if unknown. */
	readonly contextWindow: number | null;
	/**
	 * Live token cost RIGHT NOW, at the moment the snapshot is taken: the host has
	 * already cleared the previous conductor pass, so this reflects the human's
	 * overrides and any folded groups but NO conductor folds. It is the baseline a
	 * conductor folds down FROM.
	 */
	readonly liveTokens: number;
	/**
	 * Index of the first block in the host's protected working tail. This is host
	 * POLICY surfaced for convenience (the built-in conductor treats it as a hard
	 * "don't fold past here" line). A conductor is free to ignore it — the host does
	 * not enforce it as a floor — but folding into the tail will be reflected in the
	 * view and may be reverted by host healing. `blocks.length` means "no tail".
	 */
	readonly protectedFromIndex: number;
	/** The protected-tail token target driving `protectedFromIndex`. */
	readonly protectTokens: number;
	/**
	 * True if this block id is a member of a folded group. Group folds are owned by
	 * the host's group overlay, not by per-block commands; a conductor should leave
	 * grouped blocks alone (folding one individually double-counts against the group).
	 */
	isInFoldedGroup(id: string): boolean;
}

/**
 * The command vocabulary. Every command is CONTENT SUBSTITUTION, never structural
 * removal — a block is never spliced out of the conversation, only its content
 * changes. That single rule is what makes broken states unrepresentable: a
 * `tool_call`/`tool_result` pair can never orphan, because neither block can vanish.
 *
 * Commands accumulate into a persistent "current state". Each `conduct()` return is
 * the conductor's COMPLETE desired state (the host resets to baseline, then applies
 * the batch) — so to change one block a conductor re-sends its whole intention. The
 * imperative form is chosen so a conductor can also work declaratively internally and
 * emit a quick burst of commands to reach its target.
 */
export type Command =
	| FoldCommand
	| ReplaceCommand
	| GroupCommand
	| RestoreCommand
	| PinCommand;

/**
 * Collapse blocks to a digest. With no `digest`, the host uses its own per-kind digest
 * (and the agent-recoverable `{#code FOLDED}` tag). With a `digest`, that exact string
 * is what the view shows and the agent receives.
 */
export interface FoldCommand {
	kind: "fold";
	ids: string[];
	digest?: string;
}

/**
 * Substitute a block's content with arbitrary text the conductor chose. `content: ""`
 * is the safe form of "delete" — the block stays in place (so its callId/pairing is
 * intact) but contributes (almost) nothing.
 */
export interface ReplaceCommand {
	kind: "replace";
	id: string;
	content: string;
}

/**
 * Collapse a CONTIGUOUS run of blocks into a single summary entry (summary-on-head,
 * the rest emptied — never removed). Non-contiguous selections are not representable;
 * a conductor wanting that must empty/replace blocks individually instead.
 */
export interface GroupCommand {
	kind: "group";
	ids: string[];
}

/** Return blocks to full, live content (undo a fold/replace). No-op on human-held blocks. */
export interface RestoreCommand {
	kind: "restore";
	ids: string[];
}

/**
 * Assert that blocks should stay live and open. In the full-state model this is
 * usually implicit (anything not folded is live), but `pin` lets a conductor be
 * explicit — e.g. force a block live that an earlier command in the same batch folded.
 * It never overrides a human pin (that override is the human's alone).
 */
export interface PinCommand {
	kind: "pin";
	ids: string[];
}

/**
 * What the host did when a command could not be applied verbatim. Never thrown, never
 * silently dropped: the host clamps to the nearest safe form (or a no-op) and returns
 * one report per affected command so the conductor can learn and adapt.
 */
export interface ClampReport {
	/** The command kind that was clamped. */
	command: Command["kind"];
	/** The block id(s) involved, for correlation. */
	ids: string[];
	/** Machine-readable reason. */
	reason: ClampReason;
	/** Human-readable detail for logs. */
	detail: string;
}

export type ClampReason =
	/** No block with that id exists (vanished in a resync, or never existed). */
	| "unknown-id"
	/** A human override (pin / manual fold / manual unfold) owns this block; human wins. */
	| "human-override"
	/** The block is inside a folded group; the group overlay owns it. */
	| "grouped"
	/** A group command's ids were not a valid contiguous, ungrouped, ≥2-member run. */
	| "invalid-group"
	/** The op was a no-op (e.g. restoring an already-live block). */
	| "noop";

/**
 * A context-management strategy. The built-in folder is one; a remote WebSocket
 * conductor is wrapped in another. The host calls `conduct()` whenever the context
 * changes (a block streamed in, the budget moved, the protect tail resized).
 *
 * Return value:
 *  - `Command[]` — the conductor's complete desired state; the host resets to baseline
 *    and applies it.
 *  - `[]` — explicitly clear to raw (nothing folded).
 *  - `null` — "hold": the host keeps the last applied state untouched. Used by an
 *    async (remote) conductor that is still thinking; it must never block a model call.
 *
 * `conduct()` MUST be synchronous and side-effect-free with respect to the snapshot.
 * An out-of-process conductor does its async work off to the side and feeds the result
 * back through a synchronous runner (see `RemoteRunner` in the live layer).
 */
export interface Conductor {
	/** Stable identifier, e.g. "builtin" or a remote session id. Drives actor attribution. */
	readonly id: string;
	/** Human-facing label for the switcher UI. */
	readonly label: string;
	conduct(snapshot: ContextSnapshot): Command[] | null;
}

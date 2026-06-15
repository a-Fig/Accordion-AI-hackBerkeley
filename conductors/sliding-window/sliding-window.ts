/*
 * sliding-window.ts — "just drop old context" conductor.
 *
 * Simulates the strategy used by many AI coding tools: once the context grows
 * past a threshold, discard a chunk of the oldest non-user content. User messages
 * are always preserved (they carry intent). Protected tail is respected.
 *
 * Fires in discrete chops, not continuously:
 *  - Threshold: liveTokens > budget * 0.95
 *  - Chop target: ~20% of budget worth of tokens
 *  - Dropping: `group` commands per contiguous run between user/protected boundaries;
 *    `replace { content: "" }` for isolated single blocks (true erasure, not digest)
 *  - State: tracks cumulative token savings and re-emits commands; extends on next trigger
 *
 * This is the dumb baseline — no ranking, no scoring, just oldest-first erasure.
 */
import type { Conductor, ConductorView, Command, ViewBlock } from "../contract";

/** Fraction of budget that triggers a chop. */
const TRIGGER_RATIO = 0.95;
/** Fraction of budget to recover per chop. */
const CHOP_RATIO = 0.20;

/**
 * Extract the message key from a durable block id (the prefix before the first colon).
 * Blocks sharing a message key belong to the same assistant/user message and must be
 * grouped or skipped together — the host snaps group ranges to message boundaries.
 */
function messageKey(id: string): string {
	const i = id.indexOf(":");
	return i >= 0 ? id.slice(0, i) : id;
}

export class SlidingWindowConductor implements Conductor {
	readonly id = "sliding-window";
	readonly label = "Sliding window";

	/** Accumulated commands from all chops so far — re-emitted each call. */
	private _commands: Command[] = [];
	/** Cumulative token savings from all emitted commands (avoids re-scanning). */
	private _tokensSaved = 0;

	conduct(view: ConductorView): Command[] {
		if (view.budget <= 0 || view.blocks.length === 0) return this._commands;

		const threshold = view.budget * TRIGGER_RATIO;
		const effectiveLive = view.liveTokens - this._tokensSaved;

		if (effectiveLive <= threshold) return this._commands;

		const chopTarget = view.budget * CHOP_RATIO;
		this._extendChop(view, chopTarget);
		return this._commands;
	}

	/**
	 * Walk blocks oldest-first and collect enough to recover `chopTarget` tokens.
	 * Builds group commands per contiguous run, validated against message-boundary
	 * snapping so the host won't reject them. Single isolated blocks use `replace`
	 * with empty content (true erasure — no digest, near-zero token cost).
	 */
	private _extendChop(view: ConductorView, chopTarget: number): void {
		const alreadyDropped = this._droppedIds();
		let recovered = 0;

		// Build a lookup of held block ids by message key, so we can detect when
		// message-boundary snapping would pull a held block into a group range.
		const heldMessageKeys = new Set<string>();
		for (const b of view.blocks) {
			if (b.held) heldMessageKeys.add(messageKey(b.id));
		}

		const eligible = view.blocks.slice(0, view.protectedFromIndex);
		let currentRun: ViewBlock[] = [];

		const flushRun = () => {
			if (currentRun.length === 0) return;

			if (currentRun.length === 1) {
				const b = currentRun[0];
				this._commands.push({ kind: "replace", id: b.id, content: "" });
				this._tokensSaved += b.tokens;
			} else {
				this._commands.push({
					kind: "group",
					ids: currentRun.map((b) => b.id),
				});
				for (const b of currentRun) this._tokensSaved += b.tokens;
			}
			currentRun = [];
		};

		for (const b of eligible) {
			if (recovered >= chopTarget) {
				flushRun();
				break;
			}

			const isDroppable =
				b.kind !== "user" &&
				!b.protected &&
				!b.held &&
				!b.grouped &&
				!alreadyDropped.has(b.id);

			if (!isDroppable) {
				flushRun();
				continue;
			}

			// Before adding to the run, check: would message-boundary snapping pull
			// in a held block? If so, skip this block (break the run) rather than
			// emit a group the host will reject.
			if (heldMessageKeys.has(messageKey(b.id))) {
				flushRun();
				continue;
			}

			currentRun.push(b);
			recovered += b.tokens;
		}

		flushRun();
	}

	/** All block ids already targeted by prior commands. */
	private _droppedIds(): Set<string> {
		const ids = new Set<string>();
		for (const cmd of this._commands) {
			if (cmd.kind === "group") {
				for (const id of cmd.ids) ids.add(id);
			} else if (cmd.kind === "replace") {
				ids.add(cmd.id);
			}
		}
		return ids;
	}
}

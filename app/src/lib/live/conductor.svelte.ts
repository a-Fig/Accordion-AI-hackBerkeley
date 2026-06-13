/*
 * conductor.svelte.ts — the active-conductor SELECTION (shared UI state).
 *
 * Mirrors `folding.svelte.ts`: a tiny reactive switch the sidebar sets and the header
 * reads. WHICH conductor is active is the user's choice, persisted across reloads. The
 * AVAILABLE list lives in `conductorDiscovery.svelte.ts`; the actual attach/detach is
 * `conductorClient.attachConductor`. This module just remembers the pick.
 */
import { BUILTIN_ID, NONE_ID } from "./conductorClient.svelte";
import { allConductors } from "./conductorDiscovery.svelte";

const KEY = "accordion.conductor.active";

export const conductorState = $state<{ activeId: string }>({
	activeId: load(),
});

export function setActiveConductor(id: string): void {
	conductorState.activeId = id;
	if (typeof localStorage !== "undefined") {
		try {
			localStorage.setItem(KEY, id);
		} catch {
			/* storage blocked — selection just won't persist */
		}
	}
}

/** Human-facing label for the active conductor, resolved against the available list. */
export function activeConductorLabel(): string {
	const id = conductorState.activeId;
	if (id === BUILTIN_ID) return "Built-in";
	if (id === NONE_ID) return "Raw";
	return allConductors().find((c) => c.id === id)?.label ?? "Built-in";
}

/** True when the active conductor is an external (remote) one — drives the header status dot. */
export function activeConductorIsRemote(): boolean {
	const id = conductorState.activeId;
	return id !== BUILTIN_ID && id !== NONE_ID;
}

function load(): string {
	if (typeof localStorage === "undefined") return BUILTIN_ID;
	return localStorage.getItem(KEY) || BUILTIN_ID;
}

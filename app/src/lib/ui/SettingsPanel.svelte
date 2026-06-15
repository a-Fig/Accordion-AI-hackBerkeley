<script lang="ts">
	import Icon from "$lib/ui/Icon.svelte";
	import SegControl from "$lib/ui/SegControl.svelte";
	import { settings } from "$lib/settings.svelte";

	let {
		open = false,
		onclose = () => {},
	}: {
		open?: boolean;
		onclose?: () => void;
	} = $props();

	// Focus management: move focus into the close button when the panel opens,
	// and restore focus to the previously-focused element when it closes.
	let closeBtn = $state<HTMLButtonElement | null>(null);
	let returnFocus = $state<Element | null>(null);

	$effect(() => {
		if (open) {
			returnFocus = document.activeElement;
			// Defer one microtask so the DOM is rendered before we focus
			Promise.resolve().then(() => closeBtn?.focus());
		} else {
			if (returnFocus instanceof HTMLElement) {
				returnFocus.focus();
			}
			returnFocus = null;
		}
	});

	// ── Section/row data shape ──────────────────────────────────────────────
	// To add a new setting: (1) add a row object to the relevant section's
	// `rows` array (or push a new section object to add a whole section), AND
	// (2) add a matching `{#if row.id === "..."}` branch in the control slot
	// below — one branch per row id is required because Svelte 5 snippets
	// can't live in plain JS objects.
	//
	// Row shape:
	//   { id, label, helper? }
	// Section shape:
	//   { title, rows }

	type SettingRow = { id: string; label: string; helper?: string };
	type Section = { title: string; rows: SettingRow[] };

	const sections: Section[] = [
		{
			title: "Appearance",
			rows: [
				{
					id: "foldDisplayMode",
					label: "Folded blocks",
					helper: "Classic = dimmed tiles · Sliver = compact slivers with a summary",
				},
			],
		},
	];

	// Escape key closes the panel
	$effect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				onclose();
			}
		}
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	});
</script>

{#if open}
	<!-- Scrim -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="scrim" onclick={onclose}></div>

	<!-- Panel -->
	<div
		class="panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
		aria-label="Settings"
	>
		<div class="panel-head">
			<span class="panel-title" id="settings-title">Settings</span>
			<button bind:this={closeBtn} class="close-btn" onclick={onclose} aria-label="Close settings">
				<Icon name="x" size={16} />
			</button>
		</div>

		<div class="panel-body">
			{#each sections as section}
				<section class="s-section">
					<h2 class="s-title">{section.title}</h2>
					{#each section.rows as row}
						<div class="s-row">
							<div class="s-label-wrap">
								<span class="s-label">{row.label}</span>
								{#if row.helper}
									<span class="s-helper">{row.helper}</span>
								{/if}
							</div>
							<div class="s-control">
								<!-- Add a new {#if row.id === "..."} branch per setting -->
								{#if row.id === "foldDisplayMode"}
									<SegControl
										options={[
											{ id: "classic", label: "Classic" },
											{ id: "sliver", label: "Sliver" },
										]}
										value={settings.foldDisplayMode}
										onchange={(v) => settings.set("foldDisplayMode", v as import("$lib/settings.svelte").FoldDisplayMode)}
										ariaLabel="Folded block display mode"
									/>
								{/if}
							</div>
						</div>
					{/each}
				</section>
			{/each}
		</div>
	</div>
{/if}

<style>
	/* ── Scrim ────────────────────────────────────────────────────────────── */
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 900;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(1px);
		animation: fade-in var(--dur-fast) var(--ease-out) both;
	}

	/* ── Panel ────────────────────────────────────────────────────────────── */
	.panel {
		position: fixed;
		z-index: 901;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(440px, calc(100vw - 48px));
		max-height: min(80vh, calc(100vh - 48px));
		background: var(--panel);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-3);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		animation: panel-in var(--dur-fast) var(--ease-out) both;
	}

	/* ── Panel header ─────────────────────────────────────────────────────── */
	.panel-head {
		display: flex;
		align-items: center;
		padding: var(--sp-3) var(--sp-4);
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
		gap: var(--sp-2);
	}
	.panel-title {
		font-size: var(--fs-base);
		font-weight: 700;
		color: var(--text);
		flex: 1;
		letter-spacing: 0.01em;
	}
	.close-btn {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--faint);
		cursor: pointer;
		flex: 0 0 auto;
		transition:
			background var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.close-btn:hover {
		background: var(--panel-2);
		color: var(--text);
	}
	.close-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	/* ── Panel body ───────────────────────────────────────────────────────── */
	.panel-body {
		padding: var(--sp-4);
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		overflow-y: auto;
		min-height: 0;
	}

	/* ── Section ──────────────────────────────────────────────────────────── */
	.s-section {
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
	}
	.s-title {
		font-size: var(--fs-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
		margin: 0;
		padding-bottom: var(--sp-1);
		border-bottom: 1px solid var(--line-soft);
	}

	/* ── Row ──────────────────────────────────────────────────────────────── */
	.s-row {
		display: flex;
		align-items: flex-start;
		gap: var(--sp-4);
	}
	.s-label-wrap {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.s-label {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
	}
	.s-helper {
		font-size: var(--fs-xs);
		color: var(--faint);
		line-height: 1.55;
	}
	.s-control {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		padding-top: 1px; /* optical alignment with label baseline */
	}

	/* ── Animations ───────────────────────────────────────────────────────── */
	@keyframes fade-in {
		from { opacity: 0; }
		to   { opacity: 1; }
	}
	@keyframes panel-in {
		from { opacity: 0; transform: translate(-50%, calc(-50% - 8px)); }
		to   { opacity: 1; transform: translate(-50%, -50%); }
	}
</style>

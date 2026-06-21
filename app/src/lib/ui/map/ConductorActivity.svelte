<script lang="ts">
	import type { AccordionStore } from "$lib/engine/store.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import { live } from "$lib/live/liveClient.svelte";
	import { conductorStatus } from "$lib/live/conductorClient.svelte";
	import { formatTokens, healthFromStore, normalizeDiagnostics } from "$lib/conductorDiagnostics";

	let { store, onclose }: { store: AccordionStore; onclose: () => void } = $props();

	const statusText = $derived(store.conductorStatus.text || conductorStatus.text);
	const statusDetails = $derived(store.conductorStatus.text ? store.conductorStatus.details : conductorStatus.details);
	const diagnostics = $derived(normalizeDiagnostics(statusDetails));
	const health = $derived(healthFromStore(diagnostics.health, store.liveTokens, store.budget, store.contextWindow));
	const target = $derived(health.foldTargetCalibrated ?? health.foldTargetThisTurn);
	const band = $derived(health.foldTargetBand);
	const pressure = $derived(health.pressure ?? "normal");
	const dashboardHref = $derived(live.sessionId ? `/conductor/${encodeURIComponent(live.sessionId)}` : "/conductor");

	function statusLabel(): string {
		if (live.status === "connected") return "connected";
		if (live.status === "connecting") return "connecting";
		if (live.status === "error") return "error";
		return "idle";
	}
</script>

<aside class="activity-panel" aria-label="Conductor activity">
	<header class="activity-head">
		<div class="head-title">
			<span class="status-dot {live.status}" aria-hidden="true"></span>
			<div>
				<div class="eyebrow">Conductor</div>
				<div class="status-line">{statusLabel()}</div>
			</div>
		</div>
		<button class="icon-btn" onclick={onclose} aria-label="Close activity panel" title="Close activity">
			<Icon name="x" size={14} />
		</button>
	</header>

	<section class="metric-block">
		<div class="metric-label">fold target</div>
		{#if target != null}
			<div class="metric-value">{Math.round(target * 100)}%</div>
			{#if band}
				<div class="metric-sub">band {Math.round(band.min * 100)}-{Math.round(band.max * 100)}%</div>
			{/if}
		{:else if statusText}
			<div class="metric-value small">{statusText}</div>
		{:else}
			<div class="metric-sub">awaiting first turn...</div>
		{/if}
	</section>

	<section class="metric-block">
		<div class="metric-label">budget</div>
		<div class="budget-row">
			<span class="metric-value">{formatTokens(health.assembledTokens)}</span>
			<span class="metric-sub">/ {formatTokens(health.budgetTokens)}</span>
		</div>
		<span class="pressure {pressure}">{pressure}</span>
	</section>

	<section class="recent">
		<div class="section-title">recent</div>
		{#if store.log.length}
			{#each store.log.slice(0, 3) as entry (entry.n)}
				<div class="log-row" title={entry.detail}>
					<span class="log-by">{entry.by}</span>
					<span class="log-action">{entry.action}</span>
					<span class="log-detail">{entry.detail}</span>
				</div>
			{/each}
		{:else}
			<div class="empty">No activity yet.</div>
		{/if}
	</section>

	<a class="dash-link" href={dashboardHref}>
		<Icon name="activity" size={13} />
		<span>Open dashboard</span>
		<Icon name="chevron-right" size={13} />
	</a>
</aside>

<style>
	.activity-panel {
		min-width: 0;
		min-height: 0;
		border-left: 1px solid var(--line-soft);
		background: var(--panel);
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding: var(--sp-3);
		overflow: auto;
	}
	.activity-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
	}
	.head-title {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.status-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
	}
	.status-dot.connected {
		background: var(--ok);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 16%, transparent);
	}
	.status-dot.connecting {
		background: var(--warn);
	}
	.status-dot.error {
		background: var(--danger);
	}
	.eyebrow {
		font-size: var(--fs-2xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--faint);
	}
	.status-line {
		font-size: var(--fs-sm);
		color: var(--text);
	}
	.icon-btn {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--panel-2);
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.icon-btn:hover {
		color: var(--text);
		background: var(--panel-3);
	}
	.metric-block,
	.recent {
		border: 1px solid var(--line-soft);
		background: var(--panel-2);
		border-radius: var(--radius-sm);
		padding: var(--sp-3);
	}
	.metric-label,
	.section-title {
		font-size: var(--fs-2xs);
		font-weight: 700;
		color: var(--faint);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: var(--sp-1);
	}
	.metric-value {
		font-family: var(--mono);
		font-size: var(--fs-xl);
		font-weight: 700;
		color: var(--text);
		line-height: 1.1;
	}
	.metric-value.small {
		font-size: var(--fs-sm);
		line-height: 1.35;
		white-space: normal;
	}
	.metric-sub {
		font-size: var(--fs-xs);
		color: var(--faint);
	}
	.budget-row {
		display: flex;
		align-items: baseline;
		gap: 4px;
		flex-wrap: wrap;
	}
	.pressure {
		display: inline-flex;
		margin-top: var(--sp-2);
		border-radius: var(--radius-pill);
		border: 1px solid var(--line);
		padding: 2px 8px;
		font-size: var(--fs-xs);
		color: var(--muted);
	}
	.pressure.comfortable {
		color: var(--ok);
		border-color: color-mix(in srgb, var(--ok) 35%, var(--line));
	}
	.pressure.tight {
		color: var(--warn);
		border-color: color-mix(in srgb, var(--warn) 35%, var(--line));
	}
	.log-row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 6px;
		align-items: baseline;
		font-size: var(--fs-xs);
		padding: 5px 0;
		border-top: 1px solid var(--line-soft);
	}
	.log-row:first-of-type {
		border-top: 0;
	}
	.log-by {
		color: var(--accent);
		font-weight: 700;
	}
	.log-action {
		color: var(--muted);
	}
	.log-detail {
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		font-size: var(--fs-xs);
		color: var(--faint);
	}
	.dash-link {
		margin-top: auto;
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		justify-content: space-between;
		color: var(--accent);
		text-decoration: none;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
		background: var(--accent-soft);
		border-radius: var(--radius-sm);
		padding: 8px 10px;
		font-size: var(--fs-sm);
		font-weight: 600;
	}
</style>

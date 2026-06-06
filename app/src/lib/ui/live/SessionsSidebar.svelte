<script lang="ts">
	import type { SessionEntry } from "$lib/live/registry";

	let {
		sessions,
		selected,
		connected,
		onselect,
	}: {
		sessions: SessionEntry[];
		selected: string | null;
		connected: boolean;
		onselect: (s: SessionEntry) => void;
	} = $props();

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
	function shortModel(m: string): string {
		if (!m) return "—";
		return m.includes("/") ? m.split("/").pop()! : m;
	}
	function pct(e: SessionEntry): number | null {
		if (e.tokens == null || !e.contextWindow) return null;
		return Math.min(100, Math.round((e.tokens / e.contextWindow) * 100));
	}
	function fmtTokens(n: number | null): string {
		if (n == null) return "";
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
		return String(n);
	}
</script>

<aside class="rail">
	<div class="head">
		<span class="logo">🪗</span>
		<span class="ttl">Sessions</span>
		<span class="count">{sessions.length}</span>
	</div>

	{#if sessions.length === 0}
		<div class="empty">
			<p>No live pi sessions.</p>
			<p class="hint">Start <code>pi</code> in a project — it shows up here on its own.</p>
		</div>
	{:else}
		<ul class="list">
			{#each sessions as s (s.sessionId)}
				{@const p = pct(s)}
				{@const isSel = s.sessionId === selected}
				<li>
					<button class="row" class:sel={isSel} onclick={() => onselect(s)} title={s.cwd}>
						<span class="dot" class:on={isSel && connected}></span>
						<span class="body">
							<span class="t1">{baseName(s.cwd) || s.title}</span>
							<span class="t2 mono">{shortModel(s.model)}</span>
						</span>
						{#if p !== null}
							<span class="usage" title={`${s.tokens} / ${s.contextWindow} tokens`}>
								<span class="bar"><span class="fill" class:hot={p >= 80} style:width={`${p}%`}></span></span>
								<span class="pct mono">{fmtTokens(s.tokens)}</span>
							</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</aside>

<style>
	.rail {
		width: 232px;
		flex: 0 0 auto;
		height: 100%;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--line);
		background: var(--panel);
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
	}
	.logo {
		font-size: 16px;
	}
	.ttl {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.count {
		margin-left: auto;
		font-size: 11px;
		color: var(--faint);
		background: var(--panel-2);
		border-radius: 999px;
		padding: 1px 8px;
	}
	.empty {
		padding: 18px 14px;
		color: var(--muted);
	}
	.empty p {
		margin: 0 0 8px;
		font-size: 12px;
	}
	.empty .hint {
		color: var(--faint);
		font-size: 11px;
		line-height: 1.5;
	}
	.empty code {
		background: var(--panel-2);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 6px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}
	.row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 9px 10px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 110ms ease, border-color 110ms ease;
	}
	.row:hover {
		background: var(--panel-2);
	}
	.row.sel {
		background: var(--panel-2);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--faint);
	}
	.dot.on {
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
	}
	.body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
	}
	.t1 {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t2 {
		font-size: 10.5px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.usage {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex: 0 0 auto;
	}
	.bar {
		width: 38px;
		height: 4px;
		border-radius: 999px;
		background: var(--panel);
		border: 1px solid var(--line);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.fill.hot {
		background: var(--danger);
	}
	.pct {
		font-size: 10px;
		color: var(--faint);
	}
</style>

<script lang="ts">
  import { tick } from 'svelte';

  let { value, format, oncommit }: {
    value: number;
    format: (n: number) => string;
    oncommit: (n: number) => void;
  } = $props();

  let editing = $state(false);
  let inputValue = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  function toEditString(n: number): string {
    const k = n / 1000;
    if (Number.isInteger(k)) return String(k);
    return k.toFixed(1).replace(/\.0$/, '');
  }

  async function startEdit() {
    inputValue = toEditString(value);
    editing = true;
    await tick();
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  }

  function commit() {
    if (!editing) return;
    editing = false;
    const raw = inputValue.replace(/,/g, '').trim();
    if (!raw) return;
    const n = parseFloat(raw);
    if (isNaN(n) || !isFinite(n)) return;
    oncommit(Math.round(n * 1000));
  }

  function cancel() {
    editing = false;
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }
</script>

{#if editing}
  <input
    bind:this={inputEl}
    bind:value={inputValue}
    class="edit-input mono tnum"
    inputmode="decimal"
    style:width="{inputValue.length + 1}ch"
    onkeydown={onkeydown}
    onblur={commit}
  />
{:else}
  <b
    class="mono tnum kl-val clickable"
    role="button"
    tabindex="0"
    onclick={startEdit}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); } }}
  >{format(value)}</b>
{/if}

<style>
  .edit-input {
    background: transparent;
    border: none;
    border-bottom: 1.5px solid var(--accent);
    outline: none;
    padding: 0;
    margin: 0;
    color: var(--muted);
    font-weight: 600;
    font-size: inherit;
    font-family: inherit;
    text-transform: none;
    letter-spacing: 0;
    line-height: inherit;
  }
  .kl-val {
    color: var(--muted);
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }
  .clickable {
    cursor: text;
  }
</style>

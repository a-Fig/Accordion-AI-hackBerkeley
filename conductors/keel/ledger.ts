/*
 * ledger.ts — Keel's deterministic FACT LEDGER + RISK FLAGS (Phase 1, ADR 0017 §6).
 *
 * Pure, zero-latency regex harvest over a block's `text`. Two jobs:
 *
 *   1. `riskFlags(text)` — which high-value categories a block contains. Used to make
 *      risk-bearing blocks STICKIER (they sort later in the fold candidate list, §relevance).
 *   2. `harvestFacts(blocks)` — a deduped, capped, category-ordered ledger of the exact
 *      load-bearing tokens across ALL blocks (paths / commands / key=value / errors /
 *      decisions). Surfaced to the human via `host.setStatus` so the *names* of things the
 *      agent has survive compression even when bodies are folded (the F3/F4 backstop).
 *
 * This is a NATIVE reimplementation informed by the-conductor's `categorizeSalienceMarkers`
 * / `buildFactLedger` — it is NOT imported (that module uses non-contract types and pulls in
 * the whole strategy file). Kept small, pure, and dependency-free: types only from `../contract`.
 * No Date, no Math.random, no global state — same input ⇒ byte-identical output.
 */
import type { ViewBlock, ConductorFactLedgerEntry } from "../contract";

/** The five fact categories, in ledger priority order (most load-bearing first). */
export type FactCategory = "exact_values" | "decisions" | "commands" | "errors" | "paths";

const CATEGORY_ORDER: readonly FactCategory[] = [
	"exact_values",
	"decisions",
	"commands",
	"errors",
	"paths",
];

/** The risk categories that lower a block's fold priority (a subset — errors are noisy). */
const RISK_CATEGORIES: readonly FactCategory[] = ["exact_values", "decisions", "commands", "paths"];

/** Common keys that carry no signal as a `key=value` fact. */
const VALUE_STOPWORDS = new Set([
	"the", "and", "for", "this", "that", "with", "from", "true", "false", "null",
	"const", "let", "var", "type", "return", "import", "export", "function",
]);

/** Per-category cap when harvesting one block (keeps a single noisy block from flooding). */
const PER_BLOCK_CAP = 3;

interface CategorizedMarkers {
	paths: string[];
	commands: string[];
	errors: string[];
	exact_values: string[];
	decisions: string[];
}

/**
 * Categorize a block's text into salience buckets. Pure regex work, bounded so it stays
 * O(n) on long no-newline text (the decision pattern's pre-context is capped at 200 chars).
 */
export function categorize(text: string): CategorizedMarkers {
	const result: CategorizedMarkers = {
		paths: [], commands: [], errors: [], exact_values: [], decisions: [],
	};
	if (typeof text !== "string" || text.length === 0) return result;
	// `seen` is a GLOBAL dedup across all categories: a value seen as a path won't reappear as a command.
	const seen = new Set<string>();
	const add = (bucket: string[], val: string): void => {
		const t = val.trim().slice(0, 80);
		if (!t || seen.has(t) || bucket.length >= PER_BLOCK_CAP) return;
		seen.add(t);
		bucket.push(t);
	};

	// Paths: filenames with a code/data extension, and relative/src-rooted paths.
	for (const m of text.matchAll(
		/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml|sh|env|log|conf|cfg|txt|sql|proto|lock)\b/g,
	)) {
		add(result.paths, m[0]);
	}
	for (const m of text.matchAll(/(?:^|\s)((?:\.{1,2}|src|lib|app|dist|build|test|scripts?)\/[\w./-]+)/gm)) {
		add(result.paths, m[1]);
	}

	// Commands: `$ …` prompts and common CLI invocations.
	for (const m of text.matchAll(/^\s*\$\s+(.+)/gm)) add(result.commands, m[1].slice(0, 80));
	for (const m of text.matchAll(
		/\b(?:npm|npx|pnpm|yarn|bun|node|git|docker|kubectl|make|cargo|go|python3?|pytest|deno|uv|gh)\s+\S[^\n.!?;]{0,60}/g,
	)) {
		add(result.commands, m[0].trim());
	}

	// Errors: explicit error markers + stack frames.
	for (const m of text.matchAll(
		/\b(?:Error|FAIL|FAILED|error|exception|panic|ENOENT|ECONNREFUSED)[: ]+[^\n]{0,60}/g,
	)) {
		add(result.errors, m[0].slice(0, 60));
	}
	if (/\s+at\s+\S+\s*\(/.test(text)) add(result.errors, "stack trace");

	// Exact values: key=value / key: value pairs with a non-trivial value.
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1];
		const val = m[2];
		if (!VALUE_STOPWORDS.has(key.toLowerCase()) && val.length > 2 && val.length < 60) {
			add(result.exact_values, `${key}=${val}`);
		}
	}

	// Decisions: explicit decision language; pre-context bounded to keep it O(n).
	for (const m of text.matchAll(
		/[^.!?\n]{0,200}\b(?:decided|chose|standardized on|going with|will use|selected|picked)\b[^.!?\n]{0,200}/gi,
	)) {
		add(result.decisions, m[0].trim().slice(0, 80));
	}

	return result;
}

/**
 * The risk categories present in a block's text. A block with more risk flags is stickier
 * (folded later). Empty array ⇒ generic prose with nothing load-bearing.
 */
export function riskFlags(text: string): FactCategory[] {
	const cats = categorize(text);
	return RISK_CATEGORIES.filter((c) => cats[c].length > 0);
}

/**
 * Build the structured fact ledger across all blocks — deduped (category+value, lowercased),
 * capped at `maxFacts`, in category-priority order. Each entry carries its source block id +
 * turn so the human can trace a fact back to where it came from. Deterministic: the first
 * block (conversation order) that mentions a value owns it.
 */
export function harvestFacts(blocks: ViewBlock[], maxFacts = 24): ConductorFactLedgerEntry[] {
	const seen = new Set<string>();
	const byCat: Record<FactCategory, ConductorFactLedgerEntry[]> = {
		exact_values: [], decisions: [], commands: [], errors: [], paths: [],
	};
	for (const block of blocks) {
		if (block.text === undefined) continue;
		const cats = categorize(block.text);
		for (const cat of CATEGORY_ORDER) {
			for (const value of cats[cat]) {
				const key = `${cat}:${value.toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				byCat[cat].push({ category: cat, value, turn: block.turn, sourceId: block.id });
			}
		}
	}
	const out: ConductorFactLedgerEntry[] = [];
	for (const cat of CATEGORY_ORDER) {
		for (const entry of byCat[cat]) {
			if (out.length >= maxFacts) return out;
			out.push(entry);
		}
	}
	return out;
}

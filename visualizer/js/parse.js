/*
 * parse.js — turn a raw session transcript (OMP/pi or Claude Code JSONL)
 * into one normalized model the rest of the app understands.
 *
 * Normalized message: { role, model, ts, blocks: [...] }
 *   role  : 'user' | 'assistant' | 'tool' | 'system'
 *   blocks: { type:'text',        text }
 *           { type:'thinking',    text }
 *           { type:'tool_call',   name, args, id }
 *           { type:'tool_result', name, text, isError }
 *           { type:'note',        text }   // compaction / system notes
 *
 * Returns { format, title, cwd, messages, lineCount, skipped }.
 */
(function (App) {
	"use strict";

	function parseLines(raw) {
		const out = [];
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				out.push(JSON.parse(t));
			} catch (_) {
				/* tolerate the odd broken line */
			}
		}
		return out;
	}

	function detectFormat(entries) {
		if (!entries.length) return "unknown";
		const first = entries[0];
		if (first.type === "session" && "version" in first) return "omp";
		// Claude Code: entries carry uuid + (parentUuid) and a typed role
		for (const e of entries.slice(0, 12)) {
			if (e.uuid && (e.type === "user" || e.type === "assistant")) return "claude";
		}
		// pi sessions may not have version but still start with type:session
		if (first.type === "session") return "omp";
		return "unknown";
	}

	const asText = (c) => {
		if (typeof c === "string") return c;
		if (Array.isArray(c))
			return c
				.filter((b) => b && b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n");
		return "";
	};

	// ---- OMP / pi -----------------------------------------------------------
	function parseOmp(entries) {
		let title = "", cwd = "";
		const messages = [];
		let skipped = 0;

		for (const e of entries) {
			switch (e.type) {
				case "session":
					title = e.title || "";
					cwd = e.cwd || "";
					break;
				case "message": {
					const m = e.message || {};
					const ts = e.timestamp;
					if (m.role === "user") {
						messages.push({ role: "user", ts, blocks: [{ type: "text", text: asText(m.content) }] });
					} else if (m.role === "assistant") {
						const blocks = [];
						for (const b of m.content || []) {
							if (b.type === "thinking") blocks.push({ type: "thinking", text: b.thinking || "" });
							else if (b.type === "text") blocks.push({ type: "text", text: b.text || "" });
							else if (b.type === "toolCall")
								blocks.push({ type: "tool_call", name: b.name, args: b.arguments || {}, id: b.id });
						}
						if (blocks.length) messages.push({ role: "assistant", model: m.model || e.model, ts, blocks });
						else skipped++;
					} else if (m.role === "toolResult") {
						messages.push({
							role: "tool",
							ts,
							blocks: [
								{ type: "tool_result", name: m.toolName || "tool", text: asText(m.content), isError: !!m.isError },
							],
						});
					} else {
						skipped++;
					}
					break;
				}
				case "compaction":
					messages.push({ role: "system", ts: e.timestamp, blocks: [{ type: "note", text: "⤺ native compaction: " + (e.summary || "").slice(0, 400) }] });
					break;
				case "custom_message": {
					const txt = asText(e.content);
					if (txt) messages.push({ role: "system", ts: e.timestamp, blocks: [{ type: "note", text: txt }] });
					else skipped++;
					break;
				}
				default:
					skipped++; // model_change, thinking_level_change, mode_change, ...
			}
		}
		return { format: "omp", title, cwd, messages, lineCount: entries.length, skipped };
	}

	// ---- Claude Code --------------------------------------------------------
	function parseClaude(entries) {
		let title = "", cwd = "";
		const messages = [];
		const toolNames = {}; // tool_use id -> name (filled as we walk)
		let skipped = 0;

		for (const e of entries) {
			if (e.cwd && !cwd) cwd = e.cwd;
			if (e.type === "ai-title" || e.type === "custom-title") {
				title = e.aiTitle || e.customTitle || title;
				continue;
			}
			if (e.type === "assistant") {
				const m = e.message || {};
				const blocks = [];
				for (const b of m.content || []) {
					if (b.type === "thinking") blocks.push({ type: "thinking", text: b.thinking || "" });
					else if (b.type === "text") blocks.push({ type: "text", text: b.text || "" });
					else if (b.type === "tool_use") {
						if (b.id) toolNames[b.id] = b.name;
						blocks.push({ type: "tool_call", name: b.name, args: b.input || {}, id: b.id });
					}
				}
				if (blocks.length) messages.push({ role: "assistant", model: m.model, ts: e.timestamp, blocks });
				else skipped++;
			} else if (e.type === "user") {
				const m = e.message || {};
				const c = m.content;
				const results = Array.isArray(c) ? c.filter((b) => b && b.type === "tool_result") : [];
				if (results.length) {
					for (const r of results) {
						const txt = typeof r.content === "string" ? r.content : asText(r.content);
						messages.push({
							role: "tool",
							ts: e.timestamp,
							blocks: [{ type: "tool_result", name: toolNames[r.tool_use_id] || "tool", text: txt, isError: !!r.is_error }],
						});
					}
					// an entry can carry the user's typed text alongside tool results — keep both
					const utxt = asText(c);
					if (utxt.trim()) messages.push({ role: "user", ts: e.timestamp, blocks: [{ type: "text", text: utxt }] });
				} else {
					const txt = asText(c);
					if (txt.trim()) messages.push({ role: "user", ts: e.timestamp, blocks: [{ type: "text", text: txt }] });
					else skipped++;
				}
			} else {
				skipped++; // queue-operation, system, attachment, last-prompt, ...
			}
		}
		if (!title) title = "Claude Code session";
		return { format: "claude", title, cwd, messages, lineCount: entries.length, skipped };
	}

	function parse(raw) {
		const entries = parseLines(raw);
		const fmt = detectFormat(entries);
		if (fmt === "omp") return parseOmp(entries);
		if (fmt === "claude") return parseClaude(entries);
		throw new Error("Unrecognized session format (expected OMP/pi or Claude Code JSONL).");
	}

	App.parse = parse;
	App.detectFormat = detectFormat;
})((window.App = window.App || {}));

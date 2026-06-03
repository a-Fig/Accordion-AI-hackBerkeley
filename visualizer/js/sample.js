/*
 * sample.js — a small SYNTHETIC session (OMP/pi format) embedded as a fallback
 * so the page shows something even when opened via file:// with no server and
 * nothing dropped. Built as objects → JSONL to avoid hand-escaping mistakes.
 * Not real data.
 */
(function (App) {
	"use strict";
	const L = [];
	let pid = "root";
	let t = 0;
	const ts = () => new Date(Date.UTC(2026, 4, 30, 1, 0, t++)).toISOString();
	const pad = (s, n) => { let o = s; while (o.length < n) o += " " + s; return o.slice(0, n); };

	L.push({ type: "session", version: 3, id: "demo", timestamp: ts(), cwd: "C:\\Users\\you\\agentplayers\\arsenal", title: "Arsenal Chaos Ranked Game (synthetic demo)" });

	function add(role, content, extra) {
		const o = { type: "message", id: "m" + L.length, parentId: pid, timestamp: ts(), message: Object.assign({ role, content }, extra || {}) };
		pid = o.id; L.push(o);
	}
	function turn(ask, thinking, say, tool, toolArgs, result, model) {
		add("user", [{ type: "text", text: ask }]);
		const c = [];
		if (thinking) c.push({ type: "thinking", thinking });
		if (say) c.push({ type: "text", text: say });
		if (tool) c.push({ type: "toolCall", id: "call" + L.length, name: tool, arguments: toolArgs || {}, intent: say || ask });
		add("assistant", c, { model: model || "deepseek-v4-flash", usage: { input: 4000 + L.length * 50, output: 120, totalTokens: 4200 } });
		if (tool) add("toolResult", [{ type: "text", text: result }], { toolName: tool, toolCallId: "call" + (L.length - 1), isError: false });
	}

	const log = pad("[match] round start · score 2-1 · 14 alive · zone closing", 380);
	turn("Review my folder and figure out what 'arsenal chaos ranked' means.",
		"Roblox game reference. Read the briefing and folder first.",
		"Reading the workspace to get oriented.", "read", { path: "." },
		"AGENT_BRIEFING.md  1.2KB\nstrategy.md  3.0KB\n" + pad("notes", 120));
	turn("Read the briefing.", "", "Got it — I'm a competitive Arsenal player; goal is to climb ranked.",
		"read", { path: "AGENT_BRIEFING.md" },
		"You are HERMES, an elite Arsenal (Roblox FPS) agent. Win ranked matches. " + pad("Use cover, rotate early, prioritise objectives.", 200));
	turn("Connect to the game and queue ranked.", "Need to launch the client and join the matchmaking queue.",
		"Launching the client and queuing ranked.", "bash", { command: "launch_arsenal --ranked" },
		"client up · authenticated as HERMES#0783 · queued ranked\n" + log);
	turn("What's the current match state?", "", "Pulling live telemetry.",
		"get_state", { fields: ["score", "alive", "zone"] },
		"score 2-1 (we lead) · 14 alive · zone closing in 38s · " + pad("teammate down at B-site", 160));
	turn("Push B or rotate to A?", "We lead and zone favors A long-term; rotating avoids the choke.",
		"Rotating to A — safer with the lead and the closing zone.", "move", { to: "A-long", style: "cover" },
		"moved to A-long · 2 enemies spotted mid · " + pad("smoke deployed", 120));
	turn("Engage or hold?", "Hold the angle; let them peek into the smoke.",
		"Holding the angle and letting them come to me.", "aim", { mode: "hold-angle" },
		"2 eliminations · 12 alive · we lead 4-1 · " + pad("reloading behind cover", 140));
	turn("Objective status?", "", "Checking the objective.", "get_state", { fields: ["objective", "round"] },
		"objective: capture flag (60% ours) · round 6/13 · " + pad("enemy regrouping at C", 150));
	turn("Capture the flag and call it.", "Final push — capture and lock the round.",
		"Capturing the flag to close the round.", "move", { to: "flag", style: "rush" },
		"FLAG CAPTURED · round won · match 5-1 · MVP: HERMES · " + pad("ranked points +24", 180));

	App.EMBEDDED = L.map((o) => JSON.stringify(o)).join("\n");
})((window.App = window.App || {}));

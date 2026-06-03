/*
 * render.js — paints the store into the DOM. Pure view: reads the store,
 * writes HTML, and tags interactive elements with data-* for app.js to wire.
 */
(function (App) {
	"use strict";
	const U = App.util;

	const esc = (s) =>
		String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : String(n));
	const ROLE = {
		user: { icon: "◢", label: "you", cls: "role-user" },
		assistant: { icon: "✦", label: "agent", cls: "role-asst" },
		tool: { icon: "▣", label: "tool", cls: "role-tool" },
		system: { icon: "❖", label: "system", cls: "role-sys" },
	};

	function longText(text, cls) {
		const t = text || "";
		if (t.length <= 700) return `<pre class="${cls}">${esc(t)}</pre>`;
		return `<details class="more"><summary>${esc(t.slice(0, 280))} … <span class="moretag">show ${fmtTok(U.estTokens(t))} tok</span></summary><pre class="${cls}">${esc(t)}</pre></details>`;
	}

	function renderBlocks(messages, max) {
		max = max || 24;
		let html = "";
		const shown = messages.slice(0, max);
		for (const m of shown) {
			for (const b of m.blocks) {
				if (b.type === "text") {
					html += `<div class="blk text ${m.role === "user" ? "uin" : ""}">${longText(b.text, "ptext")}</div>`;
				} else if (b.type === "thinking") {
					html += `<details class="blk thinking"><summary>✷ thinking</summary><pre class="ptext">${esc(b.text)}</pre></details>`;
				} else if (b.type === "tool_call") {
					const args = esc(U.clip(JSON.stringify(b.args || {}), 240));
					html += `<div class="blk call"><span class="cname">⚙ ${esc(b.name)}</span><code class="cargs">${args}</code></div>`;
				} else if (b.type === "tool_result") {
					html += `<div class="blk result ${b.isError ? "err" : ""}"><div class="rhead">▣ ${esc(b.name)}${b.isError ? " · error" : ""}</div>${longText(b.text, "ptext")}</div>`;
				} else if (b.type === "note") {
					html += `<div class="blk note">${esc(b.text)}</div>`;
				}
			}
		}
		if (messages.length > max) {
			html += `<div class="blk note">… +${messages.length - max} more messages in this turn (a busy agent turn — fold it, or peek the full thing)</div>`;
		}
		return html;
	}

	function whoBadge(who) {
		if (!who) return "";
		return `<span class="who who-${who}">${who}</span>`;
	}

	function sectionCard(store, s) {
		const folded = s.state === "folded" && !s.pinned;
		const roles = [...new Set(s.messages.map((m) => m.role))];
		const model = (s.messages.find((m) => m.model) || {}).model || "";
		const stateBadge = s.pinned
			? `<span class="badge pin">📌 pinned</span>`
			: folded
				? `<span class="badge folded">folded ${whoBadge(s.by)}</span>`
				: `<span class="badge full">full ${s.by ? whoBadge(s.by) : ""}</span>`;
		const tok = folded ? U.digestTokens(s) : s.tokens;
		const body = folded
			? `<div class="digest">${esc(U.sectionDigest(s))}</div>`
			: `<div class="sbody">${renderBlocks(s.messages)}</div>`;
		const grouped = s.groupId ? ` grouped` : "";
		return `
<div class="section ${folded ? "is-folded" : "is-full"}${s.pinned ? " is-pinned" : ""}${grouped}" data-id="${s.id}">
  <div class="shead" data-act="toggle" data-id="${s.id}">
    <span class="idx">#${s.index}</span>
    <span class="roles">${roles.map((r) => { const rd = ROLE[r] || ROLE.system; return `<span class="${rd.cls}">${rd.icon}</span>`; }).join("")}</span>
    <span class="stitle" title="${esc(s.title)}">${esc(s.title)}</span>
    ${model ? `<span class="model">${esc(model)}</span>` : ""}
    <span class="tok">${fmtTok(tok)} tok</span>
    ${stateBadge}
    <span class="actions">
      ${folded ? `<button data-act="peek" data-id="${s.id}" title="Read it without changing the agent's context">peek</button>` : ""}
      <button data-act="${s.pinned ? "unpin" : "pin"}" data-id="${s.id}">${s.pinned ? "unpin" : "pin"}</button>
      <button data-act="toggle" data-id="${s.id}">${folded ? "unfold" : "fold"}</button>
    </span>
  </div>
  ${body}
</div>`;
	}

	function groupCard(store, g) {
		const secs = g.sectionIds.map((id) => store.get(id)).filter(Boolean);
		if (!secs.length) return "";
		const tok = store.groupDigestTokens(g);
		const span = `#${secs[0].index}–#${secs[secs.length - 1].index}`;
		return `
<div class="group" data-gid="${g.id}">
  <div class="ghead" data-act="toggleGroup" data-gid="${g.id}">
    <span class="gicon">🗂</span>
    <span class="gtitle">Folded group · ${secs.length} sections (${span})</span>
    <span class="tok">${fmtTok(tok)} tok</span>
    <span class="badge group">grouped ${whoBadge(g.by)}</span>
    <span class="actions"><button data-act="toggleGroup" data-gid="${g.id}">expand</button></span>
  </div>
  <div class="gsum">${secs.map((s) => `• ${esc(U.clip(U.sectionDigest(s), 90))}`).join("<br>")}</div>
</div>`;
	}

	App.render = function (store) {
		// stats + budget bar
		const total = store.totalTokens();
		const live = store.liveTokens();
		const win = store.windowBudget;
		const pct = win > 0 ? Math.min(100, (live / win) * 100) : 100;
		const over = live > win;
		const saved = total - live;
		const savedPct = total ? Math.round((saved / total) * 100) : 0;
		document.getElementById("budgetbar").innerHTML = `
      <div class="bb-row">
        <span class="bb-live ${over ? "over" : ""}">${fmtTok(live)}</span>
        <span class="bb-sep">live in context · window</span>
        <span class="bb-win">${fmtTok(win)}</span>
      </div>
      <div class="bb-track"><div class="bb-fill ${over ? "over" : ""}" style="width:${pct}%"></div></div>
      <div class="bb-meta">full session <b>${fmtTok(total)}</b> tok · accordion is saving <b>${fmtTok(saved)}</b> (${savedPct}%)${over ? ` · <span class="warn">over window — fold or run the Conductor</span>` : ""}</div>`;

		// sections (collapsed groups render once at their first member)
		const out = [];
		const done = new Set();
		for (const s of store.sections) {
			if (s.index > store.revealUpTo) continue; // replay reveal pointer
			const g = store.groupOf(s);
			if (g && g.collapsed) {
				if (!done.has(g.id)) { out.push(groupCard(store, g)); done.add(g.id); }
				continue;
			}
			out.push(sectionCard(store, s));
		}
		document.getElementById("sections").innerHTML = out.join("");

		// activity feed
		document.getElementById("events").innerHTML =
			store.events.length === 0
				? `<div class="ev empty">No moves yet. Try folding a section, or run the Conductor.</div>`
				: store.events
						.map((e) => `<div class="ev"><span class="dot who-${e.who}"></span><b>${e.who}</b> ${e.action} <span class="evd">${esc(e.detail || "")}</span></div>`)
						.join("");
	};

	App.peek = function (store, id) {
		const s = store.get(id);
		if (!s) return;
		const d = document.getElementById("drawer");
		d.innerHTML = `
      <div class="dhead">
        <div>
          <div class="dtitle">Peek · #${s.index}</div>
          <div class="dnote">Read-only — the agent's context is unchanged.</div>
        </div>
        <button id="drawerClose">close ✕</button>
      </div>
      <div class="dtitle2">${esc(s.title)}</div>
      <div class="dbody">${renderBlocks(s.messages, 200)}</div>`;
		d.classList.add("open");
		document.getElementById("drawerClose").onclick = () => d.classList.remove("open");
	};
})((window.App = window.App || {}));

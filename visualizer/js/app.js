/*
 * app.js — wiring: load sessions (drag/drop, picker, bundled samples), drive
 * the controls, and delegate clicks on the rendered cards to the store.
 */
(function (App) {
	"use strict";
	let store = null;
	let replayTimer = null;

	const $ = (id) => document.getElementById(id);
	const roundNice = (n) => Math.round(n / 1000) * 1000;
	function markActive(btn) {
		document.querySelectorAll(".sample-btn.active").forEach((b) => b.classList.remove("active"));
		if (btn) btn.classList.add("active");
	}

	function chooseWindow(total) {
		// a window that makes folding visible but keeps the recent tail full
		return Math.max(1500, Math.min(200000, roundNice(total * 0.4)));
	}

	function load(parsed) {
		stopReplay();
		store = new App.Store(parsed);
		store.onChange = () => App.render(store);
		store.windowBudget = chooseWindow(store.totalTokens());
		$("windowRange").max = String(Math.max(300000, store.totalTokens()));
		$("windowRange").value = String(store.windowBudget);
		syncWindowLabel();
		store.runConductor({ force: true }); // open in a realistic, fitted state
		App.render(store);
		$("sessionTitle").textContent = parsed.title || "session";
		$("sessionMeta").textContent =
			`${parsed.format.toUpperCase()} · ${store.sections.length} sections · ${parsed.messages.length} messages` +
			(parsed.cwd ? ` · ${parsed.cwd}` : "");
		$("dropHint").style.display = "none";
	}

	function loadRaw(raw, label) {
		try {
			load(App.parse(raw));
		} catch (e) {
			toast("Could not parse " + (label || "file") + ": " + e.message);
		}
	}

	function syncWindowLabel() {
		const v = +$("windowRange").value;
		$("windowVal").textContent = (v / 1000).toFixed(0) + "k";
	}

	// ---- sample discovery (works when served; silently skipped on file://) ---
	const CANDIDATES = [
		{ path: "samples/local/real-omp.jsonl", label: "★ real OMP session" },
		{ path: "samples/local/real-claude.jsonl", label: "★ real Claude Code session" },
		{ path: "samples/synthetic-arsenal.jsonl", label: "synthetic sample" },
	];

	async function discoverSamples() {
		const bar = $("samples");
		let firstLoaded = false;
		for (const c of CANDIDATES) {
			try {
				const res = await fetch(c.path, { cache: "no-store" });
				if (!res.ok) continue;
				const raw = await res.text();
				if (!raw.trim()) continue;
				const btn = document.createElement("button");
				btn.className = "sample-btn";
				btn.textContent = c.label;
				btn.onclick = () => { loadRaw(raw, c.label); markActive(btn); };
				bar.appendChild(btn);
				if (!firstLoaded) { loadRaw(raw, c.label); markActive(btn); firstLoaded = true; }
			} catch (_) { /* file:// or missing — ignore */ }
		}
		if (!firstLoaded) {
			// last resort: the small embedded sample so the page is never empty
			if (App.EMBEDDED) {
				const btn = document.createElement("button");
				btn.className = "sample-btn";
				btn.textContent = "embedded demo";
				btn.onclick = () => { loadRaw(App.EMBEDDED, "embedded"); markActive(btn); };
				bar.appendChild(btn);
				loadRaw(App.EMBEDDED, "embedded"); markActive(btn);
			}
		}
	}

	// ---- replay: watch the session grow and the Conductor keep it in budget --
	function stopReplay() {
		if (replayTimer) { clearInterval(replayTimer); replayTimer = null; $("replay").textContent = "▶ replay"; }
	}
	function startReplay() {
		if (!store) return;
		if (replayTimer) { stopReplay(); return; }
		if (store.sections.length <= 2) { toast("Replay needs a longer session."); return; }
		store.expandAll();
		store.revealUpTo = 1;
		$("replay").textContent = "⏸ pause";
		App.render(store);
		replayTimer = setInterval(() => {
			if (!store) return stopReplay();
			store.revealUpTo = (store.revealUpTo || 1) + 1;
			store.runConductor({ force: true });
			App.render(store);
			if (store.revealUpTo >= store.sections.length) stopReplay();
		}, 450);
	}

	// ---- control wiring -----------------------------------------------------
	function wire() {
		$("conductor").onclick = () => { if (store) store.runConductor(); };
		$("group").onclick = () => { if (store && !store.groupColdHistory("you")) toast("Need ≥2 leading folded sections to group."); };
		$("expandAll").onclick = () => { if (store) { store.revealUpTo = Infinity; store.expandAll(); } };
		$("foldCold").onclick = () => { if (store) store.foldAllCold(); };
		$("replay").onclick = startReplay;
		let winTimer = null;
		$("windowRange").oninput = () => {
			syncWindowLabel();
			if (!store) return;
			store.windowBudget = +$("windowRange").value;
			clearTimeout(winTimer);
			winTimer = setTimeout(() => { store.runConductor(); App.render(store); }, 70);
		};
		$("fileInput").onchange = (e) => {
			const f = e.target.files[0];
			if (!f) return;
			markActive(null);
			const r = new FileReader();
			r.onload = () => loadRaw(r.result, f.name);
			r.readAsText(f);
		};

		// drag & drop anywhere
		const body = document.body;
		["dragenter", "dragover"].forEach((ev) =>
			body.addEventListener(ev, (e) => { e.preventDefault(); body.classList.add("dragging"); }));
		body.addEventListener("dragleave", (e) => {
			if (!e.relatedTarget || !body.contains(e.relatedTarget)) body.classList.remove("dragging");
		});
		body.addEventListener("drop", (e) => {
			e.preventDefault();
			body.classList.remove("dragging");
			const f = e.dataTransfer.files[0];
			if (!f) return;
			markActive(null);
			const r = new FileReader();
			r.onload = () => loadRaw(r.result, f.name);
			r.readAsText(f);
		});

		// delegated clicks on cards
		document.addEventListener("click", (e) => {
			const el = e.target.closest("[data-act]");
			if (!el || !store) return;
			const act = el.dataset.act;
			const id = el.dataset.id;
			const gid = el.dataset.gid;
			if (act === "toggle") store.toggleFold(id, "you");
			else if (act === "pin") store.pin(id);
			else if (act === "unpin") store.unpin(id);
			else if (act === "peek") { e.stopPropagation(); App.peek(store, id); }
			else if (act === "toggleGroup") store.toggleGroup(gid);
		});
	}

	let toastTimer = null;
	function toast(msg) {
		const t = $("toast");
		t.textContent = msg; t.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
	}

	document.addEventListener("DOMContentLoaded", () => {
		wire();
		discoverSamples();
	});
})((window.App = window.App || {}));

import { DEFAULTS, TYPE_LABELS, loadJson, listDir, putJson, putPhoto, fmtDuration, fmtKm, fmtDay } from "./data.js?v=2026.11.16-2";
import { APP_VERSION } from "./version.js?v=2026.11.16-2";
import { figure } from "./figures.js?v=2026.11.16-2";
import { openStore, memoryStore, flush, isNetworkError, summarize as outboxSummary } from "./outbox.js?v=2026.11.16-2";
import { checkForUpdate, reloadUrl } from "./update.js?v=2026.11.16-2";
import {
  STATES, weekFor, matchWeek, evaluate, latestChoices, latestFeedback, pendingFeedback, daysUntil,
  spontaneousFor, inboxName, isoDate, minutesOf,
} from "./plan.js?v=2026.11.16-2";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const KEY_SETTINGS = "fh.settings";
const KEY_TOKEN = "fh.token";
const KEY_VIEW = "fh.view";
const KEY_THEME = "fh.theme";
const KEY_TICKS = "fh.ticks";

// ---------------------------------------------------------------- Speicher (kann fehlen oder werfen)
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* ignorieren */ } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignorieren */ } },
};
function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(store.get(KEY_SETTINGS) || "{}") }; } catch { return { ...DEFAULTS }; }
}
function getToken() { return store.get(KEY_TOKEN, sessionStorage) || store.get(KEY_TOKEN) || ""; }

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get(KEY_THEME));

// ---------------------------------------------------------------- Zustand
const state = {
  plan: null, workouts: [], strength: [], feedback: [], choices: [], photos: [], outbox: [], loaded: false,
  view: store.get(KEY_VIEW) || "heute", weekIndex: null, spontan: null,
};
const today = () => isoDate(new Date());

// ---------------------------------------------------------------- DOM-Helfer (nur textContent)
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "style") e.style.cssText = v; // CSSOM statt style-Attribut (CSP)
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const svgNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...children) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}
function btn(text, onclick, cls = "btn") { return el("button", { type: "button", class: cls, onclick }, text); }
function setStatus(msg, kind = "") { const s = $("#status"); s.textContent = msg; s.className = "status " + kind; }

// ---------------------------------------------------------------- Laden
async function loadAll() {
  const settings = getSettings();
  const token = getToken();
  if (!token) { openSettings(); setStatus("Bitte zuerst den GitHub-Token eintragen.", "warn"); render(); return; }
  setStatus("Lade …");
  const dir = settings.dataDir || "data";
  try {
    const [plan, wdoc, sdoc, fdoc, cdoc, fInbox, cInbox, pdoc, pInbox] = await Promise.all([
      loadJson(settings, `${dir}/plan.json`, token, null),
      loadJson(settings, `${dir}/workouts.json`, token, { workouts: [] }),
      loadJson(settings, `${dir}/strength.json`, token, { exercises: [] }),
      loadJson(settings, `${dir}/feedback.json`, token, { feedback: [] }),
      loadJson(settings, `${dir}/choices.json`, token, { choices: [] }),
      listDir(settings, "inbox/app/feedback", token),
      listDir(settings, "inbox/app/choices", token),
      loadJson(settings, `${dir}/photos.json`, token, { photos: [] }),
      listDir(settings, "inbox/app/photos", token),
    ]);
    // Noch nicht übernommene Einträge aus dem App-Eingang dazunehmen
    const pending = await Promise.all([...fInbox, ...cInbox].slice(0, 60).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.plan = plan;
    state.workouts = wdoc.workouts || [];
    state.strength = sdoc.exercises || [];
    state.feedback = [...(fdoc.feedback || []), ...pending.filter((x) => x && x.workout_id)];
    state.choices = [...(cdoc.choices || []), ...pending.filter((x) => x && x.block_id && x.substitute_id)];
    const pPending = await Promise.all(pInbox.slice(-20).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.photos = [...(pdoc.photos || []), ...pPending.filter((x) => x && x.file)];
    mergeOutbox();
    state.loaded = true;
    setStatus(plan ? "" : "Noch kein Trainingsplan im Daten-Repo (plan.json fehlt).", plan ? "" : "warn");
  } catch (e) {
    setStatus(e.message, "error");
  }
  render();
}

// ---------------------------------------------------------------- Ausgang (offline zwischenspeichern)
let outbox = memoryStore();
let flushing = false;
const UPLOAD_TIMEOUT_MS = 45 * 1000;
function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
const online = () => navigator.onLine !== false;

async function refreshOutbox() {
  try { state.outbox = await outbox.all(); } catch { state.outbox = []; }
  render();
}

/** Noch nicht hochgeladene Einträge in die Anzeige übernehmen (nach dem Laden aus dem Repo). */
function mergeOutbox() {
  for (const it of state.outbox || []) {
    if (it.kind !== "json") continue;
    if (it.path.startsWith("inbox/app/feedback/") && !state.feedback.some((f) => f.created_at === it.obj.created_at && f.workout_id === it.obj.workout_id)) state.feedback.push(it.obj);
    if (it.path.startsWith("inbox/app/choices/") && !state.choices.some((c) => c.created_at === it.obj.created_at && c.block_id === it.obj.block_id)) state.choices.push(it.obj);
    if (it.path.startsWith("inbox/app/photos/") && !state.photos.some((p) => p.file === it.obj.file)) state.photos.push(it.obj);
  }
}

function sendItem(item) {
  if (item.kind === "photo") return putPhoto(getSettings(), item.path, item.bytes, getToken(), item.message, timedFetch);
  return putJson(getSettings(), item.path, item.obj, getToken(), item.message, timedFetch);
}

async function queue(item) {
  await outbox.add({ ...item, created_at: new Date().toISOString() });
}

/** Speichern nach inbox/app/; ohne Empfang landet es im Ausgang. Liefert { queued }. */
async function save(path, obj, message, { later = false } = {}) {
  const item = { kind: "json", path, obj, message };
  if (!later) {
    try { await sendItem(item); return { queued: false }; } catch (e) { if (!isNetworkError(e, online())) throw e; }
  }
  await queue(item);
  await refreshOutbox();
  return { queued: true };
}

async function flushNow(manual = false) {
  if (flushing || !(state.outbox || []).length) return;
  if (!getToken()) return;
  flushing = true;
  if (manual) setStatus("Lade hoch …");
  try {
    const before = state.outbox.length;
    const r = await flush(outbox, sendItem, online());
    await refreshOutbox();
    if (r.sent && !r.left) setStatus(`Hochgeladen: ${before === 1 ? "1 Eintrag" : `${before} Einträge`}.`, "ok");
    else if (manual && r.error) setStatus(isNetworkError(r.error, online()) ? "Noch kein Empfang – bleibt auf dem Gerät und wird später hochgeladen." : r.error.message, isNetworkError(r.error, online()) ? "warn" : "error");
  } finally { flushing = false; }
}

/** Hinweis auf der Startseite: was liegt noch auf dem Gerät? */
function outboxCard() {
  const items = state.outbox || [];
  if (!items.length) return null;
  const errs = items.filter((i) => i.last_error);
  return el("section", { class: "card card-outbox", role: "status" },
    el("span", { class: "eyebrow", text: "Noch nicht hochgeladen" }),
    el("strong", { text: outboxSummary(items) }),
    el("span", { class: "muted small", text: outbox.persistent
      ? "Liegt sicher auf diesem Gerät und wird automatisch hochgeladen, sobald Empfang da ist."
      : "Nur bis zum Schließen der App gespeichert – bitte bald hochladen." }),
    errs.length ? el("span", { class: "small st-below", text: `Fehler: ${errs[0].last_error}` }) : null,
    btn("Jetzt hochladen", () => flushNow(true), "btn primary"));
}

// ---------------------------------------------------------------- Navigation
function show(view) {
  state.view = view;
  store.set(KEY_VIEW, view);
  for (const s of $$(".view")) s.hidden = s.id !== `view-${view}`;
  for (const b of $$(".nav-btn[data-view]")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  $("#view-title").textContent = $(`#view-${view}`).dataset.title;
  render();
}

function render() {
  const v = state.view;
  if (v === "heute") renderHeute();
  if (v === "training") renderTraining();
  if (v === "plan") renderPlan();
  if (v === "weg") renderWeg();
  if (v === "fortschritt") renderFortschritt();
  const g = state.plan?.goal;
  $("#side-countdown").textContent = g ? `${Math.max(0, daysUntil(g.date, today()))} Tage bis zum Schnee` : "";
}

// ---------------------------------------------------------------- Gemeinsame Bausteine
function currentWeek() {
  if (!state.plan) return null;
  const wf = weekFor(state.plan, today());
  if (state.weekIndex == null) state.weekIndex = state.plan.weeks.indexOf(wf.week);
  return wf;
}
function matched(week) {
  return matchWeek(week, state.workouts, latestChoices(state.choices), new Set(state.strength.map((e) => e.start_local.slice(0, 10))));
}
function fb() { return latestFeedback(state.feedback); }
function labels() { return state.plan?.effort_labels || ["locker", "machbar", "fordernd", "musste beißen", "zu viel"]; }

function workoutLine(w, parts = []) {
  const mins = minutesOf(w) + parts.reduce((a, o) => a + minutesOf(o), 0);
  const bits = [fmtDay(w.start_local), TYPE_LABELS[w.type] || w.type, `${mins} min`];
  if (w.distance_m && w.type !== "strength") bits.push(fmtKm(w.distance_m));
  if (parts.length) bits.push(`inkl. ${parts.map((o) => TYPE_LABELS[o.type] || o.type).join(", ")}`);
  return bits.join(" · ");
}

const STATE_CLASS = { [STATES.below]: "st-below", [STATES.in]: "st-in", [STATES.above]: "st-above" };
const STATE_ARROW = { [STATES.below]: " ↓", [STATES.in]: "", [STATES.above]: " ↑" };

function corridorRows(ev) {
  const grid = el("div", { class: "corr" },
    el("span"), el("div", { class: "corr-scale" }, el("span", { text: "schwächer" }), el("span", { text: "Ziel" }), el("span", { text: "besser" })), el("span"));
  for (const r of ev.rows) {
    const bar = svg("svg", { width: "100%", height: "18", viewBox: "0 0 140 18", preserveAspectRatio: "none", role: "img", "aria-label": `${r.label}: ${r.text}${r.state ? ", " + r.state : ""}` },
      svg("rect", { x: "0", y: "7", width: "140", height: "4", rx: "2", class: "corr-track" }),
      svg("rect", { x: "50", y: "5", width: "40", height: "8", rx: "4", class: "corr-band" }));
    if (r.pos != null) bar.append(svg("circle", { cx: String(Math.round(r.pos * 140)), cy: "9", r: "6", class: `corr-dot ${STATE_CLASS[r.state] || ""}` }));
    grid.append(
      el("span", { class: "corr-label" }, r.label, el("small", { text: r.text })),
      bar,
      el("span", { class: `corr-state ${STATE_CLASS[r.state] || "st-none"}`, text: r.state ? r.state + STATE_ARROW[r.state] : "–" }),
    );
  }
  return grid;
}

const SHORT = { kraft_a: "Kraft A", kraft_b: "Kraft B", lang: "Lang", frei: "Nach Wahl" };
function when(b) { return b.day ? `${fmtDay(b.day)} · ${b.slot}` : b.where; }
function byDay(blocks) { return [...blocks].sort((x, y) => (x.block.day || "9").localeCompare(y.block.day || "9")); }

/** Tagesleiste Mo–So mit geplanten Bausteinen und gesperrten Tagen. */
function dayStrip(week, m) {
  const t = today();
  const strip = el("div", { class: "daystrip", role: "list", "aria-label": "Wochenübersicht nach Tagen" });
  const start = new Date(week.start + "T00:00:00");
  const unavailable = Object.fromEntries((week.unavailable || []).map((u) => [u.date, u.text]));
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const iso = isoDate(d);
    const mb = m.blocks.find((x) => x.block.day === iso);
    const doneHere = m.blocks.find((x) => x.workout && x.workout.start_local.slice(0, 10) === iso);
    const lbl = fmtDay(iso);
    const target = mb || doneHere;
    const cls = "day" + (iso === t ? " today" : "") + (unavailable[iso] ? " off" : "");
    const cell = target
      ? el("button", { type: "button", class: cls + " day-link", role: "listitem", "aria-label": `${lbl}: ${target.block.title} – Details`, onclick: () => openDetail(target, week) })
      : el("div", { class: cls, role: "listitem" });
    cell.append(el("span", { class: "day-name", text: lbl.slice(0, 2) }), el("span", { class: "day-num", text: lbl.slice(3, 5) }));
    if (mb) {
      cell.append(el("span", { class: `day-block tag-${mb.status}`, text: SHORT[mb.block.kind] + (mb.status === "done" ? " ✓" : "") }));
    } else if (doneHere) {
      cell.append(el("span", { class: "day-block tag-done", text: SHORT[doneHere.block.kind] + " ✓" }));
    } else if (unavailable[iso]) {
      cell.append(el("span", { class: "day-off", text: unavailable[iso].split(" – ")[0] }));
    } else {
      cell.append(el("span", { class: "day-rest", text: "Pause" }));
    }
    strip.append(cell);
  }
  return strip;
}

function chip(text, cls = "") { return el("span", { class: "chip " + cls, text }); }

// ---------------------------------------------------------------- Heute
function renderHeute() {
  const root = $("#view-heute");
  root.replaceChildren();
  if (!state.loaded) { root.append(el("p", { class: "muted", text: "Noch keine Daten geladen." })); return; }
  if (!state.plan) { root.append(el("p", { class: "muted", text: "Sobald ein Trainingsplan im Daten-Repo liegt, erscheint er hier." })); return; }
  const wf = currentWeek();
  const m = matched(wf.week);
  const t = today();
  const fbm = fb();
  const colA = el("div", { class: "col" });
  const colB = el("div", { class: "col" });

  const days = daysUntil(state.plan.goal.date, t);
  root.append(el("p", { class: "dateline", text: new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }) }));

  const ob = outboxCard();
  if (ob) colA.append(ob);

  // Rückmeldungen
  for (const w of pendingFeedback(state.workouts, fbm, state.plan, t).slice(0, 3)) {
    colA.append(el("section", { class: "card card-accent" },
      el("span", { class: "eyebrow", text: "Neue Einheit" }),
      el("button", { type: "button", class: "card-link", onclick: () => openWorkout(w) }, el("strong", { text: workoutLine(w) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })),
      btn("Wie war's?", () => openFeedback(w), "btn primary")));
  }

  // Nächster Baustein
  const openByDay = byDay(m.blocks.filter((b) => b.status === "open"));
  const next = openByDay.find((b) => !b.block.day || b.block.day >= t) || openByDay[0];
  if (wf.before) {
    colA.append(el("section", { class: "card" }, el("span", { class: "eyebrow", text: "Bald geht's los" }),
      el("strong", { class: "big", text: `Woche 1 startet am ${fmtDay(wf.week.start)}` }),
      el("span", { class: "muted", text: wf.week.focus })));
  }
  if (next) {
    const b = next.block;
    colA.append(el("section", { class: "card card-next" },
      el("span", { class: "eyebrow", text: b.day === t ? "Heute geplant" : b.day && b.day < t ? "Noch offen" : wf.before ? "Erster Baustein" : "Nächster Baustein" }),
      el("button", { type: "button", class: "card-link", onclick: () => openDetail(next, wf.week) },
        el("strong", { class: "big", text: b.substitute ? `${b.title} → ${b.substitute.title}` : b.title }),
        el("span", { class: "chev", "aria-hidden": "true", text: "›" })),
      el("span", { class: "muted", text: `${b.minutes} min · ${when(b)}` }),
      el("span", { text: b.details }),
      el("div", { class: "row" }, btn(b.day === t ? "Zum Training" : "Details", () => b.day === t ? show("training") : openDetail(next, wf.week), "btn primary"),
        btn("Ersatz", () => openErsatz(b, wf.week)))));
  } else if (!wf.before) {
    colA.append(el("section", { class: "card" }, el("strong", { class: "big", text: "Alle Bausteine dieser Woche erledigt" })));
  }

  // Spontan
  const sp = el("section", { class: "card" }, el("strong", { text: "Spontan Zeit?" }));
  const row = el("div", { class: "row wrap" });
  for (const mins of [20, 30, 45, 60]) {
    row.append(el("button", { type: "button", class: "btn" + (state.spontan === mins ? " active" : ""), "aria-pressed": state.spontan === mins ? "true" : "false",
      onclick: () => { state.spontan = mins; renderHeute(); } }, `${mins} min`));
  }
  sp.append(row);
  if (state.spontan) {
    const s = spontaneousFor(state.plan, state.spontan, m);
    if (s) sp.append(el("p", {}, el("strong", { text: s.title }), ` – ${s.details}`));
  }
  colA.append(sp);

  // Woche
  const active = m.blocks.filter((b) => b.status !== "skipped");
  const done = active.filter((b) => b.status === "done").length;
  const pct = active.length ? Math.round((done / active.length) * 100) : 0;
  const wk = el("section", { class: "card" },
    el("div", { class: "row between" }, el("strong", { text: `Woche ${wf.week.week} · ${wf.week.focus}` }), el("span", { class: "accent-text", text: `${done} / ${active.length}` })),
    el("div", { class: "progress" }, el("div", { style: `width: ${pct}%` })));
  const list = el("ul", { class: "mini-list" });
  for (const b of byDay(m.blocks)) {
    list.append(el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openDetail(b, wf.week) },
      el("span", { text: `${b.block.day ? fmtDay(b.block.day).slice(0, 2) + " · " : ""}${b.block.title}` }),
      el("span", { class: `tag tag-${b.status}`, text: b.status === "done" ? "erledigt" : b.status === "skipped" ? "weggelassen" : "offen" }))));
  }
  wk.append(dayStrip(wf.week, m), list, btn("Zum Wochenplan", () => show("plan"), "btn link-btn"));
  colB.append(wk);

  // Ziel und Bereitschaft
  const r = state.plan.readiness;
  colB.append(el("section", { class: "card" },
    el("div", { class: "row wrap" }, chip(`${Math.max(0, days)} Tage bis zum Schnee`, "chip-dark")),
    el("ul", { class: "mini-list" }, ...(r?.items || []).map((i) => el("li", {}, el("span", { text: i.title }), el("strong", { text: `${i.percent} %` })))),
    el("span", { class: "muted small", text: `Schätzung vom ${fmtDay(r?.as_of)}` })));

  root.append(el("div", { class: "cols" }, colA, colB));
}

// ---------------------------------------------------------------- Plan
function renderPlan() {
  const root = $("#view-plan");
  root.replaceChildren();
  if (!state.plan) { root.append(el("p", { class: "muted", text: "Noch kein Trainingsplan." })); return; }
  currentWeek();
  const weeks = state.plan.weeks;
  const i = Math.min(Math.max(state.weekIndex, 0), weeks.length - 1);
  const week = weeks[i];
  const m = matched(week);
  const fbm = fb();

  root.append(el("div", { class: "weeknav" },
    el("button", { type: "button", class: "icon-btn", "aria-label": "Vorige Woche", disabled: i === 0, onclick: () => { state.weekIndex = i - 1; renderPlan(); } }, "‹"),
    el("div", { class: "weeknav-title" }, el("strong", { text: `Woche ${week.week} von ${weeks.length}` }),
      el("span", { class: "muted", text: `${fmtDay(week.start)} – ${fmtDay(week.end)} · ${week.focus}` })),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Nächste Woche", disabled: i === weeks.length - 1, onclick: () => { state.weekIndex = i + 1; renderPlan(); } }, "›")));
  root.append(el("section", { class: "card" }, dayStrip(week, m)));
  if (week.note) root.append(el("p", { class: "note", text: week.note }));

  const grid = el("div", { class: "cards" });
  for (const mb of byDay(m.blocks)) {
    const b = mb.block;
    const card = el("section", { class: `card block block-${mb.status}` });
    card.append(el("button", { type: "button", class: "card-link row between", onclick: () => openDetail(mb, week) },
      el("strong", { text: b.title }),
      el("span", { class: "row" }, el("span", { class: `tag tag-${mb.status}`, text: mb.status === "done" ? `erledigt ${fmtDay(mb.workout.start_local).slice(0, 2)}` : mb.status === "skipped" ? "weggelassen" : `${b.minutes} min` }),
        el("span", { class: "chev", "aria-hidden": "true", text: "›" }))));
    if (b.substitute && !b.skipped) card.append(el("span", { class: "muted", text: `Ersatz: ${b.substitute.title}` }));
    if (mb.status === "done") {
      card.append(el("span", { class: "muted", text: workoutLine(mb.workout, mb.parts) }));
      const ev = evaluate(mb, fbm[mb.workout.id], state.strength, labels());
      card.append(corridorRows(ev), el("p", { class: "advice", text: ev.advice }));
      if (!fbm[mb.workout.id]) card.append(btn("Rückmeldung geben", () => openFeedback(mb.workout), "btn primary"));
    } else if (mb.status === "open") {
      card.append(el("span", { class: "plan-day", text: when(b) }), el("span", { text: b.details }),
        el("div", { class: "row" }, btn("Übungen", () => openDetail(mb, week)), btn("Ersatz", () => openErsatz(b, week))));
    } else {
      card.append(el("span", { class: "muted", text: b.substitute?.effect || "" }),
        el("div", { class: "row" }, btn("Doch machen", () => chooseSubstitute(b, { id: "plan", title: "Wie geplant" }))));
    }
    grid.append(card);
  }
  root.append(grid);

  if (m.extra.length) {
    root.append(el("h2", { class: "section-title", text: "Zusätzlich" }),
      el("ul", { class: "plain-list" }, ...m.extra.map((w) => el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openWorkout(w) }, el("span", { text: workoutLine(w) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" }))))));
  }
  root.append(el("div", { class: "row adjust" },
    btn("Woche leichter", () => openRequest(week, "leichter")),
    btn("Woche fordernder", () => openRequest(week, "fordernder"))));
}

// ---------------------------------------------------------------- Weg (Vorschau, Ausbau in Stufe 4)
function renderWeg() {
  const root = $("#view-weg");
  root.replaceChildren();
  if (!state.plan) { root.append(el("p", { class: "muted", text: "Noch kein Trainingsplan." })); return; }
  const t = today();
  const r = state.plan.readiness;
  const ready = el("section", { class: "card" }, el("strong", { text: "Wie nah bist du dran?" }), el("span", { class: "muted small", text: `Schätzung vom ${fmtDay(r.as_of)}` }));
  for (const it of r.items) {
    ready.append(el("div", { class: "ready" },
      el("div", { class: "row between" }, el("span", { text: it.title }), el("strong", { text: `${it.percent} %` })),
      el("div", { class: "progress" }, el("div", { style: `width: ${it.percent}%` })),
      el("span", { class: "small" }, el("b", { text: "Dafür spricht: " }), it.pro),
      el("span", { class: "small" }, el("b", { text: "Es fehlt: " }), it.missing)));
  }
  const start = state.plan.weeks[0].start;
  const since = state.workouts.filter((w) => !w.duplicate_of && w.start_local.slice(0, 10) >= start);
  const longest = Math.max(0, ...since.filter((w) => w.type !== "strength").map(minutesOf));
  const leg = Math.max(0, ...state.strength.filter((e) => e.start_local.slice(0, 10) >= start && e.exercise === "leg_extension" && !e.is_test).map((e) => e.avg_weight_kg || 0));
  const tl = el("ol", { class: "timeline" });
  for (const ms of state.plan.milestones) {
    let done = false;
    if (ms.check?.longest_endurance_min) done = longest >= ms.check.longest_endurance_min;
    if (ms.check?.leg_extension_kg) done = leg >= ms.check.leg_extension_kg;
    if (ms.id === "urlaub") done = t >= ms.due;
    tl.append(el("li", { class: done ? "done" : "" }, el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { text: ms.title }), el("span", { class: "muted small", text: ms.due ? fmtDay(ms.due) : "Termin offen" })));
  }
  root.append(el("div", { class: "cols" },
    el("div", { class: "col" }, el("section", { class: "card card-dark" },
      el("strong", { class: "huge", text: String(Math.max(0, daysUntil(state.plan.goal.date, t))) }),
      el("span", { text: "Tage bis zum Schnee" }), el("span", { class: "small", text: state.plan.goal.title })), ready),
    el("div", { class: "col" }, el("section", { class: "card" }, el("strong", { text: "Meilensteine" }), tl))));
}

// ---------------------------------------------------------------- Fortschritt
function renderFortschritt() {
  const root = $("#view-fortschritt");
  root.replaceChildren();
  const ws = state.workouts.filter((w) => !w.duplicate_of);
  if (!ws.length) { root.append(el("p", { class: "muted", text: "Noch keine Einheiten." })); return; }
  // Stunden der letzten 8 Wochen (Mo–So)
  const now = new Date();
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const bars = [];
  for (let k = 7; k >= 0; k--) {
    const s = new Date(monday); s.setDate(s.getDate() - 7 * k);
    const e = new Date(s); e.setDate(e.getDate() + 7);
    const si = isoDate(s), ei = isoDate(e);
    const mins = ws.filter((w) => w.start_local.slice(0, 10) >= si && w.start_local.slice(0, 10) < ei).reduce((a, w) => a + minutesOf(w), 0);
    bars.push({ label: fmtDay(si).slice(3), h: mins / 60 });
  }
  const max = Math.max(4, ...bars.map((b) => b.h));
  const chart = el("div", { class: "bars", role: "img", "aria-label": "Trainingsstunden pro Woche, letzte 8 Wochen: " + bars.map((b) => b.h.toFixed(1).replace(".", ",") + " h").join(", ") });
  for (const b of bars) {
    chart.append(el("div", { class: "bar-col" }, el("span", { class: "bar-val", text: b.h ? b.h.toFixed(1).replace(".", ",") : "" }),
      el("div", { class: "chart-bar", style: `height: ${Math.round((b.h / max) * 120)}px` }), el("span", { class: "bar-lbl", text: b.label })));
  }
  const recent = [...ws].sort((a, b) => b.start_utc.localeCompare(a.start_utc)).slice(0, 15);
  root.append(el("div", { class: "cols" },
    el("div", { class: "col" }, el("section", { class: "card" }, el("div", { class: "row between" }, el("strong", { text: "Training pro Woche" }), el("span", { class: "muted small", text: "Stunden" })), chart)),
    el("div", { class: "col" }, el("section", { class: "card" }, el("strong", { text: "Letzte Einheiten" }),
      el("ul", { class: "plain-list" }, ...recent.map((w) => el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openWorkout(w) }, el("span", { text: workoutLine(w) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })))))))));
}

// ---------------------------------------------------------------- Training heute + Details
const fmtKg = (x) => `${String(x).replace(".", ",")} kg`;

function getTicks(key) {
  try {
    const all = JSON.parse(store.get(KEY_TICKS) || "{}");
    return new Set(all[key] || []);
  } catch { return new Set(); }
}
function toggleTick(key, i) {
  let all = {};
  try { all = JSON.parse(store.get(KEY_TICKS) || "{}"); } catch { /* neu */ }
  for (const k of Object.keys(all)) if (!k.startsWith(today())) delete all[k]; // nur heute merken
  const s = new Set(all[key] || []);
  if (s.has(i)) s.delete(i); else s.add(i);
  all[key] = [...s];
  store.set(KEY_TICKS, JSON.stringify(all));
}

function photosToday(match) {
  const t = today();
  return state.photos.filter((p) => (p.day || p.created_at.slice(0, 10)) === t && Object.entries(match).every(([k, v]) => p[k] === v));
}

/** Übungsliste mit Zeichnung je Übung; mit tickKey lassen sich Übungen abhaken (nur heute, nur auf diesem Gerät).
 *  Mit ctx (Baustein) gibt es je Übung einen Foto-Knopf. */
function exerciseList(ex, tickKey = null, ctx = null) {
  const ticks = tickKey ? getTicks(tickKey) : null;
  const ol = el("ol", { class: "ex-list" });
  ex.forEach((e, i) => {
    const dose = e.sets ? `${e.sets} × ${e.reps}` : e.dose || "";
    const bits = [dose];
    if (e.weight_kg != null) bits.push(fmtKg(e.weight_kg));
    if (e.rest_s) bits.push(`Pause ${e.rest_s} s`);
    const li = el("li", { class: "ex" + (ticks?.has(i) ? " ticked" : "") });
    if (ticks) {
      const cb = el("button", { type: "button", class: "tick", role: "checkbox", "aria-checked": ticks.has(i) ? "true" : "false", "aria-label": `${e.name} erledigt` }, "✓");
      cb.addEventListener("click", () => {
        toggleTick(tickKey, i);
        const on = li.classList.toggle("ticked");
        cb.setAttribute("aria-checked", on ? "true" : "false");
      });
      li.append(cb);
    } else {
      li.append(el("span", { class: "ex-num", "aria-hidden": "true", text: String(i + 1) }));
    }
    const body = el("div", { class: "ex-body" },
      el("strong", { class: "ex-name", text: e.name }),
      el("span", { class: "ex-dose", text: bits.filter(Boolean).join(" · ") }));
    if (e.last_kg != null && e.weight_kg != null && e.last_kg !== e.weight_kg) body.append(el("span", { class: "muted small", text: `vor Planbeginn ${fmtKg(e.last_kg)}` }));
    const fig = e.key ? figure(e.key) : null;
    if (fig || e.cue) body.append(el("div", { class: "ex-visual" }, fig, e.cue ? el("span", { class: "ex-cue", text: e.cue }) : null));
    if (e.guide) body.append(guideBox(e.guide));
    if (ctx && e.key) {
      const n = photosToday({ block_id: ctx.block_id, exercise: e.key }).length;
      body.append(el("div", { class: "row" }, btn(n ? `Foto · ${n} heute` : "Foto", () => pickPhoto({ ...ctx, exercise: e.key, exercise_name: e.name, label: `${ctx.label} · ${e.name}` }), "btn small-btn")));
    }
    li.append(body);
    ol.append(li);
  });
  return ol;
}

/** Aufklappbare Anleitung mit Ablauf, Fehlern, Varianten und Video-Links (nur https). */
function guideBox(g) {
  const d = el("details", { class: "guide" }, el("summary", { text: g.videos?.length ? "Anleitung & Video" : "Anleitung" }));
  const sec = (title, ...content) => d.append(el("div", { class: "guide-sec" }, el("strong", { text: title }), ...content));
  if (g.setup) sec("Ausgangsposition", el("p", { text: g.setup }));
  if (g.steps?.length) sec("Ablauf", el("ol", { class: "guide-steps" }, ...g.steps.map((s) => el("li", { text: s }))));
  if (g.breath) sec("Atmung", el("p", { text: g.breath }));
  if (g.mistakes?.length) sec("Typische Fehler", el("ul", { class: "guide-list" }, ...g.mistakes.map((s) => el("li", { text: s }))));
  if (g.easier || g.harder) sec("Anpassen", g.easier ? el("p", {}, el("b", { text: "Leichter: " }), g.easier) : null, g.harder ? el("p", {}, el("b", { text: "Schwerer: " }), g.harder) : null);
  if (g.knee) sec("Knie links", el("p", { text: g.knee }));
  const vids = (g.videos || []).filter((v) => /^https:\/\/[^\s"'<>]+$/.test(v.url || ""));
  if (vids.length) {
    sec("Video", el("ul", { class: "guide-links" }, ...vids.map((v) => el("li", {},
      el("a", { href: v.url, target: "_blank", rel: "noopener noreferrer", text: v.title }),
      v.source ? el("span", { class: "muted small", text: ` · ${v.source}` }) : null))));
  }
  return d;
}

/** Technogym-Übungen am Tag einer Einheit, mit Vergleich zum Zielgewicht. */
function strengthOn(w, targets = []) {
  const day = w.start_local.slice(0, 10);
  const rows = state.strength.filter((e) => e.start_local.slice(0, 10) === day).sort((a, b) => a.start_local.localeCompare(b.start_local));
  if (!rows.length) return null;
  const goal = Object.fromEntries(targets.filter((t) => t.device).map((t) => [t.device, t.weight_kg]));
  const ul = el("ul", { class: "mini-list" });
  for (const r of rows) {
    const g = goal[r.exercise];
    let mark = "";
    if (g != null && r.avg_weight_kg != null) mark = r.avg_weight_kg > g + 0.25 ? " ↑" : r.avg_weight_kg < g - 0.25 ? " ↓" : " ✓";
    ul.append(el("li", {}, el("span", { text: r.exercise_name || r.exercise }),
      el("span", { class: "muted", text: `${r.set_count || "–"} × ${r.set_count ? Math.round((r.reps_total || 0) / r.set_count) : "–"}${r.avg_weight_kg != null ? " · " + fmtKg(r.avg_weight_kg) : ""}${r.is_test ? " · Test" : ""}${mark}` })));
  }
  return ul;
}

function statusText(mb) {
  return mb.status === "done" ? "erledigt" : mb.status === "skipped" ? "weggelassen" : "offen";
}

/** Inhalt der Detailansicht eines Bausteins (im Sheet oder im Reiter Training). */
function blockDetail(mb, week, inline = false) {
  const b = mb.block;
  const sub = b.substitute && !b.skipped ? b.substitute : null;
  const wrap = el("div", { class: "detail" });
  wrap.append(el("div", { class: "row wrap" },
    b.day ? chip(when(b)) : null, chip(`${b.minutes} min`), chip(statusText(mb), `tag-${mb.status}`)));
  if (b.where) wrap.append(el("span", { class: "muted", text: b.where }));
  if (sub) wrap.append(el("p", { class: "note", text: `Ersatz gewählt: ${sub.title} – ${sub.effect}` }));
  if (b.skipped) wrap.append(el("p", { class: "note", text: `Diese Woche weggelassen – ${b.substitute?.effect || ""}` }));
  const ex = sub ? sub.exercises : b.exercises;
  if (ex?.length && !b.skipped) {
    const strength = b.kind.startsWith("kraft") || !!sub?.exercises;
    wrap.append(el("h3", { class: "detail-h", text: strength ? "Übungen" : "Ablauf" }));
    if (inline && mb.status !== "skipped") wrap.append(el("span", { class: "muted small", text: "Antippen zum Abhaken." }));
    wrap.append(exerciseList(ex, inline && mb.status !== "skipped" ? `${today()}|${b.id}` : null,
      mb.status !== "skipped" ? { block_id: b.id, workout_id: mb.workout?.id, label: b.title } : null));
  } else if (!b.skipped) {
    wrap.append(el("p", { text: sub ? sub.effect : b.details }));
  }
  if (b.notes && !sub && !b.skipped) wrap.append(el("p", { class: "muted small", text: b.notes }));
  const actions = el("div", { class: "row wrap" });
  if (mb.status === "done") {
    const fbm = fb();
    const ev = evaluate(mb, fbm[mb.workout.id], state.strength, labels());
    wrap.append(el("h3", { class: "detail-h", text: "So lief es" }),
      el("button", { type: "button", class: "list-link", onclick: () => openWorkout(mb.workout) }, el("span", { text: workoutLine(mb.workout, mb.parts) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })),
      corridorRows(ev), el("p", { class: "advice", text: ev.advice }));
    const done = strengthOn(mb.workout, b.exercises || []);
    if (done) wrap.append(el("span", { class: "small", text: "Am Gerät (↑ über, ✓ im, ↓ unter Zielgewicht):" }), done);
    if (!fbm[mb.workout.id]) actions.append(btn("Rückmeldung geben", () => openFeedback(mb.workout), "btn primary"));
  } else if (mb.status === "open") {
    actions.append(btn("Ersatz", () => openErsatz(b, week)));
  } else {
    actions.append(btn("Doch machen", () => chooseSubstitute(b, { id: "plan", title: "Wie geplant" })));
  }
  if (mb.status !== "skipped") actions.append(btn("Fotos zur Einheit", () => pickPhoto({ block_id: b.id, workout_id: mb.workout?.id, label: b.title })));
  wrap.append(actions);
  return wrap;
}

function openDetail(mb, week) {
  openSheet(mb.block.title, blockDetail(mb, week));
}

/** Details zu einer erledigten Einheit (aus Strava/Technogym). */
function openWorkout(w) {
  const tiles = el("div", { class: "tiles" });
  const tile = (label, value) => { if (value) tiles.append(el("div", { class: "tile" }, el("span", { class: "muted small", text: label }), el("strong", { text: value }))); };
  tile("Dauer", fmtDuration(w.moving_s || w.duration_s));
  if (w.distance_m && w.type !== "strength") tile("Strecke", fmtKm(w.distance_m));
  if (w.type === "run" && w.distance_m && (w.moving_s || w.duration_s)) {
    const sPerKm = (w.moving_s || w.duration_s) / (w.distance_m / 1000);
    tile("Tempo", `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, "0")} /km`);
  }
  if (w.hr_avg) tile("Puls Ø", `${Math.round(w.hr_avg)}`);
  if (w.hr_max) tile("Puls max", `${Math.round(w.hr_max)}`);
  if (w.elevation_gain_m) tile("Höhenmeter", `${Math.round(w.elevation_gain_m)} m`);
  const body = el("div", { class: "sheet-content" }, el("p", { class: "muted", text: workoutLine(w) }), tiles);
  // Zu welchem Baustein zählt die Einheit?
  if (state.plan) {
    const wk = state.plan.weeks.find((x) => w.start_local.slice(0, 10) >= x.start && w.start_local.slice(0, 10) <= x.end);
    const mb = wk && matched(wk).blocks.find((x) => x.workout?.id === w.id);
    if (mb) body.append(el("button", { type: "button", class: "list-link", onclick: () => openDetail(mb, wk) },
      el("span", { text: `Zählt als: ${mb.block.title}` }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })));
  }
  const s = strengthOn(w);
  if (s && (w.type === "strength" || (w.source === "technogym"))) body.append(el("strong", { text: "Übungen am Gerät" }), s);
  const f = fb()[w.id];
  if (f) body.append(el("p", { class: "small", text: `Gefühl: ${labels()[f.effort - 1]}${f.knee != null ? ` · Knie: ${(state.plan?.knee_labels || [])[f.knee] || f.knee}` : ""}${f.note ? ` · ${f.note}` : ""}` }));
  body.append(el("div", { class: "row wrap" },
    f ? null : btn("Rückmeldung geben", () => openFeedback(w), "btn primary"),
    btn("Fotos zur Einheit", () => pickPhoto({ workout_id: w.id, label: workoutLine(w) }))));
  openSheet(TYPE_LABELS[w.type] || w.type, body);
}

/** Was steht heute an? Heute geplante oder heute erledigte Bausteine, sonst der nächste offene. */
function trainingToday() {
  const wf = currentWeek();
  const m = matched(wf.week);
  const t = today();
  const todays = byDay(m.blocks.filter((b) => b.block.day === t || b.workout?.start_local.slice(0, 10) === t));
  if (todays.length) return { list: todays, week: wf.week, kind: "heute" };
  const open = byDay(m.blocks.filter((b) => b.status === "open"));
  const next = open.find((b) => !b.block.day || b.block.day >= t) || open[0];
  return { list: next ? [next] : [], week: wf.week, kind: "naechste" };
}

function renderTraining() {
  const root = $("#view-training");
  root.replaceChildren();
  if (!state.loaded) { root.append(el("p", { class: "muted", text: "Noch keine Daten geladen." })); return; }
  if (!state.plan) { root.append(el("p", { class: "muted", text: "Noch kein Trainingsplan." })); return; }
  const { list, week, kind } = trainingToday();
  root.append(el("p", { class: "dateline", text: new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }) }));
  const colA = el("div", { class: "col" });
  const colB = el("div", { class: "col" });
  if (kind === "naechste") colA.append(el("p", { class: "note", text: list.length ? "Heute ist kein Training geplant. Als Nächstes:" : "Diese Woche ist alles erledigt." }));
  for (const mb of list) {
    const b = mb.block;
    colA.append(el("section", { class: "card card-next" },
      el("span", { class: "eyebrow", text: mb.status === "done" ? "Heute erledigt" : kind === "heute" ? "Heute" : "Nächste Einheit" }),
      el("strong", { class: "big", text: b.substitute && !b.skipped ? `${b.title} → ${b.substitute.title}` : b.title }),
      blockDetail(mb, week, kind === "heute")));
  }
  const ob = outboxCard();
  if (ob) colB.append(ob);
  const t = today();
  const shots = state.photos.filter((p) => (p.day || p.created_at.slice(0, 10)) === t);
  colB.append(el("section", { class: "card" },
    el("strong", { text: "Gerätebildschirm fotografieren" }),
    el("span", { class: "muted", text: "Zu einer Übung: Knopf „Foto“ bei der Übung. Für die ganze Einheit: hier – auch mehrere Bilder auf einmal. Claude liest die Werte aus und übernimmt sie." }),
    btn("Fotos aufnehmen", () => pickPhoto({ block_id: list[0]?.block.id, label: list[0]?.block.title || "Training" }), "btn primary"),
    el("span", { class: "muted small", text: shots.length ? `Heute ${shots.length} ${shots.length === 1 ? "Foto" : "Fotos"} gespeichert` : "Heute noch keine Fotos" })));
  colB.append(el("section", { class: "card" }, el("strong", { text: "Diese Woche" }), dayStrip(week, matched(week))));
  root.append(el("div", { class: "cols" }, colA, colB));
}

// ---------------------------------------------------------------- Foto vom Gerätebildschirm
function pickPhoto(ctx) {
  // ohne capture: iPhone bietet Kamera, Fotomediathek oder Datei an
  const input = el("input", { type: "file", accept: "image/*", multiple: true, class: "visually-hidden", "aria-hidden": "true", tabindex: "-1" });
  input.addEventListener("change", () => {
    const files = [...(input.files || [])].slice(0, MAX_PHOTOS);
    input.remove();
    if (files.length) openPhoto(files, ctx);
  });
  document.body.append(input);
  input.click();
}

async function shrink(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { bmp = await createImageBitmap(file); }
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c; // Neu gezeichnet: keine EXIF-/Ortsdaten mehr
}

const MAX_PHOTOS = 10;

async function openPhoto(files, ctx) {
  const canvases = [];
  for (const f of files) {
    try { canvases.push(await shrink(f)); } catch { /* unlesbares Bild überspringen */ }
  }
  if (!canvases.length) {
    openSheet("Foto vom Gerät", el("p", { text: "Das Bild konnte nicht gelesen werden." }));
    return;
  }
  canvases.forEach((c, i) => {
    c.className = "photo-preview";
    c.setAttribute("role", "img");
    c.setAttribute("aria-label", `Vorschau Foto ${i + 1}`);
  });
  const note = el("input", { type: "text", id: "photo-note", maxlength: "200", placeholder: "z. B. Beinstrecker, 3. Satz" });
  const n = canvases.length;
  const up = btn(n === 1 ? "Hochladen" : `${n} Fotos hochladen`, null, "btn primary full");
  const laterBtn = btn("Erst mal behalten, später hochladen", null, "btn full");
  let done = 0, queued = 0;
  const run = async (later) => {
    up.disabled = true; laterBtn.disabled = true;
    try {
      for (; done < n; done++) {
        sheetStatus(later ? "Speichere auf dem Gerät …" : n === 1 ? "Lade hoch …" : `Lade Foto ${done + 1} von ${n} hoch …`);
        const c = canvases[done];
        const blob = await new Promise((res, rej) => c.toBlob((x) => (x ? res(x) : rej(new Error("Bild konnte nicht erzeugt werden"))), "image/jpeg", 0.82));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const id = [ctx.block_id || ctx.workout_id || "foto", ctx.exercise, n > 1 ? done + 1 : null].filter(Boolean).join("_");
        const base = inboxName("inbox/app/photos", id).replace(/\.json$/, "");
        const meta = { file: `${base}.jpg`, block_id: ctx.block_id || null, workout_id: ctx.workout_id || null,
          exercise: ctx.exercise || null, exercise_name: ctx.exercise_name || null, day: today(),
          note: note.value.trim() || null, created_at: new Date().toISOString(), source: "app" };
        const photoItem = { kind: "photo", path: `${base}.jpg`, bytes, message: `App: Foto ${id}` };
        let toQueue = later;
        if (!later) {
          try { await sendItem(photoItem); } catch (e) {
            if (!isNetworkError(e, online())) throw e;
            toQueue = later = true; // kein Empfang: diesen und alle weiteren auf dem Gerät behalten
          }
        }
        if (toQueue) {
          await queue(photoItem);
          await queue({ kind: "json", path: `${base}.json`, obj: meta, message: "App: Foto-Info" });
          queued++;
        } else {
          const r = await save(`${base}.json`, meta, "App: Foto-Info");
          if (r.queued) queued++;
        }
        state.photos.push(meta);
      }
      await refreshOutbox();
      const what = n === 1 ? "Foto" : `${n} Fotos`;
      $("#sheet-body").replaceChildren(el("div", { class: "sheet-content" },
        el("p", { text: queued
          ? `${what} auf dem Gerät gespeichert. Hochgeladen wird automatisch, sobald Empfang da ist – oder auf der Startseite mit „Jetzt hochladen“.`
          : `${what} hochgeladen. Claude liest sie beim nächsten Abgleich aus und übernimmt die Werte.` }),
        btn("Weitere Fotos", () => pickPhoto(ctx), "btn")));
      sheetStatus(queued ? "Auf dem Gerät gespeichert." : "Gespeichert.", queued ? "warn" : "ok");
      render();
    } catch (e) { sheetStatus(`${e.message}${done ? ` – ${done} von ${n} gespeichert` : ""}`, "error"); up.disabled = false; laterBtn.disabled = false; }
  };
  up.addEventListener("click", () => run(false));
  laterBtn.addEventListener("click", () => run(true));
  openSheet(n === 1 ? "Foto vom Gerät" : `${n} Fotos vom Gerät`, el("div", { class: "sheet-content" },
    ctx.label ? el("p", { class: "muted", text: ctx.label }) : null,
    el("div", { class: n > 1 ? "photo-grid" : "" }, ...canvases), el("label", { class: "field" }, "Notiz (optional, gilt für alle)", note), up, laterBtn,
    el("span", { class: "muted small", text: "Wird verkleinert und ohne Ortsdaten nur in dein privates Daten-Repo geschrieben." })));
}

// ---------------------------------------------------------------- Sheets (Rückmeldung, Ersatz, Anpassung)
function openSheet(title, body) {
  $("#sheet-title").textContent = title;
  $("#sheet-body").replaceChildren(body);
  $("#sheet-status").textContent = "";
  $("#sheet-status").className = "status";
  $("#sheet").showModal();
}
function sheetStatus(msg, kind = "") { const s = $("#sheet-status"); s.textContent = msg; s.className = "status " + kind; }

function choiceGroup(name, options, selected, onPick) {
  const g = el("div", { class: "choices", role: "radiogroup", "aria-label": name });
  options.forEach((label, idx) => {
    g.append(el("button", { type: "button", role: "radio", class: "btn choice" + (selected === idx ? " active" : ""),
      "aria-checked": selected === idx ? "true" : "false", onclick: () => onPick(idx) }, label));
  });
  return g;
}

function openFeedback(w) {
  let effort = null, knee = null;
  const knees = state.plan?.knee_labels || ["ruhig", "leicht", "deutlich", "stark"];
  const note = el("input", { type: "text", id: "fb-note", placeholder: "z. B. Gegenwind, schlecht geschlafen", maxlength: "200" });
  const saveBtn = btn("Speichern", null, "btn primary full");
  const body = el("div", { class: "sheet-content" });
  const draw = () => {
    body.replaceChildren(
      el("p", { class: "muted", text: workoutLine(w) }),
      el("strong", { text: "Wie war's?" }),
      choiceGroup("Gefühlte Belastung", labels(), effort == null ? null : effort - 1, (i) => { effort = i + 1; draw(); }),
      el("strong", { text: "Knie links" }),
      choiceGroup("Knie links", knees, knee, (i) => { knee = i; draw(); }),
      el("label", { class: "field" }, "Notiz (optional)", note),
      saveBtn,
      el("span", { class: "muted small", text: "Wird nur in dein privates Daten-Repo geschrieben." }));
    saveBtn.disabled = effort == null;
  };
  saveBtn.addEventListener("click", async () => {
    if (effort == null) return;
    const item = { workout_id: w.id, effort, knee, note: note.value.trim() || null, created_at: new Date().toISOString(), source: "app" };
    saveBtn.disabled = true;
    sheetStatus("Speichere …");
    try {
      await save(inboxName("inbox/app/feedback", w.id), item, `App: Rückmeldung ${w.start_local.slice(0, 10)} ${TYPE_LABELS[w.type] || w.type}`);
      state.feedback.push(item);
      $("#sheet").close();
      render();
    } catch (e) { sheetStatus(e.message, "error"); saveBtn.disabled = false; }
  });
  draw();
  openSheet("Rückmeldung", body);
}

function openErsatz(block, week) {
  const body = el("div", { class: "sheet-content" }, el("p", { class: "muted", text: `${block.title} · ${block.minutes} min · Woche ${week.week}` }));
  const opts = [...block.substitutes];
  if (block.substitute) opts.unshift({ id: "plan", title: "Wie geplant", effect: "Ersatz zurücknehmen", minutes: block.minutes });
  for (const s of opts) {
    body.append(el("button", { type: "button", class: "option" + (s.recommended ? " recommended" : ""), onclick: () => chooseSubstitute(block, s) },
      el("strong", { text: s.title }), el("span", { text: s.effect + (s.recommended ? " · Empfohlen" : "") })));
  }
  openSheet("Ersatz wählen", body);
}

async function chooseSubstitute(block, sub) {
  const item = { block_id: block.id, substitute_id: sub.id, created_at: new Date().toISOString(), source: "app" };
  const dlg = $("#sheet");
  try {
    if (!dlg.open) openSheet("Ersatz", el("p", { text: "Speichere …" }));
    sheetStatus("Speichere …");
    await save(inboxName("inbox/app/choices", block.id), item, `App: Ersatz ${block.id} → ${sub.id}`);
    state.choices.push(item);
    dlg.close();
    render();
  } catch (e) { sheetStatus(e.message, "error"); }
}

function openRequest(week, request) {
  const go = btn(request === "leichter" ? "Ja, leichter machen" : "Ja, fordernder machen", null, "btn primary full");
  go.addEventListener("click", async () => {
    go.disabled = true;
    sheetStatus("Speichere …");
    try {
      const r = await save(inboxName("inbox/app/requests", `w${week.week}-${request}`),
        { week: week.week, request, created_at: new Date().toISOString(), source: "app" },
        `App: Woche ${week.week} ${request}`);
      $("#sheet-body").replaceChildren(el("p", { text: (r.queued ? "Wunsch auf dem Gerät gespeichert, wird hochgeladen, sobald Empfang da ist. " : "Wunsch gespeichert. ") + "Claude passt den Plan beim nächsten Abgleich an – du siehst die Änderung dann hier." }));
      sheetStatus("Gespeichert.", "ok");
    } catch (e) { sheetStatus(e.message, "error"); go.disabled = false; }
  });
  openSheet(`Woche ${week.week} ${request}`, el("div", { class: "sheet-content" },
    el("p", { text: request === "leichter"
      ? "Die restlichen Bausteine dieser Woche werden spürbar kürzer oder ruhiger, die Ziele verschieben sich etwas."
      : "Die restlichen Bausteine werden länger oder intensiver – nur wenn du dich frisch fühlst und das Knie ruhig ist." }),
    go));
}

// ---------------------------------------------------------------- Einstellungen
function openSettings() {
  const s = getSettings();
  $("#f-repo").value = s.repo;
  $("#f-branch").value = s.branch;
  $("#f-dir").value = s.dataDir || "data";
  $("#f-token").value = getToken();
  $("#f-remember").checked = !!store.get(KEY_TOKEN);
  $("#f-theme").value = store.get(KEY_THEME) || "auto";
  $("#settings").showModal();
}
function saveSettings(ev) {
  ev.preventDefault();
  store.set(KEY_SETTINGS, JSON.stringify({ repo: $("#f-repo").value.trim(), branch: $("#f-branch").value.trim(), dataDir: $("#f-dir").value.trim().replace(/\/+$/, "") }));
  const token = $("#f-token").value.trim();
  store.del(KEY_TOKEN);
  if (token) store.set(KEY_TOKEN, token, $("#f-remember").checked ? localStorage : sessionStorage);
  store.set(KEY_THEME, $("#f-theme").value);
  applyTheme($("#f-theme").value);
  $("#settings").close();
  loadAll();
}

// ---------------------------------------------------------------- Update-Prüfung
const UPDATE_INTERVAL_MS = 15 * 60 * 1000;
let pendingUpdate = null;
let lastCheck = 0;
async function runUpdateCheck(manual = false) {
  lastCheck = Date.now();
  try {
    const found = await checkForUpdate(APP_VERSION);
    if (found) {
      pendingUpdate = found;
      $("#update-notes").textContent = found.notes ? ` – ${found.notes}` : ` (${found.version})`;
      $("#update-banner").hidden = false;
    } else if (manual) setStatus(`App ist aktuell (Version ${APP_VERSION}).`, "ok");
  } catch (e) {
    if (manual) setStatus(`Update-Prüfung fehlgeschlagen: ${e.message}`, "error");
  }
}
function startUpdateChecks() {
  $("#app-version").textContent = APP_VERSION;
  $("#btn-update").addEventListener("click", () => { if (pendingUpdate) location.replace(reloadUrl(location.href, pendingUpdate.version)); });
  $("#btn-check-update").addEventListener("click", () => runUpdateCheck(true));
  runUpdateCheck();
  setInterval(() => runUpdateCheck(), UPDATE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheck > 60 * 1000) runUpdateCheck();
  });
}

// ---------------------------------------------------------------- Start
document.addEventListener("DOMContentLoaded", () => {
  startUpdateChecks();
  openStore().then(async (s) => { outbox = s; await refreshOutbox(); mergeOutbox(); flushNow(); });
  window.addEventListener("online", () => flushNow());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushNow(); });
  setInterval(() => flushNow(), 2 * 60 * 1000);
  for (const b of $$(".nav-btn[data-view]")) b.addEventListener("click", () => show(b.dataset.view));
  $("#btn-load").addEventListener("click", loadAll);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-side").addEventListener("click", openSettings);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#btn-cancel").addEventListener("click", () => $("#settings").close());
  $("#btn-forget").addEventListener("click", () => { store.del(KEY_TOKEN); $("#f-token").value = ""; setStatus("Token auf diesem Gerät gelöscht.", "ok"); });
  $("#sheet-close").addEventListener("click", () => $("#sheet").close());
  show(["heute", "plan", "weg", "fortschritt"].includes(state.view) ? state.view : "heute");
  loadAll();
});

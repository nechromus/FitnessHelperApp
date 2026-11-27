import { DEFAULTS, TYPE_LABELS, loadJson, listDir, putJson, putPhoto, fmtDuration, fmtKm, fmtDay } from "./data.js?v=2026.11.27-1";
import { APP_VERSION } from "./version.js?v=2026.11.27-1";
import { figure } from "./figures.js?v=2026.11.27-1";
import { openStore, memoryStore, flush, isNetworkError, summarize as outboxSummary } from "./outbox.js?v=2026.11.27-1";
import { checkForUpdate, reloadUrl } from "./update.js?v=2026.11.27-1";
import {
  STATES, weekFor, matchWeek, evaluate, latestChoices, latestAssignments, latestFeedback, pendingFeedback, daysUntil,
  spontaneousFor, inboxName, isoDate, minutesOf, loadOf, totalMinutes, warmupsFor, warmupIds, segmentsFor, continuationIds,
  latestMoves, applyMoves, moveTargets,
} from "./plan.js?v=2026.11.27-1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const KEY_SETTINGS = "fh.settings";
const KEY_TOKEN = "fh.token";
const KEY_VIEW = "fh.view";
const KEY_THEME = "fh.theme";
const KEY_TICKS = "fh.ticks";
const KEY_PICK = "fh.pick";
const KEY_SEEN_REPORT = "fh.seenReport";

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
  plan: null, planRaw: null, moves: [], workouts: [], strength: [], feedback: [], choices: [], photos: [], outbox: [], assignments: [], readiness: null, coach: [], loaded: false,
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
    const [plan, wdoc, sdoc, fdoc, cdoc, fInbox, cInbox, pdoc, pInbox, rdoc, coachDoc, adoc, aInbox, mInbox, mvdoc, mvInbox] = await Promise.all([
      loadJson(settings, `${dir}/plan.json`, token, null),
      loadJson(settings, `${dir}/workouts.json`, token, { workouts: [] }),
      loadJson(settings, `${dir}/strength.json`, token, { exercises: [] }),
      loadJson(settings, `${dir}/feedback.json`, token, { feedback: [] }),
      loadJson(settings, `${dir}/choices.json`, token, { choices: [] }),
      listDir(settings, "inbox/app/feedback", token),
      listDir(settings, "inbox/app/choices", token),
      loadJson(settings, `${dir}/photos.json`, token, { photos: [] }),
      listDir(settings, "inbox/app/photos", token),
      loadJson(settings, `${dir}/readiness.json`, token, null),
      loadJson(settings, `${dir}/coach.json`, token, { notes: [] }),
      loadJson(settings, `${dir}/assignments.json`, token, { assignments: [] }),
      listDir(settings, "inbox/app/assign", token),
      listDir(settings, "inbox/app/manual", token),
      loadJson(settings, `${dir}/moves.json`, token, { moves: [] }),
      listDir(settings, "inbox/app/moves", token),
    ]);
    // Noch nicht übernommene Einträge aus dem App-Eingang dazunehmen
    const pending = await Promise.all([...fInbox, ...cInbox].slice(0, 60).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.planRaw = plan;
    state.readiness = rdoc;
    state.coach = coachDoc.notes || [];
    state.workouts = wdoc.workouts || [];
    state.strength = sdoc.exercises || [];
    state.feedback = [...(fdoc.feedback || []), ...pending.filter((x) => x && x.workout_id)];
    state.choices = [...(cdoc.choices || []), ...pending.filter((x) => x && x.block_id && x.substitute_id)];
    const pPending = await Promise.all(pInbox.slice(-20).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.photos = [...(pdoc.photos || []), ...pPending.filter((x) => x && x.file)];
    const aPending = await Promise.all(aInbox.slice(-30).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.assignments = [...(adoc.assignments || []), ...aPending.filter((x) => x && x.workout_id && x.block_id)];
    const mPending = await Promise.all(mInbox.slice(-30).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    for (const w of mPending) if (w && w.id && !state.workouts.some((x) => x.id === w.id)) state.workouts.push({ ...w, source: "app" });
    const mvPending = await Promise.all(mvInbox.slice(-30).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.moves = [...(mvdoc.moves || []), ...mvPending.filter((x) => x && x.block_id && x.day)];
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
    if (it.path.startsWith("inbox/app/assign/") && !state.assignments.some((x) => x.created_at === it.obj.created_at && x.workout_id === it.obj.workout_id)) state.assignments.push(it.obj);
    if (it.path.startsWith("inbox/app/manual/") && !state.workouts.some((x) => x.id === it.obj.id)) state.workouts.push({ ...it.obj, source: "app" });
    if (it.path.startsWith("inbox/app/moves/") && !state.moves.some((x) => x.created_at === it.obj.created_at && x.block_id === it.obj.block_id)) state.moves.push(it.obj);
  }
  refreshPlan();
}

/** Plan mit den verschobenen Tagen (aus der App) – alle Ansichten nutzen state.plan. */
function refreshPlan() { state.plan = applyMoves(state.planRaw, latestMoves(state.moves)); }

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
function studioDays() { return new Set(state.strength.map((e) => e.start_local.slice(0, 10))); }
/** Einheiten, die nur Teil einer anderen sind (Rad-Aufwärmen, Folgeteile) – nicht einzeln aufführen. */
function warmups() { const s = warmupIds(state.workouts, studioDays()); for (const id of continuationIds(state.workouts)) s.add(id); return s; }
function partsOf(w) { return w.type === "strength" ? warmupsFor(w, state.workouts, studioDays()) : segmentsFor(w, state.workouts); }
function matched(week) {
  const m = matchWeek(week, state.workouts, latestChoices(state.choices), studioDays(),
    latestAssignments(state.assignments.map((a) => ({ ...a, workout_id: primaryId(a.workout_id) }))));
  const bf = blockFb();
  // Selbst als fertig gemeldet, Einheit aus Strava/Technogym fehlt noch → „gemeldet“
  for (const mb of m.blocks) if (mb.status === "open" && bf[mb.block.id]) mb.status = "reported";
  return m;
}
/** Von Hand eingetragene Einheit, die später aus Strava/Technogym kam → Rückmeldung/Zuordnung wandert mit. */
function primaryId(id) { return state.workouts.find((w) => w.id === id)?.duplicate_of || id; }
function fb() { return latestFeedback(state.feedback.filter((f) => f.workout_id).map((f) => ({ ...f, workout_id: primaryId(f.workout_id) }))); }
/** Rückmeldungen über „Fertig“ (ohne Einheit) je Baustein, neueste gilt. */
function blockFb() {
  const by = {};
  for (const f of state.feedback) if (f.block_id && !f.workout_id && (!by[f.block_id] || by[f.block_id].created_at <= f.created_at)) by[f.block_id] = f;
  return by;
}
function feedbackFor(mb) { return (mb.workout && fb()[mb.workout.id]) || blockFb()[mb.block.id] || null; }
const isDone = (mb) => mb.status === "done" || mb.status === "reported";
function labels() { return state.plan?.effort_labels || ["locker", "machbar", "fordernd", "musste beißen", "zu viel"]; }

function workoutLine(w, parts = []) {
  const mins = minutesOf(w) + parts.reduce((a, o) => a + minutesOf(o), 0);
  const bits = [fmtDay(w.start_local), TYPE_LABELS[w.type] || w.type, `${mins} min`];
  const same = parts.filter((o) => o.type === w.type), other = parts.filter((o) => o.type !== w.type);
  const dist = (w.distance_m || 0) + same.reduce((a, o) => a + (o.distance_m || 0), 0);
  if (dist && w.type !== "strength") bits.push(fmtKm(dist));
  if (same.length) bits.push(`${same.length + 1} Teile`);
  if (other.length) bits.push(`inkl. ${other.map((o) => TYPE_LABELS[o.type] || o.type).join(", ")}`);
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
function when(b) { return b.day ? `${fmtDay(b.day)}${b.slot ? " · " + b.slot : ""}${b.planned_day ? ` (verschoben, geplant ${fmtDay(b.planned_day).slice(0, 2)})` : ""}` : b.where; }
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
    const here = m.blocks.filter((x) => x.block.day === iso);
    const mb = here.find((x) => !isDone(x) && x.status !== "skipped") || here[0];
    const doneHere = m.blocks.find((x) => x.workout && x.workout.start_local.slice(0, 10) === iso);
    const lbl = fmtDay(iso);
    const target = mb || doneHere;
    const cls = "day" + (iso === t ? " today" : "") + (unavailable[iso] ? " off" : "");
    const cell = target
      ? el("button", { type: "button", class: cls + " day-link", role: "listitem", "aria-label": `${lbl}: ${(here.length ? here : [target]).map((x) => x.block.title).join(", ")} – Details`, onclick: () => openDetail(target, week) })
      : el("div", { class: cls, role: "listitem" });
    cell.append(el("span", { class: "day-name", text: lbl.slice(0, 2) }), el("span", { class: "day-num", text: lbl.slice(3, 5) }));
    if (mb) {
      for (const x of here) cell.append(el("span", { class: `day-block tag-${x.status}`, text: SHORT[x.block.kind] + (isDone(x) ? " ✓" : "") }));
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
  const rc = reportCard();
  if (rc) colA.append(rc);

  // Rückmeldungen
  const covered = warmups();
  for (const wk of state.plan.weeks.filter((x) => x.start <= t)) {
    for (const mb of matched(wk).blocks) if (mb.workout && blockFb()[mb.block.id]) covered.add(mb.workout.id);
  }
  for (const w of pendingFeedback(state.workouts, fbm, state.plan, t, 10, covered).slice(0, 3)) {
    colA.append(el("section", { class: "card card-accent" },
      el("span", { class: "eyebrow", text: "Neue Einheit" }),
      el("button", { type: "button", class: "card-link", onclick: () => openWorkout(w) }, el("strong", { text: workoutLine(w, partsOf(w)) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })),
      btn("Wie war's?", () => openFeedback({ workout: w }), "btn primary")));
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
        btn("Fällt aus", () => openAusfall(b, wf.week)), btn("Ersatz", () => openErsatz(b, wf.week)))));
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
  const done = active.filter(isDone).length;
  const pct = active.length ? Math.round((done / active.length) * 100) : 0;
  const wk = el("section", { class: "card" },
    el("div", { class: "row between" }, el("strong", { text: `Woche ${wf.week.week} · ${wf.week.focus}` }), el("span", { class: "accent-text", text: `${done} / ${active.length}` })),
    el("div", { class: "progress" }, el("div", { style: `width: ${pct}%` })));
  const list = el("ul", { class: "mini-list" });
  for (const b of byDay(m.blocks)) {
    list.append(el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openDetail(b, wf.week) },
      el("span", { text: `${b.block.day ? fmtDay(b.block.day).slice(0, 2) + " · " : ""}${b.block.title}` }),
      el("span", { class: `tag tag-${b.status}`, text: statusText(b) }))));
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
      el("span", { class: "row" }, el("span", { class: `tag tag-${mb.status}`, text: mb.status === "done" ? `erledigt ${fmtDay(mb.workout.start_local).slice(0, 2)}` : mb.status === "reported" ? "fertig gemeldet" : mb.status === "skipped" ? "weggelassen" : `${b.minutes} min` }),
        el("span", { class: "chev", "aria-hidden": "true", text: "›" }))));
    if (b.substitute && !b.skipped) card.append(el("span", { class: "muted", text: `Ersatz: ${b.substitute.title}` }));
    if (mb.status === "done") {
      card.append(el("span", { class: "muted", text: workoutLine(mb.workout, mb.parts) }));
      const ev = evaluate(mb, feedbackFor(mb), state.strength, labels());
      card.append(corridorRows(ev), el("p", { class: "advice", text: ev.advice }));
      if (!feedbackFor(mb)) card.append(btn("Rückmeldung geben", () => openFeedback({ workout: mb.workout, block: mb.block }), "btn primary"));
    } else if (mb.status === "reported") {
      card.append(feedbackSummary(feedbackFor(mb)), el("span", { class: "muted small", text: "Wartet auf die Aufzeichnung aus Strava bzw. Technogym." }));
    } else if (mb.status === "open") {
      card.append(el("span", { class: "plan-day", text: when(b) }), el("span", { text: b.details }),
        el("div", { class: "row wrap" }, btn("Übungen", () => openDetail(mb, week)), btn("Verschieben", () => openMove(b, week)), btn("Fällt aus", () => openAusfall(b, week)), btn("Ersatz", () => openErsatz(b, week))));
    } else {
      card.append(el("span", { class: "muted", text: b.substitute?.effect || "" }),
        el("div", { class: "row" }, btn("Doch machen", () => chooseSubstitute(b, { id: "plan", title: "Wie geplant" }))));
    }
    grid.append(card);
  }
  root.append(grid);

  if (m.extra.length) {
    root.append(el("h2", { class: "section-title", text: "Zusätzlich" }),
      el("ul", { class: "plain-list" }, ...m.extra.map((w) => el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openWorkout(w) }, el("span", { text: workoutLine(w, partsOf(w)) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" }))))));
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
  const ready = readinessCard();
  const start = state.plan.weeks[0].start;
  const since = state.workouts.filter((w) => !w.duplicate_of && w.start_local.slice(0, 10) >= start);
  const longest = Math.max(0, ...since.filter((w) => w.type !== "strength").map(minutesOf));
  const leg = Math.max(0, ...state.strength.filter((e) => e.start_local.slice(0, 10) >= start && e.exercise === "leg_extension" && !e.is_test).map((e) => loadOf(e) || 0));
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

// ---------------------------------------------------------------- Bereitschaft und Wochenbericht
const ASPECT_ORDER = ["snowboard", "classic15", "skating"];
function snapshots() { return state.readiness?.snapshots || []; }
/** Letzter Stichtag (auch vorläufig) und der Stichtag davor (abgeschlossen) zum Vergleich. */
function readinessNow() {
  const s = snapshots();
  if (!s.length) return null;
  const cur = s[s.length - 1];
  const prev = [...s].reverse().find((x) => x !== cur && !x.provisional) || null;
  return { cur, prev };
}

function sparkline(values, label) {
  const w = 96, h = 28, max = 100;
  const pts = values.map((v, i) => `${values.length === 1 ? w / 2 : Math.round((i / (values.length - 1)) * (w - 6)) + 3},${Math.round(h - 3 - (v / max) * (h - 6))}`).join(" ");
  const s = svg("svg", { width: String(w), height: String(h), viewBox: `0 0 ${w} ${h}`, class: "spark", role: "img", "aria-label": label },
    svg("polyline", { points: pts, class: "spark-line" }));
  const last = pts.split(" ").pop().split(",");
  s.append(svg("circle", { cx: last[0], cy: last[1], r: "3", class: "spark-dot" }));
  return s;
}

function deltaChip(d) {
  if (d == null || Math.abs(d) < 1) return chip("±0", "delta-flat");
  return chip(`${d > 0 ? "▲ +" : "▼ "}${d}`, d > 0 ? "delta-up" : "delta-down");
}

function readinessCard() {
  const rn = readinessNow();
  const card = el("section", { class: "card" }, el("div", { class: "row between" }, el("strong", { text: "Wie nah bist du dran?" }),
    rn ? btn("Wie berechnet?", () => openReadinessInfo(), "btn small-btn") : null));
  if (!rn) {
    const r = state.plan.readiness;
    card.append(el("span", { class: "muted small", text: `Schätzung vom ${fmtDay(r.as_of)}` }));
    for (const it of r.items) {
      card.append(el("div", { class: "ready" },
        el("div", { class: "row between" }, el("span", { text: it.title }), el("strong", { text: `${it.percent} %` })),
        el("div", { class: "progress" }, el("div", { style: `width: ${it.percent}%` })),
        el("span", { class: "small" }, el("b", { text: "Dafür spricht: " }), it.pro),
        el("span", { class: "small" }, el("b", { text: "Es fehlt: " }), it.missing)));
    }
    return card;
  }
  const { cur, prev } = rn;
  const checked = state.coach.find((n) => n.date === cur.date);
  card.append(el("span", { class: "muted small", text: cur.provisional
    ? `Stand heute (vorläufig) · Vergleich mit ${fmtDay(prev?.date)}`
    : `Stand ${fmtDay(cur.date)}${checked ? " · von Claude geprüft" : ""}${prev ? ` · Vergleich mit ${fmtDay(prev.date)}` : ""}` }));
  for (const id of ASPECT_ORDER) {
    const a = cur.aspects[id];
    if (!a) continue;
    const d = prev ? a.percent - prev.aspects[id].percent : null;
    const hist = snapshots().filter((s) => !s.provisional || s === cur).map((s) => s.aspects[id].percent);
    card.append(el("div", { class: "ready" },
      el("div", { class: "row between" }, el("span", { text: a.title }),
        el("span", { class: "row" }, deltaChip(d), el("strong", { text: `${a.percent} %` }))),
      el("div", { class: "row between ready-bar" }, el("div", { class: "progress grow" }, el("div", { style: `width: ${a.percent}%` })),
        sparkline(hist, `Verlauf ${a.title}: ${hist.join(", ")} %`)),
      a.pro.length ? el("span", { class: "small" }, el("b", { text: "Dafür spricht: " }), a.pro.join(" · ")) : null,
      a.missing.length ? el("span", { class: "small" }, el("b", { text: "Es fehlt: " }), a.missing.join(" · ")) : null,
      a.adjust_reasons?.length ? el("span", { class: "small muted" }, el("b", { text: `Von Claude justiert (${a.adjust > 0 ? "+" : ""}${a.adjust}): ` }), a.adjust_reasons.join(" · ")) : null,
      el("span", { class: "muted small", text: `Sicherheit der Schätzung: ${a.confidence}` })));
  }
  return card;
}

function openReadinessInfo() {
  const r = state.readiness;
  const { cur } = readinessNow();
  const body = el("div", { class: "sheet-content" },
    el("p", { text: "Jede Kennzahl wird zwischen Ausgangsniveau (0) und Ziel (1) eingeordnet und je Zielaspekt gewichtet. Startwert ist die Schätzung vom 15.11.; Veränderungen werden geglättet, damit ein einzelner Ausreißer nichts kippt. Sonntags prüft Claude die Werte und justiert bei Bedarf – mit Begründung." }));
  const list = el("ul", { class: "mini-list" });
  for (const [k, m] of Object.entries(r.metrics)) {
    const v = cur.metrics[k], s = cur.scores[k];
    list.append(el("li", {}, el("span", { text: m.title }),
      el("span", { class: "muted", text: v == null ? "keine Daten" : `${String(v).replace(".", ",")} ${m.unit} · Ziel ${String(m.goal).replace(".", ",")} ${m.unit}${s != null ? ` · ${Math.round(s * 100)} %` : ""}` })));
  }
  body.append(el("strong", { text: "Kennzahlen" }), list, el("strong", { text: "Gewichte" }));
  for (const id of ASPECT_ORDER) {
    const w = r.weights[id];
    body.append(el("p", { class: "small" }, el("b", { text: `${cur.aspects[id].title}: ` }),
      Object.entries(w).map(([k, x]) => `${r.metrics[k].title.split(" (")[0].split(":")[0]} ${Math.round(x * 100)} %`).join(" · ")));
  }
  openSheet("So wird die Bereitschaft berechnet", body);
}

/** Wochen, die schon begonnen haben (neueste zuerst). */
function reportWeeks() {
  if (!state.plan) return [];
  return state.plan.weeks.filter((w) => w.start <= today()).slice().reverse();
}

function weekReport(week) {
  const m = matched(week);
  const active = m.blocks.filter((b) => b.status !== "skipped");
  const done = active.filter(isDone);
  const t = today();
  const ws = state.workouts.filter((w) => !w.duplicate_of && w.start_local.slice(0, 10) >= week.start && w.start_local.slice(0, 10) <= week.end);
  const mins = ws.reduce((a, w) => a + minutesOf(w), 0);
  const planned = active.reduce((a, b) => a + b.block.minutes, 0);
  const fbs = state.feedback.filter((f) => {
    const day = f.day || (f.workout_id && state.workouts.find((w) => w.id === f.workout_id)?.start_local.slice(0, 10)) || f.created_at.slice(0, 10);
    return day >= week.start && day <= week.end;
  });
  const tags = {};
  for (const f of fbs) for (const tg of f.tags || []) tags[tg] = (tags[tg] || 0) + 1;
  const note = state.coach.find((n) => n.week === week.week);
  const snapEnd = snapshots().find((s) => s.date === week.end) || (week.end > t ? snapshots().slice(-1)[0] : null);
  const snapStart = [...snapshots()].reverse().find((s) => s.date < week.start && !s.provisional) || snapshots()[0];
  return { week, m, active, done, mins, planned, fbs, tags, note, snapEnd, snapStart, running: week.end >= t };
}

function openWeekReport(week) {
  const r = weekReport(week);
  store.set(KEY_SEEN_REPORT, String(week.week));
  const body = el("div", { class: "sheet-content" },
    el("p", { class: "muted", text: `${fmtDay(week.start)} – ${fmtDay(week.end)} · ${week.focus}${r.running ? " · läuft noch" : ""}` }));
  if (r.note) {
    body.append(el("section", { class: "coach" },
      el("span", { class: "eyebrow", text: `Claudes Prüfung · ${fmtDay(r.note.date)}` }),
      el("p", { text: r.note.summary }),
      r.note.highlights?.length ? el("div", {}, el("strong", { text: "Gut gelaufen" }), el("ul", { class: "guide-list" }, ...r.note.highlights.map((x) => el("li", { text: x })))) : null,
      r.note.watch?.length ? el("div", {}, el("strong", { text: "Darauf achten" }), el("ul", { class: "guide-list" }, ...r.note.watch.map((x) => el("li", { text: x })))) : null,
      r.note.changes?.length ? el("div", {}, el("strong", { text: "Angepasst" }), el("ul", { class: "guide-list" }, ...r.note.changes.map((x) => el("li", { text: x })))) : null,
      r.note.next_focus ? el("p", {}, el("b", { text: "Nächste Woche: " }), r.note.next_focus) : null));
  } else {
    body.append(el("p", { class: "note", text: r.running ? "Claude prüft die Woche am Sonntagabend." : "Für diese Woche gibt es noch keine Prüfung von Claude." }));
  }
  const tiles = el("div", { class: "tiles" });
  const tile = (label, value) => tiles.append(el("div", { class: "tile" }, el("span", { class: "muted small", text: label }), el("strong", { text: value })));
  tile("Bausteine", `${r.done.length} / ${r.active.length}`);
  const hm = (m) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`;
  tile("Zeit · Plan", `${hm(r.mins)} / ${hm(r.planned)} h`);
  const effs = r.fbs.map((f) => f.effort);
  if (effs.length) tile("Ø Gefühl", labels()[Math.round(effs.reduce((a, b) => a + b, 0) / effs.length) - 1]);
  const kn = r.fbs.map((f) => f.knee).filter((k) => k != null);
  if (kn.length) tile("Knie (max.)", (state.plan.knee_labels || [])[Math.max(...kn)] || String(Math.max(...kn)));
  body.append(tiles, el("strong", { text: "Plan und Umsetzung" }));
  const list = el("ul", { class: "mini-list" });
  for (const mb of byDay(r.m.blocks)) {
    list.append(el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openDetail(mb, week) },
      el("span", { text: mb.block.title }),
      el("span", { class: `tag tag-${mb.status}`, text: mb.status === "done" ? `${totalMinutes(mb)} / ${mb.block.minutes} min` : statusText(mb) }))));
  }
  body.append(list);
  if (Object.keys(r.tags).length) {
    body.append(el("strong", { text: "Deine Stichworte" }),
      el("div", { class: "row wrap" }, ...Object.entries(r.tags).sort((a, b) => b[1] - a[1]).map(([k, n]) => chip(n > 1 ? `${k} ×${n}` : k))));
  }
  if (r.snapEnd && r.snapStart) {
    const rl = el("ul", { class: "mini-list" });
    for (const id of ASPECT_ORDER) {
      const a = r.snapEnd.aspects[id], b = r.snapStart.aspects[id];
      rl.append(el("li", {}, el("span", { text: a.title }), el("span", { class: "row" }, deltaChip(a.percent - b.percent), el("strong", { text: `${a.percent} %` }))));
    }
    body.append(el("strong", { text: r.snapEnd.provisional ? "Bereitschaft (vorläufig)" : "Bereitschaft" }), rl);
  }
  openSheet(`Wochenbericht · Woche ${week.week}`, body);
}

/** Hinweis auf der Startseite, wenn Claudes Prüfung der letzten Woche neu ist. */
function reportCard() {
  const last = state.coach.slice().sort((a, b) => b.week - a.week)[0];
  if (!last || store.get(KEY_SEEN_REPORT) === String(last.week)) return null;
  const week = state.plan?.weeks.find((w) => w.week === last.week);
  if (!week) return null;
  return el("section", { class: "card card-report" },
    el("span", { class: "eyebrow", text: `Wochenbericht · Woche ${week.week}` }),
    el("strong", { text: last.summary.length > 140 ? last.summary.slice(0, 137) + " …" : last.summary }),
    btn("Bericht ansehen", () => { openWeekReport(week); render(); }, "btn primary"));
}

// ---------------------------------------------------------------- Fortschritt
function renderFortschritt() {
  const root = $("#view-fortschritt");
  root.replaceChildren();
  const weeksDone = reportWeeks();
  if (weeksDone.length) {
    const rep = el("section", { class: "card" }, el("strong", { text: "Wochenberichte" }));
    const ul = el("ul", { class: "plain-list" });
    for (const wk of weeksDone) {
      const r = weekReport(wk);
      ul.append(el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openWeekReport(wk) },
        el("span", { text: `Woche ${wk.week} · ${fmtDay(wk.start).slice(3)}–${fmtDay(wk.end).slice(3)} · ${r.done.length}/${r.active.length}` }),
        el("span", { class: "row" }, r.note ? chip("geprüft", "tag-done") : r.running ? chip("läuft") : null, el("span", { class: "chev", "aria-hidden": "true", text: "›" })))));
    }
    rep.append(ul);
    root.append(rep);
  }
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
  const skip = warmups();
  const recent = [...ws].filter((w) => !skip.has(w.id)).sort((a, b) => b.start_utc.localeCompare(a.start_utc)).slice(0, 15);
  root.append(el("div", { class: "cols" },
    el("div", { class: "col" }, el("section", { class: "card" }, el("div", { class: "row between" }, el("strong", { text: "Training pro Woche" }), el("span", { class: "muted small", text: "Stunden" })), chart)),
    el("div", { class: "col" }, el("section", { class: "card" }, el("strong", { text: "Letzte Einheiten" }),
      el("ul", { class: "plain-list" }, ...recent.map((w) => el("li", {}, el("button", { type: "button", class: "list-link", onclick: () => openWorkout(w) }, el("span", { text: workoutLine(w, partsOf(w)) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })))))))));
}

// ---------------------------------------------------------------- Zuordnung „Welches Training war das?“
function weekOf(w) {
  return state.plan?.weeks.find((x) => w.start_local.slice(0, 10) >= x.start && w.start_local.slice(0, 10) <= x.end) || null;
}
/** Aktuelle Zuordnung einer Einheit: Baustein-ID, "extra" oder null (außerhalb des Plans). */
function assignmentOf(w) {
  const wk = weekOf(w);
  if (!wk) return null;
  const mb = matched(wk).blocks.find((x) => x.workout?.id === w.id || (x.parts || []).some((p) => p.id === w.id));
  return mb ? mb.block.id : "extra";
}
/** Auswahl Baustein / zusätzlich für eine Einheit; onPick(id) bei Änderung. */
function assignPicker(w, current, onPick) {
  const wk = weekOf(w);
  if (!wk) return null;
  const m = matched(wk);
  const g = el("div", { class: "options-list", role: "radiogroup", "aria-label": "Welches Training war das?" });
  const opt = (id, title, sub) => {
    const on = id === current;
    g.append(el("button", { type: "button", role: "radio", "aria-checked": on ? "true" : "false", class: "option" + (on ? " recommended" : ""),
      onclick: () => onPick(id) }, el("strong", { text: title }), sub ? el("span", { text: sub }) : null));
  };
  for (const mb of byDay(m.blocks)) {
    const other = mb.workout && mb.workout.id !== w.id ? `zählt bisher: ${workoutLine(mb.workout)}` : mb.status === "skipped" ? "war weggelassen" : mb.block.id === current ? "aktuell" : `${mb.block.minutes} min · ${statusText(mb)}`;
    opt(mb.block.id, mb.block.title, other);
  }
  opt("extra", "Zusätzlich", "Zählt nicht für einen Baustein, aber für Wochenzeit und Fortschritt");
  return g;
}
async function saveAssignment(w, blockId) {
  const item = { workout_id: w.id, block_id: blockId, created_at: new Date().toISOString(), source: "app" };
  await save(inboxName("inbox/app/assign", w.id), item, `App: Zuordnung ${w.id} → ${blockId}`);
  state.assignments.push(item);
}
function openAssign(w) {
  const current = assignmentOf(w);
  const body = el("div", { class: "sheet-content" }, el("p", { class: "muted", text: workoutLine(w, partsOf(w)) }));
  const picker = assignPicker(w, current, async (id) => {
    if (id === current) { $("#sheet").close(); return; }
    sheetStatus("Speichere …");
    try { await saveAssignment(w, id); $("#sheet").close(); render(); } catch (e) { sheetStatus(e.message, "error"); }
  });
  if (!picker) { body.append(el("p", { text: "Diese Einheit liegt außerhalb des Trainingsplans." })); openSheet("Welches Training war das?", body); return; }
  body.append(picker);
  openSheet("Welches Training war das?", body);
}

// ---------------------------------------------------------------- Training von Hand hinzufügen
const ADD_TYPES = [
  { id: "run", title: "Laufen", dist: true }, { id: "rowing", title: "Rudern", dist: true }, { id: "ride", title: "Rad", dist: true },
  { id: "strength", title: "Kraft zu Hause" }, { id: "strength", title: "Studio", location: "studio" },
  { id: "hike", title: "Wandern", dist: true }, { id: "walk", title: "Gehen", dist: true }, { id: "swim", title: "Schwimmen", dist: true },
  { id: "workout", title: "Sonstiges" },
];
function pad2(n) { return String(n).padStart(2, "0"); }

function openAdd() {
  if (!state.plan) return;
  let kind = null, effort = null, knee = null, assignTo = null;
  const now = new Date();
  const dateIn = el("input", { type: "date", id: "add-date", value: today(), max: today() });
  const timeIn = el("input", { type: "time", id: "add-time", value: `${pad2(Math.max(0, now.getHours() - 1))}:${pad2(now.getMinutes())}` });
  const durIn = el("input", { type: "number", id: "add-min", min: "1", max: "600", inputmode: "numeric", placeholder: "z. B. 40" });
  const distIn = el("input", { type: "number", id: "add-km", min: "0", max: "200", step: "0.1", inputmode: "decimal", placeholder: "optional" });
  const note = el("textarea", { id: "add-note", rows: "2", maxlength: "500", placeholder: "Optional, z. B. Uhr vergessen" });
  const knees = state.plan.knee_labels || ["ruhig", "leicht", "deutlich", "stark"];
  const saveBtn = btn("Hinzufügen", null, "btn primary full");
  const body = el("div", { class: "sheet-content" });
  const draft = () => {
    const d = dateIn.value || today();
    const start = new Date(`${d}T${timeIn.value || "12:00"}:00`);
    const mins = Math.round(Number(durIn.value) || 0);
    const k = ADD_TYPES[kind] || {};
    return { id: `app:${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`, type: k.id || "workout",
      name: `Von Hand: ${k.title || "Training"}`, start_local: `${d}T${pad2(start.getHours())}:${pad2(start.getMinutes())}:00`,
      start_utc: start.toISOString().replace(/\.\d+Z$/, "Z"), duration_s: mins * 60, moving_s: mins * 60,
      distance_m: k.dist && Number(distIn.value) > 0 ? Math.round(Number(distIn.value) * 1000) : (k.id === "strength" ? 0 : null),
      location: k.location || null, source: "app" };
  };
  const draw = () => {
    const k = ADD_TYPES[kind];
    const w = draft();
    const wk = weekOf(w);
    const picker = kind != null && wk ? assignPicker(w, assignTo ?? "extra", (id) => { assignTo = id; draw(); }) : null;
    body.replaceChildren(
      el("strong", { text: "Was hast du gemacht?" }),
      choiceGroup("Sportart", ADD_TYPES.map((x) => x.title), kind, (i) => { kind = i; draw(); }),
      el("div", { class: "form-row" }, el("label", { class: "field" }, "Datum", dateIn), el("label", { class: "field" }, "Beginn", timeIn)),
      el("div", { class: "form-row" }, el("label", { class: "field" }, "Dauer (min)", durIn), k?.dist ? el("label", { class: "field" }, "Strecke (km)", distIn) : null),
      picker ? el("strong", { text: "Welches Training war das?" }) : null, picker,
      el("strong", { text: "Wie war's? (optional)" }),
      choiceGroup("Gefühlte Belastung", labels(), effort == null ? null : effort - 1, (i) => { effort = effort === i + 1 ? null : i + 1; draw(); }),
      el("strong", { text: "Knie links (optional)" }),
      choiceGroup("Knie links", knees, knee, (i) => { knee = knee === i ? null : i; draw(); }),
      el("label", { class: "field" }, "Kommentar", note),
      saveBtn,
      el("span", { class: "muted small", text: "Kommt die Einheit später doch aus Strava oder Technogym, ersetzt die Aufzeichnung diesen Eintrag – deine Angaben bleiben." }));
    saveBtn.disabled = kind == null || !(Number(durIn.value) > 0);
  };
  for (const i of [durIn, dateIn, timeIn, distIn]) i.addEventListener("input", () => { saveBtn.disabled = kind == null || !(Number(durIn.value) > 0); });
  dateIn.addEventListener("change", draw);
  saveBtn.addEventListener("click", async () => {
    const w = draft();
    if (!(w.duration_s > 0) || kind == null) return;
    if (note.value.trim() && effort == null) w.note = note.value.trim();
    saveBtn.disabled = true;
    sheetStatus("Speichere …");
    try {
      await save(`inbox/app/manual/${w.id.slice(4)}_add.json`, w, `App: Training hinzugefügt ${w.start_local.slice(0, 10)} ${ADD_TYPES[kind].title}`);
      state.workouts.push(w);
      const target = assignTo ?? "extra";
      if (weekOf(w)) await saveAssignment(w, target);
      if (effort != null) {
        const item = { workout_id: w.id, effort, knee, tags: [], note: note.value.trim() || null, created_at: new Date().toISOString(), source: "app" };
        await save(inboxName("inbox/app/feedback", w.id), item, "App: Rückmeldung (von Hand)");
        state.feedback.push(item);
      }
      $("#sheet").close();
      render();
    } catch (e) { sheetStatus(e.message, "error"); saveBtn.disabled = false; }
  });
  draw();
  openSheet("Training hinzufügen", body);
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
    if (e.weight_kg != null) bits.push(fmtKg(e.weight_kg) + (e.elastic ? ` + Elastik ${e.elastic}` : ""));
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
    const load = loadOf(r);
    let mark = "";
    if (g != null && load != null) mark = load > g + 0.25 ? " ↑" : load < g - 0.25 ? " ↓" : " ✓";
    const el_ = r.elastic_level ? ` + E${r.elastic_level}` : r.mode === "elastisch" ? " + E" : "";
    ul.append(el("li", {}, el("span", { text: r.exercise_name || r.exercise }),
      el("span", { class: "muted", text: `${r.set_count || "–"} × ${r.set_count ? Math.round((r.reps_total || 0) / r.set_count) : "–"}${load != null ? " · " + fmtKg(load) + el_ : ""}${r.is_test ? " · Test" : ""}${mark}` })));
  }
  return ul;
}

function statusText(mb) {
  return mb.status === "done" ? "erledigt" : mb.status === "reported" ? "fertig gemeldet" : mb.status === "skipped" ? "weggelassen" : "offen";
}

/** Inhalt der Detailansicht eines Bausteins (im Sheet oder im Reiter Training). */
// „Training nach Wahl“: gewählte Sportart (nur auf diesem Gerät); erledigt → aus der Einheit abgeleitet
const OPTION_BY_TYPE = { run: "laufen", rowing: "rudern", ride: "rad", strength: "kraft" };
function getPicks() { try { return JSON.parse(store.get(KEY_PICK) || "{}"); } catch { return {}; } }
function pickedOption(mb) {
  const opts = mb.block.options;
  if (!opts?.length) return null;
  const want = (mb.workout && OPTION_BY_TYPE[mb.workout.type]) || getPicks()[mb.block.id];
  return opts.find((o) => o.id === want) || opts[0];
}
function setPick(blockId, optionId) {
  const p = getPicks();
  p[blockId] = optionId;
  store.set(KEY_PICK, JSON.stringify(p));
}

function blockDetail(mb, week, inline = false) {
  const b = mb.block;
  const sub = b.substitute && !b.skipped ? b.substitute : null;
  const wrap = el("div", { class: "detail" });
  wrap.append(el("div", { class: "row wrap" },
    b.day ? chip(when(b)) : null, chip(`${b.minutes} min`), chip(statusText(mb), `tag-${mb.status}`)));
  if (b.where) wrap.append(el("span", { class: "muted", text: b.where }));
  if (sub) wrap.append(el("p", { class: "note", text: `Ersatz gewählt: ${sub.title} – ${sub.effect}` }));
  if (b.skipped) wrap.append(el("p", { class: "note", text: `Diese Woche weggelassen – ${b.substitute?.effect || ""}` }));
  const opt = sub ? null : pickedOption(mb);
  if (opt && !b.skipped) {
    wrap.append(el("h3", { class: "detail-h", text: isDone(mb) ? "Gemacht" : "Was machst du?" }));
    const g = el("div", { class: "choices", role: "radiogroup", "aria-label": "Sportart wählen" });
    for (const o of b.options) {
      const on = o.id === opt.id;
      g.append(el("button", { type: "button", role: "radio", class: "btn choice" + (on ? " active" : ""), "aria-checked": on ? "true" : "false",
        disabled: isDone(mb) && !on,
        onclick: () => { setPick(b.id, o.id); if (inline) renderTraining(); else openDetail(mb, week); } }, o.title));
    }
    wrap.append(g);
  }
  const ex = sub ? sub.exercises : opt ? opt.exercises : b.exercises;
  if (ex?.length && !b.skipped) {
    const strength = sub ? sub.accepts.some((x) => x === "strength" || x === "studio") : b.kind.startsWith("kraft") || opt?.id === "kraft";
    wrap.append(el("h3", { class: "detail-h", text: strength ? "Übungen" : "Ablauf" }));
    if (inline && mb.status !== "skipped") wrap.append(el("span", { class: "muted small", text: "Antippen zum Abhaken." }));
    wrap.append(exerciseList(ex, inline && mb.status !== "skipped" ? `${today()}|${b.id}${opt ? "|" + opt.id : ""}` : null,
      mb.status !== "skipped" ? { block_id: b.id, workout_id: mb.workout?.id, label: opt ? `${b.title} · ${opt.title}` : b.title } : null));
  } else if (!b.skipped) {
    wrap.append(el("p", { text: sub ? sub.effect : b.details }));
  }
  if (b.notes && !sub && !b.skipped) wrap.append(el("p", { class: "muted small", text: b.notes }));
  const actions = el("div", { class: "row wrap" });
  if (mb.status === "done") {
    const ev = evaluate(mb, feedbackFor(mb), state.strength, labels());
    wrap.append(el("h3", { class: "detail-h", text: "So lief es" }),
      el("button", { type: "button", class: "list-link", onclick: () => openWorkout(mb.workout) }, el("span", { text: workoutLine(mb.workout, mb.parts) }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })),
      corridorRows(ev), el("p", { class: "advice", text: ev.advice }));
    const done = strengthOn(mb.workout, b.exercises || []);
    if (done) wrap.append(el("span", { class: "small", text: "Am Gerät eingestellte Belastung (↑ über, ✓ im, ↓ unter Ziel):" }), done);
    const f = feedbackFor(mb);
    if (f) wrap.append(feedbackSummary(f));
    else actions.append(btn("Rückmeldung geben", () => openFeedback({ workout: mb.workout, block: b }), "btn primary"));
  } else if (mb.status === "reported") {
    wrap.append(el("h3", { class: "detail-h", text: "Deine Rückmeldung" }), feedbackSummary(feedbackFor(mb)),
      el("span", { class: "muted small", text: "Die Aufzeichnung aus Strava bzw. Technogym kommt beim nächsten Abgleich dazu." }));
    actions.append(btn("Rückmeldung ändern", () => openFeedback({ block: b, option: opt?.id, prev: feedbackFor(mb) })));
  } else if (mb.status === "open") {
    actions.append(btn("Fertig", () => openFeedback({ block: b, option: opt?.id }), "btn primary"), btn("Verschieben", () => openMove(b, week)), btn("Fällt aus", () => openAusfall(b, week)), btn("Ersatz", () => openErsatz(b, week)));
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
  const body = el("div", { class: "sheet-content" }, el("p", { class: "muted", text: workoutLine(w, partsOf(w)) }), tiles);
  // Zu welchem Baustein zählt die Einheit?
  if (state.plan) {
    const wk = state.plan.weeks.find((x) => w.start_local.slice(0, 10) >= x.start && w.start_local.slice(0, 10) <= x.end);
    const mb = wk && matched(wk).blocks.find((x) => x.workout?.id === w.id);
    if (mb) body.append(el("button", { type: "button", class: "list-link", onclick: () => openDetail(mb, wk) },
      el("span", { text: `Zählt als: ${mb.block.title}${mb.manual ? " (von dir zugeordnet)" : ""}` }), el("span", { class: "chev", "aria-hidden": "true", text: "›" })));
    else if (wk) body.append(el("span", { class: "muted", text: "Zählt als: zusätzlich" }));
    if (wk && !warmups().has(w.id)) body.append(btn("Zuordnung ändern", () => openAssign(w), "btn small-btn"));
  }
  const s = strengthOn(w);
  if (s && (w.type === "strength" || (w.source === "technogym"))) body.append(el("strong", { text: "Übungen am Gerät" }), s);
  let f = fb()[w.id];
  if (!f && state.plan) {
    const wk = state.plan.weeks.find((x) => w.start_local.slice(0, 10) >= x.start && w.start_local.slice(0, 10) <= x.end);
    const mb = wk && matched(wk).blocks.find((x) => x.workout?.id === w.id);
    if (mb) f = feedbackFor(mb);
  }
  if (f) body.append(feedbackSummary(f));
  body.append(el("div", { class: "row wrap" },
    f ? null : btn("Rückmeldung geben", () => openFeedback({ workout: w }), "btn primary"),
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
      el("span", { class: "eyebrow", text: isDone(mb) ? "Heute erledigt" : kind === "heute" ? "Heute" : "Nächste Einheit" }),
      el("strong", { class: "big", text: b.substitute && !b.skipped ? `${b.title} → ${b.substitute.title}` : pickedOption(mb) ? `${b.title} · ${pickedOption(mb).title}` : b.title }),
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

const FEEDBACK_TAGS = [
  "Lief richtig gut", "Leichter als gedacht", "Gewicht erhöht", "Technik besser",
  "Beine schwer", "Atmung schwer", "Kurz und knackig", "Abgebrochen / gekürzt",
  "Wenig geschlafen", "Stress / müde", "Zeitdruck", "Knie hat gezwickt", "Wetter schlecht",
];

function feedbackSummary(f) {
  if (!f) return null;
  const knees = state.plan?.knee_labels || [];
  const bits = [`Gefühl: ${labels()[f.effort - 1]}`];
  if (f.knee != null) bits.push(`Knie: ${knees[f.knee] ?? f.knee}`);
  return el("div", { class: "fb-summary" },
    el("span", { class: "small", text: bits.join(" · ") }),
    f.tags?.length ? el("div", { class: "row wrap" }, ...f.tags.map((t) => chip(t))) : null,
    f.note ? el("p", { class: "small", text: f.note }) : null);
}

/** Rückmeldung zu einer aufgezeichneten Einheit ({ workout }) oder „Fertig“ zu einem Baustein ({ block, option }). */
function openFeedback({ workout = null, block = null, option = null, prev = null } = {}) {
  let effort = prev?.effort ?? null, knee = prev?.knee ?? null;
  const tags = new Set(prev?.tags || []);
  const knees = state.plan?.knee_labels || ["ruhig", "leicht", "deutlich", "stark"];
  const note = el("textarea", { id: "fb-note", rows: "3", maxlength: "500", placeholder: "Was du festhalten willst – z. B. Gegenwind, 3. Satz nur 12 Wdh." });
  note.value = prev?.note || "";
  const saveBtn = btn(workout ? "Speichern" : "Fertig – speichern", null, "btn primary full");
  const body = el("div", { class: "sheet-content" });
  const tagBox = el("div", { class: "tag-choices", role: "group", "aria-label": "Stichworte" });
  for (const t of FEEDBACK_TAGS) {
    const b = el("button", { type: "button", class: "chip chip-toggle" + (tags.has(t) ? " active" : ""), "aria-pressed": tags.has(t) ? "true" : "false" }, t);
    b.addEventListener("click", () => {
      if (tags.has(t)) tags.delete(t); else tags.add(t);
      b.classList.toggle("active", tags.has(t));
      b.setAttribute("aria-pressed", tags.has(t) ? "true" : "false");
    });
    tagBox.append(b);
  }
  const head = workout ? workoutLine(workout, partsOf(workout)) : `${block.title}${option ? " · " + (block.options?.find((o) => o.id === option)?.title || option) : ""} · ${fmtDay(today())}`;
  const assignedBefore = workout ? assignmentOf(workout) : null;
  let assignTo = assignedBefore;
  const draw = () => {
    const picker = workout && assignedBefore ? assignPicker(workout, assignTo, (id) => { assignTo = id; draw(); }) : null;
    body.replaceChildren(
      el("p", { class: "muted", text: head }),
      picker ? el("strong", { text: "Welches Training war das?" }) : null, picker,
      el("strong", { text: "Wie war's?" }),
      choiceGroup("Gefühlte Belastung", labels(), effort == null ? null : effort - 1, (i) => { effort = i + 1; draw(); }),
      el("strong", { text: "Knie links" }),
      choiceGroup("Knie links", knees, knee, (i) => { knee = i; draw(); }),
      el("strong", { text: "Stichworte (optional)" }), tagBox,
      el("label", { class: "field" }, "Kommentar (optional)", note),
      saveBtn,
      el("span", { class: "muted small", text: workout ? "Wird nur in dein privates Daten-Repo geschrieben."
        : "Markiert die Einheit als fertig. Die Aufzeichnung aus Strava bzw. Technogym wird später automatisch zugeordnet." }));
    saveBtn.disabled = effort == null;
  };
  saveBtn.addEventListener("click", async () => {
    if (effort == null) return;
    const item = { effort, knee, tags: [...tags], note: note.value.trim() || null, created_at: new Date().toISOString(), source: "app" };
    if (workout) item.workout_id = workout.id;
    if (block) { item.block_id = block.id; item.day = today(); if (option) item.option = option; }
    saveBtn.disabled = true;
    sheetStatus("Speichere …");
    try {
      const id = workout ? workout.id : block.id;
      const msg = workout ? `App: Rückmeldung ${workout.start_local.slice(0, 10)} ${TYPE_LABELS[workout.type] || workout.type}` : `App: Fertig ${block.id}`;
      if (workout && assignTo && assignTo !== assignedBefore) await saveAssignment(workout, assignTo);
      await save(inboxName("inbox/app/feedback", id), item, msg);
      state.feedback.push(item);
      $("#sheet").close();
      render();
    } catch (e) { sheetStatus(e.message, "error"); saveBtn.disabled = false; }
  });
  draw();
  openSheet(workout ? "Rückmeldung" : "Einheit abschließen", body);
}

function openErsatz(block, week) {
  const body = el("div", { class: "sheet-content" }, el("p", { class: "muted", text: `${block.title} · ${block.minutes} min · Woche ${week.week}` }));
  const opts = [...block.substitutes];
  if (block.substitute) opts.unshift({ id: "plan", title: "Wie geplant", effect: "Ersatz zurücknehmen", minutes: block.minutes });
  for (const s of opts) {
    body.append(el("button", { type: "button", class: "option" + (s.recommended ? " recommended" : ""), onclick: () => s.id === "verschieben" ? openMove(block, week) : chooseSubstitute(block, s) },
      el("strong", { text: s.title }), el("span", { text: s.effect + (s.recommended ? " · Empfohlen" : "") })));
  }
  openSheet("Ersatz wählen", body);
}

const AUSFALL_GRUENDE = ["Keine Zeit", "Termin", "Krank", "Zu müde", "Knie", "Sonstiges"];

/** Geplante Einheit fällt aus: Grund angeben, dann nachholen, ersetzen oder weglassen. */
function openAusfall(block, week) {
  let reason = null;
  const note = el("textarea", { id: "ausfall-note", rows: "2", maxlength: "300", placeholder: "Optional, z. B. bis Montag erkältet" });
  const daysLeft = Math.max(0, daysUntil(week.end, today()));
  const recommended = block.substitutes.find((s) => s.recommended && s.minutes > 0 && s.id !== "verschieben");
  const skip = block.substitutes.find((s) => s.id === "weglassen") || { id: "weglassen", title: "Diese Woche weglassen", minutes: 0, effect: "" };
  const extra = () => ({ reason, note: note.value.trim() || null });
  const reasons = el("div", { class: "tag-choices", role: "radiogroup", "aria-label": "Grund" });
  for (const r of AUSFALL_GRUENDE) {
    const b = el("button", { type: "button", role: "radio", class: "chip chip-toggle", "aria-checked": "false" }, r);
    b.addEventListener("click", () => {
      reason = reason === r ? null : r;
      for (const x of reasons.children) { const on = x.textContent === reason; x.classList.toggle("active", on); x.setAttribute("aria-checked", on ? "true" : "false"); }
    });
    reasons.append(b);
  }
  const option = (title, text, onclick, cls = "option") => el("button", { type: "button", class: cls, onclick }, el("strong", { text: title }), el("span", { text }));
  const body = el("div", { class: "sheet-content" },
    el("p", { class: "muted", text: `${block.title} · ${block.day ? fmtDay(block.day) : `Woche ${week.week}`}` }),
    el("strong", { text: "Warum? (optional)" }), reasons,
    el("label", { class: "field" }, "Kommentar", note),
    el("strong", { text: "Und jetzt?" }),
    daysLeft > 0 ? option("Später in dieser Woche nachholen", `Bleibt offen – noch ${daysLeft} ${daysLeft === 1 ? "Tag" : "Tage"} in dieser Woche.`,
      () => openMove(block, week, { ausfall: extra() })) : null,
    recommended ? option(`Stattdessen: ${recommended.title}`, recommended.effect, () => chooseSubstitute(block, recommended, extra())) : null,
    option("Diese Woche weglassen", skip.effect || "Wird nicht nachgeholt.", () => chooseSubstitute(block, skip, extra()), "option option-skip"),
    el("span", { class: "muted small", text: "Claude sieht den Grund beim nächsten Abgleich und passt die folgenden Wochen bei Bedarf an." }));
  openSheet("Fällt aus", body);
}

/** Baustein auf einen anderen Tag dieser Woche schieben. Nach „Fällt aus → Nachholen“ zusätzlich die Wahl speichern. */
function openMove(block, week, { ausfall = null } = {}) {
  const targets = moveTargets(week, block, today());
  const body = el("div", { class: "sheet-content" },
    el("p", { class: "muted", text: `${block.title} · ${block.minutes} min · jetzt ${block.day ? fmtDay(block.day) : "ohne Tag"}${block.planned_day ? ` (geplant ${fmtDay(block.planned_day)})` : ""}` }),
    el("strong", { text: ausfall ? "Wann holst du es nach?" : "Auf welchen Tag?" }));
  const list = el("div", { class: "move-days", role: "list" });
  for (const t of targets) {
    const info = t.why === "vorbei" ? "vorbei" : t.why === "gesperrt" ? ((week.unavailable || []).find((u) => u.date === t.day)?.text || "gesperrt")
      : t.why === "aktuell" ? "jetzt hier" : t.others.length ? `dazu: ${t.others.map((o) => o.title).join(", ")}` : "frei";
    list.append(el("button", { type: "button", role: "listitem", class: "option move-day" + (t.why === "aktuell" ? " active" : ""), disabled: !t.ok,
      "aria-label": `${fmtDay(t.day)}: ${info}${t.planned ? ", Plantag" : ""}`,
      onclick: () => saveMove(block, t.day, ausfall) },
      el("strong", { text: fmtDay(t.day) + (t.planned ? " · Plantag" : "") }), el("span", { text: info })));
  }
  body.append(list);
  if (ausfall) body.append(btn("Tag noch offen lassen", () => chooseSubstitute(block, { id: "nachholen", title: "Nachholen" }, ausfall), "btn full"));
  else if (block.planned_day && targets.find((t) => t.day === block.planned_day)?.ok) body.append(btn(`Zurück auf ${fmtDay(block.planned_day)}`, () => saveMove(block, block.planned_day), "btn full"));
  if (!targets.some((t) => t.ok)) body.append(el("p", { class: "muted", text: "In dieser Woche ist kein Tag mehr frei." }));
  openSheet(ausfall ? "Nachholen" : "Verschieben", body);
}

async function saveMove(block, day, ausfall = null) {
  const now = new Date().toISOString();
  const item = { block_id: block.id, day, from_day: block.planned_day || block.day || null, created_at: now, source: "app" };
  try {
    sheetStatus("Speichere …");
    if (ausfall) {
      const choice = { block_id: block.id, substitute_id: "nachholen", ...ausfall, created_at: now, source: "app" };
      await save(inboxName("inbox/app/choices", block.id), choice, `App: Ersatz ${block.id} → nachholen`);
      state.choices.push(choice);
    }
    await save(inboxName("inbox/app/moves", block.id), item, `App: ${block.id} → ${day}`);
    state.moves.push(item);
    refreshPlan();
    $("#sheet").close();
    render();
  } catch (e) { sheetStatus(e.message, "error"); }
}

async function chooseSubstitute(block, sub, extra = {}) {
  const item = { block_id: block.id, substitute_id: sub.id, ...extra, created_at: new Date().toISOString(), source: "app" };
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
  $("#btn-add").addEventListener("click", openAdd);
  $("#btn-add-side").addEventListener("click", openAdd);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-side").addEventListener("click", openSettings);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#btn-cancel").addEventListener("click", () => $("#settings").close());
  $("#btn-forget").addEventListener("click", () => { store.del(KEY_TOKEN); $("#f-token").value = ""; setStatus("Token auf diesem Gerät gelöscht.", "ok"); });
  $("#sheet-close").addEventListener("click", () => $("#sheet").close());
  show(["heute", "plan", "weg", "fortschritt"].includes(state.view) ? state.view : "heute");
  loadAll();
});

import { DEFAULTS, TYPE_LABELS, loadJson, listDir, putJson, fmtDuration, fmtKm, fmtDay } from "./data.js?v=2026.11.15-2";
import { APP_VERSION } from "./version.js?v=2026.11.15-2";
import { checkForUpdate, reloadUrl } from "./update.js?v=2026.11.15-2";
import {
  STATES, weekFor, matchWeek, evaluate, latestChoices, latestFeedback, pendingFeedback, daysUntil,
  spontaneousFor, inboxName, isoDate, minutesOf,
} from "./plan.js?v=2026.11.15-2";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const KEY_SETTINGS = "fh.settings";
const KEY_TOKEN = "fh.token";
const KEY_VIEW = "fh.view";

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

// ---------------------------------------------------------------- Zustand
const state = {
  plan: null, workouts: [], strength: [], feedback: [], choices: [], loaded: false,
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
    const [plan, wdoc, sdoc, fdoc, cdoc, fInbox, cInbox] = await Promise.all([
      loadJson(settings, `${dir}/plan.json`, token, null),
      loadJson(settings, `${dir}/workouts.json`, token, { workouts: [] }),
      loadJson(settings, `${dir}/strength.json`, token, { exercises: [] }),
      loadJson(settings, `${dir}/feedback.json`, token, { feedback: [] }),
      loadJson(settings, `${dir}/choices.json`, token, { choices: [] }),
      listDir(settings, "inbox/app/feedback", token),
      listDir(settings, "inbox/app/choices", token),
    ]);
    // Noch nicht übernommene Einträge aus dem App-Eingang dazunehmen
    const pending = await Promise.all([...fInbox, ...cInbox].slice(0, 60).map((p) => loadJson(settings, p, token, null).catch(() => null)));
    state.plan = plan;
    state.workouts = wdoc.workouts || [];
    state.strength = sdoc.exercises || [];
    state.feedback = [...(fdoc.feedback || []), ...pending.filter((x) => x && x.workout_id)];
    state.choices = [...(cdoc.choices || []), ...pending.filter((x) => x && x.block_id)];
    state.loaded = true;
    setStatus(plan ? "" : "Noch kein Trainingsplan im Daten-Repo (plan.json fehlt).", plan ? "" : "warn");
  } catch (e) {
    setStatus(e.message, "error");
  }
  render();
}

async function save(path, obj, message) {
  await putJson(getSettings(), path, obj, getToken(), message);
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
  return matchWeek(week, state.workouts, latestChoices(state.choices));
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

  // Rückmeldungen
  for (const w of pendingFeedback(state.workouts, fbm, state.plan, t).slice(0, 3)) {
    colA.append(el("section", { class: "card card-accent" },
      el("span", { class: "eyebrow", text: "Neue Einheit" }),
      el("strong", { text: workoutLine(w) }),
      btn("Wie war's?", () => openFeedback(w), "btn primary")));
  }

  // Nächster Baustein
  const next = m.blocks.find((b) => b.status === "open");
  if (wf.before) {
    colA.append(el("section", { class: "card" }, el("span", { class: "eyebrow", text: "Bald geht's los" }),
      el("strong", { class: "big", text: `Woche 1 startet am ${fmtDay(wf.week.start)}` }),
      el("span", { class: "muted", text: wf.week.focus })));
  }
  if (next) {
    const b = next.block;
    colA.append(el("section", { class: "card card-next" },
      el("span", { class: "eyebrow", text: wf.before ? "Erster Baustein" : "Nächster Baustein" }),
      el("strong", { class: "big", text: b.substitute ? `${b.title} → ${b.substitute.title}` : b.title }),
      el("span", { class: "muted", text: `${b.minutes} min · ${b.where}` }),
      el("span", { text: b.details }),
      el("div", { class: "row" }, btn("Ersatz", () => openErsatz(b, wf.week)))));
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
  for (const b of m.blocks) {
    list.append(el("li", {}, el("span", { text: b.block.title }),
      el("span", { class: `tag tag-${b.status}`, text: b.status === "done" ? "erledigt" : b.status === "skipped" ? "weggelassen" : "offen" })));
  }
  wk.append(list, btn("Zum Wochenplan", () => show("plan"), "btn link-btn"));
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
  if (week.note) root.append(el("p", { class: "note", text: week.note }));

  const grid = el("div", { class: "cards" });
  for (const mb of m.blocks) {
    const b = mb.block;
    const card = el("section", { class: `card block block-${mb.status}` });
    card.append(el("div", { class: "row between" }, el("strong", { text: b.title }),
      el("span", { class: `tag tag-${mb.status}`, text: mb.status === "done" ? `erledigt ${fmtDay(mb.workout.start_local).slice(0, 2)}` : mb.status === "skipped" ? "weggelassen" : `${b.minutes} min` })));
    if (b.substitute && !b.skipped) card.append(el("span", { class: "muted", text: `Ersatz: ${b.substitute.title}` }));
    if (mb.status === "done") {
      card.append(el("span", { class: "muted", text: workoutLine(mb.workout, mb.parts) }));
      const ev = evaluate(mb, fbm[mb.workout.id], state.strength, labels());
      card.append(corridorRows(ev), el("p", { class: "advice", text: ev.advice }));
      if (!fbm[mb.workout.id]) card.append(btn("Rückmeldung geben", () => openFeedback(mb.workout), "btn primary"));
    } else if (mb.status === "open") {
      card.append(el("span", { class: "muted", text: b.where }), el("span", { text: b.details }),
        el("div", { class: "row" }, btn("Ersatz", () => openErsatz(b, week))));
    } else {
      card.append(el("span", { class: "muted", text: b.substitute?.effect || "" }),
        el("div", { class: "row" }, btn("Doch machen", () => chooseSubstitute(b, { id: "plan", title: "Wie geplant" }))));
    }
    grid.append(card);
  }
  root.append(grid);

  if (m.extra.length) {
    root.append(el("h2", { class: "section-title", text: "Zusätzlich" }),
      el("ul", { class: "plain-list" }, ...m.extra.map((w) => el("li", { text: workoutLine(w) }))));
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
      el("ul", { class: "plain-list" }, ...recent.map((w) => el("li", { text: workoutLine(w) })))))));
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
      await save(inboxName("inbox/app/requests", `w${week.week}-${request}`),
        { week: week.week, request, created_at: new Date().toISOString(), source: "app" },
        `App: Woche ${week.week} ${request}`);
      $("#sheet-body").replaceChildren(el("p", { text: "Wunsch gespeichert. Claude passt den Plan beim nächsten Abgleich an – du siehst die Änderung dann hier." }));
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
  $("#settings").showModal();
}
function saveSettings(ev) {
  ev.preventDefault();
  store.set(KEY_SETTINGS, JSON.stringify({ repo: $("#f-repo").value.trim(), branch: $("#f-branch").value.trim(), dataDir: $("#f-dir").value.trim().replace(/\/+$/, "") }));
  const token = $("#f-token").value.trim();
  store.del(KEY_TOKEN);
  if (token) store.set(KEY_TOKEN, token, $("#f-remember").checked ? localStorage : sessionStorage);
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

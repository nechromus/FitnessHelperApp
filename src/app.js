import { DEFAULTS, TYPE_LABELS, loadFromGitHub, parseDoc, summarize, fmtDuration, fmtKm, fmtDate } from "./data.js";

const $ = (sel) => document.querySelector(sel);
const KEY_SETTINGS = "fh.settings";
const KEY_TOKEN = "fh.token";

// Speicher kann in manchen Umgebungen fehlen oder werfen
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* ignorieren */ } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignorieren */ } },
};

function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(store.get(KEY_SETTINGS) || "{}") }; } catch { return { ...DEFAULTS }; }
}
function getToken() { return store.get(KEY_TOKEN, sessionStorage) || store.get(KEY_TOKEN) || ""; }

function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = "status " + kind;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render(doc, origin) {
  const ws = [...doc.workouts].sort((a, b) => (b.start_utc || "").localeCompare(a.start_utc || ""));
  const s = summarize(ws);
  $("#sample-badge").hidden = !doc.sample;
  $("#origin").textContent = origin;

  const tiles = $("#tiles");
  tiles.replaceChildren(
    tile("Einheiten", String(s.count)),
    tile("Distanz", fmtKm(s.distance_m)),
    tile("Zeit", fmtDuration(s.duration_s)),
    tile("Zeitraum", s.from ? `${fmtDate(s.from)} – ${fmtDate(s.to)}` : "–"),
  );

  const list = $("#workouts");
  list.replaceChildren();
  if (!ws.length) list.append(el("li", "empty", "Noch keine Einheiten in dieser Datei."));
  for (const w of ws) {
    const li = el("li", "workout");
    const head = el("div", "w-head");
    head.append(el("span", `w-type t-${w.type}`, TYPE_LABELS[w.type] || w.type), el("span", "w-date", fmtDate(w.start_local)));
    const name = el("div", "w-name", w.name || "(ohne Titel)");
    const facts = el("div", "w-facts");
    facts.append(
      el("span", null, fmtDuration(w.duration_s)),
      el("span", null, fmtKm(w.distance_m)),
      el("span", null, w.hr_avg ? `Ø ${w.hr_avg} bpm` : "Puls –"),
    );
    li.append(head, name, facts);
    list.append(li);
  }
  $("#content").hidden = false;
}

function tile(label, value) {
  const t = el("div", "tile");
  t.append(el("div", "tile-value", value), el("div", "tile-label", label));
  return t;
}

async function loadRemote() {
  const settings = getSettings();
  const token = getToken();
  if (!token) { openSettings(); setStatus("Bitte zuerst einen Lese-Token eintragen.", "warn"); return; }
  setStatus("Lade …");
  try {
    const doc = await loadFromGitHub(settings, token);
    render(doc, `${settings.repo} · ${settings.path}`);
    setStatus(`Geladen: ${doc.count ?? doc.workouts.length} Einheiten`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function loadLocal(file) {
  try {
    const doc = parseDoc(await file.text());
    render(doc, `lokale Datei · ${file.name}`);
    setStatus(`Geladen: ${doc.workouts.length} Einheiten`, "ok");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function openSettings() {
  const s = getSettings();
  $("#f-repo").value = s.repo;
  $("#f-branch").value = s.branch;
  $("#f-path").value = s.path;
  $("#f-token").value = getToken();
  $("#f-remember").checked = !!store.get(KEY_TOKEN);
  $("#settings").showModal();
}

function saveSettings(ev) {
  ev.preventDefault();
  store.set(KEY_SETTINGS, JSON.stringify({
    repo: $("#f-repo").value.trim(), branch: $("#f-branch").value.trim(), path: $("#f-path").value.trim(),
  }));
  const token = $("#f-token").value.trim();
  store.del(KEY_TOKEN);
  if (token) store.set(KEY_TOKEN, token, $("#f-remember").checked ? localStorage : sessionStorage);
  $("#settings").close();
  loadRemote();
}

document.addEventListener("DOMContentLoaded", () => {
  $("#btn-load").addEventListener("click", loadRemote);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#btn-cancel").addEventListener("click", () => $("#settings").close());
  $("#btn-forget").addEventListener("click", () => { store.del(KEY_TOKEN); $("#f-token").value = ""; setStatus("Token auf diesem Gerät gelöscht.", "ok"); });
  $("#file").addEventListener("change", (e) => e.target.files[0] && loadLocal(e.target.files[0]));
  if (getToken()) loadRemote();
  else setStatus("Noch keine Daten. Token unter ⚙︎ eintragen oder eine JSON-Datei öffnen.");
});

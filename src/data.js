// Laden und Aufbereiten der Daten aus FitnessData. Keine DOM-Zugriffe (testbar mit node).

export const API_HOST = "https://api.github.com";

export const DEFAULTS = {
  repo: "nechromus/FitnessHelperAppData",
  branch: "main",
  path: "data/sample/workouts.sample.json",
};

export const TYPE_LABELS = {
  run: "Laufen", ride: "Radfahren", walk: "Gehen", hike: "Wandern", swim: "Schwimmen",
  strength: "Kraft", workout: "Training", ski_alpine: "Ski alpin", snowboard: "Snowboard",
  ski_nordic: "Langlauf", ski_touring: "Skitour", yoga: "Yoga", rowing: "Rudern", other: "Sonstiges",
};

/** Baut die API-URL. Nur api.github.com ist erlaubt – der Token geht nirgendwo anders hin. */
export function contentsUrl({ repo, branch, path }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repo muss die Form besitzer/name haben");
  if (!/^[\w./-]+\.json$/.test(path) || path.includes("..")) throw new Error("Pfad muss auf .json enden");
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `${API_HOST}/repos/${repo}/contents/${enc}?ref=${encodeURIComponent(branch || "main")}`;
}

export async function loadFromGitHub(settings, token, fetchImpl = fetch) {
  const url = contentsUrl(settings);
  if (!url.startsWith(API_HOST + "/")) throw new Error("Unerlaubter Host");
  const headers = { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, cache: "no-store" });
  if (res.status === 401) throw new Error("Token ungültig oder abgelaufen (401)");
  if (res.status === 404) throw new Error("Datei oder Repo nicht gefunden (404) – Token braucht Lesezugriff auf das private Repo");
  if (!res.ok) throw new Error(`GitHub-Fehler ${res.status}`);
  return parseDoc(await res.text());
}

export function parseDoc(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("Keine gültige JSON-Datei"); }
  if (!doc || !Array.isArray(doc.workouts)) throw new Error("Datei enthält kein Feld 'workouts'");
  if (doc.schema_version !== 1) throw new Error(`Schema-Version ${doc.schema_version} wird nicht unterstützt`);
  return doc;
}

export function summarize(workouts) {
  const s = { count: workouts.length, distance_m: 0, duration_s: 0, from: null, to: null, byType: {} };
  for (const w of workouts) {
    s.distance_m += w.distance_m || 0;
    s.duration_s += w.duration_s || 0;
    const d = w.start_local?.slice(0, 10);
    if (d && (!s.from || d < s.from)) s.from = d;
    if (d && (!s.to || d > s.to)) s.to = d;
    s.byType[w.type] = (s.byType[w.type] || 0) + 1;
  }
  return s;
}

export function fmtDuration(sec) {
  if (sec == null) return "–";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

export function fmtKm(m) {
  if (!m) return "–";
  return (m / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";
}

export function fmtDate(local) {
  if (!local) return "–";
  const [y, mo, d] = local.slice(0, 10).split("-");
  return `${d}.${mo}.${y}`;
}

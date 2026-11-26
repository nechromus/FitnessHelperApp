// Laden und Schreiben über die GitHub-API, Formatierung. Keine DOM-Zugriffe (testbar mit node).

export const API_HOST = "https://api.github.com";

export const DEFAULTS = {
  repo: "nechromus/FitnessHelperAppData",
  branch: "main",
  path: "data/sample/workouts.sample.json",
  dataDir: "data",
};

export const TYPE_LABELS = {
  run: "Laufen", ride: "Radfahren", walk: "Gehen", hike: "Wandern", swim: "Schwimmen",
  strength: "Kraft", workout: "Training", ski_alpine: "Ski alpin", snowboard: "Snowboard",
  ski_nordic: "Langlauf", ski_touring: "Skitour", yoga: "Yoga", rowing: "Rudern", paddle: "Paddeln", other: "Sonstiges",
};

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const PATH_RE = /^[\w./-]+$/;

function checkRepoPath(repo, path) {
  if (!REPO_RE.test(repo)) throw new Error("Repo muss die Form besitzer/name haben");
  if (!PATH_RE.test(path) || path.includes("..") || path.startsWith("/")) throw new Error("Ungültiger Pfad");
}

/** Baut die API-URL. Nur api.github.com ist erlaubt – der Token geht nirgendwo anders hin. */
export function contentsUrl({ repo, branch, path }) {
  checkRepoPath(repo, path);
  if (!path.endsWith(".json")) throw new Error("Pfad muss auf .json enden");
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `${API_HOST}/repos/${repo}/contents/${enc}?ref=${encodeURIComponent(branch || "main")}`;
}

function dirUrl({ repo, branch }, path) {
  checkRepoPath(repo, path);
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `${API_HOST}/repos/${repo}/contents/${enc}?ref=${encodeURIComponent(branch || "main")}`;
}

function headers(token, raw = true) {
  const h = { Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function httpError(res, what) {
  if (res.status === 401) return new Error("Token ungültig oder abgelaufen (401)");
  if (res.status === 403) return new Error(`Keine Berechtigung für ${what} (403) – Token-Rechte prüfen`);
  if (res.status === 404) return new Error(`${what} nicht gefunden (404) – Token braucht Zugriff auf das private Repo`);
  return new Error(`GitHub-Fehler ${res.status} bei ${what}`);
}

export async function loadFromGitHub(settings, token, fetchImpl = fetch) {
  const url = contentsUrl(settings);
  if (!url.startsWith(API_HOST + "/")) throw new Error("Unerlaubter Host");
  const res = await fetchImpl(url, { headers: headers(token), cache: "no-store" });
  if (!res.ok) throw httpError(res, "Datei oder Repo");
  return parseDoc(await res.text());
}

/** Lädt eine JSON-Datei aus dem Repo; fehlende Datei (404) → fallback. */
export async function loadJson(settings, path, token, fallback = null, fetchImpl = fetch) {
  const res = await fetchImpl(contentsUrl({ ...settings, path }), { headers: headers(token), cache: "no-store" });
  if (res.status === 404 && fallback !== undefined) return fallback;
  if (!res.ok) throw httpError(res, path);
  try { return JSON.parse(await res.text()); } catch { throw new Error(`${path}: kein gültiges JSON`); }
}

/** Dateien eines Ordners (nur Namen/Pfade); fehlender Ordner → []. */
export async function listDir(settings, path, token, fetchImpl = fetch) {
  const res = await fetchImpl(dirUrl(settings, path), { headers: headers(token, false), cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) throw httpError(res, path);
  const items = await res.json();
  return Array.isArray(items) ? items.filter((i) => i.type === "file" && i.name.endsWith(".json")).map((i) => i.path) : [];
}

export function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Gibt es die Datei schon? (z. B. Upload war erfolgreich, aber die Antwort kam bei schwachem Empfang nicht an) */
async function fileExists(settings, path, token, fetchImpl) {
  const res = await fetchImpl(dirUrl(settings, path), { method: "GET", headers: headers(token, false), cache: "no-store" });
  return res.ok;
}

/** Legt eine neue JSON-Datei an (nur für inbox/app/…). */
export async function putJson(settings, path, obj, token, message, fetchImpl = fetch) {
  if (!path.startsWith("inbox/app/")) throw new Error("Die App schreibt nur nach inbox/app/");
  const url = contentsUrl({ ...settings, path }).replace(/\?ref=.*$/, "");
  const body = { message, content: toBase64Utf8(JSON.stringify(obj, null, 1) + "\n"), branch: settings.branch || "main" };
  const res = await fetchImpl(url, { method: "PUT", headers: { ...headers(token, false), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // 422 = Datei existiert schon: früherer Versuch kam an, nur die Antwort ging verloren → erledigt
  if (res.status === 422 && await fileExists(settings, path, token, fetchImpl)) return true;
  if (!res.ok) throw httpError(res, "Speichern");
  return true;
}

/** Base64 aus Bytes (für Fotos). */
export function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Legt ein JPEG-Foto an – ausschließlich unter inbox/app/photos/. */
export async function putPhoto(settings, path, bytes, token, message, fetchImpl = fetch) {
  if (!/^inbox\/app\/photos\/[A-Za-z0-9_-]+\.jpg$/.test(path)) throw new Error("Fotos nur nach inbox/app/photos/*.jpg");
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Foto zu groß");
  const url = dirUrl(settings, path).replace(/\?ref=.*$/, "");
  const body = { message, content: bytesToBase64(bytes), branch: settings.branch || "main" };
  const res = await fetchImpl(url, { method: "PUT", headers: { ...headers(token, false), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 422 && await fileExists(settings, path, token, fetchImpl)) return true;
  if (!res.ok) throw httpError(res, "Foto speichern");
  return true;
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

const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
export function fmtDay(local) {
  if (!local) return "–";
  const d = new Date(local.slice(0, 10) + "T00:00:00");
  return `${WD[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
}

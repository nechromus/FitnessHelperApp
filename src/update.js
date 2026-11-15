// Prüft, ob auf dem Server eine neuere App-Version liegt. Ohne DOM (testbar mit node).
// Quelle der Wahrheit: version.json im Repo-Stamm; APP_VERSION steht in src/version.js.
// Beide werden nur über tools/bump_version.py geändert.

/** Vergleicht Versionen wie "2026.11.15-2" Teil für Teil numerisch. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Fragt version.json ab (am Browser-Cache vorbei). Liefert {version, notes} oder null, wenn nichts Neues. */
export async function checkForUpdate(current, fetchImpl = fetch, url = "version.json") {
  const res = await fetchImpl(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`version.json: HTTP ${res.status}`);
  const info = await res.json();
  if (!info || typeof info.version !== "string") throw new Error("version.json ungültig");
  return compareVersions(info.version, current) > 0
    ? { version: info.version, notes: typeof info.notes === "string" ? info.notes : "" }
    : null;
}

/** Ziel-URL zum Neuladen: hängt die neue Version an, damit iOS die Startseite nicht aus dem Cache nimmt. */
export function reloadUrl(href, version) {
  const u = new URL(href);
  u.searchParams.set("v", version);
  u.hash = "";
  return u.toString();
}

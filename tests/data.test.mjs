// Aufruf: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentsUrl, loadFromGitHub, parseDoc, summarize, fmtDuration, fmtKm, fmtDate, DEFAULTS, putPhoto, bytesToBase64 } from "../src/data.js";

const doc = { schema_version: 1, count: 2, workouts: [
  { id: "strava:1", type: "run", start_local: "2026-09-06T07:30:12", start_utc: "2026-09-06T05:30:12Z", duration_s: 2410, distance_m: 6120.4 },
  { id: "strava:2", type: "strength", start_local: "2026-09-12T20:05:00", start_utc: "2026-09-12T18:05:00Z", duration_s: 2700, distance_m: 0 },
] };

test("URL zeigt nur auf api.github.com", () => {
  assert.equal(contentsUrl(DEFAULTS),
    "https://api.github.com/repos/nechromus/FitnessHelperAppData/contents/data/sample/workouts.sample.json?ref=main");
  assert.throws(() => contentsUrl({ ...DEFAULTS, repo: "evil.com/x/y" }));
  assert.throws(() => contentsUrl({ ...DEFAULTS, path: "../secrets.json" }));
  assert.throws(() => contentsUrl({ ...DEFAULTS, path: "data/x.txt" }));
});

test("Token wird als Bearer an GitHub gesendet", async () => {
  let seen;
  const fake = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, text: async () => JSON.stringify(doc) }; };
  const d = await loadFromGitHub(DEFAULTS, "tok123", fake);
  assert.equal(d.workouts.length, 2);
  assert.ok(seen.url.startsWith("https://api.github.com/"));
  assert.equal(seen.opts.headers.Authorization, "Bearer tok123");
});

test("Fehlermeldungen bei 401/404", async () => {
  const mk = (status) => async () => ({ ok: false, status, text: async () => "" });
  await assert.rejects(loadFromGitHub(DEFAULTS, "x", mk(401)), /401/);
  await assert.rejects(loadFromGitHub(DEFAULTS, "x", mk(404)), /404/);
});

test("parseDoc prüft Schema", () => {
  assert.throws(() => parseDoc("kein json"), /JSON/);
  assert.throws(() => parseDoc("{}"), /workouts/);
  assert.throws(() => parseDoc('{"schema_version":2,"workouts":[]}'), /Schema-Version/);
});

test("Zusammenfassung und Formatierung", () => {
  const s = summarize(doc.workouts);
  assert.equal(s.count, 2);
  assert.equal(s.from, "2026-09-06");
  assert.equal(s.to, "2026-09-12");
  assert.equal(s.byType.run, 1);
  assert.equal(fmtDuration(2410), "40 min");
  assert.equal(fmtDuration(5110), "1 h 25 min");
  assert.equal(fmtKm(6120.4), "6,1 km");
  assert.equal(fmtKm(0), "–");
  assert.equal(fmtDate("2026-09-06T07:30:12"), "06.09.2026");
});

// ---------------------------------------------------------------- Update-Prüfung
import { compareVersions, checkForUpdate, reloadUrl } from "../src/update.js";
import { APP_VERSION } from "../src/version.js";
import { readFileSync, readdirSync } from "node:fs";

test("Versionen vergleichen", () => {
  assert.equal(compareVersions("2026.11.15-2", "2026.11.15-1"), 1);
  assert.equal(compareVersions("2026.11.15-10", "2026.11.15-9"), 1);
  assert.equal(compareVersions("2026.12.01-1", "2026.11.30-5"), 1);
  assert.equal(compareVersions("2026.11.15-1", "2026.11.15-1"), 0);
  assert.equal(compareVersions("2026.11.14-3", "2026.11.15-1"), -1);
});

test("Update wird nur bei neuerer Version gemeldet", async () => {
  const mk = (v) => async (url, opts) => {
    assert.match(url, /^version\.json\?t=\d+$/);
    assert.equal(opts.cache, "no-store");
    return { ok: true, json: async () => ({ version: v, notes: "Neu" }) };
  };
  assert.deepEqual(await checkForUpdate("2026.11.15-1", mk("2026.11.15-2")), { version: "2026.11.15-2", notes: "Neu" });
  assert.equal(await checkForUpdate("2026.11.15-1", mk("2026.11.15-1")), null);
  assert.equal(await checkForUpdate("2026.11.15-2", mk("2026.11.15-1")), null);
  await assert.rejects(checkForUpdate("1", async () => ({ ok: false, status: 404 })), /404/);
});

test("Neuladen-URL umgeht den Cache", () => {
  assert.equal(reloadUrl("https://x.github.io/App/?v=old#a", "2026.11.15-2"), "https://x.github.io/App/?v=2026.11.15-2");
});

test("Versionsangaben sind überall gleich", () => {
  const root = new URL("..", import.meta.url);
  const vj = JSON.parse(readFileSync(new URL("version.json", root), "utf8")).version;
  assert.equal(APP_VERSION, vj);
  const files = ["index.html", ...readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".js")).map((f) => "src/" + f)];
  for (const f of files) {
    for (const m of readFileSync(new URL(f, root), "utf8").matchAll(/\?v=([\d.-]+)/g)) {
      assert.equal(m[1], vj, `${f} verweist auf ?v=${m[1]}`);
    }
  }
});

test("Fotos nur nach inbox/app/photos/*.jpg, als Base64 an api.github.com", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(bytesToBase64(bytes), "/9j/2Q==");
  let seen = null;
  const fake = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201 }; };
  await putPhoto(DEFAULTS, "inbox/app/photos/20261116T110000_w1-kraft-a.jpg", bytes, "t", "m", fake);
  assert.ok(seen.url.startsWith("https://api.github.com/repos/"));
  assert.equal(seen.opts.method, "PUT");
  assert.equal(JSON.parse(seen.opts.body).content, "/9j/2Q==");
  for (const bad of ["data/x.jpg", "inbox/app/photos/../x.jpg", "inbox/app/photos/x.png", "inbox/app/feedback/x.jpg"]) {
    await assert.rejects(() => putPhoto(DEFAULTS, bad, bytes, "t", "m", fake));
  }
});

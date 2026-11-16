// Aufruf: node --test tests/plan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categories, matchWeek, evaluate, effortState, rangeState, weekFor, latestChoices, latestFeedback,
  pendingFeedback, warmupIds, daysUntil, spontaneousFor, inboxName, effectiveBlock, totalMinutes, STATES,
} from "../src/plan.js";
import { putJson, toBase64Utf8, listDir, loadJson, DEFAULTS } from "../src/data.js";

const LABELS = ["locker", "machbar", "fordernd", "musste beißen", "zu viel"];
const sub = (id, minutes, accepts, extra = {}) => ({ id, title: id, minutes, accepts, effect: "", ...extra });
const week = {
  week: 1, start: "2026-11-16", end: "2026-11-22", focus: "Test",
  blocks: [
    { id: "w1-kraft-a", kind: "kraft_a", title: "Kraft A", minutes: 70, accepts: ["studio"],
      corridor: { minutes: [60, 80], effort: [2, 3], leg_extension_kg: [21, 23] },
      substitutes: [sub("heim-45", 45, ["strength"]), sub("weglassen", 0, [])] },
    { id: "w1-lang", kind: "lang", title: "Lang", minutes: 60, accepts: ["endurance"], min_share: 0.75,
      corridor: { minutes: [51, 69], effort: [1, 2] }, substitutes: [sub("weglassen", 0, [])] },
    { id: "w1-kraft-b", kind: "kraft_b", title: "Kraft B", minutes: 45, accepts: ["strength"],
      corridor: { minutes: [38, 52], effort: [2, 3] }, substitutes: [] },
    { id: "w1-frei", kind: "frei", title: "Training nach Wahl", minutes: 40, accepts: ["endurance", "strength"],
      corridor: { minutes: [34, 46], effort: [2, 3] }, substitutes: [] },
  ],
};
const W = (id, type, source, start_local, mins, extra = {}) => ({
  id, type, source, start_local, start_utc: start_local.replace(" ", "T") + "Z",
  duration_s: mins * 60, moving_s: mins * 60, ...extra,
});
const workouts = [
  W("strava:1", "ride", "strava", "2026-11-16T11:32:00", 14, { name: "Bike 700 Excite Live: Cross training" }),
  W("technogym:session-2026-11-16", "strength", "technogym", "2026-11-16T11:47:00", 45),
  W("strava:2", "run", "strava", "2026-11-19T12:10:00", 41, { distance_m: 4600 }),
  W("strava:3", "run", "strava", "2026-11-21T10:00:00", 62, { distance_m: 7400 }),
  W("strava:4", "rowing", "strava", "2026-11-22T17:00:00", 25),
  W("strava:5", "strength", "strava", "2026-11-16T11:48:00", 44, { duplicate_of: "technogym:session-2026-11-16" }),
  W("strava:9", "run", "strava", "2026-11-25T12:00:00", 40),
];

test("Kategorien", () => {
  assert.deepEqual(categories({ type: "strength", source: "technogym" }), ["studio", "strength"]);
  assert.deepEqual(categories({ type: "strength", source: "strava" }), ["strength"]);
  assert.deepEqual(categories({ type: "run" }), ["endurance"]);
});

test("Zuordnung der Woche: Studio + Aufwärmen, längste Einheit als Lang, Rest frei", () => {
  const m = matchWeek(week, workouts, {});
  const by = Object.fromEntries(m.blocks.map((b) => [b.block.kind, b]));
  assert.equal(by.kraft_a.workout.id, "technogym:session-2026-11-16");
  assert.deepEqual(by.kraft_a.parts.map((p) => p.id), ["strava:1"]);  // Rad-Aufwärmen gehört dazu
  assert.equal(totalMinutes(by.kraft_a), 59);
  assert.equal(by.lang.workout.id, "strava:3");
  assert.equal(by.kraft_b.status, "open");
  assert.equal(by.frei.workout.id, "strava:2");
  assert.deepEqual(m.extra.map((w) => w.id), ["strava:4"]);  // Dubletten und andere Wochen fehlen
});

test("Ersatz: Heimprogramm statt Studio, Weglassen", () => {
  const ch = latestChoices([
    { block_id: "w1-kraft-a", substitute_id: "weglassen", created_at: "2026-11-16T08:00:00Z" },
    { block_id: "w1-kraft-a", substitute_id: "heim-45", created_at: "2026-11-16T09:00:00Z" },
    { block_id: "w1-lang", substitute_id: "weglassen", created_at: "2026-11-16T09:00:00Z" },
  ]);
  const m = matchWeek(week, [W("strava:7", "strength", "strava", "2026-11-17T18:00:00", 46)], ch);
  const by = Object.fromEntries(m.blocks.map((b) => [b.block.kind, b]));
  assert.equal(by.kraft_a.workout.id, "strava:7");
  assert.equal(by.kraft_a.block.minutes, 45);
  assert.deepEqual(by.kraft_a.block.corridor.minutes, [39, 51]);
  assert.equal(by.lang.status, "skipped");
  assert.equal(effectiveBlock(week.blocks[0], { substitute_id: "plan" }).substitute, null);
});

test("Korridor: darüber = besser, höhere Anstrengung = darunter", () => {
  assert.equal(rangeState(50, [60, 80]), STATES.below);
  assert.equal(rangeState(85, [60, 80]), STATES.above);
  assert.equal(effortState(4, [2, 3]), STATES.below);
  assert.equal(effortState(1, [2, 3]), STATES.above);
  assert.equal(effortState(3, [2, 3]), STATES.in);
});

test("Bewertung einer Einheit mit Beinstrecker und Rückmeldung", () => {
  const m = matchWeek(week, workouts, {});
  const ka = m.blocks[0];
  const strength = [{ session_id: "technogym:session-2026-11-16", exercise: "leg_extension", is_test: false, avg_weight_kg: 24 }];
  const ev = evaluate(ka, { effort: 4, knee: 0 }, strength, LABELS);
  const st = Object.fromEntries(ev.rows.map((r) => [r.key, r.state]));
  assert.equal(st.minutes, STATES.below);   // 59 von 60–80
  assert.equal(st.leg, STATES.above);       // 24 kg > 23
  assert.equal(st.effort, STATES.below);    // musste beißen
  assert.match(ev.advice, /Gewicht halten/);
  const knee = evaluate(ka, { effort: 2, knee: 2 }, strength, LABELS);
  assert.match(knee.advice, /Knie/);
  const none = evaluate(m.blocks[3], null, [], LABELS);
  assert.equal(none.rows.find((r) => r.key === "effort").state, null);
});

test("Woche, offene Rückmeldungen, Countdown, Spontan, Dateiname", () => {
  const plan = { weeks: [week, { ...week, week: 2, start: "2026-11-23", end: "2026-11-29" }],
    spontaneous: [{ minutes: 20, counts_as: "kraft_b", title: "Kurz" }, { minutes: 30, counts_as: "frei", title: "Rudern" }] };
  assert.equal(weekFor(plan, "2026-11-15").before, true);
  assert.equal(weekFor(plan, "2026-11-25").week.week, 2);
  assert.equal(weekFor(plan, "2027-03-01").after, true);
  const fbm = latestFeedback([{ workout_id: "strava:2", effort: 3, created_at: "x" }]);
  const pend = pendingFeedback(workouts, fbm, plan, "2026-11-22").map((w) => w.id);
  assert.ok(pend.includes("strava:3") && !pend.includes("strava:2") && !pend.includes("strava:5"));
  assert.equal(daysUntil("2027-02-01", "2026-11-15"), 78);
  const m = matchWeek(week, [], {});
  assert.equal(spontaneousFor(plan, 30, m).title, "Rudern");
  assert.equal(inboxName("inbox/app/feedback", "technogym:session-1", new Date("2026-11-17T12:00:00Z")),
    "inbox/app/feedback/20261117T120000_technogym_session-1.json");
});

test("Schreiben nur nach inbox/app/, Base64 mit Umlauten, 404-Verhalten", async () => {
  await assert.rejects(putJson(DEFAULTS, "data/workouts.json", {}, "t", "x", async () => ({ ok: true })), /inbox/);
  let seen;
  await putJson(DEFAULTS, "inbox/app/feedback/a.json", { note: "Knie ruhig, Gegenwind ä" }, "tok", "msg",
    async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201 }; });
  assert.equal(seen.opts.method, "PUT");
  assert.ok(seen.url.startsWith("https://api.github.com/repos/nechromus/FitnessHelperAppData/contents/inbox/app/feedback/a.json"));
  assert.ok(!seen.url.includes("?ref="));
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.branch, "main");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))).includes("Gegenwind ä"), true);
  assert.equal(toBase64Utf8("ä"), "w6Q=");
  assert.deepEqual(await listDir(DEFAULTS, "inbox/app/feedback", "t", async () => ({ status: 404, ok: false })), []);
  assert.equal(await loadJson(DEFAULTS, "data/feedback.json", "t", null, async () => ({ status: 404, ok: false })), null);
  await assert.rejects(putJson(DEFAULTS, "inbox/app/x.json", {}, "t", "m", async () => ({ ok: false, status: 403 })), /403/);
});

test("Uhr-Krafttraining zählt als Studio, wenn es Gerätewerte vom Tag gibt", () => {
  const w = { id: "s:1", type: "strength", source: "strava", start_local: "2030-01-07T12:00:00" };
  assert.deepEqual(categories(w), ["strength"]);
  assert.deepEqual(categories(w, new Set(["2030-01-07"])), ["studio", "strength"]);
});

test("Rad-Aufwärmen zählt zum Studio, auch wenn die Uhr schon vorher läuft", () => {
  const week = { week: 1, start: "2030-01-07", end: "2030-01-13", blocks: [
    { id: "w1-kraft-a", kind: "kraft_a", title: "Kraft A", minutes: 70, accepts: ["studio"], corridor: { minutes: [60, 80] }, substitutes: [] },
    { id: "w1-frei", kind: "frei", title: "Wahl", minutes: 40, accepts: ["endurance", "strength"], corridor: { minutes: [34, 46] }, substitutes: [] }] };
  const ws = [
    { id: "s", type: "strength", source: "strava", start_local: "2030-01-07T11:00:00", start_utc: "2030-01-07T10:00:00Z", duration_s: 3300 },
    { id: "r", type: "ride", source: "strava", name: "Bike 700 Excite Live", start_local: "2030-01-07T11:01:00", start_utc: "2030-01-07T10:01:00Z", duration_s: 840, moving_s: 840 }];
  const m = matchWeek(week, ws, {}, new Set(["2030-01-07"]));
  assert.equal(m.blocks[0].status, "done");
  assert.deepEqual(m.blocks[0].parts.map((p) => p.id), ["r"]);
  assert.equal(m.blocks[1].status, "open");
});

test("Rad-Aufwärmen wird nicht einzeln geführt und braucht keine eigene Rückmeldung", () => {
  const ws = [
    { id: "s", type: "strength", source: "strava", start_local: "2030-01-07T11:00:00", start_utc: "2030-01-07T10:00:00Z", duration_s: 3300 },
    { id: "r", type: "ride", source: "strava", name: "Bike 700 Excite Live", start_local: "2030-01-07T11:01:00", start_utc: "2030-01-07T10:01:00Z", duration_s: 840 },
    { id: "r2", type: "ride", source: "strava", start_local: "2030-01-07T18:00:00", start_utc: "2030-01-07T17:00:00Z", duration_s: 3600 }];
  const ids = warmupIds(ws, new Set(["2030-01-07"]));
  assert.deepEqual([...ids], ["r"]);
  const plan = { weeks: [{ start: "2030-01-07" }] };
  assert.deepEqual(pendingFeedback(ws, {}, plan, "2030-01-08", 10, ids).map((w) => w.id), ["r2", "s"]);
});

test("Radfahrt ins Studio bleibt eigene Einheit, Ergometer zählt zum Krafttraining", () => {
  const ws = [
    { id: "s", type: "strength", source: "strava", start_local: "2030-01-07T11:00:00", start_utc: "2030-01-07T10:00:00Z", duration_s: 3300 },
    { id: "hin", type: "ride", source: "strava", name: "Mittagsradfahrt", start_local: "2030-01-07T10:40:00", start_utc: "2030-01-07T09:40:00Z", duration_s: 1080, elevation_gain_m: 12 },
    { id: "ergo", type: "ride", source: "strava", name: "Bike 700 Excite Live: Cross training", start_local: "2030-01-07T11:01:00", start_utc: "2030-01-07T10:01:00Z", duration_s: 840 }];
  assert.deepEqual([...warmupIds(ws, new Set(["2030-01-07"]))], ["ergo"]);
});

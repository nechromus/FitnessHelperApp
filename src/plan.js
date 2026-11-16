// Plan-Logik: Woche bestimmen, Einheiten den Bausteinen zuordnen, gegen den Zielkorridor bewerten.
// Ohne DOM – mit node testbar.

export const STATES = { below: "darunter", in: "im Ziel", above: "darüber" };

const ENDURANCE = new Set(["run", "ride", "walk", "hike", "swim", "rowing", "paddle", "ski_nordic",
  "ski_touring", "ski_alpine", "snowboard", "workout", "yoga", "other"]);

/** Kategorien einer Einheit: studio (Technogym-Kraftzirkel), strength, endurance.
 *  studioDays: Tage mit Gerätewerten (Technogym-Export oder Fotos) – dann zählt auch
 *  ein mit der Uhr aufgezeichnetes Krafttraining an diesem Tag als Studio. */
export function categories(w, studioDays = null) {
  return cats(w, studioDays);
}
function cats(w, studioDays) {
  if (w.type === "strength") {
    const studio = w.source === "technogym" || (studioDays && studioDays.has((w.start_local || "").slice(0, 10)));
    return studio ? ["studio", "strength"] : ["strength"];
  }
  return ENDURANCE.has(w.type) ? ["endurance"] : [];
}

export function minutesOf(w) {
  const s = w.type === "strength" ? (w.duration_s || w.moving_s) : (w.moving_s || w.duration_s);
  return s ? Math.round(s / 60) : 0;
}

export function isoDate(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Woche des Plans für ein Datum (YYYY-MM-DD). Vor Planbeginn: Woche 1 mit before=true. */
export function weekFor(plan, day) {
  const weeks = plan?.weeks || [];
  if (!weeks.length) return null;
  if (day < weeks[0].start) return { week: weeks[0], before: true, after: false };
  for (const w of weeks) if (day >= w.start && day <= w.end) return { week: w, before: false, after: false };
  return { week: weeks[weeks.length - 1], before: false, after: true };
}

/** Neueste Wahl je Baustein. */
export function latestChoices(choices) {
  const by = {};
  for (const c of choices || []) {
    if (!by[c.block_id] || by[c.block_id].created_at <= c.created_at) by[c.block_id] = c;
  }
  return by;
}

export function latestFeedback(feedback) {
  const by = {};
  for (const f of feedback || []) {
    if (!by[f.workout_id] || by[f.workout_id].created_at <= f.created_at) by[f.workout_id] = f;
  }
  return by;
}

/** Baustein mit gewähltem Ersatz: liefert Ziel-Minuten, accepts, Titel. */
export function effectiveBlock(block, choice) {
  const sub = choice && choice.substitute_id !== "plan"
    ? block.substitutes.find((s) => s.id === choice.substitute_id) : null;
  if (!sub) return { ...block, substitute: null, skipped: false };
  const scale = block.minutes ? sub.minutes / block.minutes : 1;
  const corr = { ...block.corridor };
  if (corr.minutes) corr.minutes = corr.minutes.map((m) => Math.round(m * scale));
  return {
    ...block, substitute: sub, skipped: sub.id === "weglassen" || sub.minutes === 0,
    minutes: sub.minutes, accepts: sub.accepts, corridor: corr, title: block.title,
  };
}

const ORDER = ["kraft_a", "lang", "kraft_b", "frei"];

/**
 * Ordnet die Einheiten einer Woche den Bausteinen zu.
 * Reihenfolge: Kraft A (Studio zuerst), Lang (längste Ausdauer ≥ min_share), Kraft B, Training nach Wahl.
 */
export function matchWeek(week, workouts, choices = {}, studioDays = null) {
  const categories = (w) => cats(w, studioDays);
  const pool = (workouts || [])
    .filter((w) => !w.duplicate_of && w.start_local && w.start_local.slice(0, 10) >= week.start && w.start_local.slice(0, 10) <= week.end)
    .sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  const used = new Set();
  const blocks = week.blocks.map((b) => effectiveBlock(b, choices[b.id]));
  const result = {};
  const sorted = [...blocks].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const b of sorted) {
    if (b.skipped) { result[b.id] = { block: b, workout: null, parts: [], status: "skipped" }; continue; }
    let cands = pool.filter((w) => !used.has(w.id) && categories(w).some((c) => b.accepts.includes(c)));
    if (b.kind === "lang") {
      cands = cands.filter((w) => categories(w).includes("endurance") && minutesOf(w) >= (b.min_share || 0.75) * b.minutes)
        .sort((x, y) => minutesOf(y) - minutesOf(x));
    } else if (b.kind === "kraft_a" || b.kind === "kraft_b") {
      const pref = b.kind === "kraft_a" ? "studio" : null;
      cands.sort((x, y) => {
        const sx = categories(x).includes("strength") ? 0 : 1, sy = categories(y).includes("strength") ? 0 : 1;
        if (sx !== sy) return sx - sy;
        if (pref) return (categories(x).includes(pref) ? 0 : 1) - (categories(y).includes(pref) ? 0 : 1);
        return (categories(x).includes("studio") ? 1 : 0) - (categories(y).includes("studio") ? 1 : 0);
      });
    } else {
      cands.sort((x, y) => minutesOf(y) - minutesOf(x));
    }
    const w = cands[0] || null;
    const parts = [];
    if (w) {
      used.add(w.id);
      // Studio: Aufwärmen am Rad (bis 30 min vor dem Zirkel, gleicher Tag) gehört dazu
      if (categories(w).includes("studio")) {
        const t0 = Date.parse(w.start_utc);
        for (const o of pool) {
          if (used.has(o.id) || !categories(o).includes("endurance")) continue;
          const end = Date.parse(o.start_utc) + minutesOf(o) * 60000;
          if (o.start_local.slice(0, 10) === w.start_local.slice(0, 10) && end <= t0 + 5 * 60000 && end >= t0 - 30 * 60000) {
            parts.push(o); used.add(o.id);
          }
        }
      }
    }
    result[b.id] = { block: b, workout: w, parts, status: w ? "done" : "open" };
  }
  return {
    blocks: blocks.map((b) => result[b.id]),
    extra: pool.filter((w) => !used.has(w.id)),
  };
}

export function totalMinutes(match) {
  if (!match.workout) return 0;
  return minutesOf(match.workout) + (match.parts || []).reduce((a, o) => a + minutesOf(o), 0);
}

export function rangeState(value, [lo, hi]) {
  if (value == null) return null;
  if (value < lo) return STATES.below;
  if (value > hi) return STATES.above;
  return STATES.in;
}

/** Gefühlte Belastung: höher als geplant = schwächer = darunter. */
export function effortState(effort, [lo, hi]) {
  if (effort == null) return null;
  if (effort > hi) return STATES.below;
  if (effort < lo) return STATES.above;
  return STATES.in;
}

/** Position 0..1 auf der Skala schwächer–besser (Korridor liegt bei 0.36–0.64). */
export function scalePos(state, value, lo, hi, inverted = false) {
  const span = Math.max(hi - lo, 1);
  let rel = (value - lo) / span; // 0..1 im Korridor
  if (inverted) rel = 1 - rel;
  const p = 0.36 + rel * 0.28;
  return Math.min(0.96, Math.max(0.04, p));
}

/** Bewertung einer erledigten Einheit gegen den Korridor des Bausteins. */
export function evaluate(match, feedback, strength = [], effortLabels = []) {
  const { block, workout } = match;
  if (!workout) return null;
  const rows = [];
  const mins = totalMinutes(match);
  const [mlo, mhi] = block.corridor.minutes || [block.minutes, block.minutes];
  const ms = rangeState(mins, [mlo, mhi]);
  rows.push({ key: "minutes", label: "Dauer", text: `${mins} von ${mlo}–${mhi} min`, state: ms, pos: scalePos(ms, mins, mlo, mhi) });

  if (block.corridor.leg_extension_kg) {
    const legs = strength.filter((e) => e.session_id === workout.id && e.exercise === "leg_extension" && !e.is_test && e.avg_weight_kg);
    if (legs.length) {
      const kg = legs[legs.length - 1].avg_weight_kg;
      const [lo, hi] = block.corridor.leg_extension_kg;
      const st = rangeState(kg, [lo, hi]);
      rows.push({ key: "leg", label: "Beinstrecker", text: `${String(kg).replace(".", ",")} kg (Ziel ${String(lo).replace(".", ",")}–${String(hi).replace(".", ",")})`, state: st, pos: scalePos(st, kg, lo, hi) });
    }
  }

  const [elo, ehi] = block.corridor.effort || [2, 3];
  if (feedback) {
    const st = effortState(feedback.effort, [elo, ehi]);
    rows.push({ key: "effort", label: "Anstrengung", text: `${effortLabels[feedback.effort - 1] || feedback.effort} (Ziel ${effortLabels[elo - 1]}–${effortLabels[ehi - 1]})`, state: st, pos: scalePos(st, feedback.effort, elo, ehi, true) });
  } else {
    rows.push({ key: "effort", label: "Anstrengung", text: "noch keine Rückmeldung", state: null, pos: null });
  }
  return { rows, advice: advice(block, rows, feedback) };
}

export function advice(block, rows, feedback) {
  const st = Object.fromEntries(rows.map((r) => [r.key, r.state]));
  if (feedback && feedback.knee >= 2) {
    return "Das Knie meldet sich: nächste Einheit ohne Sprünge und etwas kürzer. Bleibt es so, ärztlich abklären lassen.";
  }
  if (st.effort === STATES.below) {
    return block.kind.startsWith("kraft")
      ? "Härter als geplant: Gewicht halten, bis es sich machbar anfühlt."
      : "Härter als geplant: die ersten 15 Minuten bewusst ruhig, du solltest dabei reden können.";
  }
  if (st.minutes === STATES.below) return "Kürzer als geplant: nächstes Mal die volle Zeit einplanen – lieber ruhiger, dafür länger.";
  if (st.leg === STATES.above) return "Mehr Gewicht als geplant – stark. Halten, bis es sich machbar anfühlt.";
  if (st.effort === STATES.above) return "Leichter als geplant: nächstes Mal darf es etwas mehr sein.";
  if (!feedback) return "Wie hat es sich angefühlt? Mit deiner Rückmeldung wird die Bewertung vollständig.";
  return "Genau im Plan – weiter so.";
}

/** Einheiten der letzten Tage ohne Rückmeldung (ab Planbeginn). */
export function pendingFeedback(workouts, feedbackById, plan, today, days = 10) {
  const start = plan?.weeks?.[0]?.start || "0000";
  const from = new Date(today + "T00:00:00");
  from.setDate(from.getDate() - days);
  const fromIso = isoDate(from);
  return (workouts || [])
    .filter((w) => !w.duplicate_of && w.start_local.slice(0, 10) >= start && w.start_local.slice(0, 10) >= fromIso
      && w.start_local.slice(0, 10) <= today && !feedbackById[w.id])
    .sort((a, b) => b.start_utc.localeCompare(a.start_utc));
}

export function daysUntil(dateIso, today) {
  const a = new Date(today + "T00:00:00"), b = new Date(dateIso + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

export function spontaneousFor(plan, minutes, matched) {
  const open = new Set((matched?.blocks || []).filter((m) => m.status === "open").map((m) => m.block.kind));
  const list = (plan?.spontaneous || []).filter((s) => s.minutes <= minutes).sort((a, b) => b.minutes - a.minutes);
  return list.find((s) => open.has(s.counts_as)) || list[0] || null;
}

/** Dateiname für die Inbox: sicher für GitHub-Pfade. */
export function inboxName(prefix, id, now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const safe = String(id).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  return `${prefix}/${ts}_${safe}.json`;
}

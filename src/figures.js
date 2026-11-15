// Eigene, schematische Zeichnungen je Übung (keine fremden Bilder).
// Koordinaten im Feld 120 × 90, Boden bei y = 84.
//   m = Gerät/Möbel (Linienzüge), mc = Gerät (Kreise [x, y, r])
//   p = Person (Linienzüge), h = Kopf [x, y]
//   g = Ausgangsstellung (gestrichelt), a = Bewegungspfeil (SVG-Pfad)
// Ohne DOM-Abhängigkeit beim Import; figure() braucht document.

export const FIGURES = {
  bike: {
    title: "Fahrrad-Ergometer",
    m: [[34, 84, 104, 84], [52, 50, 58, 84], [44, 49, 60, 49], [84, 38, 90, 64], [78, 37, 90, 37], [58, 72, 88, 66]],
    mc: [[90, 66, 13]],
    h: [58, 15],
    p: [[58, 23, 51, 47], [57, 28, 70, 34, 81, 38], [51, 47, 70, 50, 70, 68], [51, 47, 64, 58, 62, 76]],
    a: ["M60 80 A11 11 0 1 0 78 70"],
  },
  total_abdominal: {
    title: "Bauchmaschine – Oberkörper gegen die Polster einrollen",
    m: [[28, 84, 92, 84], [40, 59, 68, 59], [54, 59, 54, 84], [38, 59, 32, 18], [33, 22, 60, 26], [70, 80, 80, 80]],
    h: [60, 20],
    p: [[44, 56, 54, 30], [52, 33, 60, 28], [44, 56, 68, 56, 70, 80]],
    g: [[44, 56, 40, 28]],
    a: ["M64 9 Q80 12 78 32"],
  },
  low_row: {
    title: "Rudern sitzend – Griffe zum Körper ziehen",
    m: [[18, 84, 110, 84], [28, 61, 52, 61], [40, 61, 40, 84], [102, 18, 102, 84], [66, 34, 66, 54], [82, 62, 82, 82], [50, 40, 102, 40]],
    h: [42, 22],
    p: [[38, 59, 41, 30], [41, 33, 30, 41, 49, 40], [38, 59, 62, 60, 80, 70]],
    a: ["M92 30 L64 30"],
  },
  leg_extension: {
    title: "Beinstrecker – Unterschenkel nach vorn-oben strecken",
    m: [[22, 84, 98, 84], [34, 57, 62, 57], [48, 57, 48, 84], [34, 57, 29, 20]],
    mc: [[62, 58, 3], [86, 44, 5]],
    h: [34, 19],
    p: [[38, 55, 34, 27], [35, 31, 44, 43, 50, 54], [38, 55, 62, 57, 84, 46]],
    g: [[62, 57, 64, 80]],
    a: ["M70 80 Q92 76 95 54"],
  },
  lower_back: {
    title: "Rückenstrecker – Oberkörper gegen das Polster nach hinten strecken",
    m: [[24, 84, 96, 84], [42, 61, 68, 61], [55, 61, 55, 84], [76, 70, 76, 82]],
    mc: [[29, 36, 5]],
    h: [33, 19],
    p: [[48, 59, 37, 28], [39, 33, 47, 38], [48, 59, 70, 59, 74, 80]],
    g: [[48, 59, 63, 34]],
    a: ["M66 25 Q52 6 38 9"],
  },
  shoulder_press: {
    title: "Schulterpresse – Griffe nach oben drücken",
    m: [[24, 84, 94, 84], [40, 63, 66, 63], [53, 63, 53, 84], [40, 63, 35, 22], [44, 9, 64, 9]],
    h: [40, 23],
    p: [[44, 61, 40, 32], [41, 35, 54, 29, 54, 10], [44, 61, 66, 63, 68, 82]],
    g: [[54, 29, 54, 24]],
    a: ["M74 32 L74 8"],
  },
  leg_curl: {
    title: "Beinbeuger – Fersen nach unten-hinten ziehen",
    m: [[18, 84, 100, 84], [32, 53, 58, 53], [45, 53, 45, 84], [32, 53, 27, 18], [46, 43, 64, 43]],
    mc: [[84, 56, 4]],
    h: [31, 16],
    p: [[36, 51, 31, 24], [32, 28, 44, 38, 52, 44], [36, 51, 60, 50, 86, 50]],
    g: [[60, 50, 66, 76]],
    a: ["M96 58 Q96 78 76 81"],
  },
  chest_press: {
    title: "Brustpresse – Griffe nach vorn drücken",
    m: [[24, 84, 96, 84], [40, 63, 66, 63], [53, 63, 53, 84], [40, 63, 35, 22], [78, 30, 78, 44]],
    h: [40, 23],
    p: [[44, 61, 40, 32], [41, 36, 59, 39, 78, 37], [44, 61, 66, 63, 68, 82]],
    a: ["M58 22 L88 22"],
  },
  single_leg_squat: {
    title: "Einbein-Kniebeuge – auf einem Bein langsam zum Stuhl absenken",
    m: [[6, 84, 114, 84], [14, 58, 36, 58], [16, 58, 16, 84], [34, 58, 34, 84], [14, 58, 14, 30]],
    h: [58, 21],
    p: [[44, 52, 55, 29], [53, 33, 76, 35], [44, 52, 62, 61, 58, 82], [44, 52, 86, 56]],
    a: ["M102 22 L102 50"],
  },
  lateral_lunge: {
    title: "Ausfallschritt seitlich – Gewicht auf ein Bein, Po nach hinten",
    m: [[6, 84, 114, 84]],
    h: [66, 21],
    p: [[62, 56, 65, 29], [64, 34, 76, 44, 70, 48], [62, 56, 82, 62, 90, 82], [62, 56, 24, 82]],
    a: ["M38 14 L86 14"],
  },
  skater_jump: {
    title: "Skater-Sprung – seitlich abspringen, auf einem Bein weich landen",
    m: [[6, 84, 114, 84]],
    h: [76, 19],
    p: [[62, 48, 72, 26], [70, 30, 86, 40], [68, 32, 52, 44], [62, 48, 70, 64, 68, 82], [62, 48, 46, 62, 36, 74]],
    a: ["M14 72 Q30 20 52 30"],
  },
  side_plank: {
    title: "Seitstütz – Körper eine Linie, Hüfte oben halten",
    m: [[6, 84, 114, 84]],
    h: [20, 51],
    p: [[28, 58, 100, 81], [26, 82, 28, 58], [26, 82, 42, 82], [50, 66, 58, 60]],
    a: ["M66 64 L66 46"],
  },
  push_up: {
    title: "Liegestütz – Rumpf fest, Brust Richtung Boden",
    m: [[6, 84, 114, 84]],
    h: [22, 49],
    p: [[30, 55, 102, 81], [30, 55, 30, 82]],
    a: ["M50 24 L50 46", "M50 46 L50 24"],
  },
  chair_dip: {
    title: "Dips am Stuhl – Ellbogen nach hinten beugen, wieder hochdrücken",
    m: [[4, 84, 114, 84], [8, 50, 32, 50], [10, 50, 10, 84], [30, 50, 30, 84], [8, 50, 8, 22]],
    h: [40, 50],
    p: [[40, 59, 44, 78], [40, 61, 25, 64, 31, 51], [44, 78, 68, 66, 74, 82]],
    a: ["M56 50 L56 28", "M56 28 L56 50"],
  },
  band_row: {
    title: "Rudern mit Band – Schulterblätter zusammen, Band zum Körper ziehen",
    m: [[6, 84, 114, 84], [106, 16, 106, 84], [52, 40, 106, 44]],
    h: [44, 20],
    p: [[44, 56, 44, 28], [44, 32, 32, 40, 52, 40], [44, 56, 40, 84], [44, 56, 50, 84]],
    a: ["M92 32 L62 32"],
  },
};

const NS = "http://www.w3.org/2000/svg";
let markerSeq = 0;

function node(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
const pts = (a) => a.reduce((s, v, i) => s + (i % 2 ? "," : i ? " " : "") + v, "");

/** Zeichnung als SVG-Element oder null, wenn es für die Übung keine gibt. */
export function figure(key, { size = 128 } = {}) {
  const f = FIGURES[key];
  if (!f) return null;
  const id = `fig-arrow-${++markerSeq}`;
  const s = node("svg", { viewBox: "0 0 120 90", width: size, height: Math.round(size * 0.75), role: "img", "aria-label": f.title, class: "fig" });
  const defs = node("defs", {});
  const mk = node("marker", { id, viewBox: "0 0 10 10", refX: "6", refY: "5", markerWidth: "5", markerHeight: "5", orient: "auto-start-reverse" });
  mk.append(node("path", { d: "M0 0 L10 5 L0 10 z", class: "fig-arrowhead" }));
  defs.append(mk);
  s.append(defs);
  for (const l of f.m || []) s.append(node("polyline", { points: pts(l), class: "fig-machine" }));
  for (const [x, y, r] of f.mc || []) s.append(node("circle", { cx: x, cy: y, r, class: "fig-machine" }));
  for (const l of f.g || []) s.append(node("polyline", { points: pts(l), class: "fig-ghost" }));
  for (const l of f.p || []) s.append(node("polyline", { points: pts(l), class: "fig-person" }));
  if (f.h) s.append(node("circle", { cx: f.h[0], cy: f.h[1], r: 6, class: "fig-head" }));
  for (const d of f.a || []) s.append(node("path", { d, class: "fig-arrow", "marker-end": `url(#${id})` }));
  return s;
}

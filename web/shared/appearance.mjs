// Node color schemes for the QG-tools appearance setting. Pure data and
// decision logic only — the DOM/graph wiring lives in js/appearance/index.js
// so this module stays testable under node:test.

// Each scheme pairs a title-bar color with a body color tuned against
// ComfyUI's dark canvas. `colors: null` means "leave the theme's default
// colors alone". The flagship QG-tools row is the pack-wide default — a deep
// slate-teal title over a near-black body (chosen 2026-08 over the original
// bright teal, which lives on in LEGACY_SCHEME_PAIRS below so old saved
// workflows upgrade); the muted rows keep title darker than body.
//
// `accent` is the highlight the node's own panels paint their chosen states
// in; it lives on the same row so a new scheme cannot ship without one (the
// fallback below is the pack teal, which would look wrong on a Plum card).
// The five rows after Navy are the 2026-11-22 additions: hues the table did
// not cover yet (gold / wine / indigo / emerald / sand).
//
// 🔴 2026-11-24 全面重调除 QG-tools/Theme default 外的 12 套（同色相、只调
// 明度/饱和度），依据 WCAG + Radix Colors 深色标度：① 强调色饱和度从 79-87%
// 降到 52-72%，去掉深色底上的霓虹刺眼感；② 每套 accent↔body 对比度 ≥4.5:1
// （旧 Slate/Wine/Indigo 只有 3.96/4.17/4.27，不达标）；③ title 压暗、body
// 抬亮，拉开层次（旧表多数明度差仅 0.01，发闷）；④ title/body 与强调色同
// 色相低饱和（tinted neutral），整块颜色更和谐。改前务必重跑对比度校验。
export const NODE_COLOR_SCHEMES = [
  { name: "QG-tools", colors: { title: "#14424d", body: "#161f21" }, accent: "#00b4aa" },
  { name: "Theme default", colors: null, accent: "#00b4aa" },
  { name: "Graphite", colors: { title: "#1d1e20", body: "#2d3034" }, accent: "#66768c" },
  { name: "Slate", colors: { title: "#17222b", body: "#233543" }, accent: "#2980c9" },
  { name: "Teal", colors: { title: "#152825", body: "#21403b" }, accent: "#30c2aa" },
  { name: "Moss", colors: { title: "#1d2716", body: "#2e3f22" }, accent: "#6fb83a" },
  { name: "Plum", colors: { title: "#1d1424", body: "#382546" }, accent: "#8531c1" },
  { name: "Rust", colors: { title: "#2e1f15", body: "#463020" }, accent: "#cb6b27" },
  { name: "Navy", colors: { title: "#131926", body: "#212d45" }, accent: "#4a68a8" },
  { name: "Amber", colors: { title: "#2f2713", body: "#483c1e" }, accent: "#d09c22" },
  { name: "Wine", colors: { title: "#2a141b", body: "#3f1c28" }, accent: "#c72b5f" },
  { name: "Indigo", colors: { title: "#111122", body: "#1c1d3b" }, accent: "#272ccb" },
  { name: "Emerald", colors: { title: "#132a21", body: "#1d4434" }, accent: "#2ec486" },
  { name: "Sand", colors: { title: "#292219", body: "#403526" }, accent: "#b18341" },
];

export const DEFAULT_SCHEME = NODE_COLOR_SCHEMES[0].name;

// The "Custom" scheme is not a table row: its title comes from the
// QG.Appearance.CustomColor setting and its body is derived from it.
export const CUSTOM_SCHEME = "Custom";

// Every name the scheme combo and the per-node menu offer.
export const SCHEME_NAMES = [...NODE_COLOR_SCHEMES.map((scheme) => scheme.name), CUSTOM_SCHEME];

const normalize = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

// Color pairs earlier releases shipped as the flagship default. A node
// restored from a saved workflow wearing one of these was colored by us,
// not by the user, so it upgrades to the active scheme on creation instead
// of being protected as a manual pick.
export const LEGACY_SCHEME_PAIRS = [
  { title: "#007f78", body: "#081413" }, // flagship bright teal through 2026-08
];

export function wearsLegacyScheme(node) {
  const color = normalize(node?.color);
  const bgcolor = normalize(node?.bgcolor);
  return LEGACY_SCHEME_PAIRS.some(
    (pair) => color === pair.title && bgcolor === pair.body,
  );
}

// ComfyUI's color setting stores bare hex without "#" (the PrimeVue picker
// contract), and its free-text field also accepts 8-digit hex. Normalize
// either form to "#rrggbb" (alpha dropped); junk normalizes to null.
export function normalizeHexColor(value) {
  const raw = normalize(value).replace(/^#/, "");
  const match = /^([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(raw);
  return match ? `#${match[1]}` : null;
}

// Custom bodies are the picked title mixed halfway toward a dark neutral, so
// any title — including bright picks — yields a body that stays quiet on the
// dark canvas. Very dark titles get a slightly lighter body (matching the
// shipped schemes' title-darker-than-body grammar); bright titles get a
// muted, darker body instead of a wall of pigment.
const BODY_NEUTRAL = 0x2f; // per-channel dark neutral, near the Graphite body
const BODY_KEEP = 0.5; // share of the title pigment the body keeps
// A pick sitting on the neutral mixes to itself, which would draw a node with
// no visible title bar at all. Only picks inside a narrow dark band collapse
// this way, so the body steps lighter — the shipped schemes' grammar.
const BODY_MIN_STEP = 10;

export function deriveBody(hex) {
  const title = normalizeHexColor(hex);
  if (!title) return null;
  const rgb = parseInt(title.slice(1), 16);
  const channels = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  let body = channels.map((channel) =>
    Math.round(channel * BODY_KEEP + BODY_NEUTRAL * (1 - BODY_KEEP)),
  );
  const separation = Math.max(...body.map((value, index) => Math.abs(value - channels[index])));
  if (separation < BODY_MIN_STEP) {
    body = channels.map((channel) => Math.min(255, channel + BODY_MIN_STEP));
  }
  const packed = (body[0] << 16) | (body[1] << 8) | body[2];
  return `#${packed.toString(16).padStart(6, "0")}`;
}

// Build the Custom scheme's color pair from the setting value; null when the
// stored value is not usable hex, so callers fall back to doing nothing.
export function customColors(titleHex) {
  const title = normalizeHexColor(titleHex);
  return title ? { title, body: deriveBody(title) } : null;
}

// Resolve a scheme name to its color pair. `customTitle` (the CustomColor
// setting value) only matters for the Custom scheme; static names ignore it.
export function schemeColors(name, customTitle) {
  if (name === CUSTOM_SCHEME) return customColors(customTitle);
  return NODE_COLOR_SCHEMES.find((scheme) => scheme.name === name)?.colors ?? null;
}

// ---------- the accent a scheme paints its "chosen" states in ----------
//
// The panel controls (a switch's off | on, a segmented setting, a focused
// field, the checkbox in a picker) all light up in one color. Until 2026-11-22
// that color was the packed QG teal whatever the node colors were set to,
// which left a Plum or Rust workflow glowing teal inside. Each scheme now
// carries an accent of its own hue, a few steps brighter than its title bar
// so it still reads as a highlight on the dark panels.
// The accent a scheme name maps to, read straight off the table above so a
// scheme and its highlight cannot drift apart (or be forgotten). Theme default
// keeps the pack teal: the node colors are the frontend's, and there is no
// scheme pigment to borrow.
const SCHEME_ACCENTS = Object.fromEntries(
  NODE_COLOR_SCHEMES.map((scheme) => [scheme.name, scheme.accent]),
);

// The accent the pack falls back to (also what Custom resolves to when the
// stored color is unusable).
const DEFAULT_ACCENT = SCHEME_ACCENTS[DEFAULT_SCHEME];

function channelLuminance(rgb) {
  return (0.299 * ((rgb >> 16) & 0xff) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff)) / 255;
}

function rgbToHsl(rgb) {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const hue = ((h % 1) + 1) % 1;
  const sat = Math.min(1, Math.max(0, s));
  const light = Math.min(1, Math.max(0, l));
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  const parts = [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
  const packed = parts
    .map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255))
    .reduce((acc, value) => (acc << 8) | value, 0);
  return `#${packed.toString(16).padStart(6, "0")}`;
}

// A Custom title as an accent: same hue, lifted to a highlight's lightness so
// a near-black pick does not turn the "on" pill into a slab of the title bar.
// Grey picks keep a little saturation, otherwise the accent would vanish into
// the panel's own greys.
function deriveAccent(titleHex) {
  const title = normalizeHexColor(titleHex);
  if (!title) return DEFAULT_ACCENT;
  const [h, s] = rgbToHsl(parseInt(title.slice(1), 16));
  return hslToHex(h, Math.max(0.42, Math.min(0.85, s)), 0.6);
}

// The accent for a scheme name; Custom reads the picked title color.
// A scheme can be overridden by the user's own pickers — that decision (and the
// fallback when a stored color is unusable) lives in appearance/index.js, so
// this stays a pure name → color lookup.
export function accentFor(name, customTitle) {
  if (name === CUSTOM_SCHEME) return deriveAccent(customTitle);
  return SCHEME_ACCENTS[name] ?? DEFAULT_ACCENT;
}

// Ink for text drawn on the accent: the accents are mid-light, so dark ink
// wins; only a genuinely dark accent (a user's very deep Custom pick that
// lands low in lightness) needs white.
export function accentInk(accent) {
  const hex = normalizeHexColor(accent);
  if (!hex) return "#04201d";
  return channelLuminance(parseInt(hex.slice(1), 16)) > 0.42 ? "#04201d" : "#ffffff";
}

// The hover shade: the same hue, a little brighter (or, for an already very
// light accent, a touch dimmer so the hover is still visible).
export function accentHover(accent) {
  const hex = normalizeHexColor(accent);
  if (!hex) return DEFAULT_ACCENT;
  const [h, s, l] = rgbToHsl(parseInt(hex.slice(1), 16));
  return hslToHex(h, s, l > 0.78 ? l - 0.08 : l + 0.08);
}

// Perceived luminance (Rec. 601 weights) of the title color picks the ink
// that keeps the title readable. Malformed input gets the light ink — every
// shipped scheme is dark, so light is the safe fallback.
export function titleInk(hex) {
  const match = /^#([0-9a-f]{6})$/.exec(normalize(hex));
  if (!match) return "#ffffff";
  const rgb = parseInt(match[1], 16);
  const luminance =
    (0.299 * ((rgb >> 16) & 0xff) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff)) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#ffffff";
}

// Flatten every node reachable from a graph, descending into subgraph
// containers via `node.subgraph`. Accepts a graph exposing `_nodes` or
// `nodes`, or a plain node array; the visited set breaks reference cycles.
export function collectGraphNodes(graph, visited = new Set()) {
  if (!graph || visited.has(graph)) return [];
  visited.add(graph);
  const nodes = Array.isArray(graph) ? graph : graph._nodes || graph.nodes || [];
  const collected = [];
  for (const node of nodes) {
    if (!node) continue;
    collected.push(node);
    if (node.subgraph) collected.push(...collectGraphNodes(node.subgraph, visited));
  }
  return collected;
}

// A node is repainted only while it is still "following the setting": either
// it carries no colors while the previous scheme was the theme default, or it
// still wears exactly the previous scheme's pair. Anything else — a color the
// user picked by hand, colors restored from a saved workflow, or a manual
// "no color" reset while a scheme was active — is the user's choice and wins.
export function shouldRecolor(current, previousColors) {
  const color = normalize(current?.color);
  const bgcolor = normalize(current?.bgcolor);
  if (!previousColors) return !color && !bgcolor;
  return color === normalize(previousColors.title) && bgcolor === normalize(previousColors.body);
}

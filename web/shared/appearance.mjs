// Node color schemes for the QG-tools appearance setting. Pure data and
// decision logic only — the DOM/graph wiring lives in js/appearance/index.js
// so this module stays testable under node:test.

// Each scheme pairs a title-bar color with a body color tuned against
// ComfyUI's dark canvas. `colors: null` means "leave the theme's default
// colors alone". The flagship QG-tools row is the pack-wide default — a deep
// slate-teal title over a near-black body (chosen 2026-08 over the original
// bright teal, which lives on in LEGACY_SCHEME_PAIRS below so old saved
// workflows upgrade); the muted rows keep title darker than body.
export const NODE_COLOR_SCHEMES = [
  { name: "QG-tools", colors: { title: "#14424d", body: "#161f21" } },
  { name: "Theme default", colors: null },
  { name: "Graphite", colors: { title: "#242424", body: "#2f2f2f" } },
  { name: "Slate", colors: { title: "#1f2c38", body: "#2a3b4a" } },
  { name: "Teal", colors: { title: "#14332f", body: "#1c453f" } },
  { name: "Moss", colors: { title: "#23331c", body: "#2f4426" } },
  { name: "Plum", colors: { title: "#2e1f38", body: "#3d2a4a" } },
  { name: "Rust", colors: { title: "#3a2317", body: "#4c2f20" } },
  { name: "Navy", colors: { title: "#1b2338", body: "#242f4b" } },
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

// Pure state logic for the LoRA Loader rows: stack normalization, strength
// scrubbing math, the picker's filter/keyboard model, the strength-bar
// visualizer, the absorb-the-chain import, moved-file resolution, and the
// master-toggle memory. DOM wiring lives in js/lora_loader/index.js;
// everything here runs under node:test.

import { zhCount, zhSep, zhEnd } from "./zh.mjs?v=2026102571";

export const STRENGTH_MIN = -10;
export const STRENGTH_MAX = 10;
export const DEFAULT_STEP = 0.05;
export const FINE_STEP = 0.01;
// Horizontal pixels of drag per strength step; small enough to feel light,
// large enough that a shaky click cannot change the value.
export const SCRUB_PIXELS_PER_STEP = 4;
export const SCRUB_DEAD_ZONE = 3;
export const MAX_ROWS = 64;

let rowSerial = 0;

export function clampStrength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, number));
}

export function roundStrength(value) {
  return Math.round(clampStrength(value) * 100) / 100;
}

export function newRow() {
  rowSerial += 1;
  return {
    id: `r${Date.now().toString(36)}${rowSerial}`,
    name: "",
    strength: 1,
    strength_clip: 1,
    enabled: true,
    triggers: "",
  };
}

export function normalizeRows(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_ROWS).map((entry) => {
    const row = newRow();
    if (entry && typeof entry === "object") {
      row.id = typeof entry.id === "string" && entry.id ? entry.id : row.id;
      row.name = typeof entry.name === "string" ? entry.name : "";
      row.strength = roundStrength(entry.strength ?? 1);
      row.strength_clip = roundStrength(entry.strength_clip ?? row.strength);
      row.enabled = entry.enabled !== false;
      row.triggers = typeof entry.triggers === "string" ? entry.triggers : "";
    }
    return row;
  });
}

export function parseRows(raw) {
  try {
    return normalizeRows(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function serializeRows(rows) {
  return JSON.stringify(rows);
}

export function reorderRows(rows, from, to) {
  if (from === to) return rows;
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) return rows;
  const next = rows.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

export function moveRow(rows, index, delta) {
  return reorderRows(rows, index, index + delta);
}

// Drag-to-reorder model: which visual slot the pointer is over, given the
// vertical centers of the rows in their current on-screen order. Past the
// last center means the last slot; an empty stack has no slot.
export function hoverRowIndex(centers, y) {
  for (let i = 0; i < centers.length; i += 1) {
    if (y < centers[i]) return i;
  }
  return centers.length - 1;
}

// Hover-thumbnail placement: below-right of the cursor, flipped left when the
// viewport edge is near, never off-screen. `edge` is the thumb's largest side
// plus its margin.
export function thumbPosition(x, y, viewportWidth, viewportHeight, edge = 188, offset = 14) {
  let left = x + offset;
  if (left + edge > viewportWidth) left = Math.max(4, x - edge - offset);
  let top = y + offset;
  if (top + edge > viewportHeight) top = Math.max(4, viewportHeight - edge);
  return { left, top };
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  let value = size;
  let unit = "B";
  for (const next of ["KB", "MB", "GB", "TB"]) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const text =
    unit === "B" ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${unit}`;
}

export function setStrength(rows, index, value, linked) {
  const next = rows.slice();
  const row = { ...next[index], strength: roundStrength(value) };
  if (linked) row.strength_clip = row.strength;
  next[index] = row;
  return next;
}

// Scrub model: value follows horizontal pointer distance from the grab point.
// Inside the dead zone nothing changes, so a plain click stays a click. The
// coarse step is configurable (the gear menu's "Strength step"); Shift always
// scrubs by the fine step.
export function scrubValue(startValue, deltaX, fine = false, coarseStep = DEFAULT_STEP) {
  if (Math.abs(deltaX) <= SCRUB_DEAD_ZONE) return roundStrength(startValue);
  const coarse = Number.isFinite(coarseStep) && coarseStep > 0 ? coarseStep : DEFAULT_STEP;
  const step = fine ? FINE_STEP : coarse;
  const travel = deltaX - Math.sign(deltaX) * SCRUB_DEAD_ZONE;
  const steps = Math.round(travel / SCRUB_PIXELS_PER_STEP);
  return roundStrength(startValue + steps * step);
}

export function isScrubbing(deltaX, deltaY) {
  return Math.abs(deltaX) > SCRUB_DEAD_ZONE && Math.abs(deltaX) >= Math.abs(deltaY);
}

export function filterLoras(names, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return names.slice();
  return names.filter((name) => name.toLowerCase().includes(needle));
}

// Picker keyboard model: a highlight index over the filtered list.
// Arrow keys wrap; Home/End jump; a shrinking filter keeps the highlight
// valid. Enter resolves to the highlighted name (null when the list is empty).
export function moveHighlight(index, delta, length) {
  if (length <= 0) return -1;
  if (index < 0) return delta >= 0 ? 0 : length - 1;
  return (index + delta + length) % length;
}

export function clampHighlight(index, length) {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, length - 1);
}

export function highlightedName(names, index) {
  return index >= 0 && index < names.length ? names[index] : null;
}

// Row keyboard intent only; DOM focus and commits stay in the node panel.
// The add button is the last destination, at index rowCount. Edited fields,
// composition and application shortcuts keep ownership of their keys.
// onControl: the key was pressed on one of a row's own buttons or boxes, not
// on the row. Enter and Space then belong to that control, as on any button.
export function loraStackKeyAction(event, { index, rowCount, atAdd = false, editing = false, onControl = false }) {
  if (editing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
      || event.isComposing || event.keyCode === 229) return null;
  const current = atAdd ? rowCount : index;
  if (!Number.isInteger(rowCount) || rowCount < 0
      || !Number.isInteger(current) || current < 0 || current > rowCount) return null;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const direction = event.key === "ArrowUp" ? -1 : 1;
    return { kind: "focus", index: Math.max(0, Math.min(rowCount, current + direction)) };
  }
  // ComfyUI deletes the selected nodes on these keys from anywhere inside
  // the graph. The stack keeps them while it holds the keyboard, so reaching
  // for "remove this row" can never remove the node.
  if (event.key === "Delete" || event.key === "Backspace") return { kind: "block" };
  if (onControl && (event.key === "Enter" || event.key === " ")) return null;
  if (event.key === "Enter") return { kind: "pick" };
  if (current === rowCount) return null;
  if (event.key === " " && !event.repeat) return { kind: "toggle" };
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    return { kind: "strength", direction: event.key === "ArrowLeft" ? -1 : 1, fine: !!event.shiftKey };
  }
  return null;
}

// A row keeps its triggers as one comma-joined text, and a trigger can hold
// commas of its own (a whole sentence from Civitai). So a trigger is looked
// for as the run of parts it becomes in that text, never as a single part.
function triggerParts(text) {
  return String(text || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findTrigger(parts, wanted) {
  if (!wanted.length) return -1;
  for (let start = 0; start + wanted.length <= parts.length; start += 1) {
    if (wanted.every((part, offset) => parts[start + offset].toLowerCase() === part.toLowerCase())) {
      return start;
    }
  }
  return -1;
}

export function hasTrigger(triggers, word) {
  return findTrigger(triggerParts(triggers), triggerParts(word)) >= 0;
}

export function toggleTrigger(triggers, word) {
  const parts = triggerParts(triggers);
  const wanted = triggerParts(word);
  let existing = findTrigger(parts, wanted);
  if (existing < 0) parts.push(...wanted);
  // Off takes out every copy, so a row that holds the trigger twice clears.
  for (; existing >= 0; existing = findTrigger(parts, wanted)) parts.splice(existing, wanted.length);
  return parts.join(", ");
}

export function summarizeRows(rows) {
  const on = rows.filter((row) => row.enabled && row.name).length;
  const total = rows.filter((row) => row.name).length;
  // The "enabled" word is appended as its own text node at the call sites,
  // so the translator can match it as a static string.
  return total === 0 ? "no LoRAs" : `${on} / ${total}`;
}

// Master toggle model: "on" when every named row is enabled, "off" when none
// are, "mixed" otherwise. Blank rows don't vote.
export function toggleAllState(rows) {
  const named = rows.filter((row) => row.name);
  if (!named.length) return "off";
  const on = named.filter((row) => row.enabled).length;
  return on === 0 ? "off" : on === named.length ? "on" : "mixed";
}

// Clicking the master pill: anything not fully-on turns everything on;
// fully-on turns everything off.
export function toggleAllRows(rows) {
  const enabled = toggleAllState(rows) !== "on";
  return rows.map((row) => (row.name ? { ...row, enabled } : row));
}

// Longest common folder prefix (whole segments only) across displayed names,
// so a picker full of "styles/wan22/x.safetensors" reads as just "x".
export function commonFolderPrefix(names) {
  if (names.length < 2) return "";
  const split = names.map((name) => name.split("/"));
  const first = split[0];
  let depth = 0;
  while (
    depth < first.length - 1 &&
    split.every((parts) => parts.length > depth + 1 && parts[depth] === first[depth])
  ) {
    depth += 1;
  }
  return depth ? first.slice(0, depth).join("/") + "/" : "";
}

// Folder grouping for the picker's browse view: names bucketed by their
// top-level folder in first-appearance order; root files group under "".
export function groupByFolder(names) {
  const groups = [];
  const index = new Map();
  for (const name of names) {
    const slash = name.indexOf("/");
    const folder = slash >= 0 ? name.slice(0, slash) : "";
    if (!index.has(folder)) {
      index.set(folder, { folder, names: [] });
      groups.push(index.get(folder));
    }
    index.get(folder).names.push(name);
  }
  return groups;
}

// Every registered subfolder is selectable, including parents with files
// only in nested folders. Folder order follows the first appearance of each
// branch; each folder's files keep the server's original names and order.
// Only separators are normalized: case can distinguish files on Linux.
function loraPath(name) {
  return name.replaceAll("\\", "/");
}

export function loraFolders(names) {
  const tree = new Map();
  for (const name of names) {
    const parts = loraPath(name).split("/");
    let branch = tree;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const part = parts[depth];
      if (!branch.has(part)) {
        branch.set(part, { folder: parts.slice(0, depth + 1).join("/"), names: [], children: new Map() });
      }
      const entry = branch.get(part);
      entry.names.push(name);
      branch = entry.children;
    }
  }
  const folders = [];
  const visit = (branch) => {
    for (const { folder, names, children } of branch.values()) {
      folders.push({ folder, names });
      visit(children);
    }
  };
  visit(tree);
  return folders;
}

// A single browse/keyboard order for selectable folder headers and files.
// Search hides unmatched files, but headers still count their whole folder:
// picking a header always adds that whole folder, not just search results.
// Folding hides descendants, retaining their preferences in the caller's Set.
// Callers can pass an empty Set while searching to reveal every match.
export function loraPickerEntries(names, query = "", collapsedFolders = new Set()) {
  const tree = { entries: [], folders: new Map() };
  for (const name of names) {
    const parts = loraPath(name).split("/");
    let branch = tree;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const label = parts[depth];
      if (!branch.folders.has(label)) {
        const folder = {
          entry: { kind: "folder", name: parts.slice(0, depth + 1).join("/"), label, depth, count: 0 },
          children: { entries: [], folders: new Map() },
        };
        branch.folders.set(label, folder);
        branch.entries.push(folder);
      }
      const folder = branch.folders.get(label);
      folder.entry.count += 1;
      branch = folder.children;
    }
    branch.entries.push({ entry: { kind: "file", name, label: parts.at(-1), depth: parts.length - 1 } });
  }
  const needle = loraPath(String(query || "")).trim().toLowerCase();
  const collapsed = new Set([...collapsedFolders].map(loraPath));
  const visit = (branch) => {
    const entries = [];
    for (const { entry, children } of branch.entries) {
      if (children) {
        const descendants = visit(children);
        if (descendants.length) {
          entries.push(entry);
          if (!collapsed.has(entry.name)) entries.push(...descendants);
        }
      } else if (loraPath(entry.name).toLowerCase().includes(needle)) {
        entries.push(entry);
      }
    }
    return entries;
  };
  return visit(tree);
}

// Folder add is one append, or no change when the whole selection cannot
// fit. Existing rows (even duplicates, disabled rows and empty slots) stay
// untouched. Deduplicate by full path, never basename or moved-file guess.
export function appendFolderRows(rows, names, defaultStrength = 1) {
  const seen = new Set(rows.map((row) => loraPath(row.name)));
  const pending = [];
  let skipped = 0;
  for (const name of names) {
    const key = loraPath(name);
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    pending.push(name);
  }
  const room = Math.max(0, MAX_ROWS - rows.length);
  const needed = pending.length;
  if (needed > room || !needed) return { rows, added: 0, skipped, needed, room };
  const strength = roundStrength(defaultStrength);
  const addedRows = pending.map((name) => ({ ...newRow(), name, strength, strength_clip: strength }));
  return { rows: [...rows, ...addedRows], added: needed, skipped, needed, room };
}

// A suggested range is advisory: null/absent bounds never flag.
// ---------- templates ----------
// A template is a named snapshot of the row stack: { name, rows } with rows
// stored id-less (ids are per-node identity, not part of the recipe).

export function templateFromRows(name, rows) {
  const label = String(name ?? "").trim();
  if (!label) return null;
  return {
    name: label,
    rows: normalizeRows(rows).map(({ id, ...rest }) => rest),
  };
}

export function applyTemplate(template) {
  return normalizeRows(template?.rows);
}

// Replace a same-named template (case-insensitive) or append; kept sorted so
// the menu order is stable however the list was built.
export function upsertTemplate(list, template) {
  if (!template) return Array.isArray(list) ? list : [];
  const base = Array.isArray(list) ? list : [];
  const key = template.name.toLowerCase();
  const next = base.filter((entry) => entry?.name?.toLowerCase() !== key);
  next.push(template);
  next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return next;
}

export function removeTemplate(list, name) {
  const key = String(name ?? "").toLowerCase();
  return (Array.isArray(list) ? list : []).filter(
    (entry) => entry?.name?.toLowerCase() !== key
  );
}

export function parseTemplates(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => templateFromRows(entry?.name, entry?.rows))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function strengthOutOfRange(value, range) {
  if (!range) return false;
  const low = Number.isFinite(range.min) ? range.min : null;
  const high = Number.isFinite(range.max) ? range.max : null;
  if (low !== null && value < low) return true;
  if (high !== null && value > high) return true;
  return false;
}

// ---------- strength bars ----------
//
// Each row's name field gets a center-zero bar behind the text: positive
// model strength grows right of center, negative grows left. One shared
// scale across the whole stack, floored at 1.0, so the everyday 0..1 range
// reads absolutely, and one +2.0 row rescales every bar rather than
// clipping. Colors stay muted so the filename stays the foreground.

export const BAR_COLORS = {
  positiveFill: "rgba(0, 180, 170, 0.28)",
  positiveCap: "rgba(0, 220, 205, 0.9)",
  negativeFill: "rgba(235, 106, 96, 0.26)",
  negativeCap: "rgba(255, 138, 128, 0.9)",
  tick: "rgba(215, 221, 226, 0.30)",
  base: "#23272c",
};

// Bars ignore values this close to zero; the center tick alone marks them.
const BAR_EPSILON = 0.005;

// Bars share one scale so magnitudes compare across rows: the largest
// enabled strength fills its half, never less than 1. A disabled row is
// dimmed and sits out, so switching one off rescales the others to the
// strongest row still in play (its own bar clamps at the edge meanwhile).
export function strengthBarScale(rows) {
  let peak = 0;
  for (const row of rows ?? []) {
    if (!row?.name || row.enabled === false) continue;
    const value = Math.abs(Number(row.strength));
    if (Number.isFinite(value)) peak = Math.max(peak, value);
  }
  return Math.max(1, peak);
}

// The bar's extent as percentages of the field width, 50 = zero.
export function strengthBarSpan(value, scale) {
  const magnitude = Math.abs(Number(value)) / (Number(scale) || 1);
  const half = 50 * Math.min(1, Number.isFinite(magnitude) ? magnitude : 0);
  return Number(value) >= 0
    ? { from: 50, to: 50 + half }
    : { from: 50 - half, to: 50 };
}

const pct = (value) => `${Number(value.toFixed(2))}%`;

// A complete CSS background value: outer-edge cap (2px), center tick (1px),
// translucent fill, base color. Empty-name rows and bars-off pass through
// the caller, which clears the inline style instead.
export function strengthBarBackground(value, scale, colors = BAR_COLORS) {
  const tick =
    `linear-gradient(to right, transparent calc(50% - 0.5px), ${colors.tick} ` +
    `calc(50% - 0.5px), ${colors.tick} calc(50% + 0.5px), transparent calc(50% + 0.5px))`;
  if (Math.abs(Number(value)) < BAR_EPSILON || !Number.isFinite(Number(value))) {
    return `${tick} ${colors.base}`;
  }
  const span = strengthBarSpan(value, scale);
  const positive = Number(value) >= 0;
  const fill = positive ? colors.positiveFill : colors.negativeFill;
  const capColor = positive ? colors.positiveCap : colors.negativeCap;
  const bar =
    `linear-gradient(to right, transparent ${pct(span.from)}, ${fill} ` +
    `${pct(span.from)}, ${fill} ${pct(span.to)}, transparent ${pct(span.to)})`;
  const cap = positive
    ? `linear-gradient(to right, transparent calc(${pct(span.to)} - 2px), ` +
      `${capColor} calc(${pct(span.to)} - 2px), ${capColor} ${pct(span.to)}, ` +
      `transparent ${pct(span.to)})`
    : `linear-gradient(to right, transparent ${pct(span.from)}, ${capColor} ` +
      `${pct(span.from)}, ${capColor} calc(${pct(span.from)} + 2px), ` +
      `transparent calc(${pct(span.from)} + 2px))`;
  return `${cap}, ${tick}, ${bar} ${colors.base}`;
}

// ---------- display names ----------

// What a row SHOWS for its lora; the serialized stack always keeps the full
// path. Folder and extension hiding are independent preferences.
export function shortLoraName(name, { hideFolders = true, hideExtension = true } = {}) {
  let text = String(name ?? "");
  if (hideFolders) text = text.split("/").pop().split("\\").pop();
  if (hideExtension) text = text.replace(/\.(safetensors|sft|ckpt|pt)$/i, "");
  return text;
}

// A long name is cut in the middle, not at the end: the end of a LoRA file
// name is usually what tells its checkpoints apart (_v1_000004000,
// -000012, _epoch_10), so it gets the larger share of the room. `measure`
// returns a string's width in the same units as maxWidth (canvas
// measureText in the browser), which keeps this testable.
const ELLIPSIS = "\u2026";
const TAIL_SHARE = 0.6;

export function middleEllipsis(text, maxWidth, measure) {
  const value = String(text ?? "");
  if (measure(value) <= maxWidth) return value;
  const build = (keep) => {
    const tail = Math.ceil(keep * TAIL_SHARE);
    return value.slice(0, keep - tail) + ELLIPSIS + value.slice(value.length - tail);
  };
  // Widest cut that fits: kept characters only ever add width.
  let low = 0;
  let high = value.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(build(mid)) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

// A path gives up its folder first: the folder is shortened from its end
// ("krea2/sty\u2026/"), and only when the file name alone does not fit is the
// file name itself cut in the middle, with the folder dropped. Returns the
// two parts to show, so the folder can be dimmed.
export function fitLoraLabel(label, maxWidth, measure) {
  const text = String(label ?? "");
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const folder = text.slice(0, slash + 1);
  const name = text.slice(slash + 1);
  if (measure(text) <= maxWidth) return { folder, name };
  if (folder.length > 2) {
    const room = maxWidth - measure(name);
    const marker = ELLIPSIS + folder.slice(-1);
    const shortened = (keep) => folder.slice(0, keep) + marker;
    if (measure(shortened(1)) <= room) {
      // Longest start of the folder that still fits, found by halving.
      let low = 1;
      let high = folder.length - 2;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (measure(shortened(mid)) <= room) low = mid;
        else high = mid - 1;
      }
      return { folder: shortened(low), name };
    }
  }
  return { folder: "", name: middleEllipsis(name, maxWidth, measure) };
}

// The picker grows to fit its longest name, so long names read whole in a
// narrow workspace; past the cap the middle ellipsis takes over. Never
// narrower than it used to open (260, or the name field plus 80 up to 380),
// never wider than the window.
export const PICKER_MIN_WIDTH = 260;
export const PICKER_MAX_WIDTH = 560;
export function pickerWidth(widestLabel, anchorWidth, viewportWidth, chrome = 48) {
  const floor = Math.max(PICKER_MIN_WIDTH, Math.min(380, (Number(anchorWidth) || 0) + 80));
  const wanted = Math.max(floor, Math.ceil((Number(widestLabel) || 0) + chrome));
  const cap = Math.min(PICKER_MAX_WIDTH, (Number(viewportWidth) || PICKER_MAX_WIDTH) - 16);
  return Math.min(wanted, cap);
}

// ---------- duplicate rows ----------

// Full names (case-insensitive) that appear on more than one row. Every copy
// gets flagged - symmetric, so the user picks which one to keep. Same file
// under two different folders is NOT a duplicate here: the stack would load
// both files, and that is worth showing truthfully.
export function duplicateLoraKeys(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    if (!row?.name) continue;
    const key = row.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  );
}

// ---------- master-toggle memory ----------

// The master pill cycles: mixed -> all on -> all off -> the remembered mixed
// state -> all on -> ... The snapshot is captured whenever the cycle leaves
// a mixed state, and refreshed by every individual toggle (the caller feeds
// snapshotEnabled back in), so an accidental master click is always one more
// click from the setup it destroyed.

export function snapshotEnabled(rows) {
  const map = {};
  for (const row of rows ?? []) {
    if (row?.name) map[row.id] = row.enabled !== false;
  }
  return map;
}

export function cycleMasterToggle(rows, snapshot) {
  const set = (enabled) =>
    rows.map((row) => (row.name ? { ...row, enabled } : row));
  const state = toggleAllState(rows);
  if (state === "mixed") return { rows: set(true), snapshot: snapshotEnabled(rows) };
  if (state === "on") return { rows: set(false), snapshot };
  // All off: restore the remembered setup when it still lights anything;
  // otherwise this is a plain binary toggle and everything turns on.
  const restored = rows.map((row) =>
    row.name && snapshot && row.id in snapshot
      ? { ...row, enabled: snapshot[row.id] }
      : row,
  );
  const remembersAnything = restored.some((row) => row.name && row.enabled);
  return remembersAnything ? { rows: restored, snapshot } : { rows: set(true), snapshot };
}

// ---------- absorb the loader chain ----------
//
// The gear menu's absorb action walks the model chain on BOTH sides of this
// node, lifts every recognized loader's rows into the stack, and bypasses
// the originals - so an old workflow's loader chain collapses into one
// QG-tools node without changing what the graph computes.

// LiteGraph node modes: 4 = bypass (pass-through), 2 = mute.
export const BYPASS_MODE = 4;
export const MUTE_MODE = 2;

const widgetValue = (nodeLike, name) =>
  nodeLike?.widgets?.find((widget) => widget?.name === name)?.value;

const cleanStrength = (value, fallback = 1) => {
  const number = Number(value);
  return roundStrength(Number.isFinite(number) ? number : fallback);
};

function entry(name, strength, strengthClip, enabled = true, triggers = "") {
  return {
    name: String(name),
    strength: cleanStrength(strength),
    strength_clip: cleanStrength(strengthClip, cleanStrength(strength)),
    enabled: enabled !== false,
    triggers: String(triggers ?? ""),
  };
}

// The loader rows a recognized node contributes, in its own apply order.
// Returns null for a node type this import does not understand - the caller
// stops walking there. nodeLike is a plain shape:
// { type, widgets: [{ name, value }] }.
export function loaderLoraEntries(nodeLike) {
  const type = String(nodeLike?.type ?? "");
  if (type === "LoraLoader" || type === "Lora Loader (JPS)") {
    const name = widgetValue(nodeLike, "lora_name");
    if (!name || name === "None") return [];
    return [entry(name, widgetValue(nodeLike, "strength_model"),
                  widgetValue(nodeLike, "strength_clip"),
                  type !== "Lora Loader (JPS)" || widgetValue(nodeLike, "switch") === "On")];
  }
  if (type === "LoraLoaderModelOnly") {
    const name = widgetValue(nodeLike, "lora_name");
    if (!name || name === "None") return [];
    // Model-only means CLIP untouched: clip strength 0 reproduces that
    // faithfully even when this node has a CLIP connected.
    return [entry(name, widgetValue(nodeLike, "strength_model"), 0)];
  }
  if (type === "Lora Loader Stack (rgthree)") {
    return (nodeLike.widgets ?? [])
      .filter((widget) => /^lora_\d+$/.test(widget.name) && widget.value && widget.value !== "None")
      .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)))
      .map((widget) => {
        const strength = widgetValue(nodeLike, `strength_${widget.name.slice(5)}`);
        return entry(widget.value, strength, strength);
      });
  }
  if (type === "Power Lora Loader (rgthree)") {
    const rows = [];
    for (const widget of nodeLike?.widgets ?? []) {
      const value = widget?.value;
      if (!value || typeof value !== "object" || !value.lora) continue;
      if (value.lora === "None") continue;
      const two = value.strengthTwo == null ? NaN : Number(value.strengthTwo);
      rows.push(entry(
        value.lora,
        value.strength,
        Number.isFinite(two) ? two : value.strength,
        value.on !== false,
      ));
    }
    return rows;
  }
  if (type === "PixaromaLoraLoader") {
    // Interop with the Pixaroma loader's serialized panel state: one widget
    // ("loras_ui") holding { loras: [{ name, on, sm, sc }] }.
    const panelState = widgetValue(nodeLike, "loras_ui");
    const list = panelState && typeof panelState === "object" ? panelState.loras : null;
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === "object" && item.name && item.name !== "None")
      .map((item) => entry(item.name, item.sm, item.sc, item.on !== false));
  }
  if (type === "QG_LoraLoader" || type === "AUSBOSS_LAB_LoraLoader") {
    try {
      const parsed = JSON.parse(String(widgetValue(nodeLike, "loras") ?? "[]"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((row) => row && typeof row === "object" && row.name)
        .map((row) => entry(row.name, row.strength,
                            row.strength_clip ?? row.strength,
                            row.enabled, row.triggers));
    } catch {
      return [];
    }
  }
  return null;
}

const baseName = (path) =>
  String(path).split("/").pop().split("\\").pop().toLowerCase();
const stripExt = (name) =>
  name.replace(/\.(safetensors|sft|ckpt|pt)$/i, "");

// Fit a foreign lora path to this install's list. Exact wins; then a unique
// case-insensitive full-path match; then a unique basename match ignoring
// the extension - which is what lets a workflow saved on another machine's
// folder layout land on the same file here.
export function resolveLoraName(name, available) {
  const list = Array.isArray(available) ? available : [];
  if (list.includes(name)) return { name, status: "exact" };
  const lower = String(name).toLowerCase();
  const fullMatches = list.filter((candidate) => candidate.toLowerCase() === lower);
  if (fullMatches.length === 1) return { name: fullMatches[0], status: "remapped" };
  const wanted = stripExt(baseName(name));
  const baseMatches = list.filter(
    (candidate) => stripExt(baseName(candidate)) === wanted,
  );
  if (baseMatches.length === 1) return { name: baseMatches[0], status: "remapped" };
  if (baseMatches.length > 1) return { name, status: "ambiguous" };
  return { name, status: "missing" };
}

// Merge rows for imports. Absorbing a live chain sets deduplicate=false:
// repeated filenames are separate patch applications and must all survive.
export function mergeImportedRows(existing, imported,
                                  { makeRow = newRow, position = "before", deduplicate = true } = {}) {
  const have = new Set(
    (existing ?? []).filter((row) => row?.name)
      .map((row) => row.name.toLowerCase()),
  );
  const added = [];
  let skipped = 0;
  for (const item of imported ?? []) {
    const key = String(item.name).toLowerCase();
    if (deduplicate && have.has(key)) {
      skipped += 1;
      continue;
    }
    have.add(key);
    added.push({ ...makeRow(), ...item });
  }
  const rows = (position === "after"
    ? [...(existing ?? []), ...added]
    : [...added, ...(existing ?? [])]).slice(0, MAX_ROWS);
  return { rows, added: added.length, skipped };
}

// Linked mode shows one strength per row; imported rows that patch model
// and CLIP differently (a model-only loader, an rgthree dual row) need the
// separate boxes or the difference would be invisible and lost on the
// first scrub.
export function importNeedsSeparateStrengths(entries) {
  return (entries ?? []).some(
    (item) => Number(item.strength) !== Number(item.strength_clip),
  );
}

// Toast summaries are composed from "{n}" templates (see shared/zh.mjs) so
// the zh plugin's dictionary can translate each fragment; counts never break
// whole-string matching because translation happens here, before the toast.
const SUMMARY_SEGMENTS = {
  empty: "No LoRA loaders found in the model chain.",
  imported1: "Imported {n} LoRA",
  importedN: "Imported {n} LoRAs",
  bypassed1: "bypassed {n} loader node",
  bypassedN: "bypassed {n} loader nodes",
  skipped: "skipped {n} already in the stack",
  remapped1: "{n} path remapped to this install",
  remappedN: "{n} paths remapped to this install",
  broken1: "{n} name not resolved - check the red rows",
  brokenN: "{n} names not resolved - check the red rows",
};

function segment(key, n) {
  return zhCount(SUMMARY_SEGMENTS[key], SUMMARY_SEGMENTS[key], n);
}

export function importSummary({ added = 0, skipped = 0, bypassed = 0,
                                remapped = 0, missing = 0, ambiguous = 0 } = {}) {
  if (!added && !skipped && !bypassed) return segment("empty", 0);
  const parts = [segment(added === 1 ? "imported1" : "importedN", added)];
  if (bypassed) parts.push(segment(bypassed === 1 ? "bypassed1" : "bypassedN", bypassed));
  if (skipped) parts.push(segment("skipped", skipped));
  if (remapped) parts.push(segment(remapped === 1 ? "remapped1" : "remappedN", remapped));
  const broken = missing + ambiguous;
  if (broken) parts.push(segment(broken === 1 ? "broken1" : "brokenN", broken));
  return `${parts.join(zhSep())}${zhEnd()}`;
}

function upstreamModelNode(node) {
  const graph = node.graph;
  if (!graph) return null;
  const input = node.inputs?.find((entry) =>
    String(entry?.type).toUpperCase() === "MODEL" || String(entry?.name).toLowerCase() === "model",
  ) ?? node.inputs?.[0];
  const linkId = input?.link;
  if (linkId === null || linkId === undefined) return null;
  const link = graph.links?.[linkId] ?? graph._links?.get?.(linkId);
  if (!link) return null;
  return graph.getNodeById?.(link.origin_id) ?? null;
}

// Loader nodes feeding the model input, nearest-first. Reroutes are walked
// through; already-bypassed loaders stay in the chain (bypass passes the
// model through, so the walk continues past them) but contribute no rows.
export function collectUpstreamLoaders(node) {
  const chain = [];
  const seen = new Set([node.id]);
  let current = upstreamModelNode(node);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const type = String(current.type ?? current.comfyClass ?? "");
    if (type === "Reroute") {
      current = upstreamModelNode(current);
      continue;
    }
    if (loaderLoraEntries({ type, widgets: current.widgets }) === null) break;
    chain.push(current);
    current = upstreamModelNode(current);
  }
  return chain;
}

// The single node this node's model output feeds - and only when it feeds
// exactly one. A fan-out ends the walk: bypassing a loader on one branch
// would silently change what every other branch computes.
function downstreamModelNode(node) {
  const graph = node.graph;
  if (!graph) return null;
  const output = node.outputs?.find((entry) =>
    String(entry?.type).toUpperCase() === "MODEL" || String(entry?.name).toLowerCase() === "model",
  ) ?? node.outputs?.[0];
  const links = output?.links;
  if (!Array.isArray(links) || links.length !== 1) return null;
  const link = graph.links?.[links[0]] ?? graph._links?.get?.(links[0]);
  if (!link) return null;
  return graph.getNodeById?.(link.target_id) ?? null;
}

// Loader nodes the model output feeds, nearest-first (= their apply order).
// Same rules as upstream: Reroutes pass through, an unrecognized type or a
// fan-out ends the walk.
export function collectDownstreamLoaders(node) {
  const chain = [];
  const seen = new Set([node.id]);
  let current = downstreamModelNode(node);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const type = String(current.type ?? current.comfyClass ?? "");
    if (type === "Reroute") {
      current = downstreamModelNode(current);
      continue;
    }
    if (loaderLoraEntries({ type, widgets: current.widgets }) === null) break;
    chain.push(current);
    current = downstreamModelNode(current);
  }
  return chain;
}

// Absorption moves patches and bypasses their old owners. Only a serial path
// can keep every consumer seeing the same patches, including CLIP consumers.
export function absorbChainIssue(node, upstream, downstream) {
  if ([2, 4].includes(node.mode ?? 0)) return "Enable this LoRA Loader before absorbing a chain.";
  if (node.inputs?.some(input => input.name === "loras" && input.link != null)) {
    return "This stack is supplied by a connected input. Disconnect it before absorbing; nothing was changed.";
  }
  const chain = [...upstream].reverse().concat(node, downstream);
  const active = item => ![2, 4].includes(item.mode ?? 0);
  const slotOf = (item, direction, type) => item[direction]?.find(slot => String(slot.type).toUpperCase() === type);
  const feedsOnly = (source, target, type) => {
    const seen = new Set();
    let output = slotOf(source, "outputs", type);
    while (output?.links?.length === 1) {
      const id = output.links[0];
      if (seen.has(id)) return false;
      seen.add(id);
      const graph = source.graph;
      const link = graph?.links?.[id] ?? graph?._links?.get?.(id);
      const next = graph?.getNodeById?.(link?.target_id);
      if (next === target) return target.inputs?.[link.target_slot] === slotOf(target, "inputs", type);
      if (next?.type !== "Reroute") return false;
      output = next.outputs?.[0];
    }
    return false;
  };
  for (let index = 1; index < chain.length; index++) {
    if (!feedsOnly(chain[index - 1], chain[index], "MODEL")) {
      return "The model chain branches or changes before reaching this stack. Keep shared loaders separate; nothing was absorbed.";
    }
  }
  const sources = [...upstream, ...downstream].filter(active);
  if (sources.some(source => source.outputs?.some(output =>
    !["MODEL", "CLIP"].includes(String(output.type).toUpperCase()) && output.links?.length))) {
    return "A source loader has another connected output, such as trigger words. Bypassing it would break that connection; nothing was absorbed.";
  }
  const movesClip = sources.some(source => slotOf(source, "inputs", "CLIP")?.link != null &&
    loaderLoraEntries({type: source.type, widgets: source.widgets})?.some(row => row.enabled && row.strength_clip !== 0));
  if (movesClip) {
    const clipChain = chain.filter(item => slotOf(item, "outputs", "CLIP"));
    if (slotOf(node, "inputs", "CLIP")?.link == null || clipChain.some((item, index) =>
      index > 0 && !feedsOnly(clipChain[index - 1], item, "CLIP"))) {
      return "CLIP must follow the same serial loader chain as MODEL to preserve its patches. Nothing was absorbed.";
    }
  }
  return null;
}

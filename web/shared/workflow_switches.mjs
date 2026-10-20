// Workflow Switches: the decisions behind js/workflow_switches/index.js.
// Which nodes a switch holds, whether it reads on, off or mixed, which rows
// the card lists and in what order, and which node modes a click changes. No
// DOM and no app import, so tests/workflow_switches.test.mjs runs it under
// node:test.
//
// A switch is either one the user made from picked nodes and groups (stored
// in the node's properties, by id) or a group listed on its own. A made
// switch can also change settings instead of turning nodes off: it keeps
// what chosen nodes' controls held when "on" was saved and when "off" was
// saved, and switches the values that differ. The truth lives in the nodes'
// own modes and values. Nothing here remembers what a switch was; every
// answer is read fresh from the graph, which is why a saved workflow, an
// undo or a change made by hand elsewhere always shows right.

// LiteGraph's node modes. Mute is the frontend's "never".
export const MODE_ALWAYS = 0;
export const MODE_NEVER = 2;
export const MODE_BYPASS = 4;

export const SETTINGS_PROPERTY = "qg_workflow_switches";

export const TITLE_MAX = 60;
export const SWITCHES_MAX = 40;
export const MEMBERS_MAX = 400;
// A switch that changes settings: how many nodes it may remember, how many
// controls of each, and how long a remembered text may be.
export const VALUE_NODES_MAX = 40;
export const VALUE_WIDGETS_MAX = 80;
export const VALUE_TEXT_MAX = 20000;

export const DEFAULT_SETTINGS = Object.freeze({
  off: "bypass", // what a switched-off part does: "bypass" | "mute"
  groups: "all", // which groups get a row of their own: "all" | "numbered" | "matching" | "none"
  match: "", // comma-separated title text, read when groups is "matching"
  order: "canvas", // group rows: "canvas" (the way the workflow reads) | "title"
  exclusive: false, // one at a time: switching a row on switches the other rows off
  // with one at a time on, how the card shows its rows: "rows" (each with its
  // own off | on) | "pill" (every row is a choice in one pill, one always picked)
  show: "rows",
  hidden: Object.freeze([]), // group titles whose rows were removed with the row's delete button
  switches: Object.freeze([]), // the made switches: { id, title, nodes, groups, on, off }
});

const CHOICES = {
  off: ["bypass", "mute"],
  groups: ["all", "numbered", "matching", "none"],
  order: ["canvas", "title"],
  show: ["rows", "pill"],
};

export function cleanTitle(title) {
  return String(title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

// Node and group ids as a workflow file stores them: numbers, or text for a
// frontend that names them. A whole number held as text ("12", which is how
// some frontends keep a node's id while the graph is open) is stored as the
// number, so a switch reads the same whichever one saved it. Anything else
// is dropped, and so is a repeat.
export function cleanIds(list, limit = MEMBERS_MAX) {
  const seen = new Set();
  const ids = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let id = null;
    if (typeof raw === "number" && Number.isFinite(raw)) id = raw;
    else if (typeof raw === "string" && /^(0|[1-9]\d{0,14})$/.test(raw.trim())) id = Number(raw.trim());
    else if (typeof raw === "string" && raw.trim()) id = raw.trim();
    if (id === null || seen.has(String(id))) continue;
    seen.add(String(id));
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

// A value a control can hold and a workflow file can store: text, a number,
// or on/off. Anything else (and text past the limit) is not remembered.
function cleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= VALUE_TEXT_MAX) return value;
  return undefined;
}

// One side of a switch that changes settings: for each of its nodes (by id)
// what the node's controls held when that side was saved, by widget name.
export function cleanSnapshots(raw) {
  const sides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sides;
  let nodes = 0;
  for (const [id, widgets] of Object.entries(raw)) {
    if (!widgets || typeof widgets !== "object" || Array.isArray(widgets)) continue;
    const kept = {};
    let count = 0;
    for (const [name, value] of Object.entries(widgets)) {
      const clean = cleanValue(value);
      if (clean === undefined || !name) continue;
      kept[name] = clean;
      count += 1;
      if (count >= VALUE_WIDGETS_MAX) break;
    }
    if (!count) continue;
    sides[String(id)] = kept;
    nodes += 1;
    if (nodes >= VALUE_NODES_MAX) break;
  }
  return sides;
}

// The made switches, whatever a saved workflow or a hand edit left there.
// Every switch keeps a small whole-number id of its own; a missing or
// repeated one is replaced, so two rows are never told apart by title. A
// node whose values a switch changes is not also turned off by it.
export function normalizeSwitches(raw) {
  const switches = [];
  const used = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue;
    let id = Number(item.id);
    if (!Number.isInteger(id) || id < 1 || used.has(id)) {
      id = 1;
      while (used.has(id)) id += 1;
    }
    used.add(id);
    const on = cleanSnapshots(item.on);
    const off = cleanSnapshots(item.off);
    switches.push({
      id,
      title: cleanTitle(item.title) || `Switch ${id}`,
      nodes: cleanIds(item.nodes).filter((member) => !(String(member) in on) && !(String(member) in off)),
      groups: cleanIds(item.groups),
      on,
      off,
    });
    if (switches.length >= SWITCHES_MAX) break;
  }
  return switches;
}

// Settings from a node property: unknown values fall back to the defaults,
// never throw.
export function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (allowed.includes(source[key])) settings[key] = source[key];
  }
  if (typeof source.match === "string") settings.match = source.match.slice(0, 200);
  if (typeof source.exclusive === "boolean") settings.exclusive = source.exclusive;
  if (Array.isArray(source.hidden)) {
    const seen = new Set();
    settings.hidden = source.hidden
      .slice(0, HIDDEN_MAX)
      .map(hiddenEntry)
      .filter((entry) => {
        if (!entry.id && !entry.title) return false;
        const key = hiddenKey(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  settings.switches = normalizeSwitches(source.switches);
  return settings;
}

// How many removed group titles are kept. The titles, not the groups, are
// stored: a group that is renamed shows again, one renamed to another
// removed title stays hidden.
export const HIDDEN_MAX = 100;

export function offMode(settings) {
  return settings?.off === "mute" ? MODE_NEVER : MODE_BYPASS;
}

// A node runs unless it is muted or bypassed.
export function isRunning(mode) {
  return mode !== MODE_NEVER && mode !== MODE_BYPASS;
}

// ---------- geometry ----------

// Half-open, like LiteGraph's own isInRect: a point on a box's right or
// bottom edge is outside it, so two boxes that touch never share a node.
export function isInRect(x, y, rect) {
  return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
}

// The rule the frontend uses to decide what moves with a group: a node
// belongs to every group whose box holds the centre of the node's box.
export function centreInside(rect, bounds) {
  return isInRect(bounds[0] + bounds[2] * 0.5, bounds[1] + bounds[3] * 0.5, rect);
}

function usableRect(rect) {
  return (
    rect != null && typeof rect.length === "number" && rect.length >= 4
    && [0, 1, 2, 3].every((index) => Number.isFinite(Number(rect[index])))
    && (Number(rect[2]) > 0 || Number(rect[3]) > 0)
  );
}

function toRect(rect) {
  return [Number(rect[0]), Number(rect[1]), Number(rect[2]), Number(rect[3])];
}

// A node's box as LiteGraph measures it: the body plus its title bar. The
// canvas re-measures every node on every frame it draws (the same pass that
// decides which nodes are visible), so the cached boundingRect is current;
// a node never measured yet is measured here from its position and size.
export function nodeBounds(node, { titleHeight = 30, collapsedWidth = 80 } = {}) {
  if (usableRect(node?.boundingRect)) return toRect(node.boundingRect);
  const pos = node?.pos ?? [0, 0];
  const size = node?.size ?? [0, 0];
  // Title modes: 1 = no title, 2 = transparent title; neither adds a bar.
  const bar = node?.title_mode === 1 || node?.title_mode === 2 ? 0 : titleHeight;
  const x = Number(pos[0]) || 0;
  const y = (Number(pos[1]) || 0) - bar;
  if (node?.flags?.collapsed) return [x, y, Number(node._collapsed_width) || collapsedWidth, titleHeight];
  return [x, y, Number(size[0]) || 0, (Number(size[1]) || 0) + bar];
}

export function groupBounds(group) {
  for (const rect of [group?.boundingRect, group?._bounding]) {
    if (usableRect(rect)) return toRect(rect);
  }
  const pos = group?.pos ?? [0, 0];
  const size = group?.size ?? [0, 0];
  return [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(size[0]) || 0, Number(size[1]) || 0];
}

// The smallest box around several boxes, or null for none: what the frame
// button brings into view for a switch whose nodes sit apart.
export function unionRect(rects) {
  let box = null;
  for (const rect of rects ?? []) {
    if (!usableRect(rect)) continue;
    const [x, y, w, h] = toRect(rect);
    if (!box) box = [x, y, x + w, y + h];
    else box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + w), Math.max(box[3], y + h)];
  }
  return box ? [box[0], box[1], box[2] - box[0], box[3] - box[1]] : null;
}

// What the frame button brings into view. The canvas fits a box to `fill` of
// the view, which would zoom far in on a part of two small nodes. A box that
// would be shown larger than life is grown around its centre until it shows
// at natural size; a big part still fits whole.
export function frameBounds(rect, view, fill = 0.8) {
  const [x, y, w, h] = toRect(rect);
  const minW = Number(view?.[0]) * fill;
  const minH = Number(view?.[1]) * fill;
  if (!(w > 0) || !(h > 0) || !(minW > 0) || !(minH > 0) || w >= minW || h >= minH) return [x, y, w, h];
  const grow = Math.min(minW / w, minH / h);
  return [x - (w * grow - w) / 2, y - (h * grow - h) / 2, w * grow, h * grow];
}

// ---------- reading a graph ----------

// Whether a node's mode changes what a run does. A subgraph node's does
// (while it is off nothing inside it runs) even though the frontend calls it
// virtual; other virtual nodes - notes, primitives, reroute nodes - never
// run, and neither does a node with no outputs that is not an output node (a
// Workflow Note, a Run Timer). Those still switch with their part, but they
// never make it read mixed.
export function modeMatters(node) {
  if (node?.isSubgraphNode?.() === true) return true;
  if (node?.isVirtualNode) return false;
  const definition = node?.constructor?.nodeData;
  if (definition && !definition.output_node && !(node.outputs?.length > 0)) return false;
  return true;
}

// What a switch shows. Only nodes whose mode changes a run are counted (a
// note inside a group never makes it read "mixed"); a part of nothing but
// such nodes is read from all of them, and one holding no node at all is
// "empty".
//
// A switch that changes settings adds one unit per setting (`pairs`, see
// readPairs): a setting at its "on" value counts as on, at its "off" value
// as off, and at anything else as neither, which reads mixed.
export function partState(members, counts = () => true, pairs = []) {
  const counted = members.filter(counts);
  const pool = counted.length || pairs.length ? counted : members;
  const total = pool.length + pairs.length;
  if (!total) return { state: "empty", on: 0, total: 0 };
  const running = pool.filter((node) => isRunning(node.mode)).length;
  const on = running + pairs.filter((pair) => pair.now === "on").length;
  const off = pool.length - running + pairs.filter((pair) => pair.now === "off").length;
  const state = on === total ? "on" : off === total ? "off" : "mixed";
  return { state, on, total };
}

// ---------- switches that change settings ----------

// What a node's own controls hold right now, by widget name: what "save as
// on" remembers. A card or panel that is not saved with the workflow has no
// value of its own and is left out.
export function snapshotNode(node) {
  const values = {};
  let count = 0;
  for (const widget of node?.widgets ?? []) {
    if (!widget || widget.serialize === false || typeof widget.name !== "string" || !widget.name) continue;
    const clean = cleanValue(widget.value);
    if (clean === undefined) continue;
    values[widget.name] = clean;
    count += 1;
    if (count >= VALUE_WIDGETS_MAX) break;
  }
  return values;
}

// A LoRA stack keeps every row in one text value: a list of rows, each with
// a file name and whether it is on. Returns the rows, or null for any other
// text.
export function stackRows(value) {
  if (typeof value !== "string" || !value.startsWith("[")) return null;
  let rows;
  try {
    rows = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const isRow = (row) => row && typeof row === "object" && typeof row.name === "string" && typeof row.enabled === "boolean";
  return rows.every(isRow) ? rows : null;
}

// A stack row is known by its file name, not by the folder in front of it:
// the LoRA Loader rewrites a row to the path it found the file at
// ("qwen/turbo.safetensors") on a refresh, and reads names the same way
// (resolveLoraName in lora_stack.mjs). The exact name wins; otherwise the one
// row with that file name. Two rows with one file name are never guessed at.
const fileKey = (name) =>
  String(name).split("/").pop().split("\\").pop().toLowerCase().replace(/\.(safetensors|sft|ckpt|pt)$/, "");

function findRow(rows, name) {
  const exact = rows.find((row) => row.name === name);
  if (exact) return exact;
  const wanted = fileKey(name);
  const same = rows.filter((row) => fileKey(row.name) === wanted);
  return same.length === 1 ? same[0] : undefined;
}

// A strength as the LoRA Loader reads it: a missing one is the fallback.
function strengthOf(value, fallback) {
  const number = value === null || value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// What a stack row holds that a switch can set: whether it is on, and its
// model and CLIP strengths, read the way the loader reads them (no strength
// is 1, no CLIP strength is the model's).
function rowSetting(row) {
  const strength = strengthOf(row.strength, 1);
  return { enabled: Boolean(row.enabled), strength, strength_clip: strengthOf(row.strength_clip, strength) };
}

const STRENGTHS = ["strength", "strength_clip"];

// What a switch sets on one stack row, for its on and its off: whether the
// row is on, and a strength only where the two sides give the row different
// ones. A switch made to turn a row on and off (both sides at one strength,
// the usual case) leaves the strength to the person: a row turned down to 0.6
// by hand keeps its 0.6 through every click and still reads on or off.
// Returns [on, off], or null when both sides hold the row the same way.
function rowSides(onRow, offRow) {
  const a = rowSetting(onRow);
  const b = rowSetting(offRow);
  const on = { enabled: a.enabled };
  const off = { enabled: b.enabled };
  let differs = a.enabled !== b.enabled;
  for (const key of STRENGTHS) {
    if (a[key] === b[key]) continue;
    on[key] = a[key];
    off[key] = b[key];
    differs = true;
  }
  return differs ? [on, off] : null;
}

// Whether a stack row holds everything one side of a switch sets on it.
function rowAt(row, side) {
  const now = rowSetting(row);
  return Object.keys(side).every((key) => now[key] === side[key]);
}

// The settings a switch changes: every control that held one value when "on"
// was saved and another when "off" was saved. A LoRA stack is compared row
// by row, by file name, so the switch moves only the rows that differ and
// leaves whatever else was changed in the stack since; on such a row it sets
// only what differs between the sides (see rowSides). Returns
// { node, widget, on, off } and, for a stack row, { ..., row }.
export function valuePairs(entry) {
  const pairs = [];
  for (const [id, on] of Object.entries(entry?.on ?? {})) {
    const off = entry?.off?.[id];
    if (!off) continue;
    for (const [widget, onValue] of Object.entries(on)) {
      if (!(widget in off) || off[widget] === onValue) continue;
      const offValue = off[widget];
      const onRows = stackRows(onValue);
      const offRows = stackRows(offValue);
      if (!onRows || !offRows) {
        pairs.push({ node: id, widget, on: onValue, off: offValue });
        continue;
      }
      for (const row of onRows) {
        const other = findRow(offRows, row.name);
        const sides = other && rowSides(row, other);
        if (sides) pairs.push({ node: id, widget, row: row.name, on: sides[0], off: sides[1] });
      }
    }
  }
  return pairs;
}

// Where a setting stands now: at its on value, its off value, or neither.
export function pairNow(pair, current) {
  if (pair.row === undefined) return current === pair.on ? "on" : current === pair.off ? "off" : "other";
  const rows = stackRows(current);
  const row = rows && findRow(rows, pair.row);
  if (!row) return "other";
  return rowAt(row, pair.on) ? "on" : rowAt(row, pair.off) ? "off" : "other";
}

// The value a control should hold for one side of a switch. For a stack row
// it is the stack as it is now with that one row changed, and only in what
// the switch sets on it: the row's other strengths and its triggers stay.
export function pairValue(pair, side, current) {
  const want = side === "on" ? pair.on : pair.off;
  if (pair.row === undefined) return want;
  const rows = stackRows(current);
  if (!rows) return current;
  const target = findRow(rows, pair.row);
  return JSON.stringify(rows.map((row) => (row === target ? { ...row, ...want } : row)));
}

// A switch's settings as they stand on the graph: each pair with its node,
// its control and where it is now. A pair whose node or control is gone is
// left out.
export function readPairs(entry, nodeById) {
  const pairs = [];
  for (const pair of valuePairs(entry)) {
    const live = nodeById.get(String(pair.node))?.node;
    const control = live?.widgets?.find((widget) => widget?.name === pair.widget);
    if (!control) continue;
    pairs.push({ ...pair, live, control, now: pairNow(pair, control.value) });
  }
  return pairs;
}

// Every node a switch may touch, with its box. `skip` leaves nodes out
// entirely (a Workflow Switches node never switches itself or another one).
export function placeNodes(nodes, { skip = () => false, measure = {} } = {}) {
  const placed = [];
  for (const node of nodes ?? []) {
    if (!node || skip(node)) continue;
    placed.push({ node, rect: nodeBounds(node, measure) });
  }
  return placed;
}

// Every group of a graph with the nodes inside it and its state. `counts`
// says whose mode decides the state (see partState).
export function readGroups(groups, placed, { counts = () => true } = {}) {
  return [...(groups ?? [])].filter(Boolean).map((group) => {
    const rect = groupBounds(group);
    const members = placed.filter((entry) => centreInside(rect, entry.rect)).map((entry) => entry.node);
    return {
      kind: "group",
      group,
      rect,
      title: String(group.title ?? ""),
      color: typeof group.color === "string" && group.color ? group.color : null,
      members,
      ...partState(members, counts),
    };
  });
}

// The made switches with the nodes they hold right now: the picked nodes
// that still exist, plus whatever sits inside a picked group at this moment.
// An id whose node or group is gone is passed over, never removed here: a
// graph that is still loading has not got all its nodes yet.
export function readSwitches(switches, placed, groupRows, { counts = () => true } = {}) {
  const nodeById = new Map(placed.map((entry) => [String(entry.node.id), entry]));
  const groupById = new Map();
  for (const row of groupRows ?? []) {
    const id = row.group?.id;
    if (id !== undefined && id !== null && !groupById.has(String(id))) groupById.set(String(id), row);
  }
  return (switches ?? []).map((entry) => {
    const members = [];
    const seen = new Set();
    const rects = [];
    let gone = 0;
    for (const id of entry.nodes ?? []) {
      const hit = nodeById.get(String(id));
      if (!hit) {
        gone += 1;
        continue;
      }
      if (seen.has(hit.node)) continue;
      seen.add(hit.node);
      members.push(hit.node);
      rects.push(hit.rect);
    }
    for (const id of entry.groups ?? []) {
      const row = groupById.get(String(id));
      if (!row) {
        gone += 1;
        continue;
      }
      rects.push(row.rect);
      for (const node of row.members) {
        if (seen.has(node)) continue;
        seen.add(node);
        members.push(node);
      }
    }
    // The nodes whose settings it changes: listed, framed and selected with
    // the rest, but never turned off by it.
    const valueNodes = [];
    const sides = new Set([...Object.keys(entry.on ?? {}), ...Object.keys(entry.off ?? {})]);
    for (const id of sides) {
      const hit = nodeById.get(id);
      if (!hit) {
        gone += 1;
        continue;
      }
      valueNodes.push(hit.node);
      rects.push(hit.rect);
    }
    const pairs = readPairs(entry, nodeById);
    return {
      kind: "switch",
      entry,
      rect: unionRect(rects),
      title: entry.title,
      color: null,
      members,
      valueNodes,
      pairs,
      // Saved for one side only so far: nothing to switch between yet.
      half: [...sides].some((id) => !(entry.on?.[id] && entry.off?.[id])),
      gone,
      ...partState(members, counts, pairs),
    };
  });
}

// ---------- which groups, in which order ----------

export function matchTerms(text) {
  return String(text ?? "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

// "numbered" keeps the titles that start with a digit - the stage groups of
// a workflow laid out as 1 · Load, 2 · Create, ... - and "matching" keeps
// titles containing any of the comma-separated terms (no terms, no filter).
// "none" lists no group at all: only the made switches show.
// A removed group row is remembered by the group's own id, so two groups
// that share a title are separate rows, and a renamed group stays removed.
// A group without an id (an older file, a frontend that names no groups)
// falls back to its title - and such a record only ever matches a group
// that has no id either, so one group is never taken for another.
function hiddenEntry(raw) {
  if (raw && typeof raw === "object") {
    const id = raw.id === undefined || raw.id === null ? "" : String(raw.id);
    return { id, title: cleanTitle(raw.title) };
  }
  return { id: "", title: cleanTitle(raw) };
}

function hiddenKey(entry) {
  return entry.id ? `#${entry.id}` : `~${entry.title.toLowerCase()}`;
}

export function groupListed(title, settings, id) {
  const text = String(title ?? "").trim();
  if (settings?.groups === "none") return false;
  // A row removed by hand stays away until Restore in the settings puts it
  // back. Nothing on the canvas is touched either way.
  const key = id === undefined || id === null || id === "" ? "" : String(id);
  const lower = text.toLowerCase();
  const gone = (settings?.hidden ?? []).some((raw) => {
    const entry = hiddenEntry(raw);
    return entry.id ? entry.id === key : !key && entry.title.toLowerCase() === lower;
  });
  if (gone) return false;
  if (settings?.groups === "numbered") return /^\d/.test(text);
  if (settings?.groups === "matching") {
    const terms = matchTerms(settings.match);
    return !terms.length || terms.some((term) => lower.includes(term));
  }
  return true;
}

// Canvas order is the way a left-to-right workflow reads: column by column,
// and top to bottom inside a column. A group joins the column on its left
// when it starts before that column's narrowest centre line, so a stage
// stacked under another reads straight after it (1, 2 | 3, 4 | 5 ...), where
// a row-by-row order would jump across the canvas and back.
export function canvasOrder(items, rectOf = (item) => item.rect) {
  const sorted = [...items].sort((a, b) => rectOf(a)[0] - rectOf(b)[0] || rectOf(a)[1] - rectOf(b)[1]);
  const columns = [];
  let column = null;
  let centre = Infinity;
  for (const item of sorted) {
    const [x, , w] = rectOf(item);
    if (column && x < centre) {
      column.push(item);
      centre = Math.min(centre, x + w * 0.5);
      continue;
    }
    column = [item];
    centre = x + w * 0.5;
    columns.push(column);
  }
  return columns.flatMap((members) => members.sort((a, b) => rectOf(a)[1] - rectOf(b)[1] || rectOf(a)[0] - rectOf(b)[0]));
}

const TITLE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Title order compares numbers as numbers, so "10 · Save" follows "9 · Upscale".
export function titleOrder(items, titleOf = (item) => item.title) {
  const canvas = canvasOrder(items);
  const place = new Map(canvas.map((item, index) => [item, index]));
  return [...items].sort((a, b) => TITLE_COLLATOR.compare(titleOf(a), titleOf(b)) || place.get(a) - place.get(b));
}

// The rows the card shows: the made switches in the order they were made
// (or moved to), then the listed groups in the chosen order.
export function listedRows(switchRows, groupRows, settings) {
  const listed = (groupRows ?? []).filter((row) => groupListed(row.title, settings, row.group?.id));
  const ordered = settings?.order === "title" ? titleOrder(listed) : canvasOrder(listed);
  return [...(switchRows ?? []), ...ordered];
}

// ---------- switching ----------

// What a click on a row's pill asks for. The pill is one switch: a click
// anywhere on it flips it, on the "off" half as much as on the "on" half.
// Only while the row reads mixed (neither half lit) does the half that was
// clicked decide: `side` is true for the on half.
export function flipTo(state, side) {
  if (state === "on") return false;
  if (state === "off") return true;
  return Boolean(side);
}

// The mode changes one click makes: every node of the row turns on (always)
// or off (bypass or mute), exactly what the frontend's own "Bypass Group
// Nodes" / "Set Group Nodes to Always" do. One at a time first turns every
// other listed row off and then this one on, so a node two rows share ends
// up on. Returns [node, mode] pairs for the nodes that change.
export function switchPlan(rows, target, on, settings) {
  const off = offMode(settings);
  const modes = new Map();
  if (on && settings?.exclusive) {
    for (const row of rows) {
      if (row === target) continue;
      for (const node of row.members) modes.set(node, off);
    }
  }
  for (const node of target?.members ?? []) modes.set(node, on ? MODE_ALWAYS : off);
  return [...modes].filter(([node, mode]) => node.mode !== mode);
}

// Every listed row on or off at once (the node's right-click menu).
export function switchAllPlan(rows, on, settings) {
  const mode = on ? MODE_ALWAYS : offMode(settings);
  const modes = new Map();
  for (const row of rows) for (const node of row.members) modes.set(node, mode);
  return [...modes].filter(([node, value]) => node.mode !== value);
}

// The settings one click changes, as [pair, side]: every setting of the row
// goes to its on or its off value, and one at a time first sends the other
// rows' settings to off. Only the settings not already there are returned.
export function valuePlan(rows, target, on, settings) {
  const sides = new Map();
  const key = (pair) => `${pair.node}|${pair.widget}|${pair.row ?? ""}`;
  if (on && settings?.exclusive) {
    for (const row of rows) {
      if (row === target) continue;
      for (const pair of row.pairs ?? []) sides.set(key(pair), [pair, "off"]);
    }
  }
  for (const pair of target?.pairs ?? []) sides.set(key(pair), [pair, on ? "on" : "off"]);
  return [...sides.values()].filter(([pair, side]) => pair.now !== side);
}

export function valueAllPlan(rows, on) {
  const sides = new Map();
  for (const row of rows) for (const pair of row.pairs ?? []) sides.set(`${pair.node}|${pair.widget}|${pair.row ?? ""}`, [pair, on ? "on" : "off"]);
  return [...sides.values()].filter(([pair, side]) => pair.now !== side);
}

// ---------- one pill for the whole card ----------

// With One at a time on, a card can show its rows as one control: every row
// is a choice, and exactly one is picked. Up to PILL_CHOICES_MAX choices sit
// side by side in a segmented pill; more are a list to pick from, the widget
// cards' rule.
export const PILL_CHOICES_MAX = 4;
// What lies between a node's edge and the names in its pill, both sides
// together: the panel's frame (12 a side in Nodes 2.0, 10 in the classic
// renderer), the card's border and padding (9) and the pill's own (3).
export const PILL_FRAME = 48;
// The room a segment keeps beside its name: 6 px a side, and 2 for rounding.
export const PILL_SEGMENT_PAD = 14;
// The widest a node is made for the sake of its pill. Names that need more
// are a list too.
export const PILL_NODE_WIDTH_MAX = 400;

// What a choice is called: the row's title, or a plain word for a group
// nobody named.
export function rowLabel(row) {
  return row?.title || (row?.kind === "switch" ? "Switch" : "Group");
}

// A guess at a name's width where it cannot be measured (under node:test).
const guessWidth = (text) => [...String(text ?? "")].length * 6.5;

// How wide a node must be for its pill to show every name in full. The
// segments are equally wide, so the longest name decides. `measure` gives a
// name's width in pixels, drawn the way a segment draws it.
export function pillNodeWidth(labels, measure = guessWidth) {
  const longest = (labels ?? []).reduce((widest, label) => Math.max(widest, Number(measure(label)) || 0), 0);
  return Math.ceil(PILL_FRAME + (labels?.length ?? 0) * (longest + PILL_SEGMENT_PAD));
}

// How a card shows its rows: "rows" (one row each, the look every card had
// before, and the default), "pill" (one segmented pill) or "list" (one list
// to pick from). The last two need One at a time, Show as set to one pill,
// and at least two rows: one row alone has nothing to be picked against.
// `width` is the node width the pill needs, which the card holds as its floor
// so that no name is cut short; 0 for the other two.
export function cardView(settings, rows, measure = guessWidth) {
  const count = rows?.length ?? 0;
  if (!settings?.exclusive || settings.show !== "pill" || count < 2) return { view: "rows", width: 0 };
  if (count <= PILL_CHOICES_MAX) {
    const width = pillNodeWidth(rows.map(rowLabel), measure);
    if (width <= PILL_NODE_WIDTH_MAX) return { view: "pill", width };
  }
  return { view: "list", width: 0 };
}

// Where a pick-one card stands. It is settled ("one", with the row that is
// `picked`) when exactly one row is on and no other row is partly on. Any
// other state is told as it is: "none" (nothing on), "partly" (one row, and
// only some of it) or "several" (`count` rows on or partly on). A graph edited
// by hand, or saved before the card was a pill, can be in any of them.
export function choiceState(rows) {
  const on = (rows ?? []).filter((row) => row.state === "on");
  const mixed = (rows ?? []).filter((row) => row.state === "mixed");
  if (on.length === 1 && !mixed.length) return { kind: "one", picked: on[0], count: 1 };
  if (!on.length && !mixed.length) return { kind: "none", picked: null, count: 0 };
  if (!on.length && mixed.length === 1) return { kind: "partly", picked: null, count: 1 };
  return { kind: "several", picked: null, count: on.length + mixed.length };
}

// What a click on a choice changes: that row goes on and every other row
// off, as one at a time does. `modes` and `values` are switchPlan's and
// valuePlan's answers. Both are empty for the choice that is already the only
// one on, so a click on it does nothing and one stays picked; from any other
// state one click leaves exactly this row on. A row with nothing in it cannot
// be picked: it would only switch the others off.
export function choosePlan(rows, target, settings) {
  if (!target || target.state === "empty") return { modes: [], values: [] };
  const one = { ...settings, exclusive: true };
  return { modes: switchPlan(rows, target, true, one), values: valuePlan(rows, target, true, one) };
}

// ---------- making and changing switches ----------

function withSwitches(settings, switches) {
  return { ...normalizeSettings(settings), switches };
}

function pickedIds(picked) {
  return { nodes: cleanIds(picked?.nodes), groups: cleanIds(picked?.groups) };
}

// A name for a new switch, from what was picked: the one box (subgraph) in
// the selection, else the one group, else the first node. `picked` carries
// titles here, not ids: { nodes: [{ title, box }], groups: [{ title }] }.
// A name already on the card gets a number, so two rows never read the same.
export function suggestTitle(picked, taken = []) {
  const nodes = picked?.nodes ?? [];
  const groups = picked?.groups ?? [];
  const boxes = nodes.filter((node) => node?.box);
  let base = "";
  if (boxes.length === 1) base = boxes[0].title;
  else if (groups.length === 1) base = groups[0].title;
  else if (nodes.length) base = nodes[0].title;
  else if (groups.length) base = groups[0].title;
  base = cleanTitle(base) || "Switch";
  const used = new Set(taken.map((title) => cleanTitle(title).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let number = 2; number < 1000; number += 1) {
    const next = cleanTitle(`${base.slice(0, TITLE_MAX - 4)} ${number}`);
    if (!used.has(next.toLowerCase())) return next;
  }
  return base;
}

// A new switch at the end of the list. Returns the new settings and the
// switch's id, or id null when there is no room for another.
export function addSwitch(settings, { title, nodes, groups } = {}) {
  const current = normalizeSettings(settings);
  if (current.switches.length >= SWITCHES_MAX) return { settings: current, id: null };
  const id = current.switches.reduce((highest, entry) => Math.max(highest, entry.id), 0) + 1;
  const entry = { id, title: cleanTitle(title) || `Switch ${id}`, ...pickedIds({ nodes, groups }), on: {}, off: {} };
  return { settings: withSwitches(current, [...current.switches, entry]), id };
}

function changeSwitch(settings, id, change) {
  const current = normalizeSettings(settings);
  return withSwitches(current, current.switches.map((entry) => (entry.id === id ? { ...entry, ...change(entry) } : entry)));
}

// An empty name keeps the old one: a switch is never left without a label.
export function renameSwitch(settings, id, title) {
  const next = cleanTitle(title);
  return changeSwitch(settings, id, (entry) => ({ title: next || entry.title }));
}

export function removeSwitch(settings, id) {
  const current = normalizeSettings(settings);
  return withSwitches(current, current.switches.filter((entry) => entry.id !== id));
}

// Takes a group's row off the card: the group's own id joins `hidden` (its
// title when the group has no id), so the row stays away until Restore puts
// it back. The group's nodes are never touched.
export function hideGroup(settings, { id, title } = {}) {
  const current = normalizeSettings(settings);
  const name = cleanTitle(title);
  const key = id === undefined || id === null ? "" : String(id);
  if (!key && !name) return current;
  const lower = name.toLowerCase();
  const same = (entry) => (entry.id ? entry.id === key : !key && entry.title.toLowerCase() === lower);
  if (current.hidden.some((raw) => same(hiddenEntry(raw)))) return current;
  return { ...current, hidden: [...current.hidden, { id: key, title: name }].slice(-HIDDEN_MAX) };
}

// Puts every removed group row back.
export function restoreGroups(settings) {
  const current = normalizeSettings(settings);
  return current.hidden.length ? { ...current, hidden: [] } : current;
}

// One place up (-1) or down (+1) the list; the ends stay put.
export function moveSwitch(settings, id, step) {
  const current = normalizeSettings(settings);
  const from = current.switches.findIndex((entry) => entry.id === id);
  const to = from + (step < 0 ? -1 : 1);
  if (from < 0 || to < 0 || to >= current.switches.length) return current;
  const switches = [...current.switches];
  [switches[from], switches[to]] = [switches[to], switches[from]];
  return withSwitches(current, switches);
}

// A node whose settings the switch already changes stays that way: it is
// not also turned off.
export function addMembers(settings, id, picked) {
  const extra = pickedIds(picked);
  return changeSwitch(settings, id, (entry) => ({
    nodes: cleanIds([...entry.nodes, ...extra.nodes]).filter((member) => !(String(member) in entry.on) && !(String(member) in entry.off)),
    groups: cleanIds([...entry.groups, ...extra.groups]),
  }));
}

function withoutKeys(sides, drop) {
  return Object.fromEntries(Object.entries(sides ?? {}).filter(([id]) => !drop.has(id)));
}

// Taking a node out also forgets the values the switch saved for it.
export function removeMembers(settings, id, picked) {
  const drop = pickedIds(picked);
  const nodes = new Set(drop.nodes.map(String));
  const groups = new Set(drop.groups.map(String));
  return changeSwitch(settings, id, (entry) => ({
    nodes: entry.nodes.filter((member) => !nodes.has(String(member))),
    groups: entry.groups.filter((member) => !groups.has(String(member))),
    on: withoutKeys(entry.on, nodes),
    off: withoutKeys(entry.off, nodes),
  }));
}

// How many of the picked nodes and groups a switch already holds, to turn
// off or to change the settings of.
export function heldCount(entry, picked) {
  const want = pickedIds(picked);
  const nodes = new Set([...(entry?.nodes ?? []).map(String), ...Object.keys(entry?.on ?? {}), ...Object.keys(entry?.off ?? {})]);
  const groups = new Set((entry?.groups ?? []).map(String));
  return want.nodes.filter((id) => nodes.has(String(id))).length + want.groups.filter((id) => groups.has(String(id))).length;
}

// Save what the picked nodes hold right now as one side of a switch ("on"
// or "off"). `snapshots` is [{ id, values }], values from snapshotNode. From
// then on the switch changes those nodes' settings and no longer turns them
// off.
export function saveValues(settings, id, side, snapshots) {
  if (side !== "on" && side !== "off") return normalizeSettings(settings);
  const saved = {};
  for (const item of snapshots ?? []) {
    const [nodeId] = cleanIds([item?.id]);
    if (nodeId === undefined) continue;
    saved[String(nodeId)] = item.values;
  }
  const ids = new Set(Object.keys(saved));
  return changeSwitch(settings, id, (entry) => ({
    nodes: entry.nodes.filter((member) => !ids.has(String(member))),
    [side]: cleanSnapshots({ ...entry[side], ...saved }),
  }));
}

// ---------- change detection ----------

// Everything the card draws, as one string: when it matches the last one,
// the redraw that asked has nothing to update.
export function rowsSignature(rows, settings, keyOf = (row) => row.title) {
  return JSON.stringify([
    settings,
    rows.map((row) => [
      row.kind, keyOf(row), row.title, row.color, row.state, row.on, row.total, row.members?.length ?? 0, row.gone ?? 0,
      row.pairs?.length ?? 0, row.half ?? false,
    ]),
  ]);
}

// Whether two stack row names are the same LoRA: the same name, or the same
// file in another folder (see fileKey).
function sameFile(a, b) {
  return a === b || (Boolean(a) && Boolean(b) && fileKey(a) === fileKey(b));
}

// The made switches that move one row of a LoRA stack: every switch, on any
// of the given Workflow Switches nodes, whose settings change that row of
// that control on that node. `boards` is [{ node, settings }], one per
// Workflow Switches node; the answer is [{ node, id, title }].
export function stackRowOwners(boards, nodeId, widget, rowName) {
  const owners = [];
  if (!rowName) return owners;
  for (const { node, settings } of boards ?? []) {
    for (const entry of normalizeSettings(settings).switches) {
      const moves = valuePairs(entry).some(
        (pair) => pair.row !== undefined && String(pair.node) === String(nodeId) && pair.widget === widget && sameFile(pair.row, rowName),
      );
      if (moves) owners.push({ node, id: entry.id, title: entry.title });
    }
  }
  return owners;
}

// Take one row of a LoRA stack away from a switch: both of its saved sides
// forget that row, so the switch leaves it alone and no longer reads
// "changed" because of it. The rest of what the switch does stays.
export function releaseStackRow(settings, id, nodeId, widget, rowName) {
  const forget = (side) => {
    const values = side?.[String(nodeId)];
    const rows = stackRows(values?.[widget]);
    const row = rows && findRow(rows, rowName);
    if (!row) return side;
    return { ...side, [String(nodeId)]: { ...values, [widget]: JSON.stringify(rows.filter((other) => other !== row)) } };
  };
  return changeSwitch(settings, id, (entry) => ({ on: forget(entry.on), off: forget(entry.off) }));
}

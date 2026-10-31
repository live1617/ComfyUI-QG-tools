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
//
// A made switch may have two sides instead of one. Its ordinary side runs
// while the row is on and stops while it is off; its other side (`nodes_off`
// and `groups_off`) does the exact opposite, so one click can hand a run
// from one path to another: a detail pass on, a shortcut off, and back. A
// node belongs to one side only - adding it to one takes it off the other.

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
  switches: Object.freeze([]), // the made switches: { id, title, nodes, groups, nodes_off?, groups_off?, on, off }
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

// One id as a workflow file may hold it: a node or group number, or the text
// a frontend gives a group it does not number. A whole number held as text
// ("12", which is how some frontends keep an id while the graph is open) reads
// back as the number, so a switch saved by one frontend and opened in another
// still points at the same node. Anything that cannot name a node or a group -
// a fraction, a negative, an object, a blank - is null.
function readId(raw) {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  return /^(0|[1-9]\d{0,14})$/.test(text) ? Number(text) : text;
}

// Node and group ids as a workflow file stores them: numbers, or text for a
// frontend that names them. Anything else is dropped, and so is a repeat -
// text "3" and number 3 name the same node, so they are one id, not two.
export function cleanIds(list, limit = MEMBERS_MAX) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = readId(raw);
    if (id === null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

// A value a control can hold and a workflow file can store: text, a number,
// or on/off. Anything else - a list, a nested object, nothing at all, text
// past the limit - is not remembered.
function cleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= VALUE_TEXT_MAX) return value;
  return undefined;
}

// One side of a switch that changes settings: for each of its nodes (by id)
// what the node's controls held when that side was saved, by widget name. A
// node left with no control at all is not remembered either - a side that
// says nothing about it would only make the row look saved when it is not.
export function cleanSnapshots(raw) {
  const sides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sides;
  let nodes = 0;
  for (const [id, widgets] of Object.entries(raw)) {
    if (nodes >= VALUE_NODES_MAX) break;
    if (!widgets || typeof widgets !== "object" || Array.isArray(widgets)) continue;
    const kept = {};
    let count = 0;
    for (const [name, value] of Object.entries(widgets)) {
      if (count >= VALUE_WIDGETS_MAX) break;
      const clean = cleanValue(value);
      if (clean === undefined || !name) continue;
      kept[name] = clean;
      count += 1;
    }
    if (!count) continue;
    sides[String(id)] = kept;
    nodes += 1;
  }
  return sides;
}

// The smallest number no switch is using yet, for a saved id that is missing,
// not a number, or already taken by an earlier switch.
function takeSwitchId(used, raw) {
  let id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || used.has(id)) {
    id = 1;
    while (used.has(id)) id += 1;
  }
  used.add(id);
  return id;
}

// The made switches, whatever a saved workflow or a hand edit left there.
// Every switch keeps a small whole-number id of its own, so two rows are never
// told apart by title. No node is asked to do two things at once: a node whose
// settings a switch changes is set, not switched, so it belongs to no side;
// and a node or group listed on both sides stays on the one that runs while
// the row is on.
export function normalizeSwitches(raw) {
  const switches = [];
  const used = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (switches.length >= SWITCHES_MAX) break;
    if (!item || typeof item !== "object") continue;
    const id = takeSwitchId(used, item.id);
    const on = cleanSnapshots(item.on);
    const off = cleanSnapshots(item.off);
    const set = new Set([...Object.keys(on), ...Object.keys(off)]);
    const switched = (ids) => ids.filter((member) => !set.has(String(member)));
    const nodes = switched(cleanIds(item.nodes));
    const groups = cleanIds(item.groups);
    const own = new Set(nodes.map(String));
    const ownGroups = new Set(groups.map(String));
    const nodesOff = switched(cleanIds(item.nodes_off)).filter((member) => !own.has(String(member)));
    const groupsOff = cleanIds(item.groups_off).filter((member) => !ownGroups.has(String(member)));
    switches.push({
      id,
      title: cleanTitle(item.title) || `Switch ${id}`,
      nodes,
      groups,
      // Left out rather than stored empty: a switch with no other side keeps
      // the file it always had.
      ...(nodesOff.length ? { nodes_off: nodesOff } : {}),
      ...(groupsOff.length ? { groups_off: groupsOff } : {}),
      on,
      off,
    });
  }
  return switches;
}

// Whether a made switch has anything on its other side: nodes or groups that
// run only while its row is off.
export function hasOffSide(entry) {
  return Boolean(entry?.nodes_off?.length || entry?.groups_off?.length);
}

// Settings from a node property, the way the card needs them: a value outside
// its list falls back to the default, and nothing here ever throws - this runs
// while a workflow is being opened, where one bad number would cost the whole
// file. The two lists are always fresh arrays, never the frozen defaults, so a
// caller that edits one cannot poison every card opened after it.
const MATCH_MAX = 200;

export function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, hidden: [], switches: normalizeSwitches(source.switches) };
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (allowed.includes(source[key])) settings[key] = source[key];
  }
  if (typeof source.match === "string") settings.match = source.match.slice(0, MATCH_MAX);
  if (typeof source.exclusive === "boolean") settings.exclusive = source.exclusive;
  if (Array.isArray(source.hidden)) {
    // One record per group, the way hiddenRecord reads them, and no group
    // recorded twice: an old file can list the same row by title and by id
    // after the group was renamed.
    const taken = new Set();
    for (const entry of source.hidden.slice(0, HIDDEN_MAX)) {
      const record = hiddenRecord(entry);
      if (!record.id && !record.title) continue;
      const key = record.id ? `id:${record.id}` : `title:${record.title.toLowerCase()}`;
      if (taken.has(key)) continue;
      taken.add(key);
      settings.hidden.push(record);
    }
  }
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
//
// A box is what LiteGraph keeps: [x, y, w, h]. Everything here answers the
// same two questions - is this thing a box at all, and if it is, where does
// it reach - so the reading code above never has to look at positions and
// sizes itself.

// Four finite numbers, or null. Lenient: a box of no size is still a box
// here, because a frame request for one has to be answered as given.
function numbersOf(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.length !== "number" || value.length < 4) return null;
  const box = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  return box.every(Number.isFinite) ? box : null;
}

// A box to place things by, or null. Stricter than numbersOf: a box with no
// width and no height is what a node that has never been drawn carries, and
// taking it for real would drag every union of boxes back to the origin.
function asRect(value) {
  const box = numbersOf(value);
  return box && (box[2] > 0 || box[3] > 0) ? box : null;
}

// Half-open, the way LiteGraph's own hit test is: a point on a box's right
// or bottom edge is already outside it, so two boxes that touch never both
// claim the same node.
export function isInRect(x, y, rect) {
  return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
}

// The rule the frontend uses to decide what moves with a group: a node
// belongs to every group whose box holds the centre of the node's box.
export function centreInside(rect, bounds) {
  return isInRect(bounds[0] + bounds[2] * 0.5, bounds[1] + bounds[3] * 0.5, rect);
}

// A node's box as the canvas measures it. The canvas re-measures every node
// on every frame it draws - the same pass that decides what is visible - so a
// node's own boundingRect is current; a node not drawn yet is measured here
// from where it sits and how big it says it is. pos is the body's top left
// corner, so the title bar goes above it.
export function nodeBounds(node, { titleHeight = 30, collapsedWidth = 80 } = {}) {
  const cached = asRect(node?.boundingRect);
  if (cached) return cached;
  const pos = node?.pos ?? [];
  const size = node?.size ?? [];
  const x = Number(pos[0]) || 0;
  const y = Number(pos[1]) || 0;
  // Title modes 1 (no title) and 2 (transparent title) draw no bar.
  const bar = node?.title_mode === 1 || node?.title_mode === 2 ? 0 : titleHeight;
  if (node?.flags?.collapsed) {
    return [x, y - bar, Number(node?._collapsed_width) || collapsedWidth, titleHeight];
  }
  return [x, y - bar, Number(size[0]) || 0, (Number(size[1]) || 0) + bar];
}

// A group's box: the one the canvas computed, then the frontend's own
// private one, and only then its position and size added up by hand.
export function groupBounds(group) {
  const cached = asRect(group?.boundingRect) ?? asRect(group?._bounding);
  if (cached) return cached;
  const pos = group?.pos ?? [];
  const size = group?.size ?? [];
  return [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(size[0]) || 0, Number(size[1]) || 0];
}

// The smallest box around several boxes, or null for none: what the frame
// button brings into view for a part whose nodes sit apart. Grown edge by
// edge rather than box by box, so a nested box never makes it bigger.
export function unionRect(rects) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const value of rects ?? []) {
    const box = asRect(value);
    if (!box) continue;
    left = Math.min(left, box[0]);
    top = Math.min(top, box[1]);
    right = Math.max(right, box[0] + box[2]);
    bottom = Math.max(bottom, box[1] + box[3]);
  }
  return right > left ? [left, top, right - left, bottom - top] : null;
}

// What the frame button asks the canvas to show. The canvas fits a box to
// `fill` of the view, which on a part of two small nodes would zoom in far
// past life size: such a box is grown around its own centre until it fills
// that much, so the part shows at a size the eye accepts. A part already big
// enough - or a box or view with no size - is handed back untouched and the
// canvas fits it whole.
export function frameBounds(rect, view, fill = 0.8) {
  const box = numbersOf(rect) ?? [0, 0, 0, 0];
  const [x, y, w, h] = box;
  const wantW = Number(view?.[0]) * fill;
  const wantH = Number(view?.[1]) * fill;
  if (!(w > 0) || !(h > 0) || !(wantW > 0) || !(wantH > 0) || w >= wantW || h >= wantH) return box;
  const grow = Math.min(wantW / w, wantH / h);
  const grownW = w * grow;
  const grownH = h * grow;
  return [x - (grownW - w) / 2, y - (grownH - h) / 2, grownW, grownH];
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
//
// A switch with an off side (`offSide`, the nodes that run only while the
// row is off) adds one unit per node, counted the other way round: such a
// node that is stopped counts as on, one that runs counts as off. So a row
// reads on when its own nodes run and nothing of its other side does, off
// when that is reversed, and mixed when only part of either holds.
export function partState(members, counts = () => true, pairs = [], offSide = []) {
  // Three kinds of unit, each answering "is this one on" its own way: a node
  // of the row (on when it runs), a node of the other side (on when it is
  // stopped, since it only runs while the row is off), and one saved setting
  // (on when its control holds the value saved for on).
  const own = members.filter(counts);
  const other = offSide.filter(counts);
  // A row of nothing but nodes that never run still says something, so it is
  // read from all of them instead of being called empty.
  const screened = own.length > 0 || other.length > 0 || pairs.length > 0;
  const ownUnits = screened ? own : members;
  const otherUnits = screened ? other : offSide;
  const total = ownUnits.length + otherUnits.length + pairs.length;
  if (!total) return { state: "empty", on: 0, total: 0 };
  const ownOn = ownUnits.filter((node) => isRunning(node.mode)).length;
  const otherOn = otherUnits.filter((node) => !isRunning(node.mode)).length;
  const pairsOn = pairs.filter((pair) => pair.now === "on").length;
  const pairsOff = pairs.filter((pair) => pair.now === "off").length;
  const on = ownOn + otherOn + pairsOn;
  // The same three kinds counted the other way: everything that has to hold
  // for the row to read off.
  const off = ownUnits.length - ownOn + (otherUnits.length - otherOn) + pairsOff;
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

// One control that held one value when "on" was saved and another when "off"
// was saved. A plain control is just the two values. A LoRA stack is compared
// row by row, by file name, so the switch moves only the rows that differ and
// leaves whatever else was changed in the stack since.
function pairsOfControl(id, widget, onValue, offValue) {
  if (offValue === onValue) return [];
  const onRows = stackRows(onValue);
  const offRows = stackRows(offValue);
  if (!onRows || !offRows) return [{ node: id, widget, on: onValue, off: offValue }];
  const pairs = [];
  for (const row of onRows) {
    const other = findRow(offRows, row.name);
    const sides = other && rowSides(row, other);
    if (sides) pairs.push({ node: id, widget, row: row.name, on: sides[0], off: sides[1] });
  }
  return pairs;
}

// The settings a switch changes: every control that held one value when "on"
// was saved and another when "off" was saved, a stack row at a time. Only
// controls and rows stated on both sides can be compared at all, so a side
// saved on its own yields nothing until the other one is saved too.
// Returns { node, widget, on, off } and, for a stack row, { ..., row }.
export function valuePairs(entry) {
  const pairs = [];
  for (const [id, on] of Object.entries(entry?.on ?? {})) {
    const off = entry?.off?.[id];
    if (!off) continue;
    for (const [widget, onValue] of Object.entries(on)) {
      if (!(widget in off)) continue;
      pairs.push(...pairsOfControl(id, widget, onValue, off[widget]));
    }
  }
  return pairs;
}

// Where a setting stands now: at its on value, its off value, or neither. A
// value set by hand to something else is "other" - the row then reads mixed
// and says so, rather than pretending to be on or off.
export function pairNow(pair, current) {
  if (pair.row === undefined) {
    if (current === pair.on) return "on";
    return current === pair.off ? "off" : "other";
  }
  const rows = stackRows(current);
  const row = rows && findRow(rows, pair.row);
  if (!row) return "other";
  if (rowAt(row, pair.on)) return "on";
  return rowAt(row, pair.off) ? "off" : "other";
}

// The value a control should hold for one side of a switch. For a stack row it
// is the stack as it is now with that one row changed, and only in what the
// switch sets on it: the row's other strengths and its triggers stay. A stack
// that cannot be read is handed back as it is rather than rewritten, which
// would lose whatever it held.
export function pairValue(pair, side, current) {
  const want = side === "on" ? pair.on : pair.off;
  if (pair.row === undefined) return want;
  const rows = stackRows(current);
  if (!rows) return current;
  const target = findRow(rows, pair.row);
  return JSON.stringify(rows.map((row) => (row === target ? { ...row, ...want } : row)));
}

// A switch's settings as they stand on the graph: each pair with its node, its
// control and where it is now. A pair whose node or control is gone is left
// out rather than reported as "changed": there is nothing left to set, so the
// row must count only what is actually there.
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
//
// A switch with an off side gets `offMembers` the same way, and its frame
// takes in both sides. Nodes are taken in a fixed order - the on side first,
// so a node listed on both ends up there - and a node is never on two sides
// at once.
export function readSwitches(switches, placed, groupRows, { counts = () => true } = {}) {
  const nodeById = new Map(placed.map((entry) => [String(entry.node.id), entry]));
  const groupById = new Map();
  for (const row of groupRows ?? []) {
    const id = row.group?.id;
    if (id !== undefined && id !== null && !groupById.has(String(id))) groupById.set(String(id), row);
  }
  return (switches ?? []).map((entry) => {
    // What this row has found so far: the nodes it took (each once, however
    // it was named - by itself or through a group), the boxes it covers, and
    // how many ids led nowhere. A miss is counted and left alone, never
    // removed here: a graph still loading has not got all its nodes yet.
    const taken = new Set();
    const boxes = [];
    let gone = 0;
    const find = (byId, id) => {
      const hit = byId.get(String(id));
      if (!hit) gone += 1;
      return hit ?? null;
    };
    const take = (node, rect) => {
      if (taken.has(node)) return false;
      taken.add(node);
      if (rect) boxes.push(rect);
      return true;
    };
    const takeNodes = (ids, into) => {
      for (const id of ids ?? []) {
        const hit = find(nodeById, id);
        if (hit && take(hit.node, hit.rect)) into.push(hit.node);
      }
    };
    const takeGroups = (ids, into) => {
      for (const id of ids ?? []) {
        const row = find(groupById, id);
        if (!row) continue;
        // The group's own box stands for everything inside it.
        boxes.push(row.rect);
        for (const node of row.members) if (take(node)) into.push(node);
      }
    };
    const members = [];
    const offMembers = [];
    takeNodes(entry.nodes, members);
    takeNodes(entry.nodes_off, offMembers);
    takeGroups(entry.groups, members);
    takeGroups(entry.groups_off, offMembers);
    // The nodes whose settings it changes: framed and selected with the rest,
    // but never turned off by it, so they belong to neither side.
    const valueNodes = [];
    const sides = new Set([...Object.keys(entry.on ?? {}), ...Object.keys(entry.off ?? {})]);
    for (const id of sides) {
      const hit = find(nodeById, id);
      if (!hit) continue;
      valueNodes.push(hit.node);
      boxes.push(hit.rect);
    }
    const pairs = readPairs(entry, nodeById);
    return {
      kind: "switch",
      entry,
      rect: unionRect(boxes),
      title: entry.title,
      color: null,
      members,
      offMembers,
      valueNodes,
      pairs,
      // Saved for one side only so far: nothing to switch between yet.
      half: [...sides].some((id) => !(entry.on?.[id] && entry.off?.[id])),
      gone,
      ...partState(members, counts, pairs, offMembers),
    };
  });
}

// ---------- which groups, in which order ----------

// The filter box's text as the terms it is made of: comma separated, case
// folded, blanks dropped. No terms at all means no filter rather than no
// rows - an empty box lists everything, which is what it looks like it does.
export function matchTerms(text) {
  return String(text ?? "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

// A group row taken off the card with its delete button, as the settings
// keep it: the group's own id when it has one, its title otherwise. Shared
// with the settings normaliser, so a record written by one and read by the
// other can never disagree about which group it means.
function hiddenRecord(raw) {
  const record = raw && typeof raw === "object" ? raw : { title: raw };
  return {
    id: record.id === undefined || record.id === null ? "" : String(record.id),
    title: cleanTitle(record.title),
  };
}

// Whether this group's row was taken off the card by hand. It stays away
// until Restore in the settings puts every one of them back; nothing on the
// canvas is touched either way. A record that names an id only matches that
// id, and one that names no id only matches a group that has none either -
// so a record for one group can never take away another group's row.
function hiddenAway(settings, id, title) {
  const key = id === undefined || id === null || id === "" ? "" : String(id);
  const lower = title.toLowerCase();
  return (settings?.hidden ?? []).some((raw) => {
    const record = hiddenRecord(raw);
    return record.id ? record.id === key : !key && record.title.toLowerCase() === lower;
  });
}

// Which groups get a row of their own under the made switches. "none" lists
// no group at all, so only the switches that were made show; "numbered"
// keeps the titles starting with a digit - the stages of a workflow laid out
// as 1 · Load, 2 · Create, ... ; "matching" keeps the titles containing any
// of the filter's terms. Anything else, including a file saved before this
// setting existed, lists every group.
export function groupListed(title, settings, id) {
  const text = String(title ?? "").trim();
  const mode = settings?.groups ?? "all";
  if (mode === "none") return false;
  if (hiddenAway(settings, id, text)) return false;
  if (mode === "numbered") return /^\d/.test(text);
  if (mode !== "matching") return true;
  const terms = matchTerms(settings?.match);
  return !terms.length || terms.some((term) => text.toLowerCase().includes(term));
}

// Canvas order is the way a left-to-right workflow reads: column by column,
// and top to bottom inside a column. A column is a run of boxes whose left
// edges still sit left of the leftmost centre line the column has seen: that
// keeps a stage stacked under another with it (1, 2 | 3, 4 | 5 ...), where a
// plain row-by-row order would jump across the canvas and back.
export function canvasOrder(items, rectOf = (item) => item.rect) {
  const byLeft = [...items].sort((a, b) => rectOf(a)[0] - rectOf(b)[0] || rectOf(a)[1] - rectOf(b)[1]);
  const columns = [];
  let current = null;
  // The column's spine: the leftmost centre line in it so far. A box that
  // starts right of the spine opens a new column.
  let spine = Infinity;
  for (const item of byLeft) {
    const [left, , width] = rectOf(item);
    if (!current || left >= spine) {
      current = [];
      columns.push(current);
      spine = Infinity;
    }
    current.push(item);
    spine = Math.min(spine, left + width * 0.5);
  }
  const downThenAcross = (a, b) => rectOf(a)[1] - rectOf(b)[1] || rectOf(a)[0] - rectOf(b)[0];
  return columns.flatMap((column) => column.sort(downThenAcross));
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
  // Only the groups are sorted. The made switches keep the order they were
  // made in, or the one they were moved to - that order is the user's own.
  const byOrder = settings?.order === "title" ? titleOrder : canvasOrder;
  return [...(switchRows ?? []), ...byOrder(listed)];
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

// What putting a set of rows in one state does to their nodes. A row's own
// nodes run while it is on and stop while it is off; the nodes on its other
// side do the exact opposite, which is what hands a run from one path to
// another.
function stateModes(rows, on, off) {
  const modes = new Map();
  const running = (row) => (on ? row.members : row.offMembers) ?? [];
  const stopping = (row) => (on ? row.offMembers : row.members) ?? [];
  // Stopping is written first and running second, so a node one row stops and
  // another runs ends up running: two rows that share a node never leave it
  // dark because of the order they were listed in.
  for (const row of rows) for (const node of stopping(row)) modes.set(node, off);
  for (const row of rows) for (const node of running(row)) modes.set(node, MODE_ALWAYS);
  return modes;
}

function merge(into, from) {
  for (const [node, mode] of from) into.set(node, mode);
}

// Only the nodes whose mode actually changes: writing a mode it already has
// would put another step in the undo history for nothing.
function modesChanged(modes) {
  return [...modes].filter(([node, mode]) => node.mode !== mode);
}

// The mode changes one click makes: the row's own nodes turn on (always) or
// off (bypass or mute), exactly what the frontend's own "Bypass Group Nodes" /
// "Set Group Nodes to Always" do, and the nodes on its other side do the
// opposite. One at a time first turns every other listed row off - which
// starts their other side - and then turns this one on, so a node two rows
// share ends up on. Returns [node, mode] pairs for the nodes that change.
export function switchPlan(rows, target, on, settings) {
  const off = offMode(settings);
  const modes = new Map();
  if (on && settings?.exclusive) merge(modes, stateModes(rows.filter((row) => row !== target), false, off));
  merge(modes, stateModes(target ? [target] : [], on, off));
  return modesChanged(modes);
}

// Every listed row on or off at once (the node's right-click menu): each row
// goes to its own on or off, its other side included.
export function switchAllPlan(rows, on, settings) {
  return modesChanged(stateModes(rows, on, offMode(settings)));
}

// A setting is known by what it is on: one control of one node, or one row of
// one stack. Two rows can name the same setting, and the later write wins.
const pairKey = (pair) => `${pair.node}|${pair.widget}|${pair.row ?? ""}`;

// Only the settings that would actually change, for the same reason the modes
// are filtered: a value written where it already is only adds to the undo
// history.
function sidesChanged(sides) {
  return [...sides.values()].filter(([pair, side]) => pair.now !== side);
}

// The settings one click changes, as [pair, side]: every setting of the row
// goes to its on or its off value, and one at a time first sends the other
// rows' settings to off.
export function valuePlan(rows, target, on, settings) {
  const sides = new Map();
  if (on && settings?.exclusive) {
    for (const row of rows) {
      if (row === target) continue;
      for (const pair of row.pairs ?? []) sides.set(pairKey(pair), [pair, "off"]);
    }
  }
  for (const pair of target?.pairs ?? []) sides.set(pairKey(pair), [pair, on ? "on" : "off"]);
  return sidesChanged(sides);
}

// Every listed row's settings at once (the node's right-click menu).
export function valueAllPlan(rows, on) {
  const sides = new Map();
  for (const row of rows) for (const pair of row.pairs ?? []) sides.set(pairKey(pair), [pair, on ? "on" : "off"]);
  return sidesChanged(sides);
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

// What a choice is called: the row's own title, or a plain word for a row
// nobody named.
export function rowLabel(row) {
  if (row?.title) return row.title;
  return row?.kind === "switch" ? "Switch" : "Group";
}

// A guess at a name's width where it cannot be measured - under node:test, or
// on a card that has not been drawn yet: about 6.5 px a character, the middle
// of the two card fonts.
const guessWidth = (text) => [...String(text ?? "")].length * 6.5;

// How wide a node must be for its pill to show every name in full. All the
// segments are the same width, so the longest name decides for every one of
// them; the frame and each segment's own padding are added on top, and the
// result is rounded up so no name is cut by half a pixel.
export function pillNodeWidth(labels, measure = guessWidth) {
  const names = labels ?? [];
  let longest = 0;
  for (const label of names) longest = Math.max(longest, Number(measure(label)) || 0);
  return Math.ceil(PILL_FRAME + names.length * (longest + PILL_SEGMENT_PAD));
}

// How a card shows its rows:
//   rows - one row each, the look every card had before, and the default;
//   pill - one segmented pill, every row a choice;
//   list - one list to pick from.
// The last two need One at a time on, Show as set to one pill, and at least
// two rows: one row alone has nothing to be picked against. A pill also needs
// its names to fit within PILL_NODE_WIDTH_MAX - past that the names would be
// cut short, and a list reads better than four shortened names.
// `width` is the node width the pill needs, which the card keeps as its floor;
// it is 0 for the other two views, which the rows themselves size.
export function cardView(settings, rows, measure = guessWidth) {
  const names = (rows ?? []).map(rowLabel);
  if (!settings?.exclusive || settings.show !== "pill" || names.length < 2) return { view: "rows", width: 0 };
  if (names.length > PILL_CHOICES_MAX) return { view: "list", width: 0 };
  const width = pillNodeWidth(names, measure);
  return width <= PILL_NODE_WIDTH_MAX ? { view: "pill", width } : { view: "list", width: 0 };
}

// Where a pick-one card stands. A row counts as "on" when all of it runs and
// "mixed" when only part of it does; a row with nothing in it counts as
// neither, so an empty row never makes the card look decided. The card is
// settled ("one") only when exactly one row is on and no other row is partly
// on - anything else is told as it is, since a graph edited by hand, or saved
// before the card was a pill, can be in any of them.
export function choiceState(rows) {
  const list = rows ?? [];
  const on = list.filter((row) => row.state === "on");
  const mixed = list.filter((row) => row.state === "mixed");
  // How many rows are spoken for at all: on or partly on.
  const live = on.length + mixed.length;
  if (!live) return { kind: "none", picked: null, count: 0 };
  if (on.length === 1 && !mixed.length) return { kind: "one", picked: on[0], count: 1 };
  if (!on.length && mixed.length === 1) return { kind: "partly", picked: null, count: 1 };
  return { kind: "several", picked: null, count: live };
}

// What a click on a choice changes: that row goes on and every other row off,
// as one at a time does - which is why the settings are forced exclusive here,
// whatever the card's own setting says: a choice with two picked is not a
// choice. `modes` and `values` are switchPlan's and valuePlan's answers; both
// are empty for the row that is already the only one on, so clicking it again
// does nothing and one stays picked. A row with nothing in it cannot be picked
// at all: it would only switch the others off.
export function choosePlan(rows, target, settings) {
  if (!target || target.state === "empty") return { modes: [], values: [] };
  const one = { ...settings, exclusive: true };
  return { modes: switchPlan(rows, target, true, one), values: valuePlan(rows, target, true, one) };
}

// ---------- making and changing switches ----------

// The switches a change produced, cleaned the same way a saved file is: an
// edit that empties one side leaves no empty list behind, and a node that an
// edit put on both sides is settled here rather than at the next reload.
function withSwitches(settings, switches) {
  return { ...normalizeSettings(settings), switches: normalizeSwitches(switches) };
}

function pickedIds(picked) {
  return { nodes: cleanIds(picked?.nodes), groups: cleanIds(picked?.groups) };
}

// A name for a new switch, from what was picked: the one box (a subgraph) in
// the selection, else the one group, else the first node picked, else the
// first group. `picked` carries titles here, not ids: { nodes: [{ title, box }],
// groups: [{ title }] }.
// A name already on the card gets a number, so two rows never read the same.
// The room for that number is taken out of the name first, so the result still
// fits TITLE_MAX and cleanTitle never cuts the number off.
export function suggestTitle(picked, taken = []) {
  const nodes = picked?.nodes ?? [];
  const groups = picked?.groups ?? [];
  const boxes = nodes.filter((node) => node?.box);
  let chosen = null;
  if (boxes.length === 1) chosen = boxes[0];
  else if (groups.length === 1) chosen = groups[0];
  else if (nodes.length) chosen = nodes[0];
  else if (groups.length) chosen = groups[0];
  const base = cleanTitle(chosen?.title) || "Switch";
  const used = new Set(taken.map((title) => cleanTitle(title).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  const stem = base.slice(0, TITLE_MAX - 4);
  for (let number = 2; number < 1000; number += 1) {
    const next = cleanTitle(`${stem} ${number}`);
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
// it back. The group's nodes are never touched, and removing it twice records
// it once.
export function hideGroup(settings, { id, title } = {}) {
  const current = normalizeSettings(settings);
  const record = hiddenRecord({ id, title });
  if (!record.id && !record.title) return current;
  const already = current.hidden.some((raw) => {
    const other = hiddenRecord(raw);
    return record.id
      ? other.id === record.id
      : !other.id && other.title.toLowerCase() === record.title.toLowerCase();
  });
  if (already) return current;
  return { ...current, hidden: [...current.hidden, record].slice(-HIDDEN_MAX) };
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

// One side's members, and the way to write them back. The two sides live
// under different keys - `nodes` / `groups` and `nodes_off` / `groups_off` -
// which is the only thing that differs between them; every edit below says
// which side it means and never touches the field names itself.
function sideOf(entry, side) {
  return side === "off"
    ? { nodes: entry.nodes_off ?? [], groups: entry.groups_off ?? [] }
    : { nodes: entry.nodes, groups: entry.groups };
}

function withSide(side, members) {
  return side === "off"
    ? { nodes_off: members.nodes, groups_off: members.groups }
    : { nodes: members.nodes, groups: members.groups };
}

function otherSide(side) {
  return side === "off" ? "on" : "off";
}

// The picked nodes and groups as text, the shape every edit compares in: a
// node is the same node whether the file kept its id as a number or as text.
function pickedKeys(picked) {
  const ids = pickedIds(picked);
  return { nodes: ids.nodes.map(String), groups: ids.groups.map(String) };
}

// A list without the given ids.
function withoutIds(list, drop) {
  return (list ?? []).filter((member) => !drop.has(String(member)));
}

function withoutKeys(sides, drop) {
  return Object.fromEntries(Object.entries(sides ?? {}).filter(([id]) => !drop.has(id)));
}

function countIn(keys, nodes, groups) {
  return keys.nodes.filter((id) => nodes.has(id)).length + keys.groups.filter((id) => groups.has(id)).length;
}

function countOutside(keys, nodes, groups) {
  return keys.nodes.filter((id) => !nodes.has(id)).length + keys.groups.filter((id) => !groups.has(id)).length;
}

// The picked members join one side and leave the other. One side only: a node
// that stayed on both would be asked to run and stop by the same click. A node
// whose settings the switch changes is set, not switched, so it joins neither.
function joinSide(entry, picked, side) {
  const extra = pickedIds(picked);
  const mine = sideOf(entry, side);
  const theirs = sideOf(entry, otherSide(side));
  const set = new Set([...Object.keys(entry.on ?? {}), ...Object.keys(entry.off ?? {})]);
  const nodes = cleanIds([...mine.nodes, ...extra.nodes]).filter((member) => !set.has(String(member)));
  const groups = cleanIds([...mine.groups, ...extra.groups]);
  const nodeKeys = new Set(nodes.map(String));
  const groupKeys = new Set(groups.map(String));
  return {
    ...withSide(side, { nodes, groups }),
    ...withSide(otherSide(side), {
      nodes: withoutIds(theirs.nodes, nodeKeys),
      groups: withoutIds(theirs.groups, groupKeys),
    }),
  };
}

// A picked node or group joins the side that runs while the row is on.
export function addMembers(settings, id, picked) {
  return changeSwitch(settings, id, (entry) => joinSide(entry, picked, "on"));
}

// The picked nodes and groups join the other side, the one that runs only
// while the row is off. One that was on this side moves over.
export function addOffMembers(settings, id, picked) {
  return changeSwitch(settings, id, (entry) => joinSide(entry, picked, "off"));
}

// The picked nodes and groups leave the other side. They end up on neither:
// this does not move them over to the side that runs while the row is on,
// which is what addMembers does.
export function removeOffMembers(settings, id, picked) {
  const drop = pickedKeys(picked);
  const nodes = new Set(drop.nodes);
  const groups = new Set(drop.groups);
  return changeSwitch(settings, id, (entry) => ({
    nodes_off: withoutIds(entry.nodes_off, nodes),
    groups_off: withoutIds(entry.groups_off, groups),
  }));
}

// Taking a node out takes it off both sides and forgets the values the switch
// saved for it: afterwards the switch does nothing to it at all.
export function removeMembers(settings, id, picked) {
  const drop = pickedKeys(picked);
  const nodes = new Set(drop.nodes);
  const groups = new Set(drop.groups);
  return changeSwitch(settings, id, (entry) => ({
    nodes: withoutIds(entry.nodes, nodes),
    groups: withoutIds(entry.groups, groups),
    nodes_off: withoutIds(entry.nodes_off, nodes),
    groups_off: withoutIds(entry.groups_off, groups),
    on: withoutKeys(entry.on, nodes),
    off: withoutKeys(entry.off, nodes),
  }));
}

// How many of the picked nodes and groups a switch already holds on the side
// that runs while its row is on, to turn off or to change the settings of. A
// node whose values it changes counts too: it is already spoken for. The other
// side is counted by offHeldCount.
export function heldCount(entry, picked) {
  const keys = pickedKeys(picked);
  const nodes = new Set([
    ...(entry?.nodes ?? []).map(String),
    ...Object.keys(entry?.on ?? {}),
    ...Object.keys(entry?.off ?? {}),
  ]);
  return countIn(keys, nodes, new Set((entry?.groups ?? []).map(String)));
}

// How many of the picked nodes and groups the switch already holds on its
// other side.
export function offHeldCount(entry, picked) {
  return countIn(
    pickedKeys(picked),
    new Set((entry?.nodes_off ?? []).map(String)),
    new Set((entry?.groups_off ?? []).map(String)),
  );
}

// How many of the picked nodes and groups could still join the other side:
// not there already, and not a node whose settings the switch changes. The
// side's own members do not count as taken - they would only move over.
export function offFreshCount(entry, picked) {
  const takenNodes = new Set([
    ...(entry?.nodes_off ?? []).map(String),
    ...Object.keys(entry?.on ?? {}),
    ...Object.keys(entry?.off ?? {}),
  ]);
  return countOutside(pickedKeys(picked), takenNodes, new Set((entry?.groups_off ?? []).map(String)));
}

// Save what the picked nodes hold right now as one side of a switch ("on" or
// "off"). `snapshots` is [{ id, values }], values from snapshotNode. From then
// on the switch sets those nodes' settings instead of switching them, so they
// leave both sides - the click that follows must not do both.
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
    nodes: withoutIds(entry.nodes, ids),
    nodes_off: withoutIds(entry.nodes_off, ids),
    // Cleaned the way a saved file is, so a value the file cannot hold is
    // dropped now rather than at the next reload.
    [side]: cleanSnapshots({ ...entry[side], ...saved }),
  }));
}

// ---------- after a paste ----------

// A pasted card's switches, pointed at the copies of their parts instead of
// the originals. `nodes` and `groups` map an old id (as text) to its copy's
// id, from web/shared/paste_remap.mjs.
//
// An id the paste did not carry along is kept as it is: a card pasted on its
// own still switches the parts it switched before, which is what someone
// duplicating just the card is after. Everything a switch knows by id is
// followed - both sides, the nodes whose settings it changes, and the group
// rows taken off the card with their delete button, which an older version
// left pointing at the original group and so came back on the copy.
//
// Returns null when no id actually changed, so the caller can leave the node
// alone - a map that carries an id onto itself is not a change.
export function repointSwitches(raw, nodes, groups) {
  const settings = normalizeSettings(raw);
  let changed = false;
  // Follow one id through a paste's map. An id the paste did not carry along
  // keeps pointing where it did: a card pasted on its own still switches the
  // parts it switched before, which is what someone duplicating just the card
  // is after.
  const follow = (map, id) => {
    const copy = map?.get(String(id));
    if (copy === undefined || copy === null) return id;
    if (String(copy) === String(id)) return id;
    changed = true;
    return copy;
  };
  const followAll = (map, list) => (Array.isArray(list) ? list.map((id) => follow(map, id)) : list);
  // A side is keyed by the id of the node whose settings it remembers.
  const followSides = (values) => (values && typeof values === "object"
    ? Object.fromEntries(Object.entries(values).map(([id, held]) => [String(follow(nodes, id)), held]))
    : values);
  const switches = settings.switches.map((entry) => ({
    ...entry,
    nodes: followAll(nodes, entry.nodes),
    groups: followAll(groups, entry.groups),
    ...(entry.nodes_off ? { nodes_off: followAll(nodes, entry.nodes_off) } : {}),
    ...(entry.groups_off ? { groups_off: followAll(groups, entry.groups_off) } : {}),
    on: followSides(entry.on),
    off: followSides(entry.off),
  }));
  // A group row taken off the card is remembered by the group's id. Without
  // this, a copy came back showing a row the original had removed.
  const hidden = settings.hidden.map((item) => {
    if (item.id === "") return item;
    const copy = follow(groups, item.id);
    return String(copy) === item.id ? item : { ...item, id: String(copy) };
  });
  return changed ? normalizeSettings({ ...settings, switches, hidden }) : null;
}

// ---------- change detection ----------

// Everything the card draws, as one string: when it matches the last one,
// the redraw that asked has nothing to update.
export function rowsSignature(rows, settings, keyOf = (row) => row.title) {
  return JSON.stringify([
    settings,
    rows.map((row) => [
      row.kind, keyOf(row), row.title, row.color, row.state, row.on, row.total, row.members?.length ?? 0, row.gone ?? 0,
      row.pairs?.length ?? 0, row.half ?? false, row.offMembers?.length ?? 0,
    ]),
  ]);
}

// Whether two stack row names are the same LoRA: the same name, or the same
// file in another folder (see fileKey).
function sameFile(a, b) {
  return a === b || (Boolean(a) && Boolean(b) && fileKey(a) === fileKey(b));
}

// Whether a pair moves this row of this control on this node: the same node,
// the same control, and a stack row naming the same file (see sameFile). A
// pair with no row is a whole-control switch and never claims a stack row.
function pairMovesRow(pair, nodeId, widget, rowName) {
  return pair.row !== undefined
    && String(pair.node) === String(nodeId)
    && pair.widget === widget
    && sameFile(pair.row, rowName);
}

// The made switches that move one row of a LoRA stack: every switch, on any of
// the given Workflow Switches nodes, whose settings change that row of that
// control on that node. `boards` is [{ node, settings }], one per Workflow
// Switches node; the answer is [{ node, id, title }], in the order the boards
// and their switches are listed.
export function stackRowOwners(boards, nodeId, widget, rowName) {
  const owners = [];
  if (!rowName) return owners;
  for (const { node, settings } of boards ?? []) {
    for (const entry of normalizeSettings(settings).switches) {
      if (valuePairs(entry).some((pair) => pairMovesRow(pair, nodeId, widget, rowName))) {
        owners.push({ node, id: entry.id, title: entry.title });
      }
    }
  }
  return owners;
}

// Take one row of a LoRA stack away from a switch: both of its saved sides
// forget that row, so the switch leaves it alone and no longer reads "changed"
// because of it. Everything else the side holds - the other rows, the other
// controls of the same node - stays exactly as it was.
export function releaseStackRow(settings, id, nodeId, widget, rowName) {
  const forget = (side) => {
    const values = side?.[String(nodeId)];
    const rows = stackRows(values?.[widget]);
    const row = rows && findRow(rows, rowName);
    if (!row) return side;
    const kept = rows.filter((other) => other !== row);
    return { ...side, [String(nodeId)]: { ...values, [widget]: JSON.stringify(kept) } };
  };
  return changeSwitch(settings, id, (entry) => ({ on: forget(entry.on), off: forget(entry.off) }));
}

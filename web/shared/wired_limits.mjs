// The limits of what a number box is wired to.
//
// ComfyUI's own Primitive node takes over the range of the input it feeds:
// wire it to a sampler's denoise and it stops at 1. Float and Integer do the
// same through this module. wiredLimits(node) follows the node's output to
// every input it reaches, through Reroutes and into boxes (subgraphs), and
// returns the range all of them allow, or null when none has one.
//
// It only reads `graph`, `links`, `inputs`, `widgets` and `subgraph`, so
// tests/wired_limits.test.mjs runs it on plain objects.

// A wire that loops back on itself (a box inside its own box cannot happen,
// but a hand-made graph of Reroutes can) stops here.
const MAX_HOPS = 16;

function linkOf(graph, id) {
  if (id === null || id === undefined || !graph) return null;
  return graph.getLink?.(id) ?? graph.links?.get?.(id) ?? graph.links?.[id] ?? null;
}

// The range a number widget has, from the options ComfyUI gives it. The
// classic `step` is ten times the real one; `step2` is the real one.
export function widgetRange(widget) {
  const options = widget?.options ?? {};
  const min = Number(options.min ?? NaN);
  const max = Number(options.max ?? NaN);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  const step = Number(options.step2 ?? (options.step ? options.step / 10 : NaN));
  return {
    min: Number.isFinite(min) ? min : -Infinity,
    max: Number.isFinite(max) ? max : Infinity,
    step: Number.isFinite(step) && step > 0 ? step : null,
  };
}

function isNumberWidget(widget) {
  return Boolean(widget) && (widget.type === "number" || widget.type === "slider" || typeof widget.value === "number");
}

// Follow one wire to the input it lands on and collect that input's range.
function follow(graph, linkId, hops, found) {
  const link = linkOf(graph, linkId);
  if (!link || hops > MAX_HOPS) return;
  const node = graph.getNodeById?.(link.target_id) ?? null;
  if (!node) return;
  // A Reroute hands the wire on.
  if (node.type === "Reroute") {
    for (const id of node.outputs?.[0]?.links ?? []) follow(graph, id, hops + 1, found);
    return;
  }
  const slot = node.inputs?.[link.target_slot];
  const name = slot?.widget?.name;
  const widget = name ? node.widgets?.find((entry) => entry.name === name) : null;
  const range = isNumberWidget(widget) ? widgetRange(widget) : null;
  if (range) {
    found.push({ ...range, name: slot.label ?? slot.localized_name ?? name, value: Number(widget.value) });
    return;
  }
  // A box: go on inside it, from the box input this wire lands on.
  const inner = node.subgraph;
  const ids = inner?.inputNode?.slots?.[link.target_slot]?.linkIds ?? inner?.inputs?.[link.target_slot]?.linkIds ?? [];
  for (const id of ids) follow(inner, id, hops + 1, found);
}

// { min, max, step, names, values } for everything `node`'s output is wired
// to, or null: nothing wired, nothing with a range, or ranges that share no
// value. `step` is set only when every input agrees on it. `values` are what
// those inputs hold now, in the order the wires were made.
export function wiredLimits(node, output = 0) {
  const found = [];
  for (const id of node?.outputs?.[output]?.links ?? []) follow(node.graph, id, 0, found);
  if (!found.length) return null;
  const min = Math.max(...found.map((range) => range.min));
  const max = Math.min(...found.map((range) => range.max));
  if (!(min <= max) || (!Number.isFinite(min) && !Number.isFinite(max))) return null;
  const steps = [...new Set(found.map((range) => range.step).filter(Boolean))];
  return {
    min, max,
    step: steps.length === 1 ? steps[0] : null,
    names: [...new Set(found.map((range) => range.name))],
    values: found.map((range) => range.value).filter(Number.isFinite),
  };
}

// ComfyUI's Primitive node takes the value of the input it is first wired to,
// so wiring it up does not change that setting. A number box does the same,
// but only a box that is new and still holds what it started with: a box that
// came with a saved workflow or a paste, or that someone has set, keeps its
// value. Returns the value to take, or null.
export function valueToTake({ fresh, value, initial, wires, wired }) {
  if (!fresh || wires !== 1 || value !== initial) return null;
  const take = wired?.values?.[0];
  return Number.isFinite(take) && take !== value ? take : null;
}

// A number box's own range narrowed to what it is wired to.
export function narrowedRange(own, wired) {
  const ownMin = Number.isFinite(Number(own?.min)) ? Number(own.min) : -Infinity;
  const ownMax = Number.isFinite(Number(own?.max)) ? Number(own.max) : Infinity;
  if (!wired) return { min: ownMin, max: ownMax };
  const min = Math.max(ownMin, wired.min);
  const max = Math.min(ownMax, wired.max);
  return min <= max ? { min, max } : { min: ownMin, max: ownMax };
}

function plain(number) {
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

// "0–1", "from 1", "up to 8": the short form shown beside the value. Empty
// for a range too wide to mean anything to a person (a seed's 0 to 2^64).
export function limitsLabel(limits) {
  if (!limits) return "";
  const low = Number.isFinite(limits.min) && Math.abs(limits.min) < 1e9;
  const high = Number.isFinite(limits.max) && Math.abs(limits.max) < 1e9;
  if (low && high) return `${plain(limits.min)}–${plain(limits.max)}`;
  if (low) return `from ${plain(limits.min)}`;
  if (high) return `up to ${plain(limits.max)}`;
  return "";
}

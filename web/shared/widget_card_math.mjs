// Pure decisions behind js/shared/widget_card.mjs: which rows a card shows,
// how tall it is, and how a number scrubs. No DOM, no app import, so
// tests/widget_card.test.mjs runs it under node:test.
export const ROW_HEIGHT = 26;
export const ROW_GAP = 5;
export const SECTION_HEIGHT = 17;
export const GROUP_HEIGHT = 22;
export const CARD_PADDING = 7;
// Every scrub field in a card reserves this much for its unit ("px", "MP",
// "×") whether it has one or not, so the numbers share one centre line.
export const UNIT_SLOT_WIDTH = 22;
// A widget input socket is drawn at the widget's y plus half a slot.
export const SLOT_OFFSET = 10;
// A segmented pill only reads when every label fits its slot.
const SEGMENT_MAX_OPTIONS = 4;
const SEGMENT_MAX_CHARS = 26;

// Which rows the current values leave visible. `groups` maps a group name to
// its open state; a row inside a closed group is out, a row whose `when`
// says no is out, a group header stays as long as any row under it exists.
export function visibleRows(rows, values, groups = {}) {
  return rows.filter((row) => {
    if (row.group !== undefined && row.widget === undefined && row.pair === undefined && row.section === undefined) {
      return true; // the disclosure header itself
    }
    if (row.when && row.when(values) === false) return false;
    if (row.inGroup && !groups[row.inGroup]) return false;
    return true;
  });
}

// Does the current value set mute this row? A muted row keeps its place,
// height and socket, but dims and stops taking input (a setting the current
// mode does not read).
export function rowMuted(row, values) {
  return typeof row?.mute === "function" && row.mute(values) === true;
}

// One row's height: a caption, a group header, a control row, or the
// height a textarea row asks for.
export function rowHeight(row) {
  if (row.section !== undefined) return SECTION_HEIGHT;
  if (row.widget === undefined && row.pair === undefined) return GROUP_HEIGHT;
  return Number(row.height) > 0 ? Number(row.height) : ROW_HEIGHT;
}

// Card height for a list of visible rows: rows, section captions and group
// headers each add their own height plus the gap between them.
export function cardHeight(rows) {
  if (!rows.length) return CARD_PADDING * 2;
  return CARD_PADDING * 2 + rows.reduce((sum, row) => sum + rowHeight(row), 0) + ROW_GAP * (rows.length - 1);
}

// Where each visible row starts, measured from the card's top edge.
export function rowTops(rows) {
  let y = CARD_PADDING;
  return rows.map((row) => {
    const top = y;
    y += rowHeight(row) + ROW_GAP;
    return top;
  });
}

// The y a hidden widget reports so its input socket sits level with the
// card row standing in for it: the socket is drawn SLOT_OFFSET below the
// widget's y, and it belongs on the row's centre line - or, for a tall
// textarea row, just under its top edge, where the frontend puts it too.
export function socketWidgetY(cardY, insetTop, rowTop, height) {
  return cardY + insetTop + rowTop + Math.min(height / 2, 13) - SLOT_OFFSET;
}

// A combo is a segmented pill when the labels are few and short enough to
// sit side by side; otherwise it is a select.
export function segmentFits(labels) {
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > SEGMENT_MAX_OPTIONS) return false;
  return labels.reduce((sum, label) => sum + String(label).length, 0) <= SEGMENT_MAX_CHARS;
}

// Scrub steps from a widget's options: the fine step is the widget's own
// increment; the coarse step covers ground - a 0..1 float moves by 0.05, a
// wide float by ten increments. A whole number moves by its own increment:
// steps, counts and frame numbers go 25, 24, 23. Only a wide pixel size
// (`pixels`) moves by 8.
export function scrubSteps(options = {}, isFloat = true, pixels = false) {
  const fine = Number(options.step2 ?? (options.step ? options.step / 10 : null) ?? (isFloat ? 0.01 : 1)) || (isFloat ? 0.01 : 1);
  const range = Number(options.max ?? Infinity) - Number(options.min ?? -Infinity);
  let step;
  if (!isFloat) step = pixels && Number.isFinite(range) && range > 2048 ? 8 : Math.max(1, fine);
  else if (Number.isFinite(range) && range <= 2) step = Math.max(fine, 0.05);
  else step = fine * 10;
  const decimals = isFloat ? Number(options.precision ?? Math.max(0, -Math.floor(Math.log10(fine)))) : 0;
  return { step, fineStep: fine, decimals };
}

// Row kind from the widget the row mirrors, unless the config names one.
export function rowKind(row, widget) {
  if (row.kind) return row.kind;
  const type = String(widget?.type ?? "");
  if (type === "number" || type === "slider") return "scrub";
  if (type === "combo") return segmentFits(comboLabels(row, widget)) ? "segment" : "select";
  if (type === "toggle") return "switch";
  if (type === "customtext") return "skip";
  if (/color/i.test(String(row.widget ?? "")) && /^#[0-9a-f]{3,8}$/i.test(String(widget?.value ?? ""))) return "color";
  return "text";
}

// Write a value the way LiteGraph's own widgets do: set it, run the widget's
// callback, then tell the node. The frontend re-scans a node for missing
// media, and clears the errors it flagged, from node.onWidgetChanged.
export function commitWidgetValue(node, widget, value, canvas) {
  const previous = widget.value;
  widget.value = value;
  widget.callback?.(value, canvas, node);
  node.onWidgetChanged?.(widget.name, value, previous, widget);
}

export function comboValues(widget) {
  let values = widget?.options?.values;
  if (typeof values === "function") values = values(widget);
  return Array.isArray(values) ? values : [];
}

// A value the widget cannot hold: a switch holds only true or false, a
// choice only one of its options, a number only a finite number. Other
// widgets are never judged (an empty text field is a real value).
export function holdsUnknownValue(widget) {
  if (widget?.type === "toggle") return widget.value !== true && widget.value !== false;
  if (widget?.type === "combo") return !comboValues(widget).includes(widget.value);
  if (widget?.type === "number" || widget?.type === "slider") return !Number.isFinite(widget.value);
  return false;
}

// Saved values come back by position, and a card used to save an empty value
// of its own, so an input appended after a release can receive the card's ""
// from an older save. Put `fallbacks[name]` back on each named
// widget holding a value it cannot hold; returns the names it reset.
export function resetUnknownValues(widgets, fallbacks = {}) {
  const reset = [];
  for (const [name, fallback] of Object.entries(fallbacks)) {
    const widget = widgets?.find((item) => item?.name === name);
    if (widget && holdsUnknownValue(widget)) {
      widget.value = fallback;
      reset.push(name);
    }
  }
  return reset;
}

function comboLabels(row, widget) {
  return comboValues(widget).map((value) => row.labels?.[value] ?? String(value));
}

// A widget's hover text. The frontend keeps a node's tooltips in its
// definition and not on the widget, so a card that mirrors a hidden widget
// looks there too. Without this no row of a card says anything on hover.
// A tooltip the widget carries itself still wins.
export function widgetTooltip(node, name, widget = null) {
  const own = widget?.options?.tooltip ?? widget?.tooltip;
  if (typeof own === "string" && own) return own;
  const inputs = node?.constructor?.nodeData?.input;
  const spec = inputs?.required?.[name] ?? inputs?.optional?.[name];
  const text = Array.isArray(spec) ? spec[1]?.tooltip : undefined;
  return typeof text === "string" ? text : "";
}

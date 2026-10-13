// Name-keyed widget serialization: pure mapping and migration logic.
//
// Workflows historically store widgets_values as a positional array, which
// breaks whenever a widget is added or reordered. These helpers build a
// {widgetName: value} object for onSerialize and plan the restore for
// onConfigure, migrating legacy arrays by widget order with per-widget
// validation. The queue/API path is untouched: graphToPrompt reads
// widget.value by name and never consults widgets_values.
//
// Restore timing: the frontend's base LGraphNode.configure() runs first and
// blindly assigns widgets_values[i] to every widget whose `serialize` is not
// false — with a dict that means every such widget briefly holds undefined.
// The plan produced here repairs that: each widget gets its stored value when
// it fits, or its captured creation default when it does not.

function jsonClone(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return null;
  }
}

// Widgets the frontend's base configure() assigns stored values to.
export function isRestorableWidget(widget) {
  return !!widget
    && typeof widget.name === "string"
    && widget.name.length > 0
    && widget.serialize !== false;
}

// Widgets worth persisting by name: restorable, not opted out through
// options, and not a button (buttons carry UI labels, not state).
export function isPersistedWidget(widget) {
  return isRestorableWidget(widget)
    && widget.options?.serialize !== false
    && widget.type !== "button";
}

// {name: value} snapshot for onSerialize. Object values are JSON-cloned so
// undo snapshots never alias live widget state.
export function widgetsToDict(widgets) {
  const out = {};
  for (const widget of widgets ?? []) {
    if (!isPersistedWidget(widget)) continue;
    out[widget.name] = jsonClone(widget.value);
  }
  return out;
}

// Creation-time defaults, captured before configure() can overwrite them.
export function captureWidgetDefaults(widgets) {
  const out = {};
  for (const widget of widgets ?? []) {
    if (!isRestorableWidget(widget)) continue;
    out[widget.name] = jsonClone(widget.value);
  }
  return out;
}

function comboValues(widget) {
  const values = widget.options?.values;
  return Array.isArray(values) ? values : null;
}

// Does a stored value fit this widget?
//   "apply"  - value is valid for the widget.
//   "keep"   - plausible but unverifiable (e.g. a combo string missing from
//              a dynamic file list); positional migration leaves it alone,
//              a name match applies it.
//   "reject" - value cannot belong to this widget.
export function widgetValueVerdict(widget, value) {
  if (value === undefined || value === null) return "reject";
  switch (widget?.type) {
    case "number":
    case "slider": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "reject";
      const { min, max } = widget.options ?? {};
      if (typeof min === "number" && value < min) return "reject";
      if (typeof max === "number" && value > max) return "reject";
      return "apply";
    }
    case "toggle":
      return typeof value === "boolean" ? "apply" : "reject";
    case "combo": {
      if (typeof value !== "string" && typeof value !== "number") return "reject";
      const values = comboValues(widget);
      if (!values || values.length === 0) return typeof value === "string" ? "apply" : "keep";
      if (values.includes(value)) return "apply";
      // A non-member matching the list's element type stays a "keep": file
      // lists are point-in-time snapshots, so an absent name is not proof
      // the value is wrong. A type mismatch is.
      return values.some((entry) => typeof entry === typeof value) ? "keep" : "reject";
    }
    case "text":
    case "string":
    case "customtext":
      return typeof value === "string" ? "apply" : "reject";
    default:
      return "keep";
  }
}

function defaultAssignment(widget, defaults) {
  if (!defaults || !(widget.name in defaults)) return null;
  return { name: widget.name, value: jsonClone(defaults[widget.name]) };
}

function planFromLegacyArray(widgets, stored, defaults) {
  const assignments = [];
  let index = 0;
  for (const widget of widgets) {
    if (!isRestorableWidget(widget)) continue;
    // Base configure() stops at the array end, leaving later widgets on
    // their defaults — mirror that by planning nothing for them. Trailing
    // array entries beyond the widget list are ignored the same way.
    if (index >= stored.length) break;
    const value = stored[index++];
    const verdict = widgetValueVerdict(widget, value);
    if (verdict === "apply") {
      assignments.push({ name: widget.name, value: jsonClone(value) });
    } else if (verdict === "reject") {
      // The blind positional assignment already landed; undo it.
      const fallback = defaultAssignment(widget, defaults);
      if (fallback) assignments.push(fallback);
    }
    // "keep": leave whatever the positional pass applied.
  }
  return { mode: "legacy", assignments };
}

function planFromDict(widgets, stored, defaults) {
  const assignments = [];
  for (const widget of widgets) {
    if (!isRestorableWidget(widget)) continue;
    if (widget.name in stored) {
      const value = stored[widget.name];
      // A name match is strong evidence, so "keep" applies here too.
      if (widgetValueVerdict(widget, value) !== "reject") {
        assignments.push({ name: widget.name, value: jsonClone(value) });
        continue;
      }
    }
    // Missing or unusable: repair the undefined left by base configure().
    const fallback = defaultAssignment(widget, defaults);
    if (fallback) assignments.push(fallback);
  }
  return { mode: "dict", assignments };
}

function planAllDefaults(widgets, defaults) {
  const assignments = [];
  for (const widget of widgets) {
    if (!isRestorableWidget(widget)) continue;
    const fallback = defaultAssignment(widget, defaults);
    if (fallback) assignments.push(fallback);
  }
  return { mode: "invalid", assignments };
}

// Restore plan for onConfigure. `stored` is info.widgets_values in either
// format; `defaults` comes from captureWidgetDefaults at creation time.
// Never throws: an unreadable payload yields mode "invalid" with a
// defaults-only plan so the caller can warn once and keep loading.
export function planWidgetRestore(widgets, stored, defaults) {
  const list = Array.isArray(widgets) ? widgets : [];
  if (stored === undefined || stored === null) return { mode: "none", assignments: [] };
  if (Array.isArray(stored)) return planFromLegacyArray(list, stored, defaults);
  if (typeof stored === "object") return planFromDict(list, stored, defaults);
  return planAllDefaults(list, defaults);
}

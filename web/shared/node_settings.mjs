// Schema-driven per-node settings: pure validation and merge logic for the
// gear menus (settings_menu.mjs does the DOM and storage). A schema is an
// array of entries; entries with a `key` describe one setting, entries with
// only `section` render as headers and hold no value.
//
//   { section: "Civitai" }
//   { key, label, type: "toggle", default: false, hint }
//   { key, label, type: "number", default: 1, min, max, step, hint }
//   { key, label, type: "text",   default: ",", hint, placeholder }
//   { key, label, type: "choice", default: "standard", options: [...], hint }
//     (optionHints: { option: "one plain line" } lists what each option does)
//
// A number entry may additionally declare itself an *override*:
//
//   { key, label, type: "number", default: 1, neutral: 1, active: 0.95, slider: true }
//
// `neutral` is the value that means "send nothing, let the server decide".
// The menu renders those rows with an enable checkbox, so "off" is explicit
// instead of the user having to know that top_p = 1 happens to mean off.
// `active` is the value ticking the box restores when there is no earlier
// value to return to.

export function schemaDefaults(schema) {
  const values = {};
  for (const entry of schema) {
    if (entry.key !== undefined) values[entry.key] = entry.default;
  }
  return values;
}

// Coerce one stored value against its schema entry; the entry's default wins
// whenever the stored value is missing or the wrong shape.
export function coerceSetting(entry, value) {
  switch (entry.type) {
    case "toggle":
      return typeof value === "boolean" ? value : entry.default;
    case "number": {
      const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof number !== "number" || !Number.isFinite(number)) return entry.default;
      let clamped = number;
      if (typeof entry.min === "number") clamped = Math.max(entry.min, clamped);
      if (typeof entry.max === "number") clamped = Math.min(entry.max, clamped);
      return clamped;
    }
    case "text":
      return typeof value === "string" ? value : entry.default;
    case "choice":
      return entry.options?.includes(value) ? value : entry.default;
    default:
      return entry.default;
  }
}

// Merge stored values over the schema defaults. Unknown stored keys are
// dropped; every schema key comes back with a valid value.
export function mergeSettings(schema, stored) {
  const values = {};
  const source = stored && typeof stored === "object" ? stored : {};
  for (const entry of schema) {
    if (entry.key === undefined) continue;
    values[entry.key] = coerceSetting(entry, source[entry.key]);
  }
  return values;
}

// ---------- override entries ----------

// An override entry can be switched off entirely, and `neutral` is the value
// that means off. Entries without one are always-on settings.
export function isOverrideEntry(entry) {
  return !!entry && entry.key !== undefined && entry.neutral !== undefined;
}

// Is this override currently sending a value? Non-override entries are
// always active, so callers can ask unconditionally.
export function isOverrideActive(entry, value) {
  if (!isOverrideEntry(entry)) return true;
  return coerceSetting(entry, value) !== coerceSetting(entry, entry.neutral);
}

// Value to commit when the box is ticked on. Prefer what the user had before
// switching it off; otherwise the entry's suggested `active` value. Never
// returns neutral - ticking on and staying off would be a dead control.
export function overrideEnableValue(entry, lastActive) {
  if (!isOverrideEntry(entry)) return coerceSetting(entry, lastActive);
  const neutral = coerceSetting(entry, entry.neutral);
  for (const candidate of [lastActive, entry.active, entry.default]) {
    if (candidate === undefined) continue;
    const coerced = coerceSetting(entry, candidate);
    if (coerced !== neutral) return coerced;
  }
  // Every candidate was neutral: step off it within the entry's own range.
  const max = typeof entry.max === "number" ? entry.max : neutral + 1;
  const min = typeof entry.min === "number" ? entry.min : neutral - 1;
  return neutral < max ? Math.min(max, neutral + 0.05) : Math.max(min, neutral - 0.05);
}

// Does this row deserve a reset affordance? Only when it is on and holding
// something other than the value the reset would restore.
export function overrideIsCustom(entry, value) {
  if (!isOverrideActive(entry, value)) return false;
  const target = overrideEnableValue(entry, undefined);
  return coerceSetting(entry, value) !== target;
}

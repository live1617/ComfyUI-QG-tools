// Pure decisions behind the media picker (media_picker.mjs): which query
// /view needs for a combo value, which values a filter keeps, how a value
// splits into folder and name, and where the highlight moves. No DOM, so
// node:test covers them.

import { parseImageReference } from "./pad_canvas.mjs?v=2026102915";

// "pasted/image (2).png" or "clip.mp4 [output]" -> "filename=...&subfolder=...&type=...".
export function mediaViewQuery(value) {
  const reference = parseImageReference(value);
  return reference ? new URLSearchParams(reference).toString() : "";
}

// Every space-separated term must appear in the value, ignoring case, so
// "night png" finds "pasted/qg_night_bridge.png".
export function filterMedia(values, query) {
  const list = Array.isArray(values) ? values.map(String) : [];
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((value) => {
    const text = value.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

// The value to add to a media widget's list, or "" when the list has it. A
// value counts as listed with or without its " [input]" tail, which is how
// the frontend looks one up before it calls a picture missing.
export function unlistedMedia(values, value) {
  const text = String(value ?? "");
  if (!text || !Array.isArray(values)) return "";
  const bare = text.replace(/\s+\[(input|output)\]$/, "");
  return values.includes(text) || values.includes(bare) ? "" : text;
}

// The dim folder prefix and the name the list shows for one value.
export function mediaLabel(value) {
  const reference = parseImageReference(value);
  if (!reference) return { folder: "", name: String(value ?? "") };
  const where = reference.type === "input" ? "" : ` [${reference.type}]`;
  return { folder: reference.subfolder ? `${reference.subfolder}/` : "", name: `${reference.filename}${where}` };
}

// Arrow-key movement that stops at the ends; -1 when there is nothing to
// highlight. From no highlight, down starts at the top and up at the bottom.
export function moveHighlight(index, delta, length) {
  if (!(length > 0)) return -1;
  if (index < 0 || index >= length) return delta > 0 ? 0 : length - 1;
  return Math.max(0, Math.min(length - 1, index + delta));
}

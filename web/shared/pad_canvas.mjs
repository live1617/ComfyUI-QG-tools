// Pure geometry and decision logic for the on-node padding canvas
// (Load Image + Pad). No DOM in here — the drawing and pointer
// wiring live in js/shared/pad_panel.mjs and the per-node entries, so this
// module stays testable under node:test.

import { clamp } from "./transform_geometry.mjs?v=2026102319";

// The whole final-rect edge is the handle; this is the grab tolerance on
// either side of it, in CSS pixels (hit zones stay larger than the drawn
// 1.5px dashed line).
export const EDGE_HIT_BAND = 16;

// A pad band thinner than this cannot host its own "+N px" label; the label
// hops inside the image onto a contrast pill instead.
export const THIN_BAND_PX = 24;

export const PAD_SIDES = ["left", "top", "right", "bottom"];

// "sub/dir\\name.png [temp]" -> { filename, subfolder, type } for a /view
// query. Handles Windows backslashes, subfolders, and the "name [type]"
// annotation ComfyUI appends outside the input folder.
export function parseImageReference(value) {
  let text = String(value ?? "").trim();
  if (!text) return null;
  let type = "input";
  const annotated = /^(.*)\s+\[(input|output|temp)\]$/i.exec(text);
  if (annotated) {
    text = annotated[1].trim();
    type = annotated[2].toLowerCase();
  }
  const normalized = text.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const filename = slash < 0 ? normalized : normalized.slice(slash + 1);
  if (!filename) return null;
  return { filename, subfolder: slash < 0 ? "" : normalized.slice(0, slash), type };
}

function padValues(values) {
  const pad = (name) => Math.max(0, Math.round(Number(values[name]) || 0));
  return {
    left: pad("pad_left"),
    top: pad("pad_top"),
    right: pad("pad_right"),
    bottom: pad("pad_bottom"),
    multiple: Math.max(1, Math.round(Number(values.canvas_multiple) || 1)),
  };
}

// One axis: the leftover joins a padded side (the far one when both are);
// an axis nobody padded is trimmed evenly to the multiple below instead of
// growing a strip. Mirror of _axis_layout in nodes/_pad_helpers.py.
function axisLayout(size, before, after, multiple) {
  const requested = size + before + after;
  const length = Math.ceil(requested / multiple) * multiple;
  const leftover = length - requested;
  if (leftover === 0 || after > 0) return { before, after: after + leftover, trimBefore: 0, trimAfter: 0, length };
  if (before > 0) return { before: before + leftover, after, trimBefore: 0, trimAfter: 0, length };
  const kept = Math.floor(size / multiple) * multiple;
  if (kept <= 0) return { before, after: after + leftover, trimBefore: 0, trimAfter: 0, length };
  const trimBefore = Math.floor((size - kept) / 2);
  return { before: 0, after: 0, trimBefore, trimAfter: size - kept - trimBefore, length: kept };
}

// Effective per-side padding, source trim and canvas size at source scale.
// Mirror of resolve_pad_geometry in nodes/_pad_helpers.py — keep the two in
// sync. (Crop + Rotate + Pad keeps its own rule in resolvePadding.)
export function padGeometry(sourceW, sourceH, values) {
  const { left, top, right, bottom, multiple } = padValues(values);
  const x = axisLayout(Math.max(1, sourceW), left, right, multiple);
  const y = axisLayout(Math.max(1, sourceH), top, bottom, multiple);
  return {
    left: x.before,
    top: y.before,
    right: x.after,
    bottom: y.after,
    trimLeft: x.trimBefore,
    trimTop: y.trimBefore,
    trimRight: x.trimAfter,
    trimBottom: y.trimAfter,
    outputWidth: x.length,
    outputHeight: y.length,
  };
}

// The composition the stage draws, at source scale. Without a megapixel
// target it is padGeometry. With one, the backend resizes the source onto
// the multiple along an axis nobody padded rather than trimming it, so
// that axis is drawn edge to edge.
export function stageGeometry(sourceW, sourceH, values) {
  const geom = padGeometry(sourceW, sourceH, values);
  if (!((Number(values.target_megapixels) || 0) > 0)) return geom;
  const { left, top, right, bottom } = padValues(values);
  if (left + right === 0) {
    Object.assign(geom, { left: 0, right: 0, trimLeft: 0, trimRight: 0, outputWidth: Math.max(1, sourceW) });
  }
  if (top + bottom === 0) {
    Object.assign(geom, { top: 0, bottom: 0, trimTop: 0, trimBottom: 0, outputHeight: Math.max(1, sourceH) });
  }
  return geom;
}

// Final output size after the multiple AND megapixel math — what the badge
// shows ("the badge is the truth"). Mirror of plan_pad_canvas in
// nodes/_pad_helpers.py — keep the two in sync.
export function finalOutputSize(sourceW, sourceH, values) {
  const target = Number(values.target_megapixels) || 0;
  if (target <= 0) {
    const base = padGeometry(sourceW, sourceH, values);
    return { width: base.outputWidth, height: base.outputHeight, scale: 1 };
  }
  const { left, top, right, bottom, multiple } = padValues(values);
  const w = Math.max(1, sourceW);
  const h = Math.max(1, sourceH);
  const ceil = (value) => Math.ceil(value / multiple) * multiple;
  // The budget is measured against the requested canvas rounded up.
  let scale = Math.sqrt((target * 1e6) / (ceil(w + left + right) * ceil(h + top + bottom)));
  let width = Math.max(1, Math.round(w * scale));
  let height = Math.max(1, Math.round(h * scale));
  // 0 = not snapped: padded, or under half a multiple.
  const snapW = left + right === 0 ? Math.round((w * scale) / multiple) * multiple : 0;
  const snapH = top + bottom === 0 ? Math.round((h * scale) / multiple) * multiple : 0;
  if (snapW && snapH) {
    width = snapW;
    height = snapH;
  } else if (snapW) {
    scale = snapW / w;
    width = snapW;
    height = Math.max(1, Math.round(h * scale));
  } else if (snapH) {
    scale = snapH / h;
    width = Math.max(1, Math.round(w * scale));
    height = snapH;
  }
  const final = padGeometry(width, height, {
    pad_left: Math.round(left * scale),
    pad_top: Math.round(top * scale),
    pad_right: Math.round(right * scale),
    pad_bottom: Math.round(bottom * scale),
    canvas_multiple: multiple,
  });
  return { width: final.outputWidth, height: final.outputHeight, scale };
}

// Which edge of the final rect (CSS-pixel {x, y, width, height}) the point
// grabs: the whole edge is the handle, corners resolve to the nearer edge,
// anywhere else is null so the click falls through and the node drags.
export function hitPadEdge(point, rect, band = EDGE_HIT_BAND) {
  if (!rect || !point) return null;
  const inside =
    point.x >= rect.x - band &&
    point.x <= rect.x + rect.width + band &&
    point.y >= rect.y - band &&
    point.y <= rect.y + rect.height + band;
  if (!inside) return null;
  const distances = {
    left: Math.abs(point.x - rect.x),
    right: Math.abs(point.x - (rect.x + rect.width)),
    top: Math.abs(point.y - rect.y),
    bottom: Math.abs(point.y - (rect.y + rect.height)),
  };
  let best = null;
  for (const side of PAD_SIDES) {
    if (distances[side] > band) continue;
    if (!best || distances[side] < distances[best]) best = side;
  }
  return best;
}

// New raw pad value for a drag: left/top edges move outward with negative
// deltas, right/bottom with positive. Deltas are in world (source) pixels.
export function padDragValue(side, startPads, worldDx, worldDy) {
  const start = Math.max(0, Number(startPads?.[side]) || 0);
  const delta =
    side === "left" ? -worldDx : side === "right" ? worldDx : side === "top" ? -worldDy : worldDy;
  return Math.max(0, Math.round(start + delta));
}

export function edgeCursor(side) {
  if (side === "left" || side === "right") return "ew-resize";
  if (side === "top" || side === "bottom") return "ns-resize";
  return "";
}

// Where a side's "+N px" label lives: on the band when it is thick enough to
// read, hopped onto a contrast pill inside the image when it is thin.
export function labelMode(bandCssPx, threshold = THIN_BAND_PX) {
  return (Number(bandCssPx) || 0) >= threshold ? "band" : "pill";
}

// Panel height coupled to node width: wide node, taller stage, within reason.
export function canvasHeightForWidth(width) {
  return Math.round(clamp((Number(width) || 0) * 0.66, 180, 520));
}

// Aspect-fit a world rect into a view with a uniform margin; returns the
// scale and the view-space origin of the world rect.
export function fitRect(worldW, worldH, viewW, viewH, margin = 26) {
  const availW = Math.max(1, viewW - margin * 2);
  const availH = Math.max(1, viewH - margin * 2);
  const scale = Math.max(0.001, Math.min(availW / Math.max(1, worldW), availH / Math.max(1, worldH)));
  return { scale, x: (viewW - worldW * scale) / 2, y: (viewH - worldH * scale) / 2 };
}


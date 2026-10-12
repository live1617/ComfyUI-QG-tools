export const MIN_CROP_SIZE = 8;

export const IDENTITY_TRANSFORM = Object.freeze({
  rotation_degrees: 0,
  crop_aspect_ratio: "free",
  crop_x: 0,
  crop_y: 0,
  crop_width: 0,
  crop_height: 0,
  pad_left: 0,
  pad_top: 0,
  pad_right: 0,
  pad_bottom: 0,
  // Feather defaults on: with zero padding/rotation there is no generated
  // area, so it is a no-op until the mask has something to soften.
  feather: 24,
  canvas_multiple: 1,
  fill_color: "#808080",
});

export function resetTransformValues(includeTimeline = false) {
  return includeTimeline
    ? { ...IDENTITY_TRANSFORM, seek_mode: "frame index", frame_index: 0, frame_time: 0 }
    : { ...IDENTITY_TRANSFORM };
}

// What Reset returns to: the node's own declared defaults (the clip node
// ships a black fill and feather 0 for video outpaint, the image nodes grey
// and 24) laid over the shared identity for anything the definition lacks.
export function declaredTransformDefaults(nodeData, includeTimeline = false) {
  const base = resetTransformValues(includeTimeline);
  const groups = nodeData?.input;
  if (!groups || typeof groups !== "object") return base;
  for (const name of Object.keys(base)) {
    const spec = groups.required?.[name] ?? groups.optional?.[name];
    const declared = Array.isArray(spec) ? spec[1]?.default : undefined;
    if (declared !== undefined && declared !== null) base[name] = declared;
  }
  return base;
}

export function sourceChanged(previousKey, nextKey, ready = true) {
  return Boolean(ready && nextKey && previousKey !== nextKey);
}

// The source a node tells the next pick apart from. Its first sync and a
// workflow load remember what the node holds, blank included: a node saved
// blank was created on the first file in the input folder, and picking that
// file must still count as a new picture. Only a blank the user makes (Server
// file before a path is typed) keeps the last source, so going back to the
// same file is no change.
export function rememberedSource(previousKey, nextKey, userChange = false) {
  return userChange && !nextKey ? previousKey : nextKey;
}

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

// Matches Pillow's Image.rotate(expand=True) output size exactly, verified
// against PIL across 6776 size/angle combinations. Pillow transposes at the
// axis angles (no ceil/floor growth) and otherwise takes ceil(max)-floor(min)
// of the corner extents using cos/sin rounded to 15 decimals. Keep in sync
// with nodes/_transform_engine.py, which delegates to Pillow.
export function rotatedSize(width, height, degrees) {
  const normalized = ((Number(degrees) || 0) % 360 + 360) % 360;
  if (normalized === 0 || normalized === 180) return { width: Math.max(1, width), height: Math.max(1, height) };
  if (normalized === 90 || normalized === 270) return { width: Math.max(1, height), height: Math.max(1, width) };
  const radians = normalized * Math.PI / 180;
  const round15 = (value) => Math.round(value * 1e15) / 1e15;
  const cosine = round15(Math.cos(radians));
  const sine = round15(Math.sin(radians));
  const centerX = width / 2;
  const centerY = height / 2;
  const xs = [];
  const ys = [];
  for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
    xs.push(centerX + (x - centerX) * cosine - (y - centerY) * sine);
    ys.push(centerY + (x - centerX) * sine + (y - centerY) * cosine);
  }
  return {
    width: Math.max(1, Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs))),
    height: Math.max(1, Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys))),
  };
}

export function parseAspectRatio(value, source) {
  if (!value || value === "free") return null;
  if (value === "source") return source.width / source.height;
  const parts = String(value).split(":").map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part) || part <= 0)) return null;
  return parts[0] / parts[1];
}

// A crop_aspect_ratio as the integer pair the backend uses, or null for
// free (and anything the backend would refuse). "source" is the rotated
// canvas's own size.
export function aspectPair(value, source) {
  if (!value || value === "free") return null;
  if (value === "source") return [Math.max(1, Math.round(source.width)), Math.max(1, Math.round(source.height))];
  const parts = String(value).split(":").map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part) || part <= 0)) return null;
  return parts;
}

// The largest box of a ratio inside width x height, in integers exactly as
// _transform_engine._geometry computes it. A box already within a pixel of
// the ratio on either side is kept as it is, so a resolved crop written
// back resolves to itself.
export function ratioBox(width, height, [ratioWidth, ratioHeight]) {
  const fitHeight = Math.floor((width * ratioHeight) / ratioWidth);
  const fitWidth = Math.floor((height * ratioWidth) / ratioHeight);
  if (height === fitHeight || width === fitWidth) return { width, height };
  if (width * ratioHeight > height * ratioWidth) return { width: Math.max(1, fitWidth), height };
  return { width, height: Math.max(1, fitHeight) };
}

export function resolveCrop(values, source) {
  const x = Math.round(clamp(values.crop_x, 0, Math.max(0, source.width - 1)));
  const y = Math.round(clamp(values.crop_y, 0, Math.max(0, source.height - 1)));
  let width = Number(values.crop_width) > 0 ? Number(values.crop_width) : source.width - x;
  let height = Number(values.crop_height) > 0 ? Number(values.crop_height) : source.height - y;
  width = Math.max(1, Math.min(Math.round(width), source.width - x));
  height = Math.max(1, Math.min(Math.round(height), source.height - y));
  const pair = aspectPair(values.crop_aspect_ratio, source);
  if (pair) ({ width, height } = ratioBox(width, height, pair));
  return { x, y, width, height };
}

export function resolvePadding(values, crop) {
  const left = Math.max(0, Math.round(Number(values.pad_left) || 0));
  const top = Math.max(0, Math.round(Number(values.pad_top) || 0));
  const right = Math.max(0, Math.round(Number(values.pad_right) || 0));
  const bottom = Math.max(0, Math.round(Number(values.pad_bottom) || 0));
  const multiple = Math.max(1, Math.round(Number(values.canvas_multiple) || 1));
  const requestedWidth = crop.width + left + right;
  const requestedHeight = crop.height + top + bottom;
  const outputWidth = Math.ceil(requestedWidth / multiple) * multiple;
  const outputHeight = Math.ceil(requestedHeight / multiple) * multiple;
  return {
    left,
    top,
    right: right + outputWidth - requestedWidth,
    bottom: bottom + outputHeight - requestedHeight,
    outputWidth,
    outputHeight,
  };
}

// A shape within about 1% of a ratio counts as that ratio. A picture that
// is almost 9:16 already is 9:16 for a ratio button: padding it would add a
// band a pixel or two wide that nobody can use, and cropping it would trim
// a sliver.
export const NEAR_RATIO = 0.01;

export function nearRatio(width, height, ratio) {
  return ratio > 0 && width > 0 && height > 0 && Math.abs(width / height / ratio - 1) <= NEAR_RATIO;
}

// Fit actions replace previous crop/padding, but retain rotation, fill and
// resize settings. Padding must unlock the INNER crop or the backend would
// trim the source before adding the new outer canvas.
export function fitSourceToAspect(source, aspect, mode = "crop") {
  const ratio = parseAspectRatio(aspect, source);
  const patch = {
    crop_aspect_ratio: mode === "pad" ? "free" : aspect,
    crop_x: 0, crop_y: 0, crop_width: source.width, crop_height: source.height,
    pad_left: 0, pad_top: 0, pad_right: 0, pad_bottom: 0,
  };
  if (!ratio || aspect === "source") return patch;
  // Already the shape: nothing to add, nothing to trim.
  if (nearRatio(source.width, source.height, ratio)) return { ...patch, crop_aspect_ratio: "free" };
  if (mode === "pad") {
    const width = Math.max(source.width, Math.ceil(source.height * ratio));
    const height = Math.max(source.height, Math.ceil(source.width / ratio));
    patch.pad_left = Math.floor((width - source.width) / 2);
    patch.pad_right = width - source.width - patch.pad_left;
    patch.pad_top = Math.floor((height - source.height) / 2);
    patch.pad_bottom = height - source.height - patch.pad_top;
  } else {
    const crop = resolveCrop(patch, source);
    // Leave one dimension open so rounding is applied exactly once when
    // the backend resolves this centered crop.
    if (source.width / source.height > ratio) {
      patch.crop_x = Math.floor((source.width - crop.width) / 2);
      patch.crop_width = 0;
    } else {
      patch.crop_y = Math.floor((source.height - crop.height) / 2);
      patch.crop_height = 0;
    }
  }
  return patch;
}

export function canvasLocalPoint(canvas, event) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, canvas.clientWidth || bounds.width || 1);
  const height = Math.max(1, canvas.clientHeight || bounds.height || 1);
  return {
    x: ((event.clientX - bounds.left) / Math.max(1, bounds.width || width)) * width,
    y: ((event.clientY - bounds.top) / Math.max(1, bounds.height || height)) * height,
  };
}

export function cropHandleCenters(rect) {
  const middleX = rect.x + rect.width / 2;
  const middleY = rect.y + rect.height / 2;
  return [
    { name: "nw", x: rect.x, y: rect.y },
    { name: "n", x: middleX, y: rect.y },
    { name: "ne", x: rect.x + rect.width, y: rect.y },
    { name: "e", x: rect.x + rect.width, y: middleY },
    { name: "se", x: rect.x + rect.width, y: rect.y + rect.height },
    { name: "s", x: middleX, y: rect.y + rect.height },
    { name: "sw", x: rect.x, y: rect.y + rect.height },
    { name: "w", x: rect.x, y: middleY },
  ];
}

export function paddingHandleCenters(rect, offset = 38) {
  return [
    { name: "pad_top", x: rect.x + rect.width / 2, y: rect.y - offset },
    { name: "pad_right", x: rect.x + rect.width + offset, y: rect.y + rect.height / 2 },
    { name: "pad_bottom", x: rect.x + rect.width / 2, y: rect.y + rect.height + offset },
    { name: "pad_left", x: rect.x - offset, y: rect.y + rect.height / 2 },
  ];
}

// The corner handles sit outside the canvas corners, as far out as the side
// diamonds, so the eight padding handles ring the canvas and stay clear of
// the crop squares on the picture's own corners.
export function canvasCornerCenters(rect, offset = 38) {
  return [
    { name: "corner_nw", corner: "nw", x: rect.x - offset, y: rect.y - offset },
    { name: "corner_ne", corner: "ne", x: rect.x + rect.width + offset, y: rect.y - offset },
    { name: "corner_se", corner: "se", x: rect.x + rect.width + offset, y: rect.y + rect.height + offset },
    { name: "corner_sw", corner: "sw", x: rect.x - offset, y: rect.y + rect.height + offset },
  ];
}

// The free spots on that ring: halfway between each corner handle and the
// side diamond next to it.
export function paddingRingGaps(rect, offset = 38) {
  const [nw, ne, se, sw] = canvasCornerCenters(rect, offset);
  const [top, right, bottom, left] = paddingHandleCenters(rect, offset);
  const ring = [nw, top, ne, right, se, bottom, sw, left];
  return ring.map((point, index) => {
    const next = ring[(index + 1) % ring.length];
    return { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
  });
}

export function nearestHandle(point, groups) {
  let selected = null;
  for (const group of groups) {
    for (const handle of group.handles) {
      const distance = Math.hypot(point.x - handle.x, point.y - handle.y);
      if (distance > group.radius) continue;
      if (!selected || distance < selected.distance || (distance === selected.distance && group.priority < selected.priority)) {
        selected = { ...handle, kind: group.kind, distance, priority: group.priority };
      }
    }
  }
  return selected;
}

export function resizeCrop(start, handle, dx, dy, source, aspectRatio = null) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP_SIZE);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN_CROP_SIZE, source.width);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP_SIZE);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP_SIZE, source.height);
  if (aspectRatio) {
    let width = right - left;
    let height = bottom - top;
    if (Math.abs(dx) >= Math.abs(dy)) height = width / aspectRatio;
    else width = height * aspectRatio;
    if (handle.includes("w")) left = right - width; else right = left + width;
    if (handle.includes("n")) top = bottom - height; else bottom = top + height;
    if (left < 0) { right -= left; left = 0; }
    if (top < 0) { bottom -= top; top = 0; }
    if (right > source.width) { left -= right - source.width; right = source.width; }
    if (bottom > source.height) { top -= bottom - source.height; bottom = source.height; }
  }
  return {
    x: Math.round(clamp(left, 0, source.width - MIN_CROP_SIZE)),
    y: Math.round(clamp(top, 0, source.height - MIN_CROP_SIZE)),
    width: Math.round(Math.max(MIN_CROP_SIZE, Math.min(right - left, source.width))),
    height: Math.round(Math.max(MIN_CROP_SIZE, Math.min(bottom - top, source.height))),
  };
}

export function zoomAround(view, nextZoom, anchor) {
  const zoom = clamp(nextZoom, 0.2, 6);
  const ratio = zoom / view.zoom;
  return {
    zoom,
    panX: anchor.x - (anchor.x - view.panX) * ratio,
    panY: anchor.y - (anchor.y - view.panY) * ratio,
  };
}

// The least height the node-face stage gets for its width: about the shape
// of a 16:9 canvas with the handles around it, so a padded clip is never a
// thumbnail. A wider stage earns a taller floor, clamped so a very wide node
// is not forced to be very tall.
export function stageHeightForWidth(width) {
  return Math.round(clamp((Number(width) || 0) * 0.6, 200, 340));
}

// Stage-size-aware handle geometry shared by the editor stage and the
// compact node panel. Large stages keep the editor's classic offsets; small
// stages pull the outboard handles (padding diamonds, rotate knob) inward,
// and the fit margin never drops below the clearance those handles need to
// stay fully visible. Drawn handle sizes are constant CSS pixels on every
// surface; hit radii stay ~2-3x the drawn size.
export function stageHandleLayout(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const short = Math.min(safeWidth, safeHeight);
  const padOffset = Math.round(clamp(short * 0.09, 16, 38));
  const rotateArm = Math.round(clamp(short * 0.085, 14, 34));
  // Pad diamond half-diagonal is ~11px, the knob radius 13px plus stroke.
  const clearance = Math.max(padOffset + 12, rotateArm + 15);
  const margin = Math.max(clearance, Math.min(90, safeWidth * 0.1, safeHeight * 0.1));
  return { padOffset, rotateArm, margin };
}

// JS mirror of nodes/_transform_engine.py scale_to_megapixels, so the
// editor can show the exact size the backend will produce. Budget is
// megapixels * 1024 * 1024 (core Scale Image to Total Pixels semantics);
// each dimension rounds independently to a multiple of steps, never below
// one step. Keep the two in sync.
export function scaleToMegapixels(width, height, megapixels, steps = 1) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const total = Math.max(1, (Number(megapixels) || 1) * 1024 * 1024);
  const scale = Math.sqrt(total / (sourceWidth * sourceHeight));
  const step = Math.max(1, Math.round(Number(steps) || 1));
  return {
    width: Math.max(step, Math.round((sourceWidth * scale) / step) * step),
    height: Math.max(step, Math.round((sourceHeight * scale) / step) * step),
  };
}

// --- Rotation keeps the crop ------------------------------------------------
// Crop values that keep the framing when the rotation moves from one angle
// to another. Crop numbers live in rotated-canvas pixels and that canvas
// changes size with every degree, so leaving them alone slid the crop off
// the picture, and zeroing them threw the crop away. Instead the crop keeps
// its size and stays over the same point of the picture: the offset of its
// centre from the picture centre turns with the picture, then the box is
// clamped into the new canvas (shrunk evenly, at its ratio, when it no
// longer fits). A crop that was the whole canvas stays open, so an
// uncropped canvas still grows to hold the tilted picture.
export function cropForRotation(values, sourceWidth, sourceHeight, fromDegrees, toDegrees) {
  const before = rotatedSize(sourceWidth, sourceHeight, fromDegrees);
  const after = rotatedSize(sourceWidth, sourceHeight, toDegrees);
  const crop = resolveCrop(values, before);
  if (crop.x === 0 && crop.y === 0 && crop.width === before.width && crop.height === before.height) {
    return { crop_x: 0, crop_y: 0, crop_width: 0, crop_height: 0 };
  }
  const turn = ((Number(toDegrees) || 0) - (Number(fromDegrees) || 0)) * Math.PI / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const offsetX = crop.x + crop.width / 2 - before.width / 2;
  const offsetY = crop.y + crop.height / 2 - before.height / 2;
  const centerX = after.width / 2 + offsetX * cos - offsetY * sin;
  const centerY = after.height / 2 + offsetX * sin + offsetY * cos;
  const fit = Math.min(1, after.width / crop.width, after.height / crop.height);
  let box = { width: Math.max(1, Math.floor(crop.width * fit)), height: Math.max(1, Math.floor(crop.height * fit)) };
  const pair = aspectPair(values.crop_aspect_ratio, after);
  if (pair && fit < 1) box = ratioBox(box.width, box.height, pair);
  return {
    crop_x: Math.round(clamp(centerX - box.width / 2, 0, after.width - box.width)),
    crop_y: Math.round(clamp(centerY - box.height / 2, 0, after.height - box.height)),
    crop_width: box.width,
    crop_height: box.height,
  };
}

// --- Size chain ---------------------------------------------------------------
// Every step that sets the output size, in the order the backend runs them,
// so the face can say why the canvas is the size it is: the crop, the crop
// plus padding, that rounded up to canvas_multiple, then the resize. Also
// the surprises worth naming. Each resized side rounds to the steps on its
// own, which stretches the picture a little (`stretch`, the fraction by
// which the width scaled more than the height; negative is taller). Align
// pads the right and bottom with fill (`alignAdded`), which ahead of a
// resize is only a strip for the model to paint, and a resize whose sides
// are not multiples of canvas_multiple undoes it anyway (`alignLost`).
// `resize` is { megapixels, steps } or null.
export function sizeChain(values, source, resize = null) {
  const crop = resolveCrop(values, source);
  const padding = resolvePadding(values, crop);
  const pads = paddingOf(values);
  const multiple = Math.max(1, Math.round(Number(values.canvas_multiple) || 1));
  const chain = {
    source: { width: source.width, height: source.height },
    crop,
    cropped: crop.width !== source.width || crop.height !== source.height,
    padded: { width: crop.width + pads.left + pads.right, height: crop.height + pads.top + pads.bottom },
    canvas: { width: padding.outputWidth, height: padding.outputHeight },
    multiple,
    resized: null,
    stretch: 0,
    alignLost: false,
  };
  // The fill strip Align adds on the right and bottom.
  chain.alignAdded = { right: chain.canvas.width - chain.padded.width, bottom: chain.canvas.height - chain.padded.height };
  if (resize) {
    const resized = scaleToMegapixels(chain.canvas.width, chain.canvas.height, resize.megapixels, resize.steps);
    chain.resized = resized;
    chain.steps = Math.max(1, Math.round(Number(resize.steps) || 1));
    chain.stretch = (resized.width / chain.canvas.width) / (resized.height / chain.canvas.height) - 1;
    chain.alignLost = multiple > 1 && (resized.width % multiple !== 0 || resized.height % multiple !== 0);
  }
  return chain;
}

// How far the resize may stretch the picture before the face says so.
export const STRETCH_WARNING = 0.01;

// The chain as short readout tokens, the last one the size the run emits,
// plus warnings. A step that changes nothing is left out.
export function sizeChainTokens(chain) {
  const size = ({ width, height }) => `${width}×${height}`;
  const tokens = [{ label: chain.cropped ? "crop" : "", text: size(chain.crop) }];
  if (chain.padded.width !== chain.crop.width || chain.padded.height !== chain.crop.height) {
    tokens.push({ label: "pad", text: size(chain.padded) });
  }
  if (chain.canvas.width !== chain.padded.width || chain.canvas.height !== chain.padded.height) {
    tokens.push({ label: `round to ${chain.multiple}`, text: size(chain.canvas) });
  }
  if (chain.resized) tokens.push({ label: "resize", text: size(chain.resized) });
  const warnings = [];
  if (Math.abs(chain.stretch) > STRETCH_WARNING) {
    warnings.push(`${(Math.abs(chain.stretch) * 100).toFixed(1)}% ${chain.stretch > 0 ? "wider" : "taller"}: each side rounds to ${chain.steps ?? 1} px`);
  }
  // Ahead of a resize, Divisible by's strip is only fill for the model to
  // paint: the Step already rounds the size. Name where it went.
  const { right, bottom } = chain.alignAdded ?? { right: 0, bottom: 0 };
  if (chain.resized && (right || bottom)) {
    const sides = [right ? `${right} px on the right` : "", bottom ? `${bottom} px at the bottom` : ""].filter(Boolean).join(" and ");
    warnings.push(`rounding to ${chain.multiple} adds ${sides} of fill`);
  } else if (chain.alignLost) {
    warnings.push(`the resize undoes rounding to ${chain.multiple}`);
  }
  return { tokens, warnings };
}

// --- Aspect lock ------------------------------------------------------------
// A locked format chip keeps the output canvas (crop plus padding) at one
// ratio through every handle gesture. The axis a gesture moved is the
// driver; the other axis's padding follows, split over its two sides and
// never below zero. When the follower cannot give enough, the driver's own
// padding grows instead - a crop pulled inward gets fill back, so the canvas
// keeps its shape and the model paints what was cut - and when nothing can
// shrink, the smallest canvas that holds the crop at the ratio wins.

function nonNegative(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function paddingOf(values) {
  return {
    left: nonNegative(values.pad_left),
    top: nonNegative(values.pad_top),
    right: nonNegative(values.pad_right),
    bottom: nonNegative(values.pad_bottom),
  };
}

// Spread `delta` over an axis's two sides, half each, clamped at zero; null
// when the pair cannot absorb a shrink that large.
function splitDelta(delta, first, second) {
  if (first + second + delta < 0) return null;
  const half = Math.floor(delta / 2);
  let a = first + half;
  let b = second + (delta - half);
  if (a < 0) { b += a; a = 0; }
  if (b < 0) { a += b; b = 0; }
  return [a, b];
}

// A canvas already counts as on-ratio when either side is the rounded
// counterpart of the other, so a solved state - or the ceil-padded canvas a
// format chip produced - is a fixed point and never creeps by a pixel.
function onRatio(width, height, ratio) {
  return width === Math.round(height * ratio) || height === Math.round(width / ratio);
}

function solveAxis(axis, pads, crop, ratio) {
  const width = crop.width + pads.left + pads.right;
  const height = crop.height + pads.top + pads.bottom;
  if (onRatio(width, height, ratio)) return { ...pads };
  if (axis === "x") {
    const pair = splitDelta(Math.round(height * ratio) - width, pads.left, pads.right);
    return pair ? { ...pads, left: pair[0], right: pair[1] } : null;
  }
  const pair = splitDelta(Math.round(width / ratio) - height, pads.top, pads.bottom);
  return pair ? { ...pads, top: pair[0], bottom: pair[1] } : null;
}

function fitAround(crop, ratio) {
  const width = Math.max(crop.width, Math.ceil(crop.height * ratio));
  const height = Math.max(crop.height, Math.ceil(crop.width / ratio));
  const left = Math.floor((width - crop.width) / 2);
  const top = Math.floor((height - crop.height) / 2);
  return { left, top, right: width - crop.width - left, bottom: height - crop.height - top };
}

// Padding that sets the crop, centred, in the smallest canvas of `ratio`
// that holds it: what the orientation button pads a turned shape to.
export function padAround(crop, ratio) {
  if (nearRatio(crop.width, crop.height, ratio)) return { pad_left: 0, pad_top: 0, pad_right: 0, pad_bottom: 0 };
  const pads = fitAround(crop, ratio);
  return { pad_left: pads.left, pad_top: pads.top, pad_right: pads.right, pad_bottom: pads.bottom };
}

export function paddingAxis(name) {
  return name === "pad_left" || name === "pad_right" ? "x" : "y";
}

// Padding values that hold `ratio` (width / height) around the resolved
// `crop`, changing the follower of `driver` first. Null for no ratio.
export function lockPadding(values, crop, ratio, driver = "x") {
  if (!(ratio > 0) || !(crop?.width > 0) || !(crop?.height > 0)) return null;
  const pads = paddingOf(values);
  const follower = driver === "y" ? "x" : "y";
  let solved = solveAxis(follower, pads, crop, ratio) ?? solveAxis(driver, pads, crop, ratio);
  if (!solved) {
    const base = driver === "x" ? { ...pads, top: 0, bottom: 0 } : { ...pads, left: 0, right: 0 };
    solved = solveAxis(follower, base, crop, ratio) ?? solveAxis(driver, base, crop, ratio) ?? fitAround(crop, ratio);
  }
  return { pad_left: solved.left, pad_top: solved.top, pad_right: solved.right, pad_bottom: solved.bottom };
}

// The least a padding side can be dragged to under the lock: the other
// axis must still fit its crop with no padding at all. Below this the
// handle simply stops.
export function lockedPadMinimum(values, crop, ratio, name) {
  if (!(ratio > 0) || !(crop?.width > 0) || !(crop?.height > 0)) return 0;
  const pads = paddingOf(values);
  if (paddingAxis(name) === "y") {
    const other = name === "pad_top" ? pads.bottom : pads.top;
    return Math.max(0, Math.ceil(crop.width / ratio) - crop.height - other);
  }
  const other = name === "pad_left" ? pads.right : pads.left;
  return Math.max(0, Math.ceil(crop.height * ratio) - crop.width - other);
}

// --- Ratio chips ---------------------------------------------------------------
// A chip is lit while the output canvas has its shape. The canvas here is
// the crop plus the padding, before Align's rounding (a strip Align adds
// does not make a 16:9 canvas "custom").
export function canvasSize(values, source) {
  const crop = resolveCrop(values, source);
  const pads = paddingOf(values);
  return { width: crop.width + pads.left + pads.right, height: crop.height + pads.top + pads.bottom };
}

// Does width x height have the shape of `aspect` ("16:9")? A pixel of
// rounding either way still counts, so a fitted canvas is never "custom",
// and so does anything within about 1% (NEAR_RATIO): the shape a ratio
// button leaves alone because it is already there.
export function aspectMatches(width, height, aspect, source = { width, height }) {
  const ratio = parseAspectRatio(aspect, source);
  if (!ratio || !(width > 0) || !(height > 0)) return false;
  return onRatio(width, height, ratio) || nearRatio(width, height, ratio);
}

// The same ratio on its side: "16:9" -> "9:16". Square and anything that is
// not a W:H pair comes back unchanged.
export function turnAspect(aspect) {
  const parts = String(aspect ?? "").split(":");
  if (parts.length !== 2 || parts[0] === parts[1]) return String(aspect ?? "");
  return `${parts[1]}:${parts[0]}`;
}

// A shape no chip names, for the face: "1.49:1" wide, "1:1.49" tall.
export function ratioLabel(width, height) {
  if (!(width > 0) || !(height > 0)) return "";
  if (width === height) return "1:1";
  return width > height ? `${(width / height).toFixed(2)}:1` : `1:${(height / width).toFixed(2)}`;
}

// Nothing done to the picture yet: no rotation, the whole source, no
// padding. The chip row then says so instead of calling it custom.
export function isUntouched(values, source) {
  const crop = resolveCrop(values, source);
  const pads = paddingOf(values);
  return !(Number(values.rotation_degrees) || 0)
    && crop.x === 0 && crop.y === 0 && crop.width === source.width && crop.height === source.height
    && !pads.left && !pads.top && !pads.right && !pads.bottom;
}

// Crop mode's orientation turn: the crop box on its side around its own
// centre, scaled down evenly when it would leave the picture, then kept
// inside it. The pixels never rotate; only the box does.
export function turnedCrop(crop, source) {
  const fit = Math.min(1, source.width / crop.height, source.height / crop.width);
  const width = Math.max(1, Math.floor(crop.height * fit));
  const height = Math.max(1, Math.floor(crop.width * fit));
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  return {
    x: Math.round(clamp(centerX - width / 2, 0, source.width - width)),
    y: Math.round(clamp(centerY - height / 2, 0, source.height - height)),
    width,
    height,
  };
}

// --- Corner handles -----------------------------------------------------------
// A corner handle scales the canvas and keeps its shape. The picture stays
// as it is; only the padding changes. By default the padding on the grabbed
// corner's two sides changes and the opposite corner holds still. About the
// centre (Alt held), every side changes, half of the change on each side of
// an axis, so the canvas keeps its middle.

// The backend's limit for one side's padding.
export const MAX_PADDING = 32768;

// How far a corner drag scales the canvas: the pointer's move projected on
// the canvas diagonal, so the grabbed corner follows the pointer along it.
// dx and dy are canvas pixels. About the centre the grabbed corner is half as
// far from the point that holds still, so the same move scales twice as much.
export function cornerScale(corner, dx, dy, width, height, centre = false) {
  const sx = corner.includes("e") ? 1 : -1;
  const sy = corner.includes("s") ? 1 : -1;
  const diagonal = width * width + height * height;
  if (!(diagonal > 0)) return 1;
  return 1 + (centre ? 2 : 1) * ((Number(dx) || 0) * sx * width + (Number(dy) || 0) * sy * height) / diagonal;
}

// The padding for a canvas `scale` times its size when the drag began
// (`start` holds that padding, `crop` the resolved crop). The canvas never
// gets smaller than the picture needs: the grabbed corner stops where one of
// its sides runs out of padding, and about the centre once both sides of an
// axis have. A side that runs out first gives the rest of a shrink to the
// side across from it.
export function scaleCanvasPadding(start, crop, corner, scale, { centre = false } = {}) {
  const pads = paddingOf(start);
  const width = crop.width + pads.left + pads.right;
  const height = crop.height + pads.top + pads.bottom;
  const east = corner.includes("e");
  const south = corner.includes("s");
  let minWidth = crop.width;
  let minHeight = crop.height;
  let maxWidth = width + 2 * (MAX_PADDING - Math.max(pads.left, pads.right));
  let maxHeight = height + 2 * (MAX_PADDING - Math.max(pads.top, pads.bottom));
  if (!centre) {
    const heldX = east ? pads.left : pads.right;
    const heldY = south ? pads.top : pads.bottom;
    minWidth = crop.width + heldX;
    minHeight = crop.height + heldY;
    maxWidth = minWidth + MAX_PADDING;
    maxHeight = minHeight + MAX_PADDING;
  }
  const lowest = Math.max(minWidth / width, minHeight / height);
  const highest = Math.max(lowest, Math.min(maxWidth / width, maxHeight / height));
  const factor = clamp(scale, lowest, highest);
  // The longer side is rounded and the other follows it, so the shape holds
  // to the pixel.
  let nextWidth;
  let nextHeight;
  if (width >= height) {
    nextWidth = Math.round(width * factor);
    nextHeight = Math.round((nextWidth * height) / width);
  } else {
    nextHeight = Math.round(height * factor);
    nextWidth = Math.round((nextHeight * width) / height);
  }
  nextWidth = clamp(nextWidth, minWidth, Math.max(minWidth, maxWidth));
  nextHeight = clamp(nextHeight, minHeight, Math.max(minHeight, maxHeight));
  let { left, top, right, bottom } = pads;
  if (centre) {
    [left, right] = splitDelta(nextWidth - width, pads.left, pads.right) ?? [left, right];
    [top, bottom] = splitDelta(nextHeight - height, pads.top, pads.bottom) ?? [top, bottom];
  } else {
    if (east) right = nextWidth - crop.width - left; else left = nextWidth - crop.width - right;
    if (south) bottom = nextHeight - crop.height - top; else top = nextHeight - crop.height - bottom;
  }
  const side = (amount) => clamp(Math.round(amount), 0, MAX_PADDING);
  return { pad_left: side(left), pad_top: side(top), pad_right: side(right), pad_bottom: side(bottom) };
}

// --- Centring -------------------------------------------------------------------
// The padding that puts the picture in the middle of the canvas along one
// axis ("x": left and right, "y": top and bottom). It only moves padding from
// one side to the other, so the canvas keeps its size and shape and a lit
// ratio stays lit. The strip Divisible by adds on the right and bottom
// counts as padding on that side, so the bands you see come out even; with
// less padding than that strip, it gets as close as it can. Null when there
// is nothing to move.
export function centredPadding(values, crop, axis) {
  const pads = paddingOf(values);
  const resolved = resolvePadding(values, crop);
  const [near, far, strip] = axis === "y"
    ? [pads.top, pads.bottom, resolved.bottom - pads.bottom]
    : [pads.left, pads.right, resolved.right - pads.right];
  const total = near + far;
  const next = clamp(Math.floor((total + strip) / 2), 0, total);
  if (next === near) return null;
  return axis === "y"
    ? { pad_top: next, pad_bottom: total - next }
    : { pad_left: next, pad_right: total - next };
}

// The bands on either side of the picture along an axis as the output has
// them (Divisible by's strip included), for the centre buttons to say
// where the picture sits.
export function axisBands(values, crop, axis) {
  const resolved = resolvePadding(values, crop);
  return axis === "y" ? { near: resolved.top, far: resolved.bottom } : { near: resolved.left, far: resolved.right };
}

// Dragging the picture itself where the crop has nowhere to go: along an
// axis where the crop spans the whole source, the padding moves from one
// side to the other instead, so the picture slides inside a canvas that
// keeps its size (and a lit chip stays lit). `start` is the padding when
// the drag began, dx/dy the drag in source pixels.
export function slidePadding(start, dx, dy, { x = false, y = false } = {}) {
  const pads = paddingOf(start);
  const out = { pad_left: pads.left, pad_top: pads.top, pad_right: pads.right, pad_bottom: pads.bottom };
  if (x) {
    const total = pads.left + pads.right;
    out.pad_left = Math.round(clamp(pads.left + dx, 0, total));
    out.pad_right = total - out.pad_left;
  }
  if (y) {
    const total = pads.top + pads.bottom;
    out.pad_top = Math.round(clamp(pads.top + dy, 0, total));
    out.pad_bottom = total - out.pad_top;
  }
  return out;
}

// --- Source changes -----------------------------------------------------------
// A new source keeps the canvas style (fill, feather, canvas multiple) and
// whatever a lit format chip asked for: those describe the job, not the old
// pixels. Only what was measured against the old source goes back to
// identity: rotation, crop, padding - and the playhead when asked.
export const SOURCE_GEOMETRY_KEYS = Object.freeze([
  "rotation_degrees", "crop_aspect_ratio", "crop_x", "crop_y", "crop_width", "crop_height",
  "pad_left", "pad_top", "pad_right", "pad_bottom",
]);

export function sourceResetValues(includeTimeline = false) {
  const defaults = resetTransformValues(includeTimeline);
  const keys = includeTimeline ? [...SOURCE_GEOMETRY_KEYS, "seek_mode", "frame_index", "frame_time"] : [...SOURCE_GEOMETRY_KEYS];
  return Object.fromEntries(keys.map((name) => [name, defaults[name]]));
}

// --- Reset crop under the padlock ---------------------------------------------
// The padding that holds `ratio` around `crop` in the smallest canvas: what
// Reset crop leaves when the lock is on, so the bands the lock added while
// the crop was trimmed go again instead of making the canvas taller.
export function tightLockPadding(values, crop, ratio) {
  const options = [lockPadding(values, crop, ratio, "x"), lockPadding(values, crop, ratio, "y")].filter(Boolean);
  if (!options.length) return null;
  const area = (pads) => (crop.width + pads.pad_left + pads.pad_right) * (crop.height + pads.pad_top + pads.pad_bottom);
  return options.reduce((best, next) => (area(next) < area(best) ? next : best));
}

// --- Dragging the picture ----------------------------------------------------
// Which ways a drag inside the picture can go. Where the crop is smaller
// than the picture, the crop box moves over it; where the crop spans the
// whole picture, the picture slides inside its padding and needs padding on
// the side it moves toward.
export function moveRoom(crop, source, values) {
  const pads = paddingOf(values);
  const spanX = crop.width >= source.width;
  const spanY = crop.height >= source.height;
  return {
    left: spanX ? pads.left > 0 : crop.x > 0,
    right: spanX ? pads.right > 0 : crop.x + crop.width < source.width,
    up: spanY ? pads.top > 0 : crop.y > 0,
    down: spanY ? pads.bottom > 0 : crop.y + crop.height < source.height,
  };
}

// The cursor for a press inside the picture: the move cross only when it
// can go both ways, an axis arrow when it can only go along one, and the
// plain pointer when it cannot move at all.
export function moveCursor(room) {
  const across = Boolean(room?.left || room?.right);
  const upDown = Boolean(room?.up || room?.down);
  if (across && upDown) return "move";
  if (across) return "ew-resize";
  if (upDown) return "ns-resize";
  return "default";
}

// --- The rotate knob ----------------------------------------------------------
// The knob sits past the picture's top-right corner, along the line from
// the picture's centre through that corner. On a wide canvas that spot can
// land on the top padding diamond (a narrow picture centred in a wide
// canvas has that corner right under it), and the nearer handle then wins
// every press. So the knob tries a longer arm, then swings around the
// corner, until it clears every other handle and stays on the stage. Where
// the canvas corner is the picture's own, its corner handle sits right on
// that spot; the knob then takes the free gap on the handle ring nearest it
// (`gaps`, from paddingRingGaps).
export const KNOB_CLEARANCE = { padding: 36, crop: 26 };

export function placeKnob(corner, center, arm, obstacles = [], bounds = null, gaps = []) {
  const base = Math.atan2(corner.y - center.y, corner.x - center.x) || -Math.PI / 4;
  const at = (length, turn) => {
    const angle = base + (turn * Math.PI) / 180;
    return { x: corner.x + Math.cos(angle) * length, y: corner.y + Math.sin(angle) * length };
  };
  const clear = (point) => {
    if (bounds && (point.x < bounds.x + 14 || point.y < bounds.y + 14 || point.x > bounds.x + bounds.width - 14 || point.y > bounds.y + bounds.height - 14)) return false;
    return obstacles.every((item) => Math.hypot(point.x - item.x, point.y - item.y) >= (item.clearance ?? KNOB_CLEARANCE.padding));
  };
  for (const extra of [0, 16, 32]) {
    for (const turn of [0, -25, 25, -50, 50, -75, 75]) {
      const point = at(arm + extra, turn);
      if (clear(point)) return point;
    }
  }
  const usual = at(arm, 0);
  const away = (point) => Math.hypot(point.x - usual.x, point.y - usual.y);
  const gap = [...gaps].sort((a, b) => away(a) - away(b)).find(clear);
  return gap ? { x: gap.x, y: gap.y } : usual;
}

// Where the knob sits on its arm, as a length and a turn from the line
// through the picture's centre and corner, and back. While you turn the
// picture the knob keeps this offset, so it turns with the picture instead
// of jumping to another spot under the pointer.
export function knobOffset(corner, center, knob) {
  const base = Math.atan2(corner.y - center.y, corner.x - center.x) || -Math.PI / 4;
  return { length: Math.hypot(knob.x - corner.x, knob.y - corner.y), turn: Math.atan2(knob.y - corner.y, knob.x - corner.x) - base };
}

export function knobAt(corner, center, offset) {
  const base = Math.atan2(corner.y - center.y, corner.x - center.x) || -Math.PI / 4;
  return { x: corner.x + Math.cos(base + offset.turn) * offset.length, y: corner.y + Math.sin(base + offset.turn) * offset.length };
}

// --- Turning the knob -----------------------------------------------------------
// The knob is followed move by move, each step taken the short way round.
// Straight left of the picture's centre the pointer's angle flips from +180
// to -180 degrees; measured from where the drag began, crossing that line
// read as a whole turn back, and the clamp at +-180 then held the picture
// upside down. Step by step it is a step of a few degrees, and the rotation
// wraps instead of stopping: past 180 it carries on from -180, so the
// picture always turns on, either way.
export function knobStep(fromAngle, toAngle) {
  const step = (Number(toAngle) || 0) - (Number(fromAngle) || 0);
  const turn = 2 * Math.PI;
  return ((((step + Math.PI) % turn) + turn) % turn) - Math.PI;
}

// A rotation in -180..180: anything past either end comes round from the
// other. Values inside the range, both ends included, stay as they are.
export function wrapDegrees(degrees) {
  const value = Number(degrees) || 0;
  if (value <= 180 && value >= -180) return value;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

// --- Rounding to the resize step ----------------------------------------------
// The resize rounds each side to the step on its own, which can stretch the
// picture a little. The largest smaller step that keeps the stretch under
// the warning, for the tooltip to name, or null.
export function stepWithoutStretch(values, source, resize) {
  if (!resize) return null;
  const current = Math.max(1, Math.round(Number(resize.steps) || 1));
  for (const step of [64, 32, 16, 8, 4, 2, 1]) {
    if (step >= current) continue;
    const chain = sizeChain(values, source, { ...resize, steps: step });
    if (Math.abs(chain.stretch) <= STRETCH_WARNING) return step;
  }
  return null;
}

// Pad mode's way out of that stretch: widen the padding on the axis that
// comes up short, split evenly, until the canvas has the shape the rounded
// size has. Every pixel stays; the model paints a few more of fill. Null
// when there is no stretch to take out or it cannot be reached.
export function evenOutPadding(values, source, resize) {
  if (!resize) return null;
  const start = sizeChain(values, source, resize);
  if (Math.abs(start.stretch) <= STRETCH_WARNING) return null;
  let pads = { ...paddingOf(values) };
  for (let pass = 0; pass < 6; pass += 1) {
    const now = sizeChain({ ...values, pad_left: pads.left, pad_top: pads.top, pad_right: pads.right, pad_bottom: pads.bottom }, source, resize);
    if (Math.abs(now.stretch) <= 0.002) break;
    const target = now.resized.width / now.resized.height;
    const width = now.padded.width;
    const height = now.padded.height;
    if (width / height < target) {
      const pair = splitDelta(Math.max(1, Math.round(height * target) - width), pads.left, pads.right);
      if (!pair) return null;
      [pads.left, pads.right] = pair;
    } else {
      const pair = splitDelta(Math.max(1, Math.round(width / target) - height), pads.top, pads.bottom);
      if (!pair) return null;
      [pads.top, pads.bottom] = pair;
    }
  }
  const out = { pad_left: pads.left, pad_top: pads.top, pad_right: pads.right, pad_bottom: pads.bottom };
  const done = sizeChain({ ...values, ...out }, source, resize);
  return Math.abs(done.stretch) < Math.abs(start.stretch) && Math.abs(done.stretch) <= STRETCH_WARNING ? out : null;
}

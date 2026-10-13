// The stitch mask math, mirrored from the backend so the editor's Show
// blend overlay is the paste mask the stitcher will actually use - not a
// sketch of it. Pure Float32Array functions on a row-major mask (1 =
// generated), testable under node:test against a fixture the Python
// helpers produced (tests/fixtures/stitch_blend_parity.json). The
// see-through rule (seeThroughMap) is mirrored too.
//
// Mirrors nodes/_mask_helpers.py grow_shrink_mask (square max filter,
// separable, -inf padding) and blur_mask (gaussian, radius ceil(3 sigma),
// replicate padding), and nodes/_inpaint_crop_helpers.py
// stitch_blend_from_mask (signed grow, then grow by blend and blur by
// blend / 3).

// Sliding window max/min over one line, window 2r+1, missing samples ignored
// (that is the -inf padding of a max pool). Monotonic deque: O(n) per line.
function slidingExtreme(line, out, r, useMax) {
  const n = line.length;
  const deque = new Int32Array(n);
  let head = 0, tail = 0;
  const better = useMax ? (a, b) => a >= b : (a, b) => a <= b;
  for (let i = 0; i < n + r; i++) {
    if (i < n) {
      while (tail > head && better(line[i], line[deque[tail - 1]])) tail--;
      deque[tail++] = i;
    }
    const center = i - r;
    if (center >= 0) {
      while (deque[head] < center - r) head++;
      out[center] = line[deque[head]];
    }
  }
}

export function growShrinkMask(values, width, height, pixels) {
  const steps = Math.abs(Math.round(pixels));
  if (!steps) return Float32Array.from(values);
  const useMax = pixels > 0;
  const pass = new Float32Array(values.length);
  const row = new Float32Array(width), rowOut = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    row.set(values.subarray(y * width, (y + 1) * width));
    slidingExtreme(row, rowOut, steps, useMax);
    pass.set(rowOut, y * width);
  }
  const out = new Float32Array(values.length);
  const col = new Float32Array(height), colOut = new Float32Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = pass[y * width + x];
    slidingExtreme(col, colOut, steps, useMax);
    for (let y = 0; y < height; y++) out[y * width + x] = colOut[y];
  }
  return out;
}

export function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = v; sum += v; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

export function blurMask(values, width, height, sigma) {
  if (!(sigma > 0)) return Float32Array.from(values);
  const { kernel, radius } = gaussianKernel(sigma);
  const pass = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k)); // replicate padding
        acc += values[base + sx] * kernel[k + radius];
      }
      pass[base + x] = acc;
    }
  }
  const out = new Float32Array(values.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += pass[sy * width + x] * kernel[k + radius];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

function clamp01(values) {
  for (let i = 0; i < values.length; i++) values[i] = values[i] < 0 ? 0 : values[i] > 1 ? 1 : values[i];
  return values;
}

// stitch_blend_from_mask: signed grow first, then the blend ramp - grown
// by `blend` and blurred with sigma blend / 3 - clamped to 0..1.
export function stitchBlendFromMask(values, width, height, blendPixels, growPixels = 0) {
  const grow = Math.round(growPixels) || 0;
  const ramp = Math.max(0, Math.round(blendPixels) || 0);
  let out = values;
  if (grow) out = growShrinkMask(out, width, height, grow);
  if (ramp > 0) { out = growShrinkMask(out, width, height, ramp); out = blurMask(out, width, height, ramp / 3); }
  return (grow || ramp) ? clamp01(out) : Float32Array.from(values);
}

// The transform's own mask feather (transform_pil): the generated-area
// mask blurred, doubled and clipped, then max'd with the original - the
// ramp starts at full strength on the edge and runs into the kept pixels.
export function featherGeneratedMask(values, width, height, featherPixels) {
  if (!(featherPixels > 0)) return Float32Array.from(values);
  const blurred = blurMask(values, width, height, featherPixels);
  const out = new Float32Array(values.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(values[i], Math.min(1, blurred[i] * 2));
  return out;
}

// The parts of a picture the run paints like its padding: a pixel less than
// SEE_THROUGH_KEEP_PERCENT as solid as the picture's most solid one (see
// see_through_kept in nodes/_transform_engine.py). A mask drawn in the
// MaskEditor is saved exactly that way, as the picture with its alpha
// cleared where you painted. Takes RGBA bytes and returns a map, 1 where
// see-through, or null for a picture at least that solid everywhere, which
// the run leaves exactly as it is.
export const SEE_THROUGH_KEEP_PERCENT = 90;

export function seeThroughMap(rgba) {
  let low = 255, top = 0;
  for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] < low) low = rgba[i]; if (rgba[i] > top) top = rgba[i]; }
  if (low * 100 >= 255 * SEE_THROUGH_KEEP_PERCENT) return null;
  const map = new Uint8Array(rgba.length >> 2);
  // A picture with no solid pixel at all is see-through everywhere.
  for (let i = 0; i < map.length; i++) map[i] = !top || rgba[i * 4 + 3] * 100 < top * SEE_THROUGH_KEEP_PERCENT ? 1 : 0;
  return map;
}

// Work-resolution planning for the overlay. Blend and grow are output
// pixels AFTER any resize; the stage draws the pre-resize canvas. One
// output pixel is `unit` work pixels (the two axes can differ by a step
// rounding; the mean keeps the ramp within a percent of either).
export function overlayPlan(outputWidth, outputHeight, target, maxSide = 384) {
  const k = Math.min(1, maxSide / Math.max(1, outputWidth, outputHeight));
  const width = Math.max(1, Math.round(outputWidth * k));
  const height = Math.max(1, Math.round(outputHeight * k));
  const targetWidth = target?.width || outputWidth;
  const targetHeight = target?.height || outputHeight;
  const unit = k * ((outputWidth / targetWidth) + (outputHeight / targetHeight)) / 2;
  return { k, width, height, unit };
}

// The part of a convex polygon on one side of an axis-aligned line: where
// the coordinate (axis 0 = x, 1 = y) is at least `limit`, or at most. A
// corner the cut makes gets `limit` itself as that coordinate, not a sum
// that could land a hair beside it, so "on the line" stays an exact test.
function cutPolygon(points, axis, limit, atLeast) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const keepA = atLeast ? a[axis] >= limit : a[axis] <= limit;
    const keepB = atLeast ? b[axis] >= limit : b[axis] <= limit;
    if (keepA) out.push(a);
    if (keepA !== keepB) {
      const t = (limit - a[axis]) / (b[axis] - a[axis]);
      const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      point[axis] = limit;
      out.push(point);
    }
  }
  return out;
}

function polygonArea(points) {
  let twice = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    twice += (points[i][0] - points[0][0]) * (points[i + 1][1] - points[0][1])
      - (points[i + 1][0] - points[0][0]) * (points[i][1] - points[0][1]);
  }
  return Math.abs(twice) / 2;
}

// The transform's generated area on the overlay's work raster: 1 where the
// run paints (the padding, the corners a rotation leaves empty), 0 on the
// picture, and in a cell the picture's edge crosses, the share of that cell
// outside the picture. See-through parts of the picture are not in it; the
// editor adds them from the picture itself.
//
// The raster is the whole output canvas, each axis by its own scale, so an
// edge of the picture that is on the canvas edge is on the raster's edge and
// every cell along it is exactly 0. One scale for both axes left a part row
// there: 921 canvas rows at 384 / 1916 are 184.58 raster rows, the last of
// the 185 read as part generated, and the blend grew that into a ramp along
// an edge nobody padded. The area is worked out here and not drawn with a
// 2D canvas, whose soft edges differ between browsers and are not exact
// where two edges meet. tests/fixtures/show_blend_canvas.json holds the
// run's own blend for a few settings, and the preview is tested against it.
//
// `source` is the rotated source's size, `crop` the box kept from it and
// `padding` the resolved padding with the output size (transform_geometry),
// `sourceWidth` x `sourceHeight` the picture before the turn, `rotation`
// in degrees, clockwise.
export function generatedAreaMask(width, height, { source, crop, padding, sourceWidth, sourceHeight, rotation = 0 }) {
  const mask = new Float32Array(width * height).fill(1);
  // Multiply before dividing: the canvas's far edge then lands on the
  // raster's far edge exactly.
  const toX = (x) => x * width / padding.outputWidth;
  const toY = (y) => y * height / padding.outputHeight;
  // The turned picture's corners on the canvas. Cosine and sine are rounded
  // as rotatedSize rounds them, so a quarter turn keeps whole-pixel corners.
  const radians = (Number(rotation) || 0) * Math.PI / 180;
  const round15 = (value) => Math.round(value * 1e15) / 1e15;
  const cosine = round15(Math.cos(radians)), sine = round15(Math.sin(radians));
  const centerX = padding.left - crop.x + source.width / 2;
  const centerY = padding.top - crop.y + source.height / 2;
  let picture = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([signX, signY]) => {
    const x = signX * sourceWidth / 2, y = signY * sourceHeight / 2;
    return [toX(centerX + x * cosine - y * sine), toY(centerY + x * sine + y * cosine)];
  });
  // Only what the crop keeps reaches the canvas.
  picture = cutPolygon(picture, 0, toX(padding.left), true);
  picture = cutPolygon(picture, 0, toX(padding.left + crop.width), false);
  picture = cutPolygon(picture, 1, toY(padding.top), true);
  picture = cutPolygon(picture, 1, toY(padding.top + crop.height), false);
  if (picture.length < 3) return mask;
  let first = Infinity, last = -Infinity;
  for (const [, y] of picture) { first = Math.min(first, y); last = Math.max(last, y); }
  for (let row = Math.max(0, Math.floor(first)); row < Math.min(height, Math.ceil(last)); row++) {
    const strip = cutPolygon(cutPolygon(picture, 1, row, true), 1, row + 1, false);
    if (strip.length < 3) continue;
    // Where the picture meets the top and the bottom line of this row. A
    // cell between both spans has all four corners in the picture, so it is
    // picture all through; the cells beside them get their share measured.
    let from = Infinity, to = -Infinity, topFrom = Infinity, topTo = -Infinity, bottomFrom = Infinity, bottomTo = -Infinity;
    for (const [x, y] of strip) {
      from = Math.min(from, x); to = Math.max(to, x);
      if (y === row) { topFrom = Math.min(topFrom, x); topTo = Math.max(topTo, x); }
      if (y === row + 1) { bottomFrom = Math.min(bottomFrom, x); bottomTo = Math.max(bottomTo, x); }
    }
    const wholeFrom = Math.ceil(Math.max(topFrom, bottomFrom)), wholeTo = Math.floor(Math.min(topTo, bottomTo));
    for (let column = Math.max(0, Math.floor(from)); column < Math.min(width, Math.ceil(to)); column++) {
      const whole = column >= wholeFrom && column < wholeTo;
      const share = whole ? 1 : Math.min(1, polygonArea(cutPolygon(cutPolygon(strip, 0, column, true), 0, column + 1, false)));
      mask[row * width + column] = 1 - share;
    }
  }
  return mask;
}

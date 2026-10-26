// Frame arithmetic for the video timeline (playhead, IN/OUT, kept frames).
//
// The backend keeps a frame when its presentation time t satisfies
// start - EPS <= t <= end - EPS (nodes/_video_load_helpers.decode_video_range,
// end 0 meaning the source's end), then thins by every_nth, caps at
// max_frames and snaps the count. Everything here mirrors those rules, so
// the frame the timeline shows for IN is the first frame a run keeps, the
// frame it shows for OUT is the last one, and a drag writes seconds that
// round-trip to the same frames. No DOM, no ComfyUI imports: tested in
// tests/timeline_math.test.mjs.

import { snapFrameCount } from "../load_video/trim_preview.mjs?v=2026102571";

// nodes/_video_load_helpers._TIME_EPSILON
export const TRIM_EPSILON = 1e-4;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// The counts the rail works in. A source that declares no frame count is
// estimated from its duration, matching nodes/_media_helpers.video_metadata.
export function clipInfo(metadata) {
  const fps = finite(metadata?.fps) > 0 ? finite(metadata.fps) : 0;
  const duration = finite(metadata?.duration) > 0 ? finite(metadata.duration) : 0;
  let count = Math.floor(finite(metadata?.frame_count));
  if (count <= 0 && fps > 0 && duration > 0) count = Math.max(1, Math.round(duration * fps));
  return { fps, duration, count: Math.max(0, count) };
}

export function clampFrame(index, info) {
  if (!info?.count) return 0;
  return clamp(Math.round(finite(index)), 0, info.count - 1);
}

export function frameTime(index, info) {
  return info?.fps > 0 ? clampFrame(index, info) / info.fps : 0;
}

// First and last kept frame for a start/end pair in seconds - the frames
// the backend's inclusion rule selects.
export function frameWindow(info, startSeconds, endSeconds) {
  const { fps, count } = info;
  if (!count || !fps) return { first: 0, last: Math.max(0, count - 1) };
  const start = Math.max(0, finite(startSeconds));
  const end = finite(endSeconds) > 0 ? finite(endSeconds) : 0;
  const first = clamp(Math.ceil((start - TRIM_EPSILON) * fps), 0, count - 1);
  const last = end > 0 ? clamp(Math.floor((end - TRIM_EPSILON) * fps), first, count - 1) : count - 1;
  return { first, last };
}

// The seconds to store for a first/last frame pair. The frontend rounds
// these FLOAT widgets to hundredths (their step), so the values are chosen
// on that grid: IN is the largest hundredth that still keeps `first`, OUT
// the smallest that still keeps `last` and drops the frame after it. Both
// resolve back to the same frames under the backend's rule, and a window
// that reaches the source's end stores 0 so the whole tail always stays in.
export const SECONDS_GRID = 0.01;

function gridFloor(value) { return Math.round(Math.floor(value / SECONDS_GRID + 1e-9) * SECONDS_GRID * 1e6) / 1e6; }
function gridCeil(value) { return Math.round(Math.ceil(value / SECONDS_GRID - 1e-9) * SECONDS_GRID * 1e6) / 1e6; }

export function windowSeconds(info, first, last) {
  const { fps, count } = info;
  if (!fps || !count) return { start_seconds: 0, end_seconds: 0 };
  const head = clamp(Math.round(finite(first)), 0, count - 1);
  const tail = clamp(Math.round(finite(last)), head, count - 1);
  return {
    start_seconds: head === 0 ? 0 : Math.max(0, gridFloor(head / fps + TRIM_EPSILON)),
    end_seconds: tail >= count - 1 ? 0 : gridCeil(tail / fps + TRIM_EPSILON),
  };
}

// The rail spans frames 0..count-1 as equal cells. A frame's cell starts at
// index/count; the boundary after the last frame is at 1.
export function frameAtFraction(fraction, info) {
  if (!info?.count) return 0;
  return clamp(Math.floor(clamp(finite(fraction), 0, 1) * info.count), 0, info.count - 1);
}

// Boundaries sit between cells (0..count): what IN/OUT handles snap to.
export function boundaryAtFraction(fraction, info) {
  if (!info?.count) return 0;
  return clamp(Math.round(clamp(finite(fraction), 0, 1) * info.count), 0, info.count);
}

export function fractionOfFrame(index, info, edge = "start") {
  if (!info?.count) return 0;
  const offset = edge === "end" ? 1 : edge === "center" ? 0.5 : 0;
  return clamp((clampFrame(index, info) + offset) / info.count, 0, 1);
}

// Move one trim edge to a boundary. IN can climb to OUT's frame and OUT can
// drop to IN's, so a one-frame window is the floor.
export function dragTrimBoundary(window, edge, boundary, info) {
  if (!info?.count) return { first: 0, last: 0 };
  const point = clamp(Math.round(finite(boundary)), 0, info.count);
  let { first, last } = window;
  if (edge === "start") first = clamp(point, 0, last);
  else last = clamp(point - 1, first, info.count - 1);
  return { first, last };
}

// Move one trim edge to a frame (typed or stepped values).
export function setTrimFrame(window, edge, index, info) {
  if (!info?.count) return { first: 0, last: 0 };
  const frame = clampFrame(index, info);
  let { first, last } = window;
  if (edge === "start") first = Math.min(frame, last);
  else last = Math.max(frame, first);
  return { first, last };
}

// Fixed length is measured at OUTPUT fps, but the handles sit on source frames.
// Keep the requested count exact: an oversized request is invalid, not truncated.
export function fixedFrameWindow(info, first, frames, outputFps) {
  if (frames === null) return { unresolved: true };
  const count = Math.max(0, Math.trunc(finite(frames)));
  if (!count) return null;
  if (!(outputFps > 0) || !(info?.fps > 0) || !info.count) return { frames: count, unresolved: true };
  const seconds = count / outputFps;
  const duration = info.duration || info.count / info.fps;
  const tooLong = seconds > duration + 1e-7;
  const span = Math.max(1, Math.ceil(seconds * info.fps - 1e-7));
  const latest = Math.max(0, Math.floor((duration - seconds) * info.fps + 1e-7));
  const head = clamp(Math.round(finite(first)), 0, Math.min(latest, Math.max(0, info.count - span)));
  return { first: head, last: Math.min(info.count - 1, head + span - 1), frames: count, seconds, tooLong };
}

// What a run keeps out of the window after thinning, the cap and the snap
// rule (the backend's decode_video_range + snap_frame_count), and the index
// of the last frame that actually reaches the output.
export function keptFrames(window, everyNth = 1, maxFrames = 0, frameSnap = "free") {
  const nth = Math.max(1, Math.floor(finite(everyNth, 1)) || 1);
  const cap = Math.max(0, Math.floor(finite(maxFrames)));
  const span = Math.max(0, window.last - window.first + 1);
  let frames = Math.ceil(span / nth);
  if (cap > 0) frames = Math.min(frames, cap);
  frames = snapFrameCount(frames, frameSnap);
  return {
    frames,
    total: span,
    nth,
    lastKept: frames > 0 ? window.first + (frames - 1) * nth : window.first,
    cut: frames < span,
  };
}

// Where the frame after the last kept one begins, as a rail fraction: the
// end of the bright part of the span.
export function keptEndFraction(window, kept, info) {
  return fractionOfFrame(kept.lastKept, info, "end");
}

// --- One way to set the length ---------------------------------------------
// The clip node's face sets how long the output is in exactly one of these
// ways, and the rail only offers the one in charge:
//   "free"   IN -> OUT: the OUT handle ends the clip.
//   "length" Length on: a frame count from IN, stored as max_frames with an
//            open end, so OUT follows IN and the count survives a new source.
//   "fixed"  a fixed_frames value saved by an older face: an exact window.
//            The first edit turns it into a Length.
//   "wired"  a connected fixed_frames, frame_load_cap or max_frames input
//            decides the length; only IN is left to set.
export function lengthMode({ maxFrames = 0, fixedFrames = 0, wired = null } = {}) {
  if (wired) return "wired";
  if (Math.trunc(finite(fixedFrames)) > 0) return "fixed";
  if (Math.trunc(finite(maxFrames)) > 0) return "length";
  return "free";
}

// The n in a "<n>n+1" snap rule (8 for LTX, 4 for Wan); 1 for free.
export function snapStep(rule) {
  const match = /^\s*(\d+)\s*n\s*\+\s*1\s*$/i.exec(String(rule ?? ""));
  const step = match ? Number(match[1]) : 1;
  return step > 0 ? step : 1;
}

// A count the snap rule keeps (step * n + 1, at least 1). Direction 0 takes
// the nearest, 1 the next at or above, -1 the next at or below - so a stepper
// arrow always moves to a new valid count instead of rounding back.
export function snapToValid(count, rule, direction = 0) {
  const step = snapStep(rule);
  const value = Math.max(1, Math.round(finite(count, 1)));
  if (step <= 1) return value;
  const below = Math.floor((value - 1) / step) * step + 1;
  const above = below === value ? value : below + step;
  if (direction > 0) return above;
  if (direction < 0) return below;
  return value - below <= above - value ? below : above;
}

// How many frames a run outputs from `first` through source frame `target`:
// one in every nth, then the snap rule (never below one frame).
export function framesThrough(first, target, everyNth = 1, frameSnap = "free") {
  const nth = Math.max(1, Math.floor(finite(everyNth, 1)) || 1);
  const span = Math.max(1, Math.round(finite(target)) - Math.round(finite(first)) + 1);
  return Math.max(1, snapFrameCount(Math.ceil(span / nth), frameSnap));
}

// The source frame the last of `frames` output frames from `first` sits on.
export function lastFrameFor(first, frames, everyNth = 1) {
  const nth = Math.max(1, Math.floor(finite(everyNth, 1)) || 1);
  return Math.round(finite(first)) + (Math.max(1, Math.trunc(finite(frames, 1))) - 1) * nth;
}

// The latest IN that still fits a Length of `frames` inside the source, so
// dragging a locked window to the end stops there instead of shortening it.
export function latestFirstFor(info, frames, everyNth = 1) {
  if (!info?.count) return 0;
  return Math.max(0, info.count - 1 - (lastFrameFor(0, frames, everyNth)));
}

// Everything the rail draws for the clip node, from the stored values:
//   mode        which way sets the length (lengthMode)
//   first       IN, the first source frame the run keeps
//   last        the source frame OUT sits on - the last one the run keeps -
//               or null when only the run can tell (a computed input)
//   windowLast  the stored window's end; frames between last and it are
//               kept by the window but dropped (every nth, the snap rule)
//   frames      output frames, or null when unknown
//   requested   the Length (or the wired count) asked for
//   truncated   the source ends before the Length is reached
//   tooLong     a fixed window longer than the source (the run refuses it)
// `values`: start and end seconds (linked frame bounds already converted),
// everyNth, frameSnap, maxFrames, fixedFrames, wired (the name of a length
// input that is connected, or null), wiredFrames (its value when it can be
// read), outputFps (the output rate, null when only the run knows it) and
// resampled (a connected force_rate: source frames no longer count output
// frames one for one, so only an exact window can still be placed).
export function clipLengthPlan(info, values = {}) {
  const nth = Math.max(1, Math.floor(finite(values.everyNth, 1)) || 1);
  const snap = values.frameSnap ?? "free";
  const window = frameWindow(info, values.start, values.end);
  const mode = lengthMode(values);
  const base = { mode, first: window.first, last: null, windowLast: window.last, frames: null, requested: null, truncated: false, tooLong: false };
  if (!info?.count) return { ...base, last: 0, windowLast: 0 };
  const exact = (frames) => {
    const fixed = fixedFrameWindow(info, window.first, frames, values.outputFps === undefined ? info.fps / nth : values.outputFps);
    if (!fixed || fixed.unresolved) return { ...base, requested: frames };
    return { ...base, first: fixed.first, last: fixed.last, windowLast: fixed.last, frames: fixed.frames, requested: frames, tooLong: fixed.tooLong };
  };
  const capped = (cap) => {
    const requested = cap > 0 ? snapFrameCount(cap, snap) : null;
    if (values.resampled) return { ...base, last: cap > 0 ? null : window.last, requested };
    const kept = keptFrames(window, nth, cap, snap);
    return { ...base, last: kept.lastKept, frames: kept.frames, requested, truncated: requested != null && kept.frames < requested };
  };
  const stored = Math.max(0, Math.trunc(finite(values.maxFrames)));
  if (mode === "fixed") return exact(Math.trunc(finite(values.fixedFrames)));
  if (mode === "wired") {
    if (values.wiredFrames == null) return base;
    const frames = Math.max(0, Math.trunc(finite(values.wiredFrames)));
    if (values.wired === "fixed_frames") return frames > 0 ? exact(frames) : capped(stored);
    return capped(frames);
  }
  return capped(mode === "length" ? stored : 0);
}

// Playback rate for a label, trimmed of float noise: 24 -> "24",
// 23.976023... -> "23.976".
export function formatFps(value) {
  const fps = finite(value);
  return fps > 0 ? String(Number(fps.toFixed(3))) : "0";
}

// The keyboard step for a trim handle: one second of frames, or a single
// frame with Shift held (the fine step, as everywhere in the pack).
export function keyboardStep(info, fine) {
  if (fine || !(info?.fps > 0)) return 1;
  return Math.max(1, Math.round(info.fps));
}

// --- What a press on the rail does -----------------------------------------
// The rail always scrubs: a press anywhere moves the playhead, whatever the
// Length says, as in every video editor. Only three things take a press
// instead: the IN and OUT handles within `hitPx` screen pixels (the nearer
// one; handles stacked on one spot split by side, left of them is IN) and
// the grip on the kept part, which slides the clip.
export function railZone({ x, inX, outX, hasOut = true, hitPx = 9, onGrip = false } = {}) {
  if (onGrip) return "grip";
  const toIn = Math.abs(finite(x) - finite(inX));
  const toOut = hasOut ? Math.abs(finite(x) - finite(outX)) : Infinity;
  if (Math.min(toIn, toOut) > hitPx) return "playhead";
  return toIn < toOut || (toIn === toOut && finite(x) <= finite(inX)) ? "start" : "end";
}

// The first frame a slide can move the kept part to, and the last one:
// a Length keeps its count and stops where OUT meets the source's end; a
// free window keeps its span.
export function slideRange(info, plan, everyNth = 1) {
  if (!info?.count || !plan) return { min: 0, max: 0 };
  if (plan.mode === "free") {
    const span = Math.max(0, finite(plan.windowLast) - finite(plan.first));
    return { min: 0, max: Math.max(0, info.count - 1 - span) };
  }
  if (plan.mode === "length" || plan.mode === "fixed") {
    const frames = plan.requested ?? plan.frames ?? 1;
    const latest = plan.mode === "fixed" ? Math.max(0, info.count - 1 - (finite(plan.last) - finite(plan.first))) : latestFirstFor(info, frames, everyNth);
    return { min: 0, max: Math.max(0, latest) };
  }
  return { min: finite(plan.first), max: finite(plan.first) };
}

// True when a Length already takes the whole clip: IN sits on the first
// frame and has nowhere to go. The face then says so instead of freezing.
export function lengthFillsClip(info, plan, everyNth = 1) {
  if (!info?.count || !plan || (plan.mode !== "length" && plan.mode !== "fixed")) return false;
  return plan.first === 0 && slideRange(info, plan, everyNth).max === 0;
}

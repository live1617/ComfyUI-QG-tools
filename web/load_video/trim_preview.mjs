import { clamp, finiteNumber } from "../shared/video_preview.mjs?v=2026102915";

export { responsivePreviewHeight } from "../shared/video_preview.mjs?v=2026102915";

export const MIN_TRIM_SECONDS = 0.1;

export function trimBounds(durationValue, startValue, endValue) {
  const rawDuration = finiteNumber(durationValue, 0);
  const duration = rawDuration > 0 ? rawDuration : Number.POSITIVE_INFINITY;
  let start = Math.max(0, finiteNumber(startValue, 0));
  if (Number.isFinite(duration)) start = Math.min(start, duration);

  const requestedEnd = finiteNumber(endValue, 0);
  let end = requestedEnd > 0 ? requestedEnd : duration;
  if (Number.isFinite(duration)) end = Math.min(end, duration);
  end = Math.max(start, end);
  return { start, end };
}

export function trimFractions(durationValue, bounds) {
  const duration = Math.max(0, finiteNumber(durationValue, 0));
  if (duration <= 0) return { start: 0, end: 1 };
  return {
    start: clamp(finiteNumber(bounds?.start, 0) / duration, 0, 1),
    end: clamp(finiteNumber(bounds?.end, duration) / duration, 0, 1),
  };
}

export function closestTrimHandle(
  startFraction,
  endFraction,
  pointerFraction,
  trackWidthValue,
  hitPixels = 10,
) {
  const trackWidth = Math.max(0, finiteNumber(trackWidthValue, 0));
  if (trackWidth <= 0) return null;
  const pointer = clamp(finiteNumber(pointerFraction, 0), 0, 1) * trackWidth;
  const startDistance = Math.abs(pointer - clamp(finiteNumber(startFraction, 0), 0, 1) * trackWidth);
  const endDistance = Math.abs(pointer - clamp(finiteNumber(endFraction, 1), 0, 1) * trackWidth);
  if (Math.min(startDistance, endDistance) > Math.max(0, finiteNumber(hitPixels, 0))) return null;
  return startDistance <= endDistance ? "start" : "end";
}

export function dragTrimHandle(
  durationValue,
  bounds,
  handle,
  fractionValue,
  minimumWindow = MIN_TRIM_SECONDS,
) {
  const duration = Math.max(0, finiteNumber(durationValue, 0));
  if (duration <= 0) return { start: 0, end: 0 };
  const minimum = Math.min(duration, Math.max(0, finiteNumber(minimumWindow, 0)));
  const point = clamp(finiteNumber(fractionValue, 0), 0, 1) * duration;
  let start = clamp(finiteNumber(bounds?.start, 0), 0, duration);
  let end = clamp(finiteNumber(bounds?.end, duration), start, duration);
  if (handle === "start") start = Math.min(point, Math.max(0, end - minimum));
  else if (handle === "end") end = Math.max(point, Math.min(duration, start + minimum));
  return { start, end };
}

export function slideTrimWindow(durationValue, bounds, deltaValue) {
  const duration = Math.max(0, finiteNumber(durationValue, 0));
  const start = clamp(finiteNumber(bounds?.start, 0), 0, duration);
  const end = clamp(finiteNumber(bounds?.end, duration), start, duration);
  const length = end - start;
  const nextStart = clamp(start + finiteNumber(deltaValue, 0), 0, Math.max(0, duration - length));
  return { start: nextStart, end: nextStart + length };
}

// Single-frame mode: the chosen instant, kept just inside the source so the
// decoder always finds a frame at or after it. An unknown duration passes the
// value through, so a typed time survives until metadata arrives.
export function singleFrameTime(durationValue, timeValue) {
  const duration = Math.max(0, finiteNumber(durationValue, 0));
  const time = Math.max(0, finiteNumber(timeValue, 0));
  if (duration <= 0) return time;
  return Math.min(time, Math.max(0, duration - MIN_TRIM_SECONDS));
}

export function singleFrameFraction(durationValue, timeValue) {
  const duration = Math.max(0, finiteNumber(durationValue, 0));
  if (duration <= 0) return 0;
  return clamp(singleFrameTime(duration, timeValue) / duration, 0, 1);
}

// Leaving single-frame mode, the picked frame is IN. An OUT at or before it
// leaves no window, and the loader refuses a start that is not before the
// end, so OUT goes back to 0: the widget's own "to the end of the source".
// Returns the pair to write, or null when it already is a window.
export function trimAfterFramePick(startValue, endValue) {
  const start = Math.max(0, finiteNumber(startValue, 0));
  const end = finiteNumber(endValue, 0);
  return end > 0 && end <= start ? { start, end: 0 } : null;
}

// Playback rate for the label, trimmed of float noise: 24 -> "24",
// 12.5 -> "12.5", 23.976023... -> "23.976".
export function formatFps(value) {
  const fps = finiteNumber(value, 0);
  if (fps <= 0) return "0";
  return String(Number(fps.toFixed(3)));
}

// What one Run will actually load, as text for the label under the trim
// strip - or "" when there is nothing honest to say (unknown fps, an empty
// window). The preview cannot re-render frame drops, so it reports them
// instead, mirroring the backend's own arithmetic (decode_video_range):
// ceil(window x fps) frames in the trim, one kept in every_nth, capped by
// max_frames; single-frame mode always loads exactly one.
// Mirror of the clip node's snap_frame_count: the largest step*n + 1 not
// above count for a rule like "8n+1"; "free" keeps count.
export function snapFrameCount(count, rule = "free") {
  const frames = Math.max(0, Math.floor(finiteNumber(count, 0)));
  const text = String(rule ?? "free").trim().toLowerCase();
  if (!text.endsWith("n+1")) return frames;
  const step = Number(text.slice(0, -"n+1".length));
  if (!Number.isInteger(step) || step <= 0 || frames <= 1) return frames;
  return Math.floor((frames - 1) / step) * step + 1;
}

export function loadSummary(
  durationValue,
  bounds,
  sourceFpsValue,
  everyNthValue = 1,
  maxFramesValue = 0,
  singleFrame = false,
  frameSnap = "free",
) {
  if (singleFrame) return "1 frame";
  const duration = Math.max(0, finiteNumber(durationValue, 0));
  const fps = finiteNumber(sourceFpsValue, 0);
  if (duration <= 0 || fps <= 0) return "";
  const start = clamp(finiteNumber(bounds?.start, 0), 0, duration);
  const requestedEnd = finiteNumber(bounds?.end, duration);
  const end = clamp(requestedEnd > 0 ? requestedEnd : duration, 0, duration);
  if (end <= start) return "";
  const nth = Math.max(1, Math.floor(finiteNumber(everyNthValue, 1)));
  const cap = Math.max(0, Math.floor(finiteNumber(maxFramesValue, 0)));
  let frames = Math.ceil(Math.ceil((end - start) * fps) / nth);
  if (cap > 0) frames = Math.min(frames, cap);
  frames = snapFrameCount(frames, frameSnap);
  if (frames <= 0) return "";
  if (frames === 1) return "1 frame";
  return `${frames} frames @ ${formatFps(fps / nth)} fps`;
}

export function clampTrimSeek(timeValue, bounds, epsilon = 0.04) {
  const time = finiteNumber(timeValue, bounds.start);
  if (time < bounds.start) return bounds.start;
  if (Number.isFinite(bounds.end) && time >= bounds.end) {
    return Math.max(bounds.start, bounds.end - epsilon);
  }
  return time;
}

export function playbackBoundaryAction(timeValue, bounds, loopEnabled, epsilon = 0.04) {
  if (!Number.isFinite(bounds?.end) || bounds.end <= bounds.start) return "none";
  if (finiteNumber(timeValue, bounds.start) < bounds.end - epsilon) return "none";
  return loopEnabled ? "loop" : "stop";
}

export function shouldLoopTrim(timeValue, bounds, epsilon = 0.04) {
  return playbackBoundaryAction(timeValue, bounds, true, epsilon) === "loop";
}

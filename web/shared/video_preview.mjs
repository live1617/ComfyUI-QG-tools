const DEFAULT_WIDTH = 320;

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function formatTime(secondsValue, precision = 2) {
  const seconds = Math.max(0, finiteNumber(secondsValue, 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  const fixed = remainder.toFixed(precision);
  return `${minutes}:${remainder < 10 ? "0" : ""}${fixed}`;
}

export function responsivePreviewHeight(
  widthValue,
  minimum = 112,
  maximum = 420,
) {
  const width = Math.max(0, finiteNumber(widthValue, DEFAULT_WIDTH));
  const scaled = Math.round(Math.max(0, width - 12) * 9 / 16);
  return clamp(scaled, minimum, maximum);
}

export function splitMediaName(nameValue) {
  const raw = typeof nameValue === "string" ? nameValue : "";
  const annotated = raw.replace(/\s+\[(input|output|temp)\]\s*$/i, "");
  const normalized = annotated.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0
    ? { filename: normalized, subfolder: "" }
    : { filename: normalized.slice(slash + 1), subfolder: normalized.slice(0, slash) };
}

export function mediaViewQuery(metaValue, fallbackType = "output") {
  const meta = typeof metaValue === "string"
    ? { ...splitMediaName(metaValue), type: fallbackType }
    : (metaValue || {});
  return new URLSearchParams({
    filename: String(meta.filename || ""),
    subfolder: String(meta.subfolder || ""),
    type: String(meta.type || fallbackType),
    t: String(Date.now()),
  }).toString();
}

// Every file Save Video can save, by the tag that shows it. gif and webp are
// animated images, not video: a <video> element cannot play either, so the
// same saved file needs an <img> to preview at all. The two lists once sat
// in two files and only the first was asked whether a run had saved
// anything, so a saved gif or webp was never shown.
// tests/video_preview.test.mjs holds both to the formats the backend writes.
const VIDEO_FILE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
const STILL_IMAGE_FILE = /\.(gif|webp)$/i;

export function isStillImage(filename) {
  return typeof filename === "string" && STILL_IMAGE_FILE.test(filename);
}

export function findVideoMetadata(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.filename === "string" && (VIDEO_FILE.test(value.filename) || isStillImage(value.filename))) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoMetadata(item, seen);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findVideoMetadata(item, seen);
    if (found) return found;
  }
  return null;
}

export function mediaInfo(meta, video) {
  const width = finiteNumber(meta?.width, video?.videoWidth || 0);
  const height = finiteNumber(meta?.height, video?.videoHeight || 0);
  const fps = finiteNumber(meta?.fps ?? meta?.frame_rate, 0);
  const frames = finiteNumber(meta?.frame_count, 0);
  const duration = finiteNumber(meta?.duration, video?.duration || 0);
  const parts = [];
  if (width > 0 && height > 0) parts.push(`${Math.round(width)}×${Math.round(height)}`);
  if (fps > 0) parts.push(`${Math.round(fps * 100) / 100} fps`);
  if (frames > 0) parts.push(`${Math.round(frames)} frames`);
  if (duration > 0) parts.push(formatTime(duration, 1));
  return parts.join(" · ");
}

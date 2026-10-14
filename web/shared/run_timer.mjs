// Run Timer decision logic: a tiny stopwatch reducer and the display
// formats. No DOM, no ComfyUI imports; the entry file wires api events.

export const HISTORY_LIMIT = 5;

export function createTimer(history = []) {
  return {
    running: false,
    startedAt: null,
    elapsed: 0,
    outcome: null, // "done" | "error" | "interrupted" once a run has ended
    history: Array.isArray(history) ? history.filter(isSeconds).slice(0, HISTORY_LIMIT) : [],
  };
}

function isSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function startTimer(state, now) {
  return { ...state, running: true, startedAt: now, elapsed: 0, outcome: null };
}

export function tickTimer(state, now) {
  if (!state.running || state.startedAt === null) return state;
  return { ...state, elapsed: Math.max(0, (now - state.startedAt) / 1000) };
}

// Ends a run. Only a completed run joins the history: an interrupted or
// failed one has no meaning as a reference time, so it shows but is not kept.
export function stopTimer(state, now, outcome = "done") {
  if (!state.running) return { ...state, outcome };
  const elapsed = state.startedAt === null ? state.elapsed : Math.max(0, (now - state.startedAt) / 1000);
  const history = outcome === "done"
    ? [elapsed, ...state.history].slice(0, HISTORY_LIMIT)
    : state.history;
  return { ...state, running: false, startedAt: null, elapsed, outcome, history };
}

// "12.3 s" under a minute, "1:05.3" under an hour, "1:02:03" beyond.
export function formatElapsed(seconds) {
  if (!isSeconds(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  const tenths = Math.floor((seconds - whole) * 10);
  return `${minutes}:${String(rest).padStart(2, "0")}.${tenths}`;
}

// The small print under the big number: the previous runs, oldest last.
export function historyLine(history) {
  if (!history?.length) return "";
  return history.map(formatElapsed).join(" · ");
}

// The readout's glow is a blur, and a blur on the graph canvas is what
// dragged the whole frontend to ~17 fps (issue #77): Chrome sends every
// filtered draw through an offscreen layer the size of the entire canvas.
// So the blurred layer is painted into its own small canvas only when
// `key` changes, and every other frame gets that canvas back untouched.
export function cachedLayer(cache, key, width, height, paint, createCanvas) {
  if (cache.canvas && cache.key === key) return cache.canvas;
  const canvas = (cache.canvas ??= createCanvas());
  // Setting the size, even to the same value, also clears the bitmap and
  // resets the context's transform and state.
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  paint(canvas.getContext("2d"));
  cache.key = key;
  return canvas;
}

// Pixel density for that layer: the canvas's current scale rounded UP to a
// quarter octave, so a zoom gesture repaints it a handful of times rather
// than every frame, and capped so a deep zoom cannot allocate a huge bitmap.
export function layerScale(pixelScale, width, maxSide = 2048) {
  const raw = Number.isFinite(pixelScale) && pixelScale > 0 ? pixelScale : 1;
  const stepped = 2 ** (Math.ceil(Math.log2(raw) * 4) / 4);
  return Math.min(stepped, maxSide / Math.max(1, width));
}

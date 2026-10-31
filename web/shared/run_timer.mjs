// Run Timer decision logic: a tiny stopwatch reducer and the display
// formats. No DOM, no ComfyUI imports; the entry file wires api events.

export const HISTORY_LIMIT = 5;

export function createTimer(history = []) {
  return {
    running: false,
    startedAt: null,
    elapsed: 0,
    outcome: null, // "done" | "error" | "interrupted" once a run has ended
    executed: false, // did any node actually compute during this run?
    history: Array.isArray(history) ? history.filter(isSeconds).slice(0, HISTORY_LIMIT) : [],
  };
}

function isSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function startTimer(state, now) {
  return { ...state, running: true, startedAt: now, elapsed: 0, outcome: null, executed: false };
}

// A node is about to compute. Core sends "executing" only for nodes it runs;
// a node served from the cache returns before that line (execution.py's
// execute(), `if cached is not None: ... return`). So a run that ends without
// a single call here was served entirely from the cache, and its 0.0 s is not
// a time anybody wants as a reference.
export function noteExecution(state) {
  if (!state.running || state.executed) return state;
  return { ...state, executed: true };
}

function secondsBetween(start, now) {
  const span = (now - start) / 1000;
  // A clock that stepped backwards, or a NaN out of performance.now(), must
  // not land in `elapsed`: from there it reads as 0.0 s for the whole run.
  return Number.isFinite(span) && span > 0 ? span : 0;
}

export function tickTimer(state, now) {
  if (!state.running || state.startedAt === null) return state;
  return { ...state, elapsed: secondsBetween(state.startedAt, now) };
}

// Ends a run. Only a completed run that computed something joins the
// history: an interrupted or failed one has no meaning as a reference time,
// so it shows but is not kept, and neither is a run the cache answered whole.
export function stopTimer(state, now, outcome = "done") {
  if (!state.running) return { ...state, outcome };
  const elapsed = state.startedAt === null ? state.elapsed : secondsBetween(state.startedAt, now);
  const keep = outcome === "done" && state.executed;
  const history = keep ? [elapsed, ...state.history].slice(0, HISTORY_LIMIT) : state.history;
  return { ...state, running: false, startedAt: null, elapsed, outcome, history };
}

// Rounding happens once, to a tenth, before a number is split up. The readout
// and the history must agree: a run that takes five seconds measures
// 4.999999999999999 (the performance.now() difference divided by 1000), which
// read as "4.9s" on the node and "5.0 s" in the menu - the same run, two
// numbers. Rounding to a tenth first also pushes 59.95 up into "1:00.0"
// instead of printing "60.0 s" and skipping the unit change.
function roundedTenths(seconds) {
  return Math.round(seconds * 10) / 10;
}

// The readout's three spans: the whole seconds carry the weight, the tenths
// ride small beside them, the unit smaller still. Kept here rather than in
// the entry file so both formats go through the same rounding.
export function splitDigits(seconds) {
  if (!isSeconds(seconds)) return { main: "0", tenths: ".0", unit: "s" };
  const rounded = roundedTenths(seconds);
  const whole = Math.floor(rounded);
  const digit = `.${Math.round((rounded - whole) * 10)}`;
  if (whole < 60) return { main: String(whole), tenths: digit, unit: "s" };
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  if (hours) return { main: `${hours}:${String(minutes).padStart(2, "0")}:${rest}`, tenths: "", unit: "" };
  return { main: `${minutes}:${rest}`, tenths: digit, unit: "" };
}

// "12.3 s" under a minute, "1:05.3" under an hour, "1:02:03" beyond.
export function formatElapsed(seconds) {
  if (!isSeconds(seconds)) return "—";
  const rounded = roundedTenths(seconds);
  if (rounded < 60) return `${rounded.toFixed(1)} s`;
  const whole = Math.floor(rounded);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  const tenths = Math.round((rounded - whole) * 10);
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

// Timecode display and entry for trim fields.
//
// The trim widgets store plain seconds (hundredth precision); these helpers
// render them as h:mm:ss.s style timecodes and parse typed input in any of
// the accepted forms: bare seconds ("95.5"), m:ss ("1:35.5"), or h:mm:ss
// ("1:02:03.5"). Malformed input parses to null so callers can fall back to
// the previous value.

function finiteSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

// 95.5 -> "1:35.5", 3723.5 -> "1:02:03.5", 3.86 -> "0:03.86", 60 -> "1:00".
// Hundredths are preserved; trailing zeros in the fraction are dropped.
export function formatTimecode(secondsValue) {
  // Integer centisecond math sidesteps float dust like 35.499999….
  const centis = Math.round(finiteSeconds(secondsValue) * 100);
  const hours = Math.floor(centis / 360000);
  const minutes = Math.floor((centis % 360000) / 6000);
  const wholeSeconds = Math.floor((centis % 6000) / 100);
  const fraction = centis % 100;
  let seconds = pad2(wholeSeconds);
  if (fraction > 0) {
    seconds += fraction % 10 === 0 ? `.${fraction / 10}` : `.${pad2(fraction)}`;
  }
  return hours > 0 ? `${hours}:${pad2(minutes)}:${seconds}` : `${minutes}:${seconds}`;
}

const BARE_SECONDS = /^\d+(?:\.\d+)?$/;
const TOP_FIELD = /^\d{1,4}$/;
const INNER_FIELD = /^\d{1,2}$/;
const SECONDS_FIELD = /^\d{1,2}(?:\.\d+)?$/;

// "95.5" | "1:35.5" | "1:02:03.5" -> seconds, or null when malformed.
// Fields below the top unit are base-60 and must stay under 60.
export function parseTimecode(textValue) {
  if (typeof textValue !== "string" && typeof textValue !== "number") return null;
  const text = String(textValue).trim();
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length === 1) {
    return BARE_SECONDS.test(text) ? Number(text) : null;
  }
  if (parts.length > 3) return null;
  const seconds = parts[parts.length - 1];
  if (!SECONDS_FIELD.test(seconds) || Number(seconds) >= 60) return null;
  const leading = parts.slice(0, -1);
  for (const [index, field] of leading.entries()) {
    if (index === 0 && !TOP_FIELD.test(field)) return null;
    if (index > 0 && (!INNER_FIELD.test(field) || Number(field) >= 60)) return null;
  }
  let total = Number(seconds);
  let scale = 60;
  for (let index = leading.length - 1; index >= 0; index--) {
    total += Number(leading[index]) * scale;
    scale *= 60;
  }
  return total;
}

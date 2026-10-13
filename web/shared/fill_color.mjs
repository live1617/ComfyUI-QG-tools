// Tolerant fill-color parsing for the transform editor preview.
//
// Mirrors the backend precedence in nodes/_color_helpers.py exactly:
//   1. Hex: #RGB / #RRGGBB, and bare hex when unambiguous (6 digits, or a
//      3-char form containing a-f). A bare 3-digit number is grayscale.
//   2. Numbers: "R, G, B" (commas or spaces) or one grayscale value; all
//      values <= 1 read as 0..1 floats, otherwise 0-255.
//   3. Color names via the injected resolver (the editor passes a canvas
//      probe so the browser's own CSS parser answers).
//   4. Anything else: null from parseFillColor, mid-gray from normalize.

export const FALLBACK_FILL = "#808080";

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

function hexFromChannels(channels) {
  return `#${channels
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function parseFillColor(value, resolveName = null) {
  const text = String(value ?? "").trim().toLowerCase();

  const match = HEX_PATTERN.exec(text);
  if (match) {
    let digits = match[1];
    const unambiguous = text.startsWith("#") || digits.length === 6 || /[a-f]/.test(digits);
    if (unambiguous) {
      if (digits.length === 3) digits = [...digits].map((character) => character + character).join("");
      return `#${digits}`;
    }
  }

  const parts = text.split(/[\s,]+/).filter(Boolean);
  if ((parts.length === 1 || parts.length === 3) && parts.every((part) => NUMBER_PATTERN.test(part))) {
    let numbers = parts.map(Number);
    if (numbers.every((number) => number <= 1)) numbers = numbers.map((number) => number * 255);
    if (numbers.length === 1) numbers = [numbers[0], numbers[0], numbers[0]];
    return hexFromChannels(numbers);
  }

  if (text && typeof resolveName === "function") {
    const resolved = resolveName(text);
    if (typeof resolved === "string" && /^#[0-9a-f]{6}$/i.test(resolved)) return resolved.toLowerCase();
  }

  return null;
}

export function normalizeFillColor(value, resolveName = null) {
  return parseFillColor(value, resolveName) ?? FALLBACK_FILL;
}

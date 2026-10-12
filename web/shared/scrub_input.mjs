// The pack's standard number control, Adobe-style: drag left/right on the
// value to scrub it, click to type an exact value, chevron arrows on the
// right step it, ArrowUp/Down step from the keyboard, and Shift always
// means the fine step. First shipped as the LoRA loader's strength box;
// this is that interaction made reusable, so every numeric field in the
// pack can behave the same way (scrubbing is the house norm).
//
// Pure gesture math up top (tested in tests/scrub_input.test.mjs); the DOM
// factory below wires it to a widget-backed value via callbacks:
//
//   const control = makeScrubInput({
//     value, min, max, step, fineStep, decimals,
//     onChange: (v) => ...,   // every committed change, any gesture
//     onSettle: () => ...,    // a gesture finished (scrub released, value
//   });                       // typed, arrow clicked) - the undo point
//   parent.append(control.root); control.set(next); control.get();
//
// An optional number (a bound that may be absent) passes allowEmpty: true.
// It then holds null, shows its placeholder, clears when the typed text is
// erased, and starts a scrub or step from `emptyStart`.
//
// A value that only means something as a multiple ("divisible by 8")
// passes snap: true. Its steps then land on multiples of `step`, so a box
// at 1 goes 8, 16, 24 instead of 9, 17, 25, and back down to its minimum.
// Shift's fine step and typed values are never snapped.

import { keepKeyInField } from "./canvas_passthrough.mjs?v=2026101216";

// Keep in sync with BRAND in shared/index.mjs - importing it would pull
// /scripts/app.js into node:test, and this module's math must stay testable.
const BRAND = "#00b4aa";

// Horizontal pixels of drag per step; small enough to feel light, large
// enough that a shaky click cannot change the value. The dead zone keeps a
// plain click a click (it opens type-in mode instead).
export const SCRUB_DEAD_ZONE = 3;
export const SCRUB_PIXELS_PER_STEP = 4;
// Shift on a box with no finer step (whole pixels, frame counts) slows the
// drag instead: the same step, over this many times the travel.
export const SCRUB_SLOW_FACTOR = 4;

export function isScrubGesture(deltaX, deltaY) {
  return Math.abs(deltaX) > SCRUB_DEAD_ZONE && Math.abs(deltaX) >= Math.abs(deltaY);
}

// Clamp into range and round to the control's precision - every value the
// control emits goes through here, so callers never see 0.30000000000000004.
export function quantizeScrubValue(value, { min = -Infinity, max = Infinity, decimals = 2 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return quantizeScrubValue(min === -Infinity ? 0 : min, { min, max, decimals });
  const clamped = Math.max(min, Math.min(max, number));
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(clamped * factor) / factor;
}

// `count` steps of `size` from `start` (negative goes down). With `snap` the
// first step goes to the next multiple of `size` that way and the rest stay
// on those multiples: from 1, +1 is 8 and +2 is 16; from 9, -1 is 8.
export function steppedValue(start, count, size, snap = false) {
  const number = Number(start);
  if (!snap || !count) return number + count * size;
  // The tolerance keeps a value already on the grid there (0.3 / 0.1 is
  // 2.9999999999999996, which must not floor to 2).
  const units = number / size;
  const from = count > 0 ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9);
  return (from + count) * size;
}

// Value under the pointer during a scrub: steps of `step` (or `fineStep`
// with Shift) per SCRUB_PIXELS_PER_STEP of travel past the dead zone. A box
// whose fine step is no finer than its step still honours Shift: the drag
// goes SCRUB_SLOW_FACTOR times slower, so Shift always means fine. A `snap`
// box keeps whole steps on multiples of `step`; fine steps move freely.
export function scrubbedValue(start, deltaX, fine, options = {}) {
  const { step = 1, fineStep = null, snap = false } = options;
  if (Math.abs(deltaX) <= SCRUB_DEAD_ZONE) return quantizeScrubValue(start, options);
  const finer = fineStep != null && fineStep < step;
  const size = fine && finer ? fineStep : step;
  const pixels = fine && !finer ? SCRUB_PIXELS_PER_STEP * SCRUB_SLOW_FACTOR : SCRUB_PIXELS_PER_STEP;
  const travel = deltaX - Math.sign(deltaX) * SCRUB_DEAD_ZONE;
  const steps = Math.round(travel / pixels);
  return quantizeScrubValue(steppedValue(start, steps, size, snap && size === step), options);
}

const CSS_ID = "qgtools-scrub-css";

function ensureScrubCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  // Child selectors on purpose: host panels (the transform editor sidebar,
  // for one) carry blanket `section input` rules, and these must outrank
  // them wherever the control is mounted.
  style.textContent = `
  .qgtools-scrub{display:flex;width:72px;height:24px;border:1px solid #3a4047;border-radius:5px;
    background:#23272c;overflow:hidden;flex:none;color:#d7dde2;font:12px system-ui}
  .qgtools-scrub:focus-within{border-color:${BRAND}}
  .qgtools-scrub>.qgtools-scrub-input{flex:1 1 auto;min-width:0;width:100%;height:100%;border:none;
    padding:0;margin:0;background:transparent;color:inherit;text-align:center;cursor:ew-resize;
    user-select:none;font:inherit;outline:none;border-radius:0}
  .qgtools-scrub>.qgtools-scrub-input:focus{cursor:text;user-select:text}
  .qgtools-scrub>.qgtools-scrub-unit{flex:none;align-self:center;padding:0 3px 0 1px;color:#5f7674;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;text-align:center;user-select:none;pointer-events:none}
  .qgtools-scrub>.qgtools-scrub-step{flex:none;width:14px;display:flex;flex-direction:column;
    border-left:1px solid #3a4047}
  .qgtools-scrub>.qgtools-scrub-step>button{flex:1 1 0;min-height:0;border:none;background:transparent;
    color:#9ba2aa;cursor:pointer;padding:0;margin:0;display:grid;place-items:center;border-radius:0}
  .qgtools-scrub>.qgtools-scrub-step>button:hover{color:${BRAND};background:rgba(255,255,255,.05)}
  `;
  document.head.append(style);
}

// Stepper chevrons, hand-drawn so no glyph font is trusted to have them.
function chevronSvg(up) {
  const points = up ? "1.5,4 4.5,1 7.5,4" : "1.5,1 4.5,4 7.5,1";
  return `<svg width="9" height="5" viewBox="0 0 9 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

export function makeScrubInput(options = {}) {
  ensureScrubCss();
  const opts = {
    value: 0, min: -Infinity, max: Infinity,
    step: 1, fineStep: null, decimals: 2,
    width: null, title: "", onChange: null, onSettle: null,
    unit: "", unitWidth: 0,
    allowEmpty: false, emptyStart: 0, placeholder: "",
    snap: false,
    ...options,
  };
  const isEmpty = (value) => opts.allowEmpty && (value === null || value === undefined || value === "");
  let current = isEmpty(opts.value) ? null : quantizeScrubValue(opts.value, opts);
  // Where a scrub or a step starts: the value, or emptyStart while empty.
  const base = () => (current === null ? quantizeScrubValue(opts.emptyStart, opts) : current);
  // One arrow-key or chevron step; Shift takes the fine step, which never snaps.
  const stepped = (direction, fine) => {
    const size = fine ? (opts.fineStep ?? opts.step) : opts.step;
    return steppedValue(base(), direction, size, opts.snap && size === opts.step);
  };

  const box = document.createElement("div");
  box.className = "qgtools-scrub";
  if (opts.width) box.style.width = `${opts.width}px`;
  const input = document.createElement("input");
  input.className = "qgtools-scrub-input";
  input.type = "text";
  input.inputMode = "decimal";
  input.readOnly = true;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  // The title must be the caller's complete sentence: the zh translator
  // matches whole attributes only, so appending a suffix here would keep
  // every scrub tooltip English. Callers that want the drag hint bake it
  // into their own static title string.
  if (opts.title) input.title = opts.title;

  const format = (value) => (value === null ? "" : value.toFixed(Math.max(0, opts.decimals)));
  input.value = format(current);

  const commit = (value) => {
    const next = isEmpty(value) ? null : quantizeScrubValue(value, opts);
    const changed = next !== current;
    current = next;
    input.value = format(current);
    if (changed) opts.onChange?.(current);
    return current;
  };
  const settle = () => opts.onSettle?.();

  // Scrub gesture: capture on the input, dead zone keeps clicks clicks.
  let drag = null;
  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !input.readOnly) return;
    drag = { x: event.clientX, y: event.clientY, start: base(), scrubbed: false };
    input.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  input.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.scrubbed && isScrubGesture(dx, dy)) { drag.scrubbed = true; drag.fine = event.shiftKey; }
    if (!drag.scrubbed) return;
    // Pressing or letting go of Shift mid-drag carries on from here instead
    // of re-reading the whole drag at the other speed.
    if (event.shiftKey !== drag.fine) {
      drag.start = base(); drag.x = event.clientX - Math.sign(dx || 1) * (SCRUB_DEAD_ZONE + 1); drag.fine = event.shiftKey;
    }
    commit(scrubbedValue(drag.start, event.clientX - drag.x, event.shiftKey, opts));
  });
  const endDrag = (event) => {
    if (!drag) return;
    try { input.releasePointerCapture(event.pointerId); } catch { /* mouse fallback */ }
    const wasClick = !drag.scrubbed;
    const scrubbed = drag.scrubbed;
    drag = null;
    if (wasClick) {
      input.readOnly = false;
      input.focus();
      input.select();
      // The graph canvas grabs focus during the click sequence on some
      // frontends, which silently blurs the input before a keystroke can
      // land. One re-assertion after the click settles wins that race
      // without starting a focus war.
      requestAnimationFrame(() => {
        if (document.activeElement !== input) {
          input.readOnly = false;
          input.focus();
          input.select();
        }
      });
    } else if (scrubbed) {
      settle();
    }
  };
  input.addEventListener("pointerup", endDrag);
  input.addEventListener("pointercancel", endDrag);

  input.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter") input.blur();
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      commit(stepped(event.key === "ArrowUp" ? 1 : -1, event.shiftKey));
      input.select();
      settle();
    }
  });
  // Typed values commit on blur/Enter; unparseable text falls back to the
  // last good value rather than guessing.
  input.addEventListener("blur", () => {
    if (!input.readOnly) {
      if (opts.allowEmpty && input.value.trim() === "") {
        if (current !== null) { commit(null); settle(); }
      } else {
        const number = Number(input.value);
        if (Number.isFinite(number) && commit(number) !== undefined) settle();
      }
      input.readOnly = true;
    }
    input.value = format(current);
  });

  const steppers = document.createElement("div");
  steppers.className = "qgtools-scrub-step";
  for (const direction of [1, -1]) {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.title = `Step ${direction > 0 ? "up" : "down"}; Shift = fine.`;
    button.innerHTML = chevronSvg(direction > 0);
    button.addEventListener("click", (event) => {
      commit(stepped(direction, event.shiftKey));
      settle();
    });
    steppers.append(button);
  }

  if (opts.unit || opts.unitWidth > 0) {
    // The unit rides inside the box, ahead of the chevrons. A `unitWidth`
    // reserves that slot at a fixed width whether or not this field has a
    // unit, so in a column of fields every number is centred on the same
    // axis - a "px" here and nothing there no longer nudges one of them.
    const unit = document.createElement("span");
    unit.className = "qgtools-scrub-unit";
    unit.textContent = opts.unit;
    if (opts.unitWidth > 0) {
      unit.style.width = `${opts.unitWidth}px`;
      unit.style.padding = "0";
    }
    box.append(input, unit, steppers);
  } else {
    box.append(input, steppers);
  }
  return {
    root: box,
    input,
    get: () => current,
    set: (value) => {
      current = isEmpty(value) ? null : quantizeScrubValue(value, opts);
      if (input.readOnly) input.value = format(current);
    },
    // For a value whose valid steps change with another setting (a frame
    // count under a snap rule steps by 8, not 1).
    setStep: (step, fineStep = null) => { opts.step = step; opts.fineStep = fineStep; },
  };
}

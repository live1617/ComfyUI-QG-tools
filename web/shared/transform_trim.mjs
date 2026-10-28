// The video timeline the transform nodes share, on the node face and in the
// editor: one rail with a playhead, and on the clip node the IN/OUT handles
// around it. Frame arithmetic lives in timeline_math.mjs (tested); this
// file is the DOM.
//
// Interaction, in the words of a video editor: press or drag anywhere on
// the rail to scrub the playhead - the stage shows that frame, whatever the
// Length says. Drag an IN or OUT handle to trim; the playhead rides along on
// the handle, so the frame on the stage is the first (IN) or last (OUT)
// frame the run keeps, and stays there on release. The small grip on the
// kept part slides the whole clip (so does IN, while Length is on). IN, OUT
// and the playhead are frames, snapped to the source's own frame grid; the
// seconds the widgets store are derived from them and round-trip exactly.
//
// The clip's length is set one way at a time (clipLengthPlan): by OUT; by a
// Length that keeps OUT a set number of frames after IN; or by a connected
// fixed_frames / frame_load_cap input, which leaves only IN to set. OUT
// always sits on the last frame the run outputs - every nth, the snap rule
// and the Length included - so the handle and the bright bar agree.
import { makeScrubInput } from "./scrub_input.mjs?v=2026102706";
import { zh } from "./zh.mjs?v=2026102706";
import { formatTimecode } from "./timecode.mjs?v=2026102706";
import {
  boundaryAtFraction,
  clampFrame,
  lengthFillsClip,
  clipInfo,
  clipLengthPlan,
  formatFps,
  fractionOfFrame,
  frameAtFraction,
  frameTime,
  framesThrough,
  keyboardStep,
  lastFrameFor,
  latestFirstFor,
  railZone,
  setTrimFrame,
  slideRange,
  snapStep,
  snapToValid,
  windowSeconds,
} from "./timeline_math.mjs?v=2026102706";

const CSS_ID = "qgtools-transform-trim-css-v4";
const HANDLE_HIT_PX = 9;
// Connected inputs that set the length themselves, in the backend's order of
// precedence: fixed_frames replaces the window, a cap replaces the Length.
const LENGTH_INPUTS = ["fixed_frames", "frame_load_cap", "max_frames"];
// Connected inputs whose value only the run knows make the count unknowable.
const COUNT_INPUTS = ["start_frame", "end_frame", "start_seconds", "end_seconds", "every_nth", "frame_snap", "force_rate"];

function installCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
    .qgtools-transform-trim{flex:none;display:flex;flex-direction:column;gap:8px;min-width:0;padding:9px 10px 8px;border:1px solid #164b49;border-radius:8px;background:#0e1718;color:#cadddb;font:11px system-ui;box-sizing:border-box;overflow:hidden}
    .qgtools-transform-trim-rail{position:relative;height:28px;margin:0 6px;touch-action:none;cursor:pointer;user-select:none}
    .qgtools-transform-trim-rail.is-disabled{opacity:.45;cursor:default}
    .qgtools-transform-trim-rail:before{content:"";position:absolute;left:0;right:0;top:11px;height:6px;border-radius:4px;background:#293637}
    .qgtools-transform-trim-span{position:absolute;top:11px;height:6px;border-radius:4px;background:rgba(0,180,170,.3);pointer-events:none}
    .qgtools-transform-trim-kept{position:absolute;top:11px;height:6px;border-radius:4px;background:#00b4aa;pointer-events:none}
    .qgtools-transform-trim-handle{position:absolute!important;top:2px;width:12px!important;height:24px;min-width:0;padding:0!important;margin:0!important;transform:translateX(-50%);border:2px solid #00b4aa!important;border-radius:4px!important;background:#e5fffc!important;cursor:ew-resize;touch-action:none;z-index:2}
    .qgtools-transform-trim-handle[hidden]{display:none!important}
    .qgtools-transform-trim-handle:focus-visible{outline:2px solid white;outline-offset:2px}
    .qgtools-transform-trim-grip{position:absolute;top:8px;width:26px;height:12px;margin-left:-13px;box-sizing:border-box;border:1px solid #00b4aa;border-radius:6px;background:#0e1718;cursor:grab;z-index:2;display:flex;align-items:center;justify-content:center;gap:2px;touch-action:none}
    .qgtools-transform-trim-grip[hidden]{display:none}
    .qgtools-transform-trim-grip:hover{background:#163234}
    .qgtools-transform-trim-grip>i{display:block;width:1px;height:6px;background:#9fe3dc;pointer-events:none}
    .qgtools-transform-trim-rail.is-sliding,.qgtools-transform-trim-rail.is-sliding .qgtools-transform-trim-grip{cursor:grabbing}
    .qgtools-transform-trim-playhead{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#f4fffd;box-shadow:0 0 0 1px rgba(0,0,0,.55);pointer-events:none;z-index:3}
    .qgtools-transform-trim-playhead:before{content:"";position:absolute;top:-1px;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top:6px solid #f4fffd;filter:drop-shadow(0 0 1px rgba(0,0,0,.7))}
    .qgtools-transform-trim-line{display:flex;align-items:center;gap:7px;min-width:0}
    .qgtools-transform-trim-line.wrap{flex-wrap:wrap;row-gap:6px}
    .qgtools-transform-trim-line label{display:flex;align-items:center;gap:5px;white-space:nowrap}
    .qgtools-transform-trim-line .spacer{flex:1 1 0;min-width:0}
    .qgtools-transform-trim-line .qgtools-scrub{width:64px}
    .qgtools-transform-trim-line select{background:#1b2627;color:#e5fffc;border:1px solid #2c4d4b;border-radius:5px;padding:3px 4px;font:11px system-ui;cursor:pointer;flex:none}
    .qgtools-transform-trim-line select:focus-visible{outline:2px solid #00b4aa;outline-offset:1px}
    .qgtools-transform-trim-line .qgtools-scrub-step button{font-size:8px}
    .qgtools-transform-trim-caption{color:#00b4aa;font-weight:650;font-size:10px;letter-spacing:.06em}
    .qgtools-transform-trim-readout{flex:1 1 0;min-width:0;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#8ca8a5;font-variant-numeric:tabular-nums}
    .qgtools-transform-trim-readout b{color:#e5fffc;font-weight:600}
    .qgtools-transform-trim-pill{display:inline-flex;flex:none;height:22px;border:1px solid #2c4d4b;border-radius:5px;overflow:hidden;background:#1b2627}
    .qgtools-transform-trim-pill button{border:0;margin:0;background:transparent;color:#8ca8a5;font:600 10px system-ui;letter-spacing:.04em;padding:0 9px;cursor:pointer}
    .qgtools-transform-trim-pill button:hover{color:#e5fffc}
    .qgtools-transform-trim-pill button.on{background:#00b4aa;color:#04201d}
    .qgtools-transform-trim-pill.is-disabled{opacity:.45}
    .qgtools-transform-trim-pill.is-disabled button{cursor:not-allowed}
    .qgtools-transform-trim-hint{flex:1 1 0;min-width:0;color:#6f8886;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .qgtools-transform-trim-hint.note{flex:0 1 auto;max-width:100%;color:#ffc46b}
    .qgtools-transform-trim-summary{flex:1 1 0;min-width:0;color:#8ca8a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
    .qgtools-transform-trim-reset{flex:none;height:18px;box-sizing:border-box;border:1px solid #2c4d4b;border-radius:4px;background:#1b2627;color:#cadddb;font:600 10px/16px system-ui;cursor:pointer;padding:0 8px;white-space:nowrap}
    .qgtools-transform-trim-reset:hover{border-color:#8fa3a1;color:#fff}
    .qgtools-transform-trim-reset:disabled{opacity:.45;cursor:not-allowed}
  `;
  document.head.append(style);
}

function el(tag, className = "", text = "") {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

const pct = (fraction) => `${(fraction * 100).toFixed(3)}%`;

// options:
//   get(name, fallback) / set(name, value)  widget access
//   has(name)                                whether a widget exists
//   driven(name)                             whether an input is linked
//   number(name, fallback)                   a linked literal's value, null
//                                            when only the run knows it
//   outputRate()                             output fps, null when unknown
//   metadata()                               the source's {fps, frame_count, duration}
//   trim                                     IN/OUT handles and the length rows
//                                            (the clip node) or playhead only
//   onSeek(frame, settled)                   the playhead moved; settled on release
//   onCommit()                               a stored value settled (undo point)
export function mountTransformTrim({ get, set, has = () => true, driven = () => false, number = (name, fallback) => get(name, fallback), outputRate, metadata, trim = true, onSeek, onCommit }) {
  installCss();
  const root = el("div", "qgtools-transform-trim");
  const rail = el("div", "qgtools-transform-trim-rail");
  const span = el("div", "qgtools-transform-trim-span");
  const kept = el("div", "qgtools-transform-trim-kept");
  const playhead = el("div", "qgtools-transform-trim-playhead");
  const grip = el("div", "qgtools-transform-trim-grip");
  grip.append(el("i"), el("i"), el("i"));
  grip.hidden = true;
  const handles = {};
  if (trim) rail.append(span, kept, grip);
  rail.append(playhead);

  const info = () => clipInfo(metadata());
  const everyNth = () => Math.max(1, Math.trunc(Number(number("every_nth", get("every_nth", 1))) || 1));
  const snapRule = () => String(get("frame_snap", "free"));
  const wiredBy = () => LENGTH_INPUTS.find((name) => driven(name)) ?? null;
  // Seconds the run starts and ends at, a connected frame bound included.
  const boundSeconds = (edge) => {
    const clip = info();
    if (driven(`${edge}_frame`)) {
      const frame = number(`${edge}_frame`, null);
      if (frame != null && clip.fps > 0) return Math.max(0, frame) / clip.fps;
    }
    const name = `${edge}_seconds`;
    return number(name, get(name, 0)) ?? get(name, 0);
  };
  const countAtRunTime = () => COUNT_INPUTS.some((name) => driven(name) && number(name, null) == null);
  const plan = () => {
    if (!trim) return null;
    const clip = info();
    const wired = wiredBy();
    return clipLengthPlan(clip, {
      start: boundSeconds("start"),
      end: boundSeconds("end"),
      everyNth: everyNth(),
      frameSnap: snapRule(),
      maxFrames: get("max_frames", 0),
      fixedFrames: driven("fixed_frames") ? 0 : get("fixed_frames", 0),
      wired,
      wiredFrames: wired ? number(wired, null) : null,
      outputFps: outputRate ? outputRate() : clip.fps,
      resampled: driven("force_rate"),
    });
  };
  const currentWindow = () => {
    const clip = info();
    if (!trim) return { first: 0, last: Math.max(0, clip.count - 1) };
    const current = plan();
    return { first: current.first, last: current.last ?? current.windowLast };
  };
  const playheadFrame = () => clampFrame(get("frame_index", 0), info());
  const controls = {};
  let syncLength = () => {};
  // IN is locked by a connected bound; OUT by a connected bound in free
  // trim, and always when a connected input sets the length.
  const locked = (edge) => {
    if (edge === "start") return driven("start_frame") || driven("start_seconds");
    const mode = plan()?.mode;
    if (mode === "wired") return true;
    if (mode === "free") return driven("end_frame") || driven("end_seconds");
    return false;
  };
  const lockTip = (edge) => edge === "start"
    ? "The starting frame is supplied by a connected input. Disconnect it to edit IN here."
    : wiredBy()
      ? `The connected ${wiredBy()} input sets the length, so the clip ends where it says. Disconnect it to use OUT or Length.`
      : "The ending frame is supplied by a connected input. Disconnect it to edit OUT here.";
  const disableControl = (control, disabled, tip) => {
    if (!control) return;
    control.root.style.opacity = disabled ? ".45" : "";
    control.root.inert = disabled;
    control.root.parentElement.title = disabled ? tip : "";
  };

  const seek = (frame, settled) => {
    onSeek?.(clampFrame(frame, info()), settled);
    sync();
  };
  const writeStart = (first) => {
    if (!locked("start")) set("start_seconds", windowSeconds(info(), first, first).start_seconds);
  };
  const writeEnd = (first, last) => set("end_seconds", windowSeconds(info(), first, last).end_seconds);
  // An older face's Fixed frames reads as a Length; the first edit makes it
  // one, keeping the window where the fixed count had placed it.
  const adoptLength = (current) => {
    if (current.mode !== "fixed") return current;
    set("fixed_frames", 0);
    set("max_frames", Math.max(1, current.requested ?? current.frames ?? 1));
    set("end_seconds", 0);
    writeStart(current.first);
    return plan();
  };
  // A trim edge moved: store it and park the playhead on that edge's frame,
  // so the stage shows the first or last frame the run keeps.
  const moveEdge = (edge, frame, settled) => {
    if (!trim || locked(edge)) return;
    const clip = info();
    const current = adoptLength(plan());
    const nth = everyNth();
    let parked;
    if (edge === "start") {
      if (current.mode === "length") {
        // A Length drags the whole window, stopping where OUT meets the end.
        parked = Math.max(0, Math.min(clampFrame(frame, clip), latestFirstFor(clip, current.requested ?? get("max_frames", 1), nth)));
        set("end_seconds", 0);
      } else {
        parked = setTrimFrame({ first: current.first, last: current.windowLast }, "start", frame, clip).first;
      }
      writeStart(parked);
    } else {
      const target = Math.max(current.first, clampFrame(frame, clip));
      const frames = framesThrough(current.first, target, nth, snapRule());
      if (current.mode === "length") {
        set("max_frames", frames);
        set("end_seconds", 0);
        parked = Math.min(clip.count - 1, lastFrameFor(current.first, frames, nth));
      } else {
        parked = driven("force_rate") ? target : lastFrameFor(current.first, frames, nth);
        writeEnd(current.first, parked);
      }
    }
    seek(parked, settled);
    if (settled) onCommit?.();
  };
  // The grip slides the kept part: a Length moves with IN (OUT follows), a
  // free window keeps its span and both edges move.
  const canSlide = () => {
    if (!trim || locked("start")) return false;
    const current = plan();
    if (!current || !["length", "fixed", "free"].includes(current.mode)) return false;
    if (current.mode === "free" && locked("end")) return false;
    const range = slideRange(info(), current, everyNth());
    return range.max > range.min;
  };
  const slideTo = (target, settled) => {
    const clip = info();
    const current = plan();
    const range = slideRange(clip, current, everyNth());
    const first = Math.max(range.min, Math.min(range.max, Math.round(target)));
    if (current.mode === "free") {
      const spanFrames = current.windowLast - current.first;
      writeStart(first);
      writeEnd(first, Math.min(clip.count - 1, first + spanFrames));
      seek(first, settled);
      if (settled) onCommit?.();
      return;
    }
    moveEdge("start", first, settled);
  };
  // Length on keeps what the rail shows now as the count; off turns the
  // Length into an OUT at the same frame. Either way nothing moves.
  const setLength = (on) => {
    const current = plan();
    if (!current || current.mode === "wired" || (on === (current.mode !== "free"))) return;
    if (on) {
      const frames = current.frames ?? framesThrough(current.first, current.windowLast, everyNth(), snapRule());
      set("max_frames", Math.max(1, frames));
      set("end_seconds", 0);
    } else {
      const last = current.last ?? current.windowLast;
      writeStart(current.first);
      writeEnd(current.first, last);
      set("max_frames", 0);
      if (!driven("fixed_frames")) set("fixed_frames", 0);
    }
    sync();
    onCommit?.();
  };

  const readout = el("span", "qgtools-transform-trim-readout");
  const summary = el("div", "qgtools-transform-trim-summary");

  const sync = () => {
    const clip = info();
    const head = playheadFrame();
    rail.classList.toggle("is-disabled", !clip.count);
    playhead.style.left = pct(fractionOfFrame(head, clip, "center"));
    playhead.style.visibility = clip.count ? "" : "hidden";
    readout.replaceChildren();
    if (clip.count) {
      readout.append(el("b", "", `fr ${head}`), document.createTextNode(` · ${formatTimecode(frameTime(head, clip))}`));
      readout.title = `Playhead: frame ${head} of ${clip.count} at ${frameTime(head, clip).toFixed(3)} s. Press or drag the rail to scrub; ${trim ? "the trim handles carry it with them." : "this is the frame the node outputs."}`;
    }
    controls.frame?.set(head);
    if (!trim) return;
    const current = plan();
    const wired = wiredBy();
    const unknown = countAtRunTime();
    const hasOut = current.last != null && current.mode !== "wired";
    const outFrame = current.last ?? current.windowLast;
    const startFraction = fractionOfFrame(current.first, clip, "start");
    const endFraction = fractionOfFrame(outFrame, clip, "end");
    // Dim: frames the free window holds but the run drops (every nth, snap).
    const tailFraction = current.mode === "free" ? fractionOfFrame(current.windowLast, clip, "end") : endFraction;
    span.style.left = pct(startFraction);
    span.style.width = pct(current.last == null && current.mode !== "free" ? 0 : Math.max(0, tailFraction - startFraction));
    kept.style.left = pct(startFraction);
    kept.style.width = current.last == null || unknown ? "0%" : pct(Math.max(0, endFraction - startFraction));
    const fills = lengthFillsClip(clip, current, everyNth());
    const railWidth = rail.getBoundingClientRect().width || 0;
    const keptWidth = Math.max(0, endFraction - startFraction) * railWidth;
    grip.hidden = !canSlide() || unknown || (railWidth > 0 && keptWidth < 34);
    grip.style.left = pct((startFraction + endFraction) / 2);
    grip.title = current.mode === "free"
      ? "Drag to slide the kept part: IN and OUT move together."
      : "Drag to slide the clip: OUT follows at the Length.";
    for (const edge of ["start", "end"]) {
      const handle = handles[edge];
      const frame = edge === "start" ? current.first : outFrame;
      const isLocked = locked(edge);
      handle.hidden = edge === "end" && !hasOut;
      handle.style.left = pct(edge === "start" ? startFraction : endFraction);
      handle.disabled = !clip.count;
      handle.setAttribute("aria-disabled", String(isLocked || !clip.count));
      handle.style.opacity = isLocked ? ".35" : "";
      handle.style.cursor = isLocked ? "not-allowed" : "";
      handle.title = isLocked ? lockTip(edge)
        : edge === "start"
          ? current.mode === "free" ? "Drag IN to trim; Shift + arrow moves one frame."
            : fills ? "The Length is the whole clip, so IN has nowhere to go. Shorten the Length to move IN."
              : "Drag IN to move the clip; OUT follows at the Length. Shift + arrow moves one frame."
          : current.mode === "free" ? "Drag OUT to trim; it lands on the last frame the run keeps." : "Drag OUT to change the Length; IN stays.";
      handle.setAttribute("aria-valuemin", "0");
      handle.setAttribute("aria-valuemax", String(Math.max(0, clip.count - 1)));
      handle.setAttribute("aria-valuenow", String(frame));
      handle.setAttribute("aria-valuetext", `frame ${frame}, ${formatTimecode(frameTime(frame, clip))}`);
    }
    controls.start_seconds?.set(current.first);
    controls.end_seconds?.set(outFrame);
    disableControl(controls.start_seconds, locked("start"), lockTip("start"));
    disableControl(controls.end_seconds, locked("end") || !hasOut, lockTip("end"));
    syncLength(current, wired);
    if (controls.reset) {
      const free = current.mode === "free";
      controls.reset.textContent = free ? "Full clip" : "To start";
      controls.reset.title = free ? zh("Reset IN/OUT to the full source. Keeps Every nth and Frames for.") : zh("Move IN to the start of the source; the length stays.");
      controls.reset.disabled = !free && locked("start");
    }
    controls.every_nth?.set(get("every_nth", 1));
    disableControl(controls.every_nth, driven("every_nth"), "Every nth is supplied by a connected input.");
    if (controls.frame_snap) {
      controls.frame_snap.value = snapRule();
      const exact = current.mode === "fixed" || (current.mode === "wired" && wired === "fixed_frames");
      controls.frame_snap.disabled = exact || driven("frame_snap");
      controls.frame_snap.title = exact ? "An exact fixed_frames count is used as it is; this does not apply." : "Keep a frame count the video model takes: LTX wants 8n+1 (49, 97, 121), Wan 4n+1. OUT and Length step to those counts. Any keeps every frame.";
    }
    syncSummary(clip, current, wired, unknown);
  };

  const syncSummary = (clip, current, wired, unknown) => {
    if (!clip.count) {
      summary.textContent = "Choose a source to set the clip window";
      summary.title = "";
      return;
    }
    const rate = outputRate?.();
    const fps = `Source ${formatFps(clip.fps)} fps → Output ${rate == null ? "rate at run time" : `${formatFps(rate)} fps`}`;
    if (current.mode === "wired") {
      summary.textContent = current.frames == null ? `${fps} · length from ${wired} at run time` : `${fps} · ${current.frames} frames from ${wired}`;
      summary.title = `The connected ${wired} input sets the length, so only IN is set here. Disconnect it to use OUT or a Length.`;
      return;
    }
    if (unknown || current.frames == null) {
      summary.textContent = `${fps} · frame count at run time`;
      summary.title = zh("IN, OUT and the playhead refer to source frames. A connected input decides the exact frame count when the workflow runs. Connect the fps output to the next video node's fps input.");
      return;
    }
    const from = formatTimecode(frameTime(current.first, clip));
    const to = formatTimecode((current.last + 1) / clip.fps);
    if (current.mode === "fixed") {
      summary.textContent = current.tooLong
        ? `Fixed length needs more than the source's ${clip.duration.toFixed(3)}s`
        : `${fps} · exactly ${current.frames} frames · ${from} → ${to}`;
      summary.title = zh("An older Fixed frames value: an exact count from IN. Any change here turns it into a Length.");
      return;
    }
    const total = current.windowLast - current.first + 1;
    const count = current.mode === "length"
      ? current.truncated ? `${current.frames} of ${current.requested} frames, source ends` : `${current.frames} frames`
      : current.frames < total ? `${current.frames} of ${total} frames` : `${current.frames} frames`;
    summary.textContent = `${fps} · ${count} · ${from} → ${to}`;
    summary.title = current.mode === "length"
      ? current.truncated
        ? `The source ends ${current.frames} frames after IN, before the Length of ${current.requested}. Move IN earlier or shorten the Length.`
        : "Length keeps OUT this many output frames after IN; drag IN to move the clip, OUT to change the Length."
      : current.frames < total
        ? `The window holds ${total} frames; every nth and the snap rule keep ${current.frames}, ending at frame ${current.last}, where OUT sits. The dim part is dropped.`
        : "Frames the run outputs, at the fps the node reports.";
  };

  // --- rail gestures --------------------------------------------------------
  const hit = (event) => {
    const box = rail.getBoundingClientRect();
    const width = Math.max(1, box.width);
    const x = Math.max(0, Math.min(width, event.clientX - box.left));
    const fraction = x / width;
    if (!trim) return { fraction, zone: "playhead" };
    if (event.target === handles.start) return { fraction, zone: "start" };
    if (event.target === handles.end && !handles.end.hidden) return { fraction, zone: "end" };
    const clip = info();
    const window = currentWindow();
    // Screen pixels, so the zone keeps its size whatever the graph zoom.
    const zone = railZone({
      x,
      inX: fractionOfFrame(window.first, clip, "start") * width,
      outX: fractionOfFrame(window.last, clip, "end") * width,
      hasOut: !handles.end.hidden,
      hitPx: HANDLE_HIT_PX,
      onGrip: !grip.hidden && grip.contains(event.target),
    });
    return { fraction, zone };
  };
  const applyPointer = (zone, fraction, settled, gesture = drag) => {
    const clip = info();
    if (zone === "playhead") { seek(frameAtFraction(fraction, clip), settled); return; }
    if (zone === "grip") {
      if (gesture) slideTo(gesture.first + Math.round((fraction - gesture.origin) * clip.count), settled);
      return;
    }
    moveEdge(zone, boundaryAtFraction(fraction, clip) - (zone === "end" ? 1 : 0), settled);
  };
  let drag = null;
  rail.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !info().count) return;
    event.preventDefault(); event.stopPropagation();
    const { fraction, zone } = hit(event);
    if (zone !== "playhead" && zone !== "window" && locked(zone)) return;
    drag = { zone, fraction, origin: fraction, first: currentWindow().first, pointerId: event.pointerId };
    rail.classList.toggle("is-sliding", zone === "grip");
    try { rail.setPointerCapture(event.pointerId); } catch { /* mouse fallback */ }
    applyPointer(zone, fraction, false);
  });
  rail.addEventListener("pointermove", (event) => {
    if (!drag) {
      const { zone } = info().count ? hit(event) : { zone: "playhead" };
      rail.style.cursor = zone === "playhead" ? "pointer" : zone === "grip" ? "grab" : locked(zone) ? "not-allowed" : "ew-resize";
      return;
    }
    event.preventDefault(); event.stopPropagation();
    drag.fraction = hit(event).fraction;
    applyPointer(drag.zone, drag.fraction, false);
  });
  const finish = (event) => {
    if (!drag) return;
    const gesture = drag;
    const { zone, fraction, pointerId } = gesture;
    drag = null;
    rail.classList.remove("is-sliding");
    try { if (rail.hasPointerCapture(pointerId)) rail.releasePointerCapture(pointerId); } catch { /* released already */ }
    if (event?.type === "pointerup") event.stopPropagation();
    applyPointer(zone, fraction, true, gesture);
  };
  rail.addEventListener("pointerup", finish);
  rail.addEventListener("pointercancel", finish);
  rail.addEventListener("lostpointercapture", () => finish(null));

  // --- trim handles ---------------------------------------------------------
  if (trim) {
    for (const edge of ["start", "end"]) {
      const handle = el("button", "qgtools-transform-trim-handle");
      handle.type = "button";
      handle.setAttribute("role", "slider");
      handle.setAttribute("aria-label", edge === "start" ? zh("Clip IN") : zh("Clip OUT"));
      handle.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const clip = info();
        if (!clip.count || locked(edge)) return;
        const direction = event.key === "ArrowLeft" || event.key === "Home" ? -1 : 1;
        const window = currentWindow();
        if (edge === "start") {
          const target = event.key === "Home" ? 0 : event.key === "End" ? clip.count - 1 : window.first + keyboardStep(clip, event.shiftKey) * direction;
          moveEdge("start", target, true);
          return;
        }
        // OUT steps by output frames, to the next count the snap rule keeps.
        const current = plan();
        const nth = everyNth();
        const frames = current.frames ?? framesThrough(window.first, window.last, nth, snapRule());
        const step = Math.max(1, Math.round(keyboardStep(clip, event.shiftKey) / nth));
        const next = event.key === "Home" ? 1 : event.key === "End" ? framesThrough(window.first, clip.count - 1, nth, snapRule()) : snapToValid(frames + step * direction, snapRule(), direction);
        moveEdge("end", lastFrameFor(window.first, next, nth), true);
      });
      handles[edge] = handle;
      rail.append(handle);
    }
  }

  // --- rows -----------------------------------------------------------------
  const timeRow = el("div", "qgtools-transform-trim-line");
  if (trim) {
    for (const [name, caption, edge] of [["start_seconds", "IN", "start"], ["end_seconds", "OUT", "end"]]) {
      const label = el("label");
      label.append(el("span", "qgtools-transform-trim-caption", caption));
      controls[name] = makeScrubInput({
        value: 0, min: 0, max: 10000000, step: 1, decimals: 0,
        title: edge === "start" ? "IN frame: the first frame the run keeps (stored as start_seconds)." : "OUT frame: the last frame the run keeps. With Length on it follows IN; typing it changes the Length.",
        onChange: (frame) => moveEdge(edge, frame, false),
        onSettle: () => { const window = currentWindow(); seek(edge === "start" ? window.first : window.last, true); onCommit?.(); },
      });
      label.append(controls[name].root);
      timeRow.append(label);
      if (edge === "start") timeRow.append(readout);
    }
  } else {
    const label = el("label");
    label.append(el("span", "qgtools-transform-trim-caption", "FRAME"));
    controls.frame = makeScrubInput({
      value: 0, min: 0, max: 10000000, step: 1, decimals: 0,
      title: "The frame this node outputs (frame_index).",
      onChange: (frame) => seek(frame, false),
      onSettle: () => seek(playheadFrame(), true),
    });
    label.append(controls.frame.root);
    timeRow.append(label, readout);
  }
  root.append(rail, timeRow);

  // Length: off, OUT ends the clip; on, a frame count from IN (max_frames,
  // end left open), so OUT follows IN and the count survives a new source.
  if (trim && has("max_frames")) {
    const lengthRow = el("div", "qgtools-transform-trim-line wrap");
    const label = el("label", "", "Length");
    const pill = el("div", "qgtools-transform-trim-pill");
    const off = el("button", "", "off");
    const on = el("button", "", "on");
    off.type = on.type = "button";
    off.title = zh("OUT ends the clip: drag both handles freely.");
    on.title = zh("Set the clip by a frame count from IN: OUT follows IN, and the count stays when you swap the video.");
    off.addEventListener("click", () => setLength(false));
    on.addEventListener("click", () => setLength(true));
    pill.append(off, on);
    const hint = el("span", "qgtools-transform-trim-hint");
    const count = makeScrubInput({ value: 1, min: 1, max: 100000, step: 1, decimals: 0, unit: "fr", width: 72,
      title: "Output frames from IN. Under a snap rule it steps to the counts the model keeps (97, 105, ... for 8n+1).",
      onChange: (next) => {
        const current = adoptLength(plan());
        if (current.mode !== "length") { sync(); return; }
        const was = current.requested ?? get("max_frames", 1);
        set("max_frames", snapToValid(next, snapRule(), Math.sign(next - was)));
        set("end_seconds", 0);
        sync();
      },
      onSettle: () => { const window = currentWindow(); seek(window.last, true); onCommit?.(); },
    });
    label.append(pill, count.root);
    lengthRow.append(label, hint);
    root.append(lengthRow);
    syncLength = (current, wired) => {
      const active = current.mode !== "free";
      const blocked = current.mode === "wired";
      off.classList.toggle("on", !active);
      on.classList.toggle("on", active);
      off.setAttribute("aria-pressed", String(!active));
      on.setAttribute("aria-pressed", String(active));
      pill.classList.toggle("is-disabled", blocked);
      off.disabled = on.disabled = blocked;
      pill.title = blocked ? lockTip("end") : "";
      count.root.style.display = active ? "" : "none";
      const step = snapStep(snapRule());
      count.setStep(step, step);
      count.set(blocked ? (current.frames ?? current.requested ?? 0) : (current.requested ?? get("max_frames", 1)));
      disableControl(count, blocked, lockTip("end"));
      const fills = lengthFillsClip(info(), current, everyNth());
      hint.textContent = blocked ? `from ${wired}` : current.mode === "fixed" ? "exact (older setting)" : fills ? "= the whole clip. Shorten it to move IN" : active ? "" : "OUT ends the clip";
      hint.classList.toggle("note", fills && !blocked);
      hint.title = fills && !blocked ? `The Length (${current.requested ?? current.frames} frames) covers the whole clip, so IN and the clip cannot move. The bar still scrubs.` : "";
    };
  }

  if (trim) {
    const sampling = el("div", "qgtools-transform-trim-line wrap");
    const nthLabel = el("label", "", "Every nth");
    controls.every_nth = makeScrubInput({ value: get("every_nth", 1), min: 1, max: 512, step: 1, decimals: 0,
      title: "Keep one frame in this many. Output fps is adjusted to keep real-time playback; a Length counts the frames kept.",
      onChange: (next) => { if (!driven("every_nth")) set("every_nth", next); sync(); }, onSettle: onCommit,
    });
    nthLabel.append(controls.every_nth.root);
    sampling.append(nthLabel, el("span", "spacer"));
    if (has("frame_snap")) {
      // Video models keep 8n+1 (LTX) or 4n+1 (Wan) frames and drop the
      // rest; snapping here keeps the clip, its audio, and its stitcher the
      // same length as what comes back from the sampler.
      const label = el("label", "", "Frames for");
      label.style.marginLeft = "auto";
      const select = el("select");
      // The stored values stay free / 8n+1 / 4n+1; only the words change.
      for (const [rule, words] of [["free", "any"], ["8n+1", "LTX (8n+1)"], ["4n+1", "Wan (4n+1)"]]) {
        const option = el("option", "", words); option.value = rule; select.append(option);
      }
      select.addEventListener("change", () => {
        set("frame_snap", select.value);
        // A Length moves to the nearest count the new rule keeps.
        if (plan()?.mode === "length") set("max_frames", snapToValid(get("max_frames", 1), select.value));
        sync(); onCommit?.();
      });
      controls.frame_snap = select;
      label.append(select);
      sampling.append(label);
    }
    const footer = el("div", "qgtools-transform-trim-line");
    const reset = el("button", "qgtools-transform-trim-reset", "Full clip");
    controls.reset = reset;
    reset.type = "button";
    reset.addEventListener("click", () => {
      const current = plan();
      if (current.mode === "free") {
        if (!locked("start")) set("start_seconds", 0);
        if (!locked("end")) set("end_seconds", 0);
        sync(); onCommit?.();
      } else {
        moveEdge("start", 0, true);
      }
    });
    footer.append(summary, reset);
    root.append(sampling, footer);
  }
  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,input,select")) event.stopPropagation();
  });
  sync();
  return { root, sync, info, window: currentWindow, moveEdge, plan };
}

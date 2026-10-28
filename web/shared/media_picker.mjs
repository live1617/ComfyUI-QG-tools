// Media picker: the Source list of the nodes that load a file from
// ComfyUI's input folder (Load Image + Pad, Load Video, the crop / rotate /
// pad editors). A native <select> draws its option list itself, so hovering
// a name there has no events and nothing to show - you pick by filename
// alone. This list previews the file under the pointer (or the arrow keys)
// beside it, a picture for images and a muted loop for videos, and narrows
// as you type.
//
// The combo widget stays the single source of truth: the picker reads its
// options when it opens and hands the chosen value back through onChange.
// Pure decisions live in media_list.mjs for node:test; this file is the DOM.

import { BRAND } from "./index.mjs?v=2026102706";
import { isAppShortcut, keepKeyInField } from "./canvas_passthrough.mjs?v=2026102706";
import { filterMedia, mediaLabel, moveHighlight } from "./media_list.mjs?v=2026102706";
import { zh } from "./zh.mjs?v=2026102706";

const CSS_ID = "qgtools-media-picker-css";
const LIST_CAP = 400; // a crowded input folder shows this many; typing narrows it
const PREVIEW_DELAY_MS = 70; // skimming down the list does not start a load per row
const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

let openMenu = null;

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-media-pick{display:flex;align-items:center;min-width:0;text-align:left;cursor:pointer}
.qgtools-media-pick-text{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.qgtools-media-pick-text.empty{color:#6f8886;font-weight:500}
.qgtools-media-pick.open{border-color:${BRAND}}
.qgtools-media-menu{position:fixed;z-index:10000;display:flex;gap:8px;padding:6px;border:1px solid #3a4047;border-radius:8px;background:#1c1f23;box-shadow:0 10px 32px rgba(0,0,0,.55);color:#d7dde2;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.qgtools-media-col{display:flex;flex-direction:column;gap:6px;width:280px;min-width:0}
.qgtools-media-filter{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid #2a3437;border-radius:6px;outline:0;background:#0b0f10;color:#eef7f6;font:12px ${MONO}}
.qgtools-media-filter:focus{border-color:${BRAND}}
.qgtools-media-list{max-height:min(320px,50vh);overflow:auto;overscroll-behavior:contain}
.qgtools-media-item{display:flex;min-width:0;padding:5px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;font:12px ${MONO}}
.qgtools-media-item.hot{background:#2c3238;color:#fff}
.qgtools-media-item.current .qgtools-media-name{color:${BRAND}}
.qgtools-media-folder{flex:none;color:#6f8886}
.qgtools-media-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.qgtools-media-more{padding:6px 8px;color:#6f8886;font-size:11px}
.qgtools-media-pane{display:flex;flex-direction:column;gap:6px;width:240px}
.qgtools-media-stage{display:flex;align-items:center;justify-content:center;height:240px;overflow:hidden;border:1px solid #2a3437;border-radius:6px;background:#0b0f10 repeating-conic-gradient(#151a1c 0 25%,#0b0f10 0 50%) 0 0/16px 16px}
.qgtools-media-stage img,.qgtools-media-stage video{display:block;max-width:100%;max-height:100%;object-fit:contain}
.qgtools-media-caption{min-height:14px;color:#8ba3a1;font:11px ${MONO};text-align:center}
.qgtools-media-note{padding:0 12px;color:#6f8886;font-size:11px;text-align:center}
`;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function closeMediaMenu() {
  openMenu?.close();
}

/**
 * @param {object} options
 * @param {"image"|"video"} options.kind what the list holds; videos preview as a muted loop
 * @param {string} [options.className] extra classes for the button, e.g. the look of the select it replaces
 * @param {string} options.placeholder button text when nothing is chosen
 * @param {(value: string) => string} options.viewUrl URL that serves one value (ComfyUI's /view)
 * @param {() => unknown[]} options.getOptions the combo's current values, read on open
 * @param {() => unknown} options.getValue the chosen value
 * @param {(value: string) => void} options.onChange writes a newly chosen value back to the widget
 * @param {string} [options.label] accessible name
 */
export function createMediaPicker({ kind = "image", className = "", placeholder, viewUrl, getOptions, getValue, onChange, label }) {
  ensureCss();
  const noun = kind === "video" ? "video" : "image";
  const button = el("button", `qgtools-media-pick ${className}`.trim());
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  if (label) button.setAttribute("aria-label", label);
  const text = el("span", "qgtools-media-pick-text");
  button.append(text);

  const refresh = (value = getValue()) => {
    const shown = value == null ? "" : String(value);
    text.textContent = shown || placeholder;
    text.classList.toggle("empty", !shown);
    // Only the "Click to choose…" line is composed; the placeholder came in
    // already translated from the caller. A title written here lands after
    // insertion, which the zh plugin's DOM pass never revisits.
    button.title = shown
      ? `${shown}\n${zh(kind === "video" ? "Click to choose another video" : "Click to choose another image")}`
      : placeholder;
  };

  const open = () => {
    closeMediaMenu();
    const all = (getOptions() || []).map(String);
    const current = String(getValue() ?? "");
    const menu = el("div", "qgtools-media-menu");
    const column = el("div", "qgtools-media-col");
    const filter = el("input", "qgtools-media-filter");
    filter.type = "text";
    filter.spellcheck = false;
    // Counted sentences and per-kind wording, both spelled out as whole
    // literals: the zh dictionary matches whole strings, so every key has to
    // appear verbatim in the source (tools/verify_i18n.py asserts it).
    const filterHint = all.length === 1
      ? (kind === "video" ? "Filter {a} video…" : "Filter {a} image…")
      : (kind === "video" ? "Filter {a} videos…" : "Filter {a} images…");
    filter.placeholder = all.length
      ? zh(filterHint).replace("{a}", String(all.length))
      : zh(kind === "video" ? "No videos in the input folder" : "No images in the input folder");
    filter.setAttribute("aria-label", zh(kind === "video" ? "Filter videos" : "Filter images"));
    const list = el("div", "qgtools-media-list");
    list.setAttribute("role", "listbox");
    column.append(filter, list);
    const pane = el("div", "qgtools-media-pane");
    const stage = el("div", "qgtools-media-stage");
    const caption = el("div", "qgtools-media-caption");
    pane.append(stage, caption);
    menu.append(column, pane);

    let shown = [];
    const items = [];
    let highlight = -1;
    let timer = null;
    let serial = 0;

    const showPreview = (value) => {
      const mine = ++serial;
      stage.replaceChildren();
      caption.textContent = "";
      if (value == null) return;
      const failed = () => {
        if (mine !== serial) return;
        stage.replaceChildren(el("div", "qgtools-media-note", zh(kind === "video" ? "Can't preview this video" : "Can't preview this image")));
      };
      if (kind === "video") {
        const video = document.createElement("video");
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = "auto";
        video.addEventListener("loadedmetadata", () => {
          if (mine !== serial) return;
          const seconds = Number.isFinite(video.duration) ? ` · ${video.duration.toFixed(1)} s` : "";
          caption.textContent = `${video.videoWidth} × ${video.videoHeight}${seconds}`;
        });
        video.addEventListener("error", failed);
        video.src = viewUrl(value);
        stage.append(video);
      } else {
        const image = new Image();
        image.decoding = "async";
        image.alt = "";
        image.addEventListener("load", () => {
          if (mine === serial) caption.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
        });
        image.addEventListener("error", failed);
        image.src = viewUrl(value);
        stage.append(image);
      }
    };

    const setHighlight = (index, scroll) => {
      if (index === highlight) return;
      items[highlight]?.classList.remove("hot");
      highlight = index;
      clearTimeout(timer);
      const item = items[index];
      if (!item) {
        showPreview(null);
        return;
      }
      item.classList.add("hot");
      if (scroll) item.scrollIntoView({ block: "nearest" });
      const value = shown[index];
      timer = setTimeout(() => showPreview(value), PREVIEW_DELAY_MS);
    };

    const render = () => {
      shown = filterMedia(all, filter.value);
      list.replaceChildren();
      items.length = 0;
      highlight = -1;
      for (const value of shown.slice(0, LIST_CAP)) {
        const { folder, name } = mediaLabel(value);
        const item = el("div", "qgtools-media-item");
        item.setAttribute("role", "option");
        item.title = value;
        if (value === current) {
          item.classList.add("current");
          item.setAttribute("aria-selected", "true");
        }
        if (folder) item.append(el("span", "qgtools-media-folder", folder));
        item.append(el("span", "qgtools-media-name", name));
        const index = items.length;
        item.addEventListener("mousemove", () => setHighlight(index, false));
        item.addEventListener("click", () => choose(value));
        list.append(item);
        items.push(item);
      }
      if (shown.length > LIST_CAP) {
        const over = el("div", "qgtools-media-more", String(shown.length - LIST_CAP));
        over.append(" more · type to narrow");
        list.append(over);
      }
      if (!shown.length) {
        const hint = all.length ? "No matches"
          : noun === "video" ? "Upload a video and it shows up here"
          : "Upload an image and it shows up here";
        list.append(el("div", "qgtools-media-more", hint));
      }
      const start = shown.indexOf(current);
      setHighlight(start >= 0 && start < items.length ? start : items.length ? 0 : -1, true);
      if (!items.length) showPreview(null);
    };

    const abort = new AbortController();
    const close = () => {
      clearTimeout(timer);
      abort.abort();
      menu.querySelector("video")?.pause();
      menu.remove();
      button.classList.remove("open");
      if (openMenu?.menu === menu) openMenu = null;
    };
    const choose = (value) => {
      close();
      if (value !== String(getValue() ?? "")) onChange(value);
      refresh(value);
      button.focus();
    };

    filter.addEventListener("input", render);
    filter.addEventListener("keydown", (event) => {
      keepKeyInField(event); // typing and editing keys stay in the filter (Delete, Ctrl+A…)
      if (isAppShortcut(event)) return; // Ctrl + Enter runs the workflow, it does not pick
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
      if (step) {
        event.preventDefault();
        setHighlight(moveHighlight(highlight, step, items.length), true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (highlight >= 0) choose(shown[highlight]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
        button.focus();
      }
    });
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());
    const outside = (event) => !menu.contains(event.target) && !button.contains(event.target);
    window.addEventListener("pointerdown", (event) => { if (outside(event)) close(); }, { capture: true, signal: abort.signal });
    window.addEventListener("wheel", (event) => { if (outside(event)) close(); }, { capture: true, passive: true, signal: abort.signal });
    window.addEventListener("resize", close, { signal: abort.signal });
    window.addEventListener("blur", close, { signal: abort.signal });

    openMenu = { owner: button, menu, close };
    button.classList.add("open");
    document.body.append(menu);
    render();
    // Under the button, or above it when the window runs out; kept on screen.
    const box = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let top = box.bottom + 4;
    if (top + height > window.innerHeight - 8 && box.top - height - 4 >= 8) top = box.top - height - 4;
    menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    filter.focus();
  };

  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", () => (openMenu?.owner === button ? openMenu.close() : open()));
  refresh();

  const closeOwn = () => {
    if (openMenu?.owner === button) openMenu.close();
  };
  return { element: button, refresh, close: closeOwn, dispose: closeOwn };
}

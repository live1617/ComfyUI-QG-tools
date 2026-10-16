// Workflow Note 🆎 — the card that makes a shared workflow self-explanatory.
//
// One hidden STRING widget holds the card as JSON (title, subtitle, author,
// Markdown body, model rows, node-pack rows, links). This file renders it
// on the node face, checks every model file and node pack against this
// install, and opens the editor dialog. All parsing and the model match
// live in js/shared/workflow_note.mjs under node:test.
//
// Safety: a downloaded workflow is someone else's text. Nothing here goes
// through innerHTML - every string becomes a text node - and only http(s)
// URLs become buttons or links (the parser already filtered them).

import { api } from "/scripts/api.js";
import { zh } from "../shared/zh.mjs?v=2026101601";
import { app } from "/scripts/app.js";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange } from "../shared/index.mjs?v=2026101601";
import { collectGraphNodes } from "../shared/appearance.mjs?v=2026101601";
import { copyToClipboard } from "../shared/clipboard.mjs?v=2026101601";
import { confirmDiscard } from "../shared/discard_prompt.mjs?v=2026101601";
import { WIDGET_FRAME, fillNodeHeight, holdNodeMinHeight } from "../shared/panel_layout.mjs?v=2026101601";
import { hideInputsInDef, hideWidget } from "../shared/widget_visibility.mjs?v=2026101601";
import {
  COMMON_FOLDERS,
  INPUT_FOLDER,
  LAYOUTS,
  MODEL_COLUMNS,
  groupModels,
  hostLabel,
  listedSpelling,
  loadersNeeding,
  loraRowsNeeding,
  matchInstalled,
  noteFit,
  noteIsEmpty,
  normalizeNote,
  packsFromGraph,
  parseMarkdown,
  rowFromCells,
  serializeNote,
  subfolderOf,
} from "../shared/workflow_note.mjs?v=2026101601";
import { comboValues, commitWidgetValue } from "../shared/widget_card_math.mjs?v=2026101601";
import { parseRows, serializeRows } from "../shared/lora_stack.mjs?v=2026101601";

const NODE_CLASS = "QG_WorkflowNote";
const CSS_ID = "qgtools-workflow-note-css";
const WIDGET_NAME = "qg_workflow_note_panel";
const PANEL_MIN_WIDTH = 300;
const CARD_MIN_HEIGHT = 160;
const BANNER_MIN_HEIGHT = 64;
const DEFAULT_SIZE = [520, 620];
const FOLDER_CACHE_MS = 30000;
// The classic canvas lays a node's first widget 2 px below its title. Only
// used before the node has been laid out once; after that the widget's own
// position is read.
const PANEL_TOP = 2;

// ---------------------------------------------------------------------------
// Server lookups, cached across every note on the canvas
// ---------------------------------------------------------------------------

const folderLists = new Map(); // dir -> { at, promise }
let modelFolders = null; // Promise<string[]> from GET /models

function listFolder(dir, fresh = false) {
  const cached = folderLists.get(dir);
  if (!fresh && cached && performance.now() - cached.at < FOLDER_CACHE_MS) return cached.promise;
  const promise = api
    .fetchApi(`/models/${encodeURIComponent(dir)}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((files) => (Array.isArray(files) ? files : null))
    .catch(() => null);
  folderLists.set(dir, { at: performance.now(), promise });
  return promise;
}

function inputExists(name) {
  const query = new URLSearchParams({ filename: name, type: "input" });
  return api
    .fetchApi(`/view?${query}`, { method: "HEAD" })
    .then((response) => response.ok)
    .catch(() => false);
}

function knownFolders() {
  modelFolders ??= api
    .fetchApi("/models")
    .then((response) => (response.ok ? response.json() : []))
    .then((list) => (Array.isArray(list) ? list.filter((item) => typeof item === "string") : []))
    .catch(() => []);
  return modelFolders;
}

function nodeTypeRegistered(type) {
  return Boolean(type && globalThis.LiteGraph?.registered_node_types?.[type]);
}

function moduleOfType(type) {
  return globalThis.LiteGraph?.registered_node_types?.[type]?.nodeData?.python_module;
}

// ---------------------------------------------------------------------------
// Pack repository URLs, cached for the whole page lifetime
// ---------------------------------------------------------------------------

const QG_REPOSITORY = "https://github.com/live1617/ComfyUI-QG-tools";

// Pack name -> repository URL. ComfyUI itself never hands out a pack's repo
// URL; the only local source is ComfyUI-Manager's index. Two rules, learned
// the hard way (v0.4.0 regression):
//   * skip_update=true is mandatory. Without it Manager runs its git update
//     check on the way out; every pack it flags "updatable" is appended to
//     Manager's startup queue and the next launch execv-restarts. A page
//     view must never have that side effect.
//   * even with the flag the endpoint still assembles a ~5 MB payload
//     server-side (measured 2.6 s here), so the lookup is lazy: it runs when
//     a note editor opens or "Detect" is pressed, never on page load.
let packUrlIndexPromise = null;
function packUrlsByName() {
  packUrlIndexPromise ??= (async () => {
    const index = new Map();
    for (const path of [
      "/api/customnode/getlist?mode=cache&skip_update=true",
      "/customnode/getlist?mode=cache&skip_update=true",
    ]) {
      try {
        const res = await api.fetchApi(path);
        if (!res.ok) continue;
        const packs = (await res.json())?.node_packs;
        if (!packs || typeof packs !== "object") continue;
        for (const [id, entry] of Object.entries(packs)) {
          const url = (Array.isArray(entry?.files) && entry.files[0]) || entry?.reference;
          if (typeof url !== "string" || !url) continue;
          for (const key of [id, entry?.title]) {
            if (typeof key === "string" && key) index.set(key.toLowerCase(), url);
          }
        }
        if (index.size) break;
      } catch (e) {
        // No Manager installed, or the API changed: URLs stay empty, the rest
        // of the detection still works.
      }
    }
    return index;
  })();
  return packUrlIndexPromise;
}
// No page-load warm-up on purpose. Warming right after page load was the
// v0.4.0 regression: every page view hit Manager's getlist without
// skip_update and refilled its restart queue. The note editor warms this on
// open (see the packUrlsByName() call in the editor builder) and "Detect
// from this workflow" awaits it, so nothing is lost by being lazy here.

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-note{box-sizing:border-box;width:100%;height:100%;padding:2px 6px 6px;pointer-events:none;overflow:hidden;--accent:${BRAND};}
.qgtools-note *{box-sizing:border-box;}
.qgtools-note-card{position:relative;display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;border:1px solid rgba(0,180,170,.27);border-radius:6px;background:rgba(0,0,0,.28);color:#c8dddd;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
.qgtools-note-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;pointer-events:auto;padding:0 0 8px;}
.qgtools-note-head{position:relative;padding:12px 40px 10px 16px;border-left:4px solid var(--accent);}
.qgtools-note-title{margin:0;color:#f2f8f8;font-size:22px;font-weight:700;line-height:1.15;letter-spacing:-.01em;overflow-wrap:anywhere;}
.qgtools-note-subtitle{margin:5px 0 0;color:#a9c4c2;font-size:12.5px;line-height:1.35;overflow-wrap:anywhere;}
.qgtools-note-author{margin:6px 0 0;color:#78908e;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;}
.qgtools-note.is-banner .qgtools-note-head{padding:14px 40px 14px 18px;}
.qgtools-note.is-banner .qgtools-note-title{font-size:28px;}
.qgtools-note-edit{position:absolute;top:8px;right:8px;width:24px;height:24px;border:1px solid transparent;border-radius:5px;background:transparent;color:#78908e;font-size:13px;line-height:1;cursor:pointer;pointer-events:auto;}
.qgtools-note-edit:hover{border-color:#3a4047;background:#23272c;color:#fff;}
.qgtools-note-empty{padding:14px 16px 4px;color:#78908e;font-size:11.5px;line-height:1.4;}
.qgtools-note-section{padding:8px 16px 0;}
.qgtools-note-section + .qgtools-note-section{margin-top:6px;border-top:1px solid rgba(255,255,255,.06);padding-top:10px;}
.qgtools-note-h{display:flex;align-items:center;gap:8px;margin:0 0 6px;color:#78908e;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;}
.qgtools-note-h .spacer{flex:1 1 auto;}
.qgtools-note-mini{height:18px;padding:0 7px;border:1px solid #3a4047;border-radius:4px;background:#23272c;color:#9ba2aa;font:10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.04em;text-transform:none;cursor:pointer;pointer-events:auto;}
.qgtools-note-mini:hover{border-color:var(--accent);color:#fff;}
.qgtools-note-body{user-select:text;-webkit-user-select:text;cursor:text;}
.qgtools-note-body p{margin:0 0 7px;overflow-wrap:anywhere;}
.qgtools-note-body h1,.qgtools-note-body h2,.qgtools-note-body h3{margin:8px 0 5px;color:#eaf4f3;font-weight:700;line-height:1.25;}
.qgtools-note-body h1{font-size:16px;}
.qgtools-note-body h2{font-size:14px;}
.qgtools-note-body h3{font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;color:#a9c4c2;}
.qgtools-note-body ul,.qgtools-note-body ol{margin:0 0 7px;padding-left:20px;}
.qgtools-note-body li{margin:2px 0;overflow-wrap:anywhere;}
.qgtools-note-body hr{margin:8px 0;border:0;border-top:1px solid rgba(255,255,255,.08);}
.qgtools-note-body code{padding:1px 4px;border-radius:3px;background:rgba(255,255,255,.08);font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6f4f3;}
.qgtools-note-body pre{margin:0 0 7px;padding:7px 9px;overflow-x:auto;border-radius:5px;background:rgba(0,0,0,.35);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6f4f3;white-space:pre;}
.qgtools-note-body a,.qgtools-note-link{color:var(--accent);text-decoration:none;pointer-events:auto;}
.qgtools-note-body a:hover,.qgtools-note-link:hover{text-decoration:underline;}
.qgtools-note-folder{margin:8px 0 4px;color:#a9c4c2;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.qgtools-note-folder:first-child{margin-top:0;}
.qgtools-note-row{display:flex;align-items:center;gap:8px;min-height:30px;padding:3px 0;}
.qgtools-note-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#4b5a5a;}
.qgtools-note-dot.checking{background:#4b5a5a;animation:qgtools-note-pulse 1s ease-in-out infinite;}
.qgtools-note-dot.ok{background:var(--accent);box-shadow:0 0 5px rgba(0,180,170,.55);}
.qgtools-note-dot.missing{background:#e0564b;box-shadow:0 0 5px rgba(224,86,75,.5);}
.qgtools-note-dot.unknown{background:#4b5a5a;}
@keyframes qgtools-note-pulse{0%,100%{opacity:.35;}50%{opacity:1;}}
.qgtools-note-file{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}
.qgtools-note-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#e6f4f3;font:11.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:auto;cursor:copy;}
.qgtools-note-meta{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#78908e;font-size:10.5px;}
.qgtools-note-dl{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border:1px solid var(--accent);border-radius:5px;background:rgba(0,180,170,.14);color:#e6f4f3;font-size:11px;font-weight:600;text-decoration:none;white-space:nowrap;pointer-events:auto;cursor:pointer;}
.qgtools-note-dl:hover{background:var(--accent);color:#08211f;}
.qgtools-note-dl .size{font-weight:400;opacity:.8;}
.qgtools-note-pill{flex:none;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:11px;background:rgba(0,180,170,.16);color:#9fe3dc;font-size:10.5px;white-space:nowrap;}
.qgtools-note-pill.missing{background:rgba(224,86,75,.16);color:#f0a59e;}
.qgtools-note-pill.elsewhere{background:rgba(255,196,107,.14);color:#ffd79a;}
.qgtools-note-action{flex:none;display:inline-flex;align-items:center;gap:6px;}
.qgtools-note-use{flex:none;height:22px;padding:0 9px;border:1px solid #ffc46b;border-radius:5px;background:rgba(255,196,107,.12);color:#ffe3b0;font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;pointer-events:auto;}
.qgtools-note-use:hover{background:#ffc46b;color:#2a1d05;}
.qgtools-note-pill a{color:inherit;text-decoration:none;pointer-events:auto;}
.qgtools-note-pill a:hover{text-decoration:underline;}
.qgtools-note-chips{display:flex;flex-wrap:wrap;gap:6px;}
.qgtools-note-chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px solid #3a4047;border-radius:12px;background:#23272c;color:#d7dde2;font-size:11px;text-decoration:none;white-space:nowrap;pointer-events:auto;}
.qgtools-note-chip:hover{border-color:var(--accent);color:#fff;}
/* editor dialog */
.qgtools-note-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}
.qgtools-note-dialog{display:flex;flex-direction:column;width:min(860px,94vw);max-height:92vh;border:1px solid #3a4047;border-radius:9px;background:#1c1f23;box-shadow:0 12px 40px rgba(0,0,0,.6);color:#d7dde2;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
.qgtools-note-dialog *{box-sizing:border-box;}
.qgtools-note-dhead{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #2c3238;color:${BRAND};font-weight:600;}
.qgtools-note-dhead .spacer{flex:1 1 auto;}
.qgtools-note-dbody{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;}
.qgtools-note-dfoot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid #2c3238;}
.qgtools-note-dfoot .spacer{flex:1 1 auto;}
.qgtools-note-field{display:flex;flex-direction:column;gap:4px;}
.qgtools-note-field > label{color:#9ba2aa;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}
.qgtools-note-field .hint{color:#78908e;font-size:10.5px;}
.qgtools-note-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.qgtools-note-dialog input,.qgtools-note-dialog textarea,.qgtools-note-dialog select{width:100%;padding:5px 8px;border:1px solid #3a4047;border-radius:5px;background:#23272c;color:#e6f4f3;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none;}
.qgtools-note-dialog textarea{min-height:120px;resize:vertical;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.qgtools-note-dialog textarea.json{min-height:320px;}
.qgtools-note-dialog input:focus,.qgtools-note-dialog textarea:focus,.qgtools-note-dialog select:focus{border-color:${BRAND};}
.qgtools-note-table{display:flex;flex-direction:column;gap:4px;}
.qgtools-note-trow{display:grid;gap:6px;align-items:center;}
.qgtools-note-trow.models{grid-template-columns:minmax(120px,1.5fr) 130px 70px minmax(100px,1fr) minmax(100px,1fr) 24px;}
.qgtools-note-trow.packs{grid-template-columns:minmax(120px,1fr) minmax(120px,1.4fr) minmax(120px,1fr) 24px;}
.qgtools-note-trow.links{grid-template-columns:minmax(120px,1fr) minmax(120px,2fr) 24px;}
.qgtools-note-trow.head{color:#78908e;font-size:10px;letter-spacing:.06em;text-transform:uppercase;}
.qgtools-note-x{width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:#9ba2aa;cursor:pointer;}
.qgtools-note-x:hover{border-color:#3a4047;color:#fff;}
.qgtools-note-btn{height:26px;padding:0 10px;border:1px solid #3a4047;border-radius:5px;background:#23272c;color:#d7dde2;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;}
.qgtools-note-btn:hover{border-color:${BRAND};color:#fff;}
.qgtools-note-btn.primary{border-color:${BRAND};background:${BRAND};color:#08211f;font-weight:600;}
.qgtools-note-btn.primary:hover{background:#19c9be;}
.qgtools-note-seg{display:inline-flex;border:1px solid #3a4047;border-radius:5px;overflow:hidden;}
.qgtools-note-seg button{height:26px;padding:0 10px;border:none;background:#23272c;color:#9ba2aa;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;}
.qgtools-note-seg button + button{border-left:1px solid #3a4047;}
.qgtools-note-seg button.on{background:${BRAND};color:#08211f;font-weight:600;}
.qgtools-note-error{color:#f0a59e;font-size:11px;}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function externalLink(url, className, text) {
  const link = el("a", className, text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  // A click on a link must not become a node drag.
  link.addEventListener("pointerdown", (event) => event.stopPropagation());
  return link;
}

function spansInto(parent, spans) {
  for (const span of spans) {
    if (span.type === "br") parent.append(document.createElement("br"));
    else if (span.type === "strong") parent.append(el("strong", "", span.text));
    else if (span.type === "em") parent.append(el("em", "", span.text));
    else if (span.type === "code") parent.append(el("code", "", span.text));
    else if (span.type === "link") parent.append(externalLink(span.url, "", span.text));
    else parent.append(document.createTextNode(span.text));
  }
}

function markdownInto(parent, text) {
  for (const block of parseMarkdown(text)) {
    if (block.type === "heading") {
      const heading = el(`h${block.level}`);
      spansInto(heading, block.spans);
      parent.append(heading);
    } else if (block.type === "list") {
      const list = el(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = el("li");
        spansInto(li, item);
        list.append(li);
      }
      parent.append(list);
    } else if (block.type === "hr") parent.append(el("hr"));
    else if (block.type === "code") parent.append(el("pre", "", block.text));
    else {
      const paragraph = el("p");
      spansInto(paragraph, block.spans);
      parent.append(paragraph);
    }
  }
}

async function copyText(text, element) {
  const copied = await copyToClipboard(text);
  // A blocked clipboard says so; the name is still on screen to copy by hand.
  const note = copied ? "copied" : "copy blocked";
  const before = element.textContent;
  element.textContent = note;
  setTimeout(() => { if (element.textContent === note) element.textContent = before; }, copied ? 700 : 1400);
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function setDot(dot, status, title) {
  dot.className = `qgtools-note-dot ${status}`;
  dot.title = title ?? "";
}

function modelRow(state, row) {
  const line = el("div", "qgtools-note-row");
  const dot = el("span", "qgtools-note-dot checking");
  const file = el("div", "qgtools-note-file");
  const name = el("div", "qgtools-note-name", row.name);
  name.title = `${row.name} - click to copy the file name`;
  name.addEventListener("pointerdown", (event) => event.stopPropagation());
  name.addEventListener("click", () => copyText(row.name, name));
  file.append(name);
  const metaBits = [];
  if (row.note) metaBits.push(row.note);
  const meta = el("div", "qgtools-note-meta", metaBits.join(" · "));
  if (metaBits.length) file.append(meta);
  const action = el("span", "qgtools-note-action");
  line.append(dot, file, action);

  const showDownload = () => {
    action.textContent = "";
    if (row.url) {
      const button = externalLink(row.url, "qgtools-note-dl", "");
      button.append(document.createTextNode("Download"));
      if (row.size) button.append(el("span", "size", row.size));
      button.title = `Opens ${hostLabel(row.url) || row.url} in a new tab`;
      action.append(button);
    } else if (row.size) {
      action.append(el("span", "qgtools-note-meta", row.size));
    }
  };
  const showInstalled = (path) => {
    action.textContent = "";
    const pill = el("span", "qgtools-note-pill");
    pill.append(document.createTextNode("✓ installed"));
    if (row.url) {
      const link = externalLink(row.url, "", "↗");
      link.title = `Source: ${hostLabel(row.url) || row.url}`;
      pill.append(link);
    }
    pill.title = path ? `Found: ${path}` : "Found";
    action.append(pill);
  };
  // The file is here, but in a subfolder, and a loader still asks for the
  // bare name: ComfyUI marks that loader red. Use it points the loaders at
  // the copy that was found. LoRA Loader rows get the same button: that
  // loader finds the file by its name when it runs, and the row then holds
  // the real path.
  const showElsewhere = (path, loaders, loraRows = [], files = []) => {
    action.textContent = "";
    const folder = subfolderOf(path);
    const pill = el("span", "qgtools-note-pill elsewhere", `in ${folder}/`);
    const asking = [...loaders, ...loraRows];
    const names = [...new Set(asking.map((entry) => entry.node.title || entry.node.type))].join(", ");
    pill.title = loaders.length
      ? `Found as ${path}, but ${names} ${asking.length === 1 ? "asks" : "ask"} for ${row.name}, which ComfyUI cannot find.`
      : `Found as ${path}. ${names} still ${asking.length === 1 ? "has" : "have"} it as ${row.name} and will find it by name.`;
    const use = el("button", "qgtools-note-use", "Use it");
    use.type = "button";
    use.title = `Point ${names} at ${path}.`;
    use.addEventListener("pointerdown", (event) => event.stopPropagation());
    use.addEventListener("click", () => {
      for (const entry of loaders) {
        commitWidgetValue(entry.node, entry.widget, listedSpelling(path, entry.options), app.canvas);
        entry.node.setDirtyCanvas?.(true, true);
      }
      const stacks = new Map();
      for (const entry of loraRows) stacks.set(entry.widget, [...(stacks.get(entry.widget) ?? []), entry]);
      for (const [widget, entries] of stacks) {
        const rows = parseRows(widget.value);
        for (const entry of entries) {
          if (rows[entry.index]) rows[entry.index] = { ...rows[entry.index], name: listedSpelling(path, files) };
        }
        commitWidgetValue(entries[0].node, widget, serializeRows(rows), app.canvas);
        entries[0].node.setDirtyCanvas?.(true, true);
      }
      app.graph?.setDirtyCanvas?.(true, true);
      notifyQgChange();
      checkModels(state, false);
    });
    action.append(pill, use);
  };
  showDownload();
  state.rows.push({ row, dot, showDownload, showInstalled, showElsewhere });
  return line;
}

function packRow(state, row) {
  const line = el("div", "qgtools-note-row");
  const dot = el("span", "qgtools-note-dot unknown");
  const file = el("div", "qgtools-note-file");
  const name = el("div", "qgtools-note-name", row.name);
  name.style.cursor = "default";
  file.append(name);
  const action = el("span");
  line.append(dot, file, action);
  const installed = row.node ? nodeTypeRegistered(row.node) : null;
  if (installed === true) {
    setDot(dot, "ok", `${row.node} is registered on this install`);
    const pill = el("span", "qgtools-note-pill", "✓ installed");
    if (row.url) {
      const link = externalLink(row.url, "", "↗");
      link.title = row.url;
      pill.append(link);
    }
    action.append(pill);
  } else {
    setDot(dot, installed === false ? "missing" : "unknown",
      installed === false ? `${row.node} is not registered here - install the pack` : "No probe node set, so this row is not checked");
    if (row.url) {
      const button = externalLink(row.url, "qgtools-note-dl", installed === false ? "Get it" : "Open");
      button.title = row.url;
      action.append(button);
    } else if (installed === false) {
      action.append(el("span", "qgtools-note-pill missing", "missing"));
    }
  }
  return line;
}

function sectionHeading(text) {
  const heading = el("div", "qgtools-note-h");
  heading.append(el("span", "", text), el("span", "spacer"));
  return heading;
}

// The frontend hangs a "which pack" badge above every custom node. On a
// banner - a title label for a column or stage - it floats in space, so
// the banner layout hides it and the card layout puts it back.
function setBadgesHidden(node, hidden) {
  if (hidden === Boolean(node.__qgBadgesHidden)) return;
  try {
    if (hidden) {
      node.__qgBadgeStash = node.badges;
      Object.defineProperty(node, "badges", { configurable: true, get: () => [], set: () => {} });
    } else {
      delete node.badges;
      node.badges = node.__qgBadgeStash ?? [];
    }
    node.__qgBadgesHidden = hidden;
  } catch {
    // A frozen node keeps its badge; nothing else depends on this.
  }
}

function render(state) {
  const { note } = state;
  const root = state.root;
  root.classList.toggle("is-banner", note.layout === "banner");
  setBadgesHidden(state.node, note.layout === "banner" && !noteIsEmpty(note));
  root.style.setProperty("--accent", note.accent || BRAND);
  const scroll = state.scroll;
  scroll.textContent = "";
  state.rows = [];

  const head = el("div", "qgtools-note-head");
  head.append(el("h1", "qgtools-note-title", note.title || "Untitled workflow"));
  if (note.subtitle) head.append(el("p", "qgtools-note-subtitle", note.subtitle));
  if (note.author) head.append(el("p", "qgtools-note-author", `by ${note.author}`));
  const edit = el("button", "qgtools-note-edit", "✎");
  edit.type = "button";
  edit.title = zh("Edit this note");
  edit.addEventListener("pointerdown", (event) => event.stopPropagation());
  edit.addEventListener("click", () => openEditor(state));
  head.append(edit);
  scroll.append(head);

  if (noteIsEmpty(note)) {
    scroll.append(el("div", "qgtools-note-empty",
      "Click ✎ to give this workflow a title, a how-to, the models it needs with download links, and your own links."));
    state.domWidget.options.getMinHeight = () => CARD_MIN_HEIGHT + WIDGET_FRAME;
    return;
  }
  if (note.layout === "banner") {
    state.domWidget.options.getMinHeight = () => BANNER_MIN_HEIGHT + WIDGET_FRAME;
    return;
  }
  state.domWidget.options.getMinHeight = () => CARD_MIN_HEIGHT + WIDGET_FRAME;

  if (note.body.trim()) {
    const section = el("div", "qgtools-note-section");
    const body = el("div", "qgtools-note-body");
    body.addEventListener("pointerdown", (event) => event.stopPropagation());
    markdownInto(body, note.body);
    section.append(body);
    scroll.append(section);
  }

  if (note.models.length) {
    const section = el("div", "qgtools-note-section");
    const heading = sectionHeading("Models");
    const recheck = el("button", "qgtools-note-mini", "↻ check files");
    recheck.type = "button";
    recheck.title = zh("Look for each file again (after moving files in, or pressing R)");
    recheck.addEventListener("pointerdown", (event) => event.stopPropagation());
    recheck.addEventListener("click", () => checkModels(state, true));
    heading.append(recheck);
    section.append(heading);
    for (const group of groupModels(note.models)) {
      section.append(el("div", "qgtools-note-folder", `📂 ${group.path}`));
      for (const row of group.rows) section.append(modelRow(state, row));
    }
    scroll.append(section);
  }

  if (note.packs.length) {
    const section = el("div", "qgtools-note-section");
    section.append(sectionHeading("Node packs"));
    for (const row of note.packs) section.append(packRow(state, row));
    scroll.append(section);
  }

  if (note.links.length) {
    const section = el("div", "qgtools-note-section");
    section.append(sectionHeading("Links"));
    const chips = el("div", "qgtools-note-chips");
    for (const row of note.links) {
      if (row.url) chips.append(externalLink(row.url, "qgtools-note-chip", row.label));
      else chips.append(el("span", "qgtools-note-chip", row.label));
    }
    section.append(chips);
    scroll.append(section);
  }

  checkModels(state, false);
}

async function checkModels(state, fresh) {
  const generation = (state.checkGeneration = (state.checkGeneration || 0) + 1);
  const rows = state.rows;
  for (const entry of rows) setDot(entry.dot, "checking", "checking…");
  const byDir = new Map();
  for (const entry of rows) {
    const dir = entry.row.dir;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(entry);
  }
  await Promise.all([...byDir.entries()].map(async ([dir, entries]) => {
    if (!dir) {
      for (const entry of entries) setDot(entry.dot, "unknown", "No folder set, so this file is not checked");
      return;
    }
    if (dir === INPUT_FOLDER) {
      await Promise.all(entries.map(async (entry) => {
        const found = await inputExists(entry.row.name);
        if (generation !== state.checkGeneration) return;
        if (found) {
          setDot(entry.dot, "ok", "Found in ComfyUI/input");
          entry.showInstalled(`input/${entry.row.name}`);
        } else {
          setDot(entry.dot, "missing", "Not in ComfyUI/input yet");
          entry.showDownload();
        }
      }));
      return;
    }
    const files = await listFolder(dir, fresh);
    if (generation !== state.checkGeneration) return;
    for (const entry of entries) {
      if (files === null) {
        setDot(entry.dot, "unknown", `This install has no "${dir}" model folder, so the file is not checked`);
        entry.showDownload();
        continue;
      }
      const match = matchInstalled(entry.row.name, files);
      const elsewhere = match.found && subfolderOf(match.path);
      const loaders = elsewhere ? loadersNeeding(entry.row.name, match.path, graphListWidgets()) : [];
      const loraRows = elsewhere ? loraRowsNeeding(entry.row.name, match.path, graphLoraLoaders(), files) : [];
      if (match.found && (loaders.length || loraRows.length)) {
        setDot(entry.dot, "ok", `Found in ${subfolderOf(match.path)}/: ${match.path}`);
        entry.showElsewhere(match.path, loaders, loraRows, files);
      } else if (match.found) {
        setDot(entry.dot, "ok", `Found: ${match.path}`);
        entry.showInstalled(match.path);
      } else {
        setDot(entry.dot, "missing", `Not found in ComfyUI/models/${dir}`);
        entry.showDownload();
      }
    }
  }));
  if (generation === state.checkGeneration) fitNote(state);
}

// ---------------------------------------------------------------------------
// Fitting the node to the card (classic canvas)
// ---------------------------------------------------------------------------

// Nodes 2.0 sizes the node to the card by itself; the classic canvas keeps
// whatever height the workflow saved.
function classicCanvas() {
  return globalThis.LiteGraph?.vueNodesMode !== true;
}

// The card's natural height at a given width. For one read the card takes
// that width and drops its 100% heights, so the content lays out at full
// size with no scrollbar narrowing it; everything goes back before anything
// is painted. The width is the node's, not the frame's: the frame can still
// be a few pixels wide in the moment after it first appears.
function naturalHeight(state, width) {
  const { root, card } = state;
  root.style.width = `${width}px`;
  root.style.height = "auto";
  card.style.height = "auto";
  const height = parseFloat(getComputedStyle(root).height);
  root.style.width = "";
  root.style.height = "";
  card.style.height = "";
  return Number.isFinite(height) && height > 0 ? height : null;
}

// Grow the node until the card shows everything, and remember that height
// as the node's floor. It never shrinks the node: a taller note keeps its
// empty space until someone drags it shorter.
function fitNote(state) {
  if (!classicCanvas()) return;
  const { node, root, domWidget } = state;
  const width = node.size[0] - WIDGET_FRAME;
  if (!(width > 0)) return;
  let natural;
  if (root.isConnected) natural = naturalHeight(state, width);
  else {
    // Not on the canvas yet - a workflow is loading. Lay the card out off
    // screen instead.
    const host = el("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
    host.append(root);
    document.body.append(host);
    natural = naturalHeight(state, width);
    root.remove();
    host.remove();
  }
  const top = Number.isFinite(domWidget.computedHeight) && Number.isFinite(domWidget.y) ? domWidget.y : PANEL_TOP;
  const { fit, grow } = noteFit({ natural, nodeHeight: node.size[1], chrome: top + WIDGET_FRAME });
  if (fit === null) return;
  state.fitHeight = fit;
  if (grow) {
    node.setSize([node.size[0], fit]);
    node.setDirtyCanvas?.(true, true);
  }
}

// Every list widget in the graph, subgraphs included: the loaders a found
// file could be handed to. Local only - the graph already holds each
// loader's choices, as ComfyUI's own server listed them.
function graphListWidgets() {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? graph.nodes ?? []) {
      for (const widget of node.widgets ?? []) {
        if (widget?.type !== "combo" || typeof widget.value !== "string") continue;
        out.push({ node, widget, value: widget.value, options: comboValues(widget) });
      }
      if (node.subgraph) walk(node.subgraph);
    }
  };
  walk(app.rootGraph ?? app.graph);
  return out;
}

// Every LoRA Loader in the graph, subgraphs included, with its rows. Its
// file names sit in the rows' text, not in a list widget.
function graphLoraLoaders() {
  const out = [];
  const seen = new Set();
  const walk = (graph) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? graph.nodes ?? []) {
      if (node.type === "QG_LoraLoader") {
        const widget = node.widgets?.find((item) => item.name === "loras");
        if (widget && typeof widget.value === "string") out.push({ node, widget, rows: parseRows(widget.value) });
      }
      if (node.subgraph) walk(node.subgraph);
    }
  };
  walk(app.rootGraph ?? app.graph);
  return out;
}

// ---------------------------------------------------------------------------
// The editor dialog
// ---------------------------------------------------------------------------

let openDialog = null;

function closeEditor() {
  if (!openDialog) return;
  openDialog.abort.abort();
  openDialog.element.remove();
  openDialog = null;
}

function field(labelText, control, hint) {
  const wrap = el("div", "qgtools-note-field");
  wrap.append(el("label", "", labelText), control);
  if (hint) wrap.append(el("span", "hint", hint));
  return wrap;
}

function input(value, placeholder) {
  const box = el("input");
  box.type = "text";
  box.value = value ?? "";
  if (placeholder) box.placeholder = placeholder;
  return box;
}

function folderSelect(value, folders) {
  const select = el("select");
  const options = [...folders];
  if (value && !options.includes(value)) options.push(value);
  if (!options.includes("")) options.unshift("");
  for (const folder of options) {
    const option = el("option", "", folder || "(folder)");
    option.value = folder;
    select.append(option);
  }
  select.value = value ?? "";
  return select;
}

// A small editable table. `columns` describes each cell; rows are plain
// objects and `read()` returns them back as edited.
function table(kind, columns, rows, makeRow) {
  const box = el("div", "qgtools-note-table");
  const head = el("div", `qgtools-note-trow ${kind} head`);
  for (const column of columns) head.append(el("span", "", column));
  head.append(el("span"));
  box.append(head);
  const body = el("div", "qgtools-note-table");
  box.append(body);
  const entries = [];
  const add = (row) => {
    const line = el("div", `qgtools-note-trow ${kind}`);
    const controls = makeRow(row ?? {});
    for (const control of controls) line.append(control);
    const remove = el("button", "qgtools-note-x", "✕");
    remove.type = "button";
    remove.title = zh("Remove this row");
    const entry = { line, controls };
    remove.addEventListener("click", () => {
      line.remove();
      entries.splice(entries.indexOf(entry), 1);
    });
    line.append(remove);
    body.append(line);
    entries.push(entry);
    return entry;
  };
  for (const row of rows) add(row);
  return { box, add, entries };
}

async function openEditor(state) {
  closeEditor();
  ensureCss();
  const folders = await knownFolders();
  const folderOptions = [...new Set([...COMMON_FOLDERS, ...folders])];
  const draft = normalizeNote(state.note);

  const overlay = el("div", "qgtools-note-overlay");
  const dialog = el("div", "qgtools-note-dialog");
  const head = el("div", "qgtools-note-dhead");
  head.append(el("span", "", "Workflow Note"), el("span", "spacer"));
  const jsonToggle = el("button", "qgtools-note-btn", "JSON");
  jsonToggle.type = "button";
  jsonToggle.title = zh("Edit the raw card JSON instead of the form");
  head.append(jsonToggle);
  const body = el("div", "qgtools-note-dbody");
  const foot = el("div", "qgtools-note-dfoot");
  const error = el("span", "qgtools-note-error");
  const cancel = el("button", "qgtools-note-btn", "Cancel");
  cancel.type = "button";
  const save = el("button", "qgtools-note-btn primary", "Save");
  save.type = "button";
  foot.append(error, el("span", "spacer"), cancel, save);
  dialog.append(head, body, foot);
  overlay.append(dialog);

  // --- form ---------------------------------------------------------------
  const form = el("div", "qgtools-note-dbody");
  form.style.padding = "0";
  form.style.overflow = "visible";
  const title = input(draft.title, "Krea 2 Outpaint");
  const subtitle = input(draft.subtitle, "One line on what this workflow does");
  const author = input(draft.author, "your name");
  const accent = input(draft.accent, "#00b4aa");
  let layout = draft.layout;
  const seg = el("div", "qgtools-note-seg");
  const segButtons = LAYOUTS.map((option) => {
    const button = el("button", option === layout ? "on" : "", option === "card" ? "Card" : "Banner");
    button.type = "button";
    button.addEventListener("click", () => {
      layout = option;
      segButtons.forEach((other, index) => other.classList.toggle("on", LAYOUTS[index] === option));
    });
    seg.append(button);
    return button;
  });
  const grid = el("div", "qgtools-note-grid");
  grid.append(
    field("Title", title),
    field("Author", author),
    field("Subtitle", subtitle),
    field("Layout", seg, "Banner shows only the title, subtitle and author - a label for a column or stage."),
    field("Accent color", accent, "Hex like #00b4aa; empty keeps the pack teal."),
  );
  form.append(grid);

  const bodyBox = el("textarea");
  bodyBox.value = draft.body;
  bodyBox.placeholder = "## How it works\n\n1. Load your image\n2. Drag the padding edges\n3. Queue\n\nMarkdown: # headings, **bold**, `code`, [links](https://...), - lists";
  form.append(field("How-to (Markdown)", bodyBox));

  const models = table("models", MODEL_COLUMNS.map((column) => column.label), draft.models, (row) =>
    MODEL_COLUMNS.map(({ key, placeholder }) => (key === "dir" ? folderSelect(row.dir, folderOptions) : input(row[key], placeholder))));
  const modelTools = el("div");
  const addModel = el("button", "qgtools-note-btn", "+ model");
  addModel.type = "button";
  addModel.addEventListener("click", () => models.add({ dir: "diffusion_models" }));
  modelTools.append(addModel);
  form.append(field("Models", models.box, "Each row shows a Download button until the file is found in its folder (subfolders count). The note shows in grey under the file name."), modelTools);

  // packUrlsByName() is the module-level single-flight lookup (see top of
  // file). This call warms it lazily: the first editor open pays the ~3 s
  // fetch once, later opens and "Detect" reuse the same promise.
  void packUrlsByName();

  const packs = table("packs", ["Pack", "URL", "Probe node class"], draft.packs, (row) => [
    input(row.name, "ComfyUI-QG-tools"),
    input(row.url, "https://github.com/user/repo"),
    input(row.node, "QG_LoraLoader"),
  ]);
  const packTools = el("div");
  packTools.style.display = "flex";
  packTools.style.gap = "6px";
  const addPack = el("button", "qgtools-note-btn", "+ pack");
  addPack.type = "button";
  addPack.addEventListener("click", () => packs.add({}));
  const detect = el("button", "qgtools-note-btn", "Detect from this workflow");
  detect.type = "button";
  detect.title = zh("List every custom node pack the open graph uses");
  detect.addEventListener("click", async () => {
    const types = collectGraphNodes(app.rootGraph ?? app.graph).map((node) => node.type);
    const have = new Set(packs.entries.map((entry) => entry.controls[0].value.trim()));
    // The Manager index is a ~5 MB payload assembled server-side on first
    // call; reflect that on the button instead of leaving it looking dead.
    // Restoring the text it had at click time keeps any translated label
    // intact.
    const idleText = detect.textContent;
    detect.disabled = true;
    detect.textContent = "Detecting…";
    try {
      // ComfyUI itself never exposes a pack's repository URL; the only local
      // source is ComfyUI-Manager's cached index (offline-friendly). Packs
      // that were never published get an empty URL.
      const known = await packUrlsByName();
      for (const pack of packsFromGraph(types, moduleOfType)) {
        if (have.has(pack.name)) continue;
        const url = pack.name === "ComfyUI-QG-tools"
          ? QG_REPOSITORY
          : known.get(pack.name.toLowerCase()) || "";
        packs.add(url ? { ...pack, url } : pack);
      }
    } finally {
      detect.disabled = false;
      detect.textContent = idleText;
    }
  });
  packTools.append(addPack, detect);
  form.append(field("Node packs", packs.box, "The probe node class is checked against this install; a missing one marks the pack missing."), packTools);

  const links = table("links", ["Label", "URL"], draft.links, (row) => [
    input(row.label, "GitHub"),
    input(row.url, "https://github.com/you"),
  ]);
  const linkTools = el("div");
  const addLink = el("button", "qgtools-note-btn", "+ link");
  addLink.type = "button";
  addLink.addEventListener("click", () => links.add({}));
  linkTools.append(addLink);
  form.append(field("Links", links.box, "Your pages: GitHub, Civitai, YouTube, Discord…"), linkTools);

  // --- raw JSON -------------------------------------------------------------
  const jsonBox = el("textarea", "json");
  let showingJson = false;

  const readForm = () => normalizeNote({
    title: title.value,
    subtitle: subtitle.value,
    author: author.value,
    body: bodyBox.value,
    layout,
    accent: accent.value,
    models: models.entries.map(({ controls }) => rowFromCells(MODEL_COLUMNS, controls.map((control) => control.value))),
    packs: packs.entries.map(({ controls }) => ({
      name: controls[0].value, url: controls[1].value, node: controls[2].value,
    })),
    links: links.entries.map(({ controls }) => ({ label: controls[0].value, url: controls[1].value })),
  });

  body.append(form);
  jsonToggle.addEventListener("click", () => {
    if (!showingJson) {
      jsonBox.value = JSON.stringify(readForm(), null, 2);
      body.textContent = "";
      body.append(field("Card JSON", jsonBox, "The exact text stored in the workflow. Save applies it."));
      jsonToggle.textContent = "Form";
    } else {
      // Going back to the form discards JSON edits that did not parse.
      try {
        const parsed = normalizeNote(JSON.parse(jsonBox.value));
        Object.assign(draft, parsed);
        closeEditor();
        state.note = parsed;
        openEditor(state);
        return;
      } catch {
        error.textContent = "That JSON does not parse - fix it or Cancel.";
        return;
      }
    }
    showingJson = !showingJson;
  });

  const commit = () => {
    let next;
    if (showingJson) {
      try {
        next = normalizeNote(JSON.parse(jsonBox.value));
      } catch {
        error.textContent = "That JSON does not parse - fix it or Cancel.";
        return;
      }
    } else next = readForm();
    state.note = next;
    state.valueWidget.value = serializeNote(next);
    closeEditor();
    render(state);
    fitNote(state);
    state.node.setDirtyCanvas?.(true, true);
    notifyQgChange();
  };
  // Every way out that is not Save asks first when the note changed, then
  // drops the draft, including one carried over by the JSON/Form toggle.
  const saved = () => JSON.stringify(normalizeNote(state.valueWidget.value));
  const changed = () => {
    if (!showingJson) return JSON.stringify(readForm()) !== saved();
    try { return JSON.stringify(normalizeNote(JSON.parse(jsonBox.value))) !== saved(); } catch { return true; }
  };
  let asking = false;
  const cancelEdits = async () => {
    if (asking) return;
    if (changed()) {
      asking = true;
      const discard = await confirmDiscard();
      asking = false;
      if (!discard) return;
    }
    state.note = normalizeNote(state.valueWidget.value);
    closeEditor();
  };
  save.addEventListener("click", commit);
  cancel.addEventListener("click", cancelEdits);

  const abort = new AbortController();
  // Keys typed into the dialog are the dialog's, not the canvas's shortcuts.
  overlay.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") void cancelEdits();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) commit();
  }, { signal: abort.signal });
  overlay.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (event.target === overlay) void cancelEdits();
  }, { signal: abort.signal });
  overlay.addEventListener("wheel", (event) => event.stopPropagation(), { signal: abort.signal });
  document.body.append(overlay);
  openDialog = { element: overlay, abort };
  title.focus();
}

// ---------------------------------------------------------------------------
// Node wiring
// ---------------------------------------------------------------------------

function buildPanel(node) {
  if (node.__qgNote) return node.__qgNote;
  ensureCss();
  const widget = node.widgets?.find((item) => item.name === "note");
  if (!widget) return null;
  hideWidget(widget);

  const root = el("div", "qgtools-note");
  const card = el("div", "qgtools-note-card");
  const scroll = el("div", "qgtools-note-scroll");
  card.append(scroll);
  root.append(card);
  // Selecting text or scrolling the card must not read as a node drag; a
  // press on empty card space still falls through to the canvas.
  scroll.addEventListener("pointerdown", (event) => {
    if (event.target !== scroll) event.stopPropagation();
  });

  const domWidget = node.addDOMWidget(WIDGET_NAME, "qg_workflow_note", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => CARD_MIN_HEIGHT + WIDGET_FRAME,
  });
  keepDomWidgetWidthAuto(domWidget);
  // Not saved with the workflow either: options.serialize only keeps it out
  // of the prompt, and saved values come back by position.
  domWidget.serialize = false;
  fillNodeHeight(domWidget, {
    minWidth: PANEL_MIN_WIDTH,
    minHeight: () => (domWidget.options.getMinHeight?.() ?? CARD_MIN_HEIGHT + WIDGET_FRAME),
    minNodeSize: [PANEL_MIN_WIDTH, 120],
    exactMinWidth: true,
  });

  // valueWidget is the hidden STRING (the storage the editor writes
  // through); domWidget is the panel the layout sizes.
  const state = (node.__qgNote = {
    node, domWidget, valueWidget: widget, root, card, scroll, rows: [],
    note: normalizeNote(widget.value),
  });
  // Classic canvas: a corner drag stops where the card shows everything, and
  // the card refits whenever its box changes (first shown, or the node made
  // wider or narrower, which rewraps the text).
  holdNodeMinHeight(node, () => (classicCanvas() ? state.fitHeight : undefined));
  state.resizeObserver = new ResizeObserver(() => fitNote(state));
  state.resizeObserver.observe(root);
  render(state);
  node.setSize?.([
    Math.max(node.size?.[0] ?? 0, DEFAULT_SIZE[0]),
    Math.max(node.size?.[1] ?? 0, DEFAULT_SIZE[1]),
  ]);
  return state;
}

app.registerExtension({
  name: "QG.WorkflowNote",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    hideInputsInDef(nodeData, ["note"]);
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      buildPanel(this);
    });
    chainCallback(nodeType.prototype, "onConfigure", function () {
      // Saved widget values land after onNodeCreated: re-read them, and
      // keep the saved size rather than the default the panel asked for.
      // The fit runs before ComfyUI snapshots the opened workflow, so
      // growing a note that was saved short does not mark it modified.
      queueMicrotask(() => {
        const state = buildPanel(this);
        if (!state) return;
        state.note = normalizeNote(state.valueWidget.value);
        render(state);
        fitNote(state);
      });
    });
    chainCallback(nodeType.prototype, "getExtraMenuOptions", function (_canvas, options) {
      const state = this.__qgNote;
      if (!state || !Array.isArray(options)) return;
      options.unshift({ content: "✎ Edit Workflow Note", callback: () => openEditor(state) }, null);
    });
    chainCallback(nodeType.prototype, "refreshComboInNode", function () {
      const state = this.__qgNote;
      if (state) checkModels(state, true);
    });
    chainCallback(nodeType.prototype, "onRemoved", function () {
      closeEditor();
      this.__qgNote?.resizeObserver?.disconnect();
      this.__qgNote = null;
    });
  },
});

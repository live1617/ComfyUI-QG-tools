// Pure logic for Workflow Note: the card's state shape, a Markdown-lite
// parser that yields data (never HTML), URL safety, and the model-presence
// match. No DOM and no ComfyUI imports, so it runs under node:test.
//
// The card is stored as JSON in one hidden STRING widget. Everything here
// treats that JSON as untrusted: a downloaded workflow is someone else's
// text, so every URL is filtered to http(s) and every string is coerced.

export const NOTE_VERSION = 1;
export const LAYOUTS = ["card", "banner"];
// The one non-model folder a row may name: sample inputs live in
// ComfyUI/input, and a shared workflow often ships one.
export const INPUT_FOLDER = "input";
// Folders every install has, offered first in the editor's folder picker.
export const COMMON_FOLDERS = [
  "diffusion_models",
  "text_encoders",
  "vae",
  "loras",
  "checkpoints",
  "clip",
  "clip_vision",
  "controlnet",
  "upscale_models",
  "embeddings",
  INPUT_FOLDER,
];

const ROW_LIMIT = 60;
const TEXT_LIMIT = 20000;

function str(value, limit = 400) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : String(value);
  return text.slice(0, limit);
}

// http(s) only. A javascript: or data: URL in a downloaded workflow must
// never become a clickable button.
export function safeUrl(value) {
  const text = str(value, 2000).trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return "";
  return text;
}

// "huggingface.co" from a full URL - the small print under a button.
export function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function baseName(path) {
  const text = str(path, 1000).trim();
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

export function emptyNote() {
  return {
    v: NOTE_VERSION,
    title: "",
    subtitle: "",
    author: "",
    body: "",
    models: [],
    packs: [],
    links: [],
    layout: "card",
    accent: "",
  };
}

function normalizeModel(row) {
  if (!row || typeof row !== "object") return null;
  const name = str(row.name).trim();
  if (!name) return null;
  return {
    name,
    dir: str(row.dir, 120).trim().replace(/^[\\/]+|[\\/]+$/g, ""),
    url: safeUrl(row.url),
    size: str(row.size, 40).trim(),
    note: str(row.note, 300).trim(),
  };
}

// The editor's model table: one column for every field normalizeModel
// keeps, in the order they show. The form builds its cells from this list
// and reads them back with rowFromCells, so saving the form can't drop a
// field the card shows, such as the note under the file name.
export const MODEL_COLUMNS = [
  { key: "name", label: "File", placeholder: "krea2_turbo_fp8_scaled.safetensors" },
  { key: "dir", label: "Folder" },
  { key: "size", label: "Size", placeholder: "13.1 GB" },
  { key: "url", label: "Download URL", placeholder: "https://huggingface.co/.../resolve/main/file.safetensors" },
  { key: "note", label: "Note", placeholder: "tip, credit, trigger word" },
];

// A table row from its cell values, given in the columns' order.
export function rowFromCells(columns, values) {
  return Object.fromEntries(columns.map(({ key }, index) => [key, values?.[index] ?? ""]));
}

function normalizePack(row) {
  if (!row || typeof row !== "object") return null;
  const name = str(row.name).trim();
  if (!name) return null;
  return { name, url: safeUrl(row.url), node: str(row.node, 200).trim() };
}

function normalizeLink(row) {
  if (!row || typeof row !== "object") return null;
  const url = safeUrl(row.url);
  const label = str(row.label, 80).trim();
  if (!url && !label) return null;
  return { label: label || hostLabel(url) || url, url };
}

function rows(list, normalize) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list.slice(0, ROW_LIMIT)) {
    const clean = normalize(row);
    if (clean) out.push(clean);
  }
  return out;
}

// Accepts the widget string, a parsed object, or nothing; always returns a
// complete card. Unknown keys are dropped and bad values fall back to empty.
export function normalizeNote(raw) {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      source = {};
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) source = {};
  const note = emptyNote();
  note.title = str(source.title, 200).trim();
  note.subtitle = str(source.subtitle, 400).trim();
  note.author = str(source.author, 120).trim();
  note.body = str(source.body, TEXT_LIMIT);
  note.models = rows(source.models, normalizeModel);
  note.packs = rows(source.packs, normalizePack);
  note.links = rows(source.links, normalizeLink);
  note.layout = LAYOUTS.includes(source.layout) ? source.layout : "card";
  const accent = str(source.accent, 20).trim();
  note.accent = /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : "";
  return note;
}

export function serializeNote(note) {
  return JSON.stringify(normalizeNote(note));
}

// True when the card has nothing to show but its placeholder.
export function noteIsEmpty(note) {
  return !(
    note.title || note.subtitle || note.author || note.body.trim()
    || note.models.length || note.packs.length || note.links.length
  );
}

// "ComfyUI/models/loras" - the folder hint under each group of rows.
export function folderPath(dir) {
  if (!dir) return "ComfyUI/models";
  if (dir === INPUT_FOLDER) return "ComfyUI/input";
  return `ComfyUI/models/${dir}`;
}

// Rows grouped by folder in first-seen order, so the card reads like the
// install tree: one heading per folder, its files beneath.
export function groupModels(models) {
  const groups = [];
  const byDir = new Map();
  for (const row of models) {
    let group = byDir.get(row.dir);
    if (!group) {
      group = { dir: row.dir, path: folderPath(row.dir), rows: [] };
      byDir.set(row.dir, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

// Match a row's file against the server's list for its folder. A file that
// moved into a subfolder still counts - the loaders resolve it there - so
// the basename decides, case-insensitively; an exact relative path wins.
export function matchInstalled(name, files) {
  if (!Array.isArray(files) || !files.length) return { found: false, path: null };
  const wanted = str(name, 1000).trim();
  const wantedBase = baseName(wanted).toLowerCase();
  if (!wantedBase) return { found: false, path: null };
  const normalized = files.map((file) => str(file, 1000).replace(/\\/g, "/"));
  const exact = normalized.find((file) => file.toLowerCase() === wanted.replace(/\\/g, "/").toLowerCase());
  if (exact) return { found: true, path: exact };
  const loose = normalized.find((file) => baseName(file).toLowerCase() === wantedBase);
  return loose ? { found: true, path: loose } : { found: false, path: null };
}

// Node packs present in a graph, from each node type's python_module
// ("custom_nodes.ComfyUI-QG-tools"). Core modules ("nodes",
// "comfy_extras.*") are skipped: nobody needs to install those. The first
// node type seen per pack becomes its presence probe.
export function packsFromGraph(nodeTypes, moduleOf) {
  const packs = [];
  const seen = new Set();
  for (const type of nodeTypes) {
    const module = str(moduleOf(type), 300);
    const match = /^custom_nodes\.([^.]+)/.exec(module);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    packs.push({ name, url: "", node: type });
  }
  return packs;
}

// How tall the node must be for the card to show all of its content, from
// three numbers the page measures: the card's natural height at its current
// width, the node's height, and the part of the node height the card never
// gets (the gap above the first widget plus the widget frame). `fit` is that
// node height. `grow` says whether the node has to get there now: Chrome
// rounds both heights before it draws a scrollbar, so a card less than half
// a pixel short already shows everything and keeps its size.
export function noteFit({ natural, nodeHeight, chrome }) {
  const values = [natural, nodeHeight, chrome].map(Number);
  if (!values.every(Number.isFinite) || values[0] <= 0) return { fit: null, grow: false };
  const [content, node, frame] = values;
  return { fit: content + frame, grow: Math.round(content) > Math.round(node - frame) };
}

// ---------------------------------------------------------------------------
// Markdown-lite. Headings, paragraphs, bullet and numbered lists, rules,
// fenced code, and inline bold / italic / code / links. Output is data; the
// renderer builds DOM nodes from it, so no user text ever meets innerHTML.
// ---------------------------------------------------------------------------

const INLINE_PATTERN = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|\[[^\]\n]+?\]\([^)\s]+?\)|(?<![\w*])\*[^*\n]+?\*(?![\w*]))/;

export function parseInline(text) {
  const spans = [];
  let rest = str(text, TEXT_LIMIT);
  while (rest.length) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match) {
      spans.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) spans.push({ type: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("**")) spans.push({ type: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("`")) spans.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("[")) {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const url = safeUrl(token.slice(close + 2, -1));
      spans.push(url ? { type: "link", text: label, url } : { type: "text", text: label });
    } else spans.push({ type: "em", text: token.slice(1, -1) });
    rest = rest.slice(match.index + token.length);
  }
  return spans;
}

export function parseMarkdown(text) {
  const lines = str(text, TEXT_LIMIT).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const spans = [];
    paragraph.forEach((line, index) => {
      if (index) spans.push({ type: "br" });
      spans.push(...parseInline(line));
    });
    blocks.push({ type: "paragraph", spans });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (code) {
      if (/^```/.test(line)) {
        blocks.push(code);
        code = null;
      } else code.text += (code.text ? "\n" : "") + rawLine;
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      code = { type: "code", text: "" };
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push({ type: "hr" });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push(parseInline((bullet || numbered)[1]));
      continue;
    }
    if (list) {
      // An indented continuation line belongs to the last item.
      if (/^\s{2,}/.test(rawLine)) {
        list.items[list.items.length - 1].push({ type: "br" }, ...parseInline(line.trim()));
        continue;
      }
      flushList();
    }
    paragraph.push(line);
  }
  if (code) blocks.push(code);
  flushParagraph();
  flushList();
  return blocks;
}

// "LTXV 2.3" for "LTXV 2.3/ltx.safetensors": the subfolder a found file
// sits in, or "" at the folder's top.
export function subfolderOf(path) {
  const text = str(path, 1000).replace(/\\/g, "/").trim();
  const cut = text.lastIndexOf("/");
  return cut > 0 ? text.slice(0, cut) : "";
}

// Loaders in the graph that ask for `name` but cannot load it: a list
// widget holding the bare file name (or another copy's path) that is not
// one of its choices, while `foundPath` - the copy the note found - is.
// That is the loader ComfyUI marks red when the file sits in a subfolder.
// `widgets` is [{ node, widget, value, options }]; returns the matches.
export function loadersNeeding(name, foundPath, widgets) {
  const wanted = baseName(name).toLowerCase();
  const found = str(foundPath, 1000).replace(/\\/g, "/");
  if (!wanted || !found || !Array.isArray(widgets)) return [];
  return widgets.filter((entry) => {
    const options = Array.isArray(entry?.options) ? entry.options.map((item) => str(item, 1000).replace(/\\/g, "/")) : [];
    const current = str(entry?.value, 1000).replace(/\\/g, "/");
    return baseName(current).toLowerCase() === wanted && current !== found && !options.includes(current) && options.includes(found);
  });
}

// LoRA Loader rows that ask for `name` but hold another spelling than the
// copy the note found: a bare file name, or a path from someone else's
// install, that is no file here. The loader finds such a file by its name
// when it runs; Use it writes the real path into the row. `loaders` is
// [{ node, widget, rows }] with rows as the loader keeps them ({ name });
// `files` is the loras folder as the server lists it. Returns
// [{ node, widget, index }], one per row.
export function loraRowsNeeding(name, foundPath, loaders, files) {
  const wanted = baseName(name).toLowerCase();
  const found = str(foundPath, 1000).replace(/\\/g, "/");
  const have = new Set((Array.isArray(files) ? files : []).map((item) => str(item, 1000).replace(/\\/g, "/")));
  if (!wanted || !found || !have.has(found) || !Array.isArray(loaders)) return [];
  const out = [];
  for (const loader of loaders) {
    (Array.isArray(loader?.rows) ? loader.rows : []).forEach((row, index) => {
      const current = str(row?.name, 1000).replace(/\\/g, "/");
      if (baseName(current).toLowerCase() === wanted && current !== found && !have.has(current)) {
        out.push({ node: loader.node, widget: loader.widget, index });
      }
    });
  }
  return out;
}

// A found file the way its folder spells it. Windows lists
// "Krea 2\\model.safetensors", and a loader only takes an entry exactly as
// it is listed, so the path with "/" the note works with is no choice there.
export function listedSpelling(foundPath, listed) {
  const found = str(foundPath, 1000).replace(/\\/g, "/");
  const hit = (Array.isArray(listed) ? listed : []).find((item) => str(item, 1000).replace(/\\/g, "/") === found);
  return hit === undefined ? found : str(hit, 1000);
}

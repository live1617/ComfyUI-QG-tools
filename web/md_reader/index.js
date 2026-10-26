// QG MD reader: a live preview of the chosen document inside the node —
// rendered view or plain text, larger view, copy, refresh the file list.

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { zh } from "../shared/zh.mjs?v=2026102571";

const NODE_NAME = "QG_MDReader";
const NO_FILE = "<no document>";
const LS_KEY = "QG.MDReader.lastFile";

// ------------------------------------------------------------------ 样式

const CSS_ID = "qgtools-md-style";

function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.qgtools-md-box{display:flex;flex-direction:column;gap:4px;width:100%;height:100%;min-height:0;
  box-sizing:border-box;background:var(--mdr-bg,#1b1b1b);border:1px solid var(--mdr-border,#3a3a3a);
  border-radius:6px;overflow:hidden;font-family:inherit;}
.qgtools-md-bar{display:flex;align-items:center;gap:2px;padding:3px 4px;flex:0 0 auto;
  background:var(--mdr-bar,#252525);border-bottom:1px solid var(--mdr-border,#3a3a3a);}
.qgtools-md-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
  padding:0;border:none;border-radius:4px;background:transparent;color:var(--mdr-fg,#cfcfcf);
  cursor:pointer;opacity:.75;transition:opacity .15s,background .15s;}
.qgtools-md-btn:hover{opacity:1;background:var(--mdr-hover,#383838);}
.qgtools-md-btn:active{transform:scale(.94);}
.qgtools-md-btn svg{width:14px;height:14px;display:block;}
.qgtools-md-name{flex:1;min-width:0;margin-left:4px;font-size:11px;color:var(--mdr-dim,#9a9a9a);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;}
.qgtools-md-body{flex:1 1 0;min-height:0;overflow:auto;padding:6px 8px;font-size:12px;line-height:1.55;
  color:var(--mdr-fg,#d8d8d8);word-break:break-word;}
.qgtools-md-body::-webkit-scrollbar{width:8px;height:8px;}
.qgtools-md-body::-webkit-scrollbar-thumb{background:#4a4a4a;border-radius:4px;}
.qgtools-md-plain{white-space:pre-wrap;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;}
.qgtools-md-empty{color:#7a7a7a;font-style:italic;}
.qgtools-md-status{flex:0 0 auto;padding:2px 8px;font-size:10px;color:var(--mdr-dim,#8a8a8a);
  border-top:1px solid var(--mdr-border,#333);background:var(--mdr-bar,#252525);}
.qgtools-md-body h1,.qgtools-md-body h2,.qgtools-md-body h3,.qgtools-md-body h4{margin:.5em 0 .3em;line-height:1.3;color:#fff;}
.qgtools-md-body h1{font-size:17px;border-bottom:1px solid #3d3d3d;padding-bottom:3px;}
.qgtools-md-body h2{font-size:15px;border-bottom:1px solid #333;padding-bottom:2px;}
.qgtools-md-body h3{font-size:13.5px;} .qgtools-md-body h4{font-size:12.5px;color:#e2e2e2;}
.qgtools-md-body p{margin:.4em 0;}
.qgtools-md-body ul,.qgtools-md-body ol{margin:.35em 0 .35em 1.2em;padding-left:.2em;}
.qgtools-md-body li{margin:.12em 0;}
.qgtools-md-body code{background:#2e2e2e;border:1px solid #3d3d3d;border-radius:3px;padding:0 3px;
  font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#ffcf8a;}
.qgtools-md-body pre{background:#151515;border:1px solid #333;border-radius:4px;padding:6px 8px;
  overflow:auto;margin:.4em 0;}
.qgtools-md-body pre code{background:none;border:none;padding:0;color:#c9d6e3;font-size:11px;}
.qgtools-md-body blockquote,.qgtools-md-quote{margin:.35em 0;padding:.2em .6em;border-left:3px solid #5a5a5a;color:#b6b6b6;background:#202020;}
.qgtools-md-body hr{border:none;border-top:1px solid #3a3a3a;margin:.6em 0;}
.qgtools-md-body a{color:#6ab0ff;text-decoration:none;} .qgtools-md-body a:hover{text-decoration:underline;}
.qgtools-md-body table{border-collapse:collapse;margin:.4em 0;font-size:11.5px;}
.qgtools-md-body th,.qgtools-md-body td{border:1px solid #3d3d3d;padding:2px 6px;text-align:left;}
.qgtools-md-body th{background:#2a2a2a;}
.qgtools-md-img{color:#8fb3ff;}
.qgtools-md-mask{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.6);backdrop-filter:blur(2px);}
.qgtools-md-panel{width:680px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;
  background:#1e1e1e;border:1px solid #3a3a3a;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden;}
.qgtools-md-panel-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#262626;
  border-bottom:1px solid #3a3a3a;font-size:13px;color:#e8e8e8;}
.qgtools-md-panel-head .qgtools-md-name{flex:1;font-size:12px;color:#a0a0a0;direction:ltr;}
.qgtools-md-panel-body{flex:1;overflow:auto;padding:12px 16px;font-size:13px;line-height:1.65;color:#d8d8d8;}
.qgtools-md-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:10001;
  background:#2b2b2b;color:#eaeaea;border:1px solid #454545;border-radius:6px;padding:6px 14px;font-size:12px;}
`;
    document.head.appendChild(style);
}

// ------------------------------------------------------------------ 图标 / 工具

const ICON = {
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
};

function btn(name, title, onClick) {
    const b = document.createElement("button");
    b.className = "qgtools-md-btn";
    b.title = zh(title);   // written after insertion: the zh plugin never revisits it
    b.dataset.act = name;
    b.innerHTML = ICON[name] || name;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
    });
    return b;
}

function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toast(msg) {
    const t = document.createElement("div");
    t.className = "qgtools-md-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast(zh("Copied"));
    } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); toast(zh("Copied")); } catch (_) { toast(zh("Copy failed")); }
        ta.remove();
    }
}

// ------------------------------------------------------------------ 简易 Markdown 渲染

function inline(t) {
    let x = t;
    x = x.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
    x = x.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (m, alt) => `<span class="qgtools-md-img">🖼 ${alt || "image"}</span>`);
    x = x.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (m, tx, url) => `<a href="${url}" target="_blank" rel="noreferrer">${tx}</a>`);
    x = x.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    x = x.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    x = x.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    x = x.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return x;
}

function renderMarkdown(src) {
    if (!src) return "";
    let s = String(src).replace(/\r\n?/g, "\n").replace(/^﻿/, "");
    s = s.replace(/^---\n[\s\S]*?\n---\n?/, "");

    const blocks = [];
    s = s.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (m, code) => {
        blocks.push(escapeHtml(code.replace(/\n$/, "")));
        return `\u0000CB${blocks.length - 1}\u0000`;
    });
    s = s.replace(/``([\s\S]*?)``/g, (m, code) => `<code>${escapeHtml(code)}</code>`);
    s = escapeHtml(s);

    const lines = s.split("\n");
    const out = [];
    let listType = null;
    let para = [];
    const flushPara = () => {
        if (para.length) { out.push("<p>" + inline(para.join("<br>")) + "</p>"); para = []; }
    };
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const cb = line.match(/^\u0000CB(\d+)\u0000$/);
        if (cb) {
            flushPara(); closeList();
            out.push(`<pre><code>${blocks[Number(cb[1])] || ""}</code></pre>`);
            continue;
        }
        if (!line.trim()) { flushPara(); closeList(); continue; }

        let m;
        if ((m = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+)$/))) {
            flushPara(); closeList();
            const lv = Math.min(m[1].length, 4);
            out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
            continue;
        }
        if (/^[ \t]{0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }
        if ((m = line.match(/^[ \t]{0,3}&gt;[ \t]?(.*)$/))) {
            flushPara(); closeList();
            out.push(`<div class="qgtools-md-quote">${inline(m[1])}</div>`);
            continue;
        }
        // a table
        if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && /^[ \t|:-]+$/.test(lines[i + 1])) {
            flushPara(); closeList();
            const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
            const head = cells(line);
            let html = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
            let j = i + 2;
            for (; j < lines.length && lines[j].includes("|"); j++) {
                const cs = cells(lines[j]);
                html += "<tr>" + cs.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
            }
            html += "</tbody></table>";
            out.push(html);
            i = j - 1;
            continue;
        }
        if ((m = line.match(/^([ \t]*)[-*+][ \t]+(.+)$/))) {
            flushPara();
            if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
            out.push(`<li>${inline(m[2])}</li>`);
            continue;
        }
        if ((m = line.match(/^([ \t]*)\d+[.)][ \t]+(.+)$/))) {
            flushPara();
            if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
            out.push(`<li>${inline(m[2])}</li>`);
            continue;
        }
        closeList();
        para.push(line);
    }
    flushPara(); closeList();
    return out.join("");
}

// ------------------------------------------------------------------ 放大查看弹窗

function openModal(name, html, plain, getText) {
    const mask = document.createElement("div");
    mask.className = "qgtools-md-mask";
    const panel = document.createElement("div");
    panel.className = "qgtools-md-panel";
    panel.innerHTML = `
        <div class="qgtools-md-panel-head">
            <span>📄 ${escapeHtml(name || "")}</span>
            <span class="qgtools-md-name"></span>
        </div>
        <div class="qgtools-md-panel-body"></div>`;
    const head = panel.querySelector(".qgtools-md-panel-head");
    head.appendChild(btn("copy", zh("Copy the plain text"), () => copyText(getText())));
    const close = btn("zoom", zh("Close (Esc)"), () => closeModal());
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
    head.appendChild(close);
    panel.querySelector(".qgtools-md-panel-body").innerHTML = html;
    panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    mask.appendChild(panel);
    mask.addEventListener("click", (e) => { if (e.target === mask) closeModal(); });
    document.body.appendChild(mask);

    function onKey(e) { if (e.key === "Escape") closeModal(); }
    document.addEventListener("keydown", onKey, true);
    function closeModal() {
        document.removeEventListener("keydown", onKey, true);
        mask.remove();
    }
}

// ------------------------------------------------------------------ 节点挂载

function getWidget(node, name) {
    return node.widgets ? node.widgets.find((w) => w && w.name === name) : null;
}

function setup(node) {
    if (node._qgMdDone) return;
    node._qgMdDone = true;
    injectCss();

    const state = { view: "render", data: null, loading: false };

    const box = document.createElement("div");
    box.className = "qgtools-md-box";
    const bar = document.createElement("div");
    bar.className = "qgtools-md-bar";
    const nameEl = document.createElement("span");
    nameEl.className = "qgtools-md-name";
    nameEl.textContent = "";
    const body = document.createElement("div");
    body.className = "qgtools-md-body";
    body.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    const status = document.createElement("div");
    status.className = "qgtools-md-status";
    status.textContent = "Loading…";

    bar.appendChild(btn("refresh", zh("Refresh the file list"), () => refreshFiles()));
    bar.appendChild(btn("zoom", zh("Open it larger"), () => zoom()));
    bar.appendChild(btn("copy", zh("Copy what is on screen now"), () => copyText(currentText())));
    bar.appendChild(btn("eye", zh("Switch between the document and the plain text it outputs"), () => toggleView()));
    bar.appendChild(nameEl);

    box.appendChild(bar);
    box.appendChild(body);
    box.appendChild(status);

    // Let the front end lay it out: no computeSize, only a minHeight and no
    // maxHeight, so _arrangeWidgets hands the node's spare height to the
    // preview and it follows whenever the node is dragged taller.
    const widget = node.addDOMWidget("qg_md_preview", "qg_md_preview", box, {
        hideOnZoom: false,
        serialize: false,
        getMinHeight: () => 120,
        getValue() { return state.data ? state.data.name || "" : ""; },
        setValue() { },
    });
    widget.serialize = false;
    widget.options.serialize = false;
    node._qgMdWidget = widget;

    function currentText() {
        if (!state.data) return "";
        return state.view === "render" ? state.data.raw || "" : state.data.plain || "";
    }

    function paint() {
        const d = state.data;
        if (!d || !d.ok) {
            body.className = "qgtools-md-body";
            body.innerHTML = `<div class="qgtools-md-empty">${d && d.error ? escapeHtml(d.error) : "Nothing here yet"}</div>`;
            status.textContent = d && d.error ? "Read failed" : "";
            return;
        }
        nameEl.textContent = d.name || "";
        if (state.view === "render") {
            body.className = "qgtools-md-body";
            const html = renderMarkdown(d.raw);
            body.innerHTML = html || `<div class="qgtools-md-empty">(the file is empty)</div>`;
        } else {
            body.className = "qgtools-md-body mdr-plain";
            body.textContent = d.plain || "";
        }
        status.textContent = zh("{a} characters · {b} · {c}")
      .replace("{a}", String(d.chars)).replace("{b}", d.mtime || "")
      .replace("{c}", zh(state.view === "render" ? "rendered" : "plain text"));
    }

    function toggleView() {
        state.view = state.view === "render" ? "plain" : "render";
        paint();
    }

    function zoom() {
        if (!state.data || !state.data.ok) { toast(zh("Nothing to show yet")); return; }
        const html = state.view === "render"
            ? renderMarkdown(state.data.raw)
            : `<pre style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace">${escapeHtml(state.data.plain || "")}</pre>`;
        openModal(state.data.name, html, state.data.plain, currentText);
    }

    async function load() {
        if (state.loading) return;
        state.loading = true;
        try {
            const wFile = getWidget(node, "md_file");
            const wPath = getWidget(node, "custom_path");
            const payload = {
                path: wFile ? wFile.value : "",
                custom_path: wPath ? wPath.value || "" : "",
            };
            if (!payload.path || payload.path === NO_FILE) {
                state.data = { ok: false, error: "No document chosen — put a .md in the input folder, then press refresh" };
                paint();
                return;
            }
            const res = await api.fetchApi("/qg/md/read", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            state.data = await res.json();
            paint();
        } catch (e) {
            state.data = { ok: false, error: String(e) };
            paint();
        } finally {
            state.loading = false;
        }
    }

    async function refreshFiles() {
        try {
            const res = await api.fetchApi("/qg/md/files");
            const d = await res.json();
            const w = getWidget(node, "md_file");
            if (w && d.files && d.files.length) {
                w.options.values = d.files;
                if (!d.files.includes(w.value)) w.value = d.files[0];
                if (w.element && w.element.tagName === "SELECT") {
                    // a plain litegraph select: rebuild the options
                    while (w.element.options.length) w.element.remove(0);
                    d.files.forEach((f) => w.element.add(new Option(f, f)));
                    w.element.value = w.value;
                }
                node.setDirtyCanvas?.(true, true);
            }
            toast(zh("Found {a} documents").replace("{a}", String(d.count || 0)));
            await load();
        } catch (e) {
            toast(zh("Refresh failed: {a}").replace("{a}", String(e)));
        }
    }

    // Watch the widgets; they can appear after onNodeCreated, so retry.
    const RETRY = [0, 60, 200, 500, 1000, 2000];
    let tries = 0;
    function bind() {
        const wFile = getWidget(node, "md_file");
        const wPath = getWidget(node, "custom_path");
        const okFile = !!wFile;
        if (okFile) {
            if (!wFile._qgMdBound) {
                wFile._qgMdBound = true;
                // Restore the last hand-picked file; a saved workflow
                // value overwrites it a moment later.
                try {
                    const last = localStorage.getItem(LS_KEY);
                    if (last && Array.isArray(wFile.options?.values) && wFile.options.values.includes(last)) {
                        wFile.value = last;
                    }
                } catch (e) { /* ignore */ }
                const cb = wFile.callback;
                wFile.callback = function (v) {
                    if (cb) cb.apply(this, arguments);
                    try { localStorage.setItem(LS_KEY, v); } catch (e) { /* ignore */ }
                    load();
                };
            }
        }
        if (wPath && !wPath._qgMdBound) {
            wPath._qgMdBound = true;
            const cb2 = wPath.callback;
            let timer = null;
            wPath.callback = function (v) {
                if (cb2) cb2.apply(this, arguments);
                clearTimeout(timer);
                timer = setTimeout(load, 500);
            };
        }
        if (!okFile && tries < RETRY.length) {
            setTimeout(bind, RETRY[tries++]);
            return;
        }
        load();
    }
    bind();

    node._qgMdRefresh = load;
    if (node.size && node.size[1] < 360) {
        node.size = [Math.max(node.size[0], 380), 360];
        node.setSize && node.setSize(node.size);
    }
    node.setDirtyCanvas && node.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "QG.MDReader",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            try { setup(this); } catch (e) { console.error("[QG-tools] md reader setup failed", e); }
            return r !== undefined ? r : this;
        };
        // Refresh once the workflow has restored widgets_values.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            setTimeout(() => {
                if (this._qgMdRefresh) {
                    try { this._qgMdRefresh(); } catch (e) { /* ignore */ }
                }
            }, 80);
            return r !== undefined ? r : this;
        };
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const r = onRemoved ? onRemoved.apply(this, arguments) : undefined;
            document.querySelectorAll(".qgtools-md-mask").forEach((m) => m.remove());
            return r !== undefined ? r : this;
        };
    },
});

console.log("[QG-tools] md reader front end ready");

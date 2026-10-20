// ===========================================================================
// Markdown 渲染引擎（纯 canvas 2D，无任何外部依赖）
// 本节点定位是「画布注释」，只做显示、不做交互：
//   - 不支持链接（[文字](url)、<url>、裸 URL）：点了没反应，一律按普通文字原样显示
//   - 不支持任务列表（- [x] / - [ ]）：复选框点不了，写成什么就显示什么
// 行内：**粗** *斜* ***粗斜*** __粗__ _斜_ `代码` ~~删除线~~ ==高亮==
//       x^上标^ x~下标~、&amp; 等 HTML 实体、\* 转义
//       <b>粗</b> <i>斜</i> <u>下划线</u> <s>删除</s> <code>代码</code>
//       <mark>高亮</mark> <sub>下</sub> <sup>上</sup> <kbd>键</kbd>
//       <small>小</small> <big>大</big> <abbr>缩写</abbr> <q>引用</q>
//       任意标签上的 style="color/background-color/font-*/text-decoration"
// 块级：# 标题(1~6)、=== Setext 标题、> 引用(可嵌套)、- 列表(可嵌套)
//       1. 编号、: 定义列表、--- 分割线
//       ```js 代码块（带语言标签）、| 表格 |（行线 + 斑马纹）、![图片](url =100x80)
// HTML：块级结构先归一化成 Markdown 再渲染 —— <h1>~<h6>、<p>/<div> 分段、
//       <blockquote> 引用、<pre> 代码、<ul>/<ol>/<li> 列表（可嵌套）、<dl>/<dt>/<dd>、
//       <table>/<thead>/<tr>/<td>/<th>（th 表头、align 对齐、colspan 补空）、
//       <img src width height alt>、<hr>、<br>、<details>/<summary>、
//       <!-- 注释 --> 丢弃、<script>/<style> 整段丢弃
// 排版：自动折行 + 最大宽度
// 只负责「解析 → 排版 → 绘制」，不含任何节点/界面代码。
// ===========================================================================
import { app } from "/scripts/app.js";

const MD_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const MD_DEFAULT_MAX_WIDTH = 520;
const MD_HEAD_SCALE = [1.8, 1.5, 1.3, 1.15, 1.08, 1.02];
const MD_LIST_MARKS = ["• ", "◦ ", "▪ "];

// 顺序 = 优先级：转义 → 代码 → 图片 → HTML 标签 → 强调 → 删除线 → 高亮 → 上标 → 下标
// 注意：这里刻意不含链接 [文字](url)、<自动链接>、裸 URL —— 本节点不做交互，
// URL 一律当普通文字显示（不识别就不会被吃掉，也不会画下划线）
// HTML 标签用「通用」写法：任意标签名 + 可选属性 + 可选自闭合，
// 但 <https://url> 这种「冒号紧接标签名」的形式不匹配，仍当普通文字。
const MD_INLINE_RE = /(\\[^\n])|(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\n]+\))|(<\/?[a-z][a-z0-9]*(?:\s[^>]*)?\/?>)|(\*{3}[^*\n]+\*{3})|(\*{2}[^*\n]+\*{2})|(\*[^*\n]+\*)|(_{2}[^_\n]+_{2})|(_[^_\n]+_)|(~{2}[^~\n]+~{2})|(==[^=\n]+==)|(\^[^\^\n]+\^)|(~[^~\n]+~)/gi;
// 「像不像一个 HTML 标签」：字母开头 + 可选属性 + 可选 /，整体以 > 收尾
const MD_HTML_ANY_RE = /^<\/?[a-z][a-z0-9]*(?:\s[^>]*)?\/?>$/i;
// ![alt](url "标题" =宽x高)
const MD_IMAGE_RE = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?(?:\s*=(\d+)x(\d+))?\s*\)\s*$/;
const MD_HTML_TAG_RE = /^<\/?\s*([a-z][a-z0-9]*)/i;
const MD_FENCE_RE = /^\s*(?:```|~~~)/;
const MD_FENCE_LANG_RE = /^\s*(?:```|~~~)\s*(\S*)/;
const MD_HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const MD_SETEXT_RE = /^={2,}\s*$/;
const MD_TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const MD_BR_RE = /<br\s*\/?>/i;

// 内嵌 HTML 标签 → 内部样式名（未知标签只吞掉标签本身，文字照常显示）
const MD_HTML_TAGS = {
    b: "bold", strong: "bold",
    i: "italic", em: "italic", dfn: "italic", cite: "italic", address: "italic",
    u: "underline", ins: "underline",
    s: "strike", del: "strike", strike: "strike",
    code: "code", kbd: "code", samp: "code", tt: "code", var: "code",
    mark: "mark",
    sub: "sub", sup: "sup",
    small: "small", big: "big",
    abbr: "abbr", acronym: "abbr",
    q: "q", blockquote: "quote",
};

// 块级 HTML 标签：交给 htmlToMarkdown() 处理结构，行内层遇到时直接吞掉
const MD_HTML_BLOCK_TAGS = new Set([
    "p", "div", "section", "article", "aside", "main", "header", "footer", "nav",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "center", "form",
    "fieldset", "legend", "figure", "figcaption", "details", "summary",
    "ul", "ol", "li", "dl", "dt", "dd", "dir", "menu",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
]);
// 自闭合标签：没有 </xxx>
const MD_HTML_VOID_TAGS = new Set([
    "br", "hr", "img", "wbr", "input", "meta", "link", "col", "area",
    "base", "source", "embed", "track", "param",
]);

// 常用 HTML 实体
const MD_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
    mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", ldquo: "\u201c", rdquo: "\u201d",
    copy: "\u00a9", reg: "\u00ae", trade: "\u2122", times: "\u00d7", divide: "\u00f7",
    deg: "\u00b0", plusmn: "\u00b1", ne: "\u2260", le: "\u2264", ge: "\u2265",
    larr: "\u2190", rarr: "\u2192", uarr: "\u2191", darr: "\u2193", harr: "\u2194",
    check: "\u2713", cross: "\u2717", heart: "\u2665", star: "\u2605",
    lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a", bdquo: "\u201e", dagger: "\u2020",
    Dagger: "\u2021", permil: "\u2030", lsaquo: "\u2039", rsaquo: "\u203a", euro: "\u20ac",
    pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", sect: "\u00a7", para: "\u00b6",
    micro: "\u00b5", middot: "\u00b7", bull: "\u2022", prime: "\u2032", Prime: "\u2033",
    asymp: "\u2248", equiv: "\u2261", infin: "\u221e", empty: "\u2205", sum: "\u2211",
    radic: "\u221a", prop: "\u221d", alpha: "\u03b1", beta: "\u03b2", pi: "\u03c0",
    sigma: "\u03c3", omega: "\u03c9", Delta: "\u0394", frac12: "\u00bd", frac14: "\u00bc",
    sup2: "\u00b2", sup3: "\u00b3", larr2: "\u21d0", rarr2: "\u21d2", harr2: "\u21d4",
};

// &amp; &lt; &#65; &#x41; → 对应字符
function decodeEntities(text) {
    return String(text ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, g) => {
        if (g[0] === "#") {
            const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
            return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? (String.fromCodePoint ? String.fromCodePoint(n) : String.fromCharCode(n)) : m;
        }
        const k = g.toLowerCase();
        return Object.prototype.hasOwnProperty.call(MD_ENTITIES, k) ? MD_ENTITIES[k] : m;
    });
}

// --- 图片缓存：异步加载，加载完成后主动刷新画布 ---
const mdImageCache = new Map();
let mdImageVersion = 0;

// 图片地址白名单：只放行不污染画布的来源。
// 关键安全点：把跨域图片画进 ComfyUI 的【主画布】会 taint 整张 canvas，
// 之后任何 toDataURL()/toBlob()（导出图片、工作流缩略图、别的插件截图）都会抛
// SecurityError，而且现象离原因很远、极难排查。所以：
//   1) 只允许 data:/blob:/同源（含 /view?...）→ 天然不污染；
//   2) 其余 http(s) 远程图必须用 crossOrigin="anonymous" 加载，对方没给 CORS 就
//      直接失败 → 退化成虚线占位框，绝不画进画布；
//   3) javascript: 等危险 scheme 一律拒绝。
function isSafeImageUrl(url) {
    const u = String(url || "").trim();
    if (!u) return false;
    if (/^data:image\//i.test(u)) return true;      // data URI 同源，不污染
    if (/^blob:/i.test(u)) return true;             // blob 同源
    if (/^[\w-]+:\/\//.test(u)) return /^https?:\/\//i.test(u); // 远程 → 走 CORS
    return true;                                     // 相对路径（/view?... 等）→ 同源
}

function getMarkdownImage(url) {
    let entry = mdImageCache.get(url);
    if (entry) return entry;
    entry = { img: null, ok: false, w: 0, h: 0 };
    if (!isSafeImageUrl(url)) {
        // 危险/不支持的地址：不加载、不绘制，保持占位框
        mdImageCache.set(url, entry);
        return entry;
    }
    try {
        const img = new Image();
        const isRemote = /^https?:\/\//i.test(String(url).trim());
        if (isRemote) img.crossOrigin = "anonymous"; // 无 CORS → onerror → 不污染画布
        img.onload = () => {
            entry.ok = true;
            entry.w = img.naturalWidth || 0;
            entry.h = img.naturalHeight || 0;
            mdImageVersion++;
            // 图片尺寸只有加载完才知道，让画布再画一帧刷新布局
            try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) { /* 忽略 */ }
        };
        img.onerror = () => {
            // 加载失败（含 CORS 拒绝）：保持 ok=false → 画占位框，不碰画布
            entry.ok = false;
            entry.img = null;
        };
        img.src = url;
        entry.img = img;
    } catch (e) { /* 环境不支持 Image：退化成占位框 */ }
    mdImageCache.set(url, entry);
    return entry;
}

// 上标/下标用更小的字号（量文字和绘制必须用同一个值，否则行宽/折行会对不上）
// 优先级：style 里的 font-size > <small>/<big> 缩放 > 上下标缩放 > 行字号
const MD_SIZE_SCALE = { small: 0.8, big: 1.2 };
function segFontSize(seg, size) {
    if (seg.sizeOverride) return Math.max(Number(seg.sizeOverride) || 4, 4);
    let s = size;
    if (seg.sup || seg.sub) s = Math.max(Number(size) * 0.62, 6);
    if (seg.small) s = Math.max(s * MD_SIZE_SCALE.small, 6);
    if (seg.big) s = s * MD_SIZE_SCALE.big;
    return Math.max(s, 4);
}

function mdFontString(seg, size, family) {
    const parts = [];
    if (seg.italic) parts.push("italic");
    if (seg.bold) parts.push("bold");
    parts.push(`${Math.max(Number(size) || 1, 1)}px`);
    const fam = seg.code ? MD_MONO : (family || "Arial");
    // family 加引号：含空格的字体名不加引号会让 ctx.font 静默失效、沿用上一套字体
    const f = String(fam).trim();
    parts.push(/^["'].*["']$/.test(f) ? f : (/^[-_a-zA-Z][-_a-zA-Z0-9 ]*$/.test(f) ? '"' + f.replace(/"/g, "") + '"' : f));
    return parts.join(" ");
}

// 颜色值校验：canvas 对非法 fillStyle 会静默沿用旧值，这里先挡掉。
// 颜色名必须是真实存在的 CSS 颜色（像 notacolor 这种杜撰词不能混进去）。
const MD_NAMED_COLORS = new Set([
    "red", "green", "blue", "white", "black", "yellow", "orange", "purple",
    "gray", "grey", "silver", "maroon", "navy", "olive", "lime", "aqua",
    "cyan", "magenta", "fuchsia", "teal", "pink", "brown", "gold", "violet",
    "indigo", "coral", "crimson", "khaki", "salmon", "tan", "tomato",
    "turquoise", "wheat", "ivory", "beige", "azure", "chocolate", "orchid",
    "plum", "sienna", "steelblue", "skyblue", "seagreen", "limegreen",
    "darkred", "darkgreen", "darkblue", "darkgray", "darkgrey", "darkorange",
    "lightgray", "lightgrey", "lightblue", "lightgreen", "lightyellow",
    "lightpink", "transparent", "currentcolor",
]);
function isValidColor(v) {
    if (typeof v !== "string") return false;
    const s = v.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return true;
    if (/^rgba?\([^)]*\)$/i.test(s)) return true;
    if (/^hsla?\([^)]*\)$/i.test(s)) return true;
    return /^[a-z]{3,20}$/i.test(s) && MD_NAMED_COLORS.has(s.toLowerCase());
}

// 从 <span style="color:red;font-size:20px"> / <font color="#0f0"> 里抽行内样式
function parseTagStyle(tok) {
    const style = {};
    const sm = tok.match(/style\s*=\s*"([^"]*)"/i) || tok.match(/style\s*=\s*'([^']*)'/i);
    if (sm) {
        for (const decl of sm[1].split(";")) {
            const dm = decl.match(/^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i);
            if (!dm) continue;
            const prop = dm[1].toLowerCase();
            const val = dm[2].trim();
            if (prop === "color") style.color = val;
            else if (prop === "background-color" || prop === "background") style.bg = val;
            else if (prop === "font-weight" && /bold|[5-9]00/i.test(val)) style.bold = true;
            else if (prop === "font-style" && /^italic$/i.test(val)) style.italic = true;
            else if (prop === "text-decoration") {
                if (/underline/i.test(val)) style.underline = true;
                if (/line-through/i.test(val)) style.strike = true;
            } else if (prop === "font-size") {
                const pm = val.match(/^(\d+(?:\.\d+)?)px$/i);
                if (pm) style.sizeOverride = Number(pm[1]);
            }
        }
    }
    // <font color="#0f0"> 旧写法
    const cm = tok.match(/\bcolor\s*=\s*"([^"]*)"/i) || tok.match(/\bcolor\s*=\s*'([^']*)'/i) || tok.match(/\bcolor=([^\s>]+)/i);
    if (cm && !style.color) style.color = cm[1];
    // 过滤非法颜色，避免污染绘制
    if (style.color && !isValidColor(style.color)) delete style.color;
    if (style.bg && !isValidColor(style.bg)) delete style.bg;
    return Object.keys(style).length ? style : null;
}

// 把一行里的行内标记拆成可逐个绘制的片段
function parseInlineMarkdown(src, style) {
    const segs = [];
    const base = style || {};
    // HTML 标签栈：支持嵌套（<b><i>x</i></b>），闭合时精确回退到该标签之前的状态。
    // 任意标签上的 style="..." 都会生效，不再局限于 span/font。
    const stack = [];
    const currentStyle = () => {
        const o = { ...base };
        for (const it of stack) {
            if (it.flag) o[it.flag] = true;
            if (it.tagStyle) Object.assign(o, it.tagStyle);
        }
        return o;
    };
    let last = 0;
    let m;
    MD_INLINE_RE.lastIndex = 0;
    while ((m = MD_INLINE_RE.exec(src)) !== null) {
        if (m.index > last) segs.push({ ...currentStyle(), text: src.slice(last, m.index) });
        const tok = m[0];
        const s = { ...currentStyle(), text: tok };
        // 只有像 <b> / <b class=x> / <br/> 这种「字母+可选属性+可选自闭合」才算标签，
        // 这样 <https://x> 和 <a@b.com> 不会被误判成标签（它们原样显示）
        const looksLikeTag = tok[0] === "<" && MD_HTML_ANY_RE.test(tok);
        const tagName = looksLikeTag ? (tok.match(MD_HTML_TAG_RE) || [])[1] : null;
        const tag = tagName ? String(tagName).toLowerCase() : "";
        const isVoid = MD_HTML_VOID_TAGS.has(tag);
        const isClose = tok[1] === "/";
        const tagKey = MD_HTML_TAGS[tag] || null;
        if (tok[0] === "\\") {
            s.escape = true;
            s.text = tok[1] || "";
        } else if (tok[0] === "`") {
            s.code = true;
            s.text = tok.slice(1, -1);
        } else if (tok.startsWith("![")) {
            // 行内图片：只显示 alt（整行单独出现时才作为图片块渲染）
            const im = tok.match(/^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?/);
            if (im) { s.image = im[2]; s.text = im[1] || "图片"; }
        } else if (looksLikeTag) {
            // 内嵌 HTML 标签：标签本身都不绘制，只影响后续文字的样式
            s.text = "";
            if (isClose && !isVoid) {
                // 闭合：从栈顶往下找到同名标签，把它和它上面的都弹掉
                for (let k = stack.length - 1; k >= 0; k--) {
                    if (stack[k].tag === tag) { stack.splice(k); break; }
                }
            } else if (!isClose && !isVoid && !MD_HTML_BLOCK_TAGS.has(tag)) {
                // 自闭合标签（br/hr/img…）不入栈；块级标签的结构已由 htmlToMarkdown() 处理
                stack.push({ tag, flag: tagKey, tagStyle: parseTagStyle(tok) });
            }
            // <q>：自动补弯引号（开标签前引号、闭标签后引号）
            if (tag === "q") {
                segs.push({ ...currentStyle(), text: isClose ? "\u201d" : "\u201c" });
            }
        } else if (tok.startsWith("***")) {
            s.bold = true; s.italic = true; s.text = tok.slice(3, -3);
        } else if (tok.startsWith("**") || tok.startsWith("__")) {
            s.bold = true; s.text = tok.slice(2, -2);
        } else if (tok.startsWith("~~")) {
            s.strike = true; s.text = tok.slice(2, -2);
        } else if (tok.startsWith("==")) {
            s.mark = true; s.text = tok.slice(2, -2);
        } else if (tok.startsWith("^")) {
            s.sup = true; s.text = tok.slice(1, -1);
        } else if (tok.startsWith("~")) {
            s.sub = true; s.text = tok.slice(1, -1);
        } else if (tok.startsWith("*") || tok.startsWith("_")) {
            s.italic = true; s.text = tok.slice(1, -1);
        }
        segs.push(s);
        last = m.index + tok.length;
    }
    if (last < src.length) segs.push({ ...currentStyle(), text: src.slice(last) });
    if (!segs.length) segs.push({ ...base, text: "" });
    // 统一做一次 HTML 实体解码（标记已经剥掉了，不会误伤）
    return segs.map((s) => (s.text ? { ...s, text: decodeEntities(s.text) } : s));
}

// ---------------------------------------------------------------------------
// HTML 块级结构 → Markdown
// 只处理「结构」：<table>/<ul>/<h1> 等先翻译成 Markdown 等价写法，再交给既有解析器；
// 行内标签（<b>/<span style=...>/<font>）原样保留，由行内解析器负责。
// ---------------------------------------------------------------------------
function htmlAttr(tagText, name) {
    const m = String(tagText ?? "").match(
        new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")
    );
    if (!m) return "";
    return String(m[1] ?? m[2] ?? m[3] ?? "").trim();
}

// 内部样式对象 → <span style="...">，用于把块级标签的 style 传给行内解析器
function styleToSpanTag(st) {
    if (!st) return "";
    const deco = [st.underline ? "underline" : "", st.strike ? "line-through" : ""].filter(Boolean).join(" ");
    const parts = [];
    if (st.color) parts.push("color:" + st.color);
    if (st.bg) parts.push("background-color:" + st.bg);
    if (st.bold) parts.push("font-weight:bold");
    if (st.italic) parts.push("font-style:italic");
    if (deco) parts.push("text-decoration:" + deco);
    if (st.sizeOverride) parts.push("font-size:" + st.sizeOverride + "px");
    return parts.length ? `<span style="${parts.join(";")}">` : "";
}

// <table> → Markdown 表格（支持 th 表头、align 对齐、colspan 补空单元格）
function htmlTableToMarkdown(inner) {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    let m;
    while ((m = trRe.exec(inner)) !== null) {
        const cells = [];
        const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
        let c;
        while ((c = cellRe.exec(m[1])) !== null) {
            const attrs = c[2] || "";
            const isHead = /^th$/i.test(c[1]);
            const text = c[3]
                .replace(/<br\s*\/?>/gi, " ")
                .replace(/<\/?(?:p|div|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|a|figure|figcaption|h[1-6])\b[^>]*>/gi, "")
                .replace(/\s+/g, " ")
                .trim();
            let align = htmlAttr(attrs, "align").toLowerCase();
            if (!align) align = (attrs.match(/text-align\s*:\s*(left|right|center)/i) || [])[1]?.toLowerCase() || "";
            const colspan = Math.max(1, parseInt(htmlAttr(attrs, "colspan"), 10) || 1);
            for (let k = 0; k < colspan; k++) cells.push({ text: k === 0 ? text : "", isHead, align });
        }
        if (cells.length) rows.push(cells);
    }
    if (!rows.length) return [];
    const cols = rows.reduce((mx, r) => Math.max(mx, r.length), 0);
    // 表头：整行都是 th；找不到就用第一行
    let headIdx = rows.findIndex((r) => r.every((c) => c.isHead));
    if (headIdx < 0) headIdx = 0;
    const header = rows[headIdx];
    const body = rows.filter((_, idx) => idx !== headIdx);
    const rowLine = (cells) =>
        "| " + Array.from({ length: cols }, (_, i) => (cells[i] ? cells[i].text : "")).join(" | ") + " |";
    const out = [rowLine(header)];
    const aligns = Array.from({ length: cols }, (_, i) => {
        const a = (header[i] && header[i].align) || (body[0] && body[0][i] && body[0][i].align) || "";
        return a === "center" ? ":---:" : a === "right" ? "---:" : "---";
    });
    out.push("| " + aligns.join(" | ") + " |");
    for (const r of body) out.push(rowLine(r));
    return out;
}

// 把 HTML 的块级结构翻译成 Markdown 文本；没有块级标签时原样返回（不动原有 Markdown）
function htmlToMarkdown(raw) {
    let s = String(raw ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")                       // 注释
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "") // 脚本整段丢掉
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");  // 样式整段丢掉
    // 没有任何块级 HTML 标签 → 直接返回原文（避免破坏纯 Markdown）
    const hasBlock = new RegExp("<\\/?(?:" + Array.from(MD_HTML_BLOCK_TAGS).join("|") + "|hr|img)\\b", "i").test(s);
    if (!hasBlock) return s;

    const out = [];
    let line = "";
    let headLevel = 0;
    const stack = [];

    const quotePrefix = () => {
        let n = 0;
        for (const f of stack) if (f.tag === "blockquote") n++;
        return n ? ">".repeat(n) + " " : "";
    };
    const flush = () => {
        out.push(quotePrefix() + (headLevel ? "#".repeat(headLevel) + " " : "") + line);
        line = "";
    };
    const flushIf = () => { if (line.trim() !== "") flush(); };
    const paraBreak = () => {
        if (line.trim() !== "") flush();
        else line = "";
        if (out.length && out[out.length - 1] !== "") out.push("");
    };
    // 块级容器之间的分隔：列表内部（嵌套 ul/ol）不插空行，保持紧凑
    const blockBreak = () => {
        if (line.trim() !== "") flush();
        else line = "";
        if (stack.some((f) => f.tag === "li")) return;
        if (out.length && out[out.length - 1] !== "") out.push("");
    };
    // 打开块级容器：顺带把它的 style 转成 <span style=...>（闭合时补 </span>）
    const openBlock = (tag, tok) => {
        blockBreak();
        const open = styleToSpanTag(parseTagStyle(tok || ""));
        if (open) { line += open; stack.push({ tag, span: true }); }
        else stack.push({ tag });
    };
    // 闭合块级容器分两步：先补 </span>（此时内容还在行里），收行之后再出栈
    // （收行必须在出栈前，否则 blockquote 的 ">" 前缀会算不出来）
    const closeSpan = (tag) => {
        for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].tag === tag) { if (stack[k].span) line += "</span>"; return; }
        }
    };
    const popOnly = (tag) => {
        for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].tag === tag) { stack.splice(k); return; }
        }
    };
    const blankAfter = () => { if (out.length && out[out.length - 1] !== "") out.push(""); };
    const listDepth = () => stack.filter((f) => f.tag === "ul" || f.tag === "ol").length;

    const TOKEN_RE = /<[a-z!/][^>]*>|[^<]+/gi;
    let m;
    while ((m = TOKEN_RE.exec(s)) !== null) {
        const tok = m[0];
        if (tok[0] !== "<") {
            // HTML 里换行等同空格（处在块级容器内时），容器外保留原本的 Markdown 换行
            if (stack.length) {
                line += tok.replace(/\s+/g, " ");
            } else {
                const parts = tok.split("\n");
                for (let k = 0; k < parts.length; k++) {
                    if (k > 0) flush();
                    line += parts[k];
                }
            }
            continue;
        }
        const isClose = tok[1] === "/";
        const tag = String((tok.match(MD_HTML_TAG_RE) || [])[1] || "").toLowerCase();
        if (!tag) continue;

        if (tag === "br") { flush(); continue; }
        if (tag === "wbr") continue;
        if (tag === "hr") { flushIf(); out.push("---"); continue; }
        if (tag === "img" && !isClose) {
            const url = htmlAttr(tok, "src");
            if (!url) continue;
            const alt = htmlAttr(tok, "alt") || "图片";
            const w = parseInt(htmlAttr(tok, "width"), 10) || 0;
            const h = parseInt(htmlAttr(tok, "height"), 10) || 0;
            flushIf();
            out.push(`![${alt}](${url}${w > 0 && h > 0 ? " =" + w + "x" + h : ""})`);
            continue;
        }
        if (tag === "pre" && !isClose) {
            const end = s.toLowerCase().indexOf("</pre>", m.index);
            const stop = end < 0 ? s.length : end;
            const inner = s.slice(m.index + tok.length, stop);
            TOKEN_RE.lastIndex = end < 0 ? s.length : end + 6;
            paraBreak();
            out.push("```");
            for (const l of inner.replace(/\r/g, "").split("\n")) out.push(l);
            out.push("```");
            out.push("");
            continue;
        }
        if (tag === "table" && !isClose) {
            let depth = 0;
            let end = -1;
            const tRe = /<\/?table\b[^>]*>/gi;
            tRe.lastIndex = m.index;
            let tm;
            while ((tm = tRe.exec(s)) !== null) {
                if (tm[0][1] === "/") { depth--; if (depth === 0) { end = tm.index; break; } }
                else depth++;
            }
            const stop = end < 0 ? s.length : end;
            const inner = s.slice(m.index + tok.length, stop);
            TOKEN_RE.lastIndex = end < 0 ? s.length : end + "</table>".length;
            paraBreak();
            out.push(...htmlTableToMarkdown(inner));
            out.push("");
            continue;
        }
        if (/^h[1-6]$/.test(tag)) {
            if (isClose) { closeSpan(tag); flush(); headLevel = 0; popOnly(tag); blankAfter(); }
            else { openBlock(tag, tok); headLevel = Number(tag[1]); }
            continue;
        }
        if (tag === "blockquote") {
            // 先收行（此时栈里还有 blockquote，才能算出 > 前缀），再出栈
            if (isClose) { closeSpan(tag); flushIf(); popOnly(tag); blockBreak(); }
            else openBlock(tag, tok);
            continue;
        }
        if (tag === "ul" || tag === "ol") {
            if (isClose) { closeSpan(tag); flushIf(); popOnly(tag); blockBreak(); }
            else {
                openBlock(tag, tok);
                const top = stack[stack.length - 1];
                if (top) top.counter = 0;
            }
            continue;
        }
        if (tag === "li") {
            if (isClose) { closeSpan(tag); flushIf(); popOnly(tag); }
            else {
                flushIf();
                let parent = null;
                for (let k = stack.length - 1; k >= 0; k--) {
                    if (stack[k].tag === "ul" || stack[k].tag === "ol") { parent = stack[k]; break; }
                }
                const marker = parent && parent.tag === "ol" ? ++parent.counter + ". " : "- ";
                line = "  ".repeat(Math.max(0, listDepth() - 1)) + marker;
                const open = styleToSpanTag(parseTagStyle(tok));
                if (open) { line += open; stack.push({ tag: "li", span: true }); }
                else stack.push({ tag: "li" });
            }
            continue;
        }
        if (tag === "dl") { blockBreak(); continue; }
        if (tag === "dt") { if (isClose) flushIf(); else { flushIf(); line = ""; } continue; }
        if (tag === "dd") { if (isClose) flushIf(); else { flushIf(); line = ": "; } continue; }
        if (tag === "summary") {
            if (isClose) { line = "**" + line.trim() + "**"; flush(); }
            else { flushIf(); line = ""; }
            continue;
        }
        if (MD_HTML_BLOCK_TAGS.has(tag)) {
            if (isClose) { closeSpan(tag); flushIf(); popOnly(tag); blockBreak(); }
            else openBlock(tag, tok);
            continue;
        }
        // 其余（行内标签及未知标签）：原样保留，交给行内解析器
        line += tok;
    }
    flushIf();
    // 末尾的空行块会多占一行高度，去掉
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.length ? out.join("\n") : s;
}

// 解析一行的块级标记（标题/引用/列表/任务/编号），返回 {segs,size,prefix,indent,quote}
function parseMarkdownLine(line, base) {
    let s = String(line ?? "");
    let size = base;
    let bold = false;
    let prefix = "";
    let indent = 0;
    let quote = false;
    let m;

    // 引用（可嵌套：> 一层、>> 两层…）
    if ((m = s.match(/^((?:\s*>)+)\s?(.*)$/))) {
        const level = (m[1].match(/>/g) || []).length;
        quote = true;
        indent = base * 0.4 + (level - 1) * base * 0.7;
        s = m[2];
    }
    if ((m = s.match(/^(#{1,6})\s+(.*)$/))) {
        size = base * MD_HEAD_SCALE[m[1].length - 1];
        bold = true;
        s = m[2];
    }
    // 列表 / 任务 / 编号：每缩进 2 个空格算一级
    if ((m = s.match(/^(\s*)[-*+]\s+(.*)$/))) {
        const lv = Math.min(2, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
        prefix = MD_LIST_MARKS[lv];
        indent += lv * base * 0.9;
        s = m[2];
        // 不做任务列表（- [x] / - [ ] 原样显示）：画布注释点不了复选框
    } else if ((m = s.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
        const lv = Math.min(2, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
        prefix = m[2] + ". ";
        indent += lv * base * 0.9;
        s = m[3];
    } else if ((m = s.match(/^:\s+(.*)$/))) {
        // 定义列表：术语下一行以 ": " 开头 → 缩进显示释义
        indent += base * 0.9;
        s = m[1];
    }
    return { segs: parseInlineMarkdown(s, bold ? { bold: true } : {}), size, prefix, indent, quote };
}

// 去掉行尾的硬换行标记（两个空格 / 反斜杠），并把 <br> 拆成多行
function splitLineBreaks(line) {
    return String(line ?? "")
        .split(MD_BR_RE)
        .map((part) => part.replace(/(?: {2,}|\\)\s*$/, ""));
}

function splitTableRow(line) {
    let s = String(line ?? "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
}

function parseTableAligns(sepLine) {
    return splitTableRow(sepLine).map((c) => {
        if (c.startsWith(":") && c.endsWith(":")) return "center";
        if (c.endsWith(":")) return "right";
        return "left";
    });
}

// 把整段文本切成「块」：段落 / 分割线 / 代码块 / 表格 / 图片
function parseMarkdownBlocks(src, base) {
    const srcLines = String(src ?? "").split("\n");
    const blocks = [];
    const isTableStart = (i) =>
        srcLines[i] && srcLines[i].includes("|") && i + 1 < srcLines.length && MD_TABLE_SEP_RE.test(srcLines[i + 1]);
    let i = 0;
    while (i < srcLines.length) {
        const line = srcLines[i];
        if (MD_FENCE_RE.test(line)) {                 // ```js 代码块
            const lang = (line.match(MD_FENCE_LANG_RE) || [])[1] || "";
            const body = [];
            i++;
            while (i < srcLines.length && !MD_FENCE_RE.test(srcLines[i])) body.push(srcLines[i++]);
            i++;                                       // 吃掉收尾的 ```
            blocks.push({ kind: "code", lines: body, lang });
            continue;
        }
        if (MD_HR_RE.test(line)) {                     // --- 分割线
            i++;
            blocks.push({ kind: "hr" });
            continue;
        }
        const img = line.match(MD_IMAGE_RE);           // ![图片](url "标题" =宽x高)
        if (img) {
            i++;
            blocks.push({
                kind: "image",
                url: img[2].trim(),
                alt: img[1] || "",
                wantW: img[3] ? Number(img[3]) : 0,
                wantH: img[4] ? Number(img[4]) : 0,
            });
            continue;
        }
        if (isTableStart(i)) {                         // | 表格 |
            const aligns = parseTableAligns(srcLines[i + 1]);
            const rows = [splitTableRow(line)];
            i += 2;
            while (i < srcLines.length && srcLines[i].includes("|") && srcLines[i].trim() !== "") {
                rows.push(splitTableRow(srcLines[i]));
                i++;
            }
            blocks.push({ kind: "table", header: rows[0], rows: rows.slice(1), aligns });
            continue;
        }
        // 段落：一直吃到空行或下一个块开始
        const para = [];
        let setext = false;
        while (i < srcLines.length) {
            const l = srcLines[i];
            if (l.trim() === "" || MD_FENCE_RE.test(l) || MD_HR_RE.test(l) || MD_IMAGE_RE.test(l)) break;
            if (isTableStart(i)) break;
            if (para.length && MD_SETEXT_RE.test(l)) {  // 标题\n=== → 一级标题
                setext = true;
                i++;
                break;
            }
            for (const part of splitLineBreaks(l)) para.push(part);
            i++;
        }
        if (!para.length) { para.push(...splitLineBreaks(line)); i++; }   // 空行：保留空白行
        blocks.push({
            kind: "text",
            lines: para.map((t, idx) => parseMarkdownLine(setext && idx === 0 ? "# " + t : t, base)),
        });
    }
    return blocks;
}

function buildLabelBlocks(raw, base, useMarkdown) {
    const src = String(raw ?? "");
    if (!useMarkdown) {
        return [{
            kind: "text",
            lines: src.split("\n").map((t) => ({ segs: [{ text: t }], size: base, prefix: "", indent: 0, quote: false })),
        }];
    }
    return parseMarkdownBlocks(htmlToMarkdown(src), base);
}

// 折行用的分词：CJK 逐字可断，西文按词断
const MD_TOKEN_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\s\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+|\s+/g;

function tokenizeForWrap(text) {
    const out = [];
    let m;
    MD_TOKEN_RE.lastIndex = 0;
    while ((m = MD_TOKEN_RE.exec(text)) !== null) out.push(m[0]);
    return out.length ? out : [text];
}

// 把一行折成若干行（不折行时直接原样返回）
function wrapMarkdownLine(ctx, ln, maxWidth, family) {
    if (!isFinite(maxWidth)) return [{ ...ln, extraIndent: 0 }];
    ctx.font = `${Math.max(ln.size, 1)}px ${family}`;
    const prefixW = ln.prefix ? ctx.measureText(ln.prefix).width : 0;
    const hang = prefixW;                               // 续行按前缀宽度悬挂缩进
    const tokens = [];
    for (const seg of ln.segs) {
        for (const t of tokenizeForWrap(seg.text)) tokens.push({ t, seg });
    }
    if (!tokens.length) return [{ ...ln, extraIndent: 0 }];
    for (const tk of tokens) {
        ctx.font = mdFontString(tk.seg, ln.size, family);
        tk.w = ctx.measureText(tk.t).width;
    }
    const visual = [];
    let cur = [];
    let curW = 0;
    let first = true;
    const avail = () => (first ? maxWidth - ln.indent - prefixW : maxWidth - ln.indent - hang);
    const flush = () => {
        const segs = [];
        for (const tk of cur) {
            const prev = segs[segs.length - 1];
            if (prev && prev.src === tk.seg) prev.text += tk.t;
            else segs.push({ ...tk.seg, src: tk.seg, text: tk.t });
        }
        visual.push({
            segs, size: ln.size, indent: ln.indent,
            extraIndent: first ? 0 : hang, prefix: first ? ln.prefix : "", quote: ln.quote,
        });
        cur = [];
        curW = 0;
        first = false;
    };
    for (const tk of tokens) {
        if (tk.t.trim() === "" && cur.length === 0) continue;   // 行首空白丢掉
        if (cur.length && curW + tk.w > avail()) flush();
        cur.push(tk);
        curW += tk.w;
    }
    flush();
    return visual;
}

// 量出每个块的尺寸（内部会改 ctx.font；行高 = 该行字号）
function layoutLabelBlocks(ctx, blocks, opt) {
    const base = Number(opt.size) || 20;
    const family = opt.family || "Arial";
    const maxWidth = opt.wrap === false ? Infinity : Math.max(40, Number(opt.maxWidth) || MD_DEFAULT_MAX_WIDTH);
    let totalW = 0;
    let totalH = 0;
    for (const b of blocks) {
        if (b.kind === "text") {
            b.rows = [];
            for (const ln of b.lines) {
                for (const vl of wrapMarkdownLine(ctx, ln, maxWidth, family)) b.rows.push(vl);
            }
            let w = 0;
            let h = 0;
            for (const vl of b.rows) {
                let lw = (Number(vl.indent) || 0) + (Number(vl.extraIndent) || 0);
                if (vl.prefix) {
                    ctx.font = `${Math.max(vl.size, 1)}px ${family}`;
                    lw += ctx.measureText(vl.prefix).width;
                }
                for (const seg of vl.segs) {
                    ctx.font = mdFontString(seg, segFontSize(seg, vl.size), family);
                    lw += ctx.measureText(seg.text).width;
                }
                vl.width = lw;
                // 行高：行字号与片段实际字号（font-size 覆盖 / <big>）取最大，避免大字被压扁
                let lineH = Math.max(vl.size, 1);
                for (const seg of vl.segs) {
                    lineH = Math.max(lineH, segFontSize(seg, vl.size));
                }
                vl.height = lineH;
                if (lw > w) w = lw;
                h += vl.height;
            }
            b.width = w;
            b.height = h;
        } else if (b.kind === "code") {
            const pad = base * 0.4;
            const lh = base * 1.35;
            ctx.font = `${base}px ${MD_MONO}`;
            let w = 0;
            for (const t of b.lines) w = Math.max(w, ctx.measureText(t).width);
            b.pad = pad;
            b.lineHeight = lh;
            b.width = w + pad * 2;
            b.height = b.lines.length * lh + pad * 2;
        } else if (b.kind === "hr") {
            b.width = isFinite(maxWidth) ? Math.min(maxWidth, 200) : 200;
            b.height = Math.max(8, base * 0.6);
        } else if (b.kind === "table") {
            const padX = Math.max(4, base * 0.5);
            const rowH = base * 1.6;
            const header = b.header.map((c) => parseInlineMarkdown(String(c), { bold: true }));
            const body = b.rows.map((r) => r.map((c) => parseInlineMarkdown(String(c), {})));
            b.cells = [header, ...body];
            const cols = Math.max(...b.cells.map((r) => r.length), (b.aligns || []).length, 1);
            const widths = new Array(cols).fill(0);
            for (const row of b.cells) {
                for (let c = 0; c < row.length; c++) {
                    let cw = 0;
                    for (const seg of row[c]) {
                        ctx.font = mdFontString(seg, segFontSize(seg, base), family);
                        cw += ctx.measureText(seg.text).width;
                    }
                    if (cw > widths[c]) widths[c] = cw;
                }
            }
            b.colWidths = widths.map((w) => w + padX * 2);
            b.padX = padX;
            b.rowH = rowH;
            b.width = b.colWidths.reduce((a, c) => a + c, 0);
            b.height = b.cells.length * rowH;
        } else if (b.kind === "image") {
            const e = getMarkdownImage(b.url);
            let w = e.w || 160;
            let h = e.h || 90;
            // 指定尺寸优先：=100x80；只给宽/高时按比例推算（这里要求两者都给）
            if (b.wantW > 0 && b.wantH > 0 && e.ok) { w = b.wantW; h = b.wantH; }
            if (isFinite(maxWidth) && w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
            b.width = w;
            b.height = h;
        }
        if (b.width > totalW) totalW = b.width;
        totalH += b.height;
    }
    return { width: totalW, height: totalH };
}

// 排版结果缓存：画布每帧都会重绘，没必要每帧重新解析 + 折行 + 量文字
const mdLayoutCache = new Map();
const MD_LAYOUT_CACHE_MAX = 60;

// 兜底排版：解析/测量出任何意外都退化成「纯文本多行」，保证节点尺寸一定是合法数字
function fallbackLayout(ctx, raw, opt) {
    const size = Math.max(Number(opt && opt.size) || 20, 1);
    const family = (opt && opt.family) || "Arial";
    const lines = String(raw ?? "").replace(/\\n/g, "\n").split("\n");
    ctx.font = `${size}px ${family}`;
    let w = 1;
    for (const t of lines) w = Math.max(w, ctx.measureText(t).width);
    return {
        blocks: [{
            kind: "text",
            lines: lines.map((t) => ({ segs: [{ text: t }], size, prefix: "", indent: 0, quote: false })),
        }],
        layout: { width: Math.max(w, 1), height: Math.max(lines.length, 1) * size },
    };
}

function getLabelLayout(ctx, raw, opt) {
    const key = [mdImageVersion, raw, opt.size, opt.family, opt.wrap, opt.maxWidth, opt.markdown].join("\u0000");
    const hit = mdLayoutCache.get(key);
    if (hit) return hit;
    let entry;
    try {
        const blocks = buildLabelBlocks(raw, opt.size, opt.markdown !== false);
        const layout = layoutLabelBlocks(ctx, blocks, opt);
        entry = { blocks, layout };
    } catch (e) {
        // 排版出错不能让整张画布挂掉：退化成纯文本，并把原因打到控制台一次
        console.error("[QG-tools] Markdown 排版出错，已按纯文本显示：", e);
        entry = fallbackLayout(ctx, raw, opt);
    }
    // 超限淘汰最旧的若干条，而不是 clear() 全清——全清会让所有节点下一帧集体重排，
    // 图片多的工作流会反复出现「雪崩式」重算（Map 保持插入顺序，先插的即最久未用）。
    if (mdLayoutCache.size > MD_LAYOUT_CACHE_MAX) {
        const excess = mdLayoutCache.size - MD_LAYOUT_CACHE_MAX + 10;
        const it = mdLayoutCache.keys();
        for (let i = 0; i < excess; i++) {
            const k = it.next();
            if (k.done) break;
            mdLayoutCache.delete(k.value);
        }
    }
    mdLayoutCache.set(key, entry);
    return entry;
}

// 顺序绘制若干片段（行内代码/高亮/删除线/链接样式都在这里处理）
function drawSegments(ctx, segs, size, family, x, y, color) {
    for (const seg of segs) {
        if (!seg.text) continue;                       // HTML 标签片段：不画
        // 上标/下标：字号缩小 + 基线上下偏移（small/big/font-size 也一并算进来）
        const isScript = !!(seg.sup || seg.sub);
        const fsize = segFontSize(seg, size);
        const dy = seg.sup ? -size * 0.34 : seg.sub ? size * 0.16 : 0;
        ctx.font = mdFontString(seg, fsize, family);
        const w = ctx.measureText(seg.text).width;
        if (seg.code && !isScript) {
            // 行内代码：淡色底 + 等宽字体
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = color;
            ctx.fillRect(x - 2, y + size * 0.06, w + 4, size * 0.88);
            ctx.globalAlpha = 1;
        }
        if (seg.mark) {
            // ==高亮== / <mark>：荧光笔底色
            ctx.globalAlpha = 0.3;
            ctx.fillStyle = color;
            ctx.fillRect(x - 1, y + size * 0.12, w + 2, size * 0.78);
            ctx.globalAlpha = 1;
        }
        if (seg.bg && isValidColor(seg.bg)) {
            // <span style="background-color:...">：自带颜色的底色（不透明度跟随颜色本身）
            ctx.fillStyle = seg.bg;
            ctx.fillRect(x - 1, y + fsize * 0.08, w + 2, fsize * 0.84);
        }
        // <span style="color:..."> / <font color=...>：片段自带颜色
        ctx.fillStyle = seg.color && isValidColor(seg.color) ? seg.color : color;
        ctx.fillText(seg.text, x, y + dy);
        if (seg.strike) {
            // 删除线：横线划掉
            ctx.fillRect(x, y + dy + fsize * 0.55, w, Math.max(1, fsize * 0.07));
        }
        if (seg.underline) {
            // <u>：文字下加下划线（只做显示，不做跳转）
            ctx.fillRect(x, y + dy + fsize * 0.94, w, Math.max(1, fsize * 0.055));
        }
        if (seg.abbr) {
            // <abbr>：点线（用小方块拼出虚线效果）
            const th = Math.max(1, fsize * 0.055);
            const yy = y + dy + fsize * 0.94;
            const dash = Math.max(1, fsize * 0.09);
            for (let px = 0; px < w; px += dash * 2) {
                ctx.fillRect(x + px, yy, Math.min(dash, w - px), th);
            }
        }
        x += w;
    }
}

function drawVisualLine(ctx, vl, family, x, y, color) {
    if (vl.quote) {
        // 引用：左侧一条竖线
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = color;
        ctx.fillRect(x - vl.indent, y + vl.height * 0.1, Math.max(2, vl.size * 0.09), vl.height * 0.8);
        ctx.globalAlpha = 1;
    }
    if (vl.prefix) {
        ctx.font = `${Math.max(vl.size, 1)}px ${family}`;
        ctx.fillStyle = color;
        ctx.fillText(vl.prefix, x, y);
        x += ctx.measureText(vl.prefix).width;
    }
    drawSegments(ctx, vl.segs, vl.size, family, x, y, color);
}

function drawTableBlock(ctx, b, x, y, base, family, color) {
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, b.width, b.rowH);                // 表头底色
    ctx.globalAlpha = 0.45;
    ctx.fillRect(x, y, b.width, 1);                     // 上边框
    ctx.fillRect(x, y + b.rowH - 1, b.width, 1);        // 表头下
    ctx.fillRect(x, y + b.height - 1, b.width, 1);      // 下边框
    ctx.globalAlpha = 1;
    for (let r = 0; r < b.cells.length; r++) {
        // 斑马纹：正文奇数行一层极淡底色
        if (r > 0 && r % 2 === 1) {
            ctx.globalAlpha = 0.06;
            ctx.fillStyle = color;
            ctx.fillRect(x, y + r * b.rowH, b.width, b.rowH);
            ctx.globalAlpha = 1;
        }
        // 行分隔线
        if (r > 0) {
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = color;
            ctx.fillRect(x, y + r * b.rowH, b.width, 1);
            ctx.globalAlpha = 1;
        }
        let cx = x;
        for (let c = 0; c < b.cells[r].length; c++) {
            const segs = b.cells[r][c];
            let cw = 0;
            for (const seg of segs) {
                ctx.font = mdFontString(seg, segFontSize(seg, base), family);
                cw += ctx.measureText(seg.text).width;
            }
            const colW = b.colWidths[c];
            const align = (b.aligns && b.aligns[c]) || "left";
            let tx = cx + b.padX;
            if (align === "right") tx = cx + colW - b.padX - cw;
            else if (align === "center") tx = cx + (colW - cw) / 2;
            drawSegments(ctx, segs, base, family, tx, y + r * b.rowH + (b.rowH - base) / 2, color);
            cx += colW;
        }
    }
}

function drawImageBlock(ctx, b, x, y, base, family, color) {
    const e = getMarkdownImage(b.url);
    if (e.ok && e.img) {
        try {
            ctx.drawImage(e.img, x, y, b.width, b.height);
            return;
        } catch (err) { /* 绘制失败 → 退化成占位框 */ }
    }
    // 还没加载好（或地址不可用）：虚线占位框 + 名称
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, b.width, b.height);
    ctx.globalAlpha = 0.45;
    if (typeof ctx.setLineDash === "function") ctx.setLineDash([5, 4]);
    if (typeof ctx.strokeRect === "function") {
        ctx.strokeStyle = color;
        ctx.strokeRect(x + 0.5, y + 0.5, b.width - 1, b.height - 1);
    }
    ctx.restore();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.font = `${Math.max(base * 0.8, 8)}px ${family}`;
    ctx.fillText(b.alt || "图片", x + b.width / 2, y + b.height / 2 - base * 0.5, b.width);
    ctx.textAlign = "left";
}

// 以文字块左上角 (x0,y0) 为原点绘制；align 决定每个块/行在块内的水平位置
function drawLabelBlocks(ctx, blocks, opt, x0, y0, blockW, align, color) {
    try {
        drawLabelBlocksUnsafe(ctx, blocks, opt, x0, y0, blockW, align, color);
    } catch (e) {
        // 绘制出错同样不能让画布崩掉：退化成逐行纯文本，控制台留一次原因
        console.error("[QG-tools] Markdown 绘制出错，已按纯文本显示：", e);
        try { ctx.restore(); } catch (e2) { /* 忽略 */ }
        drawPlainFallback(ctx, blocks, opt, x0, y0, color);
    }
}

// 绘制兜底：把所有块里的文字原样逐行画出来
function drawPlainFallback(ctx, blocks, opt, x0, y0, color) {
    const base = Math.max(Number(opt && opt.size) || 20, 1);
    const family = (opt && opt.family) || "Arial";
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${base}px ${family}`;
    ctx.fillStyle = color || "#ffffff";
    let y = y0;
    for (const b of blocks) {
        if (b.kind === "text") {
            for (const ln of b.lines || []) {
                let x = x0 + (Number(ln.indent) || 0);
                for (const seg of ln.segs || []) {
                    if (!seg || !seg.text) continue;
                    ctx.fillText(seg.text, x, y);
                    x += ctx.measureText(seg.text).width;
                }
                y += base;
            }
        } else if (b.kind === "code") {
            for (const t of b.lines || []) { ctx.fillText(t, x0, y); y += base; }
        } else if (b.kind === "table") {
            for (const row of b.cells || []) {
                for (const cellSegs of row) {
                    ctx.fillText((cellSegs || []).map((s) => (s && s.text) || "").join(""), x0, y);
                    y += base;
                }
            }
        } else {
            y += Number(b.height) || base;
        }
    }
    ctx.restore();
}

function drawLabelBlocksUnsafe(ctx, blocks, opt, x0, y0, blockW, align, color) {
    const base = Number(opt.size) || 20;
    const family = opt.family || "Arial";
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let y = y0;
    for (const b of blocks) {
        let bx = x0;
        if (align === "center") bx = x0 + (blockW - b.width) / 2;
        else if (align === "right") bx = x0 + blockW - b.width;
        if (b.kind === "text") {
            for (const vl of b.rows) {
                let x = bx + (Number(vl.indent) || 0) + (Number(vl.extraIndent) || 0);
                if (align === "center") x += (blockW - vl.width) / 2;
                else if (align === "right") x += blockW - vl.width;
                drawVisualLine(ctx, vl, family, x, y, color);
                y += vl.height;
            }
        } else if (b.kind === "code") {
            ctx.globalAlpha = 0.14;
            ctx.fillStyle = color;
            ctx.fillRect(bx, y, b.width, b.height);
            ctx.globalAlpha = 1;
            ctx.font = `${Math.max(base, 1)}px ${MD_MONO}`;
            ctx.fillStyle = color;
            for (let i = 0; i < b.lines.length; i++) {
                ctx.fillText(b.lines[i], bx + b.pad, y + b.pad + i * b.lineHeight);
            }
            // 语言标签（```js / ```python …）画在右上角
            if (b.lang) {
                ctx.globalAlpha = 0.5;
                ctx.font = `${Math.max(base * 0.7, 8)}px ${MD_MONO}`;
                ctx.textAlign = "right";
                ctx.fillText(b.lang, bx + b.width - b.pad * 0.6, y + b.pad * 0.5);
                ctx.textAlign = "left";
                ctx.globalAlpha = 1;
            }
            y += b.height;
        } else if (b.kind === "hr") {
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = color;
            ctx.fillRect(bx, y + b.height / 2 - Math.max(1, base * 0.05), b.width, Math.max(1, base * 0.1));
            ctx.globalAlpha = 1;
            y += b.height;
        } else if (b.kind === "table") {
            drawTableBlock(ctx, b, bx, y, base, family, color);
            y += b.height;
        } else if (b.kind === "image") {
            drawImageBlock(ctx, b, bx, y, base, family, color);
            y += b.height;
        }
    }
    ctx.restore();
}

export {
    MD_DEFAULT_MAX_WIDTH,
    buildLabelBlocks,
    getLabelLayout,
    drawLabelBlocks,
};

// QG_MarkdownNote 的 Nodes 2.0（Vue 渲染）DOM 分支。
//
// 经典模式由 markdown_node.mjs 用 canvas 逐块绘制；Vue 模式下 LGraphCanvas 的
// draw 不跑，这里把同一份排版结果（md_render.mjs 的 blocks / rows）翻译成真实 DOM。
//
// 🔴 关键设计：**不重新排版，直接复用 canvas 已算好的行**
//    md_render 的 `layoutLabelBlocks` 已经把每段折好行（`b.rows`）、算好每行
//    高度（`vl.height`）与每块尺寸（`b.width` / `b.height`）。DOM 侧只按这些
//    数字摆位置 + `white-space:pre` 关掉浏览器自己的折行 —— 两种模式逐行一致，
//    而且**完全不需要读 DOM 布局**，从根上躲开「size ← 布局 ← size」回声循环
//    （那个循环会把主线程占满，表现是画布滚轮缩放失效）。
//
// 挂载 / 指针穿透 / 双击编辑 / 卸载清理在 label_dom_base.mjs，与画布标签共用。
import {
    getLabelLayout,
    isValidColor,
    isSafeImageUrl,
    segFontSize,
    MD_MONO,
} from "./md_render.mjs?v=2026102706";
import { getMeasureCtx, DEFAULT_MD_BG } from "./label_common.mjs?v=2026102706";
import { createLabelDomDriver } from "./label_dom_base.mjs?v=2026102706";
import { openMarkdownEditor } from "./markdown_node.mjs?v=2026102706";

// 与 canvas_label_dom.mjs 同一个值（Vue 节点外壳左右内边距合计）
const VUE_SHELL_PAD_X = 24;

// 字体名加引号：含空格的字体名不加引号，CSS font-family 会失效
function cssFamily(family) {
    const f = String(family || "Arial").trim();
    if (!f) return "Arial";
    if (/^["'].*["']$/.test(f)) return f;
    if (/^[-_a-zA-Z][-_a-zA-Z0-9 ]*$/.test(f)) return '"' + f.replace(/"/g, "") + '"';
    return f;
}

function mdText(node) {
    return String(node.title ?? "").replace(/\\n/g, "\n").replace(/\n*$/, "");
}

function mdOpts(p) {
    return {
        size: Math.max(Number(p.fontSize) || 16, 1),
        family: p.fontFamily || "Arial",
        wrap: p.wrap !== false,
        maxWidth: p.maxWidth,
        markdown: p.markdown !== false,
    };
}

/** 取排版结果（带缓存，与 canvas 分支共享同一份）。取不到返回 null。 */
function mdLayout(node) {
    const ctx = getMeasureCtx();
    if (!ctx) return null;
    const p = node.properties || {};
    const opts = mdOpts(p);
    try {
        const { blocks, layout } = getLabelLayout(ctx, mdText(node), opts);
        return { blocks, layout, opts, padding: Number(p.padding) || 0, p };
    } catch (e) {
        console.error("[QG-tools] Markdown 排版失败（Vue DOM 分支）：", e);
        return null;
    }
}

const div = (css) => {
    const d = document.createElement("div");
    if (css) d.style.cssText = css;
    return d;
};

/** 半透明底色：canvas 用 globalAlpha 叠色，CSS 用 color-mix 叠同一个颜色。 */
function tint(color, alpha) {
    return "color-mix(in srgb, " + (isValidColor(color) ? color : "#ffffff")
        + " " + Math.round(alpha * 100) + "%, transparent)";
}

/**
 * 一个文字片段 → span。
 *
 * 只改「看起来怎么样」的属性，绝不碰任何会影响宽度的属性（padding / margin /
 * letter-spacing）—— 行宽是 canvas 算好的，DOM 一改宽度就会跟相邻行错位。
 */
function segSpan(seg, baseSize, family, color) {
    const el = document.createElement("span");
    el.textContent = seg.text;
    const fs = segFontSize(seg, baseSize);
    const st = [];
    st.push("font-size:" + fs + "px");
    st.push("font-family:" + (seg.code ? MD_MONO : cssFamily(family)));
    if (seg.bold) st.push("font-weight:700");
    if (seg.italic) st.push("font-style:italic");
    if (seg.color && isValidColor(seg.color)) st.push("color:" + seg.color);
    const deco = [];
    if (seg.strike) deco.push("line-through");
    if (seg.underline) deco.push("underline");
    // canvas 给 <abbr> 画点线，CSS 用 dotted 近似
    if (seg.abbr) deco.push("underline dotted");
    if (deco.length) st.push("text-decoration:" + deco.join(" "));
    // 底色：先画高亮/自带底色，再叠行内代码底色（与 canvas 的绘制顺序一致）
    if (seg.mark) st.push("background:" + tint(color, 0.3));
    if (seg.bg && isValidColor(seg.bg)) st.push("background:" + seg.bg);
    if (seg.code && !seg.sup && !seg.sub && !seg.mark && !seg.bg) {
        st.push("background:" + tint(color, 0.16));
        st.push("border-radius:2px");
    }
    // 上标/下标：字号已由 segFontSize 缩小，这里只补基线偏移。
    // 用 relative + top 而不是 vertical-align：后者会撑高行盒，破坏固定行高。
    if (seg.sup) st.push("position:relative;top:" + (-baseSize * 0.34) + "px");
    else if (seg.sub) st.push("position:relative;top:" + (baseSize * 0.16) + "px");
    el.style.cssText = st.join(";");
    return el;
}

/** 一行（canvas 已折好）→ 定高 div。 */
function rowEl(vl, opts, color, align) {
    const row = div(
        "position:relative;box-sizing:border-box;"
        + "width:100%;height:" + vl.height + "px;line-height:" + vl.height + "px;"
        + "white-space:pre;overflow:visible;text-align:" + align + ";"
    );
    // 引用竖线：canvas 画在 (x - indent)，x 含 indent，落点即 extraIndent
    if (vl.quote) {
        const bar = div(
            "position:absolute;left:" + (Number(vl.extraIndent) || 0) + "px;"
            + "top:10%;height:80%;width:" + Math.max(2, vl.size * 0.09) + "px;"
            + "background:currentColor;opacity:.5;"
        );
        row.append(bar);
    }
    const indent = (Number(vl.indent) || 0) + (Number(vl.extraIndent) || 0);
    if (indent > 0) {
        const sp = div("display:inline-block;width:" + indent + "px;height:1px;overflow:hidden;");
        row.append(sp);
    }
    if (vl.prefix) {
        const pre = document.createElement("span");
        pre.textContent = vl.prefix;
        pre.style.cssText = "font-size:" + Math.max(vl.size, 1) + "px;font-family:"
            + cssFamily(opts.family) + ";";
        row.append(pre);
    }
    for (const seg of vl.segs) {
        if (!seg.text) continue;
        row.append(segSpan(seg, vl.size, opts.family, color));
    }
    return row;
}

/** 文字块：逐行堆叠，行高与 canvas 完全一致。 */
function textBlockEl(b, opts, color, align) {
    const box = div("position:relative;width:" + b.width + "px;height:" + b.height + "px;overflow:visible;");
    for (const vl of b.rows || []) box.append(rowEl(vl, opts, color, align));
    return box;
}

/** 代码块：底色 + 等宽字体逐行 + 右上角语言标签。 */
function codeBlockEl(b, opts, color) {
    const pad = Number(b.pad) || 0;
    const lh = Number(b.lineHeight) || opts.size * 1.35;
    const box = div(
        "position:relative;box-sizing:border-box;overflow:hidden;"
        + "width:" + b.width + "px;height:" + b.height + "px;padding:" + pad + "px;"
        + "background:" + tint(color, 0.14) + ";"
        + "font-family:" + MD_MONO + ";font-size:" + Math.max(opts.size, 1) + "px;"
        + "line-height:" + lh + "px;white-space:pre;"
    );
    for (const t of b.lines || []) {
        const ln = div("height:" + lh + "px;line-height:" + lh + "px;white-space:pre;");
        ln.textContent = t === "" ? "\u00a0" : t;
        box.append(ln);
    }
    if (b.lang) {
        const lan = div(
            "position:absolute;right:" + (pad * 0.6) + "px;top:" + (pad * 0.5) + "px;"
            + "font-size:" + Math.max(opts.size * 0.7, 8) + "px;font-family:" + MD_MONO + ";"
            + "opacity:.5;line-height:1;"
        );
        lan.textContent = b.lang;
        box.append(lan);
    }
    return box;
}

/** 分割线：canvas 在块竖直中线画一条 alpha .6 的横线。 */
function hrBlockEl(b, opts, color) {
    const th = Math.max(1, opts.size * 0.1);
    const box = div("position:relative;width:" + b.width + "px;height:" + b.height + "px;");
    box.append(div(
        "position:absolute;left:0;top:" + (b.height / 2 - Math.max(1, opts.size * 0.05)) + "px;"
        + "width:" + b.width + "px;height:" + th + "px;background:" + color + ";opacity:.6;"
    ));
    return box;
}

/**
 * 表格：用绝对定位的单元格，而不是 <table>。
 * <table> 的 border-collapse / padding 会改变内容宽度，和 canvas 算好的
 * colWidths 对不上，逐列错位；绝对定位能 1:1 复刻。
 */
function tableBlockEl(b, opts, color) {
    const box = div(
        "position:relative;width:" + b.width + "px;height:" + b.height + "px;overflow:hidden;"
        + "font-size:" + Math.max(opts.size, 1) + "px;line-height:1;"
    );
    const padX = Number(b.padX) || 0;
    const rowH = Number(b.rowH) || opts.size * 1.6;
    const cols = b.colWidths || [];

    // 表头底色 + 上边框 + 表头下边框 + 下边框（与 canvas 同层次、同透明度）
    box.append(div("position:absolute;left:0;top:0;width:" + b.width + "px;height:" + rowH
        + "px;background:" + tint(color, 0.1) + ";"));
    const line = (y, alpha) => div("position:absolute;left:0;top:" + y + "px;width:" + b.width
        + "px;height:1px;background:" + color + ";opacity:" + alpha + ";");
    box.append(line(0, 0.45), line(rowH - 1, 0.45), line(b.height - 1, 0.45));

    const cells = b.cells || [];
    for (let r = 0; r < cells.length; r++) {
        if (r > 0 && r % 2 === 1) {
            box.append(div("position:absolute;left:0;top:" + (r * rowH) + "px;width:" + b.width
                + "px;height:" + rowH + "px;background:" + tint(color, 0.06) + ";"));
        }
        if (r > 0) box.append(line(r * rowH, 0.18));
        const row = cells[r] || [];
        let cx = 0;
        for (let c = 0; c < row.length; c++) {
            const colW = cols[c] || 0;
            const al = (b.aligns && b.aligns[c]) || "left";
            const cell = div(
                "position:absolute;left:" + cx + "px;top:" + (r * rowH) + "px;"
                + "box-sizing:border-box;width:" + colW + "px;height:" + rowH + "px;"
                + "padding:0 " + padX + "px;line-height:" + rowH + "px;white-space:pre;"
                + "text-align:" + al + ";overflow:hidden;"
            );
            for (const seg of row[c] || []) {
                if (!seg.text) continue;
                cell.append(segSpan(seg, opts.size, opts.family, color));
            }
            box.append(cell);
            cx += colW;
        }
    }
    return box;
}

/** 图片块：能安全加载就用 <img>，否则退化成虚线占位框（与 canvas 行为一致）。 */
function imageBlockEl(b, opts, color) {
    const box = div(
        "position:relative;width:" + b.width + "px;height:" + b.height + "px;"
        + "box-sizing:border-box;background:" + tint(color, 0.12) + ";"
    );
    if (!isSafeImageUrl(b.url)) {
        box.style.border = "1px dashed " + tint(color, 0.45);
    } else {
        const img = document.createElement("img");
        img.src = b.url;
        img.alt = b.alt || "";
        img.draggable = false;
        img.style.cssText = "display:block;width:100%;height:100%;object-fit:fill;";
        // 加载失败就把图片藏起来，露出底下的占位底色
        img.addEventListener("error", () => { img.style.display = "none"; });
        box.append(img);
    }
    return box;
}

/** 从节点属性构造整个内容 DOM。 */
function buildContent(node) {
    const L = mdLayout(node);
    const p = node.properties || {};
    const color = p.fontColor || "#ffffff";
    const borderRadius = Number(p.borderRadius) || 0;
    const bg = p.backgroundColor || DEFAULT_MD_BG;

    if (!L) {
        // 排版拿不到（离屏 ctx 不可用等）：退化成纯文本，绝不留空节点
        const fb = div(
            "box-sizing:border-box;padding:4px 6px;white-space:pre;"
            + "font:" + Math.max(Number(p.fontSize) || 16, 1) + "px " + cssFamily(p.fontFamily) + ";"
            + "color:" + color + ";"
        );
        fb.textContent = mdText(node) || "\u00a0";
        return fb;
    }

    const { blocks, layout, opts, padding } = L;
    const boxW = Math.max(layout.width, 1) + padding * 2;
    const boxH = Math.max(layout.height, 1) + padding * 2;
    const align = p.textAlign === "center" ? "center" : p.textAlign === "right" ? "right" : "left";
    const angle = parseInt(String(p.angle ?? 0)) || 0;

    const root = div(
        "position:relative;box-sizing:border-box;overflow:visible;"
        + "width:" + boxW + "px;height:" + boxH + "px;padding:" + padding + "px;"
        + "background:" + (bg && bg !== "transparent" ? bg : "transparent") + ";"
        + "border-radius:" + borderRadius + "px;color:" + color + ";"
        + "font-family:" + cssFamily(opts.family) + ";font-size:" + opts.size + "px;"
        + "white-space:pre;"
        + (angle ? "transform:rotate(" + angle + "deg);" : "")
    );
    // 内层宽度 = 内容宽（layout.width），与 canvas 的 blockW 一致
    const inner = div("position:relative;width:" + layout.width + "px;white-space:pre;");
    // 类名是给探针 / 控制台排查用的：.qgtools-md-blocks > * 就是各个块
    inner.className = "qgtools-md-blocks";
    root.append(inner);

    for (const b of blocks) {
        let el = null;
        if (b.kind === "text") el = textBlockEl(b, opts, color, align);
        else if (b.kind === "code") el = codeBlockEl(b, opts, color);
        else if (b.kind === "hr") el = hrBlockEl(b, opts, color);
        else if (b.kind === "table") el = tableBlockEl(b, opts, color);
        else if (b.kind === "image") el = imageBlockEl(b, opts, color);
        if (!el) continue;
        // 块内水平对齐：canvas 是 bx = x0 + (blockW - b.width)/2
        if (align === "center") el.style.marginLeft = Math.round((layout.width - b.width) / 2) + "px";
        else if (align === "right") el.style.marginLeft = Math.round(layout.width - b.width) + "px";
        inner.append(el);
    }
    return root;
}

/**
 * 量算：直接复用节点的 computeSize()。
 * 它内部就是 `layout + padding*2`，与 buildContent 的盒子完全同源 ——
 * 两边各算一套是尺寸漂移的万恶之源。
 */
function measureContent(node) {
    if (typeof node.computeSize === "function") {
        const s = node.computeSize();
        if (Array.isArray(s) && s[0] > 0 && s[1] > 0) return s;
    }
    return [120, 40];
}

const driver = createLabelDomDriver({
    widgetName: "qg_markdown_note_dom",
    widgetType: "qg_markdown_note",
    label: "Markdown 便签",
    rootClass: "qgtools-md-dom",
    padX: VUE_SHELL_PAD_X,
    build: buildContent,
    measure: measureContent,
    openEditor: (node) => openMarkdownEditor(node),
});

export const mountMarkdownNoteDom = driver.mount;
export const unmountMarkdownNoteDom = driver.unmount;
export const syncMarkdownNoteMode = driver.sync;

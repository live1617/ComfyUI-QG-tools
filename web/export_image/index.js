/**
 * QG 导出图像 — 节点上只留一行概要，全部参数收进齿轮面板
 *
 * 起因：这个节点执行完要在下方显示预览图，而 6 行控件固定占 178px，节点一窄预览就没地方
 * （用户原话：「光上面选择条都占了大部分了，预览就显的小了」）。预览高度只跟节点**宽度**走，
 * 控件条高度又压不下去，所以干脆把控件从画布上拿掉：节点只画一行概要
 * `PNG · 90 · 4:4:4 · 白底 · ComfyUI`，点标题栏的齿轮（或点概要本身）打开面板改参数。节点高度 178 → 56。
 *
 * 为什么用面板而不是画布控件：
 *   - ComfyUI 1.55 的 `options.advanced` 在 canvas 模式下**不生效**（实测给参数打了 advanced 之后
 *     `computeSize` 纹丝不动，画布上也不会冒出「高级」按钮），原生折叠这条路是堵的。
 *   - 面板里用原生 `<select>` / `<input>`：长选项（`4:4:4（最高画质）`、`保留透明（PNG / WEBP）`）
 *     各自成行不溢出；「当前格式用不到」的参数直接用原生 `disabled` 灰掉。于是 canvas 上那套补丁
 *     （暗纱 + onPointerDown 拦点击 + 改 tooltip + MutationObserver 改下拉项）全部删掉了。
 *
 * ⚠️ 折叠不能动 `widgets_values` 的顺序：隐藏的 widget 仍然留在 `node.widgets` 数组里，
 *    只是不再绘制、`computeSize` 返回 0。`serialize()` 仍按原顺序吐出 6 个值，
 *    **老工作流照常读**（验证过）。
 *
 * ⚠️ 齿轮是**画在标题栏上的 canvas 图形**，位置紧挨在 `?` 左边。那个 `?` 是
 *    `web/appearance/index.js` 用 `badgeCenter()` 画的（圆心 = 宽-16、y=-15），这里借同一份
 *    几何再左移 22px，两个图标永远在同一条线上。**别再改回 DOM 按钮**：DOM 版要挂到
 *    `document.body`、每帧按 `world*scale+offset` 重算屏幕坐标（`.dom-widget` 带 transform，
 *    会把 `position:fixed` 的包含块改成它自己），还要在 onRemoved 里收尾 —— 画在画布上
 *    这些全省，而且缩放 / 拖拽 / 折叠天然跟随。
 *
 * ⚠️ 概要行是在 `drawWidgets` 之后自己画的，高度靠重写 `computeSize` 加出来。
 *    不加的话 ComfyUI 按「只剩标题栏 + 槽位」算尺寸，概要会画到节点外面去。
 */

import { app } from "/scripts/app.js";
import { BRAND, notifyQgChange } from "../shared/index.mjs?v=2026102002";
import { badgeCenter, showBadge } from "../shared/help_badge.mjs?v=2026102002";
import { gearIconSvg } from "../shared/settings_menu.mjs?v=2026102002";
import { zh } from "../shared/zh.mjs?v=2026102002";

const NODE_TYPE = "QG_ExportImage";
const CSS_ID = "qgtools-export-css";
const SUMMARY_HEIGHT = 22;
// 折叠后 ComfyUI 只给「标题栏 + 4px」，槽位行放不下；概要借这一行显示，
// 所以这 22px 同时也是槽位行的落脚处。别删。
// 藏掉控件后节点宽度会从 270 掉到 210 —— 预览按节点宽度缩放，窄了预览就更小，
// 正好和这次的诉求相反，所以把原来的宽度守住。
const MIN_WIDTH = 270;
const KEEP_ALPHA = "保留透明（PNG / WEBP）";
const FLAT_WHITE = "合成白底";
const FLAT_BLACK = "合成黑底";

// 文件名前缀的默认值跟 ComfyUI 原生 SaveImage 一致（后端 INPUT_TYPES 里也是 "ComfyUI"）。
// 老工作流的存档里写的还是这个节点从前的默认值 "QG"，下面做一次一次性迁移。
const DEFAULT_PREFIX = "ComfyUI";
const LEGACY_PREFIX = "QG";

// 每种格式「用不到」的参数：面板里整行禁用。
// PNG 无损，quality / subsampling 后端完全不读；subsampling 只有 JPEG 读。
const UNUSED = {
    JPEG: [],
    PNG: ["quality", "subsampling"],
    WEBP: ["subsampling"],
};

// 全部收进面板的控件（顺序 = 面板里的顺序）
const FOLDED = ["format", "quality", "subsampling", "alpha_mode", "filename_prefix", "save_path"];

const LABELS = {
    format: "格式",
    quality: "编码质量",
    subsampling: "色度采样",
    alpha_mode: "透明处理",
    filename_prefix: "文件名前缀",
    save_path: "保存路径",
};

// 面板里每行的一句说明（后端 tooltip 太长，这里只留关键半句，一行放得下）
const NOTES = {
    quality: "只对 JPEG / WEBP 生效",
    subsampling: "只对 JPEG 生效",
    alpha_mode: "只有 PNG / WEBP 能存透明",
    filename_prefix: "命名同原生，00001 递增",
    save_path: "留空写 output 目录",
};

function widgetOf(node, name) {
    return (node.widgets || []).find((w) => w.name === name);
}

function isExportNode(node) {
    return node?.type === NODE_TYPE || node?.comfyClass === NODE_TYPE;
}

// ---------------------------------------------------------------- 折叠控件

// 把一行控件藏起来：不绘制、不占高度，但仍留在 widgets 数组里
// （数组顺序就是 widgets_values 的顺序，动了顺序老工作流的值就错位了）。
function foldWidget(widget) {
    if (widget.__qgFolded) return;
    widget.__qgFolded = true;
    widget.computeSize = () => [0, -4];
    widget.type = "hidden";
    widget.draw = () => {};
}

// ---------------------------------------------------------------- 参数规则

// 按当前格式收一遍：JPEG 收不了透明，值停在「保留透明」就落回白底。
function normalize(node) {
    const format = widgetOf(node, "format")?.value;
    const alpha = widgetOf(node, "alpha_mode");
    if (format === "JPEG" && alpha && alpha.value === KEEP_ALPHA) {
        alpha.value = FLAT_WHITE;
        alpha.callback?.(FLAT_WHITE, app.canvas, node, [0, 0], null);
    }
}

function isUnused(node, name) {
    return (UNUSED[widgetOf(node, "format")?.value] || []).includes(name);
}

// 老存档里前缀是旧默认值 "QG"，统一换成 "ComfyUI"。
// 只做一次：迁移后在 properties 里留个标记（会跟着工作流存盘），
// 之后用户就算自己写回 "QG" 也不会再被改第二次。
function migratePrefix(node) {
    const props = node.properties || (node.properties = {});
    if (props.__qgPrefixMigrated) return;
    props.__qgPrefixMigrated = true;
    const prefix = widgetOf(node, "filename_prefix");
    if (!prefix) return;
    if (String(prefix.value ?? "").trim() !== LEGACY_PREFIX) return;
    prefix.value = DEFAULT_PREFIX;
    prefix.callback?.(DEFAULT_PREFIX, app.canvas, node, [0, 0], null);
}

// ---------------------------------------------------------------- 概要行

function shortAlpha(value) {
    if (value === KEEP_ALPHA) return "透明";
    if (value === FLAT_WHITE) return "白底";
    if (value === FLAT_BLACK) return "黑底";
    return String(value ?? "");
}

function summaryOf(node) {
    const value = (name) => widgetOf(node, name)?.value;
    const format = String(value("format") ?? "");
    const parts = [format];
    if (format && format !== "PNG") parts.push(String(value("quality") ?? ""));
    if (format === "JPEG") {
        const sub = String(value("subsampling") ?? "");
        // 「4:4:4（最高画质）」→「4:4:4」，概要里塞不下整句
        if (sub) parts.push(sub.split("（")[0].split("(")[0].trim());
    }
    if (value("alpha_mode")) parts.push(shortAlpha(value("alpha_mode")));
    const prefix = String(value("filename_prefix") ?? "").trim();
    if (prefix) parts.push(prefix);
    return parts.filter(Boolean).join(" · ");
}

// 概要在节点最底下那一行（用户要求「保留」在底部）。
// 起始 x 跟着「图像」槽位标签走，避开它。
const SUMMARY_FONT = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
const TITLE_HEIGHT = 30; // LiteGraph 标题栏高度（概要在它还下面，太矮就没地方画）

// ComfyUI 执行完会往节点里塞一个弹性的图片预览 widget（名字 `$$canvas-image-preview`），
// 它把「节点剩余高度」全部吃掉，于是预览自己那行 `1824 x 3243` 就画到了节点最底下，
// 跟概要行压在一起。把它能拿的上限压掉一行：预览会自己缩着重画，尺寸字跟着上移。
const PREVIEW_WIDGET = "$$canvas-image-preview";

function shareBottomRow(node) {
    const preview = node.widgets?.find((w) => w && w.name === PREVIEW_WIDGET);
    if (!preview || preview.__qgShareBottom) return;
    const layout = preview.computeLayoutSize;
    if (typeof layout !== "function") return;
    preview.__qgShareBottom = true;
    preview.__qgOrigLayout = layout; // 探针要用它做「修之前」的对照
    preview.computeLayoutSize = function (...args) {
        const size = layout.apply(this, args);
        // 布局在 node.computeSize 内部跑，那一刻 freeWidgetSpace 还不可靠（实测会偏大），
        // 所以自己用节点高度和预览的上沿算：底边正好停在概要行上面。
        const nodeHeight = node.size?.[1] ?? 0;
        const top = this.y;
        if (!nodeHeight || typeof top !== "number") return size;
        const room = nodeHeight - top - SUMMARY_HEIGHT;
        // 🔴 光压 `maxHeight` 没用：预览的 `minHeight` 是「按图片比例给的硬值」（270 宽的 4:3
        //    = 220），布局分配时以 min 为准，`maxHeight` 压到 198 也会被无视、预览照样吃满整块，
        //    概要整行被 `__qgSummaryHidden` 吞掉（默认高度下看不见摘要）。
        //    所以 min/max **一起**压到 room：预览缩 22px 换一行概要，用户要的就是这一行。
        if (room <= 8) return size;
        const capped = Math.max(8, room);
        return {
            ...size,
            minHeight: Math.min(size.minHeight ?? capped, capped),
            maxHeight: capped,
        };
    };
    // 布局（computedHeight）只在节点尺寸变化 / arrange 时重算，装好钩子后得催一次，
    // 否则预览还保持旧高度，直到用户拖动节点才对齐。
    try {
        node.arrange?.();
    } catch (err) {
        console.warn("[QG] 预览重排失败", err);
    }
}

function drawSummary(node, ctx) {
    const width = node.size?.[0] || 0;
    const height = node.size?.[1] || 0;
    if (!width || height < TITLE_HEIGHT + 10) return;
    // 节点矮到预览放不下时（预览自己有 minHeight 硬下限，压不下去）就让位给它，
    // 宁可这一帧不显示概要，也别把两行字叠在一起。
    const preview = node.widgets?.find((w) => w && w.name === PREVIEW_WIDGET);
    const previewBottom = preview ? (preview.y ?? 0) + (preview.computedHeight ?? 0) : 0;
    node.__qgSummaryHidden = previewBottom > height - SUMMARY_HEIGHT + 1;
    if (node.__qgSummaryHidden) return;
    ctx.save();
    ctx.font = SUMMARY_FONT;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let text = summaryOf(node);
    // 齿轮搬去标题栏后，这一整行都归概要，左右各留 15px
    const room = width - 30;
    if (room > 12 && ctx.measureText(text).width > room) {
        while (text.length > 1 && ctx.measureText(text + "…").width > room) text = text.slice(0, -1);
        text += "…";
    }
    ctx.fillStyle = "#9ba2aa";
    ctx.fillText(text, 15, height - SUMMARY_HEIGHT / 2);
    ctx.restore();
}

// ---------------------------------------------------------------- 样式

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
  /* 齿轮画在画布标题栏上（见 drawGear），这里只剩参数面板的样式 */
  .qgtools-exp-pop { position: fixed; z-index: 10000; width: 330px; background: #1c1f23;
    border: 1px solid #3a4047; border-radius: 7px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
    font: 12px system-ui; color: #d7dde2; display: flex; flex-direction: column; }
  .qgtools-exp-pop * { box-sizing: border-box; }
  .qgtools-exp-head { display: flex; align-items: center; gap: 7px; padding: 9px 10px;
    border-bottom: 1px solid #2c3238; color: ${BRAND}; font-weight: 600; }
  .qgtools-exp-head svg { flex: none; }
  .qgtools-exp-close { margin-left: auto; width: 22px; height: 22px; border: none;
    border-radius: 5px; background: transparent; color: #9ba2aa; cursor: pointer;
    font-size: 14px; line-height: 1; }
  .qgtools-exp-close:hover { background: #2c3238; color: #fff; }
  .qgtools-exp-body { display: flex; flex-direction: column; padding: 5px 10px 9px;
    max-height: 68vh; overflow-y: auto; }
  .qgtools-exp-body > * { flex-shrink: 0; }
  .qgtools-exp-row { display: flex; align-items: center; gap: 10px; min-height: 34px;
    padding: 3px 0; }
  .qgtools-exp-row.off { opacity: .45; }
  .qgtools-exp-label { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;
    gap: 1px; }
  .qgtools-exp-label .hint { color: #9ba2aa; font-size: 10.5px; line-height: 1.35; }
  .qgtools-exp-row.off .qgtools-exp-label .hint { color: #6a727a; }
  .qgtools-exp-row select, .qgtools-exp-row input { flex: none; height: 24px;
    border: 1px solid #3a4047; border-radius: 5px; background: #23272c; color: inherit;
    font: inherit; outline: none; }
  .qgtools-exp-row select { width: 138px; padding: 0 4px; cursor: pointer; }
  .qgtools-exp-row input { width: 138px; padding: 0 8px; }
  .qgtools-exp-row input[type=number] { width: 72px; text-align: center; }
  .qgtools-exp-row select:focus, .qgtools-exp-row input:focus { border-color: ${BRAND}; }
  .qgtools-exp-row select:disabled, .qgtools-exp-row input:disabled {
    opacity: .45; cursor: default; }
  .qgtools-exp-sep { height: 1px; background: #2c3238; margin: 6px 0 2px; }
  .qgtools-exp-foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-top: 1px solid #2c3238; }
  .qgtools-exp-note { color: #9ba2aa; font-size: 11px; line-height: 1.4; flex: 1 1 auto; }
  .qgtools-exp-btn { height: 24px; border: 1px solid ${BRAND}; border-radius: 5px;
    background: ${BRAND}; color: #08211f; cursor: pointer; padding: 0 14px; font: inherit;
    font-weight: 600; flex: none; }
  .qgtools-exp-btn:hover { filter: brightness(1.1); }
  `;
    document.head.append(style);
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// ---------------------------------------------------------------- 设置面板

let closeActivePanel = null;
// 面板当前挂在哪个节点上（齿轮是画布图形，没 DOM 元素可以比对，只能记节点）
let panelNode = null;

function closePanel() {
    panelNode = null;
    if (!closeActivePanel) return;
    closeActivePanel();
    closeActivePanel = null;
}

function openPanel(node, anchor) {
    ensureCss();
    closePanel();
    panelNode = node;
    const pop = element("div", "qgtools-exp-pop");

    const head = element("div", "qgtools-exp-head");
    const icon = element("span");
    icon.innerHTML = gearIconSvg();
    const close = element("button", "qgtools-exp-close", "×");
    close.type = "button";
    close.title = zh("Close");
    head.append(icon, element("span", "", "导出图像设置"), close);

    const body = element("div", "qgtools-exp-body");
    const controls = {};

    // 按当前格式刷新每行的禁用状态
    const sync = () => {
        for (const name of FOLDED) {
            const entry = controls[name];
            if (!entry) continue;
            const off = isUnused(node, name);
            entry.control.disabled = off;
            entry.row.classList.toggle("off", off);
            if (name === "alpha_mode") {
                // JPEG 下「保留透明」这一项单独禁用，其余照常
                const keep = [...entry.control.options].find((option) => option.value === KEEP_ALPHA);
                if (keep) keep.disabled = widgetOf(node, "format")?.value === "JPEG";
            }
        }
    };

    const write = (name, raw) => {
        const widget = widgetOf(node, name);
        if (!widget) return;
        widget.value = raw;
        widget.callback?.(raw, app.canvas, node, [0, 0], null);
        normalize(node);
        // normalize 可能改了 alpha_mode，把面板上的显示拉回来
        const alpha = controls.alpha_mode;
        if (alpha) alpha.control.value = String(widgetOf(node, "alpha_mode")?.value ?? "");
        sync();
        node.setDirtyCanvas(true, true);
        notifyQgChange();
    };

    for (const name of FOLDED) {
        const widget = widgetOf(node, name);
        if (!widget) continue;
        const row = element("div", "qgtools-exp-row");
        const label = element("div", "qgtools-exp-label");
        label.append(element("span", "", LABELS[name] ?? name));
        if (NOTES[name]) label.append(element("span", "hint", NOTES[name]));

        let control;
        const values = widget.options?.values;
        if (Array.isArray(values) && values.length) {
            control = element("select");
            for (const option of values) {
                const item = element("option", "", String(option));
                item.value = String(option);
                control.append(item);
            }
            control.value = String(widget.value);
            control.addEventListener("change", () => write(name, control.value));
        } else if (typeof widget.value === "number") {
            control = element("input");
            control.type = "number";
            if (widget.options?.min !== undefined) control.min = String(widget.options.min);
            if (widget.options?.max !== undefined) control.max = String(widget.options.max);
            if (widget.options?.step !== undefined) control.step = String(widget.options.step);
            control.value = String(widget.value);
            const commit = () => {
                const number = Number(control.value);
                if (!Number.isFinite(number)) {
                    control.value = String(widgetOf(node, name)?.value ?? "");
                    return;
                }
                write(name, number);
                control.value = String(widgetOf(node, name)?.value ?? number);
            };
            control.addEventListener("change", commit);
            control.addEventListener("keydown", (event) => {
                // 输入框里的按键别让画布快捷键吃了
                event.stopPropagation();
                if (event.key === "Enter") commit();
            });
        } else {
            control = element("input");
            control.type = "text";
            control.value = String(widget.value ?? "");
            control.addEventListener("change", () => write(name, control.value));
            control.addEventListener("keydown", (event) => {
                event.stopPropagation();
                if (event.key === "Enter") write(name, control.value);
            });
        }
        // 文件名和保存路径是两个文本输入，前面拉一条分割线，视觉上和编码参数分开
        if (name === "save_path") body.append(element("div", "qgtools-exp-sep"));
        row.append(label, control);
        body.append(row);
        controls[name] = {row, control};
    }

    const foot = element("div", "qgtools-exp-foot");
    foot.append(element("div", "qgtools-exp-note", "改完直接关掉，值已经写进节点"));
    const done = element("button", "qgtools-exp-btn", "好");
    done.type = "button";
    done.addEventListener("click", () => closePanel());
    foot.append(done);

    pop.append(head, body, foot);
    document.body.append(pop);
    sync();

    // 贴着齿轮下方展开；下方放不下就翻到上面
    const place = () => {
        const box = pop.getBoundingClientRect();
        // 左边缘对齐齿轮，超出右边界就往左推
        const left = Math.min(anchor.left, window.innerWidth - box.width - 8);
        let top = anchor.bottom + 4;
        if (top + box.height > window.innerHeight - 8) top = Math.max(8, anchor.top - box.height - 4);
        pop.style.left = `${Math.max(8, left)}px`;
        pop.style.top = `${top}px`;
    };
    place();
    requestAnimationFrame(place);

    const abort = new AbortController();
    close.addEventListener("click", () => closePanel());
    document.addEventListener(
        "pointerdown",
        (event) => {
            if (pop.contains(event.target)) return;
            // 点在齿轮 / 概要上时别先关：那一下由 onMouseDown 当开关处理，
            // 这里再关就会变成「关掉又立刻打开」，看着像点不动。
            if (hitZone(node, clientToLocal(node, event))) return;
            closePanel();
        },
        {capture: true, signal: abort.signal},
    );
    window.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closePanel();
        },
        {capture: true, signal: abort.signal},
    );
    closeActivePanel = () => {
        abort.abort();
        pop.remove();
    };
}

// ---------------------------------------------------------------- 齿轮（画在标题栏上）

// 齿轮紧挨 `?` 左边：`?` 的圆心是 badgeCenter() 给的 [宽-16, -15]，再左移 22px 就是齿轮。
// 借这个函数（而不是自己写 16）是为了以后 `?` 挪位置时两个图标还在一起。
const GEAR_STEP = 22;
const GEAR_RADIUS = 7;
// gearIconSvg 的 viewBox 是 16×16（-8..8），缩到 13px 左右，跟 `?` 那个 r=7 的圈一般大
const GEAR_SCALE = 0.85;
const GEAR_INK = "rgba(155,162,170,0.8)"; // 和 `?` 同一个灰

function gearCenter(nodeWidth) {
    const [cx, cy] = badgeCenter(nodeWidth);
    return [cx - GEAR_STEP, cy];
}

function gearShown(node) {
    return showBadge(node.size?.[0] ?? 0, node.flags?.collapsed);
}

// 命中区比图形大一圈，和 `?` 的礼貌一致（±10 × ±11）。
// 右边界故意给到 +12：正好贴上 `?` 的命中区（宽-26），中间不留点不到的缝。
function hitsGear(pos, nodeWidth) {
    const [cx, cy] = gearCenter(nodeWidth);
    return pos[0] >= cx - 10 && pos[0] <= cx + 12 && pos[1] >= cy - 11 && pos[1] <= cy + 11;
}

// 齿轮用 canvas 路径画，不用 ctx.drawImage(gearIconSvg())：画布整体按缩放系数放大，
// 位图会糊、路径不会。形状照抄 gearIconSvg 的坐标（8 个齿 + 外圆 4.6 + 内孔 2.1）。
function drawGear(node, ctx) {
    if (!gearShown(node)) return;
    const [cx, cy] = gearCenter(node.size[0]);
    // 鼠标离开节点时 node.onMouseMove 就不再被调，光靠标记会一直亮着；
    // 再对一眼 canvas.node_over，离开后下一帧自动回落。
    const hover = node.__qgGearHover && app.canvas?.node_over === node;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(GEAR_SCALE, GEAR_SCALE);
    ctx.fillStyle = hover ? BRAND : GEAR_INK;
    for (let i = 0; i < 8; i += 1) {
        ctx.save();
        ctx.rotate((i * Math.PI) / 4);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-1.4, -8, 2.8, 4.4, 1);
        else ctx.rect(-1.4, -8, 2.8, 4.4);
        ctx.fill();
        ctx.restore();
    }
    // 内孔用 evenodd 挖空：底下就是节点标题栏，挖掉自然透出标题色，等于 SVG 里那个洞
    ctx.beginPath();
    ctx.arc(0, 0, 4.6, 0, Math.PI * 2);
    ctx.arc(0, 0, 2.1, 0, Math.PI * 2);
    ctx.fill("evenodd");
    ctx.restore();
}

// 节点局部坐标 -> 屏幕坐标，面板要按屏幕坐标定位
// ⚠️ 换算必须照 LiteGraph 的口径：convertOffsetToCanvas 是 `(world + offset) * scale`，
//    不是 `world * scale + offset`。两者只在缩放 1.0 时碰巧相等，一旦画布缩放就会偏，
//    面板会飞到一个看着「没反应」的位置。
function gearAnchor(node) {
    const canvas = app.canvas;
    const [lx, ly] = gearCenter(node.size?.[0] ?? 0);
    const box = canvas?.canvas?.getBoundingClientRect?.() ?? {left: 0, top: 0};
    const scale = canvas?.ds?.scale ?? 1;
    const offset = canvas?.ds?.offset ?? [0, 0];
    const cx = box.left + (node.pos[0] + lx + offset[0]) * scale;
    const cy = box.top + (node.pos[1] + ly + offset[1]) * scale;
    const half = GEAR_RADIUS * scale;
    return {left: cx - half, top: cy - half, bottom: cy + half, width: half * 2};
}

function clientToLocal(node, event) {
    const canvas = app.canvas;
    if (!canvas?.canvas || !event) return null;
    const box = canvas.canvas.getBoundingClientRect();
    const scale = canvas.ds.scale;
    const offset = canvas.ds.offset;
    // convertCanvasToOffset：world = screen / scale - offset
    return [
        (event.clientX - box.left) / scale - offset[0] - node.pos[0],
        (event.clientY - box.top) / scale - offset[1] - node.pos[1],
    ];
}

// 齿轮和概要行都是「开关面板」的入口，命中判定合成一处，鼠标和 pointerdown 都用它
function hitZone(node, pos) {
    if (!pos) return null;
    // 四角的缩放手柄必须先让开，见 inResizeCorner 的注释
    if (inResizeCorner(node, pos)) return null;
    if (gearShown(node) && hitsGear(pos, node.size[0])) return "gear";
    const height = node.size?.[1] ?? 0;
    if (pos[1] >= height - SUMMARY_HEIGHT && pos[1] <= height) return "summary";
    return null;
}

// 🔴 缩放手柄是四角各 15x15（`LGraphNode.resizeHandleSize`），而 canvas 的处理顺序是
//    `if (node.onMouseDown?.(...)) { return }` → 然后才 `if (node.findResizeDirection(...))`。
//    也就是说 onMouseDown 只要返回 true，resize 就永远轮不到 —— 节点会「拉不大」。
//    概要行是整行宽、又贴在节点底部，正好把右下角手柄包在里面（踩过：拖右下角弹出设置面板）。
const RESIZE_HANDLE = 15;

function inResizeCorner(node, pos) {
    const width = node.size?.[0] ?? 0;
    const height = node.size?.[1] ?? 0;
    const nearX = pos[0] <= RESIZE_HANDLE || pos[0] >= width - RESIZE_HANDLE;
    const nearY = pos[1] <= RESIZE_HANDLE || pos[1] >= height - RESIZE_HANDLE;
    return nearX && nearY;
}

function togglePanel(node) {
    // 面板 DOM 有可能被别处收走（切标签页、扩展清理），此时 panelNode 还指着它，
    // 光看 panelNode 会判成「已开」→ 只执行关闭 → 用户看到的就是「点了没反应」。
    if (panelNode === node && document.querySelector(".qgtools-exp-pop")) {
        closePanel();
        return;
    }
    openPanel(node, gearAnchor(node));
}

// ---------------------------------------------------------------- 挂载

function foldAll(node) {
    // 折叠前的高度（此时 computeSize 已经包过 +SUMMARY_HEIGHT）
    const before = node.computeSize();
    for (const name of FOLDED) {
        const widget = widgetOf(node, name);
        if (widget) foldWidget(widget);
    }
    // 只收「还停在默认高度」的节点：用户为了看预览手动拉高过的，别把他的高度改掉
    if ((node.size?.[1] ?? 0) <= before[1] + 8) node.setSize(node.computeSize());
}

function hookNode(node) {
    if (node.__qgFoldHooked) {
        foldAll(node);
        normalize(node);
        return;
    }
    node.__qgFoldHooked = true;

    // 概要行的高度要算进节点尺寸，否则它会被画到节点外面。
    // 必须在 foldAll 之前包好，否则算出来的是「只有标题栏 + 槽位」的高度。
    const computeSize = node.computeSize;
    node.computeSize = function () {
        const [width, height] = computeSize.call(this);
        return [Math.max(width, MIN_WIDTH), height + SUMMARY_HEIGHT];
    };

    const drawWidgets = node.drawWidgets;
    node.drawWidgets = function (ctx, options) {
        shareBottomRow(this); // 预览 widget 是执行后才出现的，每帧认一次
        const result = drawWidgets?.call(this, ctx, options);
        drawSummary(this, ctx);
        return result;
    };

    // 齿轮跟 `?` 一样画在标题栏上：同一套 onDrawForeground，坐标系就是节点局部坐标，
    // 缩放 / 拖拽 / 折叠都不用管。
    const onDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        const result = onDrawForeground?.apply(this, arguments);
        drawGear(this, ctx);
        return result;
    };

    // 悬停高亮：只在状态变化时重绘，别让每帧都刷
    const onMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, localPos) {
        const hover = !!(gearShown(this) && localPos && hitsGear(localPos, this.size[0]));
        if (hover !== !!this.__qgGearHover) {
            this.__qgGearHover = hover;
            this.setDirtyCanvas(true, true);
        }
        return onMouseMove?.apply(this, arguments);
    };

    const onMouseLeave = node.onMouseLeave;
    node.onMouseLeave = function () {
        if (this.__qgGearHover) {
            this.__qgGearHover = false;
            this.setDirtyCanvas(true, true);
        }
        return onMouseLeave?.apply(this, arguments);
    };

    // 齿轮和概要行都是面板开关（同一个点第二次 = 关）
    const onMouseDown = node.onMouseDown;
    node.onMouseDown = function (event, localPos, canvas) {
        if (hitZone(this, localPos)) {
            togglePanel(this);
            return true; // 吃掉点击，别让它变成拖节点
        }
        return onMouseDown?.call(this, event, localPos, canvas);
    };

    // 读存档之后也要收一遍（格式可能是 PNG / WEBP）
    const configured = node.onConfigure;
    node.onConfigure = function () {
        const result = configured?.apply(this, arguments);
        migratePrefix(this);
        foldAll(this);
        normalize(this);
        return result;
    };

    foldAll(node);
    normalize(node);
}

app.registerExtension({
    name: "QG.ExportImage",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            hookNode(this);
            return result;
        };
    },
    async setup() {
        // 排查用：控制台 __qgExportImage 一看就知道扩展装没装
        window.__qgExportImage = {
            version: 8,
            summary: summaryOf,
            open: openPanel,
            close: closePanel,
            gear: gearCenter,
            migratePrefix,
            prefixDefault: DEFAULT_PREFIX,
        };
    },
});

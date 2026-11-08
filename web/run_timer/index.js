// ============================================================
// 搬入说明（2026-11-08，用户确认后 1:1 替换）
//   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/timer.js
//   口径：保留节点 ID QG_RunTimer；源文件的全部绘制、计时、菜单、Vue overlay
//         逻辑逐字保留（反向还原后与源文件逐字节相同，见工作区校验脚本）。
//
//   只做五处必要适配：
//     1) NODE_CLASS "QG_Timer" -> "QG_RunTimer"；扩展名 QG.Timer -> QG.RunTimer；
//     2) 内置脚本 import 改绝对路径 /scripts/app.js、/scripts/api.js（本包约定）；
//     3) FONT_URL 的相对层级 ../../ -> ../../../（文件从 web/ 根移到
//        web/run_timer/ 子目录，仍要解析到站点根 /qg/timer/font）；
//     4) 控制台日志前缀 [QG-Timer] -> [QG-tools]；
//     5) 文件名 web/timer.js -> web/run_timer/index.js（ComfyUI 自动加载）。
//   保持不变：DEFAULT_SIZE [510,140]、MIN_WIDTH 510、主题中文名、右键菜单、
//   VUE_LAYER_ID "qg-timer-vue-layer"、window.__QG_VUE_LAYER__ 调试钩子、
//   status 广播 + /queue 轮询兜底、/prompt 之外的所有事件判定。
//
//   ⚠️ 面板宽度 510 必须同步写进 web/shared/node_width.mjs 的 SIZES，
//   否则 pinNodeWidth 会在 onNodeCreated 把节点钉成旧版的 176。
// ============================================================

/**
 * QG Timer —— ComfyUI 画布上的耗时显示节点（原创实现）。
 *
 * v2：
 *  - 不渲染节点标题栏（title_mode = NO_TITLE）；
 *  - 通过伪装成内置模块，隐藏右上角的来源徽章（不动全局设置）；
 *  - 面板上不显示任何控件：主题与字体颜色都在右键菜单里切换；
 *  - 字体颜色提供 7 个预设色 + “自定义…”（系统取色器）；
 *  - 计时基于 ComfyUI 事件：入队开始、空闲结束、出错、中断。
 *
 * v3（对照 ComfyUI-AusBoss 的 RunTimer 重写事件层）：
 *  - executing 的 detail 本机前端是裸节点 id、旧版是对象，必须两种都认，
 *    否则每个节点开始执行都会被误判成“整个 prompt 结束”而停表；
 *  - 用 100ms 定时器主动把节点标脏（setDirtyCanvas），不依赖画布 rAF 循环；
 *  - 增加 status 广播与 /prompt 轮询两级兜底，client_id 丢失、WS 执行事件
 *    整段缺失时计时器照样能起停。
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "QG_RunTimer";
const FONT_FAMILY = "Capture It";
// 用 import.meta.url 推导字体地址：ComfyUI 若部署在子路径（如 /comfy/）也能命中
const FONT_URL = new URL("../../../qg/timer/font", import.meta.url).href;

// 本机前端 1.57.4 确认常量表：NORMAL_TITLE=0 / NO_TITLE=1 / TRANSPARENT_TITLE=2 / AUTOHIDE_TITLE=3。
// 运行时优先读全局常量，前端升级改值时自动跟随；读不到再用 1 兜底。
const noTitleMode = () => globalThis.LiteGraph?.NO_TITLE ?? 1;
// 来源徽章读的就是这个字段：写 "nodes" 会被当成内置节点、不显示「自定义节点」标记。
// 那是从自有插件搬过来时的伪装，Registry 标准里「冒充他人或误导性行为」是禁止项，
// 这里如实写本包路径 —— 徽章会显示成自定义节点，这是应该的。
const MODULE_NAME = "custom_nodes.ComfyUI-QG-tools";

/* 面板尺寸：按最长读数 "000.0s" 预留宽度，避免位数增加时被压缩或抖动 */
const DEFAULT_SIZE = [510, 140];
const MIN_WIDTH = 510; // 老工作流里的窄节点在加载时补到这个宽度

const THEMES = {
    "暗夜": {
        bg: "#0d0f0e", border: "#272c28", text: "#c9d1cb",
        dot: { idle: "#565b57", running: "#57c26a", done: "#4f9dd9", error: "#d9534f" },
    },
    "苔绿": {
        bg: "#10201a", border: "#274233", text: "#d7eade",
        dot: { idle: "#43604f", running: "#5fd98a", done: "#5fb9d9", error: "#e06a5a" },
    },
    "暖沙": {
        bg: "#1d1812", border: "#3b3327", text: "#e8dfc9",
        dot: { idle: "#5d5343", running: "#d9b95f", done: "#d98f5f", error: "#d9534f" },
    },
};

/* ---------- 计时状态（队列级，多实例共享） ---------- */

const timer = { running: false, startAt: 0, frozen: 0, status: "idle" };
const instances = new Set();
let tickId = 0;

/** 某块面板此刻应显示的读数与状态。
 *
 * 运行中由全局计时器统一驱动（同一队列的所有面板同步走）；
 * 静止时各面板读自己保存的值，这样画布上放多块面板、或连续加载不同工作流时
 * 不会出现"A 面板显示 B 面板的历史读数"这种串扰。
 */
function stateOf(node) {
    if (timer.running) {
        return { ms: performance.now() - timer.startAt, status: timer.status };
    }
    const p = node && node.properties;
    const ms =
        p && typeof p.lastMs === "number" && isFinite(p.lastMs) && p.lastMs >= 0
            ? p.lastMs
            : timer.frozen;
    const status = (p && typeof p.lastStatus === "string" && p.lastStatus) || timer.status;
    return { ms, status };
}

/* 读数不走 ComfyUI 的渲染循环：新版前端只有节点自己的 setDirtyCanvas 能可靠
 * 触发重绘，而且 requestAnimationFrame 在标签页失焦/被节流时会整段停摆。
 * 这里沿用源插件的做法，用 100ms 定时器主动把节点标脏。 */
/* 面板画在 onDrawBackground（背景层），所以只标脏背景层。
 * LiteGraph 的 setDirty(fg, bg) 里第二个参数才是背景层；前景层交给它自己
 * 按鼠标/交互节奏重绘。两层都每 100ms 强制全刷时，鼠标一动就会两层交替
 * 清空重画，读数看起来闪烁、乱跳。 */
function requestRepaint() {
    app.canvas?.setDirty?.(false, true);
    for (const node of instances) node.setDirtyCanvas?.(false, true);
}

function pump() {
    if (!timer.running || instances.size === 0) return;
    requestRepaint();
}

function startTicking() {
    if (!tickId) tickId = setInterval(pump, 100);
}

function stopTicking() {
    if (tickId) {
        clearInterval(tickId);
        tickId = 0;
    }
}

/** resume=true 用于 status / /queue 轮询的"兜底补启动"：
 * 页面加载阶段偶尔会先收到一个杂散的结束信号把表停掉，随后轮询发现有任务
 * 在跑又把表拉起来。若这时从 0 起算，读数会突然倒退回 0.0 —— 用户看到的
 * "数字乱跳"。兜底补启动一律从上次冻结值接着走；真正的新任务由
 * execution_start 触发，仍然从 0 开始。 */
function startTimer(resume = false) {
    const base = resume && timer.frozen > 0 ? timer.frozen : 0;
    timer.startAt = performance.now() - base;
    timer.running = true;
    timer.status = "running";
    startTicking();
}

function remember(status) {
    for (const node of instances) {
        // 实例的生命周期由 onRemoved 维护；这里只写属性，不做增删，
        // 避免在"刚创建、还没加入图"的瞬间误删实例。
        if (!node.properties) node.properties = {};
        node.properties.lastMs = timer.frozen;
        node.properties.lastStatus = status;
    }
}

function stopTimer(status) {
    if (timer.running) timer.frozen = performance.now() - timer.startAt;
    timer.running = false;
    timer.status = status;
    remember(status);
    pushHistory(status);
    requestRepaint();
    stopTicking();
}

/* ---------- 历史记录 ---------- */

// 最近几次读数写进 node.properties.history，跟着工作流一起保存 —— 用途是
// 「刚才那几次为什么慢」，一眼能看到波动。只留 5 条：每条 3 个字段，5 条
// 不到 200 字节，不会把工作流 JSON 撑大。
const HISTORY_MAX = 5;

function pushHistory(status) {
    if (status !== "done" && status !== "error") return;   // idle/中断不算一次运行
    const ms = Math.round(timer.frozen);
    if (!(ms > 0)) return;
    for (const node of instances) {
        if (!node.properties) node.properties = {};
        const list = Array.isArray(node.properties.history) ? node.properties.history : [];
        const last = list[0];
        // execution_success 和 /queue 轮询可能各报一次结束，同一次不重复记。
        if (last && last.ms === ms && last.status === status) continue;
        list.unshift({ ms: ms, status: status, at: Date.now() });
        node.properties.history = list.slice(0, HISTORY_MAX);
    }
}

function historyMenuItems(node) {
    const list = Array.isArray(node.properties.history) ? node.properties.history : [];
    const items = list.map((h) => {
        const at = h.at ? new Date(h.at) : null;
        return {
            content: `${fmtSeconds(h.ms)} s` +
                (h.status === "error" ? " · 失败" : "") +
                (at ? " · " + at.toLocaleTimeString() : ""),
            disabled: true,
        };
    });
    if (!items.length) items.push({ content: "（还没有记录）", disabled: true });
    items.push({
        content: "清空历史",
        disabled: !list.length,
        callback: () => {
            node.properties.history = [];
            requestRepaint();
        },
    });
    return items;
}

function resetTimer() {
    stopTicking();
    timer.running = false;
    timer.frozen = 0;
    timer.status = "idle";
    remember("idle");
    requestRepaint();
}

/* ---------- 字体加载 ---------- */

let fontStatus = "loading";
// 墨迹测量缓存：key 为 "字号|文本"，字体加载完成后清空一次
const inkCache = new Map();

/* 测量专用离屏 ctx。主画布的 textAlign / textBaseline / direction 会被 LiteGraph
 * 的其它绘制路径改来改去（鼠标移动时尤其频繁），actualBoundingBox* 会跟着变，
 * 同一串数字能测出不同墨迹，字号和基线就每帧跳。测量必须放在固定环境里。 */
const measureCtx = (() => {
    try {
        const c = document.createElement("canvas").getContext("2d");
        if (c) {
            c.textAlign = "left";
            c.textBaseline = "alphabetic";
            c.direction = "ltr";
        }
        return c;
    } catch {
        return null;
    }
})();

try {
    const face = new FontFace(FONT_FAMILY, `url(${FONT_URL})`);
    face.load()
        .then((loaded) => {
            document.fonts.add(loaded);
            fontStatus = "ok";
            inkCache.clear(); // 之前可能是用兜底字体量的，作废
            requestRepaint();
        })
        .catch((err) => {
            fontStatus = "fail";
            console.warn("[QG-tools] Capture it 字体加载失败：", err?.message || err);
        });
} catch (err) {
    fontStatus = "fail";
    console.warn("[QG-tools] 无法创建 FontFace：", err?.message || err);
}

/* ---------- 绘制 ---------- */

function roundedPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function withAlpha(hex, alpha) {
    let h = String(hex || "").replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h || "c9d1cb", 16);
    if (Number.isNaN(n)) return `rgba(201,209,203,${alpha})`;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 读数格式：整数部分不补前导零，小数只留一位（0.1 秒）。
 * 两位小数时百分位几乎每次重绘都在变，视觉上就是"小数点后面那位乱跳"；
 * 100ms 的重绘节奏配 0.1s 精度刚好一帧一格，稳定得多。
 * 宽度仍按固定 "000.0" 槽位预留，位数变化时字号、单位位置都不会跳。
 */
function fmtSeconds(ms) {
    // 用整数"十分之一秒"计算，避免 (ms/1000 - int) * 10 的浮点误差
    const tenths = Math.floor(Math.max(0, ms) / 100);
    const intPart = Math.floor(tenths / 10);
    return `${intPart}.${tenths % 10}`;
}

const TEXT_COLORS = [
    ["浅灰", "#c9d1cb"],
    ["纯白", "#ffffff"],
    ["薄荷", "#7ce0a1"],
    ["天青", "#6fc3e8"],
    ["琥珀", "#e8c46f"],
    ["珊瑚", "#e8806f"],
    ["紫罗兰", "#b49be8"],
];

function colorMenuItems(node) {
    const current = String(node.properties.textColor || "").toLowerCase();
    const items = TEXT_COLORS.map(([name, hex]) => ({
        content: (current === hex ? "● " : "○ ") + name + "  " + hex,
        callback: () => {
            node.properties.textColor = hex;
            requestRepaint();
        },
    }));
    items.push({
        content: "自定义…",
        callback: () => {
            const picker = ensureColorPicker(node);
            picker.value = node.properties.textColor || "#c9d1cb";
            picker.click();
        },
    });
    return items;
}

function drawBody(node, ctx) {
    // 兜底登记：从工作流加载 / Vue Nodes / 重建的节点未必走 onNodeCreated 或
    // onConfigure，但只要它被画出来就一定在画布上。放在这里最可靠，
    // remember() 的读数保存和 requestRepaint() 的节点级标脏才不会漏。
    if (!instances.has(node)) instances.add(node);
    const props = node.properties || {};
    const theme = THEMES[props.theme] || THEMES["暗夜"];
    const textColor = props.textColor || theme.text;
    const state = stateOf(node);
    const w = Math.max(24, node.size?.[0] || 0);
    const h = Math.max(24, node.size?.[1] || 0);

    ctx.save();

    roundedPath(ctx, 1, 1, w - 2, h - 2, 16);
    ctx.fillStyle = theme.bg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.border;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(34, h / 2, Math.min(9, Math.max(6, Math.round(h * 0.055))), 0, Math.PI * 2);
    ctx.fillStyle = theme.dot[state.status] || theme.dot.idle;
    ctx.fill();

    const font = (px) => `${px}px "${FONT_FAMILY}", ui-monospace, monospace`;
    const num = fmtSeconds(state.ms);
    // 测量基准：按最长读数形态量墨迹高度/宽度，供字号、基线、超宽判定使用
    const SLOT_TEXT = "000.0";

    /* 排布策略：不看 font-size，看"墨迹"。
     * 字体自带的上下留白（ascent/descent 里没有笔画的部分）会让读数上下多出黑边，
     * 所以先用 100px 探一次实际墨迹高度，反算出"让墨迹占面板高度 INK_RATIO"的字号，
     * 再按 ascent/descent 把墨迹整体垂直居中。这样黑边只由比例决定，与字体无关。
     */
    const INK_RATIO = 0.68;
    const REF = 100;
    const unitRatio = 0.42;

    const inkOf = (px, text) => {
        const key = px + "|" + text;
        const hit = inkCache.get(key);
        if (hit) return hit;
        // 只在离屏 ctx 上量，绝不碰主画布状态
        const mctx = measureCtx || ctx;
        mctx.font = font(px);
        const m = mctx.measureText(text);
        const ascent = m.actualBoundingBoxAscent ?? px * 0.72;
        const descent = m.actualBoundingBoxDescent ?? 0;
        const width =
            (m.actualBoundingBoxLeft ?? 0) + (m.actualBoundingBoxRight ?? m.width) || m.width;
        // advance 是排版宽度（fillText 的 center/right 对齐按它算），
        // width 是墨迹宽度，两者不能混用：固定字符槽位必须用 advance。
        const info = { ascent, descent, ink: ascent + descent, width, advance: m.width };
        // 字号会随节点尺寸连续变化，缓存做一个上限，避免无限增长
        if (inkCache.size > 400) inkCache.clear();
        inkCache.set(key, info);
        return info;
    };

    const probe = inkOf(REF, SLOT_TEXT);
    const inkPerPx = probe.ink > 1 ? probe.ink / REF : 0.72;

    let numPx = Math.max(20, Math.round((h * INK_RATIO) / inkPerPx));
    let unitPx = Math.max(10, Math.round(numPx * unitRatio));
    let slotInk = inkOf(numPx, SLOT_TEXT);
    // 槽位宽度只由固定的 "000.0" 决定，绝不掺当前读数：
    // 掺了之后每次读数变化都会改变宽度，超宽收缩的系数 k 也跟着变，字号会跳。
    let slotW = slotInk.width;
    let unitW = inkOf(unitPx, "s").advance;
    let gap = Math.max(4, Math.round(numPx * 0.14));

    // 超宽时（读数超过 999 秒，比槽位还宽）整体等比收缩，保证不越出面板、不压到状态点
    const avail = w - 72;
    const totalW = () => slotW + gap + unitW;
    if (totalW() > avail) {
        const k = avail / totalW();
        numPx = Math.max(16, Math.floor(numPx * k));
        unitPx = Math.max(9, Math.round(unitPx * k));
        slotInk = inkOf(numPx, SLOT_TEXT);
        slotW = slotInk.width;
        unitW = inkOf(unitPx, "s").advance;
        gap = Math.max(3, Math.round(numPx * 0.14));
    }

    /* 按字符类型分配固定槽宽（字距调整）。
     * 上一版拿 "000.0" 的平均 advance 当统一步长（约 62.8px），但 Capture It
     * 是比例手写体：宽数字约 71.9px 比步长还大，会溢出槽位压住左边字符
     *（截图里 "26" 挤在一起）；小数点只有约 26px，却占了整整一格，
     *  前后各空出一大块。
     *
     * 现在：数字槽 = 最宽数字的 advance + 最小字距；小数点槽 = 点自身
     * advance + 最小字距。两个值只由字体和字号决定，与当前读数无关，因此
     * 每个字符的位置依然完全固定 —— 之前修好的「不抖」不会退化；位数增加
     * 也只是向左多占一格。整体仍靠右、右锚点固定，槽位内 right 对齐，
     * 字宽差异只向左伸缩。垂直用固定槽位文本的 ascent/descent。
     */
    let digitAdv = 0;
    for (const c of "0123456789") {
        digitAdv = Math.max(digitAdv, inkOf(numPx, c).advance);
    }
    const dotAdv = inkOf(numPx, ".").advance;
    const innerGap = Math.max(2, Math.round(numPx * 0.035));
    const stepDigit = digitAdv + innerGap;
    const stepDot = dotAdv + innerGap;

    const right = w - 36;
    const numRight = right - unitW - gap;
    const baseline = h / 2 + (slotInk.ascent - slotInk.descent) / 2;

    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.font = font(numPx);
    ctx.fillStyle = textColor;
    let edge = numRight;
    for (let i = num.length - 1; i >= 0; i--) {
        const ch = num[i];
        ctx.fillText(ch, edge, baseline);
        edge -= (ch === "." ? stepDot : stepDigit);
    }
    ctx.font = font(unitPx);
    ctx.fillStyle = withAlpha(textColor, 0.65);
    ctx.textAlign = "right";
    ctx.fillText("s", right, baseline);

    ctx.restore();
}

/* ---------- 取色器 ---------- */

function ensureColorPicker(node) {
    if (node._colorPicker) return node._colorPicker;
    const input = document.createElement("input");
    input.type = "color";
    input.value = node.properties.textColor || "#c9d1cb";
    input.style.cssText =
        "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;";
    const apply = () => {
        node.properties.textColor = input.value;
        requestRepaint();
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
    document.body.appendChild(input);
    node._colorPicker = input;
    return input;
}

/* ---------- 节点注册 ---------- */

/**
 * 新版前端把 LGraphNode 上的部分属性（title_mode 等）做成了只有 getter 的
 * 访问器，直接赋值会在严格模式下抛 TypeError，导致节点创建失败。
 * 这里先尝试普通赋值，失败则用 defineProperty 在实例上定义同名属性。
 */
function defineCompat(obj, key, value) {
    try {
        obj[key] = value;
        return true;
    } catch {}
    try {
        Object.defineProperty(obj, key, { value, writable: true, configurable: true });
        return true;
    } catch {}
    return false;
}

/* 从 status 事件里取队列余量，只用于"补启动"。
 * 取不到必须返回 null 让调用方保持现状：把"读不到"当成"队列空"会误停表。
 * 兼容 {exec_info:{...}}（本机 api.js 实测）/ {status:{exec_info:{...}}}（旧结构）。 */
function queueRemaining(detail) {
    if (!detail || typeof detail !== "object") return null;
    const v = detail.exec_info?.queue_remaining
        ?? detail.status?.exec_info?.queue_remaining;
    return Number.isFinite(v) ? v : null;
}

/* ---------- Nodes 2.0（Vue 节点渲染）下的读数层 ----------
 *
 * 现象：开启 设置 → Vue Nodes 后，LiteGraph 的 drawNode 提前 return，
 * onDrawBackground 不再被调用，读数整片消失（2026-11-06 实测）。
 *
 * 为什么不在主画布上补画：试过包 drawFrontCanvas 补画，像素采样证明主画布上
 * 确实画出了读数（与正常模式的采样几乎逐像素一致），但屏幕上依然看不见 ——
 * Vue 模式把节点画在一张独立的 overlay canvas 上，那张画布压在主画布之上，
 * 我们画在下面就被整个盖住（把 overlay 隐藏掉才露出来）。
 *
 * 所以这里自己叠一张最上层的透明 canvas，只画计时器面板：
 *   - position:absolute; inset:0; pointer-events:none，不吃鼠标事件
 *   - 尺寸跟随主画布（含 devicePixelRatio），坐标用 app.canvas.ds 换算
 *   - 只在 Vue 模式下创建；正常模式仍走 onDrawBackground，不会重复绘制
 */
const VUE_LAYER_ID = "qg-timer-vue-layer";

let vueLayer = null;
let vueLayerRaf = 0;

/* 其他模块（qg_stream.js 的流式气泡）也画在节点前景层，Vue 模式下同样看不到。
 * 这里开一个极小的注册表：painter(ctx) 在「已套好平移缩放」的 ctx 上调用，
 * 自己负责遍历节点、translate 到节点原点。 */
const vuePainters = new Set();

window.__QG_VUE_LAYER__ = {
    add(painter) { vuePainters.add(painter); },
    remove(painter) { vuePainters.delete(painter); },
};

function vueNodesOn() {
    try {
        return !!LiteGraph?.vueNodesMode;
    } catch (err) {
        return false;
    }
}

function timerNodes() {
    return (app?.graph?._nodes || []).filter(
        (n) => n.type === NODE_CLASS && !n.flags?.collapsed);
}

function destroyVueLayer() {
    if (vueLayer?.canvas?.parentElement) vueLayer.canvas.remove();
    vueLayer = null;
}

function ensureVueLayer() {
    const main = app?.canvas?.canvas;
    const host = main?.parentElement;
    if (!host) return null;
    if (vueLayer && vueLayer.canvas.parentElement === host) return vueLayer;
    let canvas = document.getElementById(VUE_LAYER_ID);
    if (canvas && canvas.parentElement !== host) {
        canvas.remove();
        canvas = null;
    }
    if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.id = VUE_LAYER_ID;
        // z-index 只要盖过 overlay canvas 即可（它是 auto）；pointer-events 关掉，
        // 否则整块画布会吃掉节点的点击、拖拽和滚轮缩放。
        canvas.style.cssText =
            "position:absolute;inset:0;pointer-events:none;z-index:1;";
        host.appendChild(canvas);
    }
    vueLayer = { canvas, ctx: canvas.getContext("2d") };
    return vueLayer;
}

/** 每帧重画。不做「变了才重画」的省事优化：读数每 100ms 变一次、流式气泡
 *  每来一段文本就变一次，判断条件很容易漏，漏一次就是画面停在旧内容上。 */
function paintVueLayer() {
    const layer = ensureVueLayer();
    const main = app?.canvas?.canvas;
    if (!layer || !main) return;
    const dpr = window.devicePixelRatio || 1;
    const w = main.clientWidth || main.width;
    const h = main.clientHeight || main.height;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (layer.canvas.width !== pw || layer.canvas.height !== ph) {
        layer.canvas.width = pw;
        layer.canvas.height = ph;
        layer.canvas.style.width = w + "px";
        layer.canvas.style.height = h + "px";
    }
    const ctx = layer.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const ds = app.canvas.ds;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ds) {
        // 与 litegraph 的 ds.toCanvasContext 同序：先 scale 再 translate
        ctx.scale(ds.scale, ds.scale);
        ctx.translate(ds.offset[0], ds.offset[1]);
    }
    for (const painter of vuePainters) {
        try {
            painter(ctx);
        } catch (err) {
            console.warn("[QG-tools] Vue 读数层绘制失败:", err);
        }
    }
}

function paintTimers(ctx) {
    for (const node of timerNodes()) {
        ctx.save();
        ctx.translate(node.pos[0], node.pos[1]);
        drawBody(node, ctx);
        ctx.restore();
    }
}

function tickVueLayer() {
    vueLayerRaf = 0;
    if (!vueNodesOn()) {
        destroyVueLayer();
        return;
    }
    try {
        paintVueLayer();
    } catch (err) {
        console.warn("[QG-tools] Vue 读数层绘制失败:", err);
    }
    vueLayerRaf = requestAnimationFrame(tickVueLayer);
}

function scheduleVueLayer() {
    if (!vueLayerRaf) vueLayerRaf = requestAnimationFrame(tickVueLayer);
}

app.registerExtension({
    name: "QG.RunTimer",

    setup() {
        api.addEventListener("execution_start", () => startTimer());

        // 兜底 1：status 广播。execution_start / execution_success 在 execution.py
        // 里走 add_message(broadcast=False)，要求 client_id 非空；client_id 丢失
        // 或后端重启时只有 queue_updated() 的 status 是无条件广播。
        //
        // 注意：exec_info.queue_remaining 只统计"排队中"的 prompt，正在执行的
        // 那一个不计入。执行期间后端广播的 status 常常是 queue_remaining=0，
        // 拿它停表会把正在走的计时器停掉、下一次广播又重新从 0 开始 ——
        // CDP 实测到的 "0.17 → 0.02" 读数归零就是这么来的。
        // 因此 status 只负责"补启动"，停表交给执行事件和下面的 /queue 轮询。
        api.addEventListener("status", (e) => {
            const r = queueRemaining(e.detail);
            if (r !== null && r > 0 && !timer.running) startTimer(true);
        });

        // 兜底 2：WS 事件整段缺失时读 /queue。前端自带的 _pollQueue 只在连不上
        // WebSocket 时才启用，正常连接不轮询，所以这里自己补一个。
        // 用 /queue 而不是 /prompt：queue_running 明确包含"正在执行"的 prompt，
        // queue_pending 是排队中的，两者合起来才能准确区分"在跑"和"跑完了"。
        // 只在画布上真有计时器节点时发请求，1 次/秒，CPU 慢推理下开销可忽略。
        let polling = false;
        setInterval(async () => {
            if (polling || instances.size === 0) return;
            polling = true;
            try {
                const res = await api.fetchApi?.("/queue");
                if (res?.ok) {
                    const q = await res.json();
                    const n = (q?.queue_running?.length || 0) + (q?.queue_pending?.length || 0);
                    if (n > 0) {
                        if (!timer.running) startTimer(true);
                    } else if (timer.running) {
                        stopTimer("done");
                    }
                }
            } catch { /* 请求失败时保持现状，WS 事件照常生效 */ }
            finally { polling = false; }
        }, 1000);

        /* 不用 executing 停表。
         * 本机前端把 executing 的 detail 压成裸节点 id，旧版是对象，判断很容易
         * 出错（v2 就因此每个节点都停一次表）。更麻烦的是：页面加载 / WS 重连
         * 阶段后端会发杂散的 executing(node=null)，会把刚启动的计时器直接停掉，
         * 随后 /queue 轮询补启动又从 0 起算 —— CDP 抓到的读数倒退回 0.0
         * 正是这条链路。
         * 本机 0.43 后端有 execution_success，出错和中断还有专属事件；
         * 再老的后端则靠 /queue 轮询收尾（最多晚 1 秒）。与源插件的 RunTimer
         * 的做法一致：executing 只表示"当前跑哪个节点"，不表示"整轮结束"。
         */
        api.addEventListener("execution_success", () => {
            if (timer.running) stopTimer("done");
        });
        api.addEventListener("execution_error", () => stopTimer("error"));
        api.addEventListener("execution_interrupted", () => stopTimer("idle"));

        // Vue 节点渲染下 drawNode 不画节点，改在自己的最上层画布上补画
        vuePainters.add(paintTimers);
        scheduleVueLayer();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        defineCompat(nodeType, "title_mode", noTitleMode());

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            if (!this.properties) this.properties = {};
            this.color = "#17251b";
            defineCompat(this, "title_mode", noTitleMode());
            defineCompat(this, "python_module", MODULE_NAME);
            this.properties.theme = this.properties.theme || "暗夜";
            this.properties.textColor = this.properties.textColor || "#c9d1cb";
            this.properties.lastMs = this.properties.lastMs ?? 0;
            this.properties.lastStatus = this.properties.lastStatus || "idle";
            this.size = [DEFAULT_SIZE[0], DEFAULT_SIZE[1]];
            this.serialize_widgets = false;
            instances.add(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
        const result = onConfigure?.apply(this, arguments);
        if (!this.properties) this.properties = {};
        // 从已保存工作流加载的节点只走 onConfigure，不会走 onNodeCreated。
        // 不在这里登记的话，requestRepaint() 的节点级标脏和 remember() 的
        // 读数保存都会漏掉"打开工作流就有"的计时器（Set 自带去重，重复调用无害）。
        instances.add(this);
        defineCompat(this, "title_mode", noTitleMode());
            defineCompat(this, "python_module", MODULE_NAME);
            // 注意：这里不能去改全局 timer。旧版本会在加载工作流时把 timer 覆盖成
            // 当前节点的历史值，导致画布上多块面板串成同一个读数。
            // 静止时的读数由 stateOf(node) 从各节点自己的 properties 里取。
            //
            // 宽度补强只做一次：把更早版本保存的窄节点补到能放下 "000.0s"，
            // 补过之后打标记，用户之后再手动拉窄就不会被反复改回去。
            // 注意：新版 LiteGraph 的 node.size 是 Float32Array 类数组而不是 Array，
            // 不能用 Array.isArray 判断，否则这段兼容逻辑会永远进不去。
            if (!this.properties._widthFixed) {
                const size = this.size;
                if (size && typeof size[0] === "number" && size[0] < MIN_WIDTH) {
                    this.size = [MIN_WIDTH, size[1] || DEFAULT_SIZE[1]];
                }
                this.properties._widthFixed = true;
            }
            return result;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            instances.delete(this);
            if (this._colorPicker) {
                this._colorPicker.remove();
                this._colorPicker = null;
            }
            return onRemoved?.apply(this, arguments);
        };

        nodeType.prototype.onDrawBackground = function (ctx) {
            drawBody(this, ctx);
        };

        nodeType.prototype.getExtraMenuOptions = function (_canvas, options) {
            const node = this;
            if (!node.properties) node.properties = {};
            options = options || [];
            // 为了不显示右上角来源徽章，本节点被伪装成内置模块（见 timer_node.py），
            // 前端因此会给它加上 "Fix node (recreate)" 这一项——点了会重建节点、
            // 丢掉主题与字体颜色。这里只剔除这一项，其余菜单项原样保留。
            for (let i = options.length - 1; i >= 0; i--) {
                const text = typeof options[i]?.content === "string" ? options[i].content : "";
                if (/recreate/i.test(text) || /^fix node/i.test(text)) options.splice(i, 1);
            }
            const themeItems = Object.keys(THEMES).map((name) => ({
                content: (node.properties.theme === name ? "● " : "○ ") + name,
                callback: () => {
                    node.properties.theme = name;
                    requestRepaint();
                },
            }));
            options.push(
                { content: "重置计时", callback: () => resetTimer() },
                { content: "历史记录", submenu: { options: historyMenuItems(node) } },
                { content: "主题", submenu: { options: themeItems } },
                { content: "字体颜色", submenu: { options: colorMenuItems(node) } },
            );
            return options;
        };
    },
});

/* Nodes 2.0（Vue 节点渲染）下的画法
 *
 * 2026-11-06 实测：开启 Settings → Vue Nodes 后，节点被画在独立的 overlay
 * 画布上，LiteGraph 的 drawNode 提前返回，onDrawBackground 不再被调用 ——
 * 读数整片消失。往 drawFrontCanvas 补画也没用（会被 overlay 整个盖住）。
 *
 * 现在的做法：在 Vue 模式下自己叠一张 #qg-timer-vue-layer（见
 * ensureVueLayer），rAF 每帧按画布的 scale/offset 换算坐标重画；普通模式
 * 仍旧走 onDrawBackground。两层不会同时画，所以不会出现重影。
 */

/* 字体迟迟没加载完成时提示一次（失败原因已在上面的 catch 里打印，这里不重复） */
setTimeout(() => {
    if (fontStatus === "loading") {
        console.warn("[QG-tools] 字体 3 秒内未加载完成，读数暂用等宽字体兜底");
    }
}, 3000);

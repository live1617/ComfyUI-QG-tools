// QG LoRA堆（英文界面 LoRA Switch Stack）—— 每行一个开关的 LoRA 堆。
//
// 与 web/lora_loader/ 的区别就在「槽放哪儿」：那边整个栈是一块 DOM 面板，
// 输入槽只能待节点左边缘；这里每行是一个**原生 litegraph widget**，把
// `on_N` 这个 BOOLEAN 输入绑到该 widget 上，画布就会把圆点画在行自己身上。
// 位置、点击命中、悬停高亮、右键断线全由画布负责，没有 `input.pos` 欺骗，
// 也没有节点高度自增的正反馈。
//
// 数据只有一处：隐藏的 `rows_data` widget（JSON 数组，长度 = SLOT_COUNT，空行占位）。
// 行 widget 不参与序列化，改任何东西都写回 `rows_data`，后端按原始下标
// 把 on_N 叠到对应行。
// 🔴 SLOT_COUNT 是行数 + on_N 槽数的唯一真相源，必须与后端
// nodes/qg_lora_switch_stack.py 的 SLOT_COUNT、verify_i18n 的 dynamic names、
// _check_lora_switch_stack.py、5 个探针、nodeDefs 的 on_N 词条一起改。

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { installModeWatcher, onRenderModeSwitch, vueNodesEnabled } from "../shared/vue_mode.mjs?v=202611132008";
import { zhPair } from "../shared/zh.mjs?v=202611132008";
import { showToast } from "../shared/index.mjs?v=202611132008";
import { widthFor } from "../shared/node_width.mjs?v=202611132008";
import {
    civitaiFailureText,
    pictureErrorText,
} from "../shared/civitai_lookup.mjs?v=202611132008";
// 强度手感 / 触发词 / 选择器过滤 / 读 LoRA 信息只有一份真相源：加载器也在用
// 同一个 shared 模块，改一次两边同步。🔴 别在这里另写 ±10 / 0.05 或切词正则。
import {
    appendTrigger,
    clampStrength,
    DEFAULT_STEP,
    FINE_STEP,
    filterLoras,
    hasTrigger,
    joinTriggerWords,
    readLoraInfo,
    SCRUB_DEAD_ZONE,
    SCRUB_PIXELS_PER_STEP,
    splitTriggerWords,
    STRENGTH_MAX,
    STRENGTH_MIN,
    toggleTrigger,
    triggerGroups,
} from "../shared/lora_stack.mjs?v=202611132008";
// Civitai 查询编排与加载器共用；卡片 note / 缩略图版本由回调注入。
import { lookupCivitaiInfo } from "../shared/civitai_flow.mjs?v=202611132008";

const NODE_CLASS = "QG_LoraSwitchStack";
const SLOT_COUNT = 24;
const ROW_HEIGHT = 20;
// 宽度从尺寸表取，别写死：verify_node_sizes 会盯这一条，两处各写一个数迟早对不上。
const TABLE_WIDTH = widthFor(NODE_CLASS);
const MIN_WIDTH = TABLE_WIDTH ?? 380;
// 圆点由画布画在节点左边缘 x=0..14 上，行的底色从这儿往后画，别盖住它。
const SLOT_BAND = 16;
const SWITCH_W = 22;
const SWITCH_H = 10;
// 强度控件：「◀  0.80  ▶」。中间数值区要放得下 "3.00/2.20"（11px 等宽约 59px），
// 两侧各留一个箭头，所以这一带比纯数字时代宽一些。
const STRENGTH_BAND = 84;
const ARROW_W = 12;
const CLEAR_W = 16;
// 旧版三点按钮占的那一列已经作废（行菜单改成**在这一行上点右键**），
// 空出来的 14 单位还给名字列：强度框与 T 图标整体右移，名字能多显示两三个字。
// 🔴 clearX 仍只由 width 决定，× 的坐标一点没动，老探针按行尾坐标点删除照样有效。
const TRIGGER_END_GAP = 6;   // T 图标右边缘到 × 左边缘的距离
// 触发词图标：紧挨 × 的那一小块。窄到只占 15px，但点得着（判定区留了 18px）。
const TRIGGER_W = 15;

const FONT = '12px Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif';

const COLOR = {
    rowA: "#2b3136",
    rowB: "#31373c",
    rowHover: "#394148",
    rowOff: "#242a2e",
    rowOffHover: "#2c3338",
    rowLinked: "#28383f",
    rowLinkedHover: "#344950",
    text: "#dbe3e7",
    textEmpty: "#78848b",
    switchOn: "#3f9d63",
    switchOff: "#4a5259",
    knob: "#eaf2ef",
    linked: "#6fd0f0",
    accent: "#6fd0f0",
};

// ---------------------------------------------------------------- 状态

function stateOf(node) {
    if (!node.__qgSwitchStack) {
        node.__qgSwitchStack = {
            node,
            rows: null,
            rowWidgets: [],
            dataWidget: null,
            addWidget: null,
            // 🔴 11-11 定稿：新节点**零行**，只显示「+ 添加 LoRA」。早期留 1 行是因为
            // 空行是点开选择器的唯一入口；现在 onAddRow 点按钮就能弹列表、选中才加行，
            // 空行没有职责、还顶着绿色启用框看着像一条真 LoRA（用户截图圈出来的）。
            minRows: 0,
            hoverRow: -1,
            drag: null,
            repeat: null,
            // 每行最后一次算出来的开关状态（"linked|on|unknown"）。纯观测用：
            // 画在 canvas 上的东西探针读不到，靠它断言接线后有没有读到真值。
            switchStates: [],
        };
    }
    return node.__qgSwitchStack;
}

function finite(value, fallback) {
    // 🔴 Number(null) / Number("") 都是 0，不是 NaN —— 存档里一个坏掉的强度会被
    // 当成「用户就是要 0」，这一行的 LoRA 静默不生效。和 shared/lora_stack.mjs
    // 的 keptStrength、后端 clamp_strength 同一口径：坏值退回默认，好值夹进
    // shared 的上下界。🔴 不能整个换成 clampStrength：它对 NaN 返回 0，会把
    // 坏存档变成「静默不生效」，所以「坏值退回 fallback」这一段必须留在这里。
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return clampStrength(number);
}

// 与后端 truthy() 同口径：存档里 "false" / "0" / "off" 这类字符串不能被当成开。
// 只认字面量 false 的话，界面显示开、后端按关处理，两边悄悄不一致。
function rowTruthy(value) {
    if (typeof value === "string") {
        return !["", "false", "0", "no", "off", "none"].includes(value.trim().toLowerCase());
    }
    return Boolean(value);
}

function normalizeRow(entry) {
    const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const strength = finite(source.strength, 1);
    return {
        // 🔴 认不得的键原样带过：从别的插件转来的栈里带 group_off，后端按它
        // 决定这一行跑不跑。只留已知字段的话，用户在这里动一下强度就把组开关
        // 抹了，后端随后会把本该关掉的组重新跑起来。
        ...source,
        name,
        strength,
        strength_clip: finite(source.strength_clip, strength),
        // 缺省视为开（和后端 entry.get("enabled", True) 一致）。
        enabled: source.enabled === undefined || source.enabled === null
            ? true : rowTruthy(source.enabled),
        triggers: typeof source.triggers === "string" ? source.triggers : "",
    };
}

function readRows(node) {
    const widget = stateOf(node).dataWidget;
    const raw = widget ? widget.value : "[]";
    let items = [];
    try {
        items = JSON.parse(typeof raw === "string" ? raw : "[]");
    } catch (_) {
        items = [];
    }
    if (!Array.isArray(items)) items = [];
    const rows = [];
    for (let i = 0; i < SLOT_COUNT; i += 1) rows.push(normalizeRow(items[i]));
    return rows;
}

function writeRows(state, quiet = false) {
    const { node } = state;
    // 展开整行而不是挑五个字段：上面 normalizeRow 好不容易保住的 group_off
    // 等外来字段，写回时不能再丢一次。
    const payload = state.rows.map((row) => ({ ...row }));
    state.dataWidget.value = JSON.stringify(payload);
    // 连发时每一档只同步 widget 值，不重复记 graph.change / 触发 callback；
    // 松手时再补一次正式的写盘，撤销栈里就只留一条记录。
    if (!quiet) {
        state.dataWidget.callback?.(state.dataWidget.value);
        node.graph?.change?.();
    }
    node.setDirtyCanvas?.(true, true);
    // 🔴 Nodes 2.0 的行是 WidgetLegacy 的独立 canvas：改了 state.rows（名字/强度/
    // 开关/重复高亮）后必须主动 triggerDraw 才会重画，setDirtyCanvas 只刷主画布、
    // 碰不到这些独立 canvas。经典模式这里是无害空操作。
    redrawVueRows(state);
}

// 可见行数 = 最后一个有名字的行，加上「+ 添加 LoRA」选中后撑出来的行。
//
// 🔴 这里**不要**再 `last + 1`：那等于永远在末行下面多留一个空行占位，
// 用户选完一个 LoRA 就看到一行「空行」跟着（截图里被圈出来的就是它）。
// 想加新行点「+ 添加 LoRA」挑一个就行，占位没有存在的必要。
// 🔴 11-11 定稿：`last` 不再 `Math.max(1,...)` —— 新节点/删空后**零行**也合法，
// 只剩「+ 添加 LoRA」。（早期强制留 1 行是因为那时空行是唯一能弹选择器的地方；
// 现在 onAddRow 点按钮就能弹、且选中后才撑行，空行没有职责了。）
function filledRows(state) {
    let last = 0;
    state.rows.forEach((row, index) => {
        if (row.name) last = index + 1;
    });
    return last;
}

function visibleRows(state) {
    return Math.min(SLOT_COUNT, Math.max(filledRows(state), state.minRows));
}

// 🔴 Nodes 2.0（Vue）下必须主动 triggerDraw：WidgetLegacy 只在 mount / ResizeObserver /
// triggerDraw 时画那块独立 canvas，改 computeSize（隐藏↔显示）**不会**让它自动重画。
// 漏了这一步，新加的行 widget 的 canvas 会停在 0 高、什么也不显示 —— 用户报的
// 「Nodes 2.0 下添加 LoRA 不显示行」就是这个。经典模式没有 triggerDraw（或画在主
// 画布上），调用它是无害的空操作。
function redrawVueRows(state) {
    const targets = [...(state?.rowWidgets || []), state?.addWidget];
    const paint = () => {
        for (const widget of targets) {
            try { widget?.triggerDraw?.(); } catch (_) { /* 经典模式没这钩子 */ }
        }
    };
    paint();
    // 🔴 再挂一帧：行数刚变时 Vue 还没给新行的 <canvas> 布局（getBoundingClientRect
    // 为 0），WidgetLegacy.draw 会读到 0 宽、把 canvas 高度留在 0 —— 表现就是
    // 「加了 LoRA 不显示行」。等一帧 DOM 排好再画一次，新行才真正出现。
    // 用 rAF 而非 setTimeout：跟着浏览器绘制节拍，不引入额外定时器生命周期。
    if (state?.node?.size && targets.some((w) => w && rowDrawWidth(state.node, w) !== state.node.size[0])) {
        try { requestAnimationFrame(paint); } catch (_) { /* 非浏览器环境 */ }
    }
}

function applyRowCount(state) {
    const visible = visibleRows(state);
    state.rowWidgets.forEach((widget, index) => {
        const shown = index < visible;
        widget.computeSize = shown ? (width) => [width, ROW_HEIGHT] : () => [0, -4];
        // 🔴 Nodes 2.0（Vue）的 WidgetGrid 按 widget 列表分配网格行：computeSize=0
        // 只把独立 canvas 收成 0 高，**那一行仍然占位**。24 个空行会把节点撑到
        // 900px 以上，「+ 添加 LoRA」被挤出视口（真机实测 916px）。必须用
        // hidden / options.hidden 让 Vue 整行不渲染；经典模式不认这个标记，
        // 仍靠上面的 computeSize 收高 —— 两条路都保留才不回归。
        widget.hidden = !shown;
        if (widget.options) widget.options.hidden = !shown;
        // 槽跟着 widget 走：隐藏的行把输入也摘掉，否则 SLOT_COUNT 个圆点会叠在底部。
        const input = state.node.inputs?.find((item) => item.name === `on_${index + 1}`);
        if (input) input.hidden = !shown;
    });
    fitHeight(state);
    // 行数变了 → Vue 的独立 canvas 要重画（新行出现 / 删除后不留空壳）。
    redrawVueRows(state);
}

function fitHeight(state) {
    const { node } = state;
    const width = node.size[0];
    const visible = visibleRows(state);
    const rows = state.rowWidgets.slice(0, visible);
    const last = rows[rows.length - 1];
    // 行距从两行的实际间距取，别把 24 写死 —— 行高改了这里不会跟着错。
    const step = rows.length > 1 ? rows[1].y - rows[0].y : ROW_HEIGHT + 4;
    // 内容底边 = 最后一行 + 一个步长（「+ 添加 LoRA」的位置），下面再留输出区。
    const content = last ? last.y + step + 14 : 0;
    const natural = node.computeSize?.()[1] ?? 0;
    const height = Math.max(content, natural);
    if (Math.abs((node.size?.[1] ?? 0) - height) > 0.5) {
        node.setSize([width, height]);
    }
    node.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------- 绘制

function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, height / 2, width / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

// 按宽度截断，末尾补省略号。返回实际画的字符串。
function fitText(ctx, text, maxWidth) {
    if (maxWidth <= 0) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ellipsis = "…";
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) low = mid;
        else high = mid - 1;
    }
    return text.slice(0, low) + ellipsis;
}

// 强度控件两侧的三角箭头。dir=-1 是「减」、+1 是「加」；底框让它们看着像
// 能点的按钮，而不是两个装饰符号。
function drawStrengthArrow(ctx, centerX, centerY, dir, fg, bg) {
    const boxW = ARROW_W - 2;
    const boxH = ROW_HEIGHT - 6;
    ctx.fillStyle = bg;
    roundRect(ctx, centerX - boxW / 2, centerY - boxH / 2, boxW, boxH, 2.5);
    ctx.fill();
    const tip = 3.2;
    ctx.beginPath();
    ctx.moveTo(centerX + dir * tip, centerY);
    ctx.lineTo(centerX - dir * tip * 0.6, centerY - tip);
    ctx.lineTo(centerX - dir * tip * 0.6, centerY + tip);
    ctx.closePath();
    ctx.fillStyle = fg;
    ctx.fill();
}

// 宽字符串自动缩字号：单值 "0.80" 用 11px，双值 "3.00/2.20" 挤就降到 10/9px，
// 免得数值压到左右箭头上（这里绝不能像名字那样截省略号，数值看不全就没意义了）。
function fitNumberFont(ctx, text, maxWidth) {
    for (const size of [11, 10, 9]) {
        ctx.font = `${size}px "Consolas", "Menlo", monospace`;
        if (ctx.measureText(text).width <= maxWidth) return;
    }
}

// 这一行到底开没开。接了线的行由连线决定：能读到来源的布尔 widget 就读真值
// （QG_BoolToggle 的 `boolean`、原生 Primitive 的 `value`），读不到（比较节点、
// 运行时算出来的布尔）就标记成「外控」，别硬画成开启骗人。
function rowSwitchState(node, index, row) {
    const input = node.inputs?.find((item) => item.name === `on_${index + 1}`);
    const id = input?.link;
    if (id == null) return { linked: false, on: row.enabled !== false, unknown: false };
    const graph = node.graph;
    const link = graph?.links?.[id];
    const origin = link ? graph.getNodeById?.(link.origin_id) : null;
    const bools = origin?.widgets?.filter((widget) => typeof widget.value === "boolean") ?? [];
    // 零个或多个布尔控件都不敢猜：猜错了比「外控」这个诚实的状态更糟。
    if (bools.length !== 1) return { linked: true, on: true, unknown: true };
    return { linked: true, on: Boolean(bools[0].value), unknown: false };
}

// 重复 LoRA 提示：名字（去空白后精确匹配）出现超过一次的名字集合。
// 空行不算；同一个栈里挑了两遍同一个文件通常是误操作，给黄框提醒。
// 每次 drawRow 都算一遍（最多 24 行，开销可忽略），比在 writeRows 里维护一份
// 缓存少一个失效入口 —— 加载存档 / configure 也会改 rows，那里不一定走 writeRows。
const DUPLICATE_BORDER = "#e0b23c";
function duplicateNameSet(state) {
    const seen = new Map();
    for (const row of state.rows || []) {
        const name = (row?.name || "").trim();
        if (!name) continue;
        seen.set(name, (seen.get(name) || 0) + 1);
    }
    const dup = new Set();
    for (const [name, count] of seen) if (count > 1) dup.add(name);
    return dup;
}

function drawRow(ctx, node, state, index, posY, width) {
    // 隐藏的行 computeSize 变成 -4，但画布并不会因此跳过 draw —— 不拦一下，
    // 第 N 行会画在「+ 添加 LoRA」的位置上，两层叠着。
    if (index >= visibleRows(state)) return;
    // width 由调用方按「画到哪块 canvas」决定：widget.draw 和主画布补画都传
    // rowDrawWidth()（Nodes 2.0 的独立 canvas 比 node.size 窄）。🔴 补画不能
    // 回落 node.size[0]：从 Vue 切回经典后行 widget.width 仍是 356，普通行画
    // 352 右缘、外控行画 376，青框就比绿框宽 24 单位（用户截图实测 76px）。
    width = width || node.size[0];
    const row = state.rows[index];
    const sw = rowSwitchState(node, index, row);
    const { linked, on, unknown } = sw;
    const off = !on && !unknown;        // 明确关闭（外控但值未知不算关）
    const hovered = state.hoverRow === index;
    state.switchStates[index] = `${linked ? 1 : 0}${on ? 1 : 0}${unknown ? 1 : 0}`;

    ctx.save();

    // 行的底色按开关状态分：开=普通深灰、关=明显压暗、外控=带青调。
    // 关闭的行连同名字、强度、行尾图标一起压暗，不用逐个去看小开关也知道它不生效。
    // 🔴 底色用圆角矩形、和下面的状态描边框同形：框住整行时四角才不会露出直角的底。
    // 框右缘要到 width-4 才把行尾的 × 也框进来（clearX=width-8-CLEAR_W，× 占到
    // width-8）；左缘 SLOT_BAND=16 起，避开画布画在 x≈10 的 BOOLEAN 输入槽圆点。
    const boxLeft = SLOT_BAND;
    const boxRight = width - 4;
    const boxY = posY + 1;
    const boxH = ROW_HEIGHT - 2;
    const BOX_R = 4;
    ctx.fillStyle = off
        ? (hovered ? COLOR.rowOffHover : COLOR.rowOff)
        : (unknown
            ? (hovered ? COLOR.rowLinkedHover : COLOR.rowLinked)
            : (hovered ? COLOR.rowHover : (index % 2 ? COLOR.rowA : COLOR.rowB)));
    roundRect(ctx, boxLeft, boxY, boxRight - boxLeft, boxH, BOX_R);
    ctx.fill();

    // 整行状态框：一圈 1px 细描边把这一行框里头，替代原来那条顶线。
    // 三态语义不变（绿=开、灰=关、青=由连线控制）。线只 1px，贴着行底色的内缘走，
    // 不占额外高度、不动节点 SIZES。🔴 别把框画在行左缘：BOOLEAN 输入槽的圆点
    // 由画布画在 x≈10（连上线还带高亮），框从 x=16 起才不会被它盖掉一角。
    // 🔴 重复 LoRA（同名出现 >1 次）时边框改**黄色**提醒：开/关/外控三态仍由
    // 开关胶囊本体承载（下面照常画绿/灰/青），所以边框专用于「这行选重了」，
    // 既不丢状态、又一眼能看到重复。用户 11-11 要求。
    const duplicate = Boolean(row.name) && duplicateNameSet(state).has(row.name.trim());
    const stateColor = duplicate ? DUPLICATE_BORDER
        : (unknown ? "#6fd0f0" : (off ? "#85929b" : "#57c281"));
    ctx.strokeStyle = stateColor;
    // 0.5px 偏移让 1px 描边正好落在像素中心，边缘不发虚。重复行加粗到 1.5px
    // 让黄框在绿/灰行之间更跳；不重复仍是 1px。
    const borderW = duplicate ? 1.5 : 1;
    roundRect(ctx, boxLeft + 0.5, boxY + 0.5, boxRight - boxLeft - 1, boxH - 1, BOX_R - 0.5);
    ctx.lineWidth = borderW;
    ctx.stroke();
    // 供探针断言「整行细框 / 三态颜色 / 重复黄框」确实画了（canvas 像素读不到闭包状态）。
    state.statusFrame = {
        color: stateColor, left: boxLeft, right: boxRight,
        y: boxY, h: boxH, radius: BOX_R, lineWidth: borderW, duplicate,
    };
    // 单行一份，供探针按行核对（statusFrame 会被下一行覆盖，只能读到最后一行）。
    state.frameByRow = state.frameByRow || {};
    state.frameByRow[index] = { color: stateColor, duplicate, left: boxLeft, right: boxRight };

    // 未连接的 BOOLEAN 槽在画面的深色底上基本看不见，补一圈细环当视觉底；
    // 接上线之后画布自己会画实心点，环就让开（改画成青色细环，表示由线控制）。
    const slotX = state.node.inputs?.find((item) => item.name === `on_${index + 1}`)?.pos?.[0] ?? 10;
    ctx.beginPath();
    ctx.arc(slotX, posY + ROW_HEIGHT / 2, 4.2, 0, Math.PI * 2);
    ctx.strokeStyle = linked ? "rgba(111, 208, 240, .85)" : "rgba(178, 200, 212, .42)";
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // 开关：开=绿、关=灰；接了线但读不出布尔值时画青色胶囊 + 中间一个小方点，
    // 表示「由外部决定」，不再一律假装成开启。
    const sx = SLOT_BAND + 4;
    const sy = posY + (ROW_HEIGHT - SWITCH_H) / 2;
    ctx.fillStyle = unknown ? "rgba(111, 208, 240, .24)"
        : (on ? COLOR.switchOn : COLOR.switchOff);
    roundRect(ctx, sx, sy, SWITCH_W, SWITCH_H, SWITCH_H / 2);
    ctx.fill();
    if (unknown) {
        ctx.fillStyle = COLOR.linked;
        ctx.fillRect(sx + SWITCH_W / 2 - 2, sy + SWITCH_H / 2 - 2, 4, 4);
    } else {
        const knobX = on ? sx + SWITCH_W - SWITCH_H / 2 : sx + SWITCH_H / 2;
        ctx.beginPath();
        ctx.arc(knobX, sy + SWITCH_H / 2, SWITCH_H / 2 - 1.5, 0, Math.PI * 2);
        ctx.fillStyle = COLOR.knob;
        ctx.fill();
    }
    if (linked) {
        // 接了线的行加一圈青色虚环，说明这颗开关现在只读、由连线决定。
        const ringX = unknown ? sx + SWITCH_W / 2
            : (on ? sx + SWITCH_W - SWITCH_H / 2 : sx + SWITCH_H / 2);
        ctx.strokeStyle = COLOR.linked;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(ringX, sy + SWITCH_H / 2, SWITCH_H / 2 + 1.5, 0, Math.PI * 2);
        ctx.stroke();
    }

    // 名字。关闭的行连名字、强度、行尾图标一起压暗，并给名字压一道细横线。
    const cols = rowColumns(width);
    // 探针读不到闭包里的列坐标，挂到 state 上：断言用的是同一套 x，
    // 前端改了布局也不会出现「探针点歪了却全绿」。
    state.cols = cols;
    const nameX = sx + SWITCH_W + 7;
    const nameWidth = cols.nameRight - nameX;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = FONT;
    const label = row.name || zhPair("empty row", "空行");
    const shown = fitText(ctx, label, nameWidth);
    ctx.fillStyle = row.name ? (off ? COLOR.textEmpty : COLOR.text) : COLOR.textEmpty;
    ctx.fillText(shown, nameX, posY + ROW_HEIGHT / 2);
    if (off && row.name) {
        ctx.fillStyle = "rgba(190, 205, 214, .38)";
        ctx.fillRect(nameX, posY + ROW_HEIGHT / 2 - 0.5, ctx.measureText(shown).width, 1);
    }

    // 强度控件：左箭头 −、中间数值、右箭头 +。数值居中而不是右对齐，左右才对称。
    const sameClip = Math.abs(row.strength_clip - row.strength) < 0.005;
    const strengthText = sameClip
        ? row.strength.toFixed(2)
        : `${row.strength.toFixed(2)}/${row.strength_clip.toFixed(2)}`;
    const dragging = state.drag?.index === index;
    const centerY = posY + ROW_HEIGHT / 2 - 1;
    const dim = off || !row.name;
    const arrowFg = dim ? "rgba(160, 178, 190, .48)"
        : (hovered ? COLOR.accent : "rgba(198, 216, 226, .66)");
    const arrowBg = hovered && !dim ? "rgba(111, 208, 240, .12)" : "rgba(160, 178, 190, .07)";
    drawStrengthArrow(ctx, cols.arrowLeftMid, centerY, -1, arrowFg, arrowBg);
    drawStrengthArrow(ctx, cols.arrowRightMid, centerY, 1, arrowFg, arrowBg);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fitNumberFont(ctx, strengthText, cols.valueRight - cols.valueLeft - 2);
    ctx.fillStyle = dragging ? COLOR.accent
        : (dim ? COLOR.textEmpty : COLOR.text);
    ctx.fillText(strengthText, cols.valueMid, centerY);
    // 供探针断言「数值确实居中、双值没溢出、箭头分列两侧」。
    state.strengthLayout = {
        text: strengthText,
        font: ctx.font,
        textWidth: ctx.measureText(strengthText).width,
        centerX: cols.valueMid,
        arrowDecX: cols.arrowLeftMid,
        arrowIncX: cols.arrowRightMid,
        valueLeft: cols.valueLeft,
        valueRight: cols.valueRight,
    };

    // 强度条：0 在中间的一条细线，只铺在数值区下方（不占箭头的位置）。
    // 数字给「现在是多少」，条给「离两端还有多远」——拖的时候不用盯着数字算。
    if (row.name) {
        const barLeft = cols.valueLeft + 1;
        const barRight = cols.valueRight - 1;
        const barY = posY + ROW_HEIGHT - 5;
        const barMid = (barLeft + barRight) / 2;
        ctx.fillStyle = "rgba(160, 178, 190, .20)";
        ctx.fillRect(barLeft, barY, barRight - barLeft, 1.5);
        const value = clampStrength(row.strength);
        // 正负极各自除以自己的端点：哪天上下界不再对称，条也不会画歪。
        const span = value < 0 ? -STRENGTH_MIN : STRENGTH_MAX;
        const tip = barMid + (barRight - barMid) * (value / span);
        ctx.fillStyle = dragging ? COLOR.accent
            : (off ? "rgba(160, 178, 190, .34)" : "rgba(111, 208, 240, .62)");
        ctx.fillRect(Math.min(barMid, tip), barY, Math.max(Math.abs(tip - barMid), 1), 1.5);
        ctx.fillStyle = "rgba(226, 238, 246, .50)";
        ctx.fillRect(barMid - 0.5, barY - 1, 1, 3.5);
    }

    // 触发词图标：一个描边小方块里放个 T，跟 rgthree 那种行内图标按钮一个路子。
    // 没有触发词时是灰的（仍然可点，点了就加），有词时点亮成青色。
    const hasTriggers = Boolean(String(row.triggers || "").trim());
    const lit = hasTriggers && !off;
    const iconBox = { x: cols.triggerX + 1, y: posY + (ROW_HEIGHT - 12) / 2, w: 12, h: 12 };
    ctx.strokeStyle = lit ? COLOR.accent : "rgba(160, 178, 190, .38)";
    ctx.lineWidth = 1;
    roundRect(ctx, iconBox.x, iconBox.y, iconBox.w, iconBox.h, 2.5);
    ctx.stroke();
    if (lit) {
        ctx.fillStyle = "rgba(111, 208, 240, .16)";
        ctx.fill();
    }
    ctx.fillStyle = lit ? COLOR.accent : "rgba(160, 178, 190, .55)";
    ctx.font = 'bold 9px "Consolas", "Menlo", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("T", iconBox.x + iconBox.w / 2, iconBox.y + iconBox.h / 2 + 0.5);

    // 行尾不再画「三点」按钮：行操作改成**在这一行上点右键**。
    // T 与 × 之间这一列留白，纯粹是让 × 的位置和命中区保持原样。

    // 清空按钮：有内容才画，悬停时变亮。
    if (row.name) {
        ctx.textAlign = "center";
        ctx.font = FONT;
        ctx.fillStyle = hovered && !off ? COLOR.text : COLOR.textEmpty;
        ctx.fillText("×", cols.clearX + CLEAR_W / 2, posY + ROW_HEIGHT / 2);
    }

    ctx.restore();
}

function drawAddRow(ctx, node, state, posY, width) {
    // 与 drawRow 同理：Nodes 2.0 的独立 canvas 比 node.size 窄，按钮右缘要按
    // 实际 canvas 宽算，否则虚线框右侧被裁、看着像缺一角。
    width = width || node.size[0];
    const visible = visibleRows(state);
    const full = visible >= SLOT_COUNT;
    ctx.save();
    ctx.strokeStyle = full ? "rgba(255,255,255,.10)" : "rgba(255,255,255,.18)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    roundRect(ctx, SLOT_BAND + 4, posY + 3, width - SLOT_BAND - 14, ROW_HEIGHT - 6, 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = full ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.55)";
    ctx.fillText(
        full
            ? zhPair(`all ${SLOT_COUNT} rows shown`, `已显示全部 ${SLOT_COUNT} 行`)
            : zhPair("+ add LoRA", "+ 添加 LoRA"),
        width / 2,
        posY + ROW_HEIGHT / 2,
    );
    ctx.restore();
}

// ---------------------------------------------------------------- 交互

// 🔴 行/「+ 添加」实际绘制的宽度 —— Nodes 2.0（Vue）下必须取 widget.width。
//
// 经典模式：行画在主画布上，整节点宽 = node.size[0]（380），widget.width 没设。
// Nodes 2.0：WidgetLegacy 给**每个 widget 一个独立 <canvas>**，宽度是节点内容区
// （≈ node.size - 外壳边距 = 356）。若仍按 node.size[0]=380 画，最右 24px（行尾
// `×`、触发词图标）会落在 canvas 外被裁掉 —— 表现就是「行看不全、× 点不着、
// 添加的行删不掉」。命中判定 rowHitZones 必须跟绘制用同一个宽度，否则点不对位。
//
// 🔴 判据必须用官方渲染模式（vueNodesEnabled），**不能拿 widget.width 猜**：
// WidgetLegacy 在 Vue 下把 356 写进 widget.width，切回经典后这个属性**残留**；
// 前端自己画控件行时也读它（LGraphNode.ts:4304 `widget.width || nodeWidth`）。
// 旧判据「widget.width < node.size 就当 Vue」会把切回经典的节点误判成 Vue：
// 行框画成 352（比节点 380 窄 24px、右边空一条）、点击坐标基准也走错，行尾
// `×` 点不掉 —— 真机实测。改成问官方模式：经典一律整宽，Vue 才取控件宽。
function rowDrawWidth(node, widget) {
    if (!vueNodesEnabled()) return node.size[0];
    const w = Number(widget?.width);
    return w > 0 && w < node.size[0] ? w : node.size[0];
}

// 行内各列的 x 坐标。绘制和命中判定共用这一个函数 —— 分开各写一套的话，
// 改一处忘另一处，就会出现「画在这儿、点在那儿」。
function rowColumns(width) {
    const clearX = width - 8 - CLEAR_W;              // × 的起点
    const triggerX = clearX - TRIGGER_END_GAP - TRIGGER_W;  // 触发词图标的左边缘
    const strengthRight = triggerX - 6;              // 强度控件右边缘
    const strengthLeft = strengthRight - STRENGTH_BAND;
    // 两侧箭头各占 ARROW_W，中间是数值（可拖、可点开输入框）。
    const valueLeft = strengthLeft + ARROW_W;
    const valueRight = strengthRight - ARROW_W;
    return {
        clearX,
        triggerX,
        strengthLeft,
        strengthRight,
        valueLeft,
        valueRight,
        valueMid: (valueLeft + valueRight) / 2,
        arrowLeftMid: strengthLeft + ARROW_W / 2,
        arrowRightMid: strengthRight - ARROW_W / 2,
        nameRight: strengthLeft - 6,
    };
}

function rowHitZones(node, index, posY, drawWidth) {
    // 命中区必须和绘制宽度一致：Nodes 2.0 下按 node.size[0] 算会把 `×` 判定
    // 放在 canvas 外，点了没反应（用户报「添加的行删不掉」）。
    const width = drawWidth || node.size[0];
    const cols = rowColumns(width);
    return {
        switch: { x0: SLOT_BAND, x1: SLOT_BAND + 4 + SWITCH_W + 6 },
        name: { x0: SLOT_BAND + 4 + SWITCH_W + 6, x1: cols.nameRight },
        // 强度：左右两个箭头各一档，中间数值区仍可拖 / 可点开输入框。
        // 三者都从 rowColumns 算，跟绘制共用一套坐标。
        strength: { x0: cols.strengthLeft, x1: cols.triggerX - 4 },
        strengthDec: { x0: cols.strengthLeft, x1: cols.valueLeft },
        strengthInc: { x0: cols.valueRight, x1: cols.strengthRight + 2 },
        // T 图标到 × 之间（含原来的三点留白）都算触发词热区：那片没有别的
        // 功能，点开卡片比「点了没反应」顺手，也和加三点按钮之前的手感一致。
        trigger: { x0: cols.triggerX - 2, x1: cols.clearX - 2 },
        // 三点按钮已移除，× 左边这一带不再有独立按钮；行菜单统一由
        // 「在这一行上点右键」打开。
        clear: { x0: cols.clearX - 2, x1: width },
        y0: posY,
        y1: posY + ROW_HEIGHT,
    };
}

// 新版前端（1.53）的 widget 事件入口是 onPointerDown，不是 litegraph 老版的
// mouse：`processWidgetClick` 先看 widget.onPointerDown，命中就 return，根本
// 不会走到 widget.mouse。
//
// 🔴 Nodes 2.0（Vue）下坐标基准和经典模式不同，必须分开取，否则点哪儿都错位：
//   · 经典：事件发生在**主画布**上，graph_mouse 是画布坐标，减 node.pos 得节点内坐标
//           （0..node.size[0]）；命中区 rowHitZones 也按 node.size[0] 算。
//   · Vue：WidgetLegacy 给每行一个**独立 <canvas>**，augmentToCanvasPointerEvent
//           在 pointer.eDown 上补了 offsetX/offsetY —— 那是相对这块行 canvas 的
//           局部坐标（0..widget.width）；命中区 rowHitZones 按 rowDrawWidth() 算，
//           正好也是 widget.width。两者基准一致，直接比。
//           这时绝不能用 graph_mouse - node.pos：Vue 节点是 DOM、不随画布 ds 缩放，
//           那套画布坐标对不上独立 canvas 的像素。
// 判据复用 rowDrawWidth 的 widget.width：窄值 = Vue 独立 canvas。
function rowPointerLocal(pointer, canvas, node, widget) {
    if (rowDrawWidth(node, widget) !== node.size[0]) {
        const e = pointer?.eDown;
        if (e && Number.isFinite(e.offsetX) && Number.isFinite(e.offsetY)) {
            return [e.offsetX, e.offsetY];
        }
        // 兜底：DOM canvas 没给 offsetX 时，从 client 坐标减 rect（等价）
        const rect = e?.target?.getBoundingClientRect?.();
        if (rect && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
            return [e.clientX - rect.left, e.clientY - rect.top];
        }
    }
    const mouse = canvas?.graph_mouse ?? [0, 0];
    return [mouse[0] - node.pos[0], mouse[1] - node.pos[1]];
}

// 接上线的行，前端连**事件**也一起接管了：实测 `widget.onPointerDown` 一次都不触发，
// 点击直接冒到节点的 `onMouseDown`（局部坐标仍是对的）。所以这里按行 y 找出
// 「已被接线」的那一行，把点击原地转发给同一套 `onRowMouse`。
// 没接线的行不要抢：它们本来就走 `widget.onPointerDown`，重发会双击。
function linkedRowAt(node, state, y) {
    const visible = visibleRows(state);
    for (let index = 0; index < visible; index += 1) {
        const widget = state.rowWidgets[index];
        const input = node.inputs?.find((item) => item.name === `on_${index + 1}`);
        if (!widget || !input?.link) continue;
        if (y >= widget.y && y <= widget.y + ROW_HEIGHT) return index;
    }
    return -1;
}

// 删掉中间一行时，把后面所有 on_N 上的连线整体前移一格。行数据压缩之后，
// 原本控制第 N+1 行的开关现在得控制第 N 行，否则「删一行」会让所有连线
// 悄悄错位到别人身上 —— 界面上完全看不出来。
//
// 🔴 只改 `input.link` 不够：link 对象自己记着 `target_slot`（node.inputs 里的下标），
// 画布按它算落点，不改就会画在旧槽上、状态却在新槽里。
function shiftSlotLinks(node, fromRow) {
    const slots = [];
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        const at = node.inputs?.findIndex((item) => item.name === `on_${index + 1}`) ?? -1;
        if (at < 0) return;          // 槽还没建好（加载中 / 老存档），别动连线
        slots.push(at);
    }
    const graph = node.graph;
    const orphan = node.inputs[slots[fromRow]]?.link ?? null;
    // 🔴 先删被删行自己那条线，再挪别人的。顺序反了的话 removeLink 会按
    // target_slot 去清「此刻占着这个槽」的线，把刚挪过来的那条一起清掉。
    if (orphan != null && graph?.removeLink && graph.links?.[orphan]) {
        graph.removeLink(orphan);
    } else if (orphan != null) {
        node.inputs[slots[fromRow]].link = null;
    }
    for (let row = fromRow; row < SLOT_COUNT; row += 1) {
        const target = node.inputs[slots[row]];
        const source = row + 1 < SLOT_COUNT ? node.inputs[slots[row + 1]] : null;
        const id = source?.link ?? null;
        target.link = id;
        if (id != null && graph?.links?.[id]) graph.links[id].target_slot = slots[row];
    }
}

// × = 删除这一行，不是「把名字抹掉留个空行」。后面的行整体前移，末尾补一个空项
// （rows_data 仍然固定 SLOT_COUNT 项，on_N 的槽位契约不变，只是空占位挪到了最后）。
function removeRow(state, index, commit = true) {
    const { rows } = state;
    shiftSlotLinks(state.node, index);
    for (let i = index; i < SLOT_COUNT - 1; i += 1) rows[i] = rows[i + 1];
    rows[SLOT_COUNT - 1] = normalizeRow(null);
    // 少了一行，手动点出来的空行也一起收掉，别在末尾留个空位。
    state.minRows = filledRows(state);
    // 批量删除时先只搬数据和连线，最后统一重算行数、只写一次盘。
    // 逐行写会在撤销栈里塞进 24 条记录，用户按一次撤销退不回删之前。
    if (commit) {
        applyRowCount(state);
        writeRows(state);
    }
}

// 批量删行：倒序调用 removeRow。shiftSlotLinks 每次只把「被删行之后」的外控
// 连线前移一位，所以必须从后往前删，前面的删除才不会把后面待删行的索引挤歪。
// 🔴 不能图快直接把 state.rows 过滤一遍铺回去：那样 on_N 槽上的连线还留在旧
// 下标，开关会悄悄控制到别的行上，界面上看不出来。
function compactRows(state, predicate) {
    const doomed = [];
    state.rows.forEach((row, index) => { if (predicate(row, index)) doomed.push(index); });
    if (!doomed.length) return 0;
    for (let k = doomed.length - 1; k >= 0; k -= 1) removeRow(state, doomed[k], false);
    state.minRows = filledRows(state);
    applyRowCount(state);
    writeRows(state);
    return doomed.length;
}

// ---------------------------------------------------------------- 行操作（插入 / 移动 / 复制）
//
// 这一组是「某一行」的动作，跟上面的整栈批量删除分开。难点全在 on_N 连线：
// 行数据挪了，槽上的线必须跟着挪，否则开关会悄悄控制到别的 LoRA 上，
// 界面上一点都看不出来。shiftSlotLinks 只管「删行 → 后面前移」，这里补齐
// 「插入 → 后面后移」和「交换两行 → 交换两条线」。

function slotIndices(node) {
    const slots = [];
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        const at = node.inputs?.findIndex((item) => item.name === `on_${index + 1}`) ?? -1;
        if (at < 0) return null;   // 槽还没建好（加载中），别动连线
        slots.push(at);
    }
    return slots;
}

// 在 atRow 插入一行：atRow 及其后的连线整体后移一位。
// 🔴 先断掉第 24 行自己的线：它要被挤出栈，不断就会留一条指向空槽的孤线；
// 顺序反了的话 removeLink 会按 target_slot 把刚搬过来的线一起清掉。
function shiftSlotLinksBack(node, atRow) {
    const slots = slotIndices(node);
    if (!slots) return;
    const graph = node.graph;
    const last = node.inputs[slots[SLOT_COUNT - 1]];
    const orphan = last?.link ?? null;
    if (orphan != null) {
        if (graph?.removeLink && graph.links?.[orphan]) graph.removeLink(orphan);
        else if (last) last.link = null;
    }
    for (let row = SLOT_COUNT - 2; row >= atRow; row -= 1) {
        const target = node.inputs[slots[row + 1]];
        const source = node.inputs[slots[row]];
        const id = source?.link ?? null;
        target.link = id;
        if (id != null && graph?.links?.[id]) graph.links[id].target_slot = slots[row + 1];
    }
    node.inputs[slots[atRow]].link = null;
}

// 在 index 处插入一行。source 给了就是「复制此行」，否则插一个空行。
function insertRow(state, index, source = null) {
    if (index < 0 || index >= SLOT_COUNT) return false;
    if (visibleRows(state) >= SLOT_COUNT) {
        showToast({ severity: "warn", detail: zhPair(`All ${SLOT_COUNT} rows are in use`, `已用满 ${SLOT_COUNT} 行`) });
        return false;
    }
    shiftSlotLinksBack(state.node, index);
    // 用 normalizeRow 复制而不是直接搬引用：否则两行会指向同一个对象，
    // 之后改其中一行的强度会连带改掉另一行。
    for (let i = SLOT_COUNT - 1; i > index; i -= 1) {
        state.rows[i] = normalizeRow(state.rows[i - 1]);
    }
    state.rows[index] = source ? normalizeRow({ ...source }) : normalizeRow(null);
    // 在末尾插空行时 filledRows 不会自己变大，抬 minRows 保证新行看得见。
    state.minRows = Math.min(SLOT_COUNT, Math.max(state.minRows, index + 1));
    applyRowCount(state);
    writeRows(state);
    return true;
}

// 交换两行：行内容和两条外控连线一起换，target_slot 也要同步。
function swapRows(state, a, b) {
    if (a < 0 || b < 0 || a >= SLOT_COUNT || b >= SLOT_COUNT || a === b) return false;
    const node = state.node;
    const graph = node.graph;
    const slots = slotIndices(node);
    if (slots && graph) {
        const sa = slots[a];
        const sb = slots[b];
        // 🔴 1.58.5 起 `input.link` 是弃用访问器：赋非 null 值**直接被忽略**
        // （前端源码原话：mutate via node["connect"]() / node.disconnectInput()）。
        // 删行时靠改 link.target_slot 还能生效，但「两条线互换」会静默失败，
        // 所以这里走官方接口：读来源 → 断开两个槽 → 按交换后的槽重新连接。
        const readLink = (slot) => {
            const link = node.getInputLink?.(slot) ?? graph.links?.[node.inputs[slot]?.link] ?? null;
            return link ? { origin_id: link.origin_id, origin_slot: link.origin_slot } : null;
        };
        const infoA = readLink(sa);
        const infoB = readLink(sb);
        if (infoA) node.disconnectInput?.(sa);
        if (infoB) node.disconnectInput?.(sb);
        const reconnect = (info, slot) => {
            if (!info) return;
            const src = graph.getNodeById?.(info.origin_id)
                ?? graph._nodes?.find?.((n) => String(n.id) === String(info.origin_id));
            src?.connect?.(info.origin_slot, node, slot);
        };
        reconnect(infoA, sb);
        reconnect(infoB, sa);
    }
    const tmp = state.rows[a];
    state.rows[a] = state.rows[b];
    state.rows[b] = tmp;
    applyRowCount(state);
    writeRows(state);
    return true;
}

function moveRow(state, index, direction) {
    const target = index + direction;
    if (target < 0 || target >= visibleRows(state)) return false;
    return swapRows(state, index, target);
}

function duplicateRow(state, index) {
    const src = state.rows[index];
    if (!src) return false;
    return insertRow(state, index + 1, src);
}

// 箭头按住不放时的连发要能干净地停掉：pointerup 可能落在画布外，
// 所以监听挂在 window 的捕获阶段（画布会 setPointerCapture 吃掉冒泡）。
function stopStepRepeat(state) {
    const repeat = state?.repeat;
    if (!repeat) return;
    if (repeat.timer) clearTimeout(repeat.timer);
    window.removeEventListener("pointerup", repeat.finish, true);
    window.removeEventListener("pointercancel", repeat.finish, true);
    window.removeEventListener("blur", repeat.finish, true);
    state.repeat = null;
}

// 点一下箭头走一档，按住 320ms 后连发。
// 🔴 箭头**不能**用 Ctrl 做微调：1.53 前端的 `LiteGraph.leftMouseClickBehavior`
// 是 "panning"，`_processPrimaryButton` 见到 ctrl/meta 就直接转「多选拖框」并 return，
// Alt 又被「拖拽克隆节点」吃掉 —— 节点内 widget 根本收不到这次 pointerdown。
// 实测只有 Shift 能穿过去。FINE_STEP 的微调请走「拖起来之后再按 Ctrl」（window 级
// pointermove 读得到 ctrlKey）或直接点数值键入。
function stepStrength(state, index, direction, event) {
    stopStepRepeat(state);
    const row = state.rows[index];
    if (!row) return;
    // widget 路径来的是 litegraph Pointer（修饰键在 eDown），节点级 onMouseDown
    // 来的是 DOM MouseEvent，两处都认。Shift = 改 CLIP 强度。
    const down = event?.eDown ?? event;
    const step = DEFAULT_STEP;
    const key = down?.shiftKey ? "strength_clip" : "strength";
    const apply = (commit) => {
        row[key] = clampStrength(Number((row[key] + direction * step).toFixed(2)));
        writeRows(state, !commit);
    };
    // 起始这一档也走 quiet：松手时 finish 会统一正式写一次，
    // 否则每次点箭头都写两遍盘、撤销栈里留两条记录。
    apply(false);

    const holder = { finish: null, timer: null };
    const tick = () => {
        apply(false);
        holder.timer = setTimeout(tick, 75);
    };
    const finish = () => {
        const active = state.repeat === holder;
        stopStepRepeat(state);
        if (active) writeRows(state);
    };
    holder.finish = finish;
    state.repeat = holder;
    holder.timer = setTimeout(tick, 320);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish, true);
}

function onRowMouse(state, event, pos, index) {
    // 行里还开着就地输入框就先收掉（把键入的值写回）。否则「输入框没按回车、
    // 直接去点箭头」会让 blur 提交和箭头步进抢同一行数据，刚加的一档被旧值盖掉。
    closeStrengthInput(state);
    const row = state.rows[index];
    if (!row || index >= visibleRows(state)) return false;
    const widget = state.rowWidgets[index];
    const zone = rowHitZones(state.node, index, widget.y, rowDrawWidth(state.node, widget));
    const x = pos[0];

    const linked = Boolean(state.node.inputs?.find((item) => item.name === `on_${index + 1}`)?.link);
    if (x < zone.switch.x1) {
        if (!linked) {
            row.enabled = !row.enabled;
            writeRows(state);
        }
        return true;
    }
    if (x < zone.name.x1) {
        openPicker(state, index);
        return true;
    }
    if (x >= zone.clear.x0) {
        // 空行没画 ×，点那儿不该悄悄把它后面的行挪上来。
        if (row.name) removeRow(state, index);
        return true;
    }
    if (x >= zone.trigger.x0 && x < zone.trigger.x1) {
        openTriggerEditor(state, index);
        return true;
    }
    if (x >= zone.strength.x0) {
        // 两边箭头是按钮：点一下 ±1 档，按住连发。别让它们进 beginDrag，
        // 否则松手时会顺手弹出数值输入框。
        if (x < zone.strengthDec.x1) {
            stepStrength(state, index, -1, event);
            return true;
        }
        if (x >= zone.strengthInc.x0) {
            stepStrength(state, index, 1, event);
            return true;
        }
        // 中间数值：Shift 拖 CLIP 强度。修饰键可能来自 Pointer.eDown，也可能来自
        // 节点级的 onMouseDown（那里直接给的是 DOM MouseEvent），两处都认。
        beginDrag(state, event, index, Boolean(event?.eDown?.shiftKey ?? event?.shiftKey));
        return true;
    }
    return true;
}

// 强度拖动用「上一次位置」累加增量，不去换算 canvas.graph_mouse 与 clientX：
// 两者坐标系不同，混着用会跳值。窗口级监听保证鼠标移出节点也能继续拖。
//
// 🔴 `onPointerDown` 的第一个参数**不是 DOM 事件**，是 litegraph 自己的 Pointer
// 对象（`{element, pointerId, eDown, eMove, eUp, ...}`），上面没有 clientX。
// 起始位置只能从 `pointer.eDown` 取 —— 取不到的话第一段位移会被当成「起点」吞掉，
// 表现就是拖了半天数值不动、或者起步明显迟钝。
//
// 🔴 两个坑，都有实测记录：
// 1. 缩放要从 `app.canvas.ds` 读。`node.graph.canvas` 在新版前端是 undefined，
//    `|| 1` 会悄悄兜成 1 —— 画布缩到 2 倍以上时拖一格会走两三档。
// 2. 监听必须挂**捕获阶段**。画布自己会 `setPointerCapture` 并吃掉 pointerup，
//    冒泡阶段收不到，上一轮的监听就留着了：下一次拖动等于挂两个 handler，
//    每像素走双份。
function endDrag(state) {
    const drag = state?.drag;
    if (!drag) return;
    window.removeEventListener("pointermove", drag.move, true);
    window.removeEventListener("pointerup", drag.up, true);
    // 触摸被系统取消、或者拖到一半窗口失焦时，pointerup 根本不会来。
    // 少这两个监听就会留下上一轮的 handler，下一次拖动每像素走双份。
    window.removeEventListener("pointercancel", drag.up, true);
    window.removeEventListener("blur", drag.up, true);
    state.drag = null;
}

function beginDrag(state, pointer, index, useClip) {
    endDrag(state);
    const row = state.rows[index];
    const downEvent = pointer?.eDown ?? pointer?.eMove ?? pointer;
    let lastX = Number(downEvent?.clientX ?? downEvent?.screenX);
    if (!Number.isFinite(lastX)) lastX = null;
    let value = useClip ? row.strength_clip : row.strength;
    let moved = false;
    // 步长按**画布坐标**算，不能按屏幕像素：缩放 2 倍时，屏幕上走
    // SCRUB_PIXELS_PER_STEP 个像素相当于两倍的画布像素，数值会翻倍地走；
    // 缩小时反过来拖不动。
    const scale = app.canvas?.ds?.scale || 1;
    const quantum = SCRUB_PIXELS_PER_STEP * scale;
    let accum = 0;
    // 没拖动就当成「想直接输一个数」：抖到 SCRUB_DEAD_ZONE 以内仍算点击。
    let travel = 0;
    const move = (moveEvent) => {
        const clientX = Number(moveEvent.clientX);
        if (!Number.isFinite(clientX)) return;
        if (lastX === null) {
            lastX = clientX;
            return;
        }
        // 余量累积，别丢零头：一格 9.38px 时逐像素推也能凑满一格。
        const delta = clientX - lastX;
        accum += delta;
        travel += Math.abs(delta);
        lastX = clientX;
        // Ctrl 是微调（FINE_STEP）。Shift 已经被「改 CLIP 强度」占了，不能再当微调键。
        const step = moveEvent.ctrlKey ? FINE_STEP : DEFAULT_STEP;
        const steps = Math.trunc(accum / quantum);
        if (!steps) return;
        accum -= steps * quantum;
        const next = clampStrength(Number((value + steps * step).toFixed(2)));
        if (next === value) return;
        value = next;
        moved = true;
        if (useClip) row.strength_clip = value;
        else row.strength = value;
        state.node.setDirtyCanvas?.(true, true);
    };
    const up = (event) => {
        endDrag(state);
        state.node.setDirtyCanvas?.(true, true);
        // 只点了一下没拖动就别标脏：否则撤销栈里全是空记录。
        if (moved) {
            writeRows(state);
            return;
        }
        // 取消 / 失焦只收尾，别在这种时候弹出输入框。
        const cancelled = event?.type === "pointercancel" || event?.type === "blur";
        // 一次没动的点击 = 打开数值输入框，直接键入 0.85 这种。
        if (!cancelled && travel < SCRUB_DEAD_ZONE) openStrengthInput(state, index, useClip);
    };
    state.drag = { index, move, up };
    state.node.setDirtyCanvas?.(true, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up, true);
}

// 点一下强度数字弹一个就地输入框：拖是「凭手感」，输是「要精确到 FINE_STEP」。
// 定位按画布缩放换算成屏幕坐标 —— 输入框是 fixed 的 DOM，跟画布各算各的。
function openStrengthInput(state, index, useClip) {
    closeStrengthInput(state);
    const node = state.node;
    const widget = state.rowWidgets[index];
    const row = state.rows[index];
    if (!node || !widget || !row) return;
    // 列宽必须和绘制同基准：Vue 下独立 canvas 比 node.size 窄 24px，
    // 按 node.size 算会让输入框 / 触发词卡片整体右偏。
    const cols = rowColumns(rowDrawWidth(node, widget));
    const ds = app.canvas?.ds ?? { scale: 1, offset: [0, 0] };
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const frame = app.canvas.canvas.getBoundingClientRect();
    const left = frame.left + (node.pos[0] + cols.valueLeft + offset[0]) * scale;
    const top = frame.top + (node.pos[1] + widget.y + offset[1]) * scale;
    const height = ROW_HEIGHT * scale;
    const valueWidth = (cols.valueRight - cols.valueLeft) * scale;

    const input = document.createElement("input");
    input.type = "text";
    // 探针靠这个标记认出「就地改强度」那个输入框。
    input.dataset.qgStrength = useClip ? "clip" : "model";
    input.value = (useClip ? row.strength_clip : row.strength).toFixed(2);
    input.style.cssText = `
        position: fixed; left: ${Math.round(left)}px; top: ${Math.round(top)}px;
        width: ${Math.round(valueWidth)}px; height: ${Math.round(height)}px;
        box-sizing: border-box; padding: 0 3px; text-align: center;
        border: 1px solid ${COLOR.accent}; border-radius: 4px; background: #14212a;
        color: #eaf6ff; font: ${Math.max(10, Math.round(11 * scale))}px "Consolas", "Menlo", monospace;
        outline: none; z-index: 10020;`;

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        state.strengthInput = null;
        input.remove();
        node.setDirtyCanvas?.(true, true);
    };
    const commit = () => {
        // Esc / 已经收起来之后再冒出来的 blur 一律不写值。
        if (closed) return;
        const raw = input.value.trim();
        // 空 = 回到默认 1，跟加载器那个「擦掉就取默认」的手感一致。
        const parsed = raw === "" ? 1 : Number(raw);
        if (Number.isFinite(parsed)) {
            const value = clampStrength(Number(parsed.toFixed(2)));
            if (useClip) row.strength_clip = value;
            else row.strength = value;
            writeRows(state);
        }
        close();
    };
    input.addEventListener("keydown", (event) => {
        // 画布上退格 / Delete 有快捷键，输入框里必须截住。
        event.stopPropagation();
        if (event.key === "Enter") commit();
        else if (event.key === "Escape") close();
    });
    input.addEventListener("blur", commit);
    document.body.append(input);
    state.strengthInput = { input, close, commit };
    input.focus({ preventScroll: true });
    input.select();
}

function closeStrengthInput(state) {
    const editor = state?.strengthInput;
    if (!editor) return;
    // 先提交再移除：点别处 = 接受当前输入（跟 blur 一个语义）。Esc 走的是
    // editor.close()，不受这里影响。
    editor.commit?.();
    editor.close?.();
    if (state) state.strengthInput = null;
}


// ---------------------------------------------------------------- 整栈预设 / 批量操作
//
// 11-12 第一层扩展。四个功能共用这一个面板入口（节点右键 →「栈工具」）：
//   ① 整栈预设：把当前 24 行栈的快照存到用户目录，命名、跨工作流复用。
//   ② 全局强度倍率：把整栈每行的模型/CLIP 强度乘一个系数，写回 rows_data。
// ③ 套用推荐强度 / ④ 底模徽标在触发词卡片里（见 renderMeta）。
// 🔴 都不动节点接口（INPUT_TYPES 一行没改）：倍率是「前端算好写回每行」，
//    后端照旧只解析每行强度，缓存指纹、存档格式、节点登记全不受影响。

let stackPanel = null;

function closeStackPanel() {
    if (!stackPanel) return;
    stackPanel.abort.abort();
    stackPanel.element.remove();
    stackPanel = null;
}

// 把每一行（含未命名行的强度）乘一个系数，钳进 shared 的上下界后写回。
// 未命名的行也一起缩放：用户可能先调好强度再回头选文件。空行 strength 是
// 默认值 1，乘倍率后会变成倍率值 —— 这没坏处（选了文件就是那个强度），
// 但为了不让「空行偷偷带个 0.5」造成困惑，只缩放有名字的行。
function scaleAllStrengths(state, factor) {
    let touched = 0;
    for (const row of state.rows) {
        if (!row.name) continue;
        row.strength = clampStrength(row.strength * factor);
        row.strength_clip = clampStrength(row.strength_clip * factor);
        touched += 1;
    }
    if (touched) writeRows(state);
    return touched;
}

// 把后端返回的预设行铺回节点：前 N 行写内容，其余清空成占位，然后重算行数。
function applyPresetRows(state, rows) {
    const clean = Array.isArray(rows) ? rows : [];
    const slots = new Array(state.rows.length).fill(null);
    // 新预设带 position（原始槽位）→ 铺回原位，on_N 连线才不会错位。
    // 老预设没有这个字段，保持旧行为：按顺序铺前 N 行。
    if (clean.some((row) => Number.isInteger(row?.position))) {
        clean.forEach((row, order) => {
            if (!row?.name) return;
            const at = Number.isInteger(row.position)
                && row.position >= 0 && row.position < slots.length
                ? row.position : order;
            if (!slots[at]) slots[at] = row;
        });
    } else {
        clean.forEach((row, order) => {
            if (row?.name && order < slots.length) slots[order] = row;
        });
    }
    for (let i = 0; i < state.rows.length; i += 1) {
        const src = slots[i] ? { ...slots[i] } : {};
        // position 只属于预设文件，别让它跟着 rows_data 写进存档。
        delete src.position;
        state.rows[i] = normalizeRow(src);
    }
    state.minRows = 0;
    applyRowCount(state);
    writeRows(state);
}

// ---------------------------------------------------------------- 删除（独立右键菜单）
//
// 11-12 追加：用户要一个和「栈工具」并列的独立右键，把删除集中放进去，
// 不必先打开面板、也不必去点行尾那个很小的 ×（手机上尤其难点中）。
// 行删除复用 removeRow → shiftSlotLinks 的连线迁移；预设删除复用第一层
// 已经加好的后端路由，不新增接口。

let presetDeleteMenu = null;

function closePresetDeleteMenu() {
    if (!presetDeleteMenu) return;
    presetDeleteMenu.abort.abort();
    presetDeleteMenu.element.remove();
    presetDeleteMenu = null;
}

// 删掉所有没选文件的空行：手动点「+ 添加」又没选文件留下的占位，
// 以及载入预设后夹在中间的空行，都会被收紧到有名字的行后面。
function deleteEmptyRows(state) {
    return compactRows(state, (row) => !row.name);
}

// 只保留同名 LoRA 第一次出现的那一行 —— 也就是把画黄框的重复行清掉。
function deleteDuplicateRows(state) {
    const seen = new Set();
    return compactRows(state, (row) => {
        const name = (row.name || "").trim();
        if (!name) return false;
        if (seen.has(name)) return true;
        seen.add(name);
        return false;
    });
}

// 整个栈回到「新节点」的样子：24 行全空、外控连线全部断开。
// 走 compactRows 而不是新建数组，是为了让 shiftSlotLinks 逐条把连线清干净。
function clearWholeStack(state) {
    return compactRows(state, () => true);
}

// 生成二级菜单的选项。state 用函数取，别在菜单构建时抓死：节点可能刚加载、
// 状态还没挂上，用户展开右键到真正点某一项之间还有时间差。
function deleteMenuOptions(node) {
    const getState = () => node.__qgSwitchStack;
    const rowAction = (label, action, emptyText) => ({
        content: label,
        callback: () => {
            const state = getState();
            if (!state) return;
            const count = action(state);
            if (count > 0) {
                showToast({ severity: "success", detail: zhPair(`Removed ${count} rows`, `已删除 ${count} 行`) });
            } else {
                showToast({ severity: "info", detail: emptyText });
            }
            state.node.setDirtyCanvas?.(true, true);
        },
    });
    return [
        rowAction(zhPair("Remove empty rows", "删除空行"), deleteEmptyRows,
            zhPair("No empty rows to remove", "没有空行可删")),
        rowAction(zhPair("Remove duplicate rows (keep first)", "删除重复行（保留第一条）"), deleteDuplicateRows,
            zhPair("No duplicate rows", "没有重复行")),
        rowAction(zhPair("Clear the whole stack", "清空整栈"), clearWholeStack,
            zhPair("The stack is already empty", "栈本来就是空的")),
        null,   // 菜单分隔线，别把「删行」和「删预设」混在一起
        {
            content: zhPair("Delete a saved preset...", "删除已存预设…"),
            callback: () => {
                const state = getState();
                if (state) openPresetDeleteMenu(state);
            },
        },
    ];
}

// 预设删除单独用一块轻量浮层：预设列表要从后端实时读，原生子菜单在展开时
// 就必须给出同步数组，做不到。浮层里每条预设一个按钮，点两次才真删 ——
// 删掉不可恢复，手机上误触的代价太高。
async function openPresetDeleteMenu(state) {
    closePresetDeleteMenu();
    closeStackPanel();
    const abort = new AbortController();
    const element = document.createElement("div");
    element.dataset.qgPresetDelete = "1";
    element.style.cssText = `
        position: fixed; width: 300px; max-width: calc(100vw - 16px);
        z-index: 10001; padding: 12px 14px; border-radius: 10px;
        background: #21272c; color: #dfe6ea; border: 1px solid #3a4248;
        box-shadow: 0 12px 32px rgba(0,0,0,.5); font: 13px/1.5 sans-serif;`;

    const header = document.createElement("div");
    header.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:8px;";
    const title = document.createElement("span");
    title.textContent = zhPair("Delete a saved preset", "删除已存预设");
    title.style.cssText = "flex:1; font-weight:600; color:#eef3f6;";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.dataset.qgPresetDeleteClose = "1";
    close.style.cssText = `font:inherit; cursor:pointer; padding:2px 9px; min-height:30px;
        border-radius:6px; border:1px solid #3a4248; background:#2b3238; color:#cdd6db;`;
    close.addEventListener("click", () => closePresetDeleteMenu(), { signal: abort.signal });
    header.append(title, close);

    const listHost = document.createElement("div");
    listHost.dataset.qgPresetDeleteList = "1";
    listHost.style.cssText = "display:flex; flex-direction:column; gap:2px; max-height:260px; overflow-y:auto;";
    element.append(header, listHost);
    document.body.append(element);
    presetDeleteMenu = { element, abort };

    // 摆在节点正下方的空白画布上，内容落定后按真实高度夹进视口。
    const frame = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const nodeLeft = frame.left + (state.node.pos[0] + offset[0]) * scale;
    const nodeBottom = frame.top + (state.node.pos[1] + offset[1] + state.node.size[1]) * scale;
    const fit = () => {
        if (!element.isConnected) return;
        const rect = element.getBoundingClientRect();
        const left = Math.max(8, Math.min(Math.round(nodeLeft), window.innerWidth - rect.width - 8));
        let top = Math.round(nodeBottom + 14);
        if (top + rect.height > window.innerHeight - 8) {
            top = Math.max(8, Math.round(window.innerHeight - 8 - rect.height));
        }
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    };
    presetDeleteMenu.fit = fit;
    fit();

    const outside = (event) => { if (!element.contains(event.target)) closePresetDeleteMenu(); };
    window.addEventListener("pointerdown", outside, { signal: abort.signal, capture: true });

    const render = async () => {
        listHost.replaceChildren();
        let presets = {};
        try {
            const res = await api.fetchApi("/qg/lora/presets");
            const data = await res.json();
            if (data.ok && data.presets) presets = data.presets;
        } catch (_) { /* 读不到就当空列表，删除时还会再报一次 */ }
        if (abort.signal.aborted) return;
        const names = Object.keys(presets).sort();
        if (!names.length) {
            const empty = document.createElement("div");
            empty.textContent = zhPair("No saved presets yet", "还没有存过预设");
            empty.style.cssText = "color:#78848b; padding:8px 0;";
            listHost.append(empty);
            fit();
            return;
        }
        for (const name of names) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex; align-items:center; gap:8px; padding:5px 0;";
            const label = document.createElement("span");
            label.textContent = name;
            label.style.cssText = "flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
            const del = document.createElement("button");
            del.type = "button";
            del.dataset.qgPresetDeleteName = name;
            del.textContent = zhPair("Delete", "删除");
            del.style.cssText = `font:inherit; cursor:pointer; padding:4px 12px; min-height:34px;
                border-radius:6px; border:1px solid #6a3d3d; background:#3a2626; color:#e6a4a4;`;
            let armed = false;
            del.addEventListener("click", async () => {
                if (!armed) {
                    armed = true;
                    del.textContent = zhPair("Tap again to confirm", "再点一次确认");
                    del.dataset.qgDeleteArmed = "1";
                    return;
                }
                try {
                    const res = await api.fetchApi("/qg/lora/presets/delete", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name }),
                    });
                    const data = await res.json();
                    if (!data.ok) throw new Error(data.error || "delete failed");
                    showToast({ severity: "success", detail: zhPair(`Deleted "${name}"`, `已删除「${name}」`) });
                    await render();
                } catch (e) {
                    showToast({ severity: "error", detail: String(e?.message || e) });
                }
            }, { signal: abort.signal });
            row.append(label, del);
            listHost.append(row);
        }
        fit();
    };
    await render();
}

// ---------------------------------------------------------------- 行操作菜单（行上右键）
//
// 用户要的是**右键菜单**：在 LoRA 堆的某一行上点右键，就在鼠标位置弹出这一行
// 的操作菜单，样式和 ComfyUI 原生右键菜单完全一致（LiteGraph.ContextMenu），
// 不再画行尾「三点」按钮。七项：插空行 / 上移 / 下移 / 复制 / 移除 / 删全部。
//
// 🔴 为什么挂 window 捕获：1.58.5 的 `node.onMouseDown` 只在左键路径
// （`_processPrimaryButton`）里调用；右键走 `processMouseDown` 的
// `pointer.onClick ??= () => this.processContextMenu(node, e)`，节点钩子里
// 根本收不到。所以要在 window 捕获阶段先认领：命中行就 stopPropagation，
// 画布不会再设置 pointer.onClick，原生长菜单也就不会和行菜单叠在一起。
// 不命中则原样放行 —— 节点标题 / 空白区右键仍是 ComfyUI 原来的菜单。
//
// 🔴 Vue（Nodes 2.0）下每行是独立 <canvas>，右键事件直接落在它上面；
// 经典模式所有行画在主画布上，得按 ds.scale / ds.offset 反算图坐标。
let rowMenu = null;
let rowContextHookInstalled = false;
let lastRowMenuRect = null;
let lastRowMenuOpenAt = 0;

function closeRowMenu() {
    const open = rowMenu;
    rowMenu = null;
    if (!open) return;
    try { open.menu.close(); } catch (_) { /* 前端已经关掉了 */ }
    open.element.remove();
}

// 右键落在哪一行：返回 { state, index } 或 null。空行也算一行。
function rowAtPointer(event) {
    const graph = app.graph;
    if (!graph?._nodes?.length) return null;
    const cx = Number(event?.clientX);
    const cy = Number(event?.clientY);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    // 浮层上（菜单 / 面板 / 选择器）的右键归浮层自己处理，别按屏幕坐标
    // 误判成下面那一行，否则会把 ComfyUI 原生菜单的「右键关闭」也吃掉。
    if (event.target?.closest?.(
        ".litecontextmenu, .litemenu, .qg-switchstack-tools, [data-qg-stack-panel], " +
        ".qg-switchstack-picker, .qg-switchstack-triggers, " +
        ".qgtools-lora-popup, .qgtools-lora-picker, .qgtools-lora-card"
    )) return null;

    // Nodes 2.0：WidgetLegacy 给每行一个独立 canvas，外层带 data-widget-name="row_N"。
    const host = event.target?.closest?.('[data-widget-name^="row_"]');
    if (host) {
        const match = /^row_(\d+)$/.exec(host.getAttribute("data-widget-name") || "");
        const shell = host.closest?.("[data-node-id]");
        const rawId = shell?.getAttribute?.("data-node-id");
        const node = graph.getNodeById?.(Number(rawId))
            || graph._nodes.find((item) => String(item.id) === String(rawId));
        // 折叠后行 canvas 不该还在，保险起见别让隐藏行收到右键。
        if (node?.flags?.collapsed) return null;
        const state = node?.__qgSwitchStack;
        const index = match ? Number(match[1]) - 1 : -1;
        if (state && index >= 0 && index < visibleRows(state)) return { state, index };
    }

    // 经典模式：主画布坐标反算（公式与 LGraphCanvas.adjustMouseEvent 一致）。
    const canvasEl = app.canvas?.canvas;
    const rect = canvasEl?.getBoundingClientRect?.();
    const ds = app.canvas?.ds;
    if (!rect || !ds) return null;
    const scale = ds.scale || 1;
    const gx = (cx - rect.left) / scale - (ds.offset?.[0] ?? 0);
    const gy = (cy - rect.top) / scale - (ds.offset?.[1] ?? 0);
    // 倒序遍历：graph._nodes 是添加顺序，后加的节点画在上面。两个 LoRA 堆
    // 叠在一起时，右键必须落在眼睛看到的那个上，不能认到被盖住的那个。
    for (let n = graph._nodes.length - 1; n >= 0; n -= 1) {
        const node = graph._nodes[n];
        const state = node.__qgSwitchStack;
        if (!state?.rowWidgets?.length || node.flags?.collapsed) continue;
        const lx = gx - node.pos[0];
        const ly = gy - node.pos[1];
        if (lx < 0 || lx > rowDrawWidth(node, state.rowWidgets[0])) continue;
        const visible = visibleRows(state);
        for (let index = 0; index < visible; index += 1) {
            const widget = state.rowWidgets[index];
            if (widget && ly >= widget.y && ly <= widget.y + ROW_HEIGHT) {
                return { state, index };
            }
        }
    }
    return null;
}

function installRowContextMenu() {
    if (rowContextHookInstalled) return;
    rowContextHookInstalled = true;
    window.addEventListener("pointerdown", (event) => {
        if (event.button !== 2) return;
        const hit = rowAtPointer(event);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        openRowMenu(hit.state, hit.index, event);
    }, { capture: true });
    // 🔴 触屏长按 / 部分浏览器只派发 contextmenu，**没有** button=2 的
    // pointerdown；只在上面那个钩子里开菜单的话，手机上会「长按没反应」。
    // 所以这里也要能开：桌面右键的 contextmenu 紧跟在 pointerdown 后面，
    // 用短时间窗去重，避免同一次右键开两次菜单。
    window.addEventListener("contextmenu", (event) => {
        const hit = rowAtPointer(event);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() - lastRowMenuOpenAt < 400) return;
        // 长按前那一下 button=0 的 pointerdown 可能已经打开了 LoRA 选择器 /
        // 触发词编辑器，先收掉，别让两个浮层叠在行菜单上面。
        closePicker?.();
        closeTriggerEditor?.();
        closeStrengthInput?.(hit.state);
        openRowMenu(hit.state, hit.index, event);
    }, { capture: true });
    // Esc 关闭只挂一次。以前每次开菜单都挂一个 window keydown，菜单被前端
    // 自己（点外面）关掉时不会走 closeRowMenu，监听就一直留着。
    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && rowMenu) closeRowMenu();
    }, { capture: true });
}

// 菜单项用原生 ContextMenu 的项格式：disabled 会被置灰且不绑点击；危险项用
// 白名单允许的 <span style="color:…"> 标红（ContextMenu 的 DOMPurify 只放行
// span/b/i/em/strong 与少量样式属性，写 class 会被洗掉）。
function rowMenuValues(state, index, confirm = false) {
    const visible = visibleRows(state);
    const full = visible >= SLOT_COUNT;
    const make = (content, run, { disabled = false, danger = false } = {}) => ({
        content: danger ? `<span style="color:#e88b8b">${content}</span>` : content,
        disabled,
        __danger: danger,
        callback: () => { closeRowMenu(); run?.(); },
    });
    if (confirm) {
        return [
            { content: zhPair("Delete every LoRA in this stack?", "确定清空整栈的所有 LoRA？"), disabled: true },
            null,
            make(zhPair("Cancel", "取消"), () => {}),
            make(zhPair("Delete all", "确定删除"), () => {
                clearWholeStack(state);
                showToast({ severity: "success", detail: zhPair("Stack cleared", "已清空整栈") });
            }, { danger: true }),
        ];
    }
    return [
        make(zhPair("Insert empty row above", "在上方插入空行"),
            () => insertRow(state, index), { disabled: full }),
        make(zhPair("Insert empty row below", "在下方插入空行"),
            () => insertRow(state, index + 1), { disabled: full }),
        make(zhPair("Move up", "上移"),
            () => moveRow(state, index, -1), { disabled: index === 0 }),
        make(zhPair("Move down", "下移"),
            () => moveRow(state, index, 1), { disabled: index >= visible - 1 }),
        make(zhPair("Duplicate this row", "复制此行"),
            () => duplicateRow(state, index), { disabled: full }),
        make(zhPair("Remove this LoRA", "移除此 LoRA"),
            () => removeRow(state, index)),
        null,
        // 纯文字，不带图标也不带省略号：用户 11-13 要求「前面的图标不要、
        // 后面三个点不要，只留删除所有 LoRA」。危险感由整行标红承担。
        make(zhPair("Delete all LoRA", "删除所有 LoRA"),
            () => openRowMenu(state, index, null, true), { danger: true }),
    ];
}

// 原生菜单的底色走 CSS 变量 `--background` / `--foreground`：Playwright 的浅色
// 系统偏好下会被解析成白底黑字，和 ComfyUI 深色界面完全不搭。这里只给自己
// 这个行菜单补一段兜底样式，不改原生菜单的结构、悬停和点击行为。
// 🔴 另有一个坑：前端 `core-CsX6xQKw.js` 的 `addFilter()` 见到
// `className === "dark"` 且条目 > 4 就往菜单里塞一个「Filter list」输入框，
// 还会用内联样式高亮当前项 —— 用户参考图里没有它。所以 className 换成一个
// 自定义值（CSS 里 `.litegraph.litecontextmenu` 本来就不依赖 `.dark`），
// 既保住深色，又不触发自动过滤框。
function ensureRowMenuStyle() {
    if (document.getElementById("qg-row-menu-theme")) return;
    const style = document.createElement("style");
    style.id = "qg-row-menu-theme";
    style.textContent = `
[data-qg-row-menu].litecontextmenu {
    background-color:#262c32 !important; color:#dfe6ea !important;
    border:1px solid #3d464d; border-radius:8px;
    box-shadow:0 12px 34px rgba(0,0,0,.55);
    min-width:200px !important; min-height:0 !important;
    /* 原生菜单固定 200px 宽 + overflow-y:scroll（会让 overflow-x 变成 auto），
       条目一长就冒出底部横向滚动条。改成按内容自适应并锁住横向，
       高度用 auto：内容装得下时不再常驻一条空滚动槽。 */
    width:max-content !important;
    max-width:min(340px, calc(100vw - 24px)) !important;
    overflow-x:hidden !important;
    overflow-y:auto !important;
    font:14px/1.4 Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
}
[data-qg-row-menu] .litemenu-entry.submenu {
    background-color:#262c32 !important; color:#dfe6ea !important;
    padding:8px 14px !important; font-size:14px; min-height:38px;
    box-sizing:border-box;
}
[data-qg-row-menu] .litemenu-entry.submenu:hover:not(.disabled) {
    background-color:#343c43 !important; color:#fff !important;
}
[data-qg-row-menu] .litemenu-entry.submenu.disabled { color:#68747c !important; }
[data-qg-row-menu] .litemenu-entry.separator {
    height:1px !important; min-height:0 !important; padding:0 !important;
    /* 原生给的是 width:100%，再加上这里的左右 margin，正好比容器宽 8px ——
       横向滚动条就是这么来的。改成 auto，block 元素自己会扣掉 margin。 */
    width:auto !important;
    margin:5px 4px !important; background:#3d464d !important; border:0 !important;
}
[data-qg-row-menu] .litemenu-title { background:#1f252a !important; color:#9fb0bb !important; }
[data-qg-row-menu] input { background:#1e2429 !important; color:#dfe6ea !important; border:1px solid #3d464d !important; }
[data-qg-row-menu] .qg-row-danger span { color:#e88b8b !important; }
`;
    document.head.append(style);
}

function openRowMenu(state, index, event, confirm = false) {
    ensureRowMenuStyle();
    // 换个前端版本没有 LiteGraph.ContextMenu 时，别把右键整个弄成报错。
    if (typeof LiteGraph === "undefined" || typeof LiteGraph.ContextMenu !== "function") {
        console.warn("[QG] LiteGraph.ContextMenu 不可用，行菜单无法打开");
        return null;
    }
    // 原生菜单被前端自己（点外面）关掉时不会通知我们，rowMenu 还指着已经
    // 脱离文档的旧节点。不清掉的话，确认菜单会从它读到全 0 的矩形。
    if (rowMenu && !rowMenu.element?.isConnected) rowMenu = null;
    // 「删全部」的确认菜单要接在刚才那个菜单的位置上：原生菜单不带 event 时
    // 会掉到屏幕 (0,0)。关旧菜单之前先把矩形记下来。
    const anchor = confirm ? (lastRowMenuRect || rowMenu?.element?.getBoundingClientRect?.()) : null;
    closeRowMenu();
    closeStrengthInput(state);
    closeStackPanel();
    closePresetDeleteMenu();
    // 选择器 / 触发词卡片可能正压在这一行上；右键开行菜单前先收掉，
    // 否则两个浮层会叠在一起（pointerdown 路径以前漏了这一步）。
    closePicker();
    closeTriggerEditor();
    try { LiteGraph.closeAllContextMenus?.(window); } catch (_) { /* 老版本前端没有 */ }

    const values = rowMenuValues(state, index, confirm);
    const nativeEvent = event?.eDown || event;
    const options = { className: "qg-row-dark", scale: Math.max(1, app.canvas?.ds?.scale || 1) };
    if (anchor) {
        options.left = anchor.left;
        options.top = anchor.top;
    } else {
        options.event = nativeEvent;
    }
    const menu = new LiteGraph.ContextMenu(values, options);
    const element = menu.root;
    element.dataset.qgRowMenu = "1";
    element.dataset.qgRowIndex = String(index);
    element.dataset.qgRowConfirm = confirm ? "1" : "0";
    // 探针按 data-qg-row-action 读文案和禁用态；原生菜单项是 div，补一个
    // JS disabled 属性就能沿用原来的断言，不必另写一套选择器。
    const entries = element.querySelectorAll(".litemenu-entry");
    entries.forEach((entry, i) => {
        const value = values[i];
        if (!value || typeof value !== "object") return;
        entry.dataset.qgRowAction = String(value.content).replace(/<[^>]*>/g, "");
        entry.disabled = Boolean(value.disabled);
        if (value.__danger) entry.classList.add("qg-row-danger");
    });
    rowMenu = { menu, element };
    lastRowMenuRect = element.getBoundingClientRect();
    lastRowMenuOpenAt = performance.now();
    return element;
}

async function openStackPanel(state) {
    closeStackPanel();
    closeRowMenu();
    closeTriggerEditor();
    closePicker();
    const abort = new AbortController();
    const element = document.createElement("div");
    element.className = "qg-switchstack-tools";
    element.dataset.qgStackPanel = "1";
    // 🔴 面板优先放在节点**正下方的空白画布**，完全不遮挡节点。
    // 真机截图试过：左上角会盖住三行，右侧宽度不够翻到左侧又盖住文件名。
    // 下方通常是空的（节点下面没别的东西），放不下时才退到右侧/左侧。
    const frame = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const n = state.node;
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const nodeLeft = frame.left + (n.pos[0] + offset[0]) * scale;
    const nodeTop = frame.top + (n.pos[1] + offset[1]) * scale;
    const nodeRight = nodeLeft + n.size[0] * scale;
    // +30 是标题栏，size[1] 只算节点主体。
    const nodeBottom = nodeTop + (n.size[1] + 30) * scale;
    const PANEL_W = 336;
    // 初值：节点正下方。真实高度要 append 之后才量得到（预设条数会变），
    // 所以先用「节点左缘 + 下方」定位，内容填完再夹进视口 —— 别用 400px
    // 的保守估计，那会把本该放下方的面板误判成放不下、又翻回节点左侧。
    const initialLeft = Math.max(8, Math.min(Math.round(nodeLeft), window.innerWidth - PANEL_W - 8));
    const initialTop = Math.max(8, Math.round(nodeBottom + 14));
    element.style.cssText = `
        position: fixed; left: ${initialLeft}px; top: ${initialTop}px; width: ${PANEL_W}px;
        max-height: min(560px, calc(100vh - 24px)); overflow-y: auto;
        padding: 10px; box-sizing: border-box; z-index: 10001;
        display: flex; flex-direction: column; gap: 9px;
        background: #23282c; border: 1px solid #3a4248; border-radius: 9px;
        box-shadow: 0 12px 32px rgba(0,0,0,.55);
        font: 12px Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;`;
    document.body.append(element);

    const title = document.createElement("div");
    title.textContent = zhPair("LoRA stack tools", "LoRA 堆工具");
    title.style.cssText = "color: #dbe3e7; font-size: 13px;";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.dataset.qgStackClose = "1";
    close.style.cssText = `margin-left:auto; background:transparent; border:none; color:#9aa6ad; cursor:pointer; font-size:18px; line-height:1;`;
    close.addEventListener("click", () => closeStackPanel(), { signal: abort.signal });
    const head = document.createElement("div");
    head.style.cssText = "display:flex; align-items:center;";
    head.append(title, close);

    const sectionLabel = (text) => {
        const d = document.createElement("div");
        d.textContent = text;
        d.style.cssText = "color:#78848b; margin-bottom:-3px;";
        return d;
    };

    // ---- ② 全局强度倍率 ----
    const scaleBox = document.createElement("div");
    scaleBox.style.cssText = "display:flex; gap:6px; align-items:center; flex-wrap:wrap;";
    const scaleInput = document.createElement("input");
    scaleInput.type = "number";
    // step 复用 shared 的真相源，别在这里另写 0.05（守卫会盯）。
    scaleInput.step = String(DEFAULT_STEP);
    scaleInput.value = "1";
    scaleInput.dataset.qgScaleInput = "1";
    scaleInput.style.cssText = `width:84px; padding:4px 7px; border-radius:6px; font:inherit;
        border:1px solid #3a4248; background:#1a1e21; color:#dbe3e7; outline:none;`;
    const scaleApply = document.createElement("button");
    scaleApply.type = "button";
    scaleApply.textContent = zhPair("Apply to all rows", "应用到整栈");
    scaleApply.dataset.qgScaleApply = "1";
    scaleApply.style.cssText = `font:inherit; cursor:pointer; padding:4px 10px; border-radius:6px;
        border:1px solid #3a4248; background:#2b3238; color:#dbe3e7;`;
    const scaleHint = document.createElement("div");
    scaleHint.textContent = zhPair("Multiply every named row's model + CLIP strength. 0.8 = 20% lighter.",
        "把每一行有名字的 LoRA 的模型与 CLIP 强度都乘这个数。0.8 = 整体调轻两成。");
    scaleHint.style.cssText = "color:#78848b; line-height:1.4;";
    scaleApply.addEventListener("click", () => {
        const factor = Number(scaleInput.value);
        if (!Number.isFinite(factor) || factor <= 0) {
            showToast({ severity: "warn", detail: zhPair("Enter a positive number", "请输入大于 0 的倍数") });
            return;
        }
        const touched = scaleAllStrengths(state, factor);
        showToast({ severity: "success", detail: zhPair(`Scaled ${touched} rows`, `已缩放 ${touched} 行`) });
    }, { signal: abort.signal });
    scaleBox.append(scaleInput, scaleApply);

    // ---- ① 整栈预设：保存 ----
    const saveBox = document.createElement("div");
    saveBox.style.cssText = "display:flex; gap:6px; align-items:center;";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.dataset.qgPresetName = "1";
    nameInput.placeholder = zhPair("Preset name", "预设名字，如「写实人像」");
    nameInput.style.cssText = `flex:1; min-width:0; padding:4px 7px; border-radius:6px; font:inherit;
        border:1px solid #3a4248; background:#1a1e21; color:#dbe3e7; outline:none;`;
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = zhPair("Save stack", "存为预设");
    saveButton.dataset.qgPresetSave = "1";
    saveButton.style.cssText = `font:inherit; cursor:pointer; padding:4px 10px; border-radius:6px;
        border:1px solid #3a4248; background:#2b3238; color:#dbe3e7;`;
    saveBox.append(nameInput, saveButton);

    // ---- 预设列表 ----
    const listHost = document.createElement("div");
    listHost.dataset.qgPresetList = "1";
    listHost.style.cssText = "display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto;";

    const renderList = async () => {
        listHost.replaceChildren();
        let presets = {};
        try {
            const res = await api.fetchApi("/qg/lora/presets");
            const data = await res.json();
            if (data.ok && data.presets) presets = data.presets;
        } catch (_) { /* 读不到就显示空列表，保存/删除时还会报错 */ }
        if (!abort.signal.aborted && nameInput) { /* 保留输入，不清空 */ }
        const names = Object.keys(presets).sort();
        if (!names.length) {
            const empty = document.createElement("div");
            empty.textContent = zhPair("No saved presets yet", "还没有存过预设");
            empty.style.cssText = "color:#78848b; padding:4px 0;";
            listHost.append(empty);
            return;
        }
        for (const name of names) {
            const entry = presets[name] || {};
            const row = document.createElement("div");
            row.style.cssText = "display:flex; align-items:center; gap:6px; padding:3px 0;";
            const label = document.createElement("span");
            label.textContent = `${name}  (${(entry.rows || []).length})`;
            label.style.cssText = "flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#cdd6db;";
            const load = document.createElement("button");
            load.type = "button";
            load.textContent = zhPair("Load", "载入");
            load.dataset.qgPresetLoad = name;
            load.style.cssText = `font:inherit; cursor:pointer; padding:2px 8px; border-radius:6px;
                border:1px solid #3a4248; background:#2b3238; color:#9fe1cb;`;
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "×";
            del.dataset.qgPresetDelete = name;
            del.title = zhPair("Delete preset", "删除预设");
            del.style.cssText = `font:inherit; cursor:pointer; padding:2px 8px; border-radius:6px;
                border:1px solid #3a4248; background:#2b3238; color:#c98080;`;
            load.addEventListener("click", async () => {
                try {
                    const res = await api.fetchApi("/qg/lora/presets/load?name=" + encodeURIComponent(name));
                    const data = await res.json();
                    if (!data.ok) throw new Error(data.error || "load failed");
                    // 面板关掉 / 工作流重新加载之后别再往旧 state 上铺行。
                    if (abort.signal.aborted || !element.isConnected) return;
                    applyPresetRows(state, data.rows);
                    showToast({ severity: "success", detail: zhPair(`Loaded "${name}"`, `已载入「${name}」`) });
                    closeStackPanel();
                } catch (e) {
                    showToast({ severity: "error", detail: String(e?.message || e) });
                }
            }, { signal: abort.signal });
            del.addEventListener("click", async () => {
                try {
                    await api.fetchApi("/qg/lora/presets/delete", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name }),
                    });
                    if (abort.signal.aborted || !element.isConnected) return;
                    await renderList();
                } catch (e) {
                    showToast({ severity: "error", detail: String(e?.message || e) });
                }
            }, { signal: abort.signal });
            row.append(label, load, del);
            listHost.append(row);
        }
        // 预设条数变了 → 面板高度变了 → 重新夹进视口（此时面板已 append）。
        stackPanel?.fit?.();
    };

    saveButton.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) {
            showToast({ severity: "warn", detail: zhPair("Give the preset a name first", "先给预设起个名字") });
            return;
        }
        // 保留从上游转来的字段（group_off 等，后端按它决定这一行跑不跑），
        // 只挑五个已知字段会静默抹掉组开关；position 记录原始槽位，
        // 载入时铺回原位，on_N 外控连线才不会指到别的行。
        const rows = state.rows
            .map((r, index) => (r.name ? { ...r, position: index } : null))
            .filter(Boolean);
        if (!rows.length) {
            showToast({ severity: "warn", detail: zhPair("The stack is empty", "栈是空的，没有可存的行") });
            return;
        }
        try {
            const res = await api.fetchApi("/qg/lora/presets", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, rows }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || "save failed");
            if (abort.signal.aborted || !element.isConnected) return;
            nameInput.value = "";
            await renderList();
            showToast({ severity: "success", detail: zhPair(`Saved "${name}"`, `已保存「${name}」`) });
        } catch (e) {
            showToast({ severity: "error", detail: String(e?.message || e) });
        }
    }, { signal: abort.signal });

    element.append(
        head,
        sectionLabel(zhPair("Global strength", "全局强度倍率")), scaleBox, scaleHint,
        sectionLabel(zhPair("Save current stack", "保存当前整栈")), saveBox,
        sectionLabel(zhPair("Saved presets", "已存预设")), listHost,
    );
    // element 创建时就已 append（1075 行），这里只填内容，不再重复 append。
    // 内容落定后按**真实高度**夹进视口：优先保持在节点下方，实在放不下
    // 才上移贴住视口底；横向摆在节点左缘下方，本来就是空白画布。
    const fitPanel = () => {
        if (!element.isConnected) return;
        const rect = element.getBoundingClientRect();
        let top = Math.round(nodeBottom + 14);
        if (top + rect.height > window.innerHeight - 8) {
            top = Math.max(8, Math.round(window.innerHeight - 8 - rect.height));
        }
        element.style.top = `${top}px`;
    };
    stackPanel = { element, abort, fit: fitPanel };
    await renderList();   // 增删预设后 renderList 末尾会自己调 stackPanel.fit()
    fitPanel();
    // 点面板外面关掉。
    const outside = (e) => { if (!element.contains(e.target)) closeStackPanel(); };
    window.addEventListener("pointerdown", outside, { signal: abort.signal, capture: true });
}

// ---------------------------------------------------------------- Civitai

// 卡片里的「获取 Civitai 信息」跟 LoRA 加载器那张卡片是同一条链路：
// 服务器算 SHA256 → **本浏览器**问 civitai.com（服务器从不联网）→ 服务器验过
// 是同一个文件再写侧车。区别只在于这里没有齿轮菜单，两个偏好直接沿用加载器
// 存在 localStorage 里的那份 —— 同一台浏览器、同一套文件，设置不该有两份。
const LORA_SETTINGS_KEY = "qg.settings.lora_loader";

function loraPreferences() {
    let stored = {};
    try {
        stored = JSON.parse(window.localStorage?.getItem(LORA_SETTINGS_KEY) || "{}") || {};
    } catch (_) {
        stored = {};
    }
    const pictures = ["off", "PG-13", "any"];
    return {
        lookup: stored?.civitai_lookup !== false,
        picture: pictures.includes(stored?.civitai_picture) ? stored.civitai_picture : "PG-13",
    };
}

// 文件旁边那张预览图（`.preview.jpg` / `.png` / Civitai 存的）。存过新图之后
// 要换一个查询串再取一次，否则浏览器给的是缓存里那张旧的。
let thumbVersion = 0;

function thumbUrl(name) {
    const suffix = thumbVersion ? `&v=${thumbVersion}` : "";
    return api.apiURL(`/qg/lora/thumb?name=${encodeURIComponent(name)}${suffix}`);
}

// Civitai 查询编排已抽到 web/shared/civitai_flow.mjs；卡片 note 与缩略图版本
// 由 openTriggerEditor 的回调处理。thumbUrl / loraPreferences 仍留在本节点。

// ---------------------------------------------------------------- 触发词编辑器



// 行尾那个小图标点开的触发词卡片。触发词就是这一行贡献给 `triggers` 输出的词。
//
// 跟 QG_LoraLoader 里那个「i」卡片是同一套功能：列出文件自带 / Civitai / 自己加的
// 三组词，点一下就勾进这一行（再点取消），也能当场加一个新词并存到磁盘。
// 区别只在于这里词是**按行**存的（写回 rows_data，跟着工作流走），而加载器那边
// 每个文件一份、全局共用。两处都调同一批路由，所以「我的词」是共享的。
let triggerEditor = null;

function closeTriggerEditor() {
    if (!triggerEditor) return;
    triggerEditor.abort.abort();
    triggerEditor.element.remove();
    triggerEditor = null;
}

// 触发词的切分 / 去重 / 点选与加载器共用 shared/lora_stack.mjs：
// splitTriggerWords / joinTriggerWords / toggleTrigger / appendTrigger。
// 分隔符在那里与后端 _TRIGGER_SPLIT 对齐，别在这里再写一份正则。

function openTriggerEditor(state, index) {
    closeTriggerEditor();
    closePicker();
    const { node } = state;
    const row = state.rows[index];
    const widget = state.rowWidgets[index];
    if (!row || !widget) return;
    const canvas = app.canvas;
    const frame = canvas.canvas.getBoundingClientRect();
    const scale = canvas.ds.scale || 1;
    const offset = canvas.ds.offset ?? [0, 0];
    // 列宽必须和绘制同基准：Vue 下独立 canvas 比 node.size 窄 24px，
    // 按 node.size 算会让输入框 / 触发词卡片整体右偏。
    const cols = rowColumns(rowDrawWidth(node, widget));
    // 图标贴着节点右边缘，卡片就右对齐到图标、往左展开，别压在别的行上。
    // 节点贴屏幕最右侧时图标可能已经出界，右边界也夹一下，别让卡片被裁。
    const POPUP_W = 320;
    const iconRight = frame.left + (node.pos[0] + cols.triggerX + TRIGGER_W + offset[0]) * scale;
    const left = iconRight - POPUP_W;
    const popupLeft = Math.max(8, Math.min(Math.round(left), window.innerWidth - POPUP_W - 8));
    const top = frame.top + (node.pos[1] + widget.y + ROW_HEIGHT + 4 + offset[1]) * scale;

    const abort = new AbortController();
    const element = document.createElement("div");
    element.className = "qg-switchstack-triggers";
    element.style.cssText = `
        position: fixed; left: ${popupLeft}px; top: ${Math.round(top)}px;
        width: ${POPUP_W}px; max-height: 420px; padding: 8px;
        display: flex; flex-direction: column; gap: 6px;
        z-index: 10000; box-sizing: border-box;
        background: #23282c; border: 1px solid #3a4248; border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0,0,0,.55);
        font: 12px Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;`;

    // 预览图放最上面，跟 LoRA 加载器那张卡片一样。文件旁边没有图就整块不出现 ——
    // 一个空的 180px 框比没有图更难看。
    const preview = document.createElement("img");
    preview.alt = "";
    preview.style.cssText = `
        max-width: 100%; max-height: 180px; object-fit: contain; border-radius: 5px;
        align-self: center; display: none;`;
    preview.addEventListener("error", () => { preview.style.display = "none"; });

    const header = document.createElement("div");
    header.style.cssText = "color: #dbe3e7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    header.textContent = row.name || zhPair("trigger words", "触发词");

    const sub = document.createElement("div");
    sub.style.cssText = "color: #78848b; margin-top: -4px;";

    // 元信息行：底模徽标 + 推荐强度套用。后端 lora_info 早就返回 base_model
    // 和 range（用户存过的 min/max），以前只在副标题里当文字显示、堆这边连
    // 推荐强度都不显示。做成徽标一眼能看出这行是不是喂错底模，推荐强度给个
    // 一键套用，省得用户对着数字猜。🔴 只在这里读 data，不改行数据除了点按钮。
    const metaRow = document.createElement("div");
    // 纵向两行：第一行底模徽标，第二行「推荐强度 + 套用按钮」。挤在一行时
    // 中英混排的字会挨成一团（真机截图确认过），手机上更看不清。
    metaRow.style.cssText = "display: flex; flex-direction: column; align-items: flex-start; gap: 5px;";
    metaRow.dataset.qgMeta = "1";

    const chipsHost = document.createElement("div");
    chipsHost.style.cssText = "max-height: 240px; overflow-y: auto; padding-right: 2px;";

    const input = document.createElement("input");
    input.type = "text";
    // 卡片里有两个输入框（加词、整行手改），探针靠这个标记认准手改那个。
    input.dataset.qgTriggerText = "1";
    input.value = row.triggers || "";
    input.placeholder = zhPair("comma separated", "用逗号分隔，留空表示不加词");
    input.style.cssText = `
        width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
        border: 1px solid #3a4248; background: #1a1e21; color: #dbe3e7;
        font: inherit; outline: none;`;

    const hint = document.createElement("div");
    hint.textContent = zhPair("Click a word to add or remove it. Enter saves, Esc cancels.",
        "点词就能加进这一行或去掉；回车保存，Esc 取消");
    hint.style.cssText = "color: #78848b; line-height: 1.4;";

    // 底部动作区：Civitai 链接 + 「获取 Civitai 信息」。放在 chipsHost **外面** ——
    // 每次重新渲染词表都会 replaceChildren，放里面按钮点一次就没了。
    const footer = document.createElement("div");
    footer.style.cssText = "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;";

    const linkSlot = document.createElement("div");
    linkSlot.style.cssText = "display: flex; align-items: center;";

    const fetchButton = document.createElement("button");
    fetchButton.type = "button";
    // 探针靠这个标记认出「获取 Civitai 信息」那个按钮。
    fetchButton.dataset.qgCivitai = "1";
    fetchButton.style.cssText = `
        font: inherit; cursor: pointer; padding: 3px 9px; border-radius: 6px;
        border: 1px solid #3a4248; background: #2b3238; color: #dbe3e7;`;
    footer.append(linkSlot, fetchButton);

    const note = document.createElement("div");
    note.style.cssText = "line-height: 1.4; display: none;";

    element.append(preview, header, sub, metaRow, chipsHost, footer, note, input, hint);
    document.body.append(element);
    // 有预览图时卡片接近 420 高：行靠在窗口底部就会掉出去，量一下再翻到行上方。
    // 图是异步来的，加载完高度会变，所以 load 之后再来一次。
    const fitToViewport = () => {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= window.innerHeight - 8) return;
        const above = frame.top + (node.pos[1] + widget.y + offset[1]) * scale - rect.height - 4;
        element.style.top = `${Math.max(8, Math.round(above))}px`;
    };
    fitToViewport();
    preview.addEventListener("load", fitToViewport);
    triggerEditor = { element, abort, row };

    const current = () => splitTriggerWords(row.triggers);
    const active = (word) => hasTrigger(row.triggers, word);

    const syncInput = () => {
        input.value = row.triggers || "";
    };

    // 词直接写回行（不关卡片），每次改完重画一遍 chip 的选中状态。
    const commitWords = (next) => {
        row.triggers = next;
        writeRows(state);
        syncInput();
        if (info) renderChips(info);
    };

    // 与加载器共用同一套词逻辑。🔴 加词按钮必须用 appendTrigger 而不是
    // toggle：它还同时往服务端存了一份，用 toggle 点两次会「行里删掉、
    // 磁盘里多一条」，两边就此岔开。
    const toggleWord = (word) => commitWords(toggleTrigger(row.triggers, word));
    const addWord = (word) => commitWords(appendTrigger(row.triggers, word));

    let info = null;

    const chip = (word) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = word;
        const on = active(word);
        button.style.cssText = `
            font: inherit; cursor: pointer; padding: 2px 7px; margin: 0 4px 4px 0;
            border-radius: 10px; line-height: 1.5;
            border: 1px solid ${on ? "rgba(111,208,240,.65)" : "#3a4248"};
            background: ${on ? "rgba(111,208,240,.18)" : "transparent"};
            color: ${on ? "#9fe3ff" : "#a9b4bb"};`;
        button.addEventListener("click", () => toggleWord(word), { signal: abort.signal });
        return button;
    };

    const section = (label, words) => {
        if (!words?.length) return null;
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom: 6px;";
        const title2 = document.createElement("div");
        title2.textContent = label;
        title2.style.cssText = "color: #78848b; margin-bottom: 3px;";
        const row2 = document.createElement("div");
        for (const word of words) row2.append(chip(word));
        wrap.append(title2, row2);
        return wrap;
    };

    // 「我的词」多一行输入：加进去既存到磁盘（跟加载器共用），也勾进这一行。
    const addWordRow = (customWords) => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display: flex; gap: 4px; margin: 2px 0 4px;";
        const addInput = document.createElement("input");
        addInput.type = "text";
        addInput.placeholder = zhPair("add your own word", "加一个自己的词");
        addInput.style.cssText = `
            flex: 1; min-width: 0; padding: 3px 7px; border-radius: 6px; font: inherit;
            border: 1px solid #3a4248; background: #1a1e21; color: #dbe3e7; outline: none;`;
        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.textContent = "＋";
        addButton.style.cssText = `
            font: inherit; cursor: pointer; padding: 2px 9px; border-radius: 6px;
            border: 1px solid #3a4248; background: #2b3238; color: #dbe3e7;`;
        const submit = async () => {
            const word = addInput.value.trim();
            if (!word) return;
            addInput.value = "";
            const words = [...new Set([...(customWords ?? []), word])];
            try {
                await api.fetchApi("/qg/lora/triggers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: row.name, words }),
                });
            } catch (_) { /* 存盘失败也让词先勾上，用户至少能用 */ }
            // 卡片在请求途中被关掉时不要再写回：闭包里的 row 可能已经被删掉 /
            // 换过，addWord 会往旧行里塞词，还多记一次撤销。
            if (abort.signal.aborted) return;
            addWord(word);
        };
        addButton.addEventListener("click", submit, { signal: abort.signal });
        addInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                submit();
            }
            event.stopPropagation();
        }, { signal: abort.signal });
        wrap.append(addInput, addButton);
        return wrap;
    };

    // 底模徽标 + 推荐强度一键套用。两件事都只用 lora_info 已经返回的数据。
    // 底模做成徽标（有值才出现），一眼能看出这行是 Flux / SDXL / SD1.5 还是
    // 别的；推荐强度存在时给「套用」按钮，把中值写回当前行的两个强度。
    // 🔴 按钮文案带 qg 标记，探针好认；套用只改这一行，不碰别的行。
    const renderMeta = (data) => {
        metaRow.replaceChildren();
        const range = data && typeof data.range === "object" ? data.range : null;
        const hasRange = range && (Number.isFinite(range.min) || Number.isFinite(range.max));
        const family = data && typeof data.base_model === "string" ? data.base_model.trim() : "";
        if (!family && !hasRange) {
            metaRow.style.display = "none";
            return;
        }
        metaRow.style.display = "";
        if (family) {
            const badge = document.createElement("span");
            badge.textContent = family;
            badge.dataset.qgBaseModel = "1";
            badge.style.cssText = `
                display: inline-block; padding: 1px 7px; border-radius: 9px;
                font-size: 11px; line-height: 1.5; cursor: default;
                border: 1px solid rgba(159,225,203,.5); background: rgba(29,158,117,.16);
                color: #9fe1cb;`;
            badge.title = zhPair("Base model declared by this LoRA", "这个 LoRA 声明的底层模型");
            metaRow.append(badge);
        }
        if (hasRange) {
            const low = Number.isFinite(range.min) ? range.min : range.max;
            const high = Number.isFinite(range.max) ? range.max : range.min;
            const mid = Math.round(((low + high) / 2) * 100) / 100;
            // 第二行：文字与按钮并排，但整块和上面的徽标分行。
            const rangeRow = document.createElement("div");
            rangeRow.style.cssText = "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;";
            const label = document.createElement("span");
            label.textContent = zhPair("Suggested", "推荐强度") + " " + String(low) + "–" + String(high);
            label.style.cssText = "color: #a6c3b8; font-size: 12px;";
            const apply = document.createElement("button");
            apply.type = "button";
            apply.dataset.qgApplyRange = "1";
            apply.textContent = zhPair("Apply", "套用") + " " + String(mid);
            apply.style.cssText = `
                font: inherit; font-size: 12px; cursor: pointer; padding: 2px 10px;
                border-radius: 9px; border: 1px solid rgba(159,225,203,.5);
                background: rgba(29,158,117,.14); color: #9fe1cb;`;
            apply.title = zhPair("Set this row's model and CLIP strength to the suggested midpoint",
                "把这一行的模型与 CLIP 强度都设为推荐中值");
            apply.addEventListener("click", () => {
                row.strength = mid;
                row.strength_clip = mid;
                writeRows(state);
                syncInput();
                apply.textContent = zhPair("Applied", "已套用");
                apply.dataset.qgRangeApplied = "1";
            }, { signal: abort.signal });
            rangeRow.append(label, apply);
            metaRow.append(rangeRow);
        }
    };

    const renderChips = (data) => {
        chipsHost.replaceChildren();
        const chosen = current();
        const chosenWords = document.createElement("div");
        chosenWords.style.cssText = "margin-bottom: 6px;";
        const chosenTitle = document.createElement("div");
        chosenTitle.textContent = chosen.length
            ? zhPair(`On this row (${chosen.length})`, `这一行已选（${chosen.length}）`)
            : zhPair("No trigger words on this row yet", "这一行还没有触发词");
        chosenTitle.style.cssText = "color: #78848b; margin-bottom: 3px;";
        chosenWords.append(chosenTitle);
        if (chosen.length) {
            const list = document.createElement("div");
            for (const word of chosen) list.append(chip(word));
            chosenWords.append(list);
        }
        chipsHost.append(chosenWords);

        const groups = triggerGroups(data);
        const parts = [
            section(zhPair("From the file", "文件自带"), groups.file),
            section(zhPair("From Civitai", "Civitai"), groups.civitai),
        ].filter(Boolean);

        // 「我的词」永远在：文件里没有词的时候，这里是唯一能加词的地方。
        const myWrap = document.createElement("div");
        myWrap.style.cssText = "margin-bottom: 6px;";
        const myTitle = document.createElement("div");
        myTitle.textContent = zhPair("Your words", "我的词");
        myTitle.style.cssText = "color: #78848b; margin-bottom: 3px;";
        const myList = document.createElement("div");
        for (const word of groups.custom) myList.append(chip(word));
        myWrap.append(myTitle, myList, addWordRow(groups.custom));
        parts.push(myWrap);

        chipsHost.append(...parts);

        // 底模已移到 metaRow 做徽标，副标题只留 Civitai 标题，别重复显示。
        const bits = [];
        if (data.civitai_title) bits.push(data.civitai_title);
        sub.textContent = bits.join(" · ");
        sub.style.display = bits.length ? "" : "none";
        renderMeta(data);
    };

    // ---------- Civitai ----------
    const prefs = loraPreferences();

    const setNote = (text, tone = "info") => {
        note.textContent = text || "";
        note.style.display = text ? "" : "none";
        note.style.color = tone === "error" ? "#c98080" : (tone === "warn" ? "#c9a980" : "#78848b");
    };

    // 侧车里已经有 Civitai 的 model id 时给一个站内链接，跟加载器一致。
    const showLink = (data) => {
        linkSlot.replaceChildren();
        if (!Number.isInteger(data?.civitai_model_id)) return;
        const version = Number.isInteger(data.civitai_version_id)
            ? `?modelVersionId=${data.civitai_version_id}` : "";
        const link = document.createElement("a");
        link.href = `https://civitai.com/models/${data.civitai_model_id}${version}`;
        link.textContent = zhPair("View on Civitai ↗", "在 Civitai 上查看 ↗");
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.style.cssText = "color: #6fd0f0; text-decoration: none;";
        linkSlot.append(link);
    };

    // 预览图：`has_preview` 是服务端按文件旁边那张图算出来的，别自己猜文件是否存在。
    const showPreview = (data) => {
        if (!row.name || !data?.has_preview) {
            preview.removeAttribute("src");
            preview.style.display = "none";
            return;
        }
        preview.style.display = "";
        preview.src = thumbUrl(row.name);
    };

    const setButtonIdle = (data) => {
        fetchButton.disabled = false;
        fetchButton.textContent = data?.has_civitai
            ? zhPair("Refresh Civitai info", "重新获取 Civitai 信息")
            : zhPair("Fetch Civitai info", "获取 Civitai 信息");
    };

    // 加载器齿轮里关掉了这个按钮，这里也真的不出现。
    if (prefs.lookup) setButtonIdle(null);
    else fetchButton.remove();

    const fetchCivitai = async () => {
        if (!row.name) {
            setNote(zhPair("Pick a LoRA on this row first.", "先给这一行选个 LoRA。"), "error");
            return;
        }
        fetchButton.disabled = true;
        fetchButton.textContent = zhPair("Fetching...", "正在查询…");
        setNote("");
        try {
            const found = await lookupCivitaiInfo({
                fetchApi: (...args) => api.fetchApi(...args),
                name: row.name,
                picture: prefs.picture,
                // UI 差异只在这里：失败写进卡片 note，加载器那边换成 loraToast。
                // picture_already_saved 由 shared 统一吞掉，不会走到这里。
                onPictureError: (error) => {
                    const why = pictureErrorText(error);
                    if (why) setNote(why, "warn");
                },
                // 新图刚落盘：卡片里那张也要换查询串重取。
                onPictureSaved: () => { thumbVersion += 1; },
            });
            if (!element.isConnected) return;
            if (!found) {
                setButtonIdle(info);
                fetchButton.textContent = zhPair("Not found on Civitai", "Civitai 上没有这个文件");
                return;
            }
            // 侧车刚被写进去，重新读一遍：标题与「Civitai」那组词都要换成新的。
            await load();
        } catch (error) {
            if (!element.isConnected) return;
            setNote(civitaiFailureText(error), "error");
            setButtonIdle(info);
            fetchButton.textContent = zhPair("Civitai lookup failed", "Civitai 查询失败");
        } finally {
            fetchButton.disabled = false;
        }
    };
    fetchButton.addEventListener("click", () => fetchCivitai(), { signal: abort.signal });

    const save = () => {
        row.triggers = input.value.trim();
        writeRows(state);
        closeTriggerEditor();
    };

    input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            closeTriggerEditor();
        }
        if (event.key === "Enter") {
            event.stopPropagation();
            save();
        }
        event.stopPropagation();
    }, { signal: abort.signal });
    // 点外面 = 保存（跟大多数内联编辑框一样，别让人以为点了就丢）
    const outside = (event) => {
        if (element.contains(event.target)) return;
        save();
    };
    window.addEventListener("pointerdown", outside, { capture: true, signal: abort.signal });

    const load = async () => {
        if (!row.name) {
            chipsHost.textContent = "";
            const message = document.createElement("div");
            message.textContent = zhPair("Pick a LoRA first, then its words show up here.",
                "先给这一行选个 LoRA，这里才会列出它的词");
            message.style.cssText = "color: #78848b; padding: 4px 0;";
            chipsHost.append(message);
            sub.style.display = "none";
            metaRow.style.display = "none";
            metaRow.replaceChildren();
            linkSlot.replaceChildren();
            showPreview(null);
            return;
        }
        try {
            // 🔴 剥 {ok, info} 外壳这一层由 shared 负责，别在这里再写一遍。
            const data = await readLoraInfo((...args) => api.fetchApi(...args), row.name);
            if (!element.isConnected) return;
            info = data;
            renderChips(data);
            if (fetchButton.isConnected) setButtonIdle(data);
            showLink(data);
            showPreview(data);
        } catch (_) {
            if (!element.isConnected) return;
            const message = document.createElement("div");
            message.textContent = zhPair("Could not read this file's words.", "读不到这个文件的词。");
            message.style.cssText = "color: #c98080; padding: 4px 0;";
            chipsHost.replaceChildren(message);
            // 读不到文件的词，不代表没法去 Civitai 查它 —— 按钮留着。
            showLink(null);
        }
        // 词表 / 标题 / 预览图都是异步填进来的，卡片可能从 200px 涨到近 420px。
        // 只在 append 和 preview.load 量一次不够 —— 没有预览图的 LoRA 根本不触发
        // load 事件，底部会被裁掉。内容落定后再量一次。
        requestAnimationFrame(() => { if (element.isConnected) fitToViewport(); });
    };
    load();

    // 画布会在 pointerdown 之后抢一次焦点，等这一轮跑完再要回来。
    requestAnimationFrame(() => {
        if (!element.isConnected) return;
        input.focus({ preventScroll: true });
    });
}

// ---------------------------------------------------------------- 选择器

let pickerState = null;

function closePicker() {
    if (!pickerState) return;
    pickerState.abort.abort();
    pickerState.element.remove();
    pickerState = null;
}

let loraCache = { at: 0, list: [] };

async function fetchLoras() {
    if (Date.now() - loraCache.at < 60000 && loraCache.list.length) return loraCache.list;
    const response = await api.fetchApi("/qg/lora/list");
    const data = await response.json();
    const list = Array.isArray(data?.loras) ? data.loras : [];
    loraCache = { at: Date.now(), list };
    return list;
}

// 过滤逻辑（多词 AND）在 shared/lora_stack.mjs，这里只定 UI 上最多列几条。
const PICKER_LIMIT = 300;

async function openPicker(state, index, options = {}) {
    closePicker();
    closeTriggerEditor();
    const { node } = state;
    const anchorWidget = options.anchorWidget ?? state.rowWidgets[index];
    const canvas = app.canvas;
    const frame = canvas.canvas.getBoundingClientRect();
    const scale = canvas.ds.scale || 1;
    const offset = canvas.ds.offset ?? [0, 0];
    const left = frame.left + (node.pos[0] + offset[0]) * scale;
    const top = frame.top + (node.pos[1] + (anchorWidget?.y ?? 0) + ROW_HEIGHT + offset[1]) * scale;

    const abort = new AbortController();
    const element = document.createElement("div");
    element.className = "qg-switchstack-picker";
    element.style.cssText = `
        position: fixed; left: ${Math.round(left)}px; top: ${Math.round(top)}px;
        width: ${Math.round(Math.max(240, node.size[0] * scale * 0.8))}px;
        max-height: 320px; display: flex; flex-direction: column; z-index: 10000;
        background: #23282c; border: 1px solid #3a4248; border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0,0,0,.55); overflow: hidden;
        font: 12px Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;`;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = zhPair("search LoRA", "搜索 LoRA");
    input.style.cssText = `
        margin: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid #3a4248;
        background: #1a1e21; color: #dbe3e7; font: inherit; outline: none;`;
    const caption = document.createElement("div");
    caption.textContent = zhPair("Choose a LoRA", "选择 LoRA");
    caption.style.cssText = "padding: 0 8px 6px; color: #9ba2aa;";
    const list = document.createElement("div");
    list.style.cssText = "flex: 1; overflow-y: auto; padding: 0 4px 6px;";
    element.append(input, caption, list);
    document.body.append(element);
    const rect = element.getBoundingClientRect();
    // 左右都夹一下：节点贴着屏幕任一侧时列表都会被裁掉一截。
    const clampedLeft = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
    if (Math.abs(clampedLeft - rect.left) > 0.5) {
        element.style.left = `${Math.round(clampedLeft)}px`;
    }
    // 「+ 添加 LoRA」在节点最底下，列表往下展开容易掉出窗口：越界就翻到按钮上方。
    if (rect.bottom > window.innerHeight - 8) {
        const above = frame.top + (node.pos[1] + (anchorWidget?.y ?? 0) + offset[1]) * scale - rect.height - 4;
        element.style.top = `${Math.max(8, Math.round(above))}px`;
    }
    pickerState = { element, abort, owner: node };

    input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            closePicker();
        }
        if (event.key === "Enter") {
            const first = list.querySelector("[data-name]");
            if (first) pick(first.dataset.name);
        }
        event.stopPropagation();
    }, { signal: abort.signal });

    const pick = (name) => {
        // 「+ 添加 LoRA」那条路：选中的这一刻才把新行撑出来，取消不留下空行。
        options.beforePick?.();
        const row = state.rows[index];
        // 换文件就把旧词的痕迹擦掉：新文件没有触发词时，留着上一份的词
        // 会静悄悄混进 triggers 输出，界面上还看不出来。
        if (row.name !== name) row.triggers = "";
        row.name = name;
        writeRows(state);
        closePicker();
        // 触发词跟着文件走：读一次 sidecar / 元数据，填进行里。
        api.fetchApi(`/qg/lora/info?name=${encodeURIComponent(name)}`)
            .then((response) => response.json())
            .then((payload) => {
                // 🔴 `{ok, info}`：少剥一层就永远拿不到词（这里曾经静默失效过）。
                const info = payload?.info ?? payload;
                const words = info?.file_triggers ?? [];
                // 读回来之前用户可能已经手动改过（卡片开着），别覆盖他。
                if (state.rows[index] !== row || row.triggers) return;
                // 🔴 连续换文件时，前一次的 /qg/lora/info 可能后回来。只比对象和
                // triggers 挡不住：换了名字时 triggers 已被清空，请求回来仍会
                // 把上一个文件的词写进这一行。名字必须是这次请求的那个文件。
                if (row.name !== name) return;
                if (!Array.isArray(words) || !words.length) return;
                // 文件自带的词当默认值填进来，不想要就在卡片里点掉。
                row.triggers = joinTriggerWords(words.map((w) => String(w).trim()).filter(Boolean));
                writeRows(state);
            })
            .catch(() => {});
    };

    const render = (items) => {
        list.replaceChildren();
        if (!items.length) {
            const empty = document.createElement("div");
            empty.textContent = zhPair("no match", "没有匹配项");
            empty.style.cssText = "padding: 10px; color: #78848b; text-align: center;";
            list.append(empty);
            return;
        }
        for (const name of items) {
            const item = document.createElement("div");
            item.dataset.name = name;
            item.textContent = name;
            item.style.cssText = `
                padding: 5px 8px; border-radius: 5px; color: #cfd8dc; cursor: pointer;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
            item.addEventListener("mouseenter", () => { item.style.background = "#2f363b"; },
                { signal: abort.signal });
            item.addEventListener("mouseleave", () => { item.style.background = ""; },
                { signal: abort.signal });
            item.addEventListener("pointerdown", (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                pick(name);
            }, { signal: abort.signal });
            list.append(item);
        }
    };

    render(filterLoras(loraCache.list, "", PICKER_LIMIT));
    // 画布会在 pointerdown 之后抢一次焦点，等这一轮事件跑完再要回来。
    requestAnimationFrame(() => {
        if (!element.isConnected) return;
        input.focus({ preventScroll: true });
    });
    input.addEventListener("input", () => render(filterLoras(loraCache.list, input.value, PICKER_LIMIT)),
        { signal: abort.signal });

    // 点别处关掉
    const outside = (event) => {
        if (!element.contains(event.target)) closePicker();
    };
    window.addEventListener("pointerdown", outside, { capture: true, signal: abort.signal });

    const all = await fetchLoras();
    if (pickerState?.element === element) render(filterLoras(all, input.value, PICKER_LIMIT));
}

// ---------------------------------------------------------------- 装配

function hideWidget(widget) {
    if (!widget) return;
    // 🔴 只按高度收，**不要**改 widget.type = "hidden"：前端保存/加载工作流时会跳过
    // 这种类型的 widget，存档里的值根本回不来 —— 表现是重新打开工作流后 rows_data
    // 变成默认的 "[]"，一整个栈消失，而界面上看不出任何报错。
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    // 🔴 1.58.5 起 Vue 按 hidden / options.hidden 决定要不要给 widget 分网格行。
    // 只把 computeSize 压到 0，独立 canvas 是没了，rows_data / trigger_separator /
    // on_missing 三块仍各占一行，节点被撑成一根长条。hidden 只收渲染，不动
    // widgets_values 的顺序和值，老存档照常恢复。
    widget.hidden = true;
    if (widget.options) widget.options.hidden = true;
    if (widget.element) widget.element.style.display = "none";
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

// 把每个 on_N 输入绑到对应行的 widget 上 —— 槽从此由画布画在行里。
// 🔴 每次加载工作流都要重来一遍：`configure` 会重建 inputs，绑好的 widget 引用、
// 零宽 label 全丢，槽就掉回节点上方的输入区、label 退回 "row_1"（截图里就是这样：
// 连线接到了行外面）。所以这个函数是幂等的，挂载和 onConfigure 都调。
function bindSlots(state) {
    const { node } = state;
    // 快路径：每帧都会路过这儿，绑好的情况下只做一次查找。
    const probe = node.inputs?.find((item) => item.name === "on_1");
    if (probe && probe.widget === state.rowWidgets[0] && probe.label === "\u200b") return;
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        const widget = state.rowWidgets[index];
        const input = node.inputs?.find((item) => item.name === `on_${index + 1}`);
        if (!input || !widget) continue;
        if (input.widget !== widget) input.widget = widget;
        // 空字符串不够 —— 前端会退回 input.name（"row_1"）画在行上。零宽字符才行。
        if (input.label !== "\u200b") input.label = "\u200b";
        // 残留的坐标会让它不跟随 widget。
        if (input.pos) delete input.pos;
    }
}

// 从存档里取回 rows_data。
//
// 🔴 不能只指望前端把 `widgets_values` 回填到 widget 上：收成 [0, -4] 的隐藏 widget
// 在有的版本里根本拿不到自己的那一项，重新打开工作流后 rows_data 停在默认的 "[]"，
// 一整个栈凭空消失，界面上一点报错都没有。存档里的第 0 项就是 rows_data（它前面
// 只有 model，而 model 是输入不是控件），形状也认得出来，所以这里直接读它。
function storedRows(info) {
    const values = info?.widgets_values;
    if (!Array.isArray(values)) return null;
    const value = values[0];
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text.startsWith("[")) return null;
    try {
        if (!Array.isArray(JSON.parse(text))) return null;
    } catch (_) {
        return null;
    }
    return text;
}

// 加载工作流后补回被重建的 inputs 上的绑定。
//
// 🔴 别指望 `onConfigure`：新版前端（1.53）**根本不调用它** —— 实测挂实例钩子，
// 加载工作流时计数始终是 0，表现为「重新打开工作流后整个栈消失」且没有任何报错。
// 真正的入口是实例上的 `configure`（见 installConfigureHook）。
// 每帧跑的 `onDrawForeground` 只做绑定兜底，**绝不能**拿 `node.widgets_values`
// 回写 widget 的值：那个字段在 configure 之后并不总是跟着更新，每帧都会把刚
// 恢复好的栈冲回旧的 "[]"，看上去又像「加载后栈没了」。
function syncFromSave(node) {
    const state = node.__qgSwitchStack;
    if (!state?.dataWidget || !state.rowWidgets?.length) return;
    bindSlots(state);
}

// 接上线的行，前端不再调 `widget.draw`，改画它自己的「已连接」块 —— 那一行就只剩
// 一个空白块，开关、名字、强度全看不见了。所以由节点级的 `onDrawForeground` 在
// 所有 widget 之上补画一遍（前景是最上层，正好盖住那个块）。
// 没接线的行不要重画：它们本来就走 `widget.draw`，重画等于每帧画两遍。
// 🔴 补画必须和 widget.draw 用同一个宽度 rowDrawWidth(node, widget)：旧代码
// 不传 width，drawRow 回落 node.size[0]，青框比绿框宽 24 单位（11-12 截图实测）。
function drawLinkedRows(node) {
    const state = node.__qgSwitchStack;
    if (!state?.rowWidgets?.length) return;
    const ctx = app.canvas?.ctx;
    if (!ctx) return;
    const visible = visibleRows(state);
    for (let index = 0; index < visible; index += 1) {
        const input = node.inputs?.find((item) => item.name === `on_${index + 1}`);
        const widget = state.rowWidgets[index];
        if (!input?.link || !widget) continue;
        drawRow(ctx, node, state, index, widget.y, rowDrawWidth(node, widget));
    }
}

function installConfigureHook(node) {    if (node.__qgSwitchStackHooked) return;
    node.__qgSwitchStackHooked = true;
    const previousConfigure = node.configure;
    node.configure = function (info) {
        const result = previousConfigure?.apply(this, arguments);
        // 🔴 无条件先 mount：configure 会把 widgets 数组整个换掉，此刻
        // `state.dataWidget` 还指着旧对象（或干脆是 null），先判空就永远进不来。
        mount(this);
        const state = this.__qgSwitchStack;
        if (!state?.dataWidget) return result;
        const saved = storedRows(info);
        if (saved !== null) state.dataWidget.value = saved;
        state.rows = readRows(this);
        // 🔴 不再 `Math.max(1, ...)`：空存档加载后就该是零行（只剩「+ 添加 LoRA」）。
        // 有名字的行由 filledRows 从存档数出来，不需要靠 minRows 兜底留空行。
        // 也**必须归零**：「+ 添加」临时撑出来的空行属于上一次界面状态，
        // 只 clamp 的话会被带进新加载的存档 / 撤销重做后的存档，多显示几行空行。
        state.minRows = 0;
        applyRowCount(state);
        return result;
    };
}

// 「+ 添加 LoRA」= 直接弹列表挑一个文件，不再先塞一行「空行」等人去点它。
// 🔴 关键顺序：**选中之后才加行**。要是先加行再弹列表，用户按 Esc / 点别处取消，
// 节点上就留下一个空行 —— 正是上一轮花力气删掉的那种空行。
function onAddRow(state) {
    // 「+ 添加 LoRA」是 addWidget 自己的 widget，不走 onRowMouse，得单独收输入框。
    closeStrengthInput(state);
    const visible = visibleRows(state);
    // 已经手动点出来、还没填名字的空行优先复用，别把它后面又撑出一行。
    let index = -1;
    for (let i = 0; i < visible; i += 1) {
        if (!state.rows[i]?.name) { index = i; break; }
    }
    let needsRow = false;
    if (index < 0) {
        if (visible >= SLOT_COUNT) return true;
        index = visible;
        needsRow = true;
    }
    openPicker(state, index, {
        // 新行此刻还没显示，rowWidgets[index].y 是没排过版的值；
        // 列表就贴在「+ 添加 LoRA」那一条下面。
        anchorWidget: needsRow ? state.addWidget : state.rowWidgets[index],
        beforePick: needsRow
            ? () => {
                state.minRows = Math.min(SLOT_COUNT, visibleRows(state) + 1);
                applyRowCount(state);
                state.node.setDirtyCanvas?.(true, true);
            }
            : null,
    });
    return true;
}

// 装配（幂等，可以反复调）。
//
// 🔴 不能只在 onNodeCreated 里建一次：加载工作流时 `configure` 会把 `node.widgets`
// 整个换成新数组，我们建的 SLOT_COUNT 个行 widget 就不在列表里了 —— 行画不出来、槽也跟丢。
// 所以这里每次都按名字清掉旧的再重建。
function mount(node) {
    const state = stateOf(node);
    const kept = (node.widgets ?? []).filter((widget) =>
        !/^row_\d+$/.test(widget.name ?? "") && widget.name !== "add_row");
    if (kept.length !== (node.widgets ?? []).length) node.widgets = kept;

    state.dataWidget = (node.widgets ?? []).find((widget) => widget.name === "rows_data") ?? null;
    if (!state.dataWidget) return;
    hideWidget(state.dataWidget);
    hideWidget((node.widgets ?? []).find((widget) => widget.name === "trigger_separator"));
    hideWidget((node.widgets ?? []).find((widget) => widget.name === "on_missing"));

    state.rows = readRows(node);

    // 建 SLOT_COUNT 个行 widget，把对应的 on_N 输入绑上去 —— 槽从此长在行上。
    state.rowWidgets = [];
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        const widget = node.addWidget("text", `row_${index + 1}`, "", () => {}, { serialize: false });
        // 🔴 新版前端把 widget 建成 TextWidget 并挂 `_node` 指回节点，于是
        // node → widgets → TextWidget → _node → node 成了循环引用；加载工作流时
        // 核心的 configure 要对节点做深拷贝，直接抛 "Converting circular structure"，
        // 整个 configure 中断 —— 表现就是存档里的行凭空消失，且一点报错都没有。
        // 不能删 `_node`（前端 setNodeId 要用），只是让它**不可枚举**：
        // JSON.stringify 跳过不可枚举属性，前端照样读得到。
        try {
            Object.defineProperty(widget, "_node", {
                value: widget._node,
                writable: true,
                configurable: true,
                enumerable: false,
            });
        } catch (_) { /* 老前端本来就没有这个字段 */ }
        widget.computeSize = (width) => [width, ROW_HEIGHT];
        // Node 2.0 的独立 canvas 比 node.size 窄，画到哪块 canvas 就按哪块的实际宽算，
        // 否则行尾 `×` 被裁到 canvas 外（用户报「添加的行删不掉」）。
        // 🔴 1.58.5 起 widget.draw 的第 3 参是**宽度数字**（经典 / Vue 都是），不是
        // widget 实例；拿它去读 `.width` 会得到 NaN、回落成 node.size[0]=380，
        // 行框右缘就画到 356px 的独立 canvas 外（真机 sf.right=376）。
        // 直接闭包捕获本行 widget；WidgetLegacy 已把它的 .width 设成画布布局宽。
        widget.draw = (ctx, ownNode, _third, posY) =>
            drawRow(ctx, ownNode, state, index, posY, rowDrawWidth(ownNode, widget));
        widget.onPointerDown = (pointer, ownNode, canvas) =>
            onRowMouse(state, pointer, rowPointerLocal(pointer, canvas, ownNode, widget), index);
        // 🔴 行一旦接上线，前端就**不再调用这一行的 draw**，改由它自己画一个
        // 「已连接」的块，块里的文字取 `widget.label ?? widget.name` —— 于是行上
        // 冒出一个 `row_2`，而开关/名字/强度全没了。widget 的 name 得留着当身份
        // （mount 靠它清理重建），所以把 label 压成零宽；行本身改由节点级的
        // `onDrawForeground` 补画（见 drawLinkedRows）。
        widget.label = "\u200b";
        state.rowWidgets.push(widget);
    }

    const addWidget = node.addWidget("text", "add_row", "", () => {}, { serialize: false });
    addWidget.computeSize = (width) => [width, ROW_HEIGHT + 4];
    addWidget.draw = (ctx, ownNode, _third, posY) =>
        drawAddRow(ctx, ownNode, state, posY, rowDrawWidth(ownNode, addWidget));
    addWidget.onPointerDown = () => onAddRow(state);
    state.addWidget = addWidget;

    bindSlots(state);
    applyRowCount(state);
}

// 🔴 切回经典时清掉 Vue 写在控件上的残留 width。我们自己的绘制/命中已改问
// 官方模式，但前端画控件底、算控件命中区仍读 widget.width（LGraphNode.ts:4304
// `widget.width || nodeWidth`），不清就会按 356 画一条比节点窄 24px 的底、
// 并把行尾 × 的命中区一起左移。清成 undefined 让前端回落 nodeWidth；下次
// 进新版界面时 WidgetLegacy 会自己重新写回 356，不用手工恢复。
function syncSwitchStackMode(node) {
    const s = node.__qgSwitchStack;
    if (!s || vueNodesEnabled()) return;
    for (const widget of [...(s.rowWidgets || []), s.addWidget]) {
        if (widget) widget.width = undefined;
    }
    node.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------- 注册

app.registerExtension({
    name: "QG.lora_switch_stack",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onCreated?.apply(this, arguments);
            mount(this);
            installConfigureHook(this);
            // 模式切换观察器的迁移入口；新建 / 加载工作流也会调，幂等无害。
            this.__qgSyncMode = () => syncSwitchStackMode(this);
            return result;
        };

        // 右键菜单入口：整栈预设 / 批量强度。note 节点已用同一套 Context Menu
        // API（getExtraMenuOptions），这里沿用；菜单项的 content 是节点内文字，
        // 走 zhPair 才能跟随语言切换。
        // 🔴 Context Menu API 的约定（LGraphCanvas.ts:8625）：
        //   const extra = node.getExtraMenuOptions?.(this, options)
        //   if (Array.isArray(extra) && extra.length > 0)
        //       options = extra.concat(options)
        // 传入的 options 是所有插件共享的那一个数组；返回非数组（undefined）时
        // 前端继续用它。所以正确写法和 note 节点一致：**只往 args[1] 里 unshift，
        // 不 return 数组**。返回数组会让前端 concat 出重复项，而且调用链上别的
        // 插件（Custom-Scripts / rgthree / Manager）会拿这个返回值另做处理 ——
        // 真机实测第一版「return baseExtra() 的结果」菜单里完全没有「栈工具」。
        const baseExtra = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (...args) {
            const shared = args[1];
            baseExtra?.apply(this, args);
            const node = this;
            if (Array.isArray(shared)) {
                // 幂等：别的插件可能再次调用，别重复插同一组入口。
                // 两个入口一次 unshift 进去，顺序才是「栈工具」在前、「删除」在后。
                if (!shared.some((item) => item && item.__qgStackTools)) {
                    shared.unshift(
                        {
                            __qgStackTools: true,
                            content: zhPair("Stack tools (presets / strength)", "栈工具（预设 / 强度）"),
                            callback: () => {
                                const state = node.__qgSwitchStack;
                                if (state) openStackPanel(state);
                            },
                        },
                        {
                            // 独立的二级菜单，删除操作全部收在这里，不用再开面板。
                            __qgDeleteTools: true,
                            content: zhPair("Delete (rows / presets)", "删除（行 / 预设）"),
                            has_submenu: true,
                            submenu: { options: deleteMenuOptions(node) },
                        },
                    );
                }
            }
            // 故意不 return：让前端沿用它传进来的那个 options 数组。
        };

        // 每帧一次的机会：configure 之外（比如撤销/重做把 inputs 换掉）也把绑定补回来。
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            const result = onDrawForeground?.apply(this, arguments);
            syncFromSave(this);
            drawLinkedRows(this);
            return result;
        };

        // 连上/断开 on_N 时刷新那一行（开关要变成「由连线决定」的样子）。
        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index, connected, link, slot) {
            const result = onConnectionsChange?.apply(this, arguments);
            if (type === 1) this.setDirtyCanvas?.(true, true);
            return result;
        };

        // 行内箭头要有悬停反馈。onMouseMove 给的是节点内局部坐标，只在跨行时
        // 才请求重绘，别让每次鼠标移动都刷整块画布。
        const onMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (event, pos, canvas) {
            const result = onMouseMove?.apply(this, arguments);
            const s = this.__qgSwitchStack;
            if (s?.rowWidgets?.length && pos) {
                const visible = visibleRows(s);
                let hit = -1;
                for (let i = 0; i < visible; i += 1) {
                    const w = s.rowWidgets[i];
                    if (w && pos[1] >= w.y && pos[1] <= w.y + ROW_HEIGHT) { hit = i; break; }
                }
                if (s.hoverRow !== hit) {
                    s.hoverRow = hit;
                    this.setDirtyCanvas?.(true, true);
                }
            }
            return result;
        };
        const onMouseLeave = nodeType.prototype.onMouseLeave;
        nodeType.prototype.onMouseLeave = function () {
            const result = onMouseLeave?.apply(this, arguments);
            const s = this.__qgSwitchStack;
            if (s && s.hoverRow !== -1) {
                s.hoverRow = -1;
                this.setDirtyCanvas?.(true, true);
            }
            return result;
        };

        // 已接线的那几行收不到 widget 事件，点击会落到这里 —— 按行 y 转发回行内逻辑，
        // 这样「接线之后强度照样能拖、名字照样能点」。
        const onMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, pos, canvas) {
            const result = onMouseDown?.apply(this, arguments);
            if (result) return result;
            const state = this.__qgSwitchStack;
            if (!state?.rowWidgets?.length || !pos) return result;
            if (event?.button > 0) return result;
            const index = linkedRowAt(this, state, pos[1]);
            if (index < 0) return result;
            return onRowMouse(state, event, pos, index) || result;
        };
    },

    async setup() {
        // 行操作菜单的入口是「在这一行上点右键」。钩子挂在 window 捕获阶段，
        // 经典画布和 Nodes 2.0 的独立行 canvas 都进得来；只认领命中行的右键，
        // 其余位置照旧走 ComfyUI 原生节点菜单。
        installRowContextMenu();
        // 切界面模式时把浮层全收掉：面板 / 选择器 / 触发词卡片 / 行菜单都是
        // 按当前模式算坐标的（画布坐标 vs Vue 独立 canvas 矩形），留着会在
        // 新模式里错位，甚至盖住节点。共享模块已经提供这个钩子，别再自己轮询。
        onRenderModeSwitch(() => {
            closePicker();
            closeTriggerEditor();
            closeStackPanel();
            closePresetDeleteMenu();
            closeRowMenu();
        });
        // 切模式后把每个 LoRA 堆节点上的残留控件宽度清掉。观察器自带 400ms
        // 轮询 + 350ms 防抖，只在真正跨模式时触发；fallback 兜住「加载工作流
        // 时节点由 configure 重建、没走 onNodeCreated」的情况。
        installModeWatcher((node) => {
            if (String(node?.comfyClass ?? node?.type ?? "") !== "QG_LoraSwitchStack") return null;
            if (typeof node.__qgSyncMode !== "function") {
                node.__qgSyncMode = () => syncSwitchStackMode(node);
            }
            return node.__qgSyncMode;
        });
    },
});

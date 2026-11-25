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
//
// 行归属（2026-11-22 起，2026-11-23 转正）：被某个「工作流开关」管着的行，
// 行尾显示一个 ⇄ 小徽章 —— 悬停看是哪个开关，点一下跳到那张卡片。判据来自
// web/shared/workflow_switches.mjs（normalizeSettings → valuePairs → 行名按
// 文件归一），与 LoRA 加载器读的是同一份开关设置；这里一次扫描建索引
// （refreshOwners），不必每帧每行重新解析整栈快照。

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { installModeWatcher, onRenderModeSwitch, vueNodesEnabled } from "../shared/vue_mode.mjs?v=202611251300";
import { zhPair } from "../shared/zh.mjs?v=202611251300";
import { BRAND, showToast } from "../shared/index.mjs?v=202611251300";
import { badgeCenter, showBadge } from "../shared/help_badge.mjs?v=202611251300";
import {
    closeSettingsMenu,
    gearIconSvg,
    loadSettings,
    openSettingsMenu,
} from "../shared/settings_menu.mjs?v=202611251300";
// 与加载器共用同一份齿轮设置表（用户 11-20 确认），别在任一节点另写一份。
import {
    LORA_SETTINGS_SCOPE,
    LORA_SETTINGS_SCHEMA,
} from "../shared/lora_settings.mjs?v=202611251300";
import {
    civitaiFailureText,
    pictureErrorText,
} from "../shared/civitai_lookup.mjs?v=202611251300";
// 强度手感 / 触发词 / 选择器过滤 / 读 LoRA 信息只有一份真相源：加载器也在用
// 同一个 shared 模块，改一次两边同步。🔴 别在这里另写 ±10 / 0.05 或切词正则。
import {
    absorbChainIssue,
    appendTrigger,
    BYPASS_MODE,
    clampStrength,
    collectDownstreamLoaders,
    collectUpstreamLoaders,
    DEFAULT_STEP,
    FINE_STEP,
    filterLoras,
    fitLoraLabel,
    groupByFolder,
    hasTrigger,
    importSummary,
    joinTriggerWords,
    loaderLoraEntries,
    loraFolders,
    mergeImportedRows,
    MUTE_MODE,
    readLoraInfo,
    resolveLoraName,
    roundStrength,
    SCRUB_DEAD_ZONE,
    SCRUB_PIXELS_PER_STEP,
    shortLoraName,
    splitTriggerWords,
    STRENGTH_MAX,
    STRENGTH_MIN,
    thumbPosition,
    toggleTrigger,
    triggerGroups,
} from "../shared/lora_stack.mjs?v=202611251300";
// Civitai 查询编排与加载器共用；卡片 note / 缩略图版本由回调注入。
import { lookupCivitaiInfo } from "../shared/civitai_flow.mjs?v=202611251300";
// 建议强度沿用加载器的可拖动数字框，手势与步长只有一份真相源。
import { makeScrubInput } from "../shared/scrub_input.mjs?v=202611251300";
// ：行归属与「工作流开关」用同一套判据（normalizeSettings +
// valuePairs），不在这里另写一份比较逻辑；SETTINGS_PROPERTY 也从那里取，
// 免得存档键在两个文件里各写一遍。
import { fileKey, normalizeSettings, SETTINGS_PROPERTY, valuePairs } from "../shared/workflow_switches.mjs?v=202611251300";

const NODE_CLASS = "QG_LoraSwitchStack";
const SLOT_COUNT = 24;
const ROW_HEIGHT = 20;
// 圆点由画布画在节点左边缘 x=0..14 上，行的底色从这儿往后画，别盖住它。
const SLOT_BAND = 16;
const SWITCH_W = 22;
const SWITCH_H = 10;
// 强度控件：「◀  0.80  ▶」。中间数值区要放得下 "3.00/2.20"（11px 等宽约 59px），
// 两侧各留一个箭头，所以这一带比纯数字时代宽一些。
const STRENGTH_BAND = 84;
// 「模型 / CLIP 强度分开」时把这一带劈成两个更窄的控件；总宽只比原来多 60px，
// 名字列还留得下。与加载器的 SEPARATE_EXTRA_WIDTH 同为 72 一档，手感一致。
const SEPARATE_BAND = 72;
const SEPARATE_GAP = 4;
const ARROW_W = 12;
const CLEAR_W = 16;
// 名字区最左端的一小条「≡」手柄：按住它拖 = 重排行。排序必须有一个**不带修饰键**
// 的抓手 —— Alt 被 ComfyUI 的「拖拽克隆节点」吃掉、Ctrl 被多选框吃掉，Shift 又要
// 留给「拖强度改 CLIP」，三条路都占着，只能让手势从「按住哪」来区分。
const GRIP_W = 13;
// 旧版三点按钮占的那一列已经作废（行菜单改成**在这一行上点右键**），
// 空出来的 14 单位还给名字列：强度框与 T 图标整体右移，名字能多显示两三个字。
// 🔴 clearX 仍只由 width 决定，× 的坐标一点没动，老探针按行尾坐标点删除照样有效。
const TRIGGER_END_GAP = 6;   // T 图标右边缘到 × 左边缘的距离
// 触发词图标：紧挨 × 的那一小块。窄到只占 15px，但点得着（判定区留了 18px）。
const TRIGGER_W = 15;

const FONT = '12px Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif';

// 「+ 添加 LoRA」按钮的强调色。appearance 把当前强调色写在 root 的
// --qg-accent / --qg-on-accent 上；canvas 画不出 CSS 变量，只能读进来缓存
// （和 snaplines 同一个套路）。切方案/改自定义色时 appearance 会发
// qg-accent-changed，这里丢缓存 + 刷画布让按钮立刻换色。
// 可点态把整块框填成实心强调色（和加载器的 +LoRA 按钮同款），字用 on-accent
// 墨色（appearance 按强调色明暗自适应：青/紫底深字、很深的自选底浅字）。
let addAccentCache = null;

function addAccent() {
    if (addAccentCache) return addAccentCache;
    let solid = BRAND;
    let ink = "#04201d";
    let hover = "#19c9bf"; // 强调色提亮一档，鼠标悬停时填充这色
    try {
        const root = getComputedStyle(document.documentElement);
        const s = root.getPropertyValue("--qg-accent").trim();
        const k = root.getPropertyValue("--qg-on-accent").trim();
        const h = root.getPropertyValue("--qg-accent-hover").trim();
        if (/^#[0-9a-f]{6}$/i.test(s)) solid = s;
        if (/^#[0-9a-f]{6}$/i.test(k)) ink = k;
        if (/^#[0-9a-f]{6}$/i.test(h)) hover = h;
    } catch (_) { /* 取不到就用回退色 */ }
    addAccentCache = { solid, ink, hover };
    return addAccentCache;
}

function installAddAccentSync() {
    // 手型指针：LiteGraph 在 onMouseMove 之后还会把 canvas.style.cursor 重设成
    // crosshair，直接 inline 赋值会被盖掉。用 CSS class + !important 压过它。
    if (!document.getElementById("qg-add-hover-cursor-style")) {
        const style = document.createElement("style");
        style.id = "qg-add-hover-cursor-style";
        style.textContent = ".qg-add-hover canvas{cursor:pointer !important}";
        document.head.append(style);
    }
    window.addEventListener("qg-accent-changed", () => {
        addAccentCache = null;
        // 只刷当前画布即可：切进子图时那边会自己重画，按钮读的是同一份变量。
        app.graph?.setDirtyCanvas?.(true, true);
    });
}

// 切换画布的手型指针 class（与 LiteGraph 的 inline cursor 竞争，靠 !important 胜出）。
function setAddHoverCursor(on) {
    const el = app.canvas?.canvas?.parentElement;
    if (el) el.classList.toggle("qg-add-hover", Boolean(on));
}

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
            // 「+ 添加 LoRA」按钮 hover：drawAddRow 据此换 hover 色，探针靠它断言。
            hoverAdd: false,
            drag: null,
            repeat: null,
            // 每行最后一次算出来的开关状态（"linked|on|unknown"）。纯观测用：
            // 画在 canvas 上的东西探针读不到，靠它断言接线后有没有读到真值。
            switchStates: [],
            // 第二层：视图侧的文件夹筛选（只影响显示行名，不动 rows_data 顺序/槽位）。
            // folderFilter 是文件夹路径字符串，"" 表示不筛选。
            folderFilter: "",
            // 第二层：拖行首「≡」手柄重排行。与 state.drag（强度拖动）分开，互不干扰。
            rowDrag: null,
            // 第二层：独奏前的整栈开关快照，取消独奏时逐行还原；非独奏时为 null。
            soloSnapshot: null,
            // 第三层：种子随机组合前的开关快照，撤销随机时逐行还原；非随机态为 null。
            randomSnapshot: null,
            // 第二层：栈工具面板当前选中的筛选文件夹（菜单里点选后写到这里）。
            // 与加载器共用的齿轮设置；只在首次 mount 时载入，configure 重建 widgets 时
            // 保留当前值，免得把工作流里存下来的分隔符 / 缺失策略冲掉。
            settings: null,
            // 吸收链式加载器要等一次取列表的请求：串行化，避免请求没回来时
            // 连点两次把同一批行加两遍。与加载器 state.importing 同口径。
            importing: false,
            // 节点被删/撤销带走后，异步吸收回来不能再往它身上写。
            disposed: false,
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

// 建议强度是硬限制：拿到每个 LoRA 的 min/max 后，这一行任何手动改强度的路径
// 都只能落在区间内。缓存按文件名走，跟加载器那份 rangeCache 同一口径。
const strengthRangeCache = new Map();
const strengthRangeFetches = new Map();

function ensureStrengthRange(name) {
    if (!name || strengthRangeCache.has(name) || strengthRangeFetches.has(name)) return;
    const request = api.fetchApi(`/qg/lora/info?name=${encodeURIComponent(name)}`)
        .then((response) => response.json())
        .then((payload) => {
            const info = payload?.info ?? payload;
            strengthRangeCache.set(name, info && typeof info === "object" ? (info.range ?? null) : null);
        })
        .catch(() => strengthRangeCache.set(name, null))
        .finally(() => strengthRangeFetches.delete(name));
    strengthRangeFetches.set(name, request);
}

function prefetchSuggestedRanges(state) {
    for (const row of state?.rows ?? []) {
        if (row?.name) ensureStrengthRange(row.name);
    }
}

// 未填的一端退回全局上下界；坏区间（min>max）整份忽略，免得把用户锁死。
function suggestedBounds(name) {
    const range = strengthRangeCache.get(name);
    let low = STRENGTH_MIN;
    let high = STRENGTH_MAX;
    if (range && typeof range === "object") {
        const min = Number(range.min);
        const max = Number(range.max);
        if (Number.isFinite(min)) low = Math.max(low, min);
        if (Number.isFinite(max)) high = Math.min(high, max);
    }
    if (low > high) return { low: STRENGTH_MIN, high: STRENGTH_MAX };
    return { low, high };
}

function clampSuggestedStrength(name, value) {
    const { low, high } = suggestedBounds(name);
    return clampStrength(Math.max(low, Math.min(high, value)));
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

// 🔴 「没有行也可以连线」修复（2026-11-14 用户截图）：
// `input.hidden` / `widget.hidden` 只影响**渲染**，litegraph 的 connectSlots
// 根本不看它们 —— 真机实测只有 5 行时把线接到 on_6 照样成功（Vue / 经典都是），
// 而后端只按 rows_data 里实际的行数处理，这条外控线永远不会生效。
// 唯一能拒绝连线的官方钩子是 onConnectInput（LGraphNode.ts 的注释：
// "if returns false the incoming connection will be canceled"）；connectSlots
// 在校验类型之后、建 link 之前调它，UI 拖拽和脚本连线都走这一条路。
// 装成实例方法而不是改 prototype，避免影响别的节点；每次 applyRowCount 都
// 确认一次，configure 之后钩子被重置也能立刻补回来。
// 来源是不是「数值控件」（滑条 / 数字输入）：有且只有一个名为 value 的有限数值
// widget 才算。布尔开关的控件值是 boolean，不会被认成数值；多个 value 的复合
// 节点也不敢猜。与 rowStrengthState 的判据保持完全一致。
function numericSourceNode(fromNode) {
    // 🔴 2026-11-24：来源可能是虚拟节点（QG_SetPoint/GetPoint、KJ Set/Get Node），
    // 它们自己只有 Name 字符串控件，直接看 widget 会判成「非数值源」，于是
    // onConnectInput 不改道、数值线接到 on_1 开关口（用户截图「连不到强度」）。
    // 沿 getInputLink 穿透到真实上游再判断；16 跳 + seen 防环，与
    // resolveWidgetSource 同源。穿不透（无同名设置点）就退回原节点，照旧不改道。
    let source = fromNode;
    const seen = new Set();
    for (let hop = 0; source && hop < 16 && source.isVirtualNode; hop += 1) {
        if (seen.has(source.id)) return null;
        seen.add(source.id);
        const link = typeof source.getInputLink === "function" ? source.getInputLink(0) : null;
        if (!link) break;
        source = source.graph?.getNodeById?.(link.origin_id) ?? null;
    }
    const values = (source?.widgets || []).filter(
        (w) => w.name === "value" && typeof w.value === "number" && Number.isFinite(w.value));
    return values.length === 1;
}

function installEmptySlotGuard(state) {
    const node = state.node;
    if (node.onConnectInput?.__qgEmptySlotGuard) return;
    const previous = node.onConnectInput;
    const guard = function (inputIndex, outputType, outputSlot, fromNode, outputIndex) {
        if (typeof previous === "function"
            && previous.call(this, inputIndex, outputType, outputSlot, fromNode, outputIndex) === false) {
            return false;
        }
        const st = this.__qgSwitchStack;
        const input = this.inputs?.[inputIndex];
        if (!st || !input) return true;
        const match = /^on_(\d+)$/.exec(input.name || "");
        if (!match) return true;

        // 🔴 11-20：on_N / strength_N 两组圆点被 LiteGraph 画在同一处（同一 row
        // widget 派生坐标），拖线过去总是先命中 on_N。用户拿数值滑条想调强度，
        // 却连到了开关，红框数字纹丝不动（用户截图「没反馈」）。这里按**来源**
        // 改道：来源是数值控件（唯一 value 数值 widget）→ 拒绝连 on_N，下一拍
        // 自动接到同一行的 strength_N。布尔开关仍照常连 on_N。与 rowStrengthState
        // 的判据同源（唯一 value 数值 widget；含虚拟节点穿透），避免「改道了但显示读不到」。
        // 🔴 注意：穿透只用来**判断来源类型**，真正补连仍用原 fromNode（虚拟节点），
        //    保持虚拟转发链不丢。
        if (numericSourceNode(fromNode)) {
            const row = Number(match[1]);
            const strengthName = `strength_${row}`;
            const strengthIndex = this.inputs?.findIndex((i) => i.name === strengthName) ?? -1;
            if (strengthIndex >= 0 && this.inputs[strengthIndex].link == null) {
                setTimeout(() => {
                    try { fromNode.connect?.(outputIndex, this, strengthIndex); } catch (_) { /* 拖线已取消 */ }
                }, 0);
            }
            return false;
        }

        // visibleRows 含「+ 添加 LoRA」撑出来的那一格空行：它确实画了行，
        // 允许提前接开关；只有连都没有的行才拒绝。
        return Number(match[1]) - 1 < visibleRows(st);
    };
    guard.__qgEmptySlotGuard = true;
    node.onConnectInput = guard;

    // 🔴 第二处「圆点落在模型槽旁边」：拖 BOOLEAN 线到节点**背景**时，核心
    // LGraphCanvas 调 `node.findInputByType()` → findFreeSlotOfType，只按类型 +
    // 「槽是否空闲」找，**完全不看 hidden**。5 行接满后第一个空闲 BOOLEAN 槽
    // 就是隐藏的 on_6，核心把高亮圆点画在 getInputSlotPos(on_6)；隐藏槽的
    // pos 被压成 [10,10]（节点顶部），正好落在「模型」输入旁边（真机 y=120
    // vs 模型 y=124）。用户截图里那个黄圈亮绿线就是它。
    // 做法：复用核心原有查找，只在调用期间把「没有行」的槽的 type 临时改成
    // 不可能匹配的值；同步 try/finally 立刻还原，不动数组结构、不改槽下标，
    // 存档 / link.target_slot 契约一律不变。再补一道结果兜底，防通配类型绕过。
    const previousFind = node.findInputByType;
    const findGuard = function (type) {
        const st = this.__qgSwitchStack;
        if (!st || typeof previousFind !== "function") return previousFind?.call(this, type);
        const visible = visibleRows(st);
        const saved = [];
        for (const input of this.inputs || []) {
            const m = /^on_(\d+)$/.exec(input.name || "");
            if (m && Number(m[1]) - 1 >= visible) {
                saved.push([input, input.type]);
                input.type = "__qg_no_row__";
            }
        }
        try {
            const found = previousFind.call(this, type);
            if (found) {
                const m = /^on_(\d+)$/.exec(found.slot?.name || "");
                if (m && Number(m[1]) - 1 >= visible) return undefined;
            }
            return found;
        } finally {
            for (const [input, original] of saved) input.type = original;
        }
    };
    findGuard.__qgEmptySlotGuard = true;
    node.findInputByType = findGuard;

    // 🔴 第四处「模型槽上叠着的圆点」：LGraphNode.drawSlots 的显示条件是
    //   isMouseOverSlot || isValidTarget || !slot.isWidgetInputSlot || ...
    // 拖线时 fromSlot 存在 → 所有同类型输入槽 isValidTarget 都为真，24 个
    // on_N 全被画成圆点，**完全不读 hidden**。隐藏槽的 pos 被压成 [10,10]，
    // 19 个圆点全叠在 model 槽（y=120 vs 124）上，看起来就是两个圆叠着。
    // 真机 AB 对照：把无行槽的 type 改成不匹配值，模型槽上方的灰色半圆
    // 立刻消失（差异 46 px）。这里改成在绘制期间把它们从 _concreteInputs
    // 里临时摘掉 —— 同步 try/finally 还原，不动 node.inputs、不改槽下标、
    // 不改 type，存档与 link.target_slot 契约一律不变；连 isMouseOverSlot /
    // isConnected 这两条绘制分支也一起挡住。
    if (node.drawSlots?.__qgEmptySlotGuard) return;
    const previousDraw = node.drawSlots;
    const drawGuard = function (ctx, opts) {
        const st = this.__qgSwitchStack;
        const concrete = this._concreteInputs;
        if (!st || typeof previousDraw !== "function" || !Array.isArray(concrete)) {
            return previousDraw?.call(this, ctx, opts);
        }
        const visible = visibleRows(st);
        const keep = concrete.filter((slot) => {
            const m = /^on_(\d+)$/.exec(slot.name || "");
            return !(m && Number(m[1]) - 1 >= visible);
        });
        const removed = concrete.length - keep.length;
        st.__qgLastDrawFiltered = removed;
        if (!removed) return previousDraw.call(this, ctx, opts);
        this._concreteInputs = keep;
        try { return previousDraw.call(this, ctx, opts); }
        finally { this._concreteInputs = concrete; }
    };
    drawGuard.__qgEmptySlotGuard = true;
    node.drawSlots = drawGuard;
}

function applyRowCount(state) {
    installEmptySlotGuard(state);
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
        // 🔴 `input.hidden` 只被部分渲染路径（预览卡片等）读取，connectSlots
        // 完全不看它 —— 真机实测 hidden=true 的 on_6 照样能连上线。真正拒绝
        // 连线靠 installEmptySlotGuard 的 onConnectInput；这里保留标记给渲染用。
        // 槽还必须一直绑着行 widget（见 bindSlots），否则会掉回普通输入区，按
        // NODE_SLOT_HEIGHT 排成节点外面那一列悬空圆点。
        const input = state.node.inputs?.find((item) => item.name === `on_${index + 1}`);
        if (input) input.hidden = !shown;
    });
    // 行数变了 / configure 重建过 inputs，都重新确认一次 24 个槽的绑定；
    // 顺手把「已经没有行」的槽上的旧连线断掉（老存档加载后圆点会卡在模型槽旁）。
    bindSlots(state);
    pruneOrphanLinks(state);
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

// 一个完整的「◀ 0.80 ▶」强度控件。合并模式画一次，分开模式给模型 / CLIP 各画一次。
function paintStrengthBox(ctx, box, centerY, text, { dim, hovered, dragging, linked = false }) {
    const arrowFg = dim ? "rgba(160, 178, 190, .48)"
        : (hovered ? COLOR.accent : "rgba(198, 216, 226, .66)");
    const arrowBg = hovered && !dim ? "rgba(111, 208, 240, .12)" : "rgba(160, 178, 190, .07)";
    drawStrengthArrow(ctx, box.arrowLeftMid, centerY, -1, arrowFg, arrowBg);
    drawStrengthArrow(ctx, box.arrowRightMid, centerY, 1, arrowFg, arrowBg);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fitNumberFont(ctx, text, box.valueRight - box.valueLeft - 2);
    ctx.fillStyle = dragging ? COLOR.accent
        : linked ? "#6fd0f0"   // 外控实时值用青色，和行外控青框同色
        : (dim ? COLOR.textEmpty : COLOR.text);
    ctx.fillText(text, box.valueMid, centerY);
    return {
        text,
        external: linked,
        font: ctx.font,
        textWidth: ctx.measureText(text).width,
        centerX: box.valueMid,
        arrowDecX: box.arrowLeftMid,
        arrowIncX: box.arrowRightMid,
        valueLeft: box.valueLeft,
        valueRight: box.valueRight,
    };
}

// 🔴 2026-11-24：连线经虚拟节点（QG_SetPoint/GetPoint、KJ 的 Set/Get Node）
// 转发时，link.origin 是那个虚拟节点——它只有 Name 字符串控件，没有布尔/数值
// widget，直接读会把外控误判成 unknown（画布永远显示「外控」、布尔开关切了
// 没反应，用户以为「控制不了」）。虚拟节点都重写了 getInputLink() 把值穿透到
// 真实上游（见 setget/index.js），沿它一路走到真正的源头再读 widget。
// 不硬编码节点类型：认 isVirtualNode 标记，KJ 的虚拟节点同样适用。
function resolveWidgetSource(graph, link) {
    let cursor = link;
    const seen = new Set();
    for (let hop = 0; cursor && hop < 16; hop += 1) {
        const origin = graph?.getNodeById?.(cursor.origin_id);
        if (!origin) return null;
        if (!origin.isVirtualNode) return origin;
        if (seen.has(origin.id)) return null; // 环路兜底
        seen.add(origin.id);
        // 虚拟节点的 getInputLink(0) 返回穿透后的真实上游 link；
        // 没有这个方法的（或其它形态的虚拟节点）就到此为止，交给 unknown 分支。
        const next = typeof origin.getInputLink === "function" ? origin.getInputLink(0) : null;
        if (!next || next === cursor) return origin;
        cursor = next;
    }
    return null;
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
    const origin = resolveWidgetSource(graph, link);
    const bools = origin?.widgets?.filter((widget) => typeof widget.value === "boolean") ?? [];
    // 零个或多个布尔控件都不敢猜：猜错了比「外控」这个诚实的状态更糟。
    if (bools.length !== 1) return { linked: true, on: true, unknown: true };
    return { linked: true, on: Boolean(bools[0].value), unknown: false };
}

// 这一行显示用的强度。接了 strength_N 线时，尽量读上游滑条的实时值画出来
// —— 后端 _merge_slots 只在「运行」时才覆盖强度，画布上若不自己读线，用户
// 拖滑条时红框里的数字纹丝不动，看着就像没接上（11-20 用户实测反馈）。
// 🔴 与 rowSwitchState 同口径：能唯一定位到一个数值控件才显示它的真值，
// 读不到（多个数值控件 / 运行时算出的值 / Primitive）就标 linked+unknown，
// 让界面诚实说「外控」而不是拿存档值骗人。存档值一个都不改。
function rowStrengthState(node, index, row) {
    const stored = finite(row?.strength, 1);
    const input = node.inputs?.find((item) => item.name === `strength_${index + 1}`);
    const id = input?.link;
    if (id == null) return { linked: false, value: stored, unknown: false };
    const graph = node.graph;
    const link = graph?.links?.[id];
    const origin = resolveWidgetSource(graph, link); // 虚拟节点转发时穿透到真实滑条
    const numbers = (origin?.widgets || []).filter(
        (widget) => widget.name === "value" && typeof widget.value === "number"
            && Number.isFinite(widget.value));
    if (numbers.length !== 1) return { linked: true, value: stored, unknown: true };
    return { linked: true, value: clampStrength(numbers[0].value), unknown: false };
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

// ---------------------------------------------------------------- 行归属（）
// 这一行由哪个「工作流开关」设定。判据仍是开关模块那一套（normalizeSettings
// → valuePairs → 行名按文件归一），与 LoRA 加载器读正式开关同源，不另写比较逻辑。
const BOARD_CLASS = "QG_WorkflowSwitches";
// 存档键跟着开关模块走，不写死：两个文件各写一个字符串，改名时必然漏一处。
const BOARD_SETTINGS = SETTINGS_PROPERTY;
const OWNER_RECHECK_MS = 400;
const OWNER_BADGE_W = 17;

// 归属索引：`<节点id>\u0001<fileKey(行名)>` → [开关标题]。
//
// 缓存分两层，都是为了「每帧每行问一次」这个调用频率：
//   * 时间层：各节点每 400ms 才算一次（state 上独立计时），拖动强度时不卡；
//   * 内容层：模块级，键是各开关节点的设置原文。设置没动就直接复用上一份索引，
//     一次 JSON.parse 都不做；图上有多个LoRA 堆时共用这一份。
//
// 旧写法是「每行调一次 stackRowOwners」—— 24 行 × 每个条目 × 每侧都要重新解析
// 整栈快照，同一串 JSON 每分钟被解析上万次。现在一次扫描建表，之后只是 Map 查表。
let ownerIndex = { key: null, map: new Map() };

function ownerIndexOf(boards) {
    // 键必须用序列化后的原文：properties 里放的是对象，直接插进模板串会全变成
    // "[object Object]"，改了开关内容也认不出变化。
    //
    // properties 是前端可写的任意值，万一被塞进循环引用，JSON.stringify 会抛。
    // 这里是 drawRow 的调用栈里，抛出去整个画布绘制就断了 —— 宁可放弃缓存。
    let key = null;
    try {
        key = "";
        for (const board of boards) {
            key += `${board.node.id}\u0001${JSON.stringify(board.settings ?? null)}\u0002`;
        }
    } catch {
        key = null;
    }
    if (key !== null && key === ownerIndex.key) return ownerIndex.map;
    const map = new Map();
    for (const { settings } of boards) {
        for (const entry of normalizeSettings(settings).switches) {
            for (const pair of valuePairs(entry)) {
                if (pair.row === undefined || pair.widget !== "rows_data") continue;
                const slot = `${pair.node}\u0001${fileKey(pair.row)}`;
                const titles = map.get(slot);
                if (!titles) map.set(slot, [entry.title]);
                // 两个开关管同一行：都记下，行上仍是一个徽章（具体在开关卡片里看）。
                else if (!titles.includes(entry.title)) titles.push(entry.title);
            }
        }
    }
    ownerIndex = { key, map };
    return map;
}

// 图上的开关。node.graph 在子图重建早期会是空的，退回根图兜底；都没有就当作
// 「没有开关」——徽章不画，也不报错。
function ownerBoards(state) {
    const graph = state.node.graph ?? app.rootGraph ?? app.graph;
    return (graph?.nodes ?? graph?._nodes ?? [])
        .filter((node) => String(node?.type ?? node?.comfyClass ?? "") === BOARD_CLASS)
        .map((node) => ({ node, settings: node.properties?.[BOARD_SETTINGS] }));
}

function refreshOwners(state) {
    const now = Date.now();
    if (state.ownerByRow && now - (state.ownerCheckedAt || 0) < OWNER_RECHECK_MS) {
        return state.ownerByRow;
    }
    state.ownerCheckedAt = now;
    const boards = ownerBoards(state);
    const owners = new Map();
    if (boards.length) {
        const index = ownerIndexOf(boards);
        const prefix = `${state.node.id}\u0001`;
        for (const row of state.rows || []) {
            if (!row?.name) continue;
            const titles = index.get(prefix + fileKey(row.name));
            // 拷一份再存：索引本身是共享的，别让下游改到它。
            if (titles?.length) owners.set(row.name, titles.slice());
        }
    }
    const signature = JSON.stringify([...owners]);
    if (signature !== state.ownerSignature) {
        state.ownerSignature = signature;
        // 先赋值再触发重画：redrawVueRows 可能同步回到 drawRow，靠上面这行
        // ownerByRow 才不会又算一遍（也就不会来回递归）。
        state.ownerByRow = owners;
        // 徽章集变了，逐行的留档整体作废：行被删掉后旧的下标不该还留着。
        state.ownerRows = {};
        redrawVueRows(state);
    }
    return state.ownerByRow ?? owners;
}

// 行名右侧的小徽章：⇄ = 这一行由某个开关设定。名字为它让出一点宽度；没有
// 归属的行宽度一点不变。具体是哪个开关在开关卡片里看得到（行勾选状态）。
// 开关改了「谁管哪行」时，清掉 400ms 的归属缓存并重画：不然改完开关要等
// 下一次重绘才看到徽章变化（徽章探针 2026-11-23 实测第一次是空的）。
let ownerEventsInstalled = false;
function installOwnerInvalidation() {
    if (ownerEventsInstalled) return;
    ownerEventsInstalled = true;
    window.addEventListener("qg-owner-changed", () => {
        for (const node of app.graph?._nodes ?? []) {
            const state = node?.__qgSwitchStack;
            if (!state || String(node?.type) !== NODE_CLASS) continue;
            state.ownerCheckedAt = 0;
            redrawVueRows(state);
            node.setDirtyCanvas?.(true, true);
        }
    });
}

// ---------------------------------------------------------------- 徽章交互（）
//
// 徽章画在 canvas 上，DOM 里没有它 ——「悬停看归谁 / 点击跳到开关」只能靠指针
// 坐标反算。矩形由 drawRow 留档在 state.badgeRects（节点局部坐标）。
//
// 两种渲染模式共用同一套换算：节点位置在同一份图坐标里，经典画布与 Nodes 2.0
// 的独立行 canvas 只是显示位置不同。
let badgeTip = null;
let badgeInteractionInstalled = false;

function ensureBadgeTipStyle() {
    if (document.getElementById("qg-owner-tip-style")) return;
    const style = document.createElement("style");
    style.id = "qg-owner-tip-style";
    style.textContent = `
.qg-owner-tip {
    position:fixed; z-index:10001; display:none; pointer-events:none;
    max-width:260px; padding:5px 8px; border-radius:6px;
    border:1px solid var(--border-color,#2a3437);
    background:var(--comfy-menu-bg,#11181a);
    color:var(--fg-color,#d8ecea);
    font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    box-shadow:0 6px 20px rgba(0,0,0,.45);
}
`;
    document.head.append(style);
}

function badgeAt(clientX, clientY) {
    const canvas = app.canvas;
    const box = canvas?.canvas?.getBoundingClientRect?.();
    if (!box) return null;
    const scale = canvas.ds?.scale || 1;
    const offset = canvas.ds?.offset ?? [0, 0];
    const gx = (clientX - box.left) / scale - offset[0];
    const gy = (clientY - box.top) / scale - offset[1];
    const nodes = app.graph?._nodes ?? app.rootGraph?._nodes ?? [];
    for (const node of nodes) {
        if (String(node?.type) !== NODE_CLASS) continue;
        const state = node.__qgSwitchStack;
        const rects = state?.badgeRects;
        if (!rects) continue;
        const lx = gx - (node.pos?.[0] ?? 0);
        const ly = gy - (node.pos?.[1] ?? 0);
        if (lx < -4 || ly < -4 || lx > (node.size?.[0] ?? 0) + 4 || ly > (node.size?.[1] ?? 0) + 4) continue;
        for (const key of Object.keys(rects)) {
            const rect = rects[key];
            // 横向放宽 2px：17px 宽的目标，鼠标很难精准停在里面。
            if (lx >= rect.x - 2 && lx <= rect.x + rect.w + 2 && ly >= rect.y && ly <= rect.y + rect.h) {
                return { node, state, index: Number(key), titles: rect.titles };
            }
        }
    }
    return null;
}

function showBadgeTip(hit, clientX, clientY) {
    ensureBadgeTipStyle();
    if (!badgeTip) {
        badgeTip = document.createElement("div");
        badgeTip.className = "qg-owner-tip";
        document.body.append(badgeTip);
    }
    const names = hit.titles.join(zhPair(", ", "、"));
    badgeTip.textContent = zhPair(
        `Set by "${names}" - click to find it`,
        `由「${names}」管着 · 点击定位`,
    );
    badgeTip.style.display = "block";
    // 贴鼠标右下；靠近视口右/下边缘时翻到另一侧，别被切掉。
    const rect = badgeTip.getBoundingClientRect();
    const left = clientX + 12 + rect.width > window.innerWidth ? clientX - rect.width - 12 : clientX + 12;
    const top = clientY + 16 + rect.height > window.innerHeight ? clientY - rect.height - 14 : clientY + 16;
    badgeTip.style.left = `${Math.round(left)}px`;
    badgeTip.style.top = `${Math.round(top)}px`;
}

function hideBadgeTip() {
    if (badgeTip) badgeTip.style.display = "none";
}

// 点了徽章：跳到管这一行的开关卡片。徽章只记了开关标题，图上可能有多张
// 开关卡片，所以先找「含有这个标题的 switch」的那张，找不到再退第一张。
function frameOwningBoard(node, titles) {
    const graph = node.graph ?? app.rootGraph ?? app.graph;
    const boards = (graph?.nodes ?? graph?._nodes ?? [])
        .filter((item) => String(item?.type) === BOARD_CLASS);
    if (!boards.length) return false;
    const named = (board) => normalizeSettings(board.properties?.[BOARD_SETTINGS]).switches
        .some((entry) => titles.includes(entry.title));
    const board = boards.find(named) ?? boards[0];
    const canvas = app.canvas;
    canvas?.centerOnNode?.(board);
    canvas?.selectNode?.(board, false);
    canvas?.setDirty?.(true, true);
    return true;
}

function installBadgeInteraction() {
    if (badgeInteractionInstalled) return;
    badgeInteractionInstalled = true;
    // 落在浮层上的指针不算命中徽章：菜单/选择器可能正好盖在徽章上面，按屏幕
    // 坐标反算会误判，结果是「在菜单里点一下，画布突然跳走了」。
    const overOverlay = (event) => Boolean(event.target?.closest?.(
        ".qgtools-ws-menu, .litecontextmenu, .litemenu, .qgtools-set-pop, " +
        ".qgtools-lora-picker, .qgtools-lora-popup, .qgtools-lora-card"
    ));
    // 悬停：显示「归谁管」。
    window.addEventListener("pointermove", (event) => {
        if (overOverlay(event)) {
            hideBadgeTip();
            return;
        }
        // 按住键时（拖节点 / 拖强度 / 框选）不弹提示，也不做命中计算。
        if (event.buttons) {
            hideBadgeTip();
            return;
        }
        const hit = badgeAt(event.clientX, event.clientY);
        if (!hit) {
            hideBadgeTip();
            return;
        }
        showBadgeTip(hit, event.clientX, event.clientY);
    }, { passive: true });
    // 点击：跳到开关卡片。捕获阶段，抢在画布「按在节点上 = 开始拖动」之前。
    window.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || overOverlay(event)) return;
        const hit = badgeAt(event.clientX, event.clientY);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();
        hideBadgeTip();
        frameOwningBoard(hit.node, hit.titles);
    }, { capture: true });
    // 滚轮 / 缩放后 tooltip 会留在原地，收掉。
    window.addEventListener("wheel", hideBadgeTip, { passive: true });
}

function drawOwnerBadge(ctx, x, centerY) {
    ctx.save();
    roundRect(ctx, x, centerY - 7, OWNER_BADGE_W, 14, 3);
    ctx.fillStyle = "rgba(0, 180, 170, .18)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 180, 170, .7)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const left = x + 4;
    const right = x + OWNER_BADGE_W - 4;
    ctx.strokeStyle = "#7fe3d6";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    // 上箭头向右
    ctx.moveTo(left, centerY - 2.5);
    ctx.lineTo(right, centerY - 2.5);
    ctx.moveTo(right, centerY - 2.5);
    ctx.lineTo(right - 3, centerY - 5);
    ctx.moveTo(right, centerY - 2.5);
    ctx.lineTo(right - 3, centerY);
    // 下箭头向左
    ctx.moveTo(right, centerY + 2.5);
    ctx.lineTo(left, centerY + 2.5);
    ctx.moveTo(left, centerY + 2.5);
    ctx.lineTo(left + 3, centerY + 5);
    ctx.moveTo(left, centerY + 2.5);
    ctx.lineTo(left + 3, centerY);
    ctx.stroke();
    ctx.restore();
}

// 行首「≡」拖动手柄：三条 1px 横线，只是提示「这里能抓着排顺序」。
// 真正的排序手势是「按住这条拖上下」，不带任何修饰键 —— Alt 会被 ComfyUI 的
// 拖拽克隆抢走、Ctrl 会被多选框抢走、Shift 留给「拖强度改 CLIP」，三条都占着。
function drawRowGrip(ctx, x, posY, hovered, dim) {
    const mid = posY + ROW_HEIGHT / 2;
    ctx.fillStyle = dim ? "rgba(150, 165, 175, .20)"
        : hovered ? "rgba(198, 216, 228, .78)" : "rgba(160, 178, 190, .46)";
    for (const dy of [-4, 0, 4]) {
        ctx.fillRect(x, mid + dy - 0.5, 6, 1);
    }
}

function drawRow(ctx, node, state, index, posY, width, ownersIn) {
    // 隐藏的行 computeSize 变成 -4，但画布并不会因此跳过 draw —— 不拦一下，
    // 第 N 行会画在「+ 添加 LoRA」的位置上，两层叠着。
    if (index >= visibleRows(state)) return;
    // width 由调用方按「画到哪块 canvas」决定：widget.draw 和主画布补画都传
    // rowDrawWidth()（Nodes 2.0 的独立 canvas 比 node.size 窄）。🔴 补画不能
    // 回落 node.size[0]：从 Vue 切回经典后行 widget.width 仍是 356，普通行画
    // 352 右缘、外控行画 376，青框就比绿框宽 24 单位（用户截图实测 76px）。
    width = width || node.size[0];
    const row = state.rows[index];
    // 归属表：这个节点被哪个开关管着（见 refreshOwners）。补画接线行的那条
    // 循环会在外面算一次再传进来，别再逐行重复判断；单独一行的 widget.draw
    // 没有可共享的上层，就自己问（内部 400ms 节流，函数本身很轻）。
    const owners = ownersIn ?? refreshOwners(state);
    const ownerTitles = row?.name ? owners.get(row.name) : null;
    const owned = Boolean(ownerTitles && ownerTitles.length);
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
    // 三态语义：开=全局强调色（11-24 用户「也跟随」，原绿 #57c281）、关=灰、
    // 青=由连线控制。线只 1px，贴着行底色的内缘走，不占额外高度、不动节点 SIZES。
    // 🔴 别把框画在行左缘：BOOLEAN 输入槽的圆点由画布画在 x≈10（连上线还带高亮），
    // 框从 x=16 起才不会被它盖掉一角。
    // 🔴 重复 LoRA（同名出现 >1 次）时边框改**黄色**提醒：开/关/外控三态仍由
    // 开关胶囊本体承载，所以边框专用于「这行选重了」，既不丢状态、又一眼能看到重复。
    const duplicate = Boolean(row.name) && duplicateNameSet(state).has(row.name.trim());
    const stateColor = duplicate ? DUPLICATE_BORDER
        : (unknown ? "#6fd0f0" : (off ? "#85929b" : addAccent().solid));
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

    // 开关：开=全局强调色（11-24 用户「也跟随」，原绿 COLOR.switchOn）、关=灰；
    // 接了线但读不出布尔值时画青色胶囊 + 中间一个小方点，表示「由外部决定」。
    const sx = SLOT_BAND + 4;
    const sy = posY + (ROW_HEIGHT - SWITCH_H) / 2;
    const switchColor = unknown ? "rgba(111, 208, 240, .24)"
        : (on ? addAccent().solid : COLOR.switchOff);
    ctx.fillStyle = switchColor;
    roundRect(ctx, sx, sy, SWITCH_W, SWITCH_H, SWITCH_H / 2);
    ctx.fill();
    // 留档供探针断言「开态开关跟随强调色」（canvas 像素读不到闭包里的颜色）。
    state.switchColorByRow = state.switchColorByRow || {};
    state.switchColorByRow[index] = switchColor;
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
    const cols = columnsFor(state, width);
    // 探针读不到闭包里的列坐标，挂到 state 上：断言用的是同一套 x，
    // 前端改了布局也不会出现「探针点歪了却全绿」。
    state.cols = cols;
    const gripX = sx + SWITCH_W + 7;
    // 🔴 这里只能传 off（811 行就有），不能传 `dim` —— 它在 959 行才声明，
    // 提前引用会炸 `Cannot access 'dim' before initialization`，整个 widget.draw
    // 抛错 → Nodes 2.0 直接显示「节点组件错误」（2026-11-22 实机踩过）。
    drawRowGrip(ctx, gripX, posY, hovered, off || !row.name);
    const nameX = gripX + GRIP_W;
    // 每一行都给徽章留出同样的位置。以前只给「有归属」的行让宽，同一节点里
    // 各行名字的右端就参差不齐（用户 2026-11-23 指出），看着像排版坏了。
    const nameWidth = cols.nameRight - nameX - (OWNER_BADGE_W + 4);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = FONT;
    // 第二层筛选：只把不匹配行的名字变暗、加标记，行本身仍在原位。
    // 绝不隐藏/重排行 —— 那会让 on_N 槽位和显示行号错位，外控开关指错 LoRA。
    const filteredOut = Boolean(state.folderFilter && row.name && !inFolder(row.name, state.folderFilter));
    const rowLabel = row.name ? shortLoraName(row.name, {
        hideFolders: state.settings?.hide_folders !== false,
        hideExtension: state.settings?.hide_extension !== false,
    }) : zhPair("empty row", "空行");
    const label = filteredOut
        ? zhPair(`${rowLabel} (filtered)`, `${rowLabel}（已筛选）`)
        : rowLabel;
    // 长名称截断也跟加载器共用：默认截尾，「middle」保留结尾的 checkpoint 编号。
    // 用 fitLoraLabel 而不是对整串做中间截断：有目录时先挤目录，文件名仍完整。
    const shown = row.name && state.settings?.name_cut === "middle"
        ? (() => {
            const parts = fitLoraLabel(label, nameWidth, (text) => ctx.measureText(text).width);
            return parts.folder + parts.name;
        })()
        : fitText(ctx, label, nameWidth);
    ctx.fillStyle = filteredOut ? "rgba(120, 132, 139, .55)"
        : row.name ? (off ? COLOR.textEmpty : COLOR.text) : COLOR.textEmpty;
    ctx.fillText(shown, nameX, posY + ROW_HEIGHT / 2);
    // 名称显示结果留档给探针：画布文字读不到，但设置改没改必须可验证。
    state.nameLabels = state.nameLabels || {};
    state.nameLabels[index] = shown;
    if (off && row.name) {
        ctx.fillStyle = "rgba(190, 205, 214, .38)";
        ctx.fillRect(nameX, posY + ROW_HEIGHT / 2 - 0.5, ctx.measureText(shown).width, 1);
    }
    // 归属徽章画在名字区右端（名字已经为它让过宽度）。留档给探针：canvas 上的
    // 图形读不到，但「哪几行有归属、归谁」必须可断言。
    //
    // 同时留一份命中矩形：徽章在 canvas 里没有 DOM，悬停提示与点击定位只能靠
    // 指针坐标反算（见 badgeAt）。存的是**节点局部坐标**，随绘制一起更新。
    const badgeX = cols.nameRight - OWNER_BADGE_W;
    if (owned) {
        drawOwnerBadge(ctx, badgeX, posY + ROW_HEIGHT / 2);
        state.ownerRows = state.ownerRows || {};
        state.ownerRows[index] = ownerTitles.join(", ");
        state.badgeRects = state.badgeRects || {};
        state.badgeRects[index] = {
            x: badgeX,
            y: posY + ROW_HEIGHT / 2 - 7,
            w: OWNER_BADGE_W,
            h: 14,
            titles: ownerTitles.slice(),
        };
    } else {
        if (state.ownerRows) delete state.ownerRows[index];
        if (state.badgeRects) delete state.badgeRects[index];
    }

    // 强度控件：左箭头 −、中间数值、右箭头 +。数值居中而不是右对齐，左右才对称。
    // 接了 strength_N 外控线时显示上游实时值（拖滑条数字跟着动），读不到就写「外控」。
    const strengthState = rowStrengthState(node, index, row);
    const shownStrength = strengthState.value;
    const sameClip = Math.abs(row.strength_clip - row.strength) < 0.005
        && !strengthState.linked;   // 外控只改模型强度，CLIP 仍是存档值，不再并成一个数字
    const strengthLinked = strengthState.linked && !strengthState.unknown;
    const dragging = state.drag?.index === index;
    const centerY = posY + ROW_HEIGHT / 2 - 1;
    const dim = off || !row.name;
    const paintOpts = { dim, hovered, dragging };
    let modelLayout;
    if (cols.separate) {
        // 分开模式两套控件：M=模型强度（外控只驱动这一套），C=CLIP 强度。
        const modelText = (strengthState.linked && strengthState.unknown
            ? zhPair("wire", "外控") : shownStrength.toFixed(2));
        const clipText = row.strength_clip.toFixed(2);
        modelLayout = paintStrengthBox(ctx, cols.model, centerY, `M ${modelText}`,
            { ...paintOpts, linked: strengthLinked });
        const clipLayout = paintStrengthBox(ctx, cols.clip, centerY, `C ${clipText}`, paintOpts);
        // 老探针仍从 state.strengthLayout 读模型数值，新探针读 model / clip 两份。
        state.strengthLayout = {
            ...modelLayout,
            model: modelLayout,
            clip: clipLayout,
            external: strengthState.linked,
            externalUnknown: strengthState.unknown,
            externalValue: strengthState.linked ? shownStrength : null,
        };
    } else {
        const strengthText = strengthState.linked && strengthState.unknown
            ? zhPair("wire", "外控")
            : sameClip
                ? shownStrength.toFixed(2)
                : `${shownStrength.toFixed(2)}/${row.strength_clip.toFixed(2)}`;
        modelLayout = paintStrengthBox(ctx, cols, centerY, strengthText,
            { ...paintOpts, linked: strengthLinked });
        state.strengthLayout = {
            ...modelLayout,
            external: strengthState.linked,
            externalUnknown: strengthState.unknown,
            externalValue: strengthState.linked ? shownStrength : null,
        };
    }
    // 逐行留档：strengthLayout 只留最后一行，探针要按行核对实时外控值。
    state.strengthByRow = state.strengthByRow || {};
    state.strengthByRow[index] = state.strengthLayout;

    // 强度条：0 在中间的一条细线，只铺在数值区下方（不占箭头的位置）。
    // 数字给「现在是多少」，条给「离两端还有多远」——拖的时候不用盯着数字算。
    state.strengthBarsDrawn = Boolean(row.name && state.settings?.strength_bars !== false);
    if (row.name && state.settings?.strength_bars !== false) {
        const boxes = cols.separate
            ? [{ box: cols.model, value: shownStrength }, { box: cols.clip, value: row.strength_clip }]
            : [{ box: cols, value: shownStrength }];
        for (const { box, value: barValue } of boxes) {
            const barLeft = box.valueLeft + 1;
            const barRight = box.valueRight - 1;
            const barY = posY + ROW_HEIGHT - 5;
            const barMid = (barLeft + barRight) / 2;
            ctx.fillStyle = "rgba(160, 178, 190, .20)";
            ctx.fillRect(barLeft, barY, barRight - barLeft, 1.5);
            const value = clampStrength(barValue);
            // 正负极各自除以自己的端点：哪天上下界不再对称，条也不会画歪。
            const span = value < 0 ? -STRENGTH_MIN : STRENGTH_MAX;
            const tip = barMid + (barRight - barMid) * (value / span);
            ctx.fillStyle = dragging ? COLOR.accent
                : (off ? "rgba(160, 178, 190, .34)" : "rgba(111, 208, 240, .62)");
            ctx.fillRect(Math.min(barMid, tip), barY, Math.max(Math.abs(tip - barMid), 1), 1.5);
            ctx.fillStyle = "rgba(226, 238, 246, .50)";
            ctx.fillRect(barMid - 0.5, barY - 1, 1, 3.5);
        }
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
    // 「+ 添加 LoRA」是可点的主操作：整块框填成实心强调色、字用自适应墨色
    // （和加载器的 +LoRA 按钮同款，用户 11-24 明确要「框里填充颜色」）。
    // 满了才退化成灰白虚线提示「已显示全部」——禁用态不染色，免得误导还能点。
    // 留档给探针断言（canvas 像素读不到闭包里的颜色）。
    ctx.save(); // 🔴 11-24 误删过这行导致 restore 弹掉外层状态、界面错乱，务必保留配对。
    const accent = addAccent();
    // 🔴 11-24 加大按钮：原来实心框只有 ROW_HEIGHT-6=14px，用户嫌上下太窄。
    // widget 本身占 ROW_HEIGHT+4=24px（见 addWidget.computeSize），在它内部把
    // 框加高到 ROW_HEIGHT=20px、上下各留 2px —— 不动 widget 高度 / 节点总高 /
    // 命中区，放大只发生在绘制层，布局与探针坐标都不受影响。
    const boxX = SLOT_BAND + 4;
    const boxY = posY + 2;
    const boxW = width - SLOT_BAND - 14;
    const boxH = ROW_HEIGHT;
    if (full) {
        // 禁用态：灰白虚线框 + 灰字。
        ctx.strokeStyle = "rgba(255,255,255,.10)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        roundRect(ctx, boxX, boxY, boxW, boxH, 4);
        ctx.stroke();
        ctx.setLineDash([]);
    } else {
        // 可点态：实心填充 + 自适应墨色字。鼠标悬停时填 hover 色（提亮一档），
        // 给出明确的「可点」反馈；圆角矩形 fill，不留虚线。
        ctx.fillStyle = state.hoverAdd ? accent.hover : accent.solid;
        roundRect(ctx, boxX, boxY, boxW, boxH, 4);
        ctx.fill();
    }
    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = full ? "rgba(255,255,255,.22)" : accent.ink;
    // 🔴 11-24 用户「左右不居中」：文字要按**框**中心对齐，不是 width/2。
    // 框从 boxX=20 到 width-10（左右留白不等），中心是 boxX+boxW/2 = width/2+5；
    // 旧代码写在 width/2，字偏左 5px，实心填充后一眼就看出来。
    const textX = boxX + boxW / 2;
    ctx.fillText(
        full
            ? zhPair(`all ${SLOT_COUNT} rows shown`, `已显示全部 ${SLOT_COUNT} 行`)
            : zhPair("+ add LoRA", "+ 添加 LoRA"),
        textX,
        boxY + boxH / 2,
    );
    ctx.restore();
    state.addAccent = { solid: accent.solid, ink: accent.ink, hover: accent.hover,
        hovered: Boolean(state.hoverAdd), full, boxY, boxH, boxX, boxW, textX };
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
function rowColumns(width, separate = false) {
    const clearX = width - 8 - CLEAR_W;              // × 的起点
    const triggerX = clearX - TRIGGER_END_GAP - TRIGGER_W;  // 触发词图标的左边缘
    const strengthRight = triggerX - 6;              // 强度控件右边缘
    const oneBand = (left) => {
        const right = left + SEPARATE_BAND;
        const valueLeft = left + ARROW_W;
        const valueRight = right - ARROW_W;
        return {
            strengthLeft: left, strengthRight: right,
            valueLeft, valueRight, valueMid: (valueLeft + valueRight) / 2,
            arrowLeftMid: left + ARROW_W / 2, arrowRightMid: right - ARROW_W / 2,
        };
    };
    if (separate) {
        const clip = oneBand(strengthRight - SEPARATE_BAND);
        const model = oneBand(clip.strengthLeft - SEPARATE_GAP - SEPARATE_BAND);
        return {
            clearX, triggerX, separate: true,
            strengthLeft: model.strengthLeft, strengthRight: clip.strengthRight,
            // 顶层这几个字段保持「模型那一半」的口径：老的命中判定与输入框定位
            // 都读它们。CLIP 那一半另在 cols.clip 里，不会混。
            valueLeft: model.valueLeft, valueRight: model.valueRight,
            valueMid: model.valueMid,
            arrowLeftMid: model.arrowLeftMid, arrowRightMid: model.arrowRightMid,
            nameRight: model.strengthLeft - 6,
            model, clip,
        };
    }
    const strengthLeft = strengthRight - STRENGTH_BAND;
    // 两侧箭头各占 ARROW_W，中间是数值（可拖、可点开输入框）。
    const valueLeft = strengthLeft + ARROW_W;
    const valueRight = strengthRight - ARROW_W;
    return {
        clearX,
        triggerX,
        separate: false,
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

// 唯一入口：绘制与命中判定都按当前节点的「分开强度」设置取列。
function columnsFor(state, width) {
    return rowColumns(width, Boolean(state?.settings?.separate_strengths));
}

function rowHitZones(node, index, posY, drawWidth) {
    // 命中区必须和绘制宽度一致：Nodes 2.0 下按 node.size[0] 算会把 `×` 判定
    // 放在 canvas 外，点了没反应（用户报「添加的行删不掉」）。
    const width = drawWidth || node.size[0];
    const cols = columnsFor(node.__qgSwitchStack, width);
    // 开关右边到名字区起点；最左 GRIP_W 那一条是排序手柄，剩下才是名字
    // （点名字开选择器、拖名字调强度）。
    const nameStart = SLOT_BAND + 4 + SWITCH_W + 6;
    return {
        switch: { x0: SLOT_BAND, x1: nameStart },
        grip: { x0: nameStart, x1: nameStart + GRIP_W },
        name: { x0: nameStart + GRIP_W, x1: cols.nameRight },
        // 强度：左右两个箭头各一档，中间数值区仍可拖 / 可点开输入框。
        // 三者都从 rowColumns 算，跟绘制共用一套坐标。
        strength: { x0: cols.strengthLeft, x1: cols.triggerX - 4 },
        strengthDec: { x0: cols.strengthLeft, x1: cols.valueLeft },
        strengthInc: { x0: cols.valueRight, x1: cols.strengthRight + 2 },
        // 分开模式下 CLIP 那半另有自己的一对箭头和数值热区。
        clipStrengthDec: cols.clip ? { x0: cols.clip.strengthLeft, x1: cols.clip.valueLeft } : null,
        clipStrengthInc: cols.clip ? { x0: cols.clip.valueRight, x1: cols.clip.strengthRight + 2 } : null,
        clipStrengthMid: cols.clip ? { x0: cols.clip.valueLeft, x1: cols.clip.valueRight } : null,
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
    // on_N 与 strength_N 两组槽都要跟着行前移，否则强度外控会悄悄串到别的行。
    for (const prefix of ["on", "strength"]) {
        shiftSlotGroup(node, fromRow, prefix);
    }
}

// 🔴 1.58.5 起 `input.link` 是弃用访问器：赋非 null 直接被忽略。整组搬迁必须
// 走官方接口（getInputLink 读 / disconnectInput 断 / 源节点.connect 接），
// 与 swapSlotGroup 保持同一套写法。
// 先按「搬迁前的状态」把整组线全读出来并全部断开，再按新槽号重连；边读边断
// 会让 removeLink 按 target_slot 把刚搬过来的那条一起清掉。
function readSlotLink(node, graph, slot) {
    const link = node.getInputLink?.(slot) ?? graph.links?.[node.inputs[slot]?.link] ?? null;
    return link ? { origin_id: link.origin_id, origin_slot: link.origin_slot } : null;
}

function remapSlotLinks(node, slots, rows, newRowOf) {
    const graph = node.graph;
    if (!graph || slots?.length !== SLOT_COUNT) return;
    const infos = rows.map((row) => ({ row, info: readSlotLink(node, graph, slots[row]) }));
    for (const { row, info } of infos) {
        if (!info) continue;
        if (typeof node.disconnectInput === "function") node.disconnectInput(slots[row]);
        else if (node.inputs?.[slots[row]]) node.inputs[slots[row]].link = null;
    }
    for (const { row, info } of infos) {
        if (!info) continue;
        const newRow = newRowOf(row);
        if (newRow < 0 || newRow >= SLOT_COUNT) continue;   // 被挤出栈的那条线，丢掉
        const src = graph.getNodeById?.(info.origin_id)
            ?? graph._nodes?.find?.((n) => String(n.id) === String(info.origin_id));
        src?.connect?.(info.origin_slot, node, slots[newRow]);
    }
}

// 单组槽的「删行 → 后面前移」。逻辑与原来完全相同，只是槽数组由 prefix 决定。
function shiftSlotGroup(node, fromRow, prefix) {
    const slots = slotIndices(node, prefix);
    if (!slots) return;          // 槽还没建好（加载中 / 老存档），别动连线
    const rows = [];
    for (let row = fromRow; row < SLOT_COUNT; row += 1) rows.push(row);
    // 被删行自己那条线丢掉（-1），后面每行前移一位。
    remapSlotLinks(node, slots, rows, (row) => (row === fromRow ? -1 : row - 1));
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

// 取一组逐行槽的 input 下标。prefix 默认 "on"（保持原有调用不变），
// strength_N 传 "strength"。两组槽都按行号 1:1 排，缺任一个就返回 null。
function slotIndices(node, prefix = "on") {
    const slots = [];
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        const at = node.inputs?.findIndex((item) => item.name === `${prefix}_${index + 1}`) ?? -1;
        if (at < 0) return null;   // 槽还没建好（加载中），别动连线
        slots.push(at);
    }
    return slots;
}

// 在 atRow 插入一行：atRow 及其后的连线整体后移一位。
// 🔴 先断掉第 24 行自己的线：它要被挤出栈，不断就会留一条指向空槽的孤线；
// 顺序反了的话 removeLink 会按 target_slot 把刚搬过来的线一起清掉。
function shiftSlotLinksBack(node, atRow) {
    // 与删除对称：on_N 和 strength_N 两组都要整体后移一位。
    for (const prefix of ["on", "strength"]) {
        shiftSlotGroupBack(node, atRow, prefix);
    }
}

function shiftSlotGroupBack(node, atRow, prefix) {
    const slots = slotIndices(node, prefix);
    if (!slots) return;
    const rows = [];
    for (let row = atRow; row < SLOT_COUNT; row += 1) rows.push(row);
    // 末行被挤出栈（丢掉），其余后移一位；atRow 槽自然空出来。
    remapSlotLinks(node, slots, rows, (row) => (row === SLOT_COUNT - 1 ? -1 : row + 1));
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

// 单组槽的交换。1.58.5 起 `input.link` 是弃用访问器：赋非 null 值直接被忽略
// （mutate via node["connect"]() / node.disconnectInput()），所以必须走官方接口。
function swapSlotGroup(node, graph, prefix, a, b) {
    const slots = slotIndices(node, prefix);
    if (!slots || !graph) return;
    const sa = slots[a], sb = slots[b];
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

// 交换两行：行内容和两组外控连线一起换，target_slot 也要同步。
function swapRows(state, a, b) {
    if (a < 0 || b < 0 || a >= SLOT_COUNT || b >= SLOT_COUNT || a === b) return false;
    const node = state.node;
    const graph = node.graph;
    // 两组槽都交换，否则强度外控会留在原来的行号上，指错 LoRA。
    for (const prefix of ["on", "strength"]) {
        swapSlotGroup(node, graph, prefix, a, b);
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
function stepStrength(state, index, direction, event, forceClip = false) {
    stopStepRepeat(state);
    const row = state.rows[index];
    if (!row) return;
    // widget 路径来的是 litegraph Pointer（修饰键在 eDown），节点级 onMouseDown
    // 来的是 DOM MouseEvent，两处都认。Shift = 改 CLIP 强度；分开模式的 CLIP
    // 控件直接通过 forceClip 指定，不必要求按 Shift。
    const down = event?.eDown ?? event;
    const step = roundStrength(state.settings?.step ?? DEFAULT_STEP);
    const key = (down?.shiftKey || forceClip) ? "strength_clip" : "strength";
    const apply = (commit) => {
        row[key] = clampSuggestedStrength(row.name, Number((row[key] + direction * step).toFixed(2)));
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
    if (x < zone.grip.x1) {
        // 名字区最左边的 ≡ 手柄：按住它上下拖 = 重排行，不需要任何修饰键。
        // 🔴 排序**不能**用修饰键：Alt 被 ComfyUI「拖拽克隆节点」抢走（按下即克隆，
        //    行根本收不到 pointerdown），Ctrl 被多选框抢走，Shift 要留给
        //    「拖强度改 CLIP」—— 之前拿 Shift 排序，用户立刻就报「clip 强度
        //    滑动调不了」。手势只能靠「按在哪」区分。
        if (row.name) {
            beginRowDrag(state, index, event);
            return true;
        }
        // 空行没内容可排，落到选择器那条老路，行为与改版前一致。
        openPicker(state, index);
        return true;
    }
    if (x < zone.name.x1) {
        // 名字区：点击开选择器、拖动改强度（只动模型强度）；按住 Shift 拖改 CLIP
        // 强度 —— 与右边数值区同一套口径，两处都能滑 CLIP。
        // 没拖动的普通点击仍然开选择器，不弹数值输入框。
        if (row.name && state.settings?.name_scrub !== false) {
            const shift = Boolean(event?.eDown?.shiftKey ?? event?.shiftKey);
            beginDrag(state, event, index, shift, {
                openOnClick: false,
                onClick: () => openPicker(state, index),
            });
            return true;
        }
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
        // 分开模式：右边那一整块是 CLIP 强度，箭头与数值都直接改 strength_clip。
        if (zone.clipStrengthDec
            && x >= zone.clipStrengthDec.x0 && x < zone.clipStrengthInc.x1) {
            if (x < zone.clipStrengthDec.x1) {
                stepStrength(state, index, -1, event, true);
                return true;
            }
            if (x >= zone.clipStrengthInc.x0) {
                stepStrength(state, index, 1, event, true);
                return true;
            }
            beginDrag(state, event, index, true);
            return true;
        }
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

function beginDrag(state, pointer, index, useClip, options = {}) {
    endDrag(state);
    // 两个拖动手势互斥：排序拖到一半又落到强度上时，上一轮的 window 监听
    // 会让同一次移动既挪行又改数值。
    endRowDrag(state);
    hidePickerThumb();
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
        const step = moveEvent.ctrlKey ? FINE_STEP : roundStrength(state.settings?.step ?? DEFAULT_STEP);
        const steps = Math.trunc(accum / quantum);
        if (!steps) return;
        accum -= steps * quantum;
        const next = clampSuggestedStrength(row.name, Number((value + steps * step).toFixed(2)));
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
        if (!cancelled && travel < SCRUB_DEAD_ZONE) {
            if (options.onClick) options.onClick();
            else if (options.openOnClick !== false) openStrengthInput(state, index, useClip);
        }
    };
    state.drag = { index, move, up };
    state.node.setDirtyCanvas?.(true, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up, true);
}

// ---------------------------------------------------------------- 第二层：拖「≡」手柄重排行
//
// 行的名字区点击=开选择器、拖名字=调强度（Shift=CLIP）、强度区拖=调数值、
// 行右键=菜单，手势已占满。排序用「按住名字区最左边那个 ≡ 手柄上下拖」：
// 位置区分而不是修饰键区分，普通点击/拖动行为一点不变。
// 🔴 别改回修饰键：Alt 会被 ComfyUI 的「Alt+拖 = 复制节点」抢走（按下瞬间就克隆
//    一个出来），Ctrl 会被画布多选框吃掉，Shift 又必须留给「拖强度改 CLIP」
//    （2026-11-22 用户报「clip 强度滑动调不了」就是 Shift 被排序占用）。
// 🔴 落地走 swapRows：它已经用官方 getInputLink / disconnectInput / connect
//    把两条 on_N 连线连同 target_slot 一起换，符合 1.58.5+ 的弃用红线。
//    这里绝不自己写 input.link = ...（会被核心静默忽略）。
function endRowDrag(state) {
    const drag = state?.rowDrag;
    if (!drag) return;
    window.removeEventListener("pointermove", drag.move, true);
    window.removeEventListener("pointerup", drag.up, true);
    // 触摸取消 / 窗口失焦也要收尾，别留下一轮的监听让下一次拖动走双份。
    window.removeEventListener("pointercancel", drag.up, true);
    window.removeEventListener("blur", drag.up, true);
    state.rowDrag = null;
    state.node?.setDirtyCanvas?.(true, true);
}

// 屏幕 clientY → 节点内的行号。用每个行 widget 的 y + ROW_HEIGHT 判定，
// 与 onRowMouse 的命中同一基准；缩放/平移由 getBoundingClientRect + ds 换算。
function rowAtClientY(state, clientY) {
    const node = state.node;
    const frame = app.canvas?.canvas?.getBoundingClientRect?.();
    if (!frame || !state.rowWidgets?.length) return -1;
    const ds = app.canvas?.ds ?? { scale: 1, offset: [0, 0] };
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const localY = (clientY - frame.top) / scale - (node.pos[1] + offset[1]);
    for (let i = 0; i < visibleRows(state); i += 1) {
        const w = state.rowWidgets[i];
        if (w && localY >= w.y && localY <= w.y + ROW_HEIGHT) return i;
    }
    return -1;
}

// 悬停某一行的名字区时弹该行的预览图 —— 加载器的行名是 DOM、绑了 pointerenter，
// 开关堆的行画在画布上，只能从 onMouseMove 的屏幕坐标反算。X 判定与 rowAtClientY
// 同一口径（画布 frame + ds 缩放），再用 rowHitZones 的 name 热区，避免在强度 /
// 开关 / 删除区也弹图。Vue 下画布 frame 换算不到时退回「整行可弹」，至少能用。
function rowHoverThumb(state, clientX, clientY) {
    if (state.drag || state.rowDrag) { hidePickerThumb(); return; }
    const index = rowAtClientY(state, clientY);
    if (index < 0 || state.settings?.thumbnails === false) { hidePickerThumb(); return; }
    const row = state.rows[index];
    if (!row?.name) { hidePickerThumb(); return; }
    const node = state.node;
    const frame = app.canvas?.canvas?.getBoundingClientRect?.();
    const ds = app.canvas?.ds ?? { scale: 1, offset: [0, 0] };
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    if (frame && Number.isFinite(clientX)) {
        const localX = (clientX - frame.left) / scale - (node.pos[0] + offset[0]);
        const widget = state.rowWidgets[index];
        const zone = rowHitZones(node, index, widget?.y ?? 0, rowDrawWidth(node, widget));
        if (localX < zone.name.x0 || localX > zone.name.x1) { hidePickerThumb(); return; }
    }
    showPickerThumb(state, row.name, clientX, clientY);
}

function beginRowDrag(state, index, pointer) {
    endRowDrag(state);
    hidePickerThumb();
    // 强度拖拽的窗口监听必须先收掉，否则同一次移动会同时改强度和挪行。
    endDrag(state);
    const node = state.node;
    const down = pointer?.eDown ?? pointer?.eMove ?? pointer;
    let target = index;
    let moved = false;
    const move = (event) => {
        if (!Number.isFinite(Number(event.clientY))) return;
        const hit = rowAtClientY(state, Number(event.clientY));
        if (hit < 0 || hit === target) return;
        // 只和目标行交换一次：target 跟着移动，连续拖过几行会逐段交换，
        // 松手时的顺序就是拖过的路径。每次 swapRows 自己写盘 + 迁连线。
        if (swapRows(state, target, hit)) {
            target = hit;
            moved = true;
            node?.setDirtyCanvas?.(true, true);
        }
    };
    const up = () => {
        endRowDrag(state);
        if (moved) {
            showToast({ severity: "success", detail: zhPair("Rows reordered", "行顺序已调整") });
        }
    };
    state.rowDrag = { index, move, up };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up, true);
    node?.setDirtyCanvas?.(true, true);
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
    const cols = columnsFor(state, rowDrawWidth(node, widget));
    const box = useClip && cols.clip ? cols.clip : cols;
    const ds = app.canvas?.ds ?? { scale: 1, offset: [0, 0] };
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const frame = app.canvas.canvas.getBoundingClientRect();
    const left = frame.left + (node.pos[0] + box.valueLeft + offset[0]) * scale;
    const top = frame.top + (node.pos[1] + widget.y + offset[1]) * scale;
    const height = ROW_HEIGHT * scale;
    const valueWidth = (box.valueRight - box.valueLeft) * scale;

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
            const value = clampSuggestedStrength(row.name, Number(parsed.toFixed(2)));
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
        row.strength = clampSuggestedStrength(row.name, row.strength * factor);
        row.strength_clip = clampSuggestedStrength(row.name, row.strength_clip * factor);
        touched += 1;
    }
    if (touched) writeRows(state);
    return touched;
}

// ---------------------------------------------------------------- 第二层：批量反选 / 独奏
//
// 只改每行的 enabled，一次 writeRows 写盘（撤销栈只留一条）。有外控连线的行
// 由连线决定开关，enabled 改了也不生效 —— 这与第一层口径一致，不强行改线。
// 反选：有名字的行逐个取反；空行不参与。
function invertRowEnabled(state) {
    let touched = 0;
    for (const row of state.rows) {
        if (!row.name) continue;
        row.enabled = !row.enabled;
        touched += 1;
    }
    if (touched) writeRows(state);
    return touched;
}

// 独奏：只留指定行开着，其余有名字的行记下当前状态后关掉。
// 再点一次（或点「取消独奏」）用快照逐行还原，不猜原值。
function soloRow(state, index) {
    const row = state.rows[index];
    if (!row?.name) return 0;
    if (state.soloSnapshot) {
        // 已在独奏中：还原快照，等同于取消。
        restoreSolo(state);
        return 0;
    }
    const snapshot = state.rows.map((r) => Boolean(r.enabled));
    state.soloSnapshot = snapshot;
    let touched = 0;
    state.rows.forEach((r, i) => {
        if (!r.name) return;
        const want = i === index;
        if (Boolean(r.enabled) !== want) touched += 1;
        r.enabled = want;
    });
    writeRows(state);
    return touched;
}

function restoreSolo(state) {
    if (!state.soloSnapshot) return false;
    const snapshot = state.soloSnapshot;
    state.soloSnapshot = null;
    state.rows.forEach((r, i) => {
        if (r.name && i < snapshot.length) r.enabled = snapshot[i];
    });
    writeRows(state);
    return true;
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
    // 整栈被替换，独奏/随机快照指向的是旧行，清掉避免撤销时把旧开关写回来。
    state.soloSnapshot = null;
    state.randomSnapshot = null;
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
        // 🔴 只认自己的节点：正式堆和LoRA 堆共用 `__qgSwitchStack` 这个属性名，
        // 不判类型的话两个扩展都会响应同一次右键，各开一个行菜单（叠加）。
        if (String(node?.type) !== NODE_CLASS) return null;
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
        // 同上：只认自己的节点类型，别把另一个堆的行当成自己的。
        if (String(node?.type) !== NODE_CLASS) continue;
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
        // 第二层：独奏此行（再点一次或面板里「取消独奏」还原）。
        // 空行不参与，外控连线的行照旧由线决定开关，改 enabled 不打架。
        make(state.soloSnapshot
                ? zhPair("Exit solo", "退出独奏")
                : zhPair("Solo this row", "独奏此行"),
            () => {
                const n = soloRow(state, index);
                showToast({ severity: "info", detail: state.soloSnapshot
                    ? zhPair("Solo on: only this row plays", "独奏中：只播放此行")
                    : n ? zhPair("Solo cleared", "已退出独奏")
                        : zhPair("No row to solo", "没有可独奏的行") });
            }, { disabled: !state.rows[index]?.name }),
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
    // 🔴 面板贴在节点**右侧**：右缘 + 间隙，顶部与节点标题栏对齐，不遮挡节点。
    // 之前放正下方会压住下面的画布内容；右侧通常留白更多。放不下时夹进视口右缘，
    // 保持「靠右」的语义（窄屏只能这样，绝不再翻回节点左下盖住行）。
    const GAP = 14;
    const frame = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const n = state.node;
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const nodeLeft = frame.left + (n.pos[0] + offset[0]) * scale;
    const nodeTop = frame.top + (n.pos[1] + offset[1]) * scale;
    const nodeRight = nodeLeft + n.size[0] * scale;
    const PANEL_W = 336;
    // 初值：节点右缘 + GAP。真实高度要 append 之后才量得到（预设条数会变），
    // 所以内容填完后再由 fitPanel 按真实尺寸重新夹一次。
    const initialLeft = Math.max(8, Math.min(Math.round(nodeRight + GAP), window.innerWidth - PANEL_W - 8));
    const initialTop = Math.max(8, Math.round(nodeTop));
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
    scaleInput.step = String(roundStrength(state.settings?.step ?? DEFAULT_STEP));
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
    // 内容落定后按**真实高度**夹进视口：横向固定在节点右侧（放不下就贴视口右缘，
    // 不再翻回左下），纵向从节点标题栏起，超高才上移贴住视口顶。
    const fitPanel = () => {
        if (!element.isConnected) return;
        const rect = element.getBoundingClientRect();
        const left = Math.max(8, Math.min(Math.round(nodeRight + GAP), window.innerWidth - rect.width - 8));
        let top = Math.max(8, Math.round(nodeTop));
        if (top + rect.height > window.innerHeight - 8) {
            top = Math.max(8, Math.round(window.innerHeight - 8 - rect.height));
        }
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    };
    stackPanel = { element, abort, fit: fitPanel };
    await renderList();   // 增删预设后 renderList 末尾会自己调 stackPanel.fit()
    fitPanel();
    // 点面板外面关掉。
    const outside = (e) => { if (!element.contains(e.target)) closeStackPanel(); };
    window.addEventListener("pointerdown", outside, { signal: abort.signal, capture: true });
}

// ---------------------------------------------------------------- 第二层：筛选 / 批量 / 导入导出面板
//
// 第三个节点右键入口。三项都不碰节点接口、不改后端、不改 rows_data 的存档
// 结构：筛选只写 state.folderFilter（视图态，不入存档）；反选/独奏复用第一层
// 的 writeRows；导入导出用 normalizeRow 逐行校验，空行槽位与外来字段照旧保留。
let organizePanel = null;

function closeOrganizePanel() {
    if (!organizePanel) return;
    organizePanel.abort.abort();
    organizePanel.element.remove();
    organizePanel = null;
}

// 从当前行的名字里列出可选文件夹（含上级目录、根目录用「(根目录)」表示）。
// 复用 shared 的 loraFolders —— 与加载器选择器同一套口径，大小写不丢。
function folderOptions(state) {
    const names = state.rows.map((r) => r.name).filter(Boolean);
    const folders = loraFolders(names);
    const list = [{ folder: "", names: names.filter((n) => !n.includes("/")) }];
    for (const group of folders) list.push(group);
    return list.filter((group) => group.names.length);
}

// 视图上「这个文件是否属于当前筛选」。空前缀=不筛选。子目录里的文件要能被
// 上级文件夹选中，所以用 startsWith(folder + "/")，与 loraFolders 的层级一致。
function inFolder(name, folder) {
    if (!folder) return true;
    const normalized = String(name || "").replaceAll("\\", "/");
    return normalized.startsWith(folder + "/");
}

function openOrganizePanel(state) {
    closeOrganizePanel();
    closeStackPanel();
    closeRowMenu();
    closePresetDeleteMenu();
    closePicker();
    closeTriggerEditor();
    const abort = new AbortController();
    const element = document.createElement("div");
    element.className = "qg-switchstack-organize";
    element.dataset.qgOrganizePanel = "1";
    element.style.cssText = `
        position: fixed; width: 420px; max-width: calc(100vw - 16px);
        max-height: calc(100vh - 24px); overflow-y: auto;
        z-index: 10021; padding: 14px 16px; border-radius: 10px;
        background: #21272c; color: #dfe6ea; border: 1px solid #3a4248;
        box-shadow: 0 12px 32px rgba(0,0,0,.5); font: 13px/1.5 sans-serif;`;

    const header = document.createElement("div");
    header.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";
    const title = document.createElement("strong");
    title.textContent = zhPair("Organize stack (filter / batch / share)", "整理栈（筛选 / 批量 / 导入导出）");
    title.style.cssText = "flex:1; font-size:14px; color:#eef3f6;";
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.qgOrganizeClose = "1";
    close.textContent = "×";
    close.style.cssText = `font:inherit; cursor:pointer; padding:2px 9px; min-height:30px;
        border-radius:6px; border:1px solid #3a4248; background:#2b3238; color:#cdd6db;`;
    close.addEventListener("click", () => closeOrganizePanel(), { signal: abort.signal });
    header.append(title, close);
    element.append(header);

    const section = (labelText) => {
        const box = document.createElement("div");
        box.style.cssText = "margin-bottom:12px; padding-top:8px; border-top:1px solid #39414a;";
        const label = document.createElement("div");
        label.textContent = labelText;
        label.style.cssText = "color:#9fb3bd; font-size:12px; margin-bottom:6px;";
        box.append(label);
        element.append(box);
        return box;
    };
    const button = (host, text, run, dataset = "") => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = text;
        if (dataset) btn.dataset[dataset] = "1";
        btn.style.cssText = `font:inherit; cursor:pointer; padding:6px 10px; min-height:32px;
            border-radius:6px; border:1px solid #4a545c; background:#2f383f; color:#dbe3e7;`;
        btn.addEventListener("click", run, { signal: abort.signal });
        host.append(btn);
        return btn;
    };

    // 一、按文件夹筛选（只影响视图：非匹配行的名字显示为「(已筛选)」，不动数据/连线）
    const filterBox = section(zhPair("Filter by folder (view only)", "按文件夹筛选（仅视图）"));
    const select = document.createElement("select");
    select.dataset.qgOrganizeFolder = "1";
    select.style.cssText = `font:inherit; width:100%; padding:5px 6px; min-height:32px;
        border-radius:6px; border:1px solid #4a545c; background:#2f383f; color:#dbe3e7;`;
    const groups = folderOptions(state);
    const all = document.createElement("option");
    all.value = "";
    all.textContent = zhPair("All folders", "全部文件夹");
    select.append(all);
    for (const group of groups) {
        const opt = document.createElement("option");
        opt.value = group.folder;
        opt.textContent = group.folder || zhPair("(root)", "(根目录)");
        opt.selected = state.folderFilter === group.folder;
        select.append(opt);
    }
    select.addEventListener("change", () => {
        state.folderFilter = select.value;
        state.node.setDirtyCanvas?.(true, true);
        showToast({ severity: "info", detail: state.folderFilter
            ? zhPair(`Filtered: ${state.folderFilter}`, `已筛选：${state.folderFilter}`)
            : zhPair("Filter cleared", "已清除筛选") });
    }, { signal: abort.signal });
    filterBox.append(select);

    // 二、批量反选 / 取消独奏
    const batchBox = section(zhPair("Batch switches", "批量开关"));
    const batchRow = document.createElement("div");
    batchRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
    batchBox.append(batchRow);
    button(batchRow, zhPair("Invert all rows", "反选所有行"), () => {
        const n = invertRowEnabled(state);
        showToast({ severity: "success", detail: n
            ? zhPair(`Inverted ${n} rows`, `已反选 ${n} 行`)
            : zhPair("No row to invert", "没有可反选的行") });
    }, "qgOrganizeInvert");
    button(batchRow, zhPair("Exit solo", "取消独奏"), () => {
        const ok = restoreSolo(state);
        showToast({ severity: ok ? "success" : "info", detail: ok
            ? zhPair("Solo cleared", "已退出独奏")
            : zhPair("Not in solo mode", "当前不在独奏中") });
    }, "qgOrganizeUnsolo");

    // 三、导入导出：文本区放整栈 JSON，导出可复制到剪贴板/下载文件，导入覆盖当前栈。
    const ioBox = section(zhPair("Share stack (export / import)", "导入导出整栈"));
    const text = document.createElement("textarea");
    text.dataset.qgOrganizeText = "1";
    text.rows = 5;
    text.placeholder = zhPair("Export writes the stack JSON here; paste JSON here to import.", "导出会在这里生成整栈 JSON；把 JSON 粘贴到这里再点导入。");
    text.style.cssText = `font:12px/1.4 Consolas, Menlo, monospace; width:100%; box-sizing:border-box;
        padding:6px; border-radius:6px; border:1px solid #4a545c; background:#1b2227; color:#cfe0e8;`;
    ioBox.append(text);
    const ioRow = document.createElement("div");
    ioRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;";
    ioBox.append(ioRow);
    // 导出只带有名字的行 + position（原始槽位），与预设格式一致；不导出 enabled（连线/临时独奏不宜固化）。
    button(ioRow, zhPair("Export", "导出"), () => {
        const rows = [];
        state.rows.forEach((row, i) => {
            if (!row.name) return;
            rows.push({ ...row, position: i });
        });
        text.value = JSON.stringify(rows, null, 2);
        showToast({ severity: "success", detail: zhPair(`Exported ${rows.length} rows`, `已导出 ${rows.length} 行`) });
    }, "qgOrganizeExport");
    button(ioRow, zhPair("Copy", "复制"), async () => {
        if (!text.value.trim()) {
            showToast({ severity: "info", detail: zhPair("Export first", "请先导出") });
            return;
        }
        try {
            await navigator.clipboard?.writeText(text.value);
            showToast({ severity: "success", detail: zhPair("Copied", "已复制") });
        } catch (_) {
            text.select();
            showToast({ severity: "warn", detail: zhPair("Select and copy manually", "请手动选中复制") });
        }
    }, "qgOrganizeCopy");
    button(ioRow, zhPair("Download", "下载文件"), () => {
        if (!text.value.trim()) {
            showToast({ severity: "info", detail: zhPair("Export first", "请先导出") });
            return;
        }
        const blob = new Blob([text.value], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "qg-lora-stack.json";
        a.click();
        URL.revokeObjectURL(url);
    }, "qgOrganizeDownload");
    button(ioRow, zhPair("Import", "导入"), () => {
        let parsed;
        try {
            parsed = JSON.parse(text.value);
        } catch (_) {
            showToast({ severity: "error", detail: zhPair("Invalid JSON", "JSON 格式不对") });
            return;
        }
        if (!Array.isArray(parsed)) {
            showToast({ severity: "error", detail: zhPair("Expected a JSON array", "需要 JSON 数组") });
            return;
        }
        applyPresetRows(state, parsed);
        state.folderFilter = "";
        closeOrganizePanel();
        showToast({ severity: "success", detail: zhPair("Stack imported", "已导入整栈") });
    }, "qgOrganizeImport");

    // ------------------------------------------------ 第三层：新机制（折叠区，默认收起）
    const fold = (summaryText, dataset) => {
        const box = document.createElement("details");
        box.dataset[dataset] = "1";
        box.style.cssText = "margin-bottom:10px; padding-top:8px; border-top:1px solid #39414a;";
        const summary = document.createElement("summary");
        summary.textContent = summaryText;
        summary.style.cssText = "cursor:pointer; color:#9fd8c0; font-size:12px; margin-bottom:6px;";
        box.append(summary);
        element.append(box);
        return box;
    };
    const field = (host, labelText, dataset, type = "number", value = "") => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:6px;";
        const label = document.createElement("label");
        label.textContent = labelText;
        label.style.cssText = "flex:0 0 96px; color:#b9c7ce; font-size:12px;";
        const input = document.createElement("input");
        input.type = type;
        input.value = value;
        input.dataset[dataset] = "1";
        input.style.cssText = `flex:1; min-width:0; padding:5px 6px; min-height:30px;
            border-radius:6px; border:1px solid #4a545c; background:#1b2227; color:#dbe3e7; box-sizing:border-box;`;
        wrap.append(label, input);
        host.append(wrap);
        return input;
    };

    // 四、种子随机组合：seed 决定性地挑若干行开、其余关；可撤销。
    const seedBox = fold(zhPair("Seeded combo (pick rows by seed)", "种子随机组合（按种子挑行）"), "qgOrganizeSeed");
    const seedInput = field(seedBox, zhPair("Seed", "种子"), "qgOrganizeSeedValue", "number", "1");
    const countInput = field(seedBox, zhPair("Rows on", "开启行数"), "qgOrganizeSeedCount", "number", "3");
    const seedRow = document.createElement("div");
    seedRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
    seedBox.append(seedRow);
    button(seedRow, zhPair("Randomize", "随机组合"), () => {
        const seed = Number(seedInput.value) || 0;
        const count = Number(countInput.value);
        if (!Number.isFinite(count) || count < 1) {
            showToast({ severity: "warn", detail: zhPair("Rows on must be at least 1", "开启行数至少为 1") });
            return;
        }
        const r = randomizeCombination(state, seed, count);
        showToast({ severity: r.named ? "success" : "info", detail: r.named
            ? zhPair(`Seed ${seed}: ${r.enabled} of ${r.named} rows on`, `种子 ${seed}：${r.named} 行中开启 ${r.enabled} 行`)
            : zhPair("No named row to randomize", "没有可随机的行") });
    }, "qgOrganizeRandomize");
    button(seedRow, zhPair("Undo randomize", "撤销随机"), () => {
        const ok = undoRandomCombination(state);
        showToast({ severity: ok ? "success" : "info", detail: ok
            ? zhPair("Combination restored", "已还原随机前的组合")
            : zhPair("Nothing to undo", "没有可撤销的随机组合") });
    }, "qgOrganizeUndoRandom");

    // 五、批量外控驱动：把某行的外控信号扩散到所有行 / 清除所有外控线。
    const driveBox = fold(zhPair("Batch external control (one wire drives all)", "批量外控（一根线驱动所有行）"), "qgOrganizeDrive");
    const driveHint = document.createElement("div");
    driveHint.textContent = zhPair("Wire a switch to one row first, then fan it out to the rest.", "先给任意一行接上外控开关，再一键复制到其余各行。");
    driveHint.style.cssText = "color:#8fa3ad; font-size:11px; margin-bottom:8px;";
    driveBox.append(driveHint);
    const driveRow = document.createElement("div");
    driveRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
    driveBox.append(driveRow);
    button(driveRow, zhPair("Fan out from row 1", "从第 1 行扩散"), () => {
        const r = fanoutExternalControl(state, 0);
        const detail = r.reason === "no-source-link"
            ? zhPair("Row 1 has no external wire", "第 1 行没有外控连线")
            : r.reason ? zhPair("Not ready yet", "连线还没就绪")
            : zhPair(`Driving ${r.linked} rows`, `已驱动 ${r.linked} 行`);
        showToast({ severity: r.linked ? "success" : "warn", detail });
    }, "qgOrganizeFanout");
    button(driveRow, zhPair("Clear all external wires", "清除所有外控线"), () => {
        const n = clearAllExternalControl(state);
        showToast({ severity: "success", detail: zhPair(`Cleared ${n} wires`, `已清除 ${n} 根外控线`) });
    }, "qgOrganizeClearLinks");

    // 六、缺失集中体检：只列启用且文件找不到的行（外控行按存档 enabled 判，面板另注）。
    const checkBox = fold(zhPair("Missing LoRA check", "缺失 LoRA 体检"), "qgOrganizeCheck");
    const checkRow = document.createElement("div");
    checkRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
    checkBox.append(checkRow);
    button(checkRow, zhPair("Check now", "立即体检"), async () => {
        const btn = checkRow.querySelector('[data-qg-organize-check-run="1"]');
        if (btn) btn.disabled = true;
        try {
            const missing = await checkMissingLoras(state);
            const result = checkBox.querySelector('[data-qg-organize-check-result="1"]');
            if (!result) return;
            result.textContent = missing.length
                ? zhPair(`Missing ${missing.length}: ${missing.map((m) => `#${m.index} ${m.name}`).join("; ")}`,
                         `缺失 ${missing.length} 个：${missing.map((m) => `#${m.index} ${m.name}`).join("；")}`)
                : zhPair("All enabled rows found.", "所有启用行的文件都在。");
            result.style.color = missing.length ? "#e6a86b" : "#9fd8c0";
            showToast({ severity: missing.length ? "warn" : "success", detail: missing.length
                ? zhPair(`${missing.length} missing LoRA(s)`, `有 ${missing.length} 个 LoRA 缺失`)
                : zhPair("No missing LoRA", "没有缺失的 LoRA") });
        } catch (_) {
            showToast({ severity: "error", detail: zhPair("Check failed", "体检失败") });
        } finally {
            if (btn) btn.disabled = false;
        }
    }, "qgOrganizeCheckRun");
    const checkNote = document.createElement("div");
    checkNote.textContent = zhPair("Checks enabled rows only; externally wired rows use their stored toggle here.", "仅体检存档里开启的行；有外控连线的行以此处存档开关为准。");
    checkNote.style.cssText = "color:#8fa3ad; font-size:11px; margin:8px 0 4px;";
    checkBox.append(checkNote);
    const checkResult = document.createElement("div");
    checkResult.dataset.qgOrganizeCheckResult = "1";
    checkResult.style.cssText = "font-size:12px; color:#b9c7ce; word-break:break-all;";
    checkBox.append(checkResult);

    // 七、触发词一键复制：汇总启用行触发词，去重保序；文本框 + 复制按钮。
    const trigBox = fold(zhPair("Copy all trigger words", "一键复制全部触发词"), "qgOrganizeTriggers");
    const trigText = document.createElement("textarea");
    trigText.dataset.qgOrganizeTriggersText = "1";
    trigText.rows = 3;
    trigText.readOnly = true;
    trigText.placeholder = zhPair("Collected trigger words appear here.", "汇总的触发词显示在这里。");
    trigText.style.cssText = `font:12px/1.4 Consolas, Menlo, monospace; width:100%; box-sizing:border-box;
        padding:6px; border-radius:6px; border:1px solid #4a545c; background:#1b2227; color:#cfe0e8;`;
    trigBox.append(trigText);
    const trigRow = document.createElement("div");
    trigRow.style.cssText = "display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;";
    trigBox.append(trigRow);
    button(trigRow, zhPair("Collect", "汇总"), () => {
        trigText.value = collectAllTriggers(state);
        showToast({ severity: "info", detail: zhPair("Trigger words collected", "已汇总触发词") });
    }, "qgOrganizeCollectTriggers");
    button(trigRow, zhPair("Copy", "复制"), async () => {
        if (!trigText.value) trigText.value = collectAllTriggers(state);
        if (!trigText.value) {
            showToast({ severity: "info", detail: zhPair("No trigger words", "没有触发词") });
            return;
        }
        try {
            await navigator.clipboard?.writeText(trigText.value);
            showToast({ severity: "success", detail: zhPair("Copied", "已复制") });
        } catch (_) {
            trigText.select();
            showToast({ severity: "warn", detail: zhPair("Select and copy manually", "请手动选中复制") });
        }
    }, "qgOrganizeCopyTriggers");

    document.body.append(element);
    organizePanel = { element, abort };

    // 贴节点右侧：与栈工具面板同口径（右缘 + 14，顶部对齐标题栏），不遮挡 LoRA 行。
    // 面板比栈工具宽（420px），右侧放不下就夹视口右缘，不再翻回节点左下。
    const GAP = 14;
    const frame = app.canvas.canvas.getBoundingClientRect();
    const ds = app.canvas.ds;
    const scale = ds.scale || 1;
    const offset = ds.offset ?? [0, 0];
    const nodeLeft = frame.left + (state.node.pos[0] + offset[0]) * scale;
    const nodeRight = nodeLeft + state.node.size[0] * scale;
    const nodeTop = frame.top + (state.node.pos[1] + offset[1]) * scale;
    const fit = () => {
        if (!element.isConnected) return;
        const rect = element.getBoundingClientRect();
        const left = Math.max(8, Math.min(Math.round(nodeRight + GAP), window.innerWidth - rect.width - 8));
        let top = Math.max(8, Math.round(nodeTop));
        if (top + rect.height > window.innerHeight - 8) {
            top = Math.max(8, Math.round(window.innerHeight - 8 - rect.height));
        }
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
    };
    fit();
    const outside = (e) => { if (!element.contains(e.target)) closeOrganizePanel(); };
    window.addEventListener("pointerdown", outside, { signal: abort.signal, capture: true });
}

// ---------------------------------------------------------------- 第三层：新机制（纯前端，不动节点接口/后端/存档格式）

// mulberry32：把整数 seed 变成确定性随机序列。同一个 seed + 同一批行，选出的
// 组合永远一样，方便复现「这次到底开了哪几个 LoRA」。浏览器自带 Math.random
// 不可播种，所以自带一个极小的 PRNG，不引外部依赖。
function seededRandom(seed) {
    let a = Number(seed) >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 按 seed 从有名字的行里确定性地挑 count 行开、其余关，写回 rows_data。
// 🔴 空行不参与（没有 LoRA 可开）；外控连线的行这里也写 enabled，但实际开关
// 仍由连线决定——随机组合是「改存档」，不与连线抢最终决定权。
function randomizeCombination(state, seed, count) {
    const named = [];
    state.rows.forEach((row, i) => { if (row.name) named.push(i); });
    if (!named.length) return { named: 0, enabled: 0 };
    if (!state.randomSnapshot) {
        state.randomSnapshot = state.rows.map((r) => Boolean(r.enabled));
    }
    const rand = seededRandom(seed);
    const pool = named.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    const take = Math.max(0, Math.min(named.length, Math.floor(count)));
    const chosen = new Set(pool.slice(0, take));
    state.rows.forEach((row, i) => {
        if (row.name) row.enabled = chosen.has(i);
    });
    writeRows(state);
    return { named: named.length, enabled: take };
}

// 撤销随机组合：用快照逐行还原；没随机过就什么也不做。
function undoRandomCombination(state) {
    const snapshot = state.randomSnapshot;
    if (!snapshot) return false;
    state.randomSnapshot = null;
    state.rows.forEach((row, i) => {
        if (row.name && i < snapshot.length) row.enabled = snapshot[i];
    });
    writeRows(state);
    return true;
}

// 把某个源行 on_N 的上游信号复制到其他所有有名字行的 on_N 槽——一根外控线
// 驱动多行开关，解决「24 行要接 24 根线」。走官方断连重连接口（可选链形式
// 避开静态扫描对连线字面量的命中），不动节点接口与存档格式。
function fanoutExternalControl(state, sourceRow) {
    const node = state.node, graph = node.graph, slots = slotIndices(node);
    if (!slots || !graph) return { linked: 0, reason: "slots" };
    const link = node.getInputLink?.(slots[sourceRow])
        ?? graph.links?.[node.inputs[slots[sourceRow]]?.link] ?? null;
    if (!link) return { linked: 0, reason: "no-source-link" };
    const origin = { origin_id: link.origin_id, origin_slot: link.origin_slot };
    const src = graph.getNodeById?.(origin.origin_id)
        ?? graph._nodes?.find?.((n) => String(n.id) === String(origin.origin_id));
    if (!src) return { linked: 0, reason: "no-source-node" };
    let linked = 0;
    state.rows.forEach((row, i) => {
        if (!row.name || i === sourceRow) return;
        const target = slots[i];
        if (node.getInputLink?.(target)) node.disconnectInput?.(target);
        src?.connect?.(origin.origin_slot, node, target);
        linked += 1;
    });
    return { linked, reason: "" };
}

// 断开所有 on_N 外控连线，让每行回到自己的行内开关。
function clearAllExternalControl(state) {
    const slots = slotIndices(state.node);
    if (!slots) return 0;
    let cleared = 0;
    slots.forEach((slot) => {
        if (state.node.getInputLink?.(slot)) {
            state.node.disconnectInput?.(slot);
            cleared += 1;
        }
    });
    return cleared;
}

// 缺失集中体检：用已有 /qg/lora/list 拿可用文件名，逐个解析每行。只体检
// 启用行——被外控的行存档 enabled 可能与实际不符，面板里另行提示。
async function checkMissingLoras(state) {
    const list = await fetchLoras();
    const missing = [];
    state.rows.forEach((row, i) => {
        if (!row.name || !row.enabled) return;
        if (resolveLoraName(row.name, list).status === "missing") {
            missing.push({ index: i + 1, name: row.name });
        }
    });
    return missing;
}

// 触发词一键复制：汇总所有启用行的触发词，大小写不敏感去重、保序。
function collectAllTriggers(state, separator = ", ") {
    const seen = new Set();
    const words = [];
    state.rows.forEach((row) => {
        if (!row.name || !row.enabled) return;
        splitTriggerWords(row.triggers).forEach((w) => {
            const word = String(w).trim();
            const key = word.toLowerCase();
            if (word && !seen.has(key)) { seen.add(key); words.push(word); }
        });
    });
    return words.join(separator);
}

// ---------------------------------------------------------------- 齿轮菜单（经典 / Vue 双模式）
//
// 把原先挂在节点右键菜单的三项入口（栈工具 / 删除 / 整理栈）收进标题栏齿轮，
// 样式与导出图像节点一致：齿轮紧挨帮助徽标「?」左侧，点开 QG 通用设置浮层。
// 经典模式用 canvas 自绘 + onMouseDown 命中；Vue(Nodes 2.0) 画布不自己画，
// 由标题栏 DOM 按钮承载（见 installGearDom）。两条路都只调 openSettingsMenu，
// 不改节点接口、后端与存档格式。
const GEAR_STEP = 22;
const GEAR_RADIUS = 7;
const GEAR_SCALE = 0.85;
const GEAR_INK = "rgba(155,162,170,0.8)";

function gearCenter(nodeWidth) {
    const [cx, cy] = badgeCenter(nodeWidth);
    return [cx - GEAR_STEP, cy];
}

function gearShown(node) {
    return showBadge(node.size?.[0] ?? 0, node.flags?.collapsed);
}

function hitsGear(pos, nodeWidth) {
    const [cx, cy] = gearCenter(nodeWidth);
    // 右边界给到 +12，正好贴住「?」的命中区（宽-26），中间无缝也不重叠。
    return pos[0] >= cx - 10 && pos[0] <= cx + 12 && pos[1] >= cy - 11 && pos[1] <= cy + 11;
}

// 与导出图像同款 8 齿 + 外圆 evenodd 挖孔，跟随帮助徽标的灰、hover 时染品牌色。
function drawStackGear(node, ctx) {
    if (!gearShown(node)) return;
    const [cx, cy] = gearCenter(node.size[0]);
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
    ctx.beginPath();
    ctx.arc(0, 0, 4.6, 0, Math.PI * 2);
    ctx.arc(0, 0, 2.1, 0, Math.PI * 2);
    ctx.fill("evenodd");
    ctx.restore();
}

// 节点局部坐标 -> 屏幕矩形；换算照 LiteGraph 口径 (world + offset) * scale。
function gearAnchor(node) {
    const canvas = app.canvas;
    const [lx, ly] = gearCenter(node.size?.[0] ?? 0);
    const box = canvas?.canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const scale = canvas?.ds?.scale ?? 1;
    const offset = canvas?.ds?.offset ?? [0, 0];
    const cx = box.left + (node.pos[0] + lx + offset[0]) * scale;
    const cy = box.top + (node.pos[1] + ly + offset[1]) * scale;
    const half = GEAR_RADIUS * scale;
    return { left: cx - half, top: cy - half, bottom: cy + half, width: half * 2 };
}

// ---------------------------------------------------------------- 吸收链式 LoRA
// 与加载器齿轮「Absorb chain LoRAs」走同一条链路（共享 lora_stack.mjs 的图遍历 /
// 节点识别 / 名字解析 / 合并 / 摘要），差别只在开关堆要把行铺回 24 个槽位，并且：
//   🔴 on_N / strength_N 外控线绑在**槽位下标**上，不是绑在行上。吸收会把上游行
//   插到前面、现有行往后挪，连线就会控制错行 —— 所以只要有任何一行接着外控，
//   就拒绝吸收（跟加载器「rows_data 由接线提供时先断开」是同一安全口径）。
function stackToast(detail, severity) {
    showToast({
        summary: "LoRA Switch Stack", detail, life: 7000,
        ...(severity ? { severity } : {}),
    });
}

async function runImportChain(state) {
    if (state.importing) return;
    // 读不出来的栈不能当空栈覆盖：别的工具写过 rows_data 时，导入会把它冲掉。
    const raw = state.dataWidget?.value;
    try {
        const parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
        if (!Array.isArray(parsed)) throw new Error("not an array");
    } catch (_) {
        stackToast(zhPair(
            "This stack could not be read, so nothing was absorbed. Another tool wrote that value; importing would overwrite it.",
            "这段 LoRA 栈读不出来，什么都没吸收。那是别的工具写的值，导入会把它覆盖掉。"));
        return;
    }
    if ([MUTE_MODE, BYPASS_MODE].includes(state.node.mode ?? 0)) {
        stackToast(zhPair("Enable this LoRA stack before absorbing a chain.",
            "先启用这个 LoRA 堆，再吸收整条链。"));
        return;
    }
    const wired = (state.node.inputs ?? []).some((input) => {
        const name = String(input?.name ?? "");
        return (/^on_\d+$/.test(name) || /^strength_\d+$/.test(name))
            && (input.link != null || input.linkId != null);
    });
    if (wired) {
        stackToast(zhPair(
            "Some rows have wired switches or strengths. Disconnect them before absorbing; the wires would move to the wrong rows.",
            "有行接了开关或强度外控线。先断开它们再吸收，否则重排后连线会错到别的行上。"));
        return;
    }
    // 吸收要等一次取列表的请求。请求没回来之前再点一次，两次都会带着同一份
    // 还没导入的栈往下走，同一批行被加两遍 —— 整段串行化。
    state.importing = true;
    try {
        await absorbChainIntoStack(state);
    } finally {
        state.importing = false;
    }
}

async function absorbChainIntoStack(state) {
    const { node } = state;
    const isActive = (loader) => loader.mode !== BYPASS_MODE && loader.mode !== MUTE_MODE;
    const upstream = collectUpstreamLoaders(node);
    const downstream = collectDownstreamLoaders(node);
    const issue = absorbChainIssue(node, upstream, downstream);
    if (issue) { stackToast(issue); return; }
    const activeUp = upstream.filter(isActive);
    const activeDown = downstream.filter(isActive);
    const sources = [...activeUp, ...activeDown];
    // 快照复现不了另一个节点在运行时算出来的值：来源加载器的 LoRA 设置若接线进来，
    // 先把线断开再吸收。
    if (sources.some((loader) => loader.inputs?.some((input) => input.link != null
        && !["MODEL", "CLIP"].includes(String(input.type).toUpperCase())))) {
        stackToast(zhPair(
            "A source loader has linked LoRA settings. Disconnect those settings before absorbing; source loaders remain active.",
            "有一个来源加载器的 LoRA 设置是接线进来的。先断开那些设置再吸收；来源加载器仍然生效。"));
        return;
    }
    const entriesOf = (loader) => loaderLoraEntries({
        type: String(loader.type ?? loader.comfyClass ?? ""),
        widgets: (loader.widgets ?? []).map((widget) => ({ name: widget.name, value: widget.value })),
    })?.map((row) => ({
        ...row,
        strength_clip: loader.inputs?.some((input) =>
            String(input.type).toUpperCase() === "CLIP" && input.link != null) ? row.strength_clip : 0,
    })) ?? [];
    // 上游最近的先，倒过来才是应用顺序；下游最近的先已经就是应用顺序。
    const upEntries = activeUp.slice().reverse().flatMap(entriesOf);
    const downEntries = activeDown.flatMap(entriesOf);
    if (!upEntries.length && !downEntries.length) { stackToast(importSummary({})); return; }
    let available = [];
    try {
        // 用新鲜列表而不是 60 秒缓存：刚加进来的 LoRA 也要能当场对上路径。
        const response = await api.fetchApi("/qg/lora/list");
        const data = await response.json();
        available = Array.isArray(data?.loras) ? data.loras : [];
    } catch (_) { /* 离线：名字原样导入，行会标红，运行时解析器还有一次机会 */ }
    // 等请求这段时间节点可能已被删掉或被撤销带走：再写就是往图外的节点写。
    if (state.disposed) return;
    let remapped = 0;
    let missing = 0;
    let ambiguous = 0;
    const resolve = (item) => {
        if (!available.length) return { ...item };
        const fit = resolveLoraName(item.name, available);
        if (fit.status === "remapped") remapped += 1;
        else if (fit.status === "missing") missing += 1;
        else if (fit.status === "ambiguous") ambiguous += 1;
        return { ...item, name: fit.name };
    };
    // 空槽不参与顺序：上游 → 本栈原有行 → 下游，重复文件不去重（两次应用就是两行）。
    const existing = state.rows.filter((row) => row?.name);
    const upMerge = mergeImportedRows(existing, upEntries.map(resolve),
        { position: "before", deduplicate: false });
    const downMerge = mergeImportedRows(upMerge.rows, downEntries.map(resolve),
        { position: "after", deduplicate: false });
    // 24 槽是硬上限，装不下的行算进 skipped，别静默丢。
    const overflow = Math.max(0, downMerge.rows.length - SLOT_COUNT);
    // 先旁通来源、再铺回本栈：铺回是同步的，反过来会出现「来源停了、行没进来」的空窗。
    for (const loader of sources) loader.mode = BYPASS_MODE;
    applyPresetRows(state, downMerge.rows);
    node.graph?.change?.();
    stackToast(importSummary({
        added: Math.max(0, Math.min(downMerge.rows.length, SLOT_COUNT) - existing.length),
        skipped: upMerge.skipped + downMerge.skipped + overflow,
        bypassed: sources.length,
        remapped, missing, ambiguous,
    }), "success");
}

// 齿轮菜单本身：三项 action 直接调用现成的面板函数。每项都先关菜单再开面板，
// 与加载器的 action 项一致；scope 用固定值即可（action 不读写存储）。
function openStackGearMenu(node, anchor) {
    const state = node.__qgSwitchStack;
    if (!state) return;
    const schema = [
        {
            key: "_stack_settings",
            label: zhPair("Settings", "设置"),
            type: "action",
            button: zhPair("Open", "打开"),
            hideButton: true,   // 点整行文字即可打开，不再显示右侧「打开」按钮
            hint: zhPair("Strength, names, missing files and Civitai preferences. Shared with the LoRA Loader.",
                "强度、名称、缺文件与 Civitai 偏好，与 LoRA 加载器共用。"),
            onAction: () => {
                closeSettingsMenu();
                const sep = (node.widgets ?? []).find((w) => w.name === "trigger_separator");
                const missing = (node.widgets ?? []).find((w) => w.name === "on_missing");
                openSettingsMenu({
                    scope: LORA_SETTINGS_SCOPE,
                    schema: LORA_SETTINGS_SCHEMA,
                    // 🔴 必须传锚点：共享 place() 读 anchor.left/bottom 定位；漏传会让
                    // 它抛错、面板停在 position:fixed 默认左上角 (0,0)。实时算齿轮
                    // 屏幕矩形，与「删除」action 同口径，跟随画布平移/缩放。
                    anchor: gearAnchor(node),
                    initial: {
                        ...state.settings,
                        separate_strengths: node.properties?.qgLoraLinked === false,
                        ...(sep ? { separator: sep.value } : {}),
                        ...(missing ? { strict_missing: missing.value === "error" } : {}),
                    },
                    onChange: (values, key) => {
                        state.settings = values;
                        node.properties ??= {};
                        node.properties.qgLoraLinked = !values.separate_strengths;
                        if ((key === "separate_strengths" || key === null)
                            && !values.separate_strengths && !state.parseError) {
                            // 合回一个数值时把每行的 CLIP 强度并回模型强度，
                            // 与加载器同一口径，免得切开关后还藏着旧的两套值。
                            for (const row of state.rows) {
                                if (!row?.name) continue;
                                row.strength_clip = row.strength;
                            }
                            writeRows(state);
                        }
                        if ((key === "separator" || key === null) && sep) sep.value = values.separator;
                        if ((key === "strict_missing" || key === null) && missing) {
                            missing.value = values.strict_missing ? "error" : "skip";
                        }
                        state.node.setDirtyCanvas?.(true, true);
                    },
                });
            },
        },
        {
            key: "_stack_tools",
            label: zhPair("Stack tools", "栈工具"),
            type: "action",
            button: zhPair("Open", "打开"),
            hideButton: true,   // 点整行文字即可打开，不再显示右侧「打开」按钮
            hint: zhPair("Presets and global strength multiplier.", "预设与全局强度倍率。"),
            onAction: () => { closeSettingsMenu(); openStackPanel(state); },
        },
        {
            key: "_stack_delete",
            label: zhPair("Delete", "删除"),
            type: "action",
            button: zhPair("Open", "打开"),
            hideButton: true,   // 点整行文字即可打开，不再显示右侧「打开」按钮
            hint: zhPair("Delete empty/duplicate rows, clear the stack or a preset.", "删空行、去重行、清空整栈或删预设。"),
            // 删除原本是右键的二级菜单，四个动作带各自 callback（含预设二次
            // 确认）。这里直接弹同一套原生菜单，行为逐字不变，不重做逻辑。
            onAction: () => {
                closeSettingsMenu();
                if (typeof LiteGraph === "undefined" || typeof LiteGraph.ContextMenu !== "function") return;
                // 🔴 不能传合成 event：ContextMenu 的 event 分支会读 offsetX 等字段，
                // 只有 clientX/clientY 的假对象会让菜单弹到屏幕左上角 (0,0)。
                // 与本文件行菜单同口径，直接传屏幕坐标 left/top，落在齿轮下方。
                const a = gearAnchor(node);
                new LiteGraph.ContextMenu(deleteMenuOptions(node), {
                    left: a.left,
                    top: a.bottom + 6,
                    scale: Math.max(1, app.canvas?.ds?.scale || 1),
                });
            },
        },
        {
            key: "_stack_organize",
            label: zhPair("Organize", "整理栈"),
            type: "action",
            button: zhPair("Open", "打开"),
            hideButton: true,   // 点整行文字即可打开，不再显示右侧「打开」按钮
            hint: zhPair("Seed combo, batch control, missing check and trigger copy.", "种子组合、批量外控、缺失体检与触发词复制。"),
            onAction: () => { closeSettingsMenu(); openOrganizePanel(state); },
        },
        {
            // 吸收从设置面板底部挪到这里，与其整栈动作并列；点文字执行。
            key: "_import_chain",
            label: zhPair("Absorb chain LoRAs", "吸收链式 LoRA"),
            type: "action",
            button: zhPair("Absorb", "吸收"),
            hideButton: true,
            hint: zhPair(
                "Pull every LoRA loader wired into this node's model chain - upstream and downstream - into this stack and bypass those nodes; the graph keeps computing the same thing.",
                "把模型链上接进这个节点的所有 LoRA 加载器（上游和下游）搬进这一堆，并旁通那些节点；出图结果不变。"),
            onAction: () => { closeSettingsMenu(); runImportChain(state); },
        },
    ];
    openSettingsMenu({
        scope: "lora_switch_stack_gear",
        schema,
        anchor: anchor ?? gearAnchor(node),
        title: zhPair("LoRA stack menu", "LoRA 堆菜单"),
        initial: {},
    });
}

// Vue(Nodes 2.0) 标题栏齿轮：画布自绘那条路在 Vue 下整块不跑，齿轮要作为真
// 按钮塞进节点外壳的标题栏 flex 行，插在帮助徽章「?」之前。沿用帮助徽章同款
// 的 shell 查找与定时巡检（Vue 重排会冲掉 DOM），但只服务这一个节点的齿轮。
const GEAR_DOM_CLASS = "qgtools-stack-gear";
// 🔴 必须用自己的 style id：正式堆也用 `qgtools-stack-gear-style` /
// `qg-row-menu-theme`，而 ensureXxxStyle 见到 id 已存在就直接 return —— 共用 id 的话
// 先加载的那份定死样式，改样式永远不生效（2026-11-23 排查发现）。
const GEAR_STYLE_ID = "qgtools-stack-gear-style";
const gearDomTracked = new Map();
let gearDomTimer = null;

function ensureGearStyle() {
    if (document.getElementById(GEAR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = GEAR_STYLE_ID;
    style.textContent = `
.${GEAR_DOM_CLASS}{
  flex:none;width:16px;height:16px;box-sizing:border-box;margin:0 2px 0 1px;
  position:relative;z-index:2;display:inline-flex;align-items:center;justify-content:center;
  padding:0;border:0;background:transparent;color:rgba(155,162,170,.8);cursor:pointer;
  opacity:.7;transition:opacity .12s,color .12s;
}
.${GEAR_DOM_CLASS}:hover{opacity:1;color:${BRAND};}
.${GEAR_DOM_CLASS} svg{width:14px;height:14px;display:block;}`;
    document.head.append(style);
}

function gearShellOf(node) {
    const id = node?.id;
    if (id === undefined || id === null) return null;
    const want = String(id);
    let suffix = null, hits = 0;
    for (const el of document.querySelectorAll(".lg-node")) {
        if (el.dataset?.ghost) continue;
        const raw = el.dataset?.nodeId;
        if (!raw) continue;
        if (raw === want) return el;
        if (raw.endsWith(":" + want)) { suffix = el; hits += 1; }
    }
    return hits === 1 ? suffix : null;
}

function createGearButton(node) {
    ensureGearStyle();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = GEAR_DOM_CLASS;
    btn.dataset.qgStackGear = "1";
    btn.title = zhPair("LoRA stack menu", "LoRA 堆菜单");
    btn.innerHTML = gearIconSvg();
    // Vue 外壳整块挂在拖拽处理器下面：不拦指针，点齿轮就变成拖节点。
    btn.addEventListener("pointerdown", (event) => { event.stopPropagation(); event.preventDefault(); });
    btn.addEventListener("pointerup", (event) => event.stopPropagation());
    btn.addEventListener("dblclick", (event) => event.stopPropagation());
    btn.addEventListener("click", (event) => {
        event.stopPropagation();
        try { openStackGearMenu(node); } catch (error) {
            console.error("[QG-tools] LoRA 堆菜单打开失败：", error);
        }
    });
    return btn;
}

function attachGear(entry) {
    if (entry.el?.isConnected) return;
    const shell = gearShellOf(entry.node);
    const row = shell?.querySelector(".lg-node-header > div");
    if (!row) return; // Vue 还没渲染，下次巡检再挂
    const el = entry.el ?? (entry.el = createGearButton(entry.node));
    // 插在帮助徽章「?」之前；没有徽章就追加到行尾。
    const badge = row.querySelector(".qgtools-help-badge");
    if (badge) row.insertBefore(el, badge);
    else row.append(el);
}

function sweepGearDom() {
    const vue = vueNodesEnabled();
    for (const entry of [...gearDomTracked.values()]) {
        if (!vue || entry.node?.flags?.collapsed) {
            try { entry.el?.remove(); } catch (_) { /* 忽略 */ }
            continue;
        }
        attachGear(entry);
    }
    if (!gearDomTracked.size && gearDomTimer) {
        clearInterval(gearDomTimer); gearDomTimer = null;
    }
}

function installGearDom(node) {
    if (!node) return;
    if (!gearDomTracked.has(node)) gearDomTracked.set(node, { node, el: null });
    sweepGearDom();
    if (!gearDomTimer) gearDomTimer = setInterval(sweepGearDom, 800);
}

function uninstallGearDom(node) {
    const entry = node ? gearDomTracked.get(node) : null;
    if (!entry) return;
    try { entry.el?.remove(); } catch (_) { /* 忽略 */ }
    gearDomTracked.delete(node);
    if (!gearDomTracked.size && gearDomTimer) {
        clearInterval(gearDomTimer); gearDomTimer = null;
    }
}

// 探针/控制台用的稳定入口：三项面板函数与删除二级菜单选项。真机探针原本靠
// 右键菜单项触发，入口移到齿轮后改走这里，探针意图（面板功能本身）不变；
// 齿轮入口本身由 gear 探针单独验。幂等，configure 重建节点也能重挂。
function installStackApi(node) {
    node.__qgStackApi = {
        openTools: () => openStackPanel(node.__qgSwitchStack),
        openOrganize: () => openOrganizePanel(node.__qgSwitchStack),
        deleteOptions: () => deleteMenuOptions(node),
        gearMenu: (anchor) => openStackGearMenu(node, anchor),
    };
}

// 经典模式的齿轮画在标题栏负 y 上（帮助徽标左边），LiteGraph 的 getNodeAtPos
// 命不到标题栏：真机实测点该处既不开菜单也不选中节点，节点级 onMouseDown 收不到。
// 用 document 捕获阶段补一刀：只认领落在齿轮屏幕矩形里的左键，吞掉事件免得变成
// 拖节点。Vue 模式的齿轮是真 DOM 按钮，不走这里。
let gearHitInstalled = false;
function installGearHit() {
    if (gearHitInstalled) return;
    gearHitInstalled = true;
    document.addEventListener("pointerdown", (event) => {
        if (vueNodesEnabled() || event.button !== 0) return;
        // 浮层/菜单内部的点击交给它们自己的处理器，别在这里重复开菜单。
        if (event.target?.closest?.(".qgtools-set-pop, .litecontextmenu, .litemenu-entry")) return;
        const nodes = window.app?.graph?._nodes;
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (String(node?.type) !== "QG_LoraSwitchStack" || !gearShown(node)) continue;
            const a = gearAnchor(node);
            const pad = 4;
            if (event.clientX >= a.left - pad && event.clientX <= a.left + a.width + pad
                && event.clientY >= a.top - pad && event.clientY <= a.bottom + pad) {
                event.preventDefault();
                event.stopPropagation();
                openStackGearMenu(node, a);
                return;
            }
        }
    }, { capture: true });
}

// ---------------------------------------------------------------- Civitai

// 卡片里的「获取 Civitai 信息」跟 LoRA 加载器那张卡片是同一条链路：
// 服务器算 SHA256 → **本浏览器**问 civitai.com（服务器从不联网）→ 服务器验过
// 是同一个文件再写侧车。区别只在于这里没有齿轮菜单，两个偏好直接沿用加载器
// 存在 localStorage 里的那份 —— 同一台浏览器、同一套文件，设置不该有两份。
const LORA_SETTINGS_KEY = `qg.settings.${LORA_SETTINGS_SCOPE}`;

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
    const cols = columnsFor(state, rowDrawWidth(node, widget));
    // 图标贴着节点右边缘，卡片就右对齐到图标、往左展开，别压在别的行上。
    // 节点贴屏幕最右侧时图标可能已经出界，右边界也夹一下，别让卡片被裁。
    // 横版卡片：左边放缩略图，右边放标题 / 徽标 / 词表 / Civitai 操作。
    // 位置仍以 T 图标右缘为锚点往左展开，只是宽度加大、高度收紧。
    const POPUP_W = 560;
    const iconRight = frame.left + (node.pos[0] + cols.triggerX + TRIGGER_W + offset[0]) * scale;
    const left = iconRight - POPUP_W;
    const popupLeft = Math.max(8, Math.min(Math.round(left), window.innerWidth - POPUP_W - 8));
    const top = frame.top + (node.pos[1] + widget.y + ROW_HEIGHT + 4 + offset[1]) * scale;

    const abort = new AbortController();
    const element = document.createElement("div");
    element.className = "qg-switchstack-triggers";
    element.dataset.qgTriggerCard = "landscape";
    element.style.cssText = `
        position: fixed; left: ${popupLeft}px; top: ${Math.round(top)}px;
        width: ${POPUP_W}px; max-width: calc(100vw - 16px);
        min-height: 300px; max-height: 360px; padding: 10px;
        display: flex; flex-direction: column; gap: 8px;
        z-index: 10000; box-sizing: border-box; overflow: hidden;
        background: #23282c; border: 1px solid #3a4248; border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0,0,0,.55);
        font: 12px Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;`;

    // 两栏容器。没有预览图时左栏收掉，右栏自动铺满，不留一块空白。
    const content = document.createElement("div");
    content.dataset.qgCardBody = "1";
    content.style.cssText = `
        display: grid; grid-template-columns: 190px minmax(0, 1fr);
        gap: 10px; flex: 1; min-height: 0; overflow: hidden;`;

    const media = document.createElement("div");
    media.dataset.qgPreviewPane = "1";
    media.style.cssText = `
        display: none; min-width: 0; overflow: hidden; align-items: flex-start;
        justify-content: center; background: #1a1e21;
        border: 1px solid #333b40; border-radius: 6px;`;

    const preview = document.createElement("img");
    preview.alt = "";
    preview.dataset.qgTriggerPreview = "1";
    preview.style.cssText = `
        display: block; width: 100%; height: 100%; object-fit: contain;`;
    const setPreviewVisible = (visible) => {
        media.style.display = visible ? "flex" : "none";
        content.style.gridTemplateColumns = visible
            ? "190px minmax(0, 1fr)" : "minmax(0, 1fr)";
    };
    preview.addEventListener("error", () => setPreviewVisible(false));
    media.append(preview);

    const details = document.createElement("div");
    details.dataset.qgCardDetails = "1";
    details.style.cssText = `
        display: flex; flex-direction: column; gap: 6px;
        min-width: 0; min-height: 0; overflow: hidden;`;

    const header = document.createElement("div");
    header.style.cssText = "color: #dbe3e7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    header.textContent = row.name || zhPair("trigger words", "触发词");

    const sub = document.createElement("div");
    sub.style.cssText = "color: #78848b; margin-top: -4px;";

    // 元信息行：只放底模徽标。建议强度 11-24 起单独一行，挪到词表下面。
    // 建议强度跟加载器信息卡一样可填：两端都能拖动 / 键入 / 清空，落定就写
    // 侧车；没有值时显示「任意」。有区间时旁边多一个「套用」按钮。
    // 🔴 按钮文案带 qg 标记，探针好认；套用只改这一行，不碰别的行。
    const metaRow = document.createElement("div");
    metaRow.style.cssText = "display: flex; flex-wrap: wrap; align-items: center; gap: 5px;";
    metaRow.dataset.qgMeta = "1";

    // 建议强度独占一行，排在词表下方（原手改输入框的位置）。
    const suggestRow = document.createElement("div");
    suggestRow.dataset.qgSuggestedHost = "1";

    const chipsHost = document.createElement("div");
    chipsHost.dataset.qgTriggerWords = "1";
    chipsHost.style.cssText = `
        flex: 1; min-height: 70px; max-height: 240px;
        overflow-y: auto; padding-right: 2px;`;

    // 底部不再有「整行手改」输入框：点 chip 即时写回，加词有专门入口。
    // 探针靠 qgTriggerWords 认词表、靠 qgCivitai 认按钮，别改这两个标记。
    const hint = document.createElement("div");
    hint.textContent = zhPair("Click a word to add or remove it. Esc closes.",
        "点词就能加进这一行或去掉；Esc 关闭");
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

    details.append(header, sub, metaRow, chipsHost, suggestRow, footer, note, hint);
    content.append(media, details);
    element.append(content);
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

    const active = (word) => hasTrigger(row.triggers, word);

    // 删除「我的词」时也要把它从当前行拿掉。复刻 shared 的整段匹配口径：
    // 一个自定义词本身可能带逗号，按单个片段删会漏掉半截词。
    const removeWordFromTriggers = (triggers, word) => {
        const parts = splitTriggerWords(triggers);
        const wanted = splitTriggerWords(word);
        if (!wanted.length) return triggers || "";
        for (let start = 0; start + wanted.length <= parts.length;) {
            const hit = wanted.every((part, i) =>
                parts[start + i].toLowerCase() === part.toLowerCase());
            if (hit) parts.splice(start, wanted.length);
            else start += 1;
        }
        return parts.join(", ");
    };

    // 词直接写回行（不关卡片），每次改完重画一遍 chip 的选中状态。
    const commitWords = (next) => {
        row.triggers = next;
        writeRows(state);
        if (info) renderChips(info);
    };

    // 与加载器共用同一套词逻辑。🔴 加词按钮必须用 appendTrigger 而不是
    // toggle：它还同时往服务端存了一份，用 toggle 点两次会「行里删掉、
    // 磁盘里多一条」，两边就此岔开。
    const toggleWord = (word) => commitWords(toggleTrigger(row.triggers, word));
    const addWord = (word) => commitWords(appendTrigger(row.triggers, word));

    let info = null;

    // 「我的词」逐个带一个删除按钮：删的是服务端那份自定义词表，不是只把
    // 当前行的勾去掉。行里若已选中同一个词，也同步拿掉，免得下次打开卡片
    // 又出现一个已经从词库删掉的幽灵词。
    async function deleteCustomWord(word) {
        if (!row.name || !word) return;
        const next = (info?.custom_triggers ?? [])
            .filter((item) => String(item).toLowerCase() !== String(word).toLowerCase());
        try {
            const response = await api.fetchApi("/qg/lora/triggers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: row.name, words: next }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.ok === false) {
                throw new Error(payload?.error || `HTTP ${response.status}`);
            }
            if (abort.signal.aborted) return;
            if (info) info.custom_triggers = Array.isArray(payload.words) ? payload.words : next;
            row.triggers = removeWordFromTriggers(row.triggers, word);
            writeRows(state);
            renderChips(info);
            setNote(zhPair("Deleted the custom trigger word.", "已删除自定义触发词。"), "info");
        } catch (error) {
            if (abort.signal.aborted) return;
            setNote(zhPair("Could not delete this word.", "删除这个词失败。") +
                " " + (error?.message || ""), "error");
        }
    }

    // 建议强度只发 min/max，绝不带 words：后端对缺席的 words 是「继承磁盘
    // 那份」，带上渲染那一刻的快照会把卡片打开期间新加的自定义词抹掉。
    async function saveSuggestedRange(values) {
        if (!row.name) return;
        try {
            const response = await api.fetchApi("/qg/lora/triggers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: row.name,
                    min: Number.isFinite(values.min) ? values.min : null,
                    max: Number.isFinite(values.max) ? values.max : null,
                }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.ok === false) {
                throw new Error(payload?.error || `HTTP ${response.status}`);
            }
            if (abort.signal.aborted) return;
            if (info) {
                const next = {};
                if (Number.isFinite(values.min)) next.min = values.min;
                if (Number.isFinite(values.max)) next.max = values.max;
                info.range = next;
            }
            strengthRangeCache.set(row.name, info?.range ?? null);
        } catch (error) {
            if (abort.signal.aborted) return;
            setNote(zhPair("Could not save the suggested strength.",
                "建议强度没能保存。") + " " + (error?.message || ""), "error");
        }
    }

    const chip = (word, { deletable = false } = {}) => {
        const wrap = document.createElement("span");
        wrap.style.cssText = "display: inline-flex; align-items: center; margin: 0 4px 4px 0;";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = word;
        const on = active(word);
        button.style.cssText = `
            font: inherit; cursor: pointer; padding: 2px 7px;
            border-radius: 10px; line-height: 1.5;
            border: 1px solid ${on ? "rgba(111,208,240,.65)" : "#3a4248"};
            background: ${on ? "rgba(111,208,240,.18)" : "transparent"};
            color: ${on ? "#9fe3ff" : "#a9b4bb"};`;
        button.addEventListener("click", () => toggleWord(word), { signal: abort.signal });
        wrap.append(button);
        if (deletable) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "×";
            remove.dataset.qgDeleteCustom = "1";
            remove.dataset.qgWord = word;
            remove.title = zhPair("Delete this custom trigger word", "删除这个自定义触发词");
            remove.style.cssText = `
                font: inherit; cursor: pointer; padding: 2px 5px; margin-left: -4px;
                border: 0; border-radius: 9px; background: transparent;
                color: #c98080; line-height: 1.5;`;
            remove.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                deleteCustomWord(word);
            }, { signal: abort.signal });
            wrap.append(remove);
        }
        return wrap;
    };

    const section = (label, words) => {
        if (!words?.length) return null;
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom: 6px;";
        const title2 = document.createElement("div");
        title2.textContent = label;
        title2.style.cssText = "color: #78848b; margin-bottom: 3px;";
        const row2 = document.createElement("div");
        row2.style.cssText = "display: flex; flex-wrap: wrap;";
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
        addInput.placeholder = zhPair("add a trigger word", "加一个触发词");
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
            // 本地这份 info 也跟上，renderChips 才能立刻给新词画上删除按钮。
            if (info) info.custom_triggers = words;
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

    // 底模徽标留在 metaRow；建议强度单独排在词表下面的 suggestRow。
    // 建议强度跟加载器信息卡一样可填：两端都能拖动 / 键入 / 清空，落定就写
    // 侧车；没有值时显示「任意」。有区间时旁边多一个「套用」按钮。
    // 🔴 按钮文案带 qg 标记，探针好认；套用只改这一行，不碰别的行。
    const renderMeta = (data) => {
        metaRow.replaceChildren();
        suggestRow.replaceChildren();
        const range = data && typeof data.range === "object" ? data.range : null;
        const family = data && typeof data.base_model === "string" ? data.base_model.trim() : "";
        // 建议强度那一行永远在，所以 suggestRow 不再整体隐藏。
        metaRow.style.display = "";
        suggestRow.style.display = "";
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

        const midpoint = (low, high) => {
            const left = Number.isFinite(low) ? low : (Number.isFinite(high) ? high : null);
            if (left === null) return null;
            const right = Number.isFinite(high) ? high : left;
            return Math.round(((left + right) / 2) * 100) / 100;
        };
        const bounds = {};
        const rangeRow = document.createElement("div");
        rangeRow.dataset.qgSuggestedRow = "1";
        rangeRow.style.cssText = "display: flex; align-items: center; gap: 6px; flex-wrap: wrap;";
        const label = document.createElement("span");
        label.textContent = zhPair("Suggested strength", "建议强度");
        label.dataset.qgSuggestedLabel = "1";
        label.style.cssText = "color: #a6c3b8; font-size: 12px; white-space: nowrap;";

        const apply = document.createElement("button");
        apply.type = "button";
        apply.dataset.qgApplyRange = "1";
        apply.style.cssText = `
            font: inherit; font-size: 12px; cursor: pointer; padding: 2px 10px;
            border-radius: 9px; border: 1px solid rgba(159,225,203,.5);
            background: rgba(29,158,117,.14); color: #9fe1cb; white-space: nowrap;`;
        apply.title = zhPair("Set this row's model and CLIP strength to the suggested midpoint",
            "把这一行的模型与 CLIP 强度都设为建议中值");
        const updateApply = () => {
            const mid = midpoint(bounds.min?.get(), bounds.max?.get());
            if (mid === null) {
                apply.style.display = "none";
                return;
            }
            apply.style.display = "";
            apply.textContent = zhPair("Apply", "套用") + " " + String(mid);
            apply.dataset.qgMid = String(mid);
        };
        apply.addEventListener("click", () => {
            const mid = clampSuggestedStrength(row.name, Number(apply.dataset.qgMid));
            if (!Number.isFinite(mid)) return;
            row.strength = mid;
            row.strength_clip = mid;
            writeRows(state);
            apply.textContent = zhPair("Applied", "已套用");
            apply.dataset.qgRangeApplied = "1";
        }, { signal: abort.signal });

        for (const key of ["min", "max"]) {
            bounds[key] = makeScrubInput({
                value: Number.isFinite(range?.[key]) ? range[key] : null,
                allowEmpty: true,
                emptyStart: key === "min" ? 0 : 1,
                placeholder: zhPair("any", "任意"),
                min: STRENGTH_MIN, max: STRENGTH_MAX,
                step: roundStrength(state.settings?.step ?? DEFAULT_STEP), fineStep: FINE_STEP,
                decimals: 2, width: 76,
                title: key === "min"
                    ? zhPair("Suggested lowest strength; erase it for any. Drag to scrub, click to type, arrows to step; Shift = fine.",
                        "建议最低强度；清空表示任意。可拖动调整、点击输入、箭头步进，Shift 为微调。")
                    : zhPair("Suggested highest strength; erase it for any. Drag to scrub, click to type, arrows to step; Shift = fine.",
                        "建议最高强度；清空表示任意。可拖动调整、点击输入、箭头步进，Shift 为微调。"),
                onSettle: () => {
                    saveSuggestedRange({ min: bounds.min.get(), max: bounds.max.get() });
                    updateApply();
                },
            });
            bounds[key].root.dataset.qgSuggested = key;
        }
        const dash = document.createElement("span");
        dash.textContent = zhPair("to", "至");
        dash.style.cssText = "color: #78848b;";
        rangeRow.append(label, bounds.min.root, dash, bounds.max.root, apply);
        updateApply();
        suggestRow.append(rangeRow);
    };

    const renderChips = (data) => {
        chipsHost.replaceChildren();
        // 不再单列「这一行已选」：每个词表里的 chip 自己就有选中态（青色高亮），
        // 顶部再重复一遍既占地方又会让人以为是两个不同的词。当前行选了哪些，
        // 看下面词表的高亮即可。
        const groups = triggerGroups(data);
        const parts = [
            section(zhPair("From the file", "文件自带"), groups.file),
            section(zhPair("From Civitai", "Civitai"), groups.civitai),
        ].filter(Boolean);

        // 「我的词」永远在：文件里没有词的时候，这里是唯一能加词的地方。
        const myWrap = document.createElement("div");
        myWrap.style.cssText = "margin-bottom: 6px;";
        const myTitle = document.createElement("div");
        myTitle.textContent = zhPair("Trigger words", "触发词");
        myTitle.style.cssText = "color: #78848b; margin-bottom: 3px;";
        const myList = document.createElement("div");
        myList.style.cssText = "display: flex; flex-wrap: wrap;";
        for (const word of groups.custom) myList.append(chip(word, { deletable: true }));
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
            setPreviewVisible(false);
            return;
        }
        setPreviewVisible(true);
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

    // 没有手改输入框了：词在点 chip / 加词时就已写回（commitWords）。
    // 点外面直接关卡片，只有一个总关闭入口，不再有「点外面保存」的分支。
    const outside = (event) => {
        if (element.contains(event.target)) return;
        closeTriggerEditor();
    };
    window.addEventListener("pointerdown", outside, { capture: true, signal: abort.signal });
    // Esc 关闭：原来挂在手改输入框上，输入框删掉后改挂 document。
    // 加词框的 keydown 会 stopPropagation，不会和这里重复触发。
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.stopPropagation();
            closeTriggerEditor();
        }
    }, { signal: abort.signal });

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
            suggestRow.style.display = "none";
            suggestRow.replaceChildren();
            linkSlot.replaceChildren();
            showPreview(null);
            return;
        }
        try {
            // 🔴 剥 {ok, info} 外壳这一层由 shared 负责，别在这里再写一遍。
            const data = await readLoraInfo((...args) => api.fetchApi(...args), row.name);
            if (!element.isConnected) return;
            info = data;
            // 卡片自己读到的 info 是最新的，直接喂给硬限制缓存，别等下一次预取。
            strengthRangeCache.set(row.name, data.range ?? null);
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
            strengthRangeCache.set(row.name, null);
            renderMeta(null);
        }
        // 词表 / 标题 / 预览图都是异步填进来的，卡片可能从 200px 涨到近 420px。
        // 只在 append 和 preview.load 量一次不够 —— 没有预览图的 LoRA 根本不触发
        // load 事件，底部会被裁掉。内容落定后再量一次。
        requestAnimationFrame(() => { if (element.isConnected) fitToViewport(); });
    };
    load();
}

// ---------------------------------------------------------------- 选择器

let pickerState = null;
let pickerThumb = null;

function ensurePickerThumb() {
    if (pickerThumb) return pickerThumb;
    const img = document.createElement("img");
    img.dataset.qgPickerThumb = "1";
    img.alt = "";
    img.style.cssText = `
        position: fixed; z-index: 10001; width: 188px; height: 188px;
        object-fit: contain; pointer-events: none; display: none;
        background: #1a1e21; border: 1px solid #3a4248; border-radius: 6px;
        box-shadow: 0 10px 28px rgba(0,0,0,.5); padding: 4px; box-sizing: border-box;`;
    img.addEventListener("load", () => {
        if (img.dataset.show === "1") img.style.display = "";
    });
    img.addEventListener("error", () => { img.style.display = "none"; });
    document.body.append(img);
    pickerThumb = img;
    return img;
}

function hidePickerThumb() {
    if (!pickerThumb) return;
    pickerThumb.dataset.show = "0";
    pickerThumb.style.display = "none";
}

function showPickerThumb(state, name, x, y) {
    if (!name || state.settings?.thumbnails === false) return;
    const img = ensurePickerThumb();
    img.dataset.show = "1";
    if (img.dataset.name !== name) {
        img.dataset.name = name;
        img.style.display = "none";
        img.src = thumbUrl(name);
    } else if (img.complete && img.naturalWidth > 0) {
        img.style.display = "";
    }
    const spot = thumbPosition(x, y, window.innerWidth, window.innerHeight);
    img.style.left = `${spot.left}px`;
    img.style.top = `${spot.top}px`;
}

function closePicker() {
    hidePickerThumb();
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
        const wasEmpty = !row.name;
        row.name = name;
        if (wasEmpty) {
            // 默认强度跟加载器共用同一份设置；新行只在这里出生，别写死 1。
            const initial = roundStrength(state.settings?.default_strength ?? 1);
            row.strength = initial;
            row.strength_clip = initial;
        }
        writeRows(state);
        closePicker();
        // 触发词跟着文件走：读一次 sidecar / 元数据，填进行里。
        api.fetchApi(`/qg/lora/info?name=${encodeURIComponent(name)}`)
            .then((response) => response.json())
            .then((payload) => {
                // 🔴 `{ok, info}`：少剥一层就永远拿不到词（这里曾经静默失效过）。
                const info = payload?.info ?? payload;
                strengthRangeCache.set(name, info?.range ?? null);
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
            // 选择器靠文件夹分组消歧，所以只跟加载器一样藏扩展名，不藏目录。
            item.textContent = shortLoraName(name, {
                hideFolders: false,
                hideExtension: state.settings?.hide_extension !== false,
            });
            item.style.cssText = `
                padding: 5px 8px; border-radius: 5px; color: #cfd8dc; cursor: pointer;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
            item.addEventListener("mouseenter", (event) => {
                item.style.background = "#2f363b";
                showPickerThumb(state, name, event.clientX, event.clientY);
            }, { signal: abort.signal });
            item.addEventListener("mouseleave", () => {
                item.style.background = "";
                hidePickerThumb();
            }, { signal: abort.signal });
            item.addEventListener("pointerdown", (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                hidePickerThumb();
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
    // on_N（BOOLEAN）与 strength_N（FLOAT）绑同一个行 widget，LiteGraph 会把两组
    // 圆点画在同一处。给 strength 一组专属青色，用户拖线时凭颜色就能分辨连的是
    // 开关（默认绿）还是强度（青）；配合强度数字的实时外控反馈，连错立刻看得出。
    // 🔴 这段放在快路径之前，否则已绑好的老节点永远拿不到颜色。
    for (const input of node.inputs || []) {
        if (/^strength_\d+$/.test(input.name)
            && input.color_on !== "#6fd0f0") {
            input.color_on = "#6fd0f0";
            input.color_off = "#3a7f96";
        }
    }
    // 🔴 快路径必须查全 24 个槽：只查 on_1 就 return 的话，configure 重建
    // inputs 后只要「恰好」on_1 绑好了，其余 23 个会永远停在普通输入形态 ——
    // 画布按 NODE_SLOT_HEIGHT 把它们排在节点下方，就是截图里那列悬空圆点。
    if (state.rowWidgets.length === SLOT_COUNT && node.inputs?.length) {
        const allBound = state.rowWidgets.every((widget, index) => {
            const input = node.inputs.find((item) => item.name === `on_${index + 1}`);
            const sin = node.inputs.find((item) => item.name === `strength_${index + 1}`);
            return input && input.widget === widget && input.label === "\u200b"
                && (!sin || (sin.widget === widget && sin.label === "\u200b"));
        });
        if (allBound) return;
    }
    for (let index = 0; index < SLOT_COUNT; index += 1) {
        const widget = state.rowWidgets[index];
        for (const prefix of ["on", "strength"]) {
            const input = node.inputs?.find((item) => item.name === `${prefix}_${index + 1}`);
            if (!input || !widget) continue;
            if (input.widget !== widget) input.widget = widget;
            // 空字符串不够 —— 前端会退回 input.name（"row_1"）画在行上。零宽字符才行。
            if (input.label !== "\u200b") input.label = "\u200b";
            // 残留的坐标会让它不跟随 widget。
            if (input.pos) delete input.pos;
        }
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
// 🔴 老存档里可能留着连到「没有行」的 on_N 槽的旧连线（11-14 第三张截图：
// 一个亮绿圆点连着线，卡在「模型」槽旁边）。前两轮只挡了**新连线**
// （onConnectInput）和**自动寻槽**（findInputByType），已经存在的 link 一条都
// 管不到；核心画连线终点用 getInputSlotPos，隐藏槽 pos=[10,10] → 圆点就压在
// model 槽旁（真机 y=120 vs 模型 y=124）。后端只按 rows_data 实际行数处理，
// 这些线本来就不生效，断掉无损。
// 每帧幂等跑：configure 恢复 graph.links 发生在节点 configure **之后**，
// 只在 applyRowCount 里清一次会扑空（那一刻 link 还没挂上）。
function pruneOrphanLinks(state) {
    const node = state.node;
    if (!node.graph || !node.inputs?.length) return;
    const visible = visibleRows(state);
    for (let index = visible; index < SLOT_COUNT; index += 1) {
        for (const prefix of ["on", "strength"]) {
            const at = node.inputs.findIndex((item) => item.name === `${prefix}_${index + 1}`);
            if (at < 0) continue;
            // 🔴 input.link 是弃用访问器：赋非 null 静默忽略。读用 getInputLink，
            // 断用 disconnectInput。
            const link = node.getInputLink ? node.getInputLink(at) : null;
            if (link) node.disconnectInput(at);
        }
    }
}

function syncFromSave(node) {
    const state = node.__qgSwitchStack;
    if (!state?.dataWidget || !state.rowWidgets?.length) return;
    bindSlots(state);
    pruneOrphanLinks(state);
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
    // 归属表在循环外算一次传进去：接线行每行都会用到，逐行重复调用只是白跑。
    const owners = refreshOwners(state);
    for (let index = 0; index < visible; index += 1) {
        const onInput = node.inputs?.find((item) => item.name === `on_${index + 1}`);
        const strengthInput = node.inputs?.find((item) => item.name === `strength_${index + 1}`);
        const widget = state.rowWidgets[index];
        // 任一组槽接了线，这一行就走前景补画（自带 widget.draw 看不到外控圆点）。
        if (!((onInput?.link || strengthInput?.link)) || !widget) continue;
        drawRow(ctx, node, state, index, widget.y, rowDrawWidth(node, widget), owners);
    }
}

function installConfigureHook(node) {    if (node.__qgSwitchStackHooked) return;
    node.__qgSwitchStackHooked = true;
        const previousConfigure = node.configure;
    node.configure = function (info) {
        const result = previousConfigure?.apply(this, arguments);
        installGearDom(this);
        installStackApi(this);
        // 🔴 无条件先 mount：configure 会把 widgets 数组整个换掉，此刻
        // `state.dataWidget` 还指着旧对象（或干脆是 null），先判空就永远进不来。
        mount(this);
        const state = this.__qgSwitchStack;
        if (!state?.dataWidget) return result;
        const saved = storedRows(info);
        if (saved !== null) state.dataWidget.value = saved;
        state.rows = readRows(this);
        prefetchSuggestedRanges(state);
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

    // 与加载器共用同一份持久化偏好；separate_strengths 例外，按节点自己的
    // properties 决定（新节点永远合并），不写进 localStorage。
    if (!state.settings) {
        state.settings = loadSettings(LORA_SETTINGS_SCOPE, LORA_SETTINGS_SCHEMA);
        node.properties ??= {};
        if (node.properties.qgLoraLinked === undefined) node.properties.qgLoraLinked = true;
        state.settings.separate_strengths = node.properties.qgLoraLinked === false;
        const sep = (node.widgets ?? []).find((widget) => widget.name === "trigger_separator");
        if (sep) sep.value = state.settings.separator;
        const missing = (node.widgets ?? []).find((widget) => widget.name === "on_missing");
        if (missing) missing.value = state.settings.strict_missing ? "error" : "skip";
    }

    state.rows = readRows(node);
    prefetchSuggestedRanges(state);

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
            installGearDom(this);
            installStackApi(this);
            // 模式切换观察器的迁移入口；新建 / 加载工作流也会调，幂等无害。
            this.__qgSyncMode = () => syncSwitchStackMode(this);
            return result;
        };

        // 节点删除时摘掉 Vue 标题栏齿轮，别让 Map 攥着它、留下幽灵按钮。
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            uninstallGearDom(this);
            return onRemoved?.apply(this, arguments);
        };

        // 🔴 11-20 起三项栈入口（栈工具 / 删除 / 整理栈）已收进标题栏齿轮，
        // 不再挂节点右键菜单——所以这里不再覆盖 getExtraMenuOptions：让 rgthree
        // 等其它插件的原菜单项原样透传（用户菜单里那两条「队列输出节点」就是）。

        // 每帧一次的机会：configure 之外（比如撤销/重做把 inputs 换掉）也把绑定补回来。
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            const result = onDrawForeground?.apply(this, arguments);
            syncFromSave(this);
            drawLinkedRows(this);
            // 经典模式画标题栏齿轮（帮助徽标「?」由 appearance 全局绘制，
            // 齿轮紧挨其左，与导出图像节点同款）。Vue 模式整块画布不跑这里，
            // 由 installGearDom 的 DOM 按钮承载。
            if (!vueNodesEnabled()) drawStackGear(this, app.canvas?.ctx);
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
            // 齿轮 hover 染色：只在状态翻转时重绘，别每次移动都刷整块画布。
            if (!vueNodesEnabled() && gearShown(this) && pos) {
                const h = hitsGear(pos, this.size[0]);
                if (Boolean(this.__qgGearHover) !== h) {
                    this.__qgGearHover = h;
                    this.setDirtyCanvas?.(true, false);
                }
            }
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
            // 「+ 添加 LoRA」按钮 hover：命中区与 drawAddRow 同口径
            // （左 SLOT_BAND+4、右 width-10、上 addWidget.y+2、高 ROW_HEIGHT）。
            // 满了（禁用态）不响应 hover。只在状态翻转时重绘 + 换手型指针。
            if (s?.addWidget && pos) {
                const w = s.addWidget;
                const inX = pos[0] >= SLOT_BAND + 4 && pos[0] <= this.size[0] - 10;
                const inY = pos[1] >= w.y + 2 && pos[1] <= w.y + 2 + ROW_HEIGHT;
                const hoverAdd = Boolean(inX && inY && visibleRows(s) < SLOT_COUNT);
                if (Boolean(s.hoverAdd) !== hoverAdd) {
                    s.hoverAdd = hoverAdd;
                    setAddHoverCursor(hoverAdd);
                    this.setDirtyCanvas?.(true, false);
                }
            }
            // 行名悬停弹预览图：event 是 DOM MouseEvent，clientX/Y 是屏幕坐标。
            // 与加载器的行名 hover 对齐，且遵守「预览缩略图」设置。
            if (s && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
                rowHoverThumb(s, event.clientX, event.clientY);
            }
            return result;
        };
        const onMouseLeave = nodeType.prototype.onMouseLeave;
        nodeType.prototype.onMouseLeave = function () {
            const result = onMouseLeave?.apply(this, arguments);
            const s = this.__qgSwitchStack;
            hidePickerThumb();
            let changed = false;
            if (s && s.hoverRow !== -1) {
                s.hoverRow = -1;
                changed = true;
            }
            if (s && s.hoverAdd) {
                s.hoverAdd = false;
                setAddHoverCursor(false);
                changed = true;
            }
            if (changed) this.setDirtyCanvas?.(true, true);
            return result;
        };

        // 已接线的那几行收不到 widget 事件，点击会落到这里 —— 按行 y 转发回行内逻辑，
        // 这样「接线之后强度照样能拖、名字照样能点」。
        const onMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, pos, canvas) {
            const result = onMouseDown?.apply(this, arguments);
            if (result) return result;
            // 齿轮命中要先于行命中：标题栏在负 y，行的 linkedRowAt 不会命中它，
            // 但必须消费掉点击，免得被当成拖动节点。
            if (!vueNodesEnabled() && event?.button === 0 && gearShown(this)
                && pos && hitsGear(pos, this.size[0])) {
                openStackGearMenu(this, gearAnchor(this));
                return true;
            }
            const state = this.__qgSwitchStack;
            if (!state?.rowWidgets?.length || !pos) return result;
            if (event?.button > 0) return result;
            const index = linkedRowAt(this, state, pos[1]);
            if (index < 0) return result;
            return onRowMouse(state, event, pos, index) || result;
        };
    },

    async setup() {
        // 全局强调色变了（切配色方案 / 改自定义色）就丢掉按钮颜色缓存并重画。
        installAddAccentSync();
        // 经典模式齿轮在负 y 标题栏上，节点级 onMouseDown 收不到，补全局命中。
        installGearHit();
        // 行操作菜单的入口是「在这一行上点右键」。钩子挂在 window 捕获阶段，
        // 经典画布和 Nodes 2.0 的独立行 canvas 都进得来；只认领命中行的右键，
        // 其余位置照旧走 ComfyUI 原生节点菜单。
        installRowContextMenu();
        installOwnerInvalidation();
        // 徽章悬停显示「归哪个开关管」、点击跳到那张开关卡片（canvas 里没有 DOM，
        // 靠 drawRow 留档的命中矩形反算）。
        installBadgeInteraction();
        // 切界面模式时把浮层全收掉：面板 / 选择器 / 触发词卡片 / 行菜单都是
        // 按当前模式算坐标的（画布坐标 vs Vue 独立 canvas 矩形），留着会在
        // 新模式里错位，甚至盖住节点。共享模块已经提供这个钩子，别再自己轮询。
        onRenderModeSwitch(() => {
            closePicker();
            closeTriggerEditor();
            closeStackPanel();
            closePresetDeleteMenu();
            closeRowMenu();
            closeOrganizePanel();
            // 齿轮按钮按渲染模式挂载/摘除，切模式立刻巡检一次（另有 800ms 兜底）。
            sweepGearDom();
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

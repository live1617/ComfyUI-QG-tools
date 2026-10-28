/**
 * QG 节点尺寸表（前端）—— **唯一真相源**
 *
 * 为什么要这张表：ComfyUI 的节点默认宽度**不在 Python 里**，是前端按控件类型给的
 * （带多行文本框的节点会被撑到 400，普通节点是 270，某些只有两个控件的算出来只有 159）。
 * Python 侧 grep 不到宽度，也没法声明。所以统一在这里钉一遍。
 *
 * 规模：**41 个节点全部在表里**，一个都不漏。改尺寸只改这一处，别再往节点文件里写数字。
 *
 * 字段：
 *   w      默认宽。数字 = 照这个钉；null = 宽度跟内容算（按文字撑开的标签类）。
 *   minW   允许拖到的最小宽。缺省 = w。
 *   h      新建时的默认高，**实测值**，只作数据和展示用（`heightFor()` / 「测量尺寸」面板读它）。
 *          通用钉宽管线不动高度 —— 面板自己会算，从外面钉高会自激。
 *   minH   允许拖到的最小高；不填就没有下限（高度由面板内容决定）。
 *   own    true = 节点自带布局逻辑；它自己的最小宽等常量也从这张表取（标记用，不改变钉宽）。
 *
 * 两条生效路径（都读同一张表，改表两路一起变）：
 *   A. 所有节点：`pinNodeWidth` 在 onNodeCreated 里把**新建节点**的宽度钉成 w；
 *      `w: null` 的（按文字算宽的标签类）不钉。
 *   B. `own: true` 的节点：它自己 `web/<节点>/index.js` 里的最小宽 / 布局常量
 *      也改成 `sizeFor("QG_Xxx")` 取值，所以拖到多窄也跟着表走。
 *
 * 🔴 「钉宽」只发生在新建那一刻。节点自己通常只把宽度当**最小宽**用（`minNodeSize`），
 * 初始宽仍由 LiteGraph 的默认值给 —— 所以不钉的话，表里把 300 改成 260 会出现
 * 「表变了、节点还是 270」的假象（实测踩过）。
 *
 * 🔴 只影响新建：存档里已有宽度的节点由 onConfigure 覆盖回来，不动用户手调过的尺寸。
 */

import { chainCallback } from "./index.mjs?v=2026102706";

export const SIZES = {
    // ══════════════════════════════════════════════════════════════
    // A 组：没有自己的尺寸逻辑，宽度照表钉
    // ══════════════════════════════════════════════════════════════

    // —— 270：主体宽度，一屏并排最整齐 ——
    QG_ColorCorrect: { w: 270, minW: 140, h: 178, minH: 178 },
    QG_ColorMatch: { w: 270, minW: 140, h: 286, minH: 286 },
    QG_EmptyLatentResolution: { w: 210, minW: 140, h: 194, minH: 194 },
    QG_Exists: { w: 210, minW: 140, h: 46, minH: 46 },
    QG_FreeMemory: { w: 210, minW: 140, h: 26, minH: 26 },
    QG_IfElse: { w: 210, minW: 140, h: 78, minH: 78 },
    QG_ImageGrid: { w: 270, minW: 140, h: 130, minH: 130 },
    QG_ImageOrLatentSize: { w: 210, minW: 140, h: 46, minH: 46 },
    QG_ImageResize: { w: 270, minW: 140, h: 194, minH: 194 },
    QG_ImageWatermark: { w: 270, minW: 140, h: 314, minH: 314 },
    QG_MaskColorize: { w: 270, minW: 140, h: 98, minH: 98 },
    QG_MaskConcat: { w: 270, minW: 140, h: 102, minH: 102 },
    QG_MaskRefine: { w: 270, minW: 140, h: 270, minH: 270 },
    QG_RouteBlocker: { w: 210, minW: 140, h: 82, minH: 82 },
    QG_SizeSelector: { w: 270, minW: 140, h: 310, minH: 310 },
    QG_TextConcat: { w: 270, minW: 140, h: 78, minH: 78 },
    QG_TextOverlayImage: { w: 270, minW: 140, h: 252, minH: 252 },
    QG_TextReplace: { w: 270, minW: 140, h: 202, minH: 202 },

    // —— 400：带多行输入框，270 打不动字 ——
    QG_GoogleTranslateText: { w: 270, minW: 140, h: 200, minH: 200 },
    QG_TextEditOutput: { w: 400, minW: 140, h: 200, minH: 200 },  // 显示名「文本」
    QG_TextSplit: { w: 270, minW: 140, h: 272, minH: 272 },
    QG_StringSwitch: { w: 270, minW: 140, h: 200, minH: 200 },

    // ══════════════════════════════════════════════════════════════
    // B 组：自带布局，宽度 / 最小宽由节点自己从表里读
    // ══════════════════════════════════════════════════════════════

    QG_AnySwitch: { w: 210, minW: 140, h: 46, minH: 46, own: true },  // 胶囊开关，宽度跟内容走
    QG_BoolToggle: { w: 210, minW: 210, h: 58, minH: 58, own: true },  // 整张节点就是一枚开关
    QG_Number: { w: 210, minW: 210, h: 96, minH: 60, own: true },  // 一行「值」+ 可拖数字框
    QG_Slider: { w: 270, minW: 270, h: 58, minH: 58, own: true },  // 经典模式 canvas 自绘 320×58
    QG_Math: { w: 270, minW: 270, h: 156, minH: 60, own: true },  // 表达式行 + 两行变量
    QG_DisplayAny: { w: 270, minW: 250, h: 270, minH: 96, own: true },  // 预览区跟着图片比例
    QG_ExportImage: { w: 430, minW: 270, h: 645, minH: 22, own: true },  // 概要行布局
    QG_ImageCompare: { w: 430, minW: 220, h: 645, minH: 220, own: true },  // 对比台
    QG_ImageCropRotatePad: { w: 430, minW: 330, h: 696, minH: 456, own: true },  // 高度随预览图比例浮动（692~726）,  // 三个并列面板
    QG_LoadImage: { w: 430, minW: 250, h: 645, minH: 312, own: true },  // 选择行 + 舞台 + 底栏，2:3
    QG_LoraLoader: { w: 430, minW: 320, h: 202, minH: 160, own: true },  // LoRA 面板
    QG_MDReader: { w: 400, minW: 140, h: 360, minH: 360, own: true },  // 文档预览（最小宽不额外限制）
    QG_RunTimer: { w: 176, minW: 110, h: 56, minH: 35, own: true },  // 计时器卡片
    QG_Seed: { w: 320, minW: 300, h: 216, minH: 120, own: true },  // 种子卡片
    QG_TripleLoader: { w: 430, minW: 140, h: 210, minH: 210, own: true },  // 三联加载器，与 LoRA 加载器等宽
    QG_WorkflowNote: { w: 520, minW: 300, h: 620, minH: 120, own: true },  // 说明卡
    QG_WorkflowSwitches: { w: 300, minW: 210, h: 134, minH: 60, own: true },  // 开关条

    // —— 宽度跟文字算，表里写 null，谁都不许钉 ——
    QG_CanvasLabel: { w: null, own: true, h: 26 },  // 画布标签
    QG_MarkdownNote: { w: null, own: true, h: 32 },  // Markdown 便签
};

/** 不在表里的节点用这个（新节点忘了登记也有兜底）。 */
export const DEFAULT_WIDTH = 270;
export const DEFAULT_MIN_WIDTH = 220;

/** 这个节点在表里的原始条目；没有就是 null。 */
export function entryFor(nodeName) {
    if (!nodeName) return null;
    return SIZES[nodeName] ?? null;
}

/**
 * 取默认尺寸：`{ w, minW, h }`。
 * 表里没有的 QG_ 节点退回 `DEFAULT_WIDTH`；`w: null` 原样返回（宽度跟内容算）。
 */
export function sizeFor(nodeName) {
    if (!nodeName || !String(nodeName).startsWith("QG_")) {
        return { w: null, minW: null, h: null, minH: null };
    }
    const entry = SIZES[nodeName];
    if (!entry) return { w: DEFAULT_WIDTH, minW: DEFAULT_MIN_WIDTH, h: null, minH: null };
    const w = entry.w ?? null;
    return {
        w,
        minW: entry.minW ?? w ?? DEFAULT_MIN_WIDTH,
        h: entry.h ?? null,
        minH: entry.minH ?? null,
    };
}

/** 这个节点该钉多宽；返回 null = 不碰（表里 w 为 null，即宽度跟内容算）。 */
export function widthFor(nodeName) {
    const { w } = sizeFor(nodeName);
    if (!w) return null;
    return w;
}

/** 这个节点允许拖到的最小宽。 */
export function minWidthFor(nodeName) {
    return sizeFor(nodeName).minW;
}

/** 这个节点写死的默认高；没填就是 null，高度交给节点自己算。 */
export function heightFor(nodeName) {
    return sizeFor(nodeName).h;
}

/**
 * 把尺寸钉在 nodeType 上：新建时按表设宽高，并守住最小宽高。
 *
 * 三件事：
 *   1. **默认宽 / 默认高**：onNodeCreated 末尾一次性设好（覆盖节点自己给的临时尺寸）；
 *   2. **最小宽 / 最小高**：写 `minWidth` / `minHeight` 给 LiteGraph 自己的拖拽夹取用，
 *      同时追加一层 `onResize` 兜底 —— 只加严不降低，节点自带的硬地板（`minNodeSize`）更大时听它的；
 *   3. `w: null` 的节点（宽度按文字算）整条跳过。
 *
 * 🔴 只影响新建：存档里已有尺寸的节点由 onConfigure 覆盖回来，不动用户调过的尺寸。
 */
export function pinNodeSize(nodeType, nodeData) {
    const { w, h, minW, minH } = sizeFor(nodeData?.name);
    if (!w) return;

    const clamp = (node) => {
        if (minW && node.size[0] < minW) node.size[0] = minW;
        if (minH && node.size[1] < minH) node.size[1] = minH;
    };

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        if (typeof this.size?.[0] === "number" && Math.abs(this.size[0] - w) > 0.5) {
            this.size[0] = w;
        }
        if (h && typeof this.size?.[1] === "number" && Math.abs(this.size[1] - h) > 0.5) {
            this.size[1] = h;
        }
        // 只加严：节点自己（widget 的 minNodeSize）已经给了更大的地板就听它的
        if (minW) this.minWidth = Math.max(Number(this.minWidth) || 0, minW);
        if (minH) this.minHeight = Math.max(Number(this.minHeight) || 0, minH);
        this.setDirtyCanvas?.(true, true);
    });

    // LiteGraph 各版本对 minWidth / minHeight 的处理不一致（有的只在拖拽时读，setSize 不读），
    // 所以既写属性给拖拽用，也在 setSize / onResize 之后直接把 size 夹回来。
    // 🔴 chainCallback 是**后置**执行（原函数跑完再跑我们的），所以这里改的是 this.size，不是参数。
    chainCallback(nodeType.prototype, "onResize", function () {
        if (Array.isArray(this.size)) clamp(this);
    });
    chainCallback(nodeType.prototype, "setSize", function () {
        if (Array.isArray(this.size)) clamp(this);
    });
}

/** 旧名，保持调用方不变。 */
export const pinNodeWidth = pinNodeSize;

// 调试用：探针（tools/_probe_verify_sizes.cjs）直接读这张表做比对。
// `__QG_SIZE_TABLE__` 是给外部插件读的公开名字 —— ComfyUI-QG-NodeMeasure
// （右键「测量尺寸」）靠它显示节点的「默认」尺寸，没装 QG-tools 时那一行自动降级。
// 同一个对象挂两个名字，省得两边口径不一。
globalThis.__QG_SIZES__ = SIZES;
globalThis.__QG_SIZE_TABLE__ = SIZES;

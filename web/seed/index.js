/**
 * QG Seed — 种子控制（前端）
 *
 * Ported from rgthree-comfy (py/seed.py), MIT, authored by rgthree.
 * Renamed to the QG_ prefix and moved under web/<feature>/ per this pack.
 *
 * 作用：seed 取 -1 / -2 / -3 时的「随机 / 递增 / 递减」在前端按队列生成，
 * 这样每次入队的 prompt 里 seed 都是具体数值，ComfyUI 的执行缓存不会
 * 复用上一次的结果（这正是 rgthree 把随机值放到前端的理由）。
 *
 * 实现：
 *  - 包装 app.queuePrompt：序列化之前把各 QG_Seed 节点的哨兵值替换成具体种子，
 *    序列化之后（finally）还原成 -1/-2/-3，节点上看到的仍是模式而非一串数字；
 *  - -2 / -3 的递增/递减用节点上的计数器 node._qgSeedSeq 维护，跨队列连续；
 *  - 三个快捷按钮（对齐 rgthree 原版）：
 *      「🎲 每次随机」= 把 seed 设回 -1（每次入队都随机）；
 *      「🎲 重新生成」= 掷一个新的固定种子（原版 New Fixed Random）；
 *      「♻️ 用上次入队的种子」= 回填上一次实际入队的种子；每次入队后按钮
 *        label 会变成 ♻️+该种子，一眼可查、一点可复现（原版 Use Last Queued Seed）。
 */

import { app } from "/scripts/app.js";

const NODE_CLASS = "QG_Seed";
const SEED_MAX = 1125899906842624;
const SEED_RANDOM = -1;
const LAST_SEED_LABEL = "♻️ 用上次入队的种子";

function randSeed() {
    return Math.floor(Math.random() * SEED_MAX) + 1;
}

/** 按节点维护的序列计数器（仅 -2/-3 用到）。 */
function nextSeq(node) {
    if (node._qgSeedSeq == null) node._qgSeedSeq = randSeed();
    return node._qgSeedSeq;
}

/**
 * 把哨兵值翻译成这一次入队要用的具体种子。
 *   -1 -> 随机
 *   -2 -> 序列 +1
 *   -3 -> 序列 -1
 */
function rollValue(node, v) {
    if (v === -1) return randSeed();
    if (v === -2) {
        node._qgSeedSeq = nextSeq(node) + 1;
        return node._qgSeedSeq;
    }
    if (v === -3) {
        node._qgSeedSeq = nextSeq(node) - 1;
        return node._qgSeedSeq;
    }
    return v;
}

// 包装 queuePrompt：序列化前替换哨兵，序列化后还原，确保 prompt 拿到具体值、
// 而节点上仍显示模式（-1/-2/-3）。同时把本次实际用的种子记到节点上，
// 供「♻️ 用上次入队的种子」按钮回填。
const origQueue = app.queuePrompt ? app.queuePrompt.bind(app) : null;
if (origQueue) {
    app.queuePrompt = async function (...args) {
        const rollbacks = [];
        for (const node of app.graph?._nodes || []) {
            if (node?.type !== NODE_CLASS) continue;
            const w = node.widgets?.find((x) => x.name === "seed");
            if (w && w.value < 0) {
                const prev = w.value;
                const used = rollValue(node, w.value);
                w.value = used;
                node._qgLastSeed = used;
                rollbacks.push(() => {
                    w.value = prev;
                });
                // 用还原前的持久值比较：哨兵入队后按钮应显示实际种子。
                updateLastSeedButton(node, used, prev);
            } else if (w) {
                // 固定种子也记一下，保持「上次入队种子」语义与原版一致。
                node._qgLastSeed = w.value;
                updateLastSeedButton(node, w.value, w.value);
            }
        }
        try {
            return await origQueue(...args);
        } finally {
            rollbacks.forEach((fn) => fn());
        }
    };
}

/** 入队后刷新「♻️」按钮：与节点上的持久值不同时显示具体种子，相同则显示原始文案。 */
function updateLastSeedButton(node, used, persisted) {
    const btn = node._qgLastSeedBtn;
    if (!btn) return;
    btn.label = used !== persisted ? `♻️ ${used}` : LAST_SEED_LABEL;
}

app.registerExtension({
    name: "QG.Seed",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const w = this.widgets?.find((x) => x.name === "seed");
            // 摘掉 ComfyUI 对名为 seed 的控件自动附加的「生成后控制」行：
            // 它的模式（fixed/increment/decrement/randomize）和本节点的三个按钮
            // 完全重复，队列后还会与哨兵还原逻辑抢写控件值。rgthree 原版同样处理。
            // 旧工作流多存的那一格值会落到按钮上（serialize:false，无副作用）。
            const ctrlIdx = this.widgets?.findIndex((x) => x.name === "control_after_generate") ?? -1;
            if (ctrlIdx >= 0) this.widgets.splice(ctrlIdx, 1);
            // 新建节点默认「每次随机」（对齐 rgthree 原版）；加载旧工作流时
            // configure() 会用存档值覆盖，不受影响。
            if (w) w.value = SEED_RANDOM;
            // 创建期写入的中文按钮文案，汉化插件整串匹配即可，不用 zh()。
            // serialize:false —— 按钮不入 workflow 存档（对齐 rgthree）。
            this.addWidget("button", "🎲 每次随机", null, () => {
                if (w) w.value = SEED_RANDOM;
            }, { serialize: false });
            this.addWidget("button", "🎲 重新生成", null, () => {
                if (w) w.value = randSeed();
            }, { serialize: false });
            const lastBtn = this.addWidget("button", LAST_SEED_LABEL, null, () => {
                if (w && this._qgLastSeed != null) w.value = this._qgLastSeed;
            }, { serialize: false });
            this._qgLastSeedBtn = lastBtn;
            return r;
        };
    },
});

console.log("[QG-tools] seed front end ready");

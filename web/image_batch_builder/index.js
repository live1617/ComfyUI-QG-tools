/**
 * QG 图像批次组合 — 动态输入槽扩展（前端）
 *
 * 搬入说明（2026-11-25，用户确认后搬运）
 *   来源：自有插件 ComfyUI-QG-Multipack v2.22.13 / web/qg_image_batch_builder.js
 *   改了什么：
 *     1) 扩展名 QG.Multipack.ImageBatchBuilder -> QG.ImageBatchBuilder
 *        （本包扩展一律不带产品线前缀）；
 *     2) 槽位标签改走 zhPair，中英文界面各显示各的；
 *     3) 控制台前缀改 [QG-tools]。
 *   保持不变：全部槽同步算法 —— 接一个加一槽、断开末尾空槽收起、上限 24、
 *   已连线的槽绝不删、按工作流存档恢复时不覆盖用户拉过的尺寸。
 *
 * 交互：
 * - 后端声明了 24 个 optional IMAGE 槽（V3 的 io.Schema 直接序列化 inputs，
 *   没有源包那种「只列一条却接受任意名字」的覆写点，所以这里靠前端控制显示）。
 * - 节点默认只显示 1 个 IMAGE 输入槽（image_01）。
 * - 给最后一个槽接上图后，自动在后面追加 1 个空槽，即「接一个加一槽」。
 * - 最少保留 1 个槽；最多 24 个（与后端 SLOT_COUNT 一致，一版 A4 拼版上限）。
 * - 断开末尾槽的连线会收起多余空槽，画布随之更新。
 *
 * 有意加固：
 * - sync 用 requestAnimationFrame 防抖，避免 onConnectionsChange 里同步增删槽
 *   引发的重入；三处生命周期（created / connections / configure）都触发。
 * - onConfigure 也同步，保证从工作流存档恢复时槽数按连接情况重建，不残留
 *   存档里那一大串空槽。
 * - resize_mode 是控件（widget），不在 node.inputs 里，本扩展只碰 image_XX
 *   槽，不影响它。
 */
import { app } from "/scripts/app.js";
import { zhPair } from "../shared/zh.mjs?v=202611251300";

const NODE_NAME = "QG_ImageBatchBuilder";
const MAX_IMAGES = 24;
const imageName = (index) => `image_${String(index + 1).padStart(2, "0")}`;

const isImageInput = (slot) => /^image_\d+$/.test(String(slot?.name || ""));
const connected = (slot) => slot?.link != null;

function imageInputs(node) {
    return (node.inputs || [])
        .map((slot, index) => ({ slot, index }))
        .filter(({ slot }) => isImageInput(slot));
}

function syncImageInputs(node) {
    let inputs = imageInputs(node);

    // 上限保护：存档里可能带超过 24 个槽，先收掉末尾未连接的。
    // 遇到已连接的槽就停 —— 原来的写法不看连接状态直接删，带 25 个以上
    // 已连线输入的工作流会被静默砍掉末尾的图，执行时少图且没有任何提示。
    while (inputs.length > MAX_IMAGES) {
        const last = inputs[inputs.length - 1];
        if (connected(last.slot)) break;
        node.removeInput(last.index);
        inputs = imageInputs(node);
    }

    if (!inputs.length) {
        node.addInput(imageName(0), "IMAGE");
        inputs = imageInputs(node);
    }

    // 「接一个加一槽」：目标槽数 = 最后已连接槽的下标 + 2（保留 1 个空槽）。
    // 从未连接时 lastConnected=-1 → 目标 1 个槽。
    let lastConnected = -1;
    inputs.forEach(({ slot }, index) => {
        if (connected(slot)) lastConnected = index;
    });
    const targetCount = Math.min(MAX_IMAGES, Math.max(1, lastConnected + 2));

    // 收起末尾多余的空槽（已连接的槽绝不删）。
    while (inputs.length > targetCount) {
        const last = inputs[inputs.length - 1];
        if (connected(last.slot)) break;
        node.removeInput(last.index);
        inputs = imageInputs(node);
    }
    // 补足到目标槽数。
    while (inputs.length < targetCount) {
        node.addInput(imageName(inputs.length), "IMAGE");
        inputs = imageInputs(node);
    }

    inputs.forEach(({ slot }, index) => {
        slot.label = zhPair(`Image ${index + 1}`, `第 ${index + 1} 张`);
        slot.type = "IMAGE";
    });
    node.setDirtyCanvas?.(true, true);
}

/**
 * 让节点高度贴合当前实际槽数。
 *
 * 后端声明了 24 个可选 IMAGE 槽，ComfyUI 建节点时按 24 槽算出初始高度，
 * 动态槽扩展随后删到只剩 1 个，高度却留在那儿 —— 表现就是一大片空白。
 *
 * 两条铁律：
 * - 工作流里加载的节点（onConfigure 打过 _qgSizeFromWorkflow）尺寸是用户
 *   拉过的，一律不动，否则就是「调好大小 → 存盘 → 重开又变回默认」。
 * - 新建节点按 computeSize() 的自然高度收紧；接线加槽时只增高不减高，
 *   保证新槽不会掉到节点外面。
 */
function fitNodeHeight(node, initial) {
    if (node._qgSizeFromWorkflow) return;
    try {
        const width = node.size?.[0] || 300;
        const natural = node.computeSize?.([width, 0]);
        const currentH = node.size?.[1] || 0;
        if (!natural || !Number.isFinite(natural[1]) || natural[1] <= 40) return;
        // 新建时收紧到自然高度；接线时只增高，避免用户拉过的高度被压回去。
        const targetH = initial ? natural[1] : Math.max(currentH, natural[1]);
        if (Math.abs(targetH - currentH) > 8) {
            node.setSize([width, targetH]);
            node.setDirtyCanvas?.(true, true);
        }
    } catch (err) {
        /* 老前端没有 computeSize 就保持原样，不影响槽增删 */
    }
}

function scheduleSync(node, initial = false) {
    if (node._qgBatchBuilderSyncPending) return;
    node._qgBatchBuilderSyncPending = true;
    requestAnimationFrame(() => {
        node._qgBatchBuilderSyncPending = false;
        syncImageInputs(node);
        fitNodeHeight(node, initial);
    });
}

app.registerExtension({
    name: "QG.ImageBatchBuilder",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        // configure 打「尺寸来自工作流」标记，晚于它的 requestAnimationFrame 里
        // fitNodeHeight 见标记就跳过，绝不覆盖用户拉过的尺寸。
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalConfigure?.apply(this, args);
            this._qgSizeFromWorkflow = true;
            scheduleSync(this);
            return result;
        };

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalCreated?.apply(this, args);
            // 只有新建节点（没有 configure 标记）才收紧高度。
            scheduleSync(this, true);
            return result;
        };

        const originalConnections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = originalConnections?.apply(this, args);
            scheduleSync(this);
            return result;
        };
    },
});

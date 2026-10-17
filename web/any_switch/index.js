// -*- coding: utf-8 -*-
// QG Any Switch front end.
// Ported from Goohaitools-comfyui (goohai_any_switch.js), GPL-3.0. Original by 孤海 (Goohaitools).
// Adds dynamic grow/shrink of the input slots, keeps a stable slot priority,
// and specializes the slot type to the connected input type so links validate.

import { app } from "/scripts/app.js";

const MAX_INPUTS = 16;
const MIN_INPUTS = 2;
// 🔴 node.size 只算「节点主体」，标题栏是画在主体上方的另外 30px，不含在里面。
// 之前把 NODE_HEADER_HEIGHT 加进高度，等于给主体白送一整条标题的高度，
// 两个槽位的节点底下就多出一大块空白。这里直接对齐 LiteGraph 自己的
// computeSize()：主体高 = 槽位数 * 20 + 6（原生节点就是这个数）。
const INPUT_ROW_HEIGHT = 20;
const BOTTOM_PADDING = 6;
const INITIAL_HEIGHT = MIN_INPUTS * INPUT_ROW_HEIGHT + BOTTOM_PADDING;
const INITIAL_SIZE = [240, INITIAL_HEIGHT];
const slotName = (index) => `any_${String(index + 1).padStart(2, "0")}`;
const slotNumber = (index) => String(index + 1).padStart(2, "0");
const heightForInputCount = (count) =>
  Math.max(MIN_INPUTS, Number(count) || 0) * INPUT_ROW_HEIGHT + BOTTOM_PADDING;
const validSize = (size) => {
  const width = Array.isArray(size) || ArrayBuffer.isView(size) ? size[0] : size?.width;
  const height = Array.isArray(size) || ArrayBuffer.isView(size) ? size[1] : size?.height;
  return Number.isFinite(Number(width)) &&
    Number.isFinite(Number(height)) &&
    Number(width) > 0 &&
    Number(height) > 0
    ? [Number(width), Number(height)]
    : null;
};

app.registerExtension({
  name: "QG.AnySwitch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "QG_AnySwitch") {
      return;
    }

    const labels = {
      IMAGE: "图像",
      VIDEO: "视频",
      AUDIO: "音频",
      MASK: "遮罩",
      LATENT: "latent",
      MODEL: "模型",
      CLIP: "CLIP",
      CLIP_VISION: "视觉编码器",
      CLIP_VISION_OUTPUT: "视觉编码输出",
      VAE: "VAE",
      CONDITIONING: "条件",
      CONDITION: "条件",
      CONTROL_NET: "控制网络",
      STYLE_MODEL: "风格模型",
      GLIGEN: "布局控制",
      UPSCALE_MODEL: "放大模型",
      GUIDER: "引导器",
      SAMPLER: "采样器",
      SIGMAS: "噪声调度",
      SIGMA: "噪声参数",
      NOISE: "噪声",
      TENSOR: "张量",
      COMBO: "组合选项",
      IMAGE_BATCH: "图像批次",
      MASK_BATCH: "遮罩批次",
      LATENT_BATCH: "潜空间批次",
      LIST: "列表",
      STRING: "字符串",
      INT: "整数",
      FLOAT: "浮点",
      BOOLEAN: "布尔",
      BBOX: "边界框",
      SEGS: "分割区域",
      FACE_ANALYSIS: "人脸分析",
      ANY: "any",
    };

    const connected = (slot) => slot?.link != null;

    const getConnectedType = function () {
      const types = new Set();
      for (const slot of this.inputs || []) {
        if (!connected(slot)) {
          continue;
        }
        const link = this.graph?.links?.[slot.link];
        const origin = link && this.graph?.getNodeById?.(link.origin_id);
        const output = origin?.outputs?.[link.origin_slot];
        const type = output?.type && String(output.type).toUpperCase();
        if (type && type !== "*" && type !== "ANY") {
          types.add(type);
        }
      }
      // A mixed graph is left as ANY in the UI. The backend performs the
      // definitive type check and reports the conflicting input types.
      return types.size === 1 ? [...types][0] : "ANY";
    };

    const sync = function () {
      let slots = this.inputs || [];

      // A copied/restored node can contain stale trailing inputs. Hard cap
      // the visible slots so repeated lifecycle events can never grow it.
      while (slots.length > MAX_INPUTS) {
        this.removeInput(slots.length - 1);
        slots = this.inputs || [];
      }

      let lastConnected = -1;
      slots.forEach((slot, index) => {
        if (connected(slot)) {
          lastConnected = index;
        }
      });

      const target = Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, lastConnected + 2));

      // Only trailing empty slots are removed. A gap in the middle keeps
      // its original position so backend priority remains stable.
      while ((this.inputs || []).length > target) {
        const index = this.inputs.length - 1;
        if (connected(this.inputs[index])) {
          break;
        }
        this.removeInput(index);
      }
      while ((this.inputs || []).length < target) {
        const index = this.inputs.length;
        this.addInput(slotName(index), "*");
      }

      slots = this.inputs || [];
      const type = getConnectedType.call(this);
      const slotType = type === "ANY" ? "*" : type;

      slots.forEach((slot, index) => {
        // `name` is the serialized/backend key and must never change.
        // Type-specific text belongs only in the visible label.
        slot.name = slotName(index);
        slot.label = type === "ANY" ? slot.name : `${labels[type] || type}_${slotNumber(index)}`;
        slot.type = slotType;
      });

      const output = this.outputs?.[0];
      if (output) {
        output.name = "any";
        output.label = type === "ANY" ? "any" : (labels[type] || type);
        output.type = slotType;
      }

      // 手动选的宽度保留，高度按当前槽位数重算（主体高 = 槽位数 * 20 + 6，
      // 与原生 computeSize() 一致；标题栏不占 size，见文件顶部说明）。
      const currentWidth =
        Number(this._qgAnySwitchRestoreWidth) ||
        Number(this.size?.[0]) ||
        INITIAL_SIZE[0];
      this.setSize?.(([currentWidth, heightForInputCount(slots.length)]));
      this._qgAnySwitchRestoreWidth = null;

      this.setDirtyCanvas?.(true, true);
    };

    const scheduleSync = function () {
      if (this._qgAnySwitchSyncScheduled) {
        return;
      }
      this._qgAnySwitchSyncScheduled = true;
      requestAnimationFrame(() => {
        this._qgAnySwitchSyncScheduled = false;
        sync.call(this);
      });
    };

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      // Keep newly created nodes compact. onConfigure can subsequently
      // restore a deliberately saved width from an existing workflow.
      if (!this._qgAnySwitchInitialized) {
        this.setSize?.(INITIAL_SIZE);
        this._qgAnySwitchInitialized = true;
      }
      // Do not remove inputs synchronously here: onConfigure may still be
      // restoring serialized links. The idempotent sync below handles both
      // a fresh node and a restored/copied node after that lifecycle step.
      scheduleSync.call(this);
    };

    const originalConnections = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      originalConnections?.apply(this, arguments);
      scheduleSync.call(this);
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (config) {
      originalConfigure?.apply(this, arguments);
      const savedSize = validSize(config?.size);
      if (savedSize) {
        this._qgAnySwitchRestoreWidth = savedSize[0];
      }
      scheduleSync.call(this);
    };
  },
});

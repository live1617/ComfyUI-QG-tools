# -*- coding: utf-8 -*-
"""QG_MaskOrderFilter — sort / group / filter a mask batch, output segs + mask.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_mask_order_filter.py
        功能规格参考 Goohaitools「孤海-Seg次序过滤」（GPL-3.0），代码为独立实现。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Mask``；显示名与 DESCRIPTION 英化；
    3) 🔴 **六个输入名与两组下拉值全部英化**（源包是中文键 + 中文值）：
       优先规则->priority（面积大小/宽度大小/高度大小/上下左右/下上左右
       -> area/width/height/top_down/bottom_up）、正反顺序->direction
       （正序/反序 -> forward/reverse）、开始索引->start_index、
       过滤数量->count、分组阈值->group_threshold、重叠因子->overlap、
       合并遮罩->merge_mask。老存档的中文值由 nodes/_qg_combo_legacy.py
       的 LEGACY 表 + 本文件的 coerce() 兜住；
    4) ``QG_SEGS`` 容器改成从 ``nodes/_qg_segs.py`` 导入（那个文件从源包
       检测节点里抽出，只依赖 numpy，类型字符串保持一致）；
    5) 报错信息英化。
  保持不变：全部排序/分组/去重/合并算术 —— 面积与外接框由非零像素行列下标
  直接求出、X 分组拿组首当基准、超出尾部从头循环取满、合并取逐像素最大值、
  一段都没选中时兜底一帧全 0。

双输出顺序与上游一致：segs 在上、MASK 在下。
"""

from __future__ import annotations

import numpy as np
import torch

from comfy_api.latest import io

from ._qg_combo_legacy import coerce
from ._qg_segs import QGSeg, QGSegs, SEGS_TYPE

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
PRIORITY_RULES = ["area", "width", "height", "top_down", "bottom_up"]
DIRECTIONS = ["forward", "reverse"]
_VALID_CUT = 0.1

# 这几个名字在原包是中文，英化后 old 值仍要能被 coerce() 认出来。
_NODE_ID = "QG_MaskOrderFilter"


def _to_numpy(mask):
    """把 MASK 转成 numpy float32。

    ComfyUI 原生 MASK 是 torch.Tensor，但本包自造检测节点以及其他第三方插件
    可能直接给 numpy.ndarray；这里统一规整，避免在上游给 ndarray 时调用
    ``.detach()`` 报 AttributeError。
    """
    if isinstance(mask, torch.Tensor):
        return mask.detach().cpu().numpy().astype(np.float32, copy=False)
    return np.asarray(mask, dtype=np.float32)


def _as_bhw(mask):
    """把 MASK 规整成 ``[B, H, W]`` 的 numpy 数组；返回 (batch, 是否原本二维)。"""
    arr = _to_numpy(mask)
    if arr.ndim == 2:
        return arr[None, ...], True
    if arr.ndim == 3:
        return arr, False
    return arr.reshape(-1, arr.shape[-2], arr.shape[-1]), False


def _frame_feature(plane):
    """单帧 ``[H, W]`` 的面积与外接框；空遮罩返回 0 与全零框。"""
    active = np.asarray(plane, dtype=np.float32) > _VALID_CUT
    ys, xs = np.nonzero(active)
    if ys.size == 0:
        return 0.0, (0, 0, 0, 0)
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    return float(ys.size), (x1, y1, x2, y2)


def _iou(a, b):
    """两个 ``(x1, y1, x2, y2)`` 框的交并比；空框视为 0。"""
    if a[2] <= a[0] or a[3] <= a[1] or b[2] <= b[0] or b[3] <= b[1]:
        return 0.0
    inter_w = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    inter_h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = inter_w * inter_h
    if inter == 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / float(area_a + area_b - inter)


def _group_by_x(items, threshold):
    """按外接框左边界 x1 分组：与**本组第一个段**的 x1 相差不超过阈值的归为一组。

    必须拿组首当基准，不能拿「上一个段」当基准：后者是链式聚合，间距为
    0/100/200、阈值 120 时会一路传递成一整组，把横排的人物全并进同一列，
    「上下左右」于是退化成纯纵向排序。组首基准下 0/100 同组、200 另起一组，
    与「X 坐标相差不超过该像素数算同一列」的字面语义一致。
    """
    ordered = sorted(items, key=lambda it: it["bbox"][0])
    groups, current, anchor_x = [], [], None
    for item in ordered:
        x1 = item["bbox"][0]
        if anchor_x is None:
            anchor_x = x1          # 第一段就是本组基准，漏这一步会全程不分组
        if abs(x1 - anchor_x) <= threshold:
            current.append(item)
        else:
            groups.append(current)
            current, anchor_x = [item], x1
    if current:
        groups.append(current)
    return groups


def order_segments(frames, rule="top_down", direction="forward",
                   group_threshold=120, metas=None):
    """对 ``[np.ndarray, ...]`` 单帧列表排序，返回带面积/框的新列表（不改入参）。

    metas 可选：与 frames 等长的原段对象，透传到 ``meta`` 字段供 Seg 输出复用。
    """
    items = []
    for index, plane in enumerate(frames):
        area, bbox = _frame_feature(plane)
        item = {"plane": plane, "area": area, "bbox": bbox}
        if metas is not None and index < len(metas):
            item["meta"] = metas[index]
        items.append(item)

    # descending：正向（forward）时面积/宽高从大到小，这是上游的口径。
    descending = direction != "reverse"
    if rule == "area":
        items.sort(key=lambda it: it["area"], reverse=descending)
    elif rule == "width":
        items.sort(key=lambda it: it["bbox"][2] - it["bbox"][0], reverse=descending)
    elif rule == "height":
        items.sort(key=lambda it: it["bbox"][3] - it["bbox"][1], reverse=descending)
    elif rule in ("top_down", "bottom_up"):
        groups = _group_by_x(items, max(0, int(group_threshold)))
        groups.sort(key=lambda g: float(np.mean([it["bbox"][0] for it in g])))
        flat = []
        for group in groups:
            if rule == "top_down":
                group.sort(key=lambda it: it["bbox"][1])       # y1 小在上
            else:
                group.sort(key=lambda it: it["bbox"][3], reverse=True)  # y2 大在下
            flat.extend(group)
        items = list(reversed(flat)) if not descending else flat
    return items


def select_segments(items, start=0, count=1, overlap=0.0):
    """按开始索引/数量截取，并按重叠因子做 bbox IoU 去重。"""
    if not items:
        return []
    start = max(0, int(start))
    count = max(0, int(count))
    if count == 0:
        chosen = list(items[start:])
    else:
        # 超出尾部时从头循环取，保证「过滤数量」总能取满（对齐上游行为）
        chosen = [items[(start + i) % len(items)] for i in range(count)]
    if overlap <= 0:
        return chosen
    kept = []
    for item in chosen:
        if any(_iou(item["bbox"], other["bbox"]) > overlap for other in kept):
            continue
        kept.append(item)
    return kept


def merge_segments(items, height, width, merge=True):
    """合并输出：merge=True 取逐像素最大值输出 [H,W]；否则堆叠成 [B,H,W]。

    一段都没选中时**兜底 1 帧全 0**（逐帧模式）或一张全 0 遮罩（合并模式）：
    输出 0 帧虽然更贴近「什么都没选中」，但预览/保存类节点拿到 ``[0,H,W]``
    会直接异常，而一张全 0 遮罩在下游是无害的（上色不上、分段为空）。
    """
    if not items:
        empty = np.zeros((height, width), dtype=np.float32)
        return empty if merge else empty[None, ...]
    planes = [np.asarray(it["plane"], dtype=np.float32) for it in items]
    if merge:
        out = np.zeros((height, width), dtype=np.float32)
        for plane in planes:
            np.maximum(out, plane, out=out)
        return out
    return np.stack(planes, axis=0)


def _build_segs(items, width, height):
    """把筛选后的段打包成 QG_SEGS 容器；有原段元数据时尽量保留。

    参数顺序与 ``QGSegs(segs, width, height)`` 一致：先宽后高。传反了不会
    报错，只会在空段时暴露成 width/height 互换（combined_mask 的形状是
    (height, width)，互换后尺寸就是错的）。
    """
    parts = []
    for item in items:
        meta = item.get("meta")
        plane = np.asarray(item["plane"], dtype=np.float32)
        if meta is not None:
            bbox = getattr(meta, "bbox", item["bbox"])
            label = getattr(meta, "label", "")
            score = getattr(meta, "score", 1.0)
            crop_factor = getattr(meta, "crop_factor", 3.0)
        else:
            bbox, label, score, crop_factor = item["bbox"], "", 1.0, 3.0
        parts.append(QGSeg(bbox, label, score, plane, crop_factor))
    return QGSegs(parts, width, height)


class QGMaskOrderFilter(io.ComfyNode):
    """Sort, group, filter and merge a mask batch."""

    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Sort, group, filter and merge a mask batch. Each mask frame counts as "
        "one segment. Order by area, width, height, or left-to-right columns "
        "read top-down or bottom-up; pick a slice by start index and count; "
        "drop overlapping boxes by IoU; merge by pixel-wise maximum or keep the "
        "frames separate. Also accepts QG_SEGS on the segs input and keeps each "
        "segment's box, label and score."
    )
    SEARCH_ALIASES = [
        "mask", "order", "sort", "filter", "segs", "次序", "排序", "遮罩",
        "过滤", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=_NODE_ID,
            display_name="Mask Order Filter",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Combo.Input(
                    "priority",
                    options=list(PRIORITY_RULES),
                    default="top_down",
                    tooltip=(
                        "area/width/height: forward runs large to small. "
                        "top_down: group by X into columns, columns left to "
                        "right, and inside a column top to bottom. bottom_up: "
                        "same columns, but inside a column bottom to top."
                    ),
                ),
                io.Combo.Input(
                    "direction",
                    options=list(DIRECTIONS),
                    default="forward",
                    tooltip=(
                        "forward follows the rule's natural direction; reverse "
                        "flips the whole result."
                    ),
                ),
                io.Int.Input(
                    "start_index",
                    default=0, min=0, max=4096, step=1,
                    tooltip="Which position in the sorted list to start from, counting up from 0.",
                ),
                io.Int.Input(
                    "count",
                    default=1, min=0, max=4096, step=1,
                    tooltip=(
                        "How many segments to take. 0 means everything from "
                        "start_index to the end; running past the end wraps "
                        "around to the front."
                    ),
                ),
                io.Int.Input(
                    "group_threshold",
                    default=120, min=0, max=4096, step=1,
                    tooltip=(
                        "For top_down / bottom_up: segments whose left edge is "
                        "within this many pixels of the column's first segment "
                        "count as the same column. 0 groups only exactly equal "
                        "left edges."
                    ),
                ),
                io.Float.Input(
                    "overlap",
                    default=0.0, min=0.0, max=1.0, step=0.01,
                    tooltip=(
                        "Drop boxes that overlap an already-kept box by more "
                        "than this IoU ratio. 0 turns deduplication off."
                    ),
                ),
                io.Boolean.Input(
                    "merge_mask",
                    default=False,
                    label_on="Merge",
                    label_off="Per frame",
                    tooltip=(
                        "Merge: every selected segment combined by pixel-wise "
                        "maximum, one mask out. Per frame: stacked in order, "
                        "each segment separate."
                    ),
                ),
                io.Custom(SEGS_TYPE).Input(
                    "segs",
                    optional=True,
                    tooltip=(
                        "A QG_SEGS container (from a QG seg detector); each "
                        "segment's mask is used. Either this or masks, masks "
                        "wins. Metadata is carried through to the output segs."
                    ),
                ),
                io.Mask.Input(
                    "masks",
                    optional=True,
                    tooltip=(
                        "A mask batch, each frame treated as one segment; a "
                        "single [H,W] mask counts as one. Either this or segs, "
                        "and one of them is required."
                    ),
                ),
            ],
            outputs=[
                io.Custom(SEGS_TYPE).Output(
                    "segs",
                    tooltip=(
                        "The filtered QG_SEGS container with each segment's box, "
                        "label, score and mask."
                    ),
                ),
                io.Mask.Output(
                    "MASK",
                    tooltip=(
                        "The filtered mask: one [H,W] mask when merge_mask is on, "
                        "otherwise a batch stacked in sorted order."
                    ),
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, priority=None, direction=None, **kwargs):
        # 老存档里存的是中文值（面积大小/正序…）。这里具名报上去，让 ComfyUI
        # 跳过「值必须在列表里」那道检查，coerce() 才有机会把它们换成英文。
        return True

    @classmethod
    def execute(cls, masks=None, priority="top_down", direction="forward",
                start_index=0, count=1, group_threshold=120, overlap=0.0,
                merge_mask=False, segs=None):
        # 🔴 V3 不能套 @combo_legacy（它按 cls.FUNCTION 找方法，而 V3 的 FUNCTION
        # 是基类的 EXECUTE_NORMALIZED）。直接在这里 coerce，语义与 V1 装饰器一致。
        priority = coerce(_NODE_ID, "priority", priority)
        direction = coerce(_NODE_ID, "direction", direction)

        # masks 与 segs 二选一：masks 优先；只接 segs 时取每段的遮罩当一段。
        # 输入侧 duck-typing：只要求对象带 mask_batch()，不解析任何第三方 SEGS
        # 结构；输出侧复用 _qg_segs 的容器，保证类型与 Multipack 检测节点一致。
        source_segs = None
        if masks is None:
            if segs is None:
                raise ValueError(
                    "Mask Order Filter needs one of its inputs: wire a mask "
                    "batch into masks, or a QG_SEGS container into segs.")
            if not hasattr(segs, "mask_batch"):
                raise TypeError(
                    "Mask Order Filter expects segs to be a QG_SEGS container "
                    "(the output of a QG seg detector), got %s."
                    % type(segs).__name__)
            source_segs = segs
            masks = segs.mask_batch()
        batch, was_2d = _as_bhw(masks)
        # 输入是 Tensor 时跟随其设备/精度；输入是 ndarray 时按 CPU fp32 处理。
        if isinstance(masks, torch.Tensor):
            device, dtype = masks.device, masks.dtype
        else:
            device, dtype = torch.device("cpu"), torch.float32
        frames = [batch[i] for i in range(batch.shape[0])]
        # 接 segs 时保留原段元数据（框/标签/打分），输出 Seg 才有意义
        metas = None
        if source_segs is not None and hasattr(source_segs, "segs"):
            metas = list(source_segs.segs)[:len(frames)]
        items = order_segments(frames, priority, direction, group_threshold, metas)
        selected = select_segments(items, start_index, count, overlap)
        _, height, width = batch.shape
        out = merge_segments(selected, height, width, merge_mask)
        result = torch.from_numpy(np.ascontiguousarray(out)).to(device=device, dtype=dtype)
        # 单帧输入 + 合并输出：保持二维，和 ComfyUI MASK 习惯一致
        if was_2d and merge_mask and result.ndim == 3 and result.shape[0] == 1:
            result = result[0]
        # Seg 口与上游对齐：排在最上面；每段始终保留独立遮罩，不受 merge_mask 影响
        filtered = _build_segs(selected, width, height)
        return io.NodeOutput(filtered, result)


NODE_CLASS_MAPPINGS = {"QG_MaskOrderFilter": QGMaskOrderFilter}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskOrderFilter": "Mask Order Filter"}

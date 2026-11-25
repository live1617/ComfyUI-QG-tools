# -*- coding: utf-8 -*-
"""QG_SEGS 容器 —— 自造分段类型，供 QG_MaskOrderFilter 使用。

搬入说明（2026-11-25，随 QG_MaskOrderFilter 一起搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_simple_seg_detector.py
        里的 ``SEGS_TYPE`` / ``QGSeg`` / ``QGSegs`` 三个定义。
  为什么单独抽一个文件：QG_MaskOrderFilter 既要吃 QG_SEGS，也要产出 QG_SEGS。
  源包里这个容器挂在「简易 Seg 检测三件套」旁边（那三个节点依赖 ultralytics /
  segment_anything / cv2，不进本包），但容器本身**只依赖 numpy**，所以拆出来
  单独放，避免为了一个 dataclass 把整条模型链拖进来。
  保持：类名、字段名、``mask_batch()`` / ``combined_mask()`` 的方法名与语义
  逐字不变 —— 两包同时安装时，类型字符串 ``QG_SEGS`` 相同、容器接口相同，
  跨包的 seg 输出可以互连（下游按 duck-typing 取 ``mask_batch()``）。

🔴 类型字符串必须与 Multipack 保持一致（"QG_SEGS"）。改成别的名字会让
  「Multipack 检测 → 本包遮罩次序过滤」这条跨包连线在类型校验处断开。
"""

from __future__ import annotations

import numpy as np

SEGS_TYPE = "QG_SEGS"


class QGSeg:
    """一段结果：矩形框、标签、打分、遮罩与各段元数据。"""

    __slots__ = ("bbox", "label", "score", "mask", "crop_factor")

    def __init__(self, bbox, label, score, mask, crop_factor):
        self.bbox = tuple(float(v) for v in bbox)   # (x0,y0,x1,y1)
        self.label = str(label)
        self.score = float(score)
        self.mask = mask                             # [H,W] float32 0..1
        self.crop_factor = float(crop_factor)

    def __repr__(self):
        return "QGSeg(label=%r, score=%.3f, bbox=%s)" % (
            self.label, self.score, self.bbox)


class QGSegs:
    """一组 QGSeg，带尺寸与合并遮罩的便捷方法。"""

    def __init__(self, segs, width, height):
        self.segs = list(segs)
        self.width = int(width)
        self.height = int(height)

    def __len__(self):
        return len(self.segs)

    def __iter__(self):
        return iter(self.segs)

    def __getitem__(self, index):
        return self.segs[index]

    def __repr__(self):
        return "QGSegs(%d segs, %dx%d)" % (len(self.segs), self.width, self.height)

    def combined_mask(self):
        """逐像素取最大，合成一张 [H,W] 遮罩；无段时返回全 0。"""
        if not self.segs:
            return np.zeros((self.height, self.width), dtype=np.float32)
        out = self.segs[0].mask.copy()
        for seg in self.segs[1:]:
            np.maximum(out, seg.mask, out=out)
        return out

    def mask_batch(self):
        """每段一帧，堆叠成 [N,H,W]；无段时返回 [0,H,W]。"""
        if not self.segs:
            return np.zeros((0, self.height, self.width), dtype=np.float32)
        return np.stack([s.mask for s in self.segs], axis=0)


__all__ = ["SEGS_TYPE", "QGSeg", "QGSegs"]

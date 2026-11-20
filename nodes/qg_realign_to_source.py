# -*- coding: utf-8 -*-
"""QG_RealignToSource — 把「编辑过的图」量回「原图」的位置。

用法形态参考 ComfyUI-AusBoss's「Realign to Source (EXPERIMENTAL) 🆎」
（MIT，nodes/node_realign_to_source.py），测量与变形算法走本包
``_qg_realign_helpers.py``（同源搬入的 MIT 代码，2026-11-11 补齐
frame_matrix / overshoot / describe 三个函数）。节点层的编排 ——
stitcher 的解包、逐帧循环、报告拼接 —— 本文件重写。

为什么需要它：编辑模型（Qwen Image 2.1 尤其明显）画风格类的大编辑时，
经常把图放大/平移百分之几，seed 之间还不一样 —— 编辑结果不再和原图
对得上，回贴（重绘缝合）就会错位。本节点测出这个漂移再把它变回去。

流程（每帧）：
  measure       —— 相位相关 + 分块匹配，测 zoom / shift（CPU，768px 内亚秒级）；
  crop_if_shift —— 整像素平移时直接裁切，不重采样；
  warp_to_source—— 否则一次性仿射回源框架；滑出边缘的空条按 empty_fill 补；
  describe      —— 一行人能读的报告（zoom / shift / 置信度 / 建议补边量）。

stitcher 接 QG_CropForInpaint（或扩图画板）给的缝合器时：在画布的
「图本体」区域内测量、只返回那块区域，模型画进补边的部分用来填
原本会空的边条。
"""

import torch

from comfy_api.latest import io

from ._qg_combo_legacy import coerce
from ._qg_execution_helpers import advance_progress, frame_progress, raise_if_interrupted
from ._qg_realign_helpers import (
    crop_if_shift,
    describe,
    frame_matrix,
    measure,
    overshoot,
    warp_to_source,
)

# 两个下拉的值表在本文件本地定义（verify_combo_i18n 的静态扫描只认本文件的
# 模块级常量，import 进来的名字进不了它的求值环境 —— 与 qg_image_scale.py
# 的 SCALE_METHODS 同款做法）。必须与 _qg_realign_helpers.py 的同名常量
# 保持同序，_check_realign.py 里有断言盯两边一致。
FIT_MODES = ("zoom + shift", "affine")
EMPTY_FILLS = ("edge", "source", "gray")


def _stitcher_canvas(stitcher):
    """从缝合器里取「编辑模型看到的补边画布」和「图本体在画布上的位置」。"""
    if not isinstance(stitcher, dict) or not isinstance(stitcher.get("canvas"), torch.Tensor):
        raise ValueError(
            "Realign to Source: the stitcher input needs a stitcher from "
            "Crop For Inpaint or Outpaint Board."
        )
    bbox = stitcher.get("source_bbox")
    if bbox is None:
        raise ValueError(
            "Realign to Source: this stitcher does not say where the picture "
            "sits on its canvas; use one that carries a source_bbox."
        )
    canvas = stitcher["canvas"]
    if canvas.ndim != 4:
        raise ValueError("Realign to Source: the stitcher's canvas is not an IMAGE batch.")
    return canvas, tuple(int(v) for v in bbox)


# V1 @combo_legacy("QG_RealignToSource")：fit/empty_fill 有中文遗留值需 coerce。
# V3 去装饰器，execute 开头 coerce 两值，与 V1 等价。
class QGRealignToSource(io.ComfyNode):
    """测出编辑模型加的 zoom / shift，把编辑图变回原图的框架。"""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "EXPERIMENTAL. Lines an edited picture back up with the original. "
        "Edit models often draw an edit slightly zoomed in or shifted, "
        "especially style changes, so the edit no longer sits on top of the "
        "original. This node measures how far it moved and moves it back. "
        "Best result: pad the picture before editing and plug the stitcher "
        "in here, so the edit has room to move and you get real picture all "
        "the way to the edges."
    )
    SEARCH_ALIASES = [
        "realign", "align to source", "register", "zoom drift", "shift",
        "对齐", "回贴", "对位", "漂移", "编辑对齐", "qg",
    ]
    @classmethod
    def validate_inputs(cls, fit=None, empty_fill=None):
        # 两个下拉的译名在 LEGACY 表里；具名报上去跳过列表校验，中文值由 coerce 换回。
        return True

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_RealignToSource",
            display_name="Realign to Source",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input("edited", tooltip="The edited picture."),
                io.Image.Input("source", tooltip="The original picture you edited, at the size the edit model saw it. The result comes out at this size."),
                io.Combo.Input("fit", options=list(FIT_MODES), default=FIT_MODES[0],
                               tooltip="zoom + shift fixes the usual zoom-and-slide drift. affine also fixes a slight tilt."),
                io.Combo.Input("empty_fill", options=list(EMPTY_FILLS), default=EMPTY_FILLS[0],
                               tooltip="If the edit slid past the edge, a thin strip ends up with nothing in it. edge stretches the nearest pixels into it, source fills it from the original, gray fills it flat gray for inpainting."),
                io.Float.Input("max_zoom", default=20.0, min=1.0, max=50.0, step=0.5,
                               tooltip="The biggest zoom it will undo, in percent. Anything bigger is treated as a change you meant and left alone."),
                io.Custom("AUSBOSS_STITCHER").Input("stitcher", optional=True,
                    tooltip="Optional. Plug in the stitcher from Crop For Inpaint or Outpaint Board if you padded the picture before editing. You get your picture back without the padding, with no empty edges."),
            ],
            outputs=[
                io.Image.Output("image", tooltip="The edit, lined up with the original and at its size."),
                io.Mask.Output("empty_mask", tooltip="White where the lined-up edit has nothing (a strip that slid off the edge). All black when there is none."),
                io.String.Output("report", tooltip="How far the edit had moved and what was done. Plug it into Display Any or a text node to read it."),
            ],
        )

    @classmethod
    def execute(cls, edited, source, fit="zoom + shift", empty_fill="edge",
                max_zoom=20.0, stitcher=None):
        # V1 装饰器 coerce 两个下拉值（中文遗留值 → 英文），V3 显式保留。
        fit = coerce("QG_RealignToSource", "fit", fit)
        empty_fill = coerce("QG_RealignToSource", "empty_fill", empty_fill)
        if edited.ndim != 4 or source.ndim != 4:
            raise ValueError("Realign to Source: edited and source must be IMAGE batches.")
        frames = int(edited.shape[0])
        sources = int(source.shape[0])
        if sources not in (1, frames):
            raise ValueError(
                "Realign to Source: %d source frames for %d edited frames; "
                "give one source, or one per edited frame." % (sources, frames)
            )
        mode = str(fit)
        if mode not in FIT_MODES:
            raise ValueError(
                "Realign to Source: fit must be one of %s, got '%s'." % (FIT_MODES, mode)
            )
        fill = str(empty_fill)
        if fill not in EMPTY_FILLS:
            raise ValueError(
                "Realign to Source: empty_fill must be one of %s, got '%s'."
                % (EMPTY_FILLS, fill)
            )
        height, width = int(source.shape[1]), int(source.shape[2])
        canvases, bbox, frame, canvas_size = None, None, None, None
        if stitcher is not None:
            canvases, bbox = _stitcher_canvas(stitcher)
            if int(canvases.shape[0]) not in (1, frames):
                raise ValueError(
                    "Realign to Source: the stitcher holds %d canvases for %d "
                    "edited frames." % (int(canvases.shape[0]), frames)
                )
            canvas_size = (int(canvases.shape[2]), int(canvases.shape[1]))
            if (width, height) == canvas_size:
                # 补边画布本身被当成 source 接了进来：结果只取「图本体」那块。
                width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
            frame = frame_matrix(width, height, bbox)

        identity = torch.eye(3, dtype=torch.float64)
        progress = frame_progress(frames) if frames > 1 else None
        images, masks, lines = [], [], []
        for index in range(frames):
            raise_if_interrupted()
            # 测量与变形跑在 CPU 上：最多 768px 工作尺寸，每帧亚秒级。
            src = source[min(index, sources - 1), ..., :3].detach().float().cpu()
            edit = edited[index, ..., :3].detach().float().cpu()
            if canvases is None:
                reference, fill_src = src, src
                result = measure(reference, edit, mode, float(max_zoom) / 100.0)
            else:
                reference = canvases[min(index, int(canvases.shape[0]) - 1), ..., :3].detach().float().cpu()
                if tuple(src.shape[:2]) != (height, width):
                    x0, y0, x1, y1 = bbox
                    src = src[y0:y1, x0:x1]
                fill_src = src
                result = measure(reference, edit, mode, float(max_zoom) / 100.0, region=bbox)
            matrix = result.matrix if result.reliable else identity
            out = crop_if_shift(edit, matrix, width, height, frame, canvas_size)
            cropped = out is not None
            if cropped:
                empty = torch.zeros((height, width), dtype=torch.float32)
            else:
                out, empty = warp_to_source(edit, matrix, width, height, fill, fill_src,
                                            frame, canvas_size)
            if not result.reliable:
                empty = torch.zeros_like(empty)
            short = overshoot(matrix, width, height, frame, canvas_size) if bool(empty.any()) else None
            images.append(out)
            masks.append(empty)
            lines.append(describe(result, float(empty.mean()), result.reliable, cropped, short,
                                  stitcher is not None))
            advance_progress(progress, index + 1, frames)
        report = lines[0] if frames == 1 else "\n".join(
            "frame %d: %s" % (i + 1, line) for i, line in enumerate(lines)
        )
        image = torch.stack(images).to(device=edited.device, dtype=edited.dtype)
        mask = torch.stack(masks).to(edited.device)
        return io.NodeOutput(image, mask, report)


NODE_CLASS_MAPPINGS = {"QG_RealignToSource": QGRealignToSource}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RealignToSource": "Realign to Source"}

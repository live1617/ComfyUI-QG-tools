# -*- coding: utf-8 -*-
"""QG_ImageBatchBuilder — gather up to 24 image slots into one batch.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_image_batch_builder.py
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Image``；显示名与 DESCRIPTION 英化；
    3) 🔴 **丢掉 ``_SlotSpecs`` 那个 dict 子类技巧**。源包靠覆写
       ``__contains__`` / ``__getitem__`` 让帮助卡只列 1 条却接受 24 个槽名；
       V3 的 ``io.Schema`` 直接序列化 inputs 列表，没有等价覆写点，所以这里
       老老实实声明 24 个 optional 槽（本包 QG_TextConcat 的 8 槽同构）。
       代价是帮助卡会列 24 行同义条目；换来的是序列化、校验、执行三条路径
       都走官方实现，不会因为 ComfyUI 内部改取值方式而静默失效；
    4) 报错与提示信息英化；tooltip 英化。
  保持不变：槽位语义（``image_01``…``image_24``，存档键名与源包一致）、
  ``collect_frames`` / ``align_frames`` 的尺寸与通道对齐策略。

槽位语义：
  * 24 个槽全部可选，只收非 None 的；至少要有 1 张，否则明确报错；
  * 槽位编号只是顺序，中间空着不影响；
  * 每个槽可以是「一张」或「一个 batch」，整批按顺序展开；
  * 尺寸/通道不一致由 resize_mode 决定：first 双三次对齐首帧（默认）、
    error 直接报错。通道数以首帧为准，RGB 与 RGBA 互相补齐。

前端 ``web/image_batch_builder/index.js`` 默认只显示 1 个槽、接一个加一个
（上限 24），并负责把节点高度收紧到实际槽数。
"""

from __future__ import annotations

import numpy as np
import torch
from PIL import Image

from comfy_api.latest import io

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
#: 输入槽数量：A4 证件照 3 列 × 8 行 = 24 人，覆盖「一版」的常见上限。
SLOT_COUNT = 24
RESIZE_MODES = ["first", "error"]
SLOT_NAMES = tuple("image_%02d" % i for i in range(1, SLOT_COUNT + 1))

#: 未接线的槽用这个哨兵区分「没传」和「传了 None」。
_MISSING = object()

SLOT_TOOLTIP = (
    "Any of the images to combine. Wire as many as you need: they are joined "
    "in slot order and empty slots are skipped. Wiring the last visible slot "
    "reveals one more. A slot can hold a single image or a whole batch."
)


def _as_frames(value):
    """把 ``[H,W,C]`` / ``[B,H,W,C]`` / None 统一成 frame 列表。"""
    if value is None or value is _MISSING:
        return []
    if not isinstance(value, torch.Tensor):
        value = torch.as_tensor(value)
    if value.ndim == 3:
        return [value]
    if value.ndim == 4:
        return [value[i] for i in range(int(value.shape[0]))]
    raise ValueError(
        "Batch Builder expects [H,W,C] or [B,H,W,C] images, got %d dimensions."
        % value.ndim)


def collect_frames(values):
    """按槽位顺序把所有非空输入展开成一维 frame 列表。"""
    frames = []
    for name in SLOT_NAMES:
        frames.extend(_as_frames(values.get(name)))
    if not frames:
        raise ValueError(
            "Batch Builder has nothing to combine: wire at least one image "
            "into image_01 or any later slot.")
    return frames


def _resize_plane(frame, height, width):
    """把单帧双三次缩放到指定高宽（尺寸已一致则原样返回）。"""
    if int(frame.shape[0]) == height and int(frame.shape[1]) == width:
        return frame
    img = Image.fromarray(
        (np.clip(frame.detach().cpu().numpy(), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8),
        "RGBA" if frame.shape[-1] == 4 else "RGB")
    img = img.resize((width, height), Image.Resampling.BICUBIC)
    return torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0)


def align_frames(frames, mode="first"):
    """把尺寸/通道不一致的帧对齐到首帧规格，再堆成一个 batch。

    ``mode='error'`` 时任何尺寸不一致都直接抛错；``'first'`` 时缩放到首帧。
    """
    if not frames:
        raise ValueError("Batch Builder received no frames to align.")
    ref = frames[0]
    height, width = int(ref.shape[0]), int(ref.shape[1])
    channels = int(ref.shape[-1])

    if mode == "error":
        bad = [(int(f.shape[1]), int(f.shape[0])) for f in frames
               if int(f.shape[0]) != height or int(f.shape[1]) != width]
        if bad:
            raise ValueError(
                "Batch Builder got mismatched sizes: the first frame is %dx%d "
                "but others are %s. Crop them to one size, or set resize_mode "
                "to first to scale them automatically."
                % (width, height, ", ".join("%dx%d" % s for s in bad[:5])))
        mode = "first"

    out = []
    for f in frames:
        if mode == "first":
            f = _resize_plane(f, height, width)
        if int(f.shape[-1]) != channels:
            if channels == 3:
                f = f[..., :3]
            else:
                f = torch.nn.functional.pad(f, (0, 1), mode="constant", value=1.0)
        out.append(f)
    return torch.stack(out, dim=0)


class QGImageBatchBuilder(io.ComfyNode):
    """Combine up to 24 image inputs into one batch."""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Wire up to 24 images and get one batch, in slot order, empty slots "
        "skipped — no need to chain a dozen batch-merge nodes. Each slot may "
        "hold a single image or a whole batch. When sizes differ, resize_mode "
        "picks between scaling everything to the first frame and refusing with "
        "both sizes named; channel counts are padded so RGB and RGBA can mix."
    )
    SEARCH_ALIASES = [
        "batch", "combine", "gather", "collect", "images", "批次", "组合",
        "合并", "多图", "qg",
    ]

    @classmethod
    def define_schema(cls):
        # 24 个槽全部 optional：前端默认只显示 1 个、接一个加一个，所以后端
        # 不能强制任何槽必填，否则只接 1 张时 ComfyUI 会因「必填未接」拦截。
        # 至少 1 张由 collect_frames 在运行时检查并给出明确报错。
        inputs = [
            io.Image.Input(name, optional=True,
                           extra_dict={"forceInput": True},
                           tooltip=SLOT_TOOLTIP)
            for name in SLOT_NAMES
        ]
        inputs.append(io.Combo.Input(
            "resize_mode",
            options=list(RESIZE_MODES),
            default="first",
            tooltip=(
                "When the sizes differ: first scales every frame to the first "
                "one (bicubic); error stops with both sizes named, which is "
                "handy when a crop spec went wrong."
            ),
        ))
        return io.Schema(
            node_id="QG_ImageBatchBuilder",
            display_name="Image Batch Builder",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=inputs,
            outputs=[
                io.Image.Output(
                    "image",
                    tooltip="All wired images in slot order, as one batch.",
                ),
                io.Int.Output(
                    "count",
                    tooltip="How many frames went into the batch.",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        resize_mode="first",
        image_01=_MISSING, image_02=_MISSING, image_03=_MISSING, image_04=_MISSING,
        image_05=_MISSING, image_06=_MISSING, image_07=_MISSING, image_08=_MISSING,
        image_09=_MISSING, image_10=_MISSING, image_11=_MISSING, image_12=_MISSING,
        image_13=_MISSING, image_14=_MISSING, image_15=_MISSING, image_16=_MISSING,
        image_17=_MISSING, image_18=_MISSING, image_19=_MISSING, image_20=_MISSING,
        image_21=_MISSING, image_22=_MISSING, image_23=_MISSING, image_24=_MISSING,
    ):
        values = {
            "image_01": image_01, "image_02": image_02, "image_03": image_03,
            "image_04": image_04, "image_05": image_05, "image_06": image_06,
            "image_07": image_07, "image_08": image_08, "image_09": image_09,
            "image_10": image_10, "image_11": image_11, "image_12": image_12,
            "image_13": image_13, "image_14": image_14, "image_15": image_15,
            "image_16": image_16, "image_17": image_17, "image_18": image_18,
            "image_19": image_19, "image_20": image_20, "image_21": image_21,
            "image_22": image_22, "image_23": image_23, "image_24": image_24,
        }
        frames = collect_frames(values)
        mode = resize_mode or "first"
        batch = align_frames(frames, mode)
        print("[QG Image Batch Builder] %d frame(s) -> batch %s (mode %s)"
              % (len(frames), tuple(batch.shape), mode))
        return io.NodeOutput(batch, int(len(frames)))


NODE_CLASS_MAPPINGS = {"QG_ImageBatchBuilder": QGImageBatchBuilder}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageBatchBuilder": "Image Batch Builder"}

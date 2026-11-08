# -*- coding: utf-8 -*-
"""QG_ImageWatermark - stamp a watermark image onto a base image.

Ported from ComfyUI-Muye-nodes (image/add_image_watermark.py, class
WatermarkMaster), MIT licensed, author muyexiuluo. Rewritten to the QG
conventions; the operation itself is unchanged:

  scale the watermark (or not) -> place it by anchor + offset -> rotate it ->
  fade it -> cut it with an optional mask -> paste it onto every frame of the
  base image.

What differs from upstream (all verified against the upstream source in
``custom_nodes/ComfyUI_Muye/image/add_image_watermark.py``):

  * Upstream pasted with ``img_pil.paste(wm_pil, location)`` whenever no MASK
    input was connected. ``Image.paste`` without a mask parameter **drops the
    alpha channel**, so the opacity slider and the transparent corners left by
    rotation did nothing at all unless a mask happened to be wired in. Measured:
    a half-transparent red stamped on white came out solid red. Here the
    watermark is always pasted with itself as the mask.
  * Upstream's private ``common_upscale`` called ``bislerp`` / ``lanczos``
    without importing them - they do not exist in that module. The two names
    were unreachable because the method list only offered nearest-exact,
    bilinear and area, so it never surfaced, but any future method choice would
    have raised NameError. Stock ``comfy.utils.common_upscale`` is used instead.
  * Upstream squashed the watermark with ``squeeze()`` before ``Image.fromarray``
    and then crashed on a multi-frame watermark. Only the first frame is used
    here, and the frames of the base image are handled one by one.
  * Upstream rotated with the default ``resample=Image.NEAREST`` (jagged, and
    worse on a logo with thin strokes). ``Image.BICUBIC`` is used instead.
  * Upstream mapped an unknown scale mode to "leave the size alone"; the QG
    rewrite used to fall into the width-height branch, which silently forced
    512x512. Unknown values fall back to "no scaling" again.
  * Three-dimensional tensors are told apart by their last axis: (H, W, C) is a
    single frame, (B, H, W) is a grayscale batch. Only that distinction keeps a
    grayscale batch from being read as one tall image.

Deliberately unchanged from upstream:

  * ``opacity`` is inverted: 0 is fully opaque, 100 is fully transparent.
  * the mask is inverted too: white areas punch holes in the watermark.
  * scaling mode "fit" only ever shrinks - a smaller watermark is blown up to
    touch the base image, which is what "fit" means here.
  * the output is always three-channel RGB, even for a grayscale input, because
    every downstream IMAGE consumer assumes (B, H, W, 3).

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category
and display name localized, tooltips and comments rewritten.
Rewritten as an own implementation on 2026-10-30.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.utils
from ._qg_combo_legacy import combo_legacy
from ._qg_tensor_helpers import as_image_batch


MAX_RESOLUTION = 16384

# 「(H, W, C) 还是 (B, H, W)」的判据现在只有一处：_qg_tensor_helpers.MAX_CHANNELS。
# 这个文件里原本还留着一份自己的 `_as_batch`，已经并入 `as_image_batch`。

# What comfy.utils.common_upscale accepts. Used when the core list cannot be
# read, so that a core rename does not make the whole node vanish at
# registration time.
_FALLBACK_METHODS = ("nearest-exact", "bilinear", "area", "bicubic", "lanczos")

POSITIONS = (
    "center", "top", "bottom", "left", "right",
    "top-left", "top-right", "bottom-left", "bottom-right",
)

SCALE_MODES = ("none", "fit", "factor", "width-height")


def _upscale_methods():
    try:
        import nodes

        methods = tuple(nodes.ImageScale.upscale_methods)
        if methods:
            return methods
    except Exception:
        pass
    return _FALLBACK_METHODS


def _tensor_to_pil(frame: torch.Tensor) -> Image.Image:
    """One frame (H, W, C) -> PIL. A single-channel frame becomes a 2-D array."""
    arr = np.clip(255.0 * frame.detach().cpu().numpy(), 0, 255).astype(np.uint8)
    if arr.ndim == 3 and arr.shape[-1] == 1:
        arr = arr[..., 0]
    if arr.ndim == 2:
        return Image.fromarray(arr, mode="L")
    return Image.fromarray(arr)


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    if image.mode != "RGB":
        image = image.convert("RGB")
    arr = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(arr)


def _as_batch(image: torch.Tensor, label: str) -> torch.Tensor:
    """Normalise to (B, H, W, C) — thin wrapper over the shared helper.

    This function used to own the whole rule. It now lives in
    ``_qg_tensor_helpers.as_image_batch`` because eight nodes needed it and
    they had each written a slightly different version of it.
    """
    return as_image_batch(image, label)[0]


@combo_legacy("QG_ImageWatermark")
class QGImageWatermark:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Stamps a watermark image onto a base image: scale it (keep size, fit "
        "inside, multiply, or force a size), anchor it to one of nine positions, "
        "nudge it by pixels, rotate it, fade it with opacity, and optionally cut "
        "it with a mask. Applies to every frame of a batch."
    )
    SEARCH_ALIASES = [
        "watermark", "logo", "stamp", "水印", "角标", "qg",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, scale_mode=None, position=None):
        # 老工作流里存的还是中文选项值，按下标校验会直接报 Value not in list。
        # 具名列出这两个 → ComfyUI 跳过列表校验，真正的换值在 combo_legacy 里做；
        # 数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_image": (
                    "IMAGE",
                    {"tooltip": "The base images. A batch is fine, the watermark lands on every frame."},
                ),
                "watermark_image": (
                    "IMAGE",
                    {"tooltip": "The watermark image; from a batch only the first frame is used."},
                ),
                "scale_mode": (
                    list(SCALE_MODES),
                    {
                        "default": "none",
                        "tooltip": (
                            "none keeps the original size; fit scales it until it exactly touches "
                            "the base image (shrink or grow, aspect kept); factor multiplies the "
                            "original size by the factor; width-height uses the width and height "
                            "filled in below."
                        ),
                    },
                ),
                "scale_method": (
                    list(_upscale_methods()),
                    {
                        "default": "bilinear",
                        "tooltip": "Resampling method used to scale the watermark, with no effect under none.",
                    },
                ),
                "scale_factor": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.01,
                        "max": 16.0,
                        "step": 0.1,
                        "tooltip": "Used when the scale mode is set to factor.",
                    },
                ),
                "target_width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "Width used when the scale mode is set to width-height.",
                    },
                ),
                "target_height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "Height used when the scale mode is set to width-height.",
                    },
                ),
                "position": (
                    list(POSITIONS),
                    {
                        "default": "bottom-right",
                        "tooltip": "Anchor point of the watermark on the base image.",
                    },
                ),
                "offset_x": (
                    "INT",
                    {
                        "default": 32,
                        "min": -48000,
                        "max": 48000,
                        "step": 1,
                        "tooltip": "Horizontal pixel offset from the anchor, positive moves right.",
                    },
                ),
                "offset_y": (
                    "INT",
                    {
                        "default": 32,
                        "min": -48000,
                        "max": 48000,
                        "step": 1,
                        "tooltip": "Vertical pixel offset from the anchor, positive moves down.",
                    },
                ),
                "rotation": (
                    "INT",
                    {
                        "default": 0,
                        "min": -180,
                        "max": 180,
                        "step": 1,
                        "tooltip": (
                            "Rotation in degrees, counter-clockwise positive. The canvas grows to "
                            "fit, so a 45 degree mark ends up inside a larger transparent square."
                        ),
                    },
                ),
                "opacity": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 5.0,
                        "display": "slider",
                        "tooltip": "0 is fully opaque and 100 is fully transparent - the scale runs backwards from the usual opacity.",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "Optional mask, applied before rotation: white areas hide the watermark, black areas show it as usual.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The images with the watermark applied, as many as went in.",
    )
    FUNCTION = "apply_watermark"

    # ------------------------------------------------------------------ scale
    def _resize_watermark(self, watermark, scale_mode, scale_method, scale_factor,
                          target_width, target_height, base_w, base_h):
        """Scale one frame (1, H, W, C). Unknown modes fall back to no scaling."""
        wm_h = int(watermark.shape[1])
        wm_w = int(watermark.shape[2])

        if scale_mode == "fit":
            # 只比一边：按较小的比例缩，另一边跟着变，纵横比不变。
            ratio = min(base_w / wm_w, base_h / wm_h)
            new_w, new_h = round(wm_w * ratio), round(wm_h * ratio)
        elif scale_mode == "factor":
            new_w, new_h = round(wm_w * float(scale_factor)), round(wm_h * float(scale_factor))
        elif scale_mode == "width-height":
            new_w, new_h = int(target_width), int(target_height)
        else:
            # "none"，以及任何认不出来的值（老存档里没映射到的中文也是这条路）。
            return watermark

        # 0 像素会让 common_upscale 直接抛，一律抬到 1。
        new_w, new_h = max(1, new_w), max(1, new_h)
        if new_w == wm_w and new_h == wm_h:
            return watermark

        samples = watermark.movedim(-1, 1)
        samples = comfy.utils.common_upscale(samples, new_w, new_h, scale_method, crop="disabled")
        return samples.movedim(1, -1)

    # ---------------------------------------------------------------- compose
    def apply_watermark(self, base_image, watermark_image, scale_mode, scale_method,
                        scale_factor, target_width, target_height, position,
                        offset_x, offset_y, rotation, opacity, mask=None):
        base_image = _as_batch(base_image, "原图")
        watermark_image = _as_batch(watermark_image, "水印图片")

        base_h, base_w = int(base_image.shape[1]), int(base_image.shape[2])

        # 空批次：没有帧可贴，torch.stack([]) 会抛 "expects a non-empty
        # TensorList"。空进空出，和 QG_TextOverlayImage 同一口径。
        if base_image.shape[0] == 0:
            return (base_image.clone(),)

        if watermark_image.shape[0] == 0:
            raise ValueError("[QG-tools] 图像水印：水印图片是空的（0 帧），没有可贴的图。")

        # 水印只用第一帧：多帧水印在语义上没有定义（每帧各贴一次？还是逐帧对应？），
        # 上游直接崩在 squeeze 上，这里明确取第一帧并写进 tooltip。
        watermark = self._resize_watermark(
            watermark_image[0:1], scale_mode, scale_method, scale_factor,
            target_width, target_height, base_w, base_h,
        )

        # 合成必须走 RGBA：旋转会把画布撑大，多出来的角只能是透明的。
        wm_pil = _tensor_to_pil(watermark[0]).convert("RGBA")

        if mask is not None:
            mask_frame = mask
            while mask_frame.dim() > 2:
                mask_frame = mask_frame[0]
            mask_pil = _tensor_to_pil(mask_frame.float())
            if mask_pil.mode != "L":
                mask_pil = mask_pil.convert("L")
            if mask_pil.size != wm_pil.size:
                # 遮罩多在缩放后尺寸上给，两边对不上就缩到水印大小。
                # BILINEAR 而不是默认的 BICUBIC：二值遮罩用 BICUBIC 会在边界
                # 振铃出 >255 / <0 的过冲，取整后是一圈灰边。
                mask_pil = mask_pil.resize(wm_pil.size, Image.BILINEAR)
            # 白=打洞。上游就是这个方向，别"修"成白=显示。
            wm_pil.putalpha(ImageOps.invert(mask_pil))

        if int(rotation) % 360:
            wm_pil = wm_pil.rotate(int(rotation), expand=True, resample=Image.BICUBIC)

        if opacity > 0:
            factor = max(0.0, 1.0 - float(opacity) / 100.0)
            alpha = wm_pil.getchannel("A").point(lambda v: round(v * factor))
            wm_pil.putalpha(alpha)

        wm_w, wm_h = wm_pil.size
        anchors = {
            "center": ((base_w - wm_w) / 2, (base_h - wm_h) / 2),
            "top": ((base_w - wm_w) / 2, 0),
            "bottom": ((base_w - wm_w) / 2, base_h - wm_h),
            "left": (0, (base_h - wm_h) / 2),
            "right": (base_w - wm_w, (base_h - wm_h) / 2),
            "top-left": (0, 0),
            "top-right": (base_w - wm_w, 0),
            "bottom-left": (0, base_h - wm_h),
            "bottom-right": (base_w - wm_w, base_h - wm_h),
        }
        # 🔴 key 必须是英文：老存档里的中文选项值在 @combo_legacy 里就换回英文了。
        #    而且 dict.get() 的默认值是「先求值再传参」—— 写个不存在的 key 会无条件
        #    KeyError，不管 position 传什么都会炸（v0.8.5 搬进来时就写错了）。
        anchor_x, anchor_y = anchors.get(position, anchors["center"])
        location = (int(anchor_x + offset_x), int(anchor_y + offset_y))

        frames = []
        for frame in torch.unbind(base_image, dim=0):
            base_pil = _tensor_to_pil(frame)
            if base_pil.mode != "RGB":
                # 🔴 灰度底图上贴 RGBA 水印时，PIL 会先把水印转成 L 再贴 ——
                #    alpha 通道整个丢掉，旋转出来的透明角和 opacity 一起失效，
                #    水印变成一个不透明的方块。先转 RGB 再贴。
                base_pil = base_pil.convert("RGB")
            # 始终把水印自己当 mask 传：不传的话 PIL 会丢掉 alpha 通道，
            # 透明度滑块和旋转出来的透明角全部失效（上游就是这么错的）。
            base_pil.paste(wm_pil, location, wm_pil)
            frames.append(_pil_to_tensor(base_pil))
        return (torch.stack(frames, dim=0),)


NODE_CLASS_MAPPINGS = {"QG_ImageWatermark": QGImageWatermark}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageWatermark": "Image Watermark"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

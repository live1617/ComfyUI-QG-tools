# -*- coding: utf-8 -*-
"""QG_ImageMergeMask —— 按遮罩把覆盖图叠加到背景图上。

功能对位本机 Goohaitools-comfyui「孤海-图像合并（遮罩）」的节点形态与参数，
但**代码完全自写**，不引入 PIL / numpy / cv2：合成、遮罩形态学、羽化和缩放
全部用本包已有的纯 torch helper，或本文件里的张量运算。

与参考实现有意不同（都是增强，不是改需求）：

* 逐帧处理整个 batch（参考实现只取第一帧）。单帧输入自动广播到背景的帧数。
* 遮罩值域按连续 alpha 处理，不做 8 位量化；因此软边羽化不留台阶。
* 遮罩扩张的画布外按 0 计（与本包其余遮罩节点一致），参考实现复制边缘像素。

合成口径（与参考一致）：遮罩白处取覆盖图、黑处留背景图；透明度是覆盖图在
遮罩区里的整体权重；「匹配图像大小」关闭时覆盖图按原尺寸居中贴入背景画布，
超出画布的右下部分裁掉，不会缩放主体。「遮罩扩展」为正放大覆盖范围、为负
收缩；「模糊半径」羽化遮罩边缘。
"""

import torch

from comfy_api.latest import io

from ._qg_mask_helpers import blur_mask, grow_shrink_mask
from ._qg_mask_crop_helpers import resize_image, resize_mask


def _as_image(value):
    """任意 IMAGE 张量 -> float32 ``[B,H,W,3]``，值域钳到 0..1。

    通道归一到 3：RGBA 取前 3 通道（本节点的透明度由外部 mask 决定，图像
    自带的 alpha 不参与合成），灰度复制成 3 通道。否则 3 通道背景 + 4 通道
    叠加层会在下面的广播乘法处抛 size mismatch，整个 workflow 中断
    （2026-11-23 排查：带透明通道的 logo 叠加是最自然的用法，命中率高）。
    """
    if value is None:
        raise ValueError("Image Merge Mask: an image input is required.")
    image = value.to(torch.float32)
    if image.dim() == 3:
        image = image.unsqueeze(0)
    if image.dim() != 4:
        raise ValueError(
            "Image Merge Mask: expected an IMAGE of shape [B,H,W,C], got %s."
            % (tuple(image.shape),)
        )
    channels = int(image.shape[-1])
    if channels >= 3:
        image = image[..., :3]
    elif channels == 1:
        image = image.repeat(1, 1, 1, 3)
    else:
        raise ValueError(
            "Image Merge Mask: expected 1, 3 or 4 channels, got %d." % channels
        )
    return image.clamp(0.0, 1.0)


def _as_mask(value, height, width):
    """MASK -> float32 ``[B,H,W]``；None 表示整幅画布全选。"""
    if value is None:
        return torch.ones((1, height, width), dtype=torch.float32)
    mask = value.to(torch.float32)
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    elif mask.dim() == 4:
        mask = mask[:, 0]
    if mask.dim() != 3:
        raise ValueError(
            "Image Merge Mask: expected a MASK of shape [B,H,W], got %s."
            % (tuple(mask.shape),)
        )
    return mask.clamp(0.0, 1.0)


def _align_frames(tensor, count):
    """把单帧输入广播到背景帧数；多帧按取模对齐。"""
    if tensor.shape[0] == count:
        return tensor
    if tensor.shape[0] == 1:
        return tensor.expand((count,) + tensor.shape[1:])
    index = torch.arange(count, device=tensor.device) % tensor.shape[0]
    return tensor.index_select(0, index)


def _place_centered(overlay, height, width):
    """把覆盖图按原尺寸居中贴入 ``[B,H,W,3]`` 画布，超出右下角的部分裁掉。"""
    frames, ov_h, ov_w, channels = overlay.shape
    canvas = overlay.new_zeros((frames, height, width, channels))
    x = (width - ov_w) // 2
    y = (height - ov_h) // 2
    # 覆盖图自身被画布左/上边缘切掉的起点
    src_x = max(0, -x)
    src_y = max(0, -y)
    # 画布里实际可写的起点
    dst_x = max(0, x)
    dst_y = max(0, y)
    copy_w = min(ov_w - src_x, width - dst_x)
    copy_h = min(ov_h - src_y, height - dst_y)
    if copy_w > 0 and copy_h > 0:
        canvas[:, dst_y:dst_y + copy_h, dst_x:dst_x + copy_w] = overlay[
            :, src_y:src_y + copy_h, src_x:src_x + copy_w
        ]
    return canvas


class QGImageMergeMask(io.ComfyNode):
    CATEGORY = "QG-tools/Image"

    DESCRIPTION = (
        "Composites the overlay picture onto the background through a mask. "
        "White mask areas take the overlay, black areas keep the background, "
        "and value in between blends the two. Opacity sets how strongly the "
        "overlay shows inside the mask, so 0 leaves the background untouched. "
        "Mask Grow widens (positive) or shrinks (negative) the painted area in "
        "whole pixels; Blur Radius feathers its edge. Match Size scales the "
        "overlay to the background before compositing; with it off the overlay "
        "keeps its own size, is centred on the background canvas and anything "
        "past the lower-right edge is cropped instead of squashed. With no mask "
        "connected the whole canvas is selected. Runs frame by frame: a single "
        "overlay or mask frame is broadcast across the background batch."
    )
    SEARCH_ALIASES = [
        "image merge mask", "merge image", "composite", "overlay image",
        "mask composite", "paste image", "blend by mask", "图像合并",
        "遮罩合并", "叠加图像", "按遮罩合成", "贴叠加图", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ImageMergeMask",
            display_name="Image Merge (Mask)",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input(
                    "bg_image",
                    tooltip="The background picture the overlay is placed onto.",
                ),
                io.Image.Input(
                    "overlay_image",
                    tooltip="The picture copied onto the background where the mask is white.",
                ),
                io.Float.Input(
                    "opacity",
                    default=1.0,
                    min=0.0,
                    max=1.0,
                    step=0.01,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="Overall weight of the overlay inside the mask. 0 leaves the background untouched.",
                ),
                io.Int.Input(
                    "mask_grow",
                    default=0,
                    min=-100,
                    max=100,
                    step=1,
                    tooltip="Grow the mask by this many pixels (negative shrinks it) before compositing.",
                ),
                io.Int.Input(
                    "blur_radius",
                    default=0,
                    min=0,
                    max=100,
                    step=1,
                    tooltip="Feather the mask edge with a Gaussian blur of this radius. 0 keeps a hard edge.",
                ),
                io.Boolean.Input(
                    "match_size",
                    default=False,
                    tooltip="Scale the overlay to the background size. Off keeps its own size, centred, cropped at the edges.",
                ),
                io.Mask.Input(
                    "mask",
                    optional=True,
                    tooltip="Where the overlay shows. White copies it fully, black keeps the background. Leave empty to select everything.",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    tooltip="The background with the overlay composited through the mask.",
                ),
            ],
        )

    @classmethod
    def execute(
        cls,
        bg_image,
        overlay_image,
        opacity=1.0,
        mask_grow=0,
        blur_radius=0,
        match_size=False,
        mask=None,
    ):
        bg = _as_image(bg_image)
        overlay = _as_image(overlay_image)
        frames, height, width = bg.shape[0], bg.shape[1], bg.shape[2]

        overlay = _align_frames(overlay, frames)
        if match_size:
            if (overlay.shape[1], overlay.shape[2]) != (height, width):
                overlay = resize_image(overlay, height, width)
        elif (overlay.shape[1], overlay.shape[2]) != (height, width):
            overlay = _place_centered(overlay, height, width)

        alpha = _as_mask(mask, height, width)
        alpha = _align_frames(resize_mask(alpha, height, width), frames)
        if int(mask_grow) != 0:
            alpha = grow_shrink_mask(alpha, int(mask_grow))
        if int(blur_radius) > 0:
            alpha = blur_mask(alpha, float(int(blur_radius)))
        alpha = (alpha * float(opacity)).clamp(0.0, 1.0)

        result = bg * (1.0 - alpha.unsqueeze(-1)) + overlay * alpha.unsqueeze(-1)
        return io.NodeOutput(result.clamp(0.0, 1.0))


NODE_CLASS_MAPPINGS = {"QG_ImageMergeMask": QGImageMergeMask}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageMergeMask": "Image Merge (Mask)"}

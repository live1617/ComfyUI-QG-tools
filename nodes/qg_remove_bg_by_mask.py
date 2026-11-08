# ============================================================
# 搬入说明（2026-11-08，用户确认后 1:1 搬运 + 文案英化）
#   来源：作者自有插件 ComfyUI-QG-Multipack v0.1.0 /
#         remove_bg_by_mask_node.py（GPL-3.0-or-later）
#   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_RemoveBGByMask
#   概念参考：孤海工具箱 Goohaitools「保留遮罩区域移除背景」（源包自写实现，
#   逐行相似度 3%，见源包 README 第 81 行）。
#
#   🔴 计算逻辑一行未改（反向还原后与源文件逐字节相同）。
#   只做「界面文案英化 + 命名规范」适配 —— 本包 verify_bilingual 硬判据：
#   后端显示名 / DESCRIPTION / 输入 tooltip 不许含中文，中文一律进
#   locales/zh/nodeDefs.json 与汉化主档。
#     1) 显示名 "QG 保留遮罩区域移除背景" -> "Remove BG by Mask"（去掉 QG 前缀）；
#     2) CATEGORY "QG 工具" -> "QG-tools/Mask"（模块级 + 类级两处）；
#     3) RETURN_NAMES 中文槽名 -> ("rgba", "rgb", "mask")；
#     4) INPUT_TYPES 声明改英文 tooltip 并按本包规范排版（"xxx": ( 独占行，
#        verify_bilingual 的启发式靠这个认输入名）；值、默认值、范围全不变；
#     5) DESCRIPTION 改英文单行；补 OUTPUT_TOOLTIPS 三条英文；
#     6) 文件名 -> nodes/qg_remove_bg_by_mask.py（加载器按目录扫）。
#   保持不变：全部几何/抠图/填洞/膨胀/裁剪/描边代码、scipy -> cv2 -> 直通
#   三层回退、空批次兜底、_expand_box 允许越界补边、中文 docstring 与行内注释、
#   SEARCH_ALIASES、DEFAULT_STROKE_COLOR / _FALLBACK_RGB。
#
#   ⚠️ 遮罩语义：_dilate 用 binary_dilation 默认 border_value=0（画布外 = 0），
#   cv2.dilate 同样按 0 边界；binary_fill_holes 也把边界外当背景 —— 与本包
#   「画布外 = 没选中」一致。本文件不调用 _qg_mask_helpers，自包含。
# ============================================================

"""QG 保留遮罩区域移除图像背景。

输入 IMAGE + MASK，按遮罩保留前景、挖空背景，可选填洞、自动裁剪、加描边，
输出 RGBA 图像 / RGB 图像（透明处填描边色）/ 遮罩。

与 Goohaitools 的同名节点功能对齐，但实现上避开了原版的几个坑：
  1. 原版用 np.column_stack(np.where(mask)) 求外接框，4K 图会瞬时吃掉几百 MB
     内存；这里改用 any/argmax，逐轴扫描，内存只跟图像高宽成正比。
  2. 原版 batch 里每张图各自裁剪，尺寸不一致时 torch.cat 直接报错；这里对
     整个 batch 取外接框**并集**，保证输出尺寸统一。
  3. 原版描边用 MaxFilter(3) 循环 stroke_width 次，512 描边等于跑 512 遍全图
     卷积（几分钟）；这里用一次性结构元膨胀，像素结果一致但快两个数量级。
  4. 原版遮罩与图像尺寸不一致时只在"不裁剪"分支做 resize，裁剪分支会用错
     坐标；这里统一在入口把遮罩对齐到图像尺寸。
"""

import numpy as np
import torch
from PIL import Image

CATEGORY = "QG-tools/Mask"
DEFAULT_STROKE_COLOR = "#364254"
_FALLBACK_RGB = (54, 66, 84)


def _hex_to_rgb(value):
    """'#RRGGBB' / '#RGB' / 'RRGGBB' -> (r, g, b)，非法输入回退默认色。"""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) == 6:
        try:
            return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    return _FALLBACK_RGB


def _fill_holes(mask_u8):
    """填充遮罩内部的孔洞（只填被前景包围的空洞，不碰外部背景）。"""
    binary = mask_u8 > 127
    if not binary.any():
        return mask_u8
    try:
        from scipy import ndimage
        return (ndimage.binary_fill_holes(binary) * 255).astype(np.uint8)
    except Exception:
        pass
    try:
        # scipy 缺失时的兜底：从图外灌水，剩下没被灌到的空白就是内部空洞
        import cv2
        m = binary.astype(np.uint8)
        padded = np.pad(m, 1, constant_values=0)
        flood_mask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
        cv2.floodFill(padded, flood_mask, (0, 0), 2)
        holes = padded[1:-1, 1:-1] == 0
        return ((binary | holes) * 255).astype(np.uint8)
    except Exception:
        return mask_u8


def _dilate(binary, iterations):
    """8 邻域方形膨胀，等价于原版反复 MaxFilter(3)，但只需一次。"""
    if iterations <= 0 or not binary.any():
        return binary
    try:
        from scipy import ndimage
        return ndimage.binary_dilation(
            binary, structure=np.ones((3, 3), bool), iterations=int(iterations))
    except Exception:
        pass
    try:
        import cv2
        kernel = np.ones((3, 3), np.uint8)
        out = cv2.dilate(binary.astype(np.uint8), kernel, iterations=int(iterations))
        return out.astype(bool)
    except Exception:
        return binary


def _bbox(binary):
    """外接框 (x0, y0, x1, y1)，右下为开区间；空遮罩返回 None。"""
    rows = np.any(binary, axis=1)
    if not rows.any():
        return None
    cols = np.any(binary, axis=0)
    y0 = int(np.argmax(rows))
    y1 = int(len(rows) - np.argmax(rows[::-1]))
    x0 = int(np.argmax(cols))
    x1 = int(len(cols) - np.argmax(cols[::-1]))
    return x0, y0, x1, y1


def _union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _expand_box(box, factor, stroke):
    """按裁剪系数向外扩，再给描边留出空间；允许越过原图边界（后续补边）。"""
    x0, y0, x1, y1 = box
    ex = int(round((x1 - x0) * (factor - 1.0) / 2.0)) + int(stroke)
    ey = int(round((y1 - y0) * (factor - 1.0) / 2.0)) + int(stroke)
    return x0 - ex, y0 - ey, x1 + ex, y1 + ey


def _cut_with_pad(rgba, mask_u8, box):
    """按 box 裁剪；越过边界的部分用透明像素 / 0 遮罩补齐，而不是压缩。"""
    x0, y0, x1, y1 = box
    h, w = mask_u8.shape[:2]
    x0c, y0c = max(0, x0), max(0, y0)
    x1c, y1c = min(w, x1), min(h, y1)
    if x1c <= x0c or y1c <= y0c:
        return rgba, mask_u8

    sub_rgba = rgba[y0c:y1c, x0c:x1c]
    sub_mask = mask_u8[y0c:y1c, x0c:x1c]

    pad_l, pad_t = x0c - x0, y0c - y0
    pad_r, pad_b = x1 - x1c, y1 - y1c
    if pad_l or pad_t or pad_r or pad_b:
        sub_rgba = np.pad(sub_rgba, ((pad_t, pad_b), (pad_l, pad_r), (0, 0)))
        sub_mask = np.pad(sub_mask, ((pad_t, pad_b), (pad_l, pad_r)))
    return sub_rgba, sub_mask


class QGRemoveBackgroundByMask:
    """按遮罩抠图：保留遮罩区域，挖掉其余部分。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {"tooltip": "Source image; all frames in a batch share one crop box so the output stays stackable."},
                ),
                "mask": (
                    "MASK",
                    {"tooltip": "Mask: values above 127 are kept, the rest is cut away. Resized to the image if sizes differ; the last mask is reused when the batch has fewer masks than images."},
                ),
                "fill_holes": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "Fill enclosed holes surrounded by foreground (e.g. a ring made by an arm). Only interior gaps are filled; the outside background is untouched."},
                ),
                "crop_to_mask": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "Crop the empty border using the foreground bounding box, keeping just the subject area. Turn off to keep the original canvas."},
                ),
                "crop_factor": (
                    "FLOAT",
                    {"default": 1.2, "min": 1.0, "max": 2.0, "step": 0.1,
                     "tooltip": "How far to expand the crop box. 1.0 hugs the subject, 1.2 leaves some margin; larger values leave more empty space."},
                ),
                "stroke_width": (
                    "INT",
                    {"default": 0, "min": 0, "max": 512, "step": 1,
                     "tooltip": "Width in pixels of the outline drawn outside the foreground edge; 0 disables it."},
                ),
                "stroke_color": (
                    "STRING",
                    {"default": DEFAULT_STROKE_COLOR,
                     "tooltip": "Outline colour, also used as the backdrop of the RGB output. Accepts #RRGGBB / #RGB / RRGGBB; invalid values fall back to the default instead of erroring."},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK")
    RETURN_NAMES = ("rgba", "rgb", "mask")
    OUTPUT_TOOLTIPS = (
        "RGBA cutout with a transparent background.",
        "Opaque RGB version: transparent areas are filled with the stroke colour.",
        "The single-channel mask after hole filling and cropping.",
    )
    FUNCTION = "remove_background"
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = "Cut out a subject using a mask: keep the pixels inside the mask and make everything else transparent. Optionally fill enclosed holes, crop to the subject bounding box with an adjustable margin, and add an outline. Returns an RGBA image, an RGB image composited over the stroke colour, and the mask actually used. A batch shares one crop box so every frame has the same size."
    SEARCH_ALIASES = [
        "remove background", "cutout", "mask", "alpha", "stroke", "outline",
        "抠图", "去背景", "遮罩", "描边", "裁边", "qg",
    ]

    def remove_background(self, image, mask, fill_holes=True, crop_to_mask=True,
                          crop_factor=1.2, stroke_width=0,
                          stroke_color=DEFAULT_STROKE_COLOR):
        stroke_width = max(0, int(stroke_width))
        crop_factor = float(crop_factor)
        if crop_factor < 1.0:
            crop_factor = 1.0
        bg_rgb = _hex_to_rgb(stroke_color)

        frames = self._prepare(image, mask, fill_holes)

        # 空批次（批量切完是空的、上游没给画面）：返回同形状的空张量。
        # 原先会走到 np.stack([]) 抛 "need at least one array to stack"，
        # 看起来像插件坏了，其实只是没东西可处理。
        if not frames:
            shape = getattr(image, "shape", ()) or ()
            height = int(shape[1]) if len(shape) >= 3 else 1
            width = int(shape[2]) if len(shape) >= 3 else 1
            return (
                torch.zeros((0, height, width, 4)),
                torch.zeros((0, height, width, 3)),
                torch.zeros((0, height, width)),
            )

        # batch 共用同一个裁剪框，避免逐帧尺寸不同导致 torch.cat 失败
        box = None
        if crop_to_mask:
            for rgba, mask_u8 in frames:
                box = _union(box, _bbox(mask_u8 > 127))
            if box is not None:
                box = _expand_box(box, crop_factor, stroke_width)

        rgba_out, rgb_out, mask_out = [], [], []
        for rgba, mask_u8 in frames:
            if box is not None:
                rgba, mask_u8 = _cut_with_pad(rgba, mask_u8, box)

            keep = mask_u8 > 127
            cut = rgba.copy()
            cut[..., 3] = np.where(keep, 255, 0).astype(np.uint8)

            if stroke_width > 0 and keep.any():
                ring = _dilate(keep, stroke_width) & ~keep
                cut[ring] = (*bg_rgb, 255)

            alpha = cut[..., 3:4].astype(np.float32) / 255.0
            rgb = cut[..., :3].astype(np.float32) * alpha \
                + np.array(bg_rgb, np.float32) * (1.0 - alpha)
            rgb = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)

            rgba_out.append(cut)
            rgb_out.append(rgb)
            mask_out.append(mask_u8.astype(np.float32) / 255.0)

        rgba_batch = torch.from_numpy(
            np.stack(rgba_out).astype(np.float32) / 255.0)
        rgb_batch = torch.from_numpy(
            np.stack(rgb_out).astype(np.float32) / 255.0)
        mask_batch = torch.from_numpy(np.stack(mask_out))
        return (rgba_batch, rgb_batch, mask_batch)

    def _prepare(self, image, mask, fill_holes):
        """把 batch 拆成 [(RGBA ndarray, mask uint8)]，尺寸统一、遮罩已对齐。"""
        arr = image if isinstance(image, np.ndarray) else image.cpu().numpy()
        if arr.ndim == 3:
            arr = arr[None]
        masks = mask if isinstance(mask, np.ndarray) else mask.cpu().numpy()
        if masks.ndim == 2:
            masks = masks[None]
        elif masks.ndim == 4:
            masks = masks[:, 0]

        out = []
        for i in range(arr.shape[0]):
            rgb_u8 = (np.clip(arr[i], 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
            if rgb_u8.shape[-1] == 4:
                rgba = rgb_u8.copy()
            else:
                rgba = np.dstack([rgb_u8, np.full(rgb_u8.shape[:2], 255, np.uint8)])
            h, w = rgba.shape[:2]

            src = masks[min(i, masks.shape[0] - 1)]
            mask_u8 = (np.clip(src, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
            if mask_u8.shape != (h, w):
                mask_u8 = np.array(
                    Image.fromarray(mask_u8, "L").resize((w, h), Image.BILINEAR))
            if fill_holes:
                mask_u8 = _fill_holes(mask_u8)
            out.append((rgba, mask_u8))
        return out


NODE_CLASS_MAPPINGS = {"QG_RemoveBGByMask": QGRemoveBackgroundByMask}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RemoveBGByMask": "Remove BG by Mask"}

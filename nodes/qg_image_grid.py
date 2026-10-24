# -*- coding: utf-8 -*-
"""QG_ImageGrid - tile a batch (or a tensor list) into a neat grid.

Ported from ComfyUI_Muye (image/image_grid_concat.py, class 宫格图像拼接),
MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips, debug prints dropped.
  * Grid geometry is unchanged: 1 image -> 1x1, 2 -> 2x1, 3-4 -> 2x2,
    5-9 -> 3 columns, 10-16 -> 4 columns (max 16 cells / 4 columns).
  * Frames that are entirely black are dropped before tiling. Upstream did this
    because batch nodes in the wild pad unused slots with ``torch.zeros``; the
    side effect is that a genuinely black frame is skipped too. The tooltip
    says so - turn the switch off if you need an all-black frame kept.

The node is an output node (it renders a preview) but still returns the grid as
a normal IMAGE, so it can sit in the middle of a graph.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import math
import os
import random

import numpy as np
import torch
from PIL import Image
from torch.nn.functional import interpolate

import folder_paths
from ._qg_combo_legacy import combo_legacy

MAX_IMAGES = 16
MAX_COLS = 4


def _is_empty_frame(image):
    flat = image.detach().to(device="cpu").float().view(-1)
    return flat.numel() == 0 or float(flat.max().item()) == 0.0


def _norm_image(image):
    """Normalise any plausible input into [1, H, W, 3] float32 in 0-1."""
    if isinstance(image, (list, tuple)):
        image = image[0]
    image = image.detach().to(device="cpu").float()
    if image.dim() == 2:
        image = image.unsqueeze(0).unsqueeze(-1)
    elif image.dim() == 3:
        if image.shape[0] == 1 or image.shape[-1] > 1:
            image = image.unsqueeze(0)
        else:
            image = image.unsqueeze(-1)
    if image.shape[0] > 1:
        image = image[0:1]
    channels = image.shape[-1]
    if channels == 1:
        image = image.repeat(1, 1, 1, 3)
    elif channels > 3:
        image = image[..., 0:3]
    return image.clamp(0.0, 1.0).contiguous()


def _resize(image, width, height):
    if image.shape[1] == height and image.shape[2] == width:
        return image
    x = image.permute(0, 3, 1, 2)
    x = interpolate(x, size=(height, width), mode="bilinear", align_corners=False)
    return x.permute(0, 2, 3, 1).contiguous()


def _make_grid(images, cols, rows, match_size, gap, background):
    count = len(images)
    if match_size:
        cell_w, cell_h = images[0].shape[2], images[0].shape[1]
        sizes = []
        for i in range(count):
            w, h = images[i].shape[2], images[i].shape[1]
            scale = min(cell_w / w, cell_h / h)
            sizes.append((max(1, int(round(w * scale))), max(1, int(round(h * scale)))))
        col_widths = [cell_w] * cols
        row_heights = [cell_h] * rows
    else:
        col_widths = []
        for c in range(cols):
            idxs = [r * cols + c for r in range(rows) if r * cols + c < count]
            col_widths.append(max(images[i].shape[2] for i in idxs))
        row_heights = []
        for r in range(rows):
            idxs = [i for i in range(r * cols, min((r + 1) * cols, count))]
            row_heights.append(max(images[i].shape[1] for i in idxs))
        sizes = []
        for i in range(count):
            r, c = divmod(i, cols)
            sizes.append((col_widths[c], row_heights[r]))

    canvas_w = sum(col_widths) + (cols - 1) * gap
    canvas_h = sum(row_heights) + (rows - 1) * gap
    fill = 0.0 if background == "black" else 1.0
    canvas = torch.full((1, canvas_h, canvas_w, 3), fill, dtype=torch.float32)

    xs, x = [], 0
    for w in col_widths:
        xs.append(x)
        x += w + gap
    ys, y = [], 0
    for h in row_heights:
        ys.append(y)
        y += h + gap

    for i in range(count):
        r, c = divmod(i, cols)
        cell_w, cell_h = sizes[i]
        image = _resize(images[i], cell_w, cell_h)
        x0 = xs[c] + (col_widths[c] - cell_w) // 2
        y0 = ys[r] + (row_heights[r] - cell_h) // 2
        canvas[:, y0:y0 + cell_h, x0:x0 + cell_w, :] = image
    return canvas


@combo_legacy("QG_ImageGrid")
class QGImageGrid:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Tiles a batch or tensor list into a compact grid: 1 image becomes 1x1, "
        "two become 2x1, three or four 2x2, five to nine use three columns and up "
        "to sixteen use four. Optionally unifies every cell to the first image's "
        "size (letterboxed, never cropped), sets the gap and the background "
        "colour, and shows the result as a preview."
    )
    SEARCH_ALIASES = [
        "grid", "contact sheet", "tile", "montage", "宫格", "拼接", "九宫格", "qg",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, background=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": (
                    "IMAGE",
                    {
                        "forceInput": True,
                        "tooltip": "A batch or a list of tensors; only the first 16 are used.",
                    },
                ),
                "match_size": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "On: every cell takes the first image's size, each picture fitted inside it without cropping. Off: every picture keeps its own size.",
                    },
                ),
                "drop_black": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": (
                            "On: drop fully black frames (batch nodes often pad unwired inputs "
                            "with black). Off: they are tiled like any other frame."
                        ),
                    },
                ),
                "gap": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000,
                        "step": 1,
                        "tooltip": "Gap between cells, in pixels.",
                    },
                ),
                "background": (
                    ["black", "white"],
                    {"default": "black", "tooltip": "Color behind the gaps and the empty space."},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The tiled grid image.",
    )
    FUNCTION = "run"
    OUTPUT_NODE = True

    def run(self, images, match_size=True, drop_black=True, gap=0, background="black"):
        if isinstance(images, torch.Tensor):
            if images.ndim == 4:
                items = [images[i] for i in range(images.shape[0])]
            elif images.ndim == 3:
                items = [images]
            else:
                raise ValueError("[QG-tools] 宫格拼接：images 需要 3 维或 4 维张量，或张量列表")
        elif isinstance(images, (list, tuple)):
            items = list(images)
        else:
            raise ValueError("[QG-tools] 宫格拼接：images 需要 3 维或 4 维张量，或张量列表")

        items = [item for item in items if item is not None]
        if drop_black:
            items = [item for item in items if not _is_empty_frame(item)]
        if not items:
            raise ValueError("[QG-tools] 宫格拼接：没有可拼接的图像（列表为空，或全黑帧都被剔除了）")
        if len(items) > MAX_IMAGES:
            items = items[:MAX_IMAGES]

        images = [_norm_image(item) for item in items]
        cols = min(MAX_COLS, math.ceil(math.sqrt(len(images))))
        rows = math.ceil(len(images) / cols)
        grid = _make_grid(images, cols, rows, match_size, gap, background)
        return {"ui": {"images": self._preview(grid)}, "result": (grid,)}

    @staticmethod
    def _preview(image):
        out_dir = folder_paths.get_temp_directory()
        prefix = "QG_Grid_temp_" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(5))
        filename = prefix + ".png"
        array = np.clip(255.0 * image[0].cpu().numpy(), 0, 255).astype(np.uint8)
        Image.fromarray(array).save(os.path.join(out_dir, filename), compress_level=1)
        return [{"filename": filename, "subfolder": "", "type": "temp"}]


NODE_CLASS_MAPPINGS = {"QG_ImageGrid": QGImageGrid}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageGrid": "Image Grid"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

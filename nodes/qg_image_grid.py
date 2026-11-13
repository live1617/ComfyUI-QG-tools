# -*- coding: utf-8 -*-
"""QG_ImageGrid - tile a batch (or a tensor list) into a neat grid.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.5 port of
ComfyUI_Muye's 「宫格图像拼接」 (MIT). The five widgets, the auto geometry, the
black-frame filter and the preview output are unchanged.

What the port got right, and is kept
------------------------------------
* **Auto geometry**: 1 image is 1x1, 2 become 2x1, 3-4 become 2x2, 5-9 use
  three columns, 10-16 use four - at most 16 cells, at most 4 columns.
* **``match_size`` letterboxes instead of cropping**: every cell takes the
  first image's box and each picture is scaled down to fit inside it, centred,
  never cut. The rest of the cell keeps the background colour.
* **``drop_black``** exists because batch nodes in the wild pad unused slots
  with ``torch.zeros``; the side effect (a genuinely black frame is skipped
  too) is real and stays documented rather than silently "fixed".
* Cells are centred inside their column/row band when sizes differ, so a
  narrow picture does not hug the left edge.
* Still an output node that also returns the grid as a normal IMAGE.

What this rewrite changed
-------------------------
* **A grey image used to come out one pixel wide.** The port classified a 3-D
  input with::

      if image.shape[0] == 1 or image.shape[-1] > 1:   # "a batch"
          image = image.unsqueeze(0)
      else:                                            # "a picture"
          image = image.unsqueeze(-1)

  A single-channel picture is ``(H, W, 1)``: ``shape[0]`` is the height, so it
  fell into the first branch, became ``(1, H, W, 1)``, then ``(H, W, 1, 3)``
  after the channel repeat, then ``[0:1]`` kept one *row* - the cell was H wide
  and 1 tall. The test is the last dimension now: ``(H, W, C)`` when it is at
  most 4, ``(B, H, W)`` otherwise, which is the same rule the rest of the pack
  uses for three-dimensional tensors.
* **A grey *batch* ``(B, H, W)`` used to be treated as one picture** - the
  same classification, from the other side. It now splits into frames, so a
  grey batch tiles like any other.
* **Two-channel input crashed** on the canvas assignment (neither the
  ``channels == 1`` nor the ``channels > 3`` branch caught it). It now takes
  the first channel as grey.
* ``drop_black`` no longer assumes every item is a tensor: a list entry that
  is itself a list is unwrapped first instead of raising ``AttributeError``.
* ``FUNCTION`` is ``execute``, matching the rest of the pack.

Only stdlib / numpy / torch / Pillow are used -- no new dependency.
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
from ._qg_tensor_helpers import as_image_batch

MAX_IMAGES = 16
MAX_COLS = 4

# 「(H,W,C) 一张图 还是 (B,H,W) 灰度多帧」的判据现在只有一处：
# `_qg_tensor_helpers.MAX_CHANNELS`。这个文件原本自己也定义了一份，已合并 ——
# 搬运版看的是第 0 维，于是灰度图被当成批次、灰度批次被当成一张图，两头都错。


def _is_empty_frame(image):
    """All-zero frame? Batch nodes pad unused slots with zeros, hence the filter."""
    if isinstance(image, (list, tuple)):
        image = image[0] if image else None
    if not torch.is_tensor(image):
        return False
    flat = image.detach().to(device="cpu").float().reshape(-1)
    return flat.numel() == 0 or float(flat.max().item()) == 0.0


def _norm_image(image):
    """Any rank to ``[1, H, W, 3]`` float32 in 0-1, keeping one frame.

    The port's 3-D branch keyed off dimension 0, which is the *height* for an
    ``(H, W, C)`` picture - see the module docstring for what that did to a
    grey image.
    """
    if isinstance(image, (list, tuple)):
        image = image[0] if image else None
    if not torch.is_tensor(image):
        raise ValueError("[QG-tools] Image Grid: the list contains a non-tensor entry")
    image = image.detach().to(device="cpu").float()

    image, _ = as_image_batch(image, "Image Grid: image")

    if image.shape[0] > 1:                      # 4 维批次只取第一帧
        image = image[0:1]

    channels = image.shape[-1]
    if channels == 1:
        image = image.repeat(1, 1, 1, 3)
    elif channels == 2:
        # 只有两个通道的图不是 ComfyUI 的常规产物，但别让它在赋值那一步炸。
        image = image[..., 0:1].repeat(1, 1, 1, 3)
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
    CATEGORY = "QG-tools/Image/Output"
    DESCRIPTION = (
        "Tiles a batch or a tensor list into a compact grid: 1 image becomes "
        "1x1, two become 2x1, three or four 2x2, five to nine use three columns "
        "and up to sixteen use four. Optionally unifies every cell to the first "
        "image's size (letterboxed, never cropped), sets the gap and the "
        "background colour, and shows the result as a preview."
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
                        "tooltip": "On: every cell takes the first image's size, each picture fitted "
                                   "inside it without cropping. Off: every picture keeps its own size.",
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
    FUNCTION = "execute"
    OUTPUT_NODE = True

    def execute(self, images, match_size=True, drop_black=True, gap=0, background="black"):
        if torch.is_tensor(images):
            # 3 维可能是「一张 (H,W,C)」也可能是「一批 (B,H,W) 灰度帧」，
            # 拆法不同 —— 判据只在 `as_image_batch` 里写一次。
            batch, _ = as_image_batch(images, "Image Grid: image")
            items = [batch[i] for i in range(batch.shape[0])]
        elif isinstance(images, (list, tuple)):
            items = list(images)
        else:
            raise ValueError("[QG-tools] Image Grid: images must be a 3D or 4D tensor, or a list of tensors")

        items = [item for item in items if item is not None]
        if drop_black:
            items = [item for item in items if not _is_empty_frame(item)]
        if not items:
            raise ValueError(
                "[QG-tools] Image Grid: no image to tile (the list is empty, or every "
                "all-black frame was dropped) - if the input really is all black, turn off "
                "Drop All-Black."
            )
        if len(items) > MAX_IMAGES:
            items = items[:MAX_IMAGES]

        frames = [_norm_image(item) for item in items]
        cols = min(MAX_COLS, math.ceil(math.sqrt(len(frames))))
        rows = math.ceil(len(frames) / cols)
        grid = _make_grid(frames, cols, rows, match_size, gap, background)
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

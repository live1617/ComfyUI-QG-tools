# -*- coding: utf-8 -*-
"""QG_LoadImage — load a picture from ComfyUI's input folder, mask included.

Core's Load Image hands every frame back as three RGB channels, so a
see-through pixel arrives with whatever colour was stored underneath it:
black for most cutouts, sometimes a green screen. Composite that over
anything and the halo shows. Its mask is also a 64 x 64 zero block when the
file has no alpha at all, which matches neither the picture nor any other
node's expectation.

Two outputs: the picture and the mask. Everything else (width, height, frame
count, file name) is already written under the picture in the panel, so it
does not take a slot.

A mask painted in the editor is stored the way Goohai's editor stores it: two
PNGs in ``input/clipspace``, one holding the picture untouched, one holding
the picture with the mask in its alpha channel. Reading pairs them back up, so
the alpha of the mask never leaks into IMAGE -- the picture comes out exactly
as it went in, and only MASK carries the mask.

保留透明通道 (keep alpha): off, a see-through pixel is composited over white,
which is what every viewer shows; on, the frame keeps four channels.

输出带色图 (tinted): paint the chosen colour over the masked area at the
chosen strength and hand that back as IMAGE -- the same thing Goohai's
"github colours" switch does, except it is off by default and the clean
picture stays available by turning it off.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import torch

from ._qg_combo_legacy import combo_legacy
from ._qg_media_helpers import (
    list_input_images,
    load_image_frames,
    resolve_input_path,
)
from ._qg_transform_engine import stable_file_fingerprint

# What our mask editor writes, next to ComfyUI's own clipspace files. Both
# names carry the same 13-digit stamp, which is what pairs them:
#   qg-src-<stamp>.png                the picture, untouched (kept for alpha)
#   qg-painted-<stem>-<stamp>.png     the picture with the mask in its alpha
PAINTED_NAME = re.compile(
    r"^qg-painted-(?P<stem>.+)-(?P<stamp>\d{13})\.png$", re.IGNORECASE
)

# The same nine colours the mask editor offers, so a tint picked there and a
# tint picked here mean the same thing.
TINT_COLORS = {
    "white": (255, 255, 255),
    "red": (255, 48, 48),
    "orange": (255, 140, 32),
    "yellow": (255, 229, 46),
    "green": (40, 214, 111),
    "cyan": (36, 217, 209),
    "blue": (52, 124, 255),
    "purple": (176, 76, 255),
    "gray": (128, 128, 128),
}


def _paired_source(path: Path) -> Path | None:
    """The untouched copy that goes with a painted file, if it is still there."""
    match = PAINTED_NAME.match(path.name)
    if not match:
        return None
    candidate = path.parent / f"qg-src-{match['stamp']}.png"
    return candidate if candidate.is_file() else None


def _has_baked_colour(colour, clean, mask):
    """Did the editor burn colours into the painted file?

    Mask editor 3.0 saves every stroke's colour into the painted PNG's RGB
    (the same trick Goohai's "colour overlay" uses), so IMAGE can hand that
    back directly and keep all the colours. Files written by older versions
    keep the picture untouched in RGB -- for those we still mix the single
    tint, which is why this check exists at all.

    Compared only inside the mask: outside it both pictures are the same
    photo, and any difference there is codec rounding, not colour.
    """
    inside = mask > 0.5
    if not bool(inside.any()):
        return False
    diff = float(np.abs(colour[inside] - clean[inside]).mean())
    return diff > 0.02      # ~5/255; a 50% tint of any palette colour is far above


@combo_legacy("QG_LoadImage")
class QGLoadImage:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Load an image from ComfyUI's input folder and get two things out: "
        "the picture and its mask. A mask painted in the editor is kept beside "
        "the picture and read back through the alpha channel, so the picture "
        "output stays exactly as it was. Turn on the tinted output to hand "
        "back the picture with the mask area painted in a colour."
    )
    SEARCH_ALIASES = [
        "load image", "open image", "import image", "upload image", "image input",
        "rgba", "alpha", "transparent png", "cutout", "mask", "mask editor",
        "tinted", "mask colour", "加载图像", "上传图像", "透明", "抠图",
        "遮罩", "遮罩编辑", "带色", "遮罩颜色", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    list_input_images(),
                    {
                        "image_upload": True,
                        "tooltip": (
                            "Choose or upload an image from ComfyUI's input "
                            "folder. The mask editor writes its save back here."
                        ),
                    },
                ),
            },
            "optional": {
                "keep_alpha": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "on",
                        "label_off": "off",
                        "tooltip": (
                            "Off: a see-through pixel is composited over white, "
                            "which is what a picture viewer shows. On: the frame "
                            "keeps four channels and the transparency is handed "
                            "on as it is."
                        ),
                    },
                ),
                "tint_output": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "on",
                        "label_off": "off",
                        "tooltip": (
                            "Off: the picture comes out clean, the mask only on "
                            "the mask output. On: hand back the colours painted "
                            "in the mask editor -- every brush stroke keeps its "
                            "own colour, and the strength is the editor's "
                            "opacity slider. Files saved by older versions (no "
                            "colour baked in) fall back to the single colour "
                            "below."
                        ),
                    },
                ),
                "tint_color": (
                    list(TINT_COLORS),
                    {
                        "default": "green",
                        "tooltip": (
                            "The colour the mask is painted with when the "
                            "tinted output is on. The mask editor writes its "
                            "own choice back here when it saves."
                        ),
                    },
                ),
                "tint_alpha": (
                    "INT",
                    {
                        "default": 50,
                        "min": 0,
                        "max": 100,
                        "step": 5,
                        "tooltip": (
                            "How much of the colour is mixed in, in percent. "
                            "50 keeps the picture readable underneath."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    OUTPUT_TOOLTIPS = (
        "The picture. A painted mask never shows up here unless the tinted "
        "output is turned on.",
        "1 where the mask is painted, 0 where it is not; always the picture's "
        "own size, never a 64 x 64 stand-in.",
    )
    FUNCTION = "load_image"

    def load_image(
        self,
        image,
        keep_alpha=False,
        tint_output=False,
        tint_color="green",
        tint_alpha=50,
    ):
        path = resolve_input_path(image)
        frames = load_image_frames(path)

        painted = PAINTED_NAME.match(path.name) is not None
        source = _paired_source(path) if painted else None
        source_frames = None
        if source is not None:
            try:
                source_frames = load_image_frames(source)
            except Exception:
                source_frames = None

        tint = None
        if tint_output:
            rgb = TINT_COLORS.get(str(tint_color), TINT_COLORS["green"])
            tint = (np.asarray(rgb, dtype=np.float32) / 255.0,
                    min(max(float(tint_alpha), 0.0), 100.0) / 100.0)

        images = []
        masks = []
        for index, frame in enumerate(frames):
            rgba = np.asarray(frame, dtype=np.float32) / 255.0
            colour = rgba[..., :3]
            stored_alpha = rgba[..., 3]
            # A painted file stores the mask in alpha, so that channel is not
            # transparency at all -- the picture's own alpha comes from the
            # untouched copy saved beside it.
            mask = 1.0 - stored_alpha
            masks.append(mask)
            clean = colour
            if painted:
                if source_frames:
                    source = np.asarray(
                        source_frames[min(index, len(source_frames) - 1)],
                        dtype=np.float32,
                    ) / 255.0
                    base = source[..., 3]
                    if base.shape != stored_alpha.shape:
                        base = np.ones_like(stored_alpha)
                    else:
                        # The editor bakes the picked colours into the painted
                        # file's RGB, so the clean picture has to come from the
                        # untouched copy -- otherwise every colour painted in
                        # the editor would leak into IMAGE.
                        clean = source[..., :3]
                else:
                    # The untouched copy is gone: the mask cannot be undone,
                    # so treat the picture as fully opaque rather than punch
                    # holes in it.
                    base = np.ones_like(stored_alpha)
            else:
                base = stored_alpha

            if tint is not None:
                if painted and _has_baked_colour(colour, clean, mask):
                    # The file already carries the editor's colours (one per
                    # brush stroke), so hand it back as it is -- mixing our own
                    # tint on top would repaint every colour into one.
                    colour = colour
                else:
                    # Mix by how strongly the mask covers each pixel, so a
                    # feathered edge fades instead of ending in a hard line.
                    rgb, strength = tint
                    weight = (mask * strength)[..., None]
                    colour = clean * (1.0 - weight) + rgb * weight
            else:
                colour = clean

            if keep_alpha:
                images.append(np.dstack([colour, base]))
            else:
                # An opaque pixel multiplies by 1 and adds nothing, so it keeps
                # exactly the value it always had.
                images.append(colour * base[..., None] + (1.0 - base)[..., None])

        return (
            torch.from_numpy(np.stack(images).astype(np.float32)),
            torch.from_numpy(np.stack(masks).astype(np.float32)),
        )

    @classmethod
    def VALIDATE_INPUTS(cls, image, tint_color=None):
        # tint_color 只是具名报上去，让 ComfyUI 跳过「值必须在列表里」这道检查
        # （老存档或中文界面存下的值可能是中文），真正的换值在 combo_legacy 里做。
        # ComfyUI 跳过它的列表检查时，也会把上传待扫描、遮罩编辑器存的
        # "… [input]" 一并放过，所以 image 这里要自己查文件。
        try:
            resolve_input_path(image)
        except Exception as exc:
            return f"Load Image: {exc}"
        return True

    @classmethod
    def IS_CHANGED(
        cls,
        image,
        keep_alpha=False,
        tint_output=False,
        tint_color="green",
        tint_alpha=50,
        **kwargs,
    ):
        # Every input is already part of ComfyUI's cache key; the fingerprint's
        # job is noticing a rewrite on disk under the same name.
        try:
            path = resolve_input_path(image)
        except Exception:
            path = Path(str(image or ""))
        parts = {
            "image": image,
            "keep_alpha": bool(keep_alpha),
            "tint_output": bool(tint_output),
            "tint_color": str(tint_color),
            "tint_alpha": int(tint_alpha),
        }
        paired = _paired_source(path) if path else None
        if paired is not None:
            try:
                parts["source"] = f"{paired.stat().st_size}:{paired.stat().st_mtime_ns}"
            except OSError:
                parts["source"] = "missing"
        return stable_file_fingerprint(path, parts)


NODE_CLASS_MAPPINGS = {"QG_LoadImage": QGLoadImage}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_LoadImage": "Load Image"}

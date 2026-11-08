# -*- coding: utf-8 -*-
"""QG_MaskColorize - paint a flat colour into the masked area of an image.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.5 port of
ComfyUI_Muye's ``MaskColorize`` (MIT). The three inputs, the six colour names
and the output are unchanged; what follows is what was wrong under them.

What the port got right, and is kept
------------------------------------
* **Six built-in colours, plus a wired RGB triple that wins over them.**
* **A soft mask is treated as a hard cut** at 0.5. "Paint this area" means
  binary - a 0.3 edge should not paint a 30% tint, which is what a plain
  multiply would do.
* **A single mask applies to every frame** of an image batch.
* The arithmetic stays in the image's own dtype and device.

What this rewrite changed
-------------------------
* **``color_rgb`` was a bare wildcard.** Without ``forceInput`` the frontend
  draws a text box for it on the canvas - a box that cannot produce a colour
  and that nobody would fill in. ``QG_Exists``, ``QG_RouteBlocker``,
  ``QG_TextOverlayImage`` (since removed), ``QG_ImageOrLatentSize`` and
  ``QG_FreeMemory`` all carried the same flag missing; this was the last one.
* **Fewer mask frames than image frames used to crash.** The port sliced
  ``mask[:image.shape[0]]`` when the counts disagreed, which does nothing when
  the mask is the shorter one - and the next multiply then failed on a shape
  mismatch. The shorter batch now repeats to fill, the longer one is trimmed.
* **A mask of a different size now says so.** Broadcasting ``(H, W)`` against
  a different ``(H, W)`` raised a generic runtime error naming tensor sizes;
  it now names both sizes in Chinese and points at the fix.
* **The colour triple is parsed once and clamped per channel.** The port
  decided between 0-1 and 0-255 by ``max(values) <= 1.0`` and then cast with
  ``int()``, which let a 300 through unclamped, died on a non-numeric entry,
  and could not read a tensor without a per-element Python loop.
* **No full-size colour layer is materialised.** ``ones_like(image) * colour``
  allocated another whole image just to be blended away; the colour is
  broadcast straight into the mix instead.
* ``FUNCTION`` is ``execute``, matching the rest of the pack.

What is deliberately *not* changed
----------------------------------
The 0-1 versus 0-255 guess. ``[1, 0, 0]`` is ambiguous - pure red on the 0-1
scale, near-black on the 0-255 one - and no rule can resolve it. The rule stays
"all three at or below 1 means 0-1, otherwise 0-255", which is what the port
did, and it is now written down in the tooltip instead of being implicit.

Modified 2026-11-01: ``color_rgb`` stays a wired-only input, and three optional
integer inputs (``r`` / ``g`` / ``b``) were added so a custom colour can be
typed straight onto the node instead of requiring an upstream triple. ``-1``
means "take this channel from the built-in colour", so setting only ``r`` keeps
the picked colour's green and blue. Precedence is unchanged at the top: a wired
``color_rgb`` still beats everything.

Only numpy / torch are used -- no new dependency.
"""

import torch

from ._qg_color_helpers import CHANNEL_UNSET, as_rgb_triple, channel_inputs, mix_channels
from ._qg_combo_legacy import combo_legacy
from ._qg_tensor_helpers import as_image_batch, as_mask_batch, match_size

COLOR_MAP = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "gray": (128, 128, 128),
    "red": (255, 0, 0),
    "green": (0, 255, 0),
    "blue": (0, 0, 255),
}

# 未知色名的兜底。combo 只有六个值，走到这里只可能是老存档里翻不出来的
# 中文值 —— 给红色是因为它一定看得出来，不会像黑/白那样被当成正常画面。
FALLBACK = (255, 0, 0)

# 三元组解析（原 `as_triple`）、通道合并（原 `mix_channels`）、三个通道输入
# （原本文件里手写的 r/g/b）现在都在 `_qg_color_helpers` 里 —— 文字叠加节点
# 曾经把这套抄了第二遍，两份的取整还不一样（一份截断一份四舍五入）。


def _fill_batch(mask, count):
    """Bring a (B, H, W) mask to exactly ``count`` frames by repeating or trimming."""
    if mask.shape[0] == count:
        return mask
    if mask.shape[0] == 0:
        return mask.new_zeros((count, mask.shape[1], mask.shape[2]))
    if mask.shape[0] < count:
        times = -(-count // mask.shape[0])
        return mask.repeat((times, 1, 1))[:count]
    return mask[:count]


@combo_legacy("QG_MaskColorize")
class QGMaskColorize:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Paints a flat colour into the masked area of an image. Pick one of six "
        "built-in colours, type a custom one into the R/G/B boxes (leave a box at "
        "-1 to keep that channel from the picker), or wire an RGB triple, which "
        "wins over both; a triple whose three numbers are all at or below 1 is "
        "read as 0-1, anything else as 0-255. The mask is cut hard at 0.5, so a "
        "soft edge does not produce a tint. One mask paints every frame of the "
        "batch; fewer mask frames than image frames repeat to fill. Handy for "
        "eyeballing a mask, or for burning a solid area into a region meant "
        "for inpainting."
    )
    SEARCH_ALIASES = ["mask", "colorize", "paint", "遮罩", "上色", "涂色", "qg"]

    @classmethod
    def VALIDATE_INPUTS(cls, color_name=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The base image; every frame of a batch is painted."}),
                "mask": (
                    "MASK",
                    {
                        "tooltip": (
                            "The mask: white areas (above 0.5) take the color, black areas keep "
                            "the image. One mask paints every frame; a shorter batch repeats to "
                            "fill. Must be the same width and height as the image."
                        )
                    },
                ),
                "color_name": (
                    list(COLOR_MAP.keys()),
                    {"default": "white", "tooltip": "One of the built-in colors; a wired RGB triple wins over it."},
                ),
            },
            "optional": {
                "color_rgb": (
                    "*",
                    {
                        # 不加 forceInput 画布上会多画一个填了也没用的文本框 ——
                        # 通配输入的通病，本包里出现过六次。
                        "forceInput": True,
                        "tooltip": "Optional custom color, as [R, G, B]. All three at or below 1 means "
                                   "a 0-1 triple; anything else is read as 0-255. Wins over both the "
                                   "picker and the three boxes below.",
                    },
                ),
                # 三个通道分开填：能只改一路，也能不连线就自定义颜色。
                # 默认 -1 = 这一路沿用「内置颜色」，所以老存档（没有这三个值）
                # 行为完全不变，还是按 color_name 上色。
                # 🔴 位置必须在 color_rgb **之后**，否则老工作流的
                # widgets_values 会跟控件错位、link 会指到错的槽。
                **channel_inputs(),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The image with the masked area painted.",
    )
    FUNCTION = "execute"

    def execute(self, image, mask, color_name, color_rgb=None,
                r=CHANNEL_UNSET, g=CHANNEL_UNSET, b=CHANNEL_UNSET):
        # 维度归一化与尺寸检查都走 `_qg_tensor_helpers`：同样的判断散在八个
        # 节点里各写了一遍，而且写的不是同一件事（见那个文件的说明）。
        image, _ = as_image_batch(image, "Mask Colorize: base image")
        mask = as_mask_batch(mask, "Mask Colorize: mask")

        # 尺寸必须在广播之前挡住：否则报的是「张量尺寸 64 与 32 无法广播」，
        # 用户看不出是遮罩和图像没对齐，也不知道该去改哪一头。
        match_size(mask, image, "Mask Colorize: mask")

        mask = _fill_batch(mask, image.shape[0])
        mask = (mask > 0.5).to(device=image.device, dtype=image.dtype).unsqueeze(-1)

        triple = as_rgb_triple(color_rgb)
        if triple is None:
            # 没接三元组才轮到「内置颜色 + 三个通道」：-1 的通道取预置分量。
            triple = mix_channels(COLOR_MAP.get(color_name, FALLBACK), r, g, b)
        # 直接把 (3,) 广播进混合，省掉一张整幅的纯色图。
        color = torch.tensor(triple, dtype=image.dtype, device=image.device) / 255.0
        out = image * (1.0 - mask) + color * mask
        return (out.clamp(0.0, 1.0),)


NODE_CLASS_MAPPINGS = {"QG_MaskColorize": QGMaskColorize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskColorize": "Mask Colorize"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

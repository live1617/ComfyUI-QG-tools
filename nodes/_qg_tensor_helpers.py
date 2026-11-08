# -*- coding: utf-8 -*-
"""IMAGE / MASK 张量的维度归一化：一处判，全库共用。

为什么要有这个文件
------------------
2026-11-01 之前，把输入「拍成 4 维」这件事在八个节点里各写了一遍
（`qg_color_correct` / `qg_color_match` / `qg_image_grid` / `qg_mask_colorize` /
`qg_mask_concat` / `qg_mask_crop`），
而且**写的不是同一件事**：

* 有的只认 `dim() == 3` 并直接 `unsqueeze(0)`，把 `(B, H, W)` 的灰度批次当成
  一张 `(H, W, B)` 的图；
* 有的（grid / watermark）多看一眼 `shape[-1] <= 4`，能分清「一张 (H,W,C)」
  和「一批 (B,H,W) 灰度帧」；
* 有的干脆没有 2 维分支，`(H, W)` 直接掉进「不是 4 维」的报错。

于是同一个输入在 A 节点能跑、在 B 节点报错。这里把最完整的那份判据定下来，
其余节点一律调用，**行为以更完整的为准**（以前报错的输入现在能跑，不会反过来）。

判据（`as_image_batch`）
------------------------
    (B, H, W, C)                     → 原样
    (H, W)                           → (1, H, W, 1)   灰度单图
    (H, W, C)  C <= MAX_CHANNELS     → (1, H, W, C)   单图
    (B, H, W)  末维 >  MAX_CHANNELS  → (B, H, W, 1)   灰度批次
    其它                              → ValueError，要点名是哪个输入

`as_mask_batch` 同理，但遮罩永远是单通道：
    (B, H, W) → 原样；(H, W) → (1, H, W)；(B, 1|C, H, W) → 按通道取 max。

返回 `(tensor, squeezed)`：`squeezed` 为真表示「本来没有批维，是我加上去的」，
调用方要还原输出时按它决定压不压回去（`qg_color_correct` 就是靠这个保形状）。

两个函数都**不复制**数据：`unsqueeze` / `max` 都是视图或原地廉价的归约。
"""

from __future__ import annotations

import torch

# 一张图最多几个通道。超过它就把最后一维当作空间维，而不是通道维 ——
# 这个数就是「(H, W, C) 还是 (B, H, W)」的唯一判据，别再各处自己定。
MAX_CHANNELS = 4


def as_image_batch(image: torch.Tensor, what: str = "IMAGE") -> tuple[torch.Tensor, bool]:
    """Bring an image tensor to (B, H, W, C). Returns (tensor, squeezed)."""
    if not isinstance(image, torch.Tensor):
        raise ValueError(
            "[QG-tools] %s needs an image tensor, got %s." % (what, type(image).__name__)
        )

    if image.dim() == 4:
        return image, False

    if image.dim() == 2:  # (H, W)
        return image.unsqueeze(0).unsqueeze(-1), True

    if image.dim() == 3:
        if image.shape[-1] <= MAX_CHANNELS:  # (H, W, C) —— 单张
            return image.unsqueeze(0), True
        # (B, H, W) —— 这是一批灰度帧，不是一张宽 B 的图
        return image.unsqueeze(-1), True

    raise ValueError(
        "[QG-tools] %s needs a 2-4D tensor, got %dD (shape=%s). "
        "An image should be (batch, height, width, channels)."
        % (what, image.dim(), tuple(image.shape))
    )


def as_mask_batch(mask: torch.Tensor, what: str = "MASK") -> torch.Tensor:
    """Bring a mask to (B, H, W). Returns the tensor only (masks have no channels)."""
    if not isinstance(mask, torch.Tensor):
        raise ValueError(
            "[QG-tools] %s needs a mask tensor, got %s." % (what, type(mask).__name__)
        )

    if mask.dim() == 3:
        return mask
    if mask.dim() == 2:  # (H, W)
        return mask.unsqueeze(0)
    if mask.dim() == 4:
        # (B, 1, H, W) 是「批维加一个留着没删的通道维」；(B, C, H, W) 也见过。
        # 取 max 对两种都成立，且单通道时是恒等。
        return mask.max(dim=1).values

    raise ValueError(
        "[QG-tools] %s needs a 2-4D tensor, got %dD (shape=%s). "
        "A mask should be (batch, height, width)."
        % (what, mask.dim(), tuple(mask.shape))
    )


def match_size(mask: torch.Tensor, image: torch.Tensor, what: str = "mask") -> None:
    """Raise a Chinese error naming both sizes when mask/image do not align.

    广播报错只说「形状 x 与 y 无法广播」，用户看不出是遮罩和图像没对齐，
    也不知道该改哪一头。放在这里是因为需要这条提示的节点不止一个。
    """
    if tuple(mask.shape[1:]) != tuple(image.shape[1:3]):
        raise ValueError(
            "[QG-tools] %s is %dx%d but the image is %dx%d; they must be the same size. "
            "Feed the mask and the image from the same source (one LoadImage, or one latent size), "
            "or align them with a scale / crop node."
            % (what, mask.shape[2], mask.shape[1], image.shape[2], image.shape[1])
        )


__all__ = ["MAX_CHANNELS", "as_image_batch", "as_mask_batch", "match_size"]

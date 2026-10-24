# -*- coding: utf-8 -*-
"""QG_ColorCorrect — one node, six sliders, the whole colour pass.

IMAGE in, IMAGE out. The sliders run in the order a colourist would use them:

    temperature (white balance) -> brightness -> contrast -> gamma
        -> saturation -> hue rotation

Everything is plain torch on the ``(B, H, W, C)`` float tensor: no OpenCV, no
Pillow round-trip, no 8-bit quantisation in the middle, no per-frame Python
loop -- the whole batch is one broadcast. Only torch is imported.

The slider set follows the ColorCorrect node from comfyui-art-venture (MIT)
so muscle memory carries over, but the maths is our own and avoids three traps
that one falls into:

  * it bounces every frame through ``uint8`` twice, which bands gradients;
  * its saturation slider scales the HLS *lightness* channel rather than the
    saturation channel, so pulling it down washes the picture out instead of
    greying it;
  * its temperature multiplies one channel only, which also changes the overall
    brightness -- here the three channel gains are normalised against the
    Rec.709 luma weights, so warming an image does not brighten it.

An alpha channel, if present, is carried through untouched.
"""

import torch

# Rec.709 luma weights -- used both for the saturation mix and for keeping the
# white-balance gains brightness-neutral.
LUMA_R, LUMA_G, LUMA_B = 0.2126, 0.7152, 0.0722

# How far the red and blue gains swing at temperature = +/-100. The green gain
# follows at a lower rate so that warming lands on yellow rather than red.
TEMPERATURE_SWING = 0.35
TEMPERATURE_GREEN_SWING = 0.12


class QGColorCorrect:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Six sliders for the whole colour pass: temperature (cool/warm), hue "
        "rotation, brightness, contrast, saturation and gamma. They are applied "
        "in that photographic order, on every frame of the batch at once, "
        "straight in float -- no 8-bit round-trip, so gradients stay smooth. "
        "Temperature is brightness-neutral and saturation is a proper "
        "luma-preserving mix. Push a value back to its default to skip that "
        "step entirely; gamma 1.0, brightness/contrast/saturation/temperature "
        "0 and hue 0 all mean untouched."
    )
    SEARCH_ALIASES = [
        "color correct", "colour correct", "colorcorrection", "color correction",
        "colour correction", "grading", "color grade", "color adjust",
        "temperature", "hue", "brightness", "contrast", "saturation", "gamma",
        "颜色校正", "调色", "校色",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {"tooltip": "The images to correct. A batch is handled in one pass, and an alpha channel is passed through untouched."},
                ),
                "temperature": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 1.0,
                        "tooltip": (
                            "Temperature: negative runs cooler and adds blue, positive runs "
                            "warmer and adds yellow. The three channel gains are normalised by "
                            "luminance weight, so this shifts colour only and never brightness."
                        ),
                    },
                ),
                "hue": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -180.0,
                        "max": 180.0,
                        "step": 1.0,
                        "tooltip": (
                            "Hue: how many degrees to rotate the hue of the whole image. 0 "
                            "leaves it alone and plus or minus 180 is a full turn; around 120 "
                            "swaps red for green and green for blue, which suits a wholesale "
                            "palette shift."
                        ),
                    },
                ),
                "brightness": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 1.0,
                        "tooltip": "Brightness: multiplies everything by a factor. 0 keeps it, -100 goes fully black, +100 doubles the brightness.",
                    },
                ),
                "contrast": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 1.0,
                        "tooltip": (
                            "Contrast: stretches around mid grey 0.5. 0 keeps it, -100 flattens "
                            "the whole frame to 0.5 grey, +100 doubles the light to dark "
                            "spread, so highlights and shadows clip sooner."
                        ),
                    },
                ),
                "saturation": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": -100.0,
                        "max": 100.0,
                        "step": 1.0,
                        "tooltip": (
                            "Saturation: blended by luminance. 0 keeps it, -100 goes pure black "
                            "and white with the brightness intact, +100 doubles the colour "
                            "intensity."
                        ),
                    },
                ),
                "gamma": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.1,
                        "max": 5.0,
                        "step": 0.01,
                        "tooltip": (
                            "Gamma: moves the midtones only and leaves both ends alone. 1.0 "
                            "keeps it, above 1 darkens the midtones, below 1 lifts them; it "
                            "holds the highlights better than plain brightness does."
                        ),
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The corrected images, same size and batch count as the input.",
    )
    FUNCTION = "color_correct"

    # ---- individual passes -------------------------------------------------

    @staticmethod
    def _white_balance(rgb, temperature):
        """Scale R/G/B so the tint changes but the luma does not."""
        warm = float(temperature) / 100.0
        red = 1.0 + TEMPERATURE_SWING * warm
        green = 1.0 + TEMPERATURE_GREEN_SWING * warm
        blue = 1.0 - TEMPERATURE_SWING * warm
        norm = LUMA_R * red + LUMA_G * green + LUMA_B * blue
        scale = 1.0 / norm
        gains = rgb.new_tensor([red * scale, green * scale, blue * scale])
        return rgb * gains

    @staticmethod
    def _saturate(rgb, amount):
        """Mix towards / away from the luma grey of each pixel."""
        factor = 1.0 + float(amount) / 100.0
        luma = (
            rgb[..., 0] * LUMA_R + rgb[..., 1] * LUMA_G + rgb[..., 2] * LUMA_B
        ).unsqueeze(-1)
        return luma + (rgb - luma) * factor

    @staticmethod
    def _rotate_hue(rgb, degrees):
        """Rotate hue in HSV space, leaving saturation and value alone.

        A linear feColorMatrix-style rotation is tempting (it is just one
        matmul) but it drags saturation down with the rotate: pure red at +120
        comes out at 44% green. Going through HSV keeps the colour as vivid as
        it was -- pure red lands on pure green.
        """
        red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        high = rgb.max(dim=-1).values
        low = rgb.min(dim=-1).values
        delta = high - low
        safe = delta.clamp_min(1e-12)

        # Hue in turns, then rotate. Grey pixels have delta == 0 and take the
        # first branch with hue 0 -- their saturation is 0 anyway, so whatever
        # sector they land in rebuilds the same grey.
        hue = torch.where(
            high == red,
            (high - blue) / safe - (high - green) / safe,
            torch.where(
                high == green,
                2.0 + (high - red) / safe - (high - blue) / safe,
                4.0 + (high - green) / safe - (high - red) / safe,
            ),
        )
        hue = (hue / 6.0 + float(degrees) / 360.0) % 1.0

        sat = torch.where(
            high > 0, delta / high.clamp_min(1e-12), torch.zeros_like(high)
        )

        sector_f = torch.floor(hue * 6.0)
        frac = hue * 6.0 - sector_f
        sector = sector_f.to(torch.int64) % 6
        p = high * (1.0 - sat)
        q = high * (1.0 - frac * sat)
        t = high * (1.0 - (1.0 - frac) * sat)
        v = high

        out_r = torch.where(
            sector == 0, v,
            torch.where(sector == 1, q,
                torch.where(sector == 2, p,
                    torch.where(sector == 3, p,
                        torch.where(sector == 4, t, v)))),
        )
        out_g = torch.where(
            sector == 0, t,
            torch.where(sector == 1, v,
                torch.where(sector == 2, v,
                    torch.where(sector == 3, q,
                        torch.where(sector == 4, p, p)))),
        )
        out_b = torch.where(
            sector == 0, p,
            torch.where(sector == 1, p,
                torch.where(sector == 2, t,
                    torch.where(sector == 3, v,
                        torch.where(sector == 4, v, q)))),
        )
        return torch.stack([out_r, out_g, out_b], dim=-1)

    # ---- entry point -------------------------------------------------------

    def color_correct(
        self,
        image,
        temperature=0.0,
        hue=0.0,
        brightness=0.0,
        contrast=0.0,
        saturation=0.0,
        gamma=1.0,
    ):
        if not torch.is_tensor(image):
            raise TypeError("image 需要是 IMAGE 张量")

        x = image
        squeeze = False
        if x.dim() == 3:  # 单张 (H, W, C)
            x = x.unsqueeze(0)
            squeeze = True
        if x.dim() != 4:
            raise ValueError("image 应该是 (B, H, W, C)，收到 %s" % (tuple(x.shape),))
        if x.shape[-1] < 3:
            raise ValueError("image 至少要 3 个通道，收到 %d" % x.shape[-1])

        out_dtype = x.dtype
        rgb = x[..., :3].to(torch.float32)
        alpha = x[..., 3:] if x.shape[-1] > 3 else None

        # 1) 白平衡 —— 只看色偏，不动亮度
        if float(temperature) != 0.0:
            rgb = self._white_balance(rgb, temperature)
        # 2) 明度
        if float(brightness) != 0.0:
            rgb = rgb * (1.0 + float(brightness) / 100.0)
        # 3) 对比度 —— 绕中灰拉伸
        if float(contrast) != 0.0:
            rgb = (rgb - 0.5) * (1.0 + float(contrast) / 100.0) + 0.5

        # 伽马要求非负底数，前面三步先收回显示范围
        if float(gamma) != 1.0:
            rgb = rgb.clamp(0.0, 1.0).pow(float(gamma))
        else:
            rgb = rgb.clamp(0.0, 1.0)

        # 4) 饱和度
        if float(saturation) != 0.0:
            rgb = self._saturate(rgb, saturation)
        # 5) 色相旋转
        if float(hue) != 0.0:
            rgb = self._rotate_hue(rgb, hue)

        rgb = rgb.clamp(0.0, 1.0).to(out_dtype)
        if alpha is not None:
            result = torch.cat([rgb, alpha.to(out_dtype)], dim=-1)
        else:
            result = rgb

        if squeeze:
            result = result.squeeze(0)
        return (result,)


NODE_CLASS_MAPPINGS = {"QG_ColorCorrect": QGColorCorrect}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ColorCorrect": "Color Correct"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

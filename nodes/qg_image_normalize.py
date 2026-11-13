# -*- coding: utf-8 -*-
"""QG_ImageNormalize - normalize an image onto a model's standard bucket.

1:1 of the author's own QG-Multipack plugin (``image_normalize_node.py``),
2026-11-08. Only wording and placement changed:

* CATEGORY "QG 工具" -> "QG-tools/Image";
* DESCRIPTION and the three tooltips anglicised (Chinese copy lives in
  ``locales/zh/nodeDefs.json`` and the translation pack);
* the two runtime ``ValueError`` messages stay Chinese, like every other node
  in this pack — they are run-time diagnostics, not UI copy.

Widget names and dropdown values were already English, so there is no
``LEGACY`` *migration* here. The tabled still carries Chinese *labels* for the
two dropdowns (``_qg_combo_legacy.LEGACY["QG_ImageNormalize"]``) because
``combo_zh.mjs`` reads the same table to draw Chinese option text; ``coerce()``
is a no-op for them since no saved workflow can hold those strings.

Behaviour
--------
The ``model`` dropdown picks a family AND a resolution tier in one go
(ComfyUI combos are static, so the two can't be linked dynamically):

* **Qwen-Image 1K / 2K** - the 13-ratio bucket table used for
  Qwen-Image-class models (32-multiple sizes; Qwen's hard requirement is
  16 = VAE 8x downsample x 2x2 latent patch packing). 1K totals ~1.05 MP,
  2K ~4.19 MP. Kept byte-identical to the community table so Qwen runs do
  not shift.
* **SDXL 1K** - the community-standard SDXL buckets (64-multiple sizes,
  ~1 MP): 1024^2, 1152x896, 1216x832, 1344x768, 1536x640 and their
  portraits. SDXL has no 5:4 / 2:1 buckets, so those ratios match to the
  nearest neighbour.
* **SD 1.5 512 / 768** - generated on the 8-px grid around the 512 / 768
  square budgets (SD 1.5 only needs 8-px alignment).
* **Flux 1MP / 2MP** - generated on the 16-px grid around 1 MP / 2 MP
  (Flux supports up to 2 MP).

Generation scores every grid cell by ``|log(ratio dev)| +
0.35 * |log(pixel dev)|`` - shape first, size second - and picks the best.

Matching: the input's aspect ratio goes to the bucket with the smallest
log-distance ``|log(source_ratio / bucket_ratio)|``. The image is scaled to
COVER that bucket and center-cropped (``ImageOps.fit``): output is exactly
the bucket size, never distorted, at the cost of trimming the edges.

``matched_ratio`` is the matched bucket's ratio NAME (STRING, e.g. "16:9").
``resolution_value`` is the tier's base square side (1:1 bucket width).

Note that ``_make_buckets`` runs at import time for the four generated tiers
(about half a million ``math.log`` calls). That is how the source file did it
and the tables are module-level constants other code reads, so it stays.
"""

from __future__ import annotations

import math

from ._qg_combo_legacy import combo_legacy

# ---- shared ratio ladder (name, w/h) -------------------------------------
RATIOS: tuple[tuple[str, float], ...] = (
    ("1:1", 1 / 1), ("4:3", 4 / 3), ("3:4", 3 / 4),
    ("5:4", 5 / 4), ("4:5", 4 / 5),
    ("3:2", 3 / 2), ("2:3", 2 / 3),
    ("16:9", 16 / 9), ("9:16", 9 / 16),
    ("21:9", 21 / 9), ("9:21", 9 / 21),
    ("2:1", 2 / 1), ("1:2", 1 / 2),
)


def _ratio(name: str) -> float:
    return dict(RATIOS)[name]


def _rows(pairs: tuple[tuple[str, int, int], ...]):
    """Build bucket rows from (ratio name, width, height) triples."""
    return tuple((name, _ratio(name), w, h) for name, w, h in pairs)


def _make_buckets(budget: int, align: int) -> tuple:
    """Generate a 13-ratio bucket table near a pixel budget.

    Grid-search w,h on the alignment grid; score = |log ratio dev| +
    0.35 x |log pixel dev| (shape first, size second).
    """
    side = int(math.isqrt(budget))
    lo = max(align, (side // 2 // align) * align)
    hi = (int(side * 1.6) // align) * align + align
    rows = []
    for name, r in RATIOS:
        best = None
        w = lo
        while w <= hi:
            h = lo
            while h <= hi:
                score = (abs(math.log((w / h) / r))
                         + 0.35 * abs(math.log((w * h) / budget)))
                if best is None or score < best[0]:
                    best = (score, w, h)
                h += align
            w += align
        rows.append((name, r, best[1], best[2]))
    return tuple(rows)


def _square_side(budget: int, align: int) -> int:
    """The 1:1 bucket side for a budget: budget rounded to the grid."""
    return max(align, int(round(math.sqrt(budget) / align)) * align)


# ---- hard-coded tables ----------------------------------------------------
# Qwen-Image: community bucket table (identical values across QG / Xinbao).
QWEN_1K = _rows((
    ("1:1", 1024, 1024), ("4:3", 1184, 896), ("3:4", 896, 1184),
    ("5:4", 1152, 928), ("4:5", 928, 1152),
    ("3:2", 1248, 832), ("2:3", 832, 1248),
    ("16:9", 1376, 768), ("9:16", 768, 1376),
    ("21:9", 1568, 672), ("9:21", 672, 1568),
    ("2:1", 1440, 736), ("1:2", 736, 1440),
))
QWEN_2K = _rows((
    ("1:1", 2048, 2048), ("4:3", 2368, 1760), ("3:4", 1760, 2368),
    ("5:4", 2304, 1824), ("4:5", 1824, 2304),
    ("3:2", 2496, 1664), ("2:3", 1664, 2496),
    ("16:9", 2720, 1536), ("9:16", 1536, 2720),
    ("21:9", 3136, 1344), ("9:21", 1344, 3136),
    ("2:1", 2912, 1440), ("1:2", 1440, 2912),
))
# SDXL: the community-standard 1 MP buckets (64-multiple sizes).
SDXL_1K = _rows((
    ("1:1", 1024, 1024), ("4:3", 1152, 896), ("3:4", 896, 1152),
    ("3:2", 1216, 832), ("2:3", 832, 1216),
    ("16:9", 1344, 768), ("9:16", 768, 1344),
    ("21:9", 1536, 640), ("9:21", 640, 1536),
))

# ---- family + tier registry ----------------------------------------------
# 🔴 别给它加类型标注（`X: dict[str, dict] = {...}`）：那是 ast.AnnAssign，
# tools/verify_combo_i18n.py 的 env 只收 ast.Assign，标注版会被漏掉，
# 连带 MODEL_CHOICES 求值成 None，报「model 在 INPUT_TYPES 里找不到」。
MODEL_TIERS = {
    "Qwen-Image 1K": {"align": 32, "buckets": QWEN_1K, "base": 1024},
    "Qwen-Image 2K": {"align": 32, "buckets": QWEN_2K, "base": 2048},
    "SDXL 1K": {"align": 64, "buckets": SDXL_1K, "base": 1024},
    "SD 1.5 512": {"align": 8, "buckets": _make_buckets(512 * 512, 8),
                   "base": _square_side(512 * 512, 8)},
    "SD 1.5 768": {"align": 8, "buckets": _make_buckets(768 * 768, 8),
                   "base": _square_side(768 * 768, 8)},
    "Flux 1MP": {"align": 16, "buckets": _make_buckets(1024 * 1024, 16),
                 "base": _square_side(1024 * 1024, 16)},
    "Flux 2MP": {"align": 16, "buckets": _make_buckets(2 * 1024 * 1024, 16),
                 "base": _square_side(2 * 1024 * 1024, 16)},
}
# list 而不是 tuple：本包的下拉覆盖检查（tools/verify_combo_coverage.py 的
# ev()、verify_combo_i18n.py）只认字面量列表 / list(dict) 两种写法，tuple(dict)
# 求值不出来，会误报「INPUT_TYPES 里找不到这个输入」。
MODEL_CHOICES = list(MODEL_TIERS)
METHODS = ("lanczos", "bicubic", "bilinear", "nearest")


def match_bucket(source_ratio: float, model: str) -> tuple[str, int, int]:
    """Return (ratio name, width, height) of the bucket closest in log space."""
    name, _, width, height = min(
        MODEL_TIERS[model]["buckets"],
        key=lambda item: abs(math.log(source_ratio / item[1])),
    )
    return name, width, height


@combo_legacy("QG_ImageNormalize")
class QGImageNormalize:
    """Scale onto the nearest standard bucket, center-crop, report the fit."""

    CATEGORY = "QG-tools/Image/Transform"
    DESCRIPTION = (
        "Scale an image onto the resolution bucket a model was trained on "
        "(Qwen-Image 1K / 2K, SDXL 1K, SD 1.5 512 / 768, Flux 1MP / 2MP) and "
        "center-crop it to that bucket's ratio. Also reports the resulting "
        "width and height, the source aspect ratio's matched bucket name and "
        "the tier's base square side, so downstream nodes can tell how much "
        "was trimmed."
    )
    SEARCH_ALIASES = [
        "normalize", "resolution", "resize", "aspect ratio", "bucket",
        "分辨率", "尺寸", "对齐", "缩放", "裁切", "画幅比", "标准化",
        "模型档位", "qg",
    ]
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):  # noqa: N802 - ComfyUI convention
        # 🔴 每个输入都写成 "名字": ( 换行 + 字典逐键换行：verify_bilingual /
        # verify_combo_i18n 靠正则找输入名，`"tooltip":` 留在行尾会让它们把所有
        # 输入误判成一个叫 tooltip 的输入。
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "Image to normalise. It is matched to the closest "
                            "bucket by aspect ratio, scaled without distortion, "
                            "then center-cropped."
                        ),
                    },
                ),
                "model": (
                    MODEL_CHOICES,
                    {
                        "default": "Qwen-Image 1K",
                        "tooltip": (
                            "Which model's bucket table to use. Families differ "
                            "in aspect ratios and total pixels; the output size "
                            "always lands on one of that model's buckets."
                        ),
                    },
                ),
                "resize_method": (
                    METHODS,
                    {
                        "default": "lanczos",
                        "tooltip": (
                            "Resampling filter. lanczos is the sharpest "
                            "(recommended), bicubic is smoother, bilinear is "
                            "faster, nearest keeps hard pixel edges."
                        ),
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "STRING", "INT")
    RETURN_NAMES = ("image", "width", "height", "matched_ratio", "resolution_value")
    # 🔴 ComfyUI 认的是 OUTPUT_TOOLTIPS，不是 RETURN_TOOLTIPS。写成后者不会报错，
    # 只是 /object_info 里根本没有这个字段、悬停永远看不到说明 —— 静默失效。
    OUTPUT_TOOLTIPS = (
        "The image cropped to the matched bucket, one frame per input frame.",
        "Width of the matched bucket.",
        "Height of the matched bucket.",
        "Name of the matched bucket's ratio, e.g. 16:9.",
        "The tier's base square side (its 1:1 bucket width).",
    )
    FUNCTION = "normalize"

    @classmethod
    def VALIDATE_INPUTS(cls, model=None, resize_method=None):
        # 两个下拉在 _qg_combo_legacy.LEGACY 里登记了中文标签，combo_legacy 会在
        # 执行前把漏网的老值 coerce 回来。这里点名这两个参数，让 ComfyUI 跳过
        # 「值必须在列表里」那道检查 —— 否则 coerce 根本轮不到。
        # 不写 **kwargs：那会把 IMAGE 等其余输入的校验一起关掉。
        return True

    def normalize(self, image, model, resize_method):
        import numpy as np  # noqa: PLC0415 - ComfyUI ships numpy
        from PIL import Image, ImageOps  # noqa: PLC0415 - ComfyUI ships Pillow

        # 老工作流里存着已经下架的档位名 / 算法名时，给一句能照做的提示，
        # 而不是 KeyError（提交阶段的 "Value not in list" 也看不懂）。
        if model not in MODEL_TIERS:
            raise ValueError(
                "Unknown resolution tier \"%s\". Available: %s" % (model, ", ".join(MODEL_CHOICES)))
        if resize_method not in METHODS:
            raise ValueError(
                "Unknown resize method \"%s\". Available: %s" % (resize_method, ", ".join(METHODS)))

        # 单帧丢成 3 维（H,W,C）在别的节点里是允许的写法，这里补齐一维，
        # 免得下游只报一句 "not enough values to unpack"。
        if image.dim() == 3:
            image = image.unsqueeze(0)
        batch, height, width = int(image.shape[0]), int(image.shape[1]), int(image.shape[2])
        if width < 1 or height < 1:
            raise ValueError("Invalid image size (width and height must be positive)")
        if batch == 0:
            # 空批次：上游什么都没给（比如批量切完是空的）。原样返回空张量，
            # 不抛异常——后面接的节点同样能处理空 IMAGE。
            return (image, 0, 0, "", MODEL_TIERS[model]["base"])
        ratio_name, out_w, out_h = match_bucket(width / float(height), model)
        flag = {
            "lanczos": Image.Resampling.LANCZOS,
            "bicubic": Image.Resampling.BICUBIC,
            "bilinear": Image.Resampling.BILINEAR,
            "nearest": Image.Resampling.NEAREST,
        }[resize_method]

        frames = []
        for i in range(batch):
            frame = image[i].detach().float().clamp(0.0, 1.0)
            arr = frame.cpu().numpy()
            # IMAGE 约定是 3 通道，但灰度图（1 通道）和带 alpha（4 通道）也会
            # 从别的节点流进来。直接 [..., :3] 对 1/2 通道无效，Pillow 会报
            # "Cannot handle this data type"；这里统一补成 3 通道再送进去。
            if arr.ndim == 2:
                arr = np.stack([arr, arr, arr], axis=-1)
            else:
                if arr.shape[-1] == 1:
                    arr = np.repeat(arr, 3, axis=-1)
                elif arr.shape[-1] == 2:
                    # 2 通道按 LA（灰度 + alpha）理解，只取亮度铺成 RGB。
                    # 早先写的是 concatenate([arr, arr[..., :1]])，拼出来是
                    # (L, A, L)——alpha 被当成绿色通道，带透明度的灰度图会
                    # 整体偏绿。亮度复制三份和单通道分支保持同一套语义。
                    arr = np.repeat(arr[..., :1], 3, axis=-1)
                elif arr.shape[-1] > 3:
                    # 4 通道是 RGBA：IMAGE 约定不带 alpha，直接取前三个。
                    arr = arr[..., :3]
            pil = Image.fromarray((arr * 255.0 + 0.5).astype("uint8"), mode="RGB")
            # cover-scale + center-crop: exact bucket size, no distortion
            fitted = ImageOps.fit(pil, (out_w, out_h), method=flag,
                                  centering=(0.5, 0.5))
            frames.append(np.asarray(fitted, dtype="float32") / 255.0)
        out = image.new_tensor(np.stack(frames, axis=0))
        return (out, out_w, out_h, ratio_name, MODEL_TIERS[model]["base"])


NODE_CLASS_MAPPINGS = {"QG_ImageNormalize": QGImageNormalize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageNormalize": "Image Normalize"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

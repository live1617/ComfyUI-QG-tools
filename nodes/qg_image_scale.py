# ============================================================
# 搬入说明（2026-11-08，用户确认后 1:1 搬运 + 值英文化 + 文案英化）
#   来源：作者自有插件 ComfyUI-QG-Multipack v0.1.0 / image_scale_node.py
#         （GPL-3.0-or-later）
#   原文件：D:////WorkBuddy////2026-10-10-13-25-05////intake////multipack-v0.1.0////
#           ComfyUI-QG-Multipack\\image_scale_node.py
#   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_ImageScale
#   概念参考：孤海工具箱 Goohaitools「图像缩放V2 孤海」（GPL-3.0）；源包为独立
#   实现，业务逻辑与参考实现零重合。
#
#   🔴 **这一轮比前几次多一层：源包 5 个下拉的值全是中文**（`按长边等比例`、
#   `填充_自定颜色`…共 22 个），违反本包硬约束（值要进存档 / API / 与别的插件
#   互通）。所以先把值换成英文 key，再单独做文案英化，两步分开做、各自可回滚：
#     第一步（只动值）：23 条中文值 → 英文 key。做法是「整串等于某个值」的字符串
#       字面量才替换 —— 注释 / tooltip / docstring 里的同一批词一个字都没碰。
#       验证：把英文 key 反向映射回中文，与原文件逐字节比对相同（唯一例外是
#       SEARCH_ALIASES 里本来就有个英文别名 "crop"，比对时按位置屏蔽）。
#     第二步（文案）：CATEGORY "QG 工具" -> "QG-tools/Image"、DESCRIPTION 改英文
#       单行、12 条 tooltip 改英文、INPUT_TYPES 按本包规范重排（"xxx": ( 独占行；
#       源包把 ("INT", { 写在行尾，verify_bilingual 的启发式会把 12 个输入全
#       误判成一个名叫 tooltip 的输入）。默认值 / 范围 / 顺序 / optional 归属不变。
#   保持不变：全部像素运算与判断分支、五张取值表的内容与顺序、中文异常提示
#   （本包 nodes/ 里 raise 一律中文）、中文 docstring 与行内注释、SEARCH_ALIASES
#   的中文别名、RETURN_TYPES / RETURN_NAMES。显示名 "Image Scale" 本来就合规。
#
#   🔴 替换关系：这个节点**顶替**原来的 QG_ImageResize（已删除）。两者接口不兼容
#   （旧 6 项控件 / 3 路输出；新 10 项控件 / 4 路输出，且多了遮罩），所以没有沿用
#   旧 ID —— 老工作流会报「节点类型不存在」，而不是把 5 个值按位置塞进 10 个控件
#   里静默跑出错图。旧节点自己的老档案（中文值）靠 LEGACY 兜：那批中文值对应的
#   正是本文件的英文 key。
# ============================================================

# -*- coding: utf-8 -*-
"""QG_ImageScale —— 图像缩放：图像与遮罩同步重采样。

功能规格参照本机已安装的 Goohaitools-comfyui「图像缩放V2 孤海」
（``nodes/图像缩放V2.py::图像缩放V2_孤海``，GPL-3.0）：两个可选输入
``IMAGE`` / ``MASK``，十个控件，输出 ``IMAGE / INT / INT / MASK``。
**代码为本包独立实现，没有复制参考实现的任何一行**，见 README「来源」一节。

参考实现的行为被逐项保留，包括几处看着"不对劲"但会影响常规结果的地方
（上一轮遮罩分析里吃过亏：改动看着像修笔误，却让 503/1024 组参数翻结果）：

* 「按长边等比例 / 按短边等比例」且整除数 <= 1 时，只做一次直接缩放，
  **完全忽略「缩放模式」**——裁剪、各种填充都不生效；
* 遮罩与图像用**同一个插值**重采样（不是遮罩常用的 NEAREST），
  包括 Lanczos / 双三次；只有尺寸不匹配时的那次对齐才用 NEAREST；
* 等比例 + 整除数 > 1 时，固定边就近取整，另一边按模式向下 / 向上 / 就近取整；
* 「填充_边缘像素」四角保持黑色，不向外延展；
* 「总像素_等比例」按 ``sqrt(总像素 / 原宽高比)`` 起算，必要时在 ±1 里挑候选；
* 「不需要缩放」分支里，整除数变小时是直接 crop 原图，不重新插值。

只在输入容错上加固，不改变上面任何常规结果：numpy / list 输入统一转张量、
张量先搬到 CPU、两者皆空与非数值参数给中文提示、不改动原张量。

⚠️ 与源包的一处差别：源包给 ``fill_color`` 配了自己的前端取色器
（``web/qg_color_picker.js`` 的 ``COLOR_WIDGETS``），QG-tools 里没有那套东西，
所以这里就是个**普通 STRING 输入框**，手填 ``#RRGGBB``（默认 ``#364254``）；
本包的 ``web/color_picker/index.js`` 会给这个控件套上色块 + 弹出色板（值仍是
同一个 hex 字符串），与源包的外观一致。
值的格式与参考的 ``GHCOLOR`` 参数一致，可以互换；只是少了点色块选色这一步。
后端解析保持源包原样，不依赖第三方前端。
"""

from __future__ import annotations

import math
from collections import Counter

import numpy as np
import torch
from PIL import Image

from ._qg_combo_legacy import combo_legacy

# 逐帧缩放是纯 CPU 的重活：视频 batch 一大，用户点取消得能立刻停下。
# 部分离线检查脚本按文件路径加载本模块（没有包上下文），相对导入会抛
# ImportError，这时兜底成空函数，行为与没有这一层时完全一样。
try:
    from ._qg_execution_helpers import raise_if_interrupted
except ImportError:  # pragma: no cover
    def raise_if_interrupted() -> None:
        return

# ---------------------------------------------------------------------------
# 控件取值：顺序、默认值、边界都与参考节点一致，参数可直接搬用
# ---------------------------------------------------------------------------
SCALE_METHODS = ["by-long-side", "by-short-side", "custom-size"]
INTERPOLATIONS = ["bilinear", "bicubic", "area", "nearest-exact", "lanczos"]
SCALE_MODES = [
    "stretch", "crop", "fill-color", "fill-border-color", "fill-edge-pixels",
    "total-pixels",
]
ANCHORS = ["center", "top", "bottom", "left", "right"]
CONDITIONS = ["always", "when-long-side-greater", "when-short-side-smaller"]

# 两个入口用的是同一张映射表。参考里 mask 那份写了 .get(..., NEAREST)，
# 但五个插值名都在表里，所以遮罩实际与图像同插值——这里照原样。
_RESAMPLE = {
    "bilinear": Image.BILINEAR,
    "bicubic": Image.BICUBIC,
    "area": Image.BOX,
    "nearest-exact": Image.NEAREST,
    "lanczos": Image.LANCZOS,
}


def _resample_of(name):
    return _RESAMPLE.get(name, Image.LANCZOS)


# ---------------------------------------------------------------------------
# 张量 <-> PIL。参考用 np.clip(255 * x) 量化到 uint8，这里保持一致
# ---------------------------------------------------------------------------
def _as_cpu_tensor(value, label):
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    try:
        return torch.as_tensor(value).detach().cpu()
    except Exception as error:  # noqa: BLE001 - 把类型错误换成能照做的提示
        raise ValueError(
            "Image Scale: %s cannot be converted to a tensor (%s); connect a ComfyUI IMAGE / MASK output"
            % (label, error)) from error


def _tensor_to_pil(image):
    frame = image[0] if image.ndim == 4 else image
    arr = np.clip(255.0 * frame.numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def _tensor_to_mask_pil(mask):
    # 单帧图像进来带 batch 维；4D 的 [B,1,H,W] 是常见的通道式遮罩。
    if mask.ndim == 4:
        frame = mask[0, 0] if mask.shape[1] == 1 else mask[0]
    else:
        frame = mask[0] if mask.ndim == 3 else mask
    arr = np.clip(255.0 * frame.numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(arr).convert("L")


def _pil_to_tensor(image):
    arr = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _pil_mask_to_tensor(mask):
    arr = np.array(mask.convert("L")).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


# ---------------------------------------------------------------------------
# 几何小工具：裁剪框 / 贴放位置
# ---------------------------------------------------------------------------
def _crop_box(src_w, src_h, dst_w, dst_h, anchor):
    """从 src 里裁出 dst 大小，返回 (左, 上, 右, 下)。"""
    if anchor == "top":
        left, top = (src_w - dst_w) // 2, 0
    elif anchor == "bottom":
        left, top = (src_w - dst_w) // 2, src_h - dst_h
    elif anchor == "left":
        left, top = 0, (src_h - dst_h) // 2
    elif anchor == "right":
        left, top = src_w - dst_w, (src_h - dst_h) // 2
    else:  # 居中
        left, top = (src_w - dst_w) // 2, (src_h - dst_h) // 2
    return left, top, left + dst_w, top + dst_h


def _paste_position(dst_w, dst_h, img_w, img_h, anchor):
    """把 img 放进 dst 画布时的左上角。"""
    if anchor == "top":
        return (dst_w - img_w) // 2, 0
    if anchor == "bottom":
        return (dst_w - img_w) // 2, dst_h - img_h
    if anchor == "left":
        return 0, (dst_h - img_h) // 2
    if anchor == "right":
        return dst_w - img_w, (dst_h - img_h) // 2
    return (dst_w - img_w) // 2, (dst_h - img_h) // 2


# ---------------------------------------------------------------------------
# 整除数：三种取整方向，参考按缩放模式切换
# ---------------------------------------------------------------------------
def _nearest_multiple(size, unit):
    if unit <= 1:
        return size
    return max(unit, int(math.floor(size / unit + 0.5)) * unit)


def _mode_multiple(size, unit, mode):
    if unit <= 1:
        return size
    if mode == "stretch":
        return _nearest_multiple(size, unit)
    if mode in ("crop", "total-pixels"):
        return max(unit, (size // unit) * unit)
    return max(unit, ((size + unit - 1) // unit) * unit)


def _apply_multiple(width, height, unit):
    if unit > 1:
        return _nearest_multiple(width, unit), _nearest_multiple(height, unit)
    return width, height


# ---------------------------------------------------------------------------
# 像素操作。统一签名：(图, 遮罩, 目标宽, 目标高, ctx) -> (图, 遮罩)
# ctx 携带原尺寸、插值、方向、颜色
# ---------------------------------------------------------------------------
def _resize_pair(img, mask, dst_w, dst_h, resample):
    return (
        img.resize((dst_w, dst_h), resample),
        mask.resize((dst_w, dst_h), resample),
    )


def _resized_to_box(img, mask, dst_w, dst_h, ctx, contain):
    """contain=True 用 min 比例（贴进画布），False 用 max 比例（铺满再裁）。"""
    ratio_w = dst_w / img.width
    ratio_h = dst_h / img.height
    ratio = min(ratio_w, ratio_h) if contain else max(ratio_w, ratio_h)
    return _resize_pair(img, mask, round(img.width * ratio),
                        round(img.height * ratio), ctx["resample"])


def _stretch(img, mask, dst_w, dst_h, ctx):
    return _resize_pair(img, mask, dst_w, dst_h, ctx["resample"])


def _center_crop(img, mask, dst_w, dst_h, ctx):
    """自定义宽高 / 不需要缩放分支用的「裁剪」：铺满后按方向裁。"""
    scaled_img, scaled_mask = _resized_to_box(img, mask, dst_w, dst_h, ctx, False)
    box = _crop_box(scaled_img.width, scaled_img.height, dst_w, dst_h,
                    ctx["anchor"])
    return scaled_img.crop(box), scaled_mask.crop(box)


def _cover_crop_guarded(img, mask, dst_w, dst_h, ctx):
    """等比例 + 整除数分支用的覆盖裁剪：缩放尺寸额外 max 到不小于目标。"""
    cover = max(dst_w / ctx["ow"], dst_h / ctx["oh"])
    sw = max(round(ctx["ow"] * cover), dst_w)
    sh = max(round(ctx["oh"] * cover), dst_h)
    scaled_img, scaled_mask = _resize_pair(img, mask, sw, sh, ctx["resample"])
    box = _crop_box(sw, sh, dst_w, dst_h, ctx["anchor"])
    return scaled_img.crop(box), scaled_mask.crop(box)


def _empty_canvas(dst_w, dst_h, img_mode, color=None):
    if color is None:
        return Image.new(img_mode, (dst_w, dst_h))
    return Image.new(img_mode, (dst_w, dst_h), color=color)


def _pad_pair(img, mask, dst_w, dst_h, ctx, border_hex):
    """按 min 比例缩进去，再贴到指定颜色的画布；遮罩画布恒为黑。"""
    small_img, small_mask = _resized_to_box(img, mask, dst_w, dst_h, ctx, True)
    left, top = _paste_position(dst_w, dst_h, small_img.width,
                                small_img.height, ctx["anchor"])
    canvas = _empty_canvas(dst_w, dst_h, "RGB", border_hex)
    canvas_mask = _empty_canvas(dst_w, dst_h, "L", 0)
    canvas.paste(small_img, (left, top))
    canvas_mask.paste(small_mask, (left, top))
    return canvas, canvas_mask


def _fill_custom(img, mask, dst_w, dst_h, ctx):
    return _pad_pair(img, mask, dst_w, dst_h, ctx, ctx["fill_color"])


def _dominant_border_hex(img, left, top, small_w, small_h, dst_w, dst_h):
    """取需要填充那一侧的边缘颜色众数（去掉低频色后加权平均）。"""
    pixels = np.array(img)
    samples = []
    if left > 0:
        samples.extend(tuple(row) for row in pixels[:, 0, :].tolist())
    if left + small_w < dst_w:
        samples.extend(tuple(row) for row in pixels[:, -1, :].tolist())
    if top > 0:
        samples.extend(tuple(row) for row in pixels[0, :, :].tolist())
    if top + small_h < dst_h:
        samples.extend(tuple(row) for row in pixels[-1, :, :].tolist())
    if not samples:
        return "#ffffff"
    counts = Counter(samples)
    keep = max(1, len(counts) // 5)
    red_sum = green_sum = blue_sum = 0
    weight = 0
    for (red, green, blue), count in counts.most_common(keep):
        red_sum += red * count
        green_sum += green * count
        blue_sum += blue * count
        weight += count
    if not weight:
        return "#ffffff"
    # 参考用 Python int 累加后做 int(a / b)；这里保持同一种整数除法，
    # 避免浮点累加在边界上差 1 个色阶。
    rgb = (int(red_sum / weight), int(green_sum / weight),
           int(blue_sum / weight))
    return "#%02x%02x%02x" % rgb


def _fill_border(img, mask, dst_w, dst_h, ctx):
    small_img, small_mask = _resized_to_box(img, mask, dst_w, dst_h, ctx, True)
    left, top = _paste_position(dst_w, dst_h, small_img.width,
                                small_img.height, ctx["anchor"])
    border = _dominant_border_hex(small_img, left, top, small_img.width,
                                  small_img.height, dst_w, dst_h)
    canvas = _empty_canvas(dst_w, dst_h, "RGB", border)
    canvas_mask = _empty_canvas(dst_w, dst_h, "L", 0)
    canvas.paste(small_img, (left, top))
    canvas_mask.paste(small_mask, (left, top))
    return canvas, canvas_mask


def _extend_edge_pixels(canvas, left, top, img_w, img_h):
    """把图像四条边向外复制；四角不会被任何一侧覆盖，保持黑色。"""
    source = np.array(canvas)
    out = source.copy()
    canvas_h, canvas_w = source.shape[:2]
    if left > 0:
        for x in range(left):
            rows = slice(top, min(top + img_h, canvas_h))
            out[rows, x] = source[rows, left]
    right = left + img_w
    if right < canvas_w:
        for x in range(right, canvas_w):
            rows = slice(top, min(top + img_h, canvas_h))
            out[rows, x] = source[rows, right - 1]
    if top > 0:
        for y in range(top):
            cols = slice(left, min(left + img_w, canvas_w))
            out[y, cols] = source[top, cols]
    bottom = top + img_h
    if bottom < canvas_h:
        for y in range(bottom, canvas_h):
            cols = slice(left, min(left + img_w, canvas_w))
            out[y, cols] = source[bottom - 1, cols]
    return Image.fromarray(out)


def _fill_edge(img, mask, dst_w, dst_h, ctx):
    small_img, small_mask = _resized_to_box(img, mask, dst_w, dst_h, ctx, True)
    left, top = _paste_position(dst_w, dst_h, small_img.width,
                                small_img.height, ctx["anchor"])
    canvas = _empty_canvas(dst_w, dst_h, "RGB")
    canvas_mask = _empty_canvas(dst_w, dst_h, "L", 0)
    canvas.paste(small_img, (left, top))
    canvas_mask.paste(small_mask, (left, top))
    return _extend_edge_pixels(canvas, left, top, small_img.width,
                               small_img.height), canvas_mask


def _total_pixels(img, mask, dst_w, dst_h, ctx, unit):
    """保持原宽高比，让 宽×高 逼近用户给的 宽×高；自定义宽高专用。"""
    aspect = img.width / img.height
    wanted = dst_w * dst_h
    new_h = int(math.sqrt(wanted / aspect))
    new_w = int(new_h * aspect)
    if abs(new_w * new_h - wanted) > wanted * 0.1:
        candidates = []
        for offset in (-1, 0, 1):
            cand_h = new_h + offset
            if cand_h <= 0:
                continue
            cand_w = int(cand_h * aspect)
            if cand_w <= 0:
                continue
            candidates.append((cand_w, cand_h,
                               abs(cand_w * cand_h - wanted)))
        candidates.sort(key=lambda item: item[2])
        new_w, new_h, _ = candidates[0]

    if unit > 1:
        new_w = max(unit, int(math.floor(new_w / unit + 0.5)) * unit)
        new_h = max(unit, int(math.floor(new_h / unit + 0.5)) * unit)
        cover = max(new_w / img.width, new_h / img.height)
        sw = max(round(img.width * cover), new_w)
        sh = max(round(img.height * cover), new_h)
    else:
        ratio = min(new_w / img.width, new_h / img.height)
        sw, sh = round(img.width * ratio), round(img.height * ratio)

    scaled_img, scaled_mask = _resize_pair(img, mask, sw, sh, ctx["resample"])
    if sw != new_w or sh != new_h:
        left = max(0, (sw - new_w) // 2)
        top = max(0, (sh - new_h) // 2)
        right = min(sw, left + new_w)
        bottom = min(sh, top + new_h)
        box = (left, top, right, bottom)
        scaled_img = scaled_img.crop(box)
        scaled_mask = scaled_mask.crop(box)
    if scaled_img.size != (new_w, new_h):
        scaled_img, scaled_mask = _resize_pair(
            scaled_img, scaled_mask, new_w, new_h, ctx["resample"])
    return scaled_img, scaled_mask, new_w, new_h


# 自定义宽高分支：缩放模式 -> 处理函数（「总像素_等比例」单独走）
_CUSTOM_DISPATCH = {
    "stretch": _stretch,
    "crop": _center_crop,
    "fill-color": _fill_custom,
    "fill-border-color": _fill_border,
    "fill-edge-pixels": _fill_edge,
}


# ---------------------------------------------------------------------------
# 尺寸规划：把参考里那串嵌套分支整理成纯计算 + 分派
# ---------------------------------------------------------------------------
def _should_rescale(ow, oh, params):
    longest = max(ow, oh)
    shortest = min(ow, oh)
    condition = params["condition"]
    if condition == "always":
        return True
    if params["scale_method"] == "custom-size":
        width, height = params["width"], params["height"]
        if width != 0 and height != 0:
            if ow >= oh:
                src_long, dst_long = ow, width
                src_short, dst_short = oh, height
            else:
                src_long, dst_long = oh, height
                src_short, dst_short = ow, width
            if condition == "when-long-side-greater" and src_long <= dst_long:
                return False
            if condition == "when-short-side-smaller" and src_short >= dst_short:
                return False
            return True
        if width != 0:
            axis = ow
            target = width
        elif height != 0:
            axis = oh
            target = height
        else:
            return True
        if condition == "when-long-side-greater" and axis <= target:
            return False
        if condition == "when-short-side-smaller" and axis >= target:
            return False
        return True
    if condition == "when-long-side-greater" and longest <= params["edge_size"]:
        return False
    if condition == "when-short-side-smaller" and shortest >= params["edge_size"]:
        return False
    return True


def _proportional_target(edge, by_long, ow, oh, unit, mode):
    """等比例 + 整除数：固定边就近取整，另一边按模式取整。"""
    edge = _nearest_multiple(edge, unit)
    longest, shortest = max(ow, oh), min(ow, oh)
    if by_long:
        based_on_width = longest == ow
    else:
        based_on_width = shortest == ow
    if based_on_width:
        wide = edge
        high = round(oh * (edge / ow))
    else:
        high = edge
        wide = round(ow * (edge / oh))
    return _mode_multiple(wide, unit, mode), _mode_multiple(high, unit, mode)


def _proportional_pixels(img, mask, dst_w, dst_h, ctx, mode):
    """等比例 + 整除数那一支的像素处理，按模式换算法。"""
    if mode == "stretch":
        return _stretch(img, mask, dst_w, dst_h, ctx)
    if mode in ("crop", "total-pixels"):
        return _cover_crop_guarded(img, mask, dst_w, dst_h, ctx)
    if mode == "fill-color":
        return _fill_custom(img, mask, dst_w, dst_h, ctx)
    if mode == "fill-border-color":
        return _fill_border(img, mask, dst_w, dst_h, ctx)
    return _fill_edge(img, mask, dst_w, dst_h, ctx)


def _zero_size_branch(img, mask, ow, oh, ctx, unit):
    """自定义宽高且宽高都为 0：保留原尺寸，或就近适配整除数。"""
    if unit <= 1:
        return img, mask, ow, oh
    dst_w, dst_h = _nearest_multiple(ow, unit), _nearest_multiple(oh, unit)
    if (dst_w, dst_h) == (ow, oh):
        return img, mask, ow, oh
    mode = ctx["mode"]
    handler = _CUSTOM_DISPATCH.get(mode, _center_crop)
    new_img, new_mask = handler(img, mask, dst_w, dst_h, ctx)
    return new_img, new_mask, dst_w, dst_h


def _custom_branch(img, mask, ow, oh, ctx, params):
    width, height = params["width"], params["height"]
    unit, mode = params["multiple_of"], ctx["mode"]
    if width == 0 and height == 0:
        out_img, out_mask, dst_w, dst_h = _zero_size_branch(
            img, mask, ow, oh, ctx, unit)
        return out_img, out_mask, dst_w, dst_h
    if width == 0:
        dst_w = round(ow * (height / oh))
        dst_h = height
    elif height == 0:
        dst_w = width
        dst_h = round(oh * (width / ow))
    else:
        dst_w, dst_h = width, height
    dst_w, dst_h = _apply_multiple(dst_w, dst_h, unit)
    if mode == "total-pixels":
        if width == 0 or height == 0:
            raise ValueError(
                "Image Scale: width and height cannot both be 0 in total-pixels "
                "keep-proportion mode (keep the original ratio so the new width x height "
                "is close to the custom width x height)")
        return _total_pixels(img, mask, width, height, ctx, unit)
    handler = _CUSTOM_DISPATCH.get(mode, _stretch)
    new_img, new_mask = handler(img, mask, dst_w, dst_h, ctx)
    return new_img, new_mask, dst_w, dst_h


def _skip_branch(img, mask, ow, oh, ctx, params):
    """执行条件不满足：原样输出，只在整除数变化时做尺寸适配。"""
    unit, mode = params["multiple_of"], ctx["mode"]
    if params["scale_method"] == "custom-size" and \
            params["width"] == 0 and params["height"] == 0:
        return _zero_size_branch(img, mask, ow, oh, ctx, unit)
    if unit <= 1:
        return img, mask, ow, oh
    dst_w, dst_h = _nearest_multiple(ow, unit), _nearest_multiple(oh, unit)
    if dst_w > ow or dst_h > oh:
        handler = _CUSTOM_DISPATCH.get(mode, _center_crop)
        new_img, new_mask = handler(img, mask, dst_w, dst_h, ctx)
        return new_img, new_mask, dst_w, dst_h
    if dst_w < ow or dst_h < oh:
        box = _crop_box(ow, oh, dst_w, dst_h, ctx["anchor"])
        return img.crop(box), mask.crop(box), dst_w, dst_h
    return img, mask, ow, oh


def _process_one(image_tensor, mask_tensor, params):
    img = _tensor_to_pil(image_tensor)
    ow, oh = img.size
    mask = _tensor_to_mask_pil(mask_tensor)
    if mask.size != (ow, oh):
        mask = mask.resize((ow, oh), Image.NEAREST)

    ctx = {
        "ow": ow,
        "oh": oh,
        "resample": _resample_of(params["interpolation"]),
        "anchor": params["anchor"],
        "fill_color": params["fill_color"],
        "mode": params["scale_mode"],
    }
    unit = params["multiple_of"]

    if not _should_rescale(ow, oh, params):
        img, mask, dst_w, dst_h = _skip_branch(img, mask, ow, oh, ctx, params)
    elif params["scale_method"] in ("by-long-side", "by-short-side"):
        by_long = params["scale_method"] == "by-long-side"
        edge = params["edge_size"]
        basis = max(ow, oh) if by_long else min(ow, oh)
        ratio = edge / basis
        dst_w, dst_h = round(ow * ratio), round(oh * ratio)
        if unit > 1:
            dst_w, dst_h = _proportional_target(
                edge, by_long, ow, oh, unit, ctx["mode"])
            img, mask = _proportional_pixels(img, mask, dst_w, dst_h, ctx,
                                             ctx["mode"])
        else:
            # 参考在这一支直接 resize，缩放模式不参与——刻意保留。
            img, mask = _resize_pair(img, mask, dst_w, dst_h,
                                     ctx["resample"])
    else:
        img, mask, dst_w, dst_h = _custom_branch(img, mask, ow, oh, ctx, params)

    return _pil_to_tensor(img), dst_w, dst_h, _pil_mask_to_tensor(mask)


def _as_int(value, label):
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "Image Scale: %s must be an integer (got %r)" % (label, value)) from error


def scale_image(image=None, mask=None, width=512, height=512,
                scale_method="by-long-side", edge_size=1024,
                interpolation="lanczos", scale_mode="crop", anchor="center",
                condition="always", fill_color="#364254", multiple_of=0):
    """与参考节点 ``执行缩放`` 同输入同结果，返回 ``(IMAGE, INT, INT, MASK)``。"""
    params = {
        "width": _as_int(width, "width"),
        "height": _as_int(height, "height"),
        "scale_method": scale_method,
        "edge_size": _as_int(edge_size, "scale edge to"),
        "interpolation": interpolation,
        "scale_mode": scale_mode,
        "anchor": anchor,
        "condition": condition,
        "fill_color": str(fill_color),
        "multiple_of": _as_int(multiple_of, "divisible by"),
    }

    if image is None and mask is None:
        raise ValueError("Image Scale: image and mask cannot both be empty; connect at least one")
    src = image if image is not None else mask
    src = _as_cpu_tensor(src, "image" if image is not None else "mask")
    if src.ndim < 3:
        raise ValueError(
            "Image Scale: the input needs at least [batch, height, width]; "
            "with no image connected the mask must carry batch, height and width")
    batch = src.shape[0]
    src_h, src_w = (src.shape[1], src.shape[2]) if image is not None \
        else (src.shape[-2], src.shape[-1])
    if image is None:
        # 参考用黑色占位图保住固定输出端口，遮罩处理结果不受影响。
        image = torch.zeros((batch, src_h, src_w, 3), dtype=torch.float32)
    else:
        image = _as_cpu_tensor(image, "image")

    if mask is None:
        mask = torch.zeros((batch, src_h, src_w), dtype=torch.float32)
    else:
        mask = _as_cpu_tensor(mask, "mask")
        if mask.ndim < 2:
            raise ValueError(
                "Image Scale: the mask needs at least [batch, height, width], got %dD"
                % mask.ndim)
        if mask.shape[0] != batch:
            if mask.shape[0] == 1:
                mask = mask.repeat(batch, 1, 1)
            else:
                raise ValueError(
                    "Image Scale: mask batch (%d) does not match image batch (%d)"
                    % (mask.shape[0], batch))

    out_images, out_masks = [], []
    final_w = final_h = 0
    for index in range(batch):
        raise_if_interrupted()
        frame = _process_one(image[index].unsqueeze(0),
                             mask[index].unsqueeze(0), params)
        out_images.append(frame[0])
        out_masks.append(frame[3])
        if index == 0:
            final_w, final_h = frame[1], frame[2]
    return (torch.cat(out_images, dim=0), final_w, final_h,
            torch.cat(out_masks, dim=0))


@combo_legacy("QG_ImageScale")
class QGImageScale:
    """图像 + 遮罩同步缩放，输出缩放后的图、最终宽高与同步后的遮罩。"""

    DESCRIPTION = (
        "Scale an image and its mask together to a target size. Pick by-long-side, "
        "by-short-side or a custom size, then stretch, crop, fill with a colour / "
        "border colour / edge pixels, or fit a total pixel count. Interpolation, "
        "anchor, a run condition, the fill colour and a multiple-of rounding are "
        "all adjustable. Both image and mask are optional but at least one has to "
        "be connected; a mask alone outputs a black placeholder image. The "
        "returned width and height feed straight into size inputs, and every "
        "parameter lines up with Goohaitools Image Scale V2 so the same numbers "
        "can be pasted between the two nodes."
    )
    SEARCH_ALIASES = [
        "image", "scale", "resize", "rescale", "upscale", "downscale",
        "mask", "width", "height", "multiple", "padding", "crop",
        "图像", "遮罩", "蒙版", "缩放", "放大", "缩小", "尺寸", "分辨率",
        "裁剪", "填充", "等比例", "长边", "短边", "整除", "qg",
    ]
    CATEGORY = "QG-tools/Image"
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE", "INT", "INT", "MASK")
    RETURN_NAMES = ("image", "width", "height", "mask")
    OUTPUT_TOOLTIPS = (
        "The scaled image, one frame per input frame.",
        "Width of the output image in pixels, ready for a size input.",
        "Height of the output image in pixels, ready for a size input.",
        "The mask scaled together with the image, matching its output size.",
    )

    @classmethod
    def VALIDATE_INPUTS(cls, scale_method=None, interpolation=None,
                        scale_mode=None, anchor=None, condition=None):
        # 五个下拉的译名登记在 nodes/_qg_combo_legacy.py 的 LEGACY 表里
        # （源包的值全是中文，这一轮才换成英文 key，老存档靠组合兜住）。
        # 这里具名报上去，让 ComfyUI 跳过「值必须在列表里」那道检查 ——
        # 中文界面显示的是「按长边等比例」，直接往 API 里塞中文也不会炸。
        # 不写 **kwargs：那会把宽 / 高 / 整除数这些数字的 min/max 一起关掉。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": (
                    "INT",
                    {
                        "default": 512, "min": 0, "max": 100000, "step": 1,
                        "tooltip": "Target width in custom-size mode; 0 derives it from the height. Ignored by the by-long-side / by-short-side methods.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 512, "min": 0, "max": 100000, "step": 1,
                        "tooltip": "Target height in custom-size mode; 0 derives it from the width. Ignored by the by-long-side / by-short-side methods.",
                    },
                ),
                "scale_method": (
                    SCALE_METHODS,
                    {
                        "default": "by-long-side",
                        "tooltip": "by-long-side / by-short-side: apply the edge length below to the long or the short side. custom-size: use the width and height above.",
                    },
                ),
                "edge_size": (
                    "INT",
                    {
                        "default": 1024, "min": 64, "max": 100000, "step": 1,
                        "tooltip": "Target edge length in pixels for the proportional methods (1024 in the original node). Also used by the when-long-side-greater / when-short-side-smaller conditions.",
                    },
                ),
                "interpolation": (
                    INTERPOLATIONS,
                    {
                        "default": "lanczos",
                        "tooltip": "Resampling filter. The image and the mask are resampled with the same filter, matching Goohaitools Image Scale V2.",
                    },
                ),
                "scale_mode": (
                    SCALE_MODES,
                    {
                        "default": "crop",
                        "tooltip": "stretch / crop / three fill modes / total pixels. Note: with by-long-side or by-short-side and multiple_of <= 1 this is not used at all (the original node behaves the same way).",
                    },
                ),
                "anchor": (
                    ANCHORS,
                    {
                        "default": "center",
                        "tooltip": "Which side survives a crop or a fill: center / top / bottom / left / right.",
                    },
                ),
                "condition": (
                    CONDITIONS,
                    {
                        "default": "always",
                        "tooltip": "Run always, or only when the long side is greater / the short side is smaller than the target. Otherwise the input passes through unchanged (multiple_of may still adapt the size).",
                    },
                ),
                "fill_color": (
                    "STRING",
                    {
                        "default": "#364254",
                        "tooltip": "Canvas colour for the fill-color mode, as #RRGGBB (default #364254). Click the swatch on the node to pick one or type the hex; the original node writes the same string.",
                    },
                ),
                "multiple_of": (
                    "INT",
                    {
                        "default": 0, "min": 0, "max": 256, "step": 1,
                        "tooltip": "Round the final width and height up to a multiple of this number (0 or 1 means no rounding). Each scale mode rounds in its own direction, matching the original node.",
                    },
                ),
            },
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "The image batch to scale, standard [B,H,W,C]. Optional: with only a mask connected the image output is a black placeholder.",
                    },
                ),
                "mask": (
                    "MASK",
                    {
                        "tooltip": "The mask to scale together with the image. Not connected gives an all-black mask; a single frame is repeated to match a multi-frame image.",
                    },
                ),
            },
        }

    def execute(self, width=512, height=512, scale_method="by-long-side",
                edge_size=1024, interpolation="lanczos", scale_mode="crop",
                anchor="center", condition="always", fill_color="#364254",
                multiple_of=0, image=None, mask=None):
        return scale_image(
            image=image, mask=mask, width=width, height=height,
            scale_method=scale_method, edge_size=edge_size,
            interpolation=interpolation, scale_mode=scale_mode,
            anchor=anchor, condition=condition, fill_color=fill_color,
            multiple_of=multiple_of)


NODE_CLASS_MAPPINGS = {"QG_ImageScale": QGImageScale}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageScale": "Image Scale"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

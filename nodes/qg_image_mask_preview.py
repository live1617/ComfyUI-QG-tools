# -*- coding: utf-8 -*-
"""QG_ImageMaskPreview — tint mask regions on an image and number the segments.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_image_mask_preview.py
        功能形态参考 Goohaitools「图像与遮罩预览」（GPL-3.0），代码为独立实现。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Display``；显示名与 DESCRIPTION 英化；
    3) 🔴 **字体来源换掉**。源包读自己 ``assets/fonts/NotoSansSC-VF.ttf``
       （随包 54 MB，含商业授权字体，不能进公开仓库），这里改成和
       QG_AddWatermark 同一套系统字体发现：插件自己的 ``fonts/`` 目录优先，
       其后是用户字体目录与系统字体目录。字体名用不带扩展名的 stem，老存档里
       存的 ``xxx.ttf`` 由 ``_resolve_font`` 的 stem 兜底接住；
    4) ``index_scale`` 的下拉值英化（跟随遮罩缩放/固定大小 ->
       follow_mask/fixed），老存档中文值由 LEGACY 表 + coerce() 兜住；
    5) 报错信息英化；tooltip 英化。
  保持不变：上色算术（多帧按 over 运算累积 alpha，只需一张全图缓冲）、
  序号绘制（跟随遮罩/固定大小两种字号口径、外接框中心取整）、遮罩二值化阈值
  0.5、以及 ``[B,H,W]`` 每帧当一个独立对象的约定。

颜色输入仍是 STRING（十六进制），色块与色板由前端
``web/color_picker/index.js`` 接管，工作流里存的是可读字符串。
"""

from __future__ import annotations

import os
import platform
from functools import lru_cache

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from comfy_api.latest import io

from ._qg_combo_legacy import coerce

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
_MAX_RESOLUTION = 16384
DEFAULT_MASK_COLOR = "#c524ff"
DEFAULT_INDEX_COLOR = "#ffffff"
SCALE_CHOICES = ["follow_mask", "fixed"]

_NODE_ID = "QG_ImageMaskPreview"

# 插件自己的字体目录：用户可以往这里丢 TTF，优先于系统字体。
_FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts")
_FONT_EXTS = (".ttf", ".otf", ".ttc")

_OS_FONT_DIRS = None


def _system_font_dirs():
    """OS font folders, cached - unlike the font list itself, these do not move."""
    global _OS_FONT_DIRS
    if _OS_FONT_DIRS is None:
        system = platform.system()
        if system == "Windows":
            # 不做环境变量查询：Registry 的 YARA 规则把读环境变量判成提权
            # （QG_TextOverlayImage 只因读 WINDIR 就被标过
            # python_environment_manipulation，见 DEVELOPMENT.md「Registry
            # 扫描误报」）。这里直接列两个众所周知的位置：用户级字体目录
            # （Win10+ 免管理员安装字体就落在这儿）与系统级目录。
            home = os.path.expanduser("~")
            dirs = [
                os.path.join(home, "AppData", "Local", "Microsoft", "Windows",
                             "Fonts"),
                r"C:\Windows\Fonts",
            ]
        elif system == "Darwin":
            dirs = ["/System/Library/Fonts", "/Library/Fonts",
                    os.path.expanduser("~/Library/Fonts")]
        else:
            dirs = ["/usr/share/fonts", "/usr/local/share/fonts",
                    os.path.expanduser("~/.fonts")]
        _OS_FONT_DIRS = [d for d in dirs if os.path.isdir(d)]
    return _OS_FONT_DIRS


def _font_index():
    """name(stem) -> full path，插件自己的 fonts/ 目录优先。

    每次调用都重建：``define_schema`` 在每次刷新时都会跑，五分钟前刚丢进去的
    字体应该立刻出现在下拉里。两个目录都只扫一层 —— Windows 与 macOS 就把
    字体放这一层，递归 ``/usr/share/fonts`` 会在每次刷新时走几千个文件。
    """
    index = {}
    folders = ([_FONT_DIR] if os.path.isdir(_FONT_DIR) else []) + _system_font_dirs()
    for folder in folders:
        try:
            entries = os.listdir(folder)
        except OSError:
            continue
        for entry in entries:
            if not entry.lower().endswith(_FONT_EXTS):
                continue
            index.setdefault(os.path.splitext(entry)[0],
                             os.path.join(folder, entry))
    return index


def font_choices():
    """字体下拉候选：插件 fonts/ 目录优先，其后是用户与系统字体。"""
    names = sorted(_font_index(), key=str.lower)
    # 下拉不能是空列表，裸系统上留一个占位；_resolve_font 会退到 PIL 默认字体。
    return names or ["Arial"]


def default_font():
    """默认字体：优先中文字体，其次任意可用字体，最后占位名。"""
    index = _font_index()
    for candidate in ("NotoSansSC-VF", "NotoSansSC", "msyh", "simhei",
                      "PingFang", "SourceHanSansSC", "Arial"):
        if candidate in index:
            return candidate
    for name in sorted(index, key=str.lower):
        return name
    return "Arial"


def load_font(name, size):
    """加载字体；可变字体固定 Regular 实例，失败回退 PIL 默认字体。"""
    index = _font_index()
    candidates = [name]
    if name:
        stem, ext = os.path.splitext(name)
        if ext:
            # 老存档里存的是 "楷体.ttf"，索引的键是 stem。
            candidates.append(stem)
    for candidate in candidates:
        path = index.get(candidate)
        if not path:
            continue
        try:
            face = ImageFont.truetype(path, max(1, int(size)))
            if hasattr(face, "set_variation_by_name"):
                try:
                    face.set_variation_by_name("Regular")
                except (OSError, ValueError, AttributeError, TypeError):
                    pass
            return face
        except OSError:
            pass
    for candidate in ("NotoSansSC-VF", "msyh", "simhei", "Arial",
                      "DejaVuSans"):
        path = index.get(candidate)
        if not path:
            continue
        try:
            return ImageFont.truetype(path, max(1, int(size)))
        except OSError:
            pass
    if index:
        try:
            return ImageFont.truetype(next(iter(index.values())), max(1, int(size)))
        except OSError:
            pass
    return ImageFont.load_default()


@lru_cache(maxsize=64)
def _cached_font(name, size):
    """同一字体/字号只读一次文件：多段预览常在同一字号下重复请求。

    字体对象在 PIL 里只读使用（textbbox / draw.text），共享实例安全；新装字体
    需要重启后端才会生效，与本包其他字体节点的缓存口径一致。
    """
    return load_font(name, int(size))


def parse_color(value, fallback):
    """把 #rgb / #rrggbb / #rrggbbaa 解析成 0-255 三元组，非法回退 fallback。"""
    text = str(value if value is not None else "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c * 2 for c in text)
    elif len(text) == 8:
        # 8 位是 #RRGGBBAA：本控件的透明度由单独的滑杆控制，这里只取 RGB。
        text = text[:6]
    if len(text) == 6:
        try:
            return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            pass
    text2 = str(fallback).strip().lstrip("#")
    return tuple(int(text2[i:i + 2], 16) for i in (0, 2, 4))


def _to_numpy(value):
    """任意输入转 float32 numpy，先 nan_to_num 再 clip（NaN 不能漏到 uint8）。"""
    if isinstance(value, torch.Tensor):
        arr = value.detach().cpu().numpy()
    else:
        arr = np.asarray(value)
    arr = np.asarray(arr, dtype=np.float32)
    arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=0.0)
    return np.clip(arr, 0.0, 1.0)


def _image_frame(image):
    """取图像第一帧转成 [H,W,3] uint8；RGBA 透明部分压黑。

    空批次（0 帧）没有首帧可取，明确报错而不是抛 IndexError。
    """
    arr = _to_numpy(image)
    if arr.ndim == 4:
        if arr.shape[0] == 0:
            raise ValueError(
                "Image Mask Preview received an empty image batch (0 frames), "
                "so there is nothing to preview.")
        arr = arr[0]
    if arr.ndim != 3:
        raise ValueError(
            "Image Mask Preview expects [H,W,C] or [B,H,W,C] images, got %d "
            "dimensions." % arr.ndim)
    if arr.shape[2] == 4:
        alpha = arr[:, :, 3:4]
        arr = arr[:, :, :3] * alpha
    elif arr.shape[2] == 1:
        arr = np.repeat(arr, 3, axis=2)
    elif arr.shape[2] < 3:
        raise ValueError(
            "Image Mask Preview needs at least 3 image channels, got %d."
            % arr.shape[2])
    return (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)


def _mask_frames(mask):
    """遮罩规整成 [B,H,W] 的二值浮点数组。

    ComfyUI 的 MASK 契约就是 [B,H,W]，三维输入一律按批次处理。不再猜测
    「最后一维为 1 就当单帧 [H,W,1]」：那个判断与 [B,H,1] 在数据上不可区分，
    会把一个批次压成一帧（[B,H,1] → [1,B,H]），帧数与尺寸全错。非规范的
    [H,W,1] 单帧会被当成 B=H 的批次，属于上游格式问题，不在这里猜。
    """
    arr = _to_numpy(mask)
    if arr.ndim == 2:
        arr = arr[None, :, :]
    elif arr.ndim != 3:
        raise ValueError(
            "Image Mask Preview expects [H,W] or [B,H,W] masks, got %d "
            "dimensions." % arr.ndim)
    return (arr > 0.5).astype(np.float32)


def _fit_mask(plane, width, height):
    """把单帧 [H,W] 遮罩最近邻缩放到图像尺寸。"""
    if plane.ndim != 2:
        raise ValueError(
            "Image Mask Preview expects each mask frame to be [H,W], got %d "
            "dimensions." % plane.ndim)
    if plane.shape[0] == height and plane.shape[1] == width:
        return plane
    img = Image.fromarray((plane * 255.0).astype(np.uint8), mode="L")
    img = img.resize((width, height), Image.NEAREST)
    return np.asarray(img, dtype=np.float32) / 255.0


def _bbox_center(plane):
    """二值遮罩的外接框中心与高度；空遮罩返回 None。"""
    rows = np.any(plane > 0.5, axis=1)
    cols = np.any(plane > 0.5, axis=0)
    if not np.any(rows) or not np.any(cols):
        return None
    r0, r1 = np.where(rows)[0][[0, -1]]
    c0, c1 = np.where(cols)[0][[0, -1]]
    return ((int(c0) + int(c1)) // 2, (int(r0) + int(r1)) // 2,
            int(r1) - int(r0))


def render_preview(image, mask, mask_opacity=0.4, mask_color=DEFAULT_MASK_COLOR,
                   show_index=True, index_opacity=0.8, index_scale="follow_mask",
                   index_ratio=0.15, index_font=None, index_color=DEFAULT_INDEX_COLOR):
    """把遮罩颜色与序号叠加到图像，返回 [1,H,W,3] float tensor。"""
    rgb = _image_frame(image)
    height, width = rgb.shape[:2]
    frames = _mask_frames(mask)

    # 画布用 RGBA，便于叠加上色层。
    canvas = Image.fromarray(rgb, mode="RGB").convert("RGBA")
    mask_rgb = parse_color(mask_color, DEFAULT_MASK_COLOR)
    opacity = float(np.clip(mask_opacity, 0.0, 1.0))

    # 多帧遮罩的叠加按「1-(1-a1)(1-a2)」累积 alpha，数学上与逐帧
    # alpha_composite 的结果一致（over 运算满足结合律），但只需要一张全图
    # 缓冲与一次合成：早期实现每帧都新建一张全尺寸 RGBA 图层，4K 图 11 段要
    # 反复分配约 360MB。段中心顺手记下，避免再存一份 plane 列表。
    acc = None
    centers = []
    for i in range(frames.shape[0]):
        plane = _fit_mask(frames[i], width, height)
        if acc is None:
            acc = np.zeros((height, width), dtype=np.float32)
        a = plane * opacity
        acc = acc * (1.0 - a) + a        # over 运算：新层压在已累积层之上
        if show_index:
            centers.append((i + 1, _bbox_center(plane)))

    if acc is not None and float(acc.max()) > 0.0:
        alpha = (np.clip(acc, 0.0, 1.0) * 255.0).astype(np.uint8)
        layer = Image.new("RGBA", (width, height), (*mask_rgb, 0))
        layer.putalpha(Image.fromarray(alpha, mode="L"))
        canvas = Image.alpha_composite(canvas, layer)

    if show_index:
        number_rgb = parse_color(index_color, DEFAULT_INDEX_COLOR)
        number_alpha = int(round(float(np.clip(index_opacity, 0.0, 1.0)) * 255.0))
        infos = [(idx, info) for idx, info in centers if info is not None]
        fixed_mode = str(index_scale).strip() == "fixed"
        max_height = max((info[2] for _, info in infos), default=0)
        font_name = index_font or default_font()

        for idx, (cx, cy, mask_height) in infos:
            base = max_height if fixed_mode else mask_height
            size = max(1, int(round(base * float(index_ratio))))
            font = _cached_font(font_name, size)
            text = str(idx)
            text_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            draw = ImageDraw.Draw(text_layer)
            try:
                box = draw.textbbox((0, 0), text, font=font)
                tw, th = box[2] - box[0], box[3] - box[1]
            except AttributeError:                        # 旧版 PIL
                tw, th = draw.textsize(text, font=font)
            draw.text((cx - tw // 2, cy - th // 2), text,
                      fill=(*number_rgb, number_alpha), font=font)
            canvas = Image.alpha_composite(canvas, text_layer)

    out = np.asarray(canvas.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(np.ascontiguousarray(out)).unsqueeze(0)


class QGImageMaskPreview(io.ComfyNode):
    """Overlay mask regions with a colour and number segments."""

    CATEGORY = "QG-tools/Display"
    DESCRIPTION = (
        "Overlays mask regions with a chosen colour and optionally numbers each "
        "segment at its centre. Every frame in the mask batch is treated as its "
        "own object, so a multi-segment detection shows up as separate tinted "
        "regions numbered 1, 2, 3. Numbers can scale with each mask or share one "
        "fixed size."
    )
    SEARCH_ALIASES = [
        "mask", "preview", "overlay", "tint", "index", "遮罩预览", "上色",
        "序号", "可视化", "qg",
    ]

    @classmethod
    def define_schema(cls):
        fonts = font_choices()
        default_face = default_font()
        return io.Schema(
            node_id=_NODE_ID,
            display_name="Image Mask Preview",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input(
                    "image",
                    tooltip="The image to draw on; only the first frame is used.",
                ),
                io.Mask.Input(
                    "mask",
                    tooltip=(
                        "Masks to tint: [H,W] for one, or [B,H,W] for a batch. "
                        "Each frame is tinted and numbered separately."
                    ),
                ),
                io.Float.Input(
                    "mask_opacity",
                    default=0.4, min=0.0, max=1.0, step=0.05,
                    tooltip=(
                        "How strongly the tint covers mask pixels: 0 leaves the "
                        "image untouched, 1 hides it completely."
                    ),
                ),
                io.String.Input(
                    "mask_color",
                    default=DEFAULT_MASK_COLOR,
                    tooltip=(
                        "Tint colour for mask regions. Click the swatch to pick "
                        "one, or type a hex value."
                    ),
                ),
                io.Boolean.Input(
                    "show_index",
                    default=True,
                    label_on="Show",
                    label_off="Hide",
                    tooltip="Draw a number at the centre of each mask, counting from 1.",
                ),
                io.Float.Input(
                    "index_opacity",
                    default=0.8, min=0.0, max=1.0, step=0.05,
                    tooltip="Opacity of the number text: 0 invisible, 1 solid.",
                ),
                io.Combo.Input(
                    "index_scale",
                    options=list(SCALE_CHOICES),
                    default="follow_mask",
                    tooltip=(
                        "follow_mask sizes each number from its own mask height; "
                        "fixed uses the tallest mask for every number, so they "
                        "all look the same size."
                    ),
                ),
                io.Float.Input(
                    "index_ratio",
                    default=0.15, min=0.05, max=3.0, step=0.05,
                    tooltip=(
                        "Number size as a fraction of the mask height. 0.5 is "
                        "about half the body; crowded group shots read better "
                        "around 0.1 to 0.2."
                    ),
                ),
                io.Combo.Input(
                    "index_font",
                    options=list(fonts),
                    default=default_face if default_face in fonts else fonts[0],
                    tooltip=(
                        "Font for the numbers. Any TTF/OTF/TTC in the plugin's "
                        "fonts folder or your system font folders shows up here."
                    ),
                ),
                io.String.Input(
                    "index_color",
                    default=DEFAULT_INDEX_COLOR,
                    tooltip=(
                        "Colour of the number text. Click the swatch to pick "
                        "one, or type a hex value."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    tooltip="The preview with tints and numbers baked in.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, index_scale=None, **kwargs):
        # 老存档里 index_scale 存的是中文（跟随遮罩缩放/固定大小）。具名报上去，
        # 让 ComfyUI 跳过「值必须在列表里」那道检查，coerce() 才有机会换掉。
        return True

    @classmethod
    def execute(cls, image, mask, mask_opacity=0.4, mask_color=DEFAULT_MASK_COLOR,
                show_index=True, index_opacity=0.8, index_scale="follow_mask",
                index_ratio=0.15, index_font=None,
                index_color=DEFAULT_INDEX_COLOR):
        index_scale = coerce(_NODE_ID, "index_scale", index_scale)
        return io.NodeOutput(render_preview(
            image, mask,
            mask_opacity=mask_opacity, mask_color=mask_color,
            show_index=show_index, index_opacity=index_opacity,
            index_scale=index_scale, index_ratio=index_ratio,
            index_font=index_font, index_color=index_color,
        ))


NODE_CLASS_MAPPINGS = {"QG_ImageMaskPreview": QGImageMaskPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageMaskPreview": "Image Mask Preview"}

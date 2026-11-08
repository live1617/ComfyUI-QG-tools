# -*- coding: utf-8 -*-
"""QG 图像对比：橡皮擦的混合图、对齐、以及它们往来的那份数据。

橡皮擦模式下，一张图压在另一张上面，画笔把上面那张擦掉一块，露出底下的。
浏览器存的是**笔画**，不是画好的位图，所以混合图在这里按**原图尺寸**重画
一遍，跟面板当时显示到多大无关。

一笔是 ``{"o": 1 或 0, "d": 笔宽, "s": 软度, "p": [x0, y0, x1, y1, ...]}``：
``o`` 为 1 是擦掉上面那张、0 是画回来；``d`` 是笔宽（图上像素）；``s`` 是
软度（百分数）；``p`` 是路径（图上像素，从左上角量起）。

浏览器**从不指名要读哪个文件**。每次运行把两张预览的位置记下来，给面板一个
键（``remember_pair``）；保存时面板把这个键发回来。请求里唯一能带的文字是
新文件的名字：纯文本、不含目录，由 ``clean_save_name`` 校验。文件一律直接
写进 ComfyUI 的 output 目录。

🔴 **错误一律「代码 + 参数 + 英文文本」三件一组**（``CompareSaveError``）。
以前这里把话直接写成中文，而它经 ``safe_route_error`` 原样回给面板 ——
英文界面下弹出来的是中文。文本仍然是英文原文（给日志、给不认识 code 的
调用方），面板按 ``code`` 自己查表出对应语言的句子。

移植自 ComfyUI-AusBoss（MIT，nodes/_compare_helpers.py）。
"""

from __future__ import annotations

import logging
import math
import re
import secrets
import threading
from collections import OrderedDict
from pathlib import Path, PurePosixPath

import numpy as np
import torch
from PIL import Image

from ._qg_brush_helpers import brush_core, brush_sigma, stroke_cover  # noqa: F401 - 画笔的数字也从这里读
from ._qg_psd_helpers import PSD_MAX_SIDE, write_psd
from ._qg_realign_helpers import crop_if_shift, measure, warp_to_source

ERASE_SIZE = (2, 2000)
ERASE_MAX_STROKES = 400
ERASE_MAX_STROKE_POINTS = 600
ERASE_MAX_POINTS = 40000
# 按住鼠标时路径可以跑出画面，但不能跑得太远。
ERASE_OUTSIDE = 4096
# 不给名字时存成什么：compare_00001.png。
SAVE_NAME = "compare"
SAVE_NAME_MAX = 80
# 名字由字母、数字、空格、点、横线、下划线组成：没有任何能写成目录或盘符的东西。
_NAME_RULE = re.compile(r"[\w][\w .\-]*")
_NOT_IN_A_NAME = re.compile(r"[^\w .\-]+")
COUNTER_WIDTH = 5
# 多少轮运行的两张图还能保存：留最新的那些。
PAIRS_KEPT = 64

# ALIGN：拿「对齐到原图」那套量法，量两张预览图。缩放超过这个比例就不信
# （对齐节点自己的默认值）；四角偏移全都小于这么多像素，说明本来就对齐了。
ALIGN_MAX_ZOOM = 0.2
ALIGN_SETTLED = 0.5

# 读到的名字里，这些后缀算图片扩展名，保存前去掉。
IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".bmp", ".tif", ".tiff",
    ".gif", ".avif", ".jxl", ".exr", ".psd",
}

_save_lock = threading.Lock()
_pairs: "OrderedDict[str, tuple[Path, Path, str]]" = OrderedDict()
_pairs_lock = threading.Lock()


# ---------------------------------------------------------------- 错误与文案

# 每个 code 一句英文。面板按 code 出对应语言的句子（见
# web/shared/compare_erase_stage.mjs 的 SERVER_TEXT）。
MESSAGES: dict[str, str] = {
    "number": "Image Compare: {field} must be a number.",
    "strokes_not_list": "Image Compare: the strokes must be a list.",
    "too_many_strokes": "Image Compare: at most {max} strokes in one mix.",
    "stroke_not_object": "Image Compare: a stroke must be an object.",
    "stroke_path_missing": "Image Compare: a stroke needs a path of x, y pairs.",
    "too_many_points_in_stroke": "Image Compare: at most {max} points in one stroke.",
    "too_many_points": "Image Compare: at most {max} points in one mix.",
    "top_not_ab": "Image Compare: the top picture is either A or B.",
    "pictures_too_large": "Image Compare: a mix is limited to {max} pixels on the long side.",
    "pictures_gone": "The two pictures are no longer on the server. Run the workflow again, then save.",
    "align_gone": "The two pictures are no longer on the server. Run the workflow again, then align.",
    "align_failed": (
        "Align could not line the pictures up. They may differ too much, "
        "or have too little detail to measure."
    ),
    "align_settled": "B already lines up with A.",
    "align_moved": "B is now lined up with A. They were up to {pixels} pixels apart.",
    "save_name": (
        "Image Compare: a file name takes letters, digits, spaces, dots, dashes and "
        "underscores, up to {max} of them. It goes into the output folder; a folder "
        "cannot be part of it."
    ),
    "preview_outside_temp": "Image Compare: the preview is not in ComfyUI's temp folder. "
                            "Run the workflow again.",
    "save_outside_output": "Image Compare: the save has to stay inside ComfyUI's output folder.",
    "bad_request": "Image Compare: the request could not be read.",
    "save_failed": "The mix could not be saved. ComfyUI's console has the reason.",
    "align_failed_unexpected": "The alignment could not be made. ComfyUI's console has the reason.",
}

# ``number`` 那条要说清是哪个数。这里的键也原样发给面板，它自己翻。
FIELD_NAMES: dict[str, str] = {
    "stroke_x": "the stroke's x coordinate",
    "stroke_y": "the stroke's y coordinate",
    "stroke_mode": "the stroke's kind",
    "brush_width": "the brush width",
    "softness": "the softness",
}

# 老名字留着，节点壳与外部代码都按这两个常量取文案。
SAVE_NAME_HELP = MESSAGES["save_name"].format(max=SAVE_NAME_MAX)
PICTURES_GONE = MESSAGES["pictures_gone"]
ALIGN_GONE = MESSAGES["align_gone"]
ALIGN_FAILED = MESSAGES["align_failed"]


class CompareSaveError(ValueError):
    """一次做不了的保存 / 对齐。

    带上 ``code``（机器读）与 ``params``（数字、字段名），``str()`` 给出英文
    原文。路由把三样一起回给面板：认识 code 的按自己的语言出句子，不认识
    的就直接用那句英文。
    """

    def __init__(self, code: str, status: int = 400, **params):
        self.code = code
        self.params = params
        self.status = status
        template = MESSAGES.get(code)
        if template is None:  # 代码里的笔误要看得见，不能悄悄回一句空话
            raise KeyError(f"unknown compare error code: {code}")
        values = dict(params)
        if "field" in values:
            values["field"] = FIELD_NAMES.get(values["field"], values["field"])
        try:
            super().__init__(template.format(**values))
        except (KeyError, IndexError, ValueError):
            # 模板和参数对不上是代码笔误。这时候要的还是「一条 400 的
            # CompareSaveError」，不能让它在这里抛出 KeyError 变成 500 ——
            # 那样面板只剩一句「保存失败」，真正的原因丢了。未格式化的模板
            # 至少还带花括号，一眼看得出是哪条。
            # （未知 code 上面已经先抛了，那一种仍然要看得见。）
            super().__init__(template)


def numbered(value, low: float, high: float, field: str) -> float:
    """请求里的一个数：不是数就拒，超范围就拉回来。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CompareSaveError("number", field=field)
    return min(high, max(low, float(value)))


# ---------------------------------------------------------------- 笔画


def clean_strokes(raw, width: int, height: int) -> list[dict]:
    """浏览器发来的笔画，逐项校验并压回上限之内。

    请求里的每个字都是别人写的：形状不对就拒，数值超范围就拉回来。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise CompareSaveError("strokes_not_list")
    if len(raw) > ERASE_MAX_STROKES:
        raise CompareSaveError("too_many_strokes", max=ERASE_MAX_STROKES)
    strokes = []
    total = 0
    for item in raw:
        if not isinstance(item, dict):
            raise CompareSaveError("stroke_not_object")
        path = item.get("p")
        if not isinstance(path, list) or len(path) < 2 or len(path) % 2:
            raise CompareSaveError("stroke_path_missing")
        if len(path) // 2 > ERASE_MAX_STROKE_POINTS:
            raise CompareSaveError("too_many_points_in_stroke", max=ERASE_MAX_STROKE_POINTS)
        total += len(path) // 2
        if total > ERASE_MAX_POINTS:
            raise CompareSaveError("too_many_points", max=ERASE_MAX_POINTS)
        points = [
            (
                numbered(path[index], -ERASE_OUTSIDE, width + ERASE_OUTSIDE, "stroke_x"),
                numbered(path[index + 1], -ERASE_OUTSIDE, height + ERASE_OUTSIDE, "stroke_y"),
            )
            for index in range(0, len(path), 2)
        ]
        strokes.append({
            # 前端只发 0 / 1；别的值按「过半才算」定，比 bool() 更贴字面意思。
            "erase": numbered(item.get("o", 1), 0, 1, "stroke_mode") >= 0.5,
            "size": numbered(item.get("d"), ERASE_SIZE[0], ERASE_SIZE[1], "brush_width"),
            "soft": numbered(item.get("s", 0), 0, 100, "softness") / 100.0,
            "points": points,
        })
    return strokes


def erase_mask(strokes: list[dict], width: int, height: int) -> np.ndarray:
    """上面那张被擦掉多少：HxW 的 float32，0（全在）到 1（全没了）。

    笔画按先后顺序落地。擦掉的一笔盖住它下面的部分，画回来的一笔再揭开，
    各自按自己的软边算。``gone[...]`` 拿到的是视图，所以 ``+=`` / ``*=``
    就地改在整张蒙版上，不用再拷回去。
    """
    gone = np.zeros((height, width), dtype=np.float32)
    for stroke in strokes:
        covered = stroke_cover(stroke["points"], stroke["size"], stroke["soft"], width, height)
        if covered is None:
            continue
        left, top, cover = covered
        part = gone[top:top + cover.shape[0], left:left + cover.shape[1]]
        if stroke["erase"]:
            part += cover * (1.0 - part)
        else:
            part *= 1.0 - cover
    return np.clip(gone, 0.0, 1.0, out=gone)


def mix_pictures(top: np.ndarray, under: np.ndarray, gone: np.ndarray) -> np.ndarray:
    """上面那张压在底下那张上，把 ``gone`` 的地方擦掉。

    两张都不透（HxWx3）时混出来也不透。只要有一张带透明部分（HxWx4），
    混出来的也带：底下那张能从上面那张的透明处透出来，而上面被擦掉的
    地方，底下那张该透明还是透明。
    """
    weight = gone[:, :, None]
    if top.shape[2] == 3 and under.shape[2] == 3:
        mixed = top.astype(np.float32) * (1.0 - weight) + under.astype(np.float32) * weight
        return np.clip(np.round(mixed), 0, 255).astype(np.uint8)
    # 「over」合成：上层的实心程度被擦掉的部分扣掉，剩下的地方才让下层透出来。
    upper = _with_alpha(top).astype(np.float32)
    lower = _with_alpha(under).astype(np.float32)
    top_alpha = upper[..., 3:] / 255.0 * (1.0 - weight)
    under_alpha = lower[..., 3:] / 255.0 * (1.0 - top_alpha)
    alpha = top_alpha + under_alpha
    rgb = (upper[..., :3] * top_alpha + lower[..., :3] * under_alpha) / np.maximum(alpha, 1e-6)
    mixed = np.concatenate([rgb, alpha * 255.0], axis=-1)
    return np.clip(np.round(mixed), 0, 255).astype(np.uint8)


def _with_alpha(pixels: np.ndarray) -> np.ndarray:
    """HxWx4：不透的 HxWx3 补一路全实心的透明通道。"""
    if pixels.shape[2] == 4:
        return pixels
    solid = np.full(pixels.shape[:2] + (1,), 255, dtype=pixels.dtype)
    return np.concatenate([pixels, solid], axis=-1)


# ---------------------------------------------------------------- 名字


def strip_image_extension(name: str) -> str:
    """去掉一个结尾的图片扩展名；别的后缀仍是名字的一部分。"""
    text = str(name or "").strip()
    suffix = PurePosixPath(text).suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return text[: -len(suffix)]
    return text


def require_output_path(path: Path, output_root: Path) -> Path:
    """最终落点也要查一遍：文件名或说明文字可以是一个符号链接。"""
    root = output_root.resolve()
    resolved = path.resolve()
    if root not in resolved.parents and resolved != root:
        raise CompareSaveError("save_outside_output")
    return path


def next_free_counter(existing_names, stem: str) -> int:
    """``stem`` 在这个目录里已经用过的最大编号，再往后一个。"""
    pattern = re.compile(rf"^{re.escape(stem)}_(\d{{{COUNTER_WIDTH},}})\.[A-Za-z0-9]+$")
    highest = 0
    for name in existing_names:
        match = pattern.match(str(name))
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def clean_save_name(name) -> str:
    """节点上打给新文件的名字，校验过。空的就用默认名。

    它跟着保存请求进来，属于别人的文字：不像个纯名字就拒，绝不「修」成
    一个名字。
    """
    if name is None:
        return SAVE_NAME
    if not isinstance(name, str):
        raise CompareSaveError("save_name", max=SAVE_NAME_MAX)
    typed = name.strip()
    if not typed:
        return SAVE_NAME
    text = strip_image_extension(typed).strip(" .")
    if not text or len(text) > SAVE_NAME_MAX or not _NAME_RULE.fullmatch(text) or ".." in text:
        raise CompareSaveError("save_name", max=SAVE_NAME_MAX)
    return text


def tidy_save_name(name) -> str:
    """接在节点上的名字，整理成纯文件名。没有就是空的。

    连线上常常带着源图的名字，连目录和扩展名一起（``sets/a/photo 12.jpg``）：
    只留最后一段，去掉扩展名，文件名装不下的字符换成下划线。绝不为了一个
    名字把运行停下来。
    """
    if not isinstance(name, str):
        return ""
    last = name.replace("\\", "/").rsplit("/", 1)[-1]
    text = _NOT_IN_A_NAME.sub("_", strip_image_extension(last.strip())).replace("..", "_").strip(" ._")
    return text[:SAVE_NAME_MAX].strip(" ._")


# ---------------------------------------------------------------- 配对记录


def remember_pair(picture_a, picture_b, name: str = "") -> str:
    """记下一次运行那两张预览在哪；返回面板要发回来的键。

    这个键是浏览器唯一点名到它们的东西：随机生成、不透露文件信息、只留最新
    的若干轮。``name`` 是运行时连线带来的保存名（已整理），没有就是空。
    """
    key = secrets.token_urlsafe(16)
    with _pairs_lock:
        _pairs[key] = (Path(picture_a), Path(picture_b), str(name or ""))
        while len(_pairs) > PAIRS_KEPT:
            _pairs.popitem(last=False)
    return key


def pair_pictures(key, gone_code: str = "pictures_gone") -> tuple[Path, Path, str]:
    """一个键代表的两张预览和这轮运行连线的名字；找不到就说「重新跑一次」。

    ``gone_code`` 让对齐那条路说「……然后再对齐」，保存那条路说「……然后再
    保存」—— 同一件事，给人下一步动作不一样。
    """
    with _pairs_lock:
        pair = _pairs.get(key) if isinstance(key, str) else None
    if pair is None or not all(path.is_file() for path in pair[:2]):
        raise CompareSaveError(gone_code, status=404)
    return pair


# ---------------------------------------------------------------- 对齐


def align_pair(*, picture_a, picture_b, temp_root, name: str = "") -> dict:
    """模型把图画得偏了一点或放大了一点时，把 B 对齐到 A。

    用「对齐到原图」那套量法量 B 相对 A 的位移和缩放，然后把对齐后的 B
    （按 A 的尺寸）写在 B 那张预览旁边，同样放 temp 目录。B 被挪出边缘露出的
    地方由 A 补上，所以混合图那里显示的是 A。

    返回 ``aligned`` 和一句 ``message``（英文原文）+ 它的 ``message_code`` 与
    ``message_params``；真挪动了还会带上新的 ``file`` 和代表「A + 对齐后的 B」
    的 pair 键。
    """
    try:
        first = _load_picture(Path(picture_a))
        second = _load_picture(Path(picture_b))
    except OSError as error:
        raise CompareSaveError("align_gone", status=404) from error
    if first.shape[2] == 4 or second.shape[2] == 4:
        first, second = _with_alpha(first), _with_alpha(second)
    source = torch.from_numpy(np.array(first)).float() / 255.0
    edit = torch.from_numpy(np.array(second)).float() / 255.0
    # 按「实际看到的样子」量：透明部分铺在中灰上。
    result = measure(_on_gray(source), _on_gray(edit), "zoom + shift", ALIGN_MAX_ZOOM)
    if not result.reliable:
        logging.info("[QG-tools] Image Compare: alignment did not move B - %s", result.reason)
        return _settled("align_failed")
    off = result.worst_corner
    if off < ALIGN_SETTLED:
        # 本来就对齐：什么都不写，也别谎报「挪了一下」。
        return _settled("align_settled")
    height, width = first.shape[:2]
    lined = crop_if_shift(edit, result.matrix, width, height)
    if lined is None:
        lined, _empty = warp_to_source(
            _premultiplied(edit), result.matrix, width, height, "source", _premultiplied(source)
        )
        lined = _unpremultiplied(lined)
    target = Path(picture_b).with_name(f"{Path(picture_b).stem}_aligned.png")
    try:
        # 对齐后的图写在 B 的预览旁边；它要是不在 temp 目录里，就没有可以
        # 落脚的地方 —— 这不是「保存越界」，是那两张预览来路不对。
        require_output_path(target, Path(temp_root))
    except CompareSaveError as error:
        raise CompareSaveError("preview_outside_temp") from error
    pixels = np.round(lined.numpy() * 255.0).clip(0, 255).astype(np.uint8)
    if pixels.shape[2] == 4 and pixels[..., 3].min() == 255:
        pixels = np.ascontiguousarray(pixels[..., :3])
    Image.fromarray(pixels).save(target, compress_level=1)
    pixels_apart = max(1, round(off))
    return {
        "aligned": True,
        "file": target,
        "width": int(width),
        "height": int(height),
        "alpha": pixels.shape[2] == 4,
        "pair": remember_pair(picture_a, target, name),
        "message": MESSAGES["align_moved"].format(pixels=pixels_apart),
        "message_code": "align_moved",
        "message_params": {"pixels": pixels_apart},
    }


def _settled(code: str) -> dict:
    """「没动」的两种结果（量不准 / 本来就对齐），文案也走同一套 code。"""
    return {
        "aligned": False,
        "message": MESSAGES[code],
        "message_code": code,
        "message_params": {},
    }


def _on_gray(pixels: torch.Tensor) -> torch.Tensor:
    """HWC 颜色按「实际看到的样子」铺在中灰上，透明处就是中灰。"""
    if pixels.shape[-1] < 4:
        return pixels
    alpha = pixels[..., 3:]
    return pixels[..., :3] * alpha + 0.5 * (1.0 - alpha)


def _premultiplied(pixels: torch.Tensor) -> torch.Tensor:
    """颜色先按实心程度加权，重采样时就不会把透明像素里藏的颜色拽到邻居身上。"""
    if pixels.shape[-1] < 4:
        return pixels
    return torch.cat([pixels[..., :3] * pixels[..., 3:], pixels[..., 3:]], dim=-1)


def _unpremultiplied(pixels: torch.Tensor) -> torch.Tensor:
    if pixels.shape[-1] < 4:
        return pixels
    alpha = pixels[..., 3:]
    rgb = torch.where(alpha > 0, pixels[..., :3] / alpha.clamp_min(1e-6), torch.zeros_like(pixels[..., :3]))
    return torch.cat([rgb.clamp(0.0, 1.0), alpha], dim=-1)


def _load_picture(path: Path, size: tuple[int, int] | None = None) -> np.ndarray:
    """读预览图的像素：HxWx3，带透明部分时是 HxWx4。

    给了 ``size``（宽、高）就缩到那个尺寸；带透明的那张按预乘方式缩，
    这样透明处的颜色不会渗到边缘上去。
    """
    with Image.open(path) as image:
        clear = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
        image = image.convert("RGBA" if clear else "RGB")
        if clear and image.getextrema()[3][0] == 255:
            image, clear = image.convert("RGB"), False
        if size is not None and image.size != size:
            if clear:
                image = image.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")
            else:
                image = image.resize(size, Image.LANCZOS)
        return np.asarray(image)


# ---------------------------------------------------------------- 存盘


def save_mix(*, picture_a, picture_b, output_dir, top="A", strokes=None, layers=False, name=SAVE_NAME) -> dict:
    """把两张预览混合好，写进 output 目录。

    写 ``<name>_00001.png``。``layers`` 为真时另写 ``<name>_00001.psd``
    （底下那张，再上面那张、擦掉的部分作它的图层蒙版）和
    ``<name>_00001_mask.png``（底下那张露出来的地方是白）。``name`` 是
    ``clean_save_name`` 或 ``tidy_save_name`` 出来的纯名字。返回写了什么。
    """
    if top not in ("A", "B"):
        raise CompareSaveError("top_not_ab")
    name = clean_save_name(name)
    try:
        first = _load_picture(Path(picture_a))
        height, width = first.shape[:2]
        # 混合图永远是 A 的尺寸；B 尺寸不同就缩到 A。
        second = _load_picture(Path(picture_b), (width, height))
    except OSError as error:
        raise CompareSaveError("pictures_gone", status=404) from error
    if max(height, width) > PSD_MAX_SIDE:
        raise CompareSaveError("pictures_too_large", max=PSD_MAX_SIDE)

    gone = erase_mask(clean_strokes(strokes, width, height), width, height)
    upper, under = (first, second) if top == "A" else (second, first)
    mixed = mix_pictures(upper, under, gone)

    folder = Path(output_dir)
    with _save_lock:
        folder.mkdir(parents=True, exist_ok=True)
        counter = next_free_counter((entry.name for entry in folder.iterdir()), name)
        while True:
            stem = f"{name}_{counter:0{COUNTER_WIDTH}}"
            wanted = [f"{stem}.png"] + ([f"{stem}.psd", f"{stem}_mask.png"] if layers else [])
            # 三个文件要一起空出来，否则只写了一半的那一套会被下一次撞上。
            if not any((folder / file).exists() for file in wanted):
                break
            counter += 1
        for file in wanted:
            # 名字指向目录外的一律拒，和原生「保存图像」一样。
            require_output_path(folder / file, folder)
        Image.fromarray(mixed).save(folder / wanted[0], compress_level=4)
        if layers:
            under_name, upper_name = ("B", "A") if top == "A" else ("A", "B")
            # 图层蒙版：白＝上面那张还在，黑＝被擦掉露出底下。PSD 的惯例是
            # 白显示、黑隐藏，所以这里不取反；另存的那张 mask.png 反过来，
            # 给「底下露出来多少」当遮罩用。
            shown = np.round((1.0 - gone) * 255.0).astype(np.uint8)
            write_psd(
                folder / wanted[1],
                [_layer(under_name, under), {**_layer(upper_name, upper), "mask": shown}],
                mixed[..., :3],
                alpha=mixed[..., 3] if mixed.shape[2] == 4 else None,
            )
            Image.fromarray(255 - shown).save(folder / wanted[2], compress_level=4)

    return {
        "files": [{"filename": file, "subfolder": "", "type": "output"} for file in wanted],
        "width": width,
        "height": height,
    }


def _layer(name: str, pixels: np.ndarray) -> dict:
    """一张图变成 PSD 的一层；带透明部分时把透明通道也带上。"""
    return {"name": name, "rgb": pixels[..., :3], "alpha": pixels[..., 3] if pixels.shape[2] == 4 else None}


__all__ = [
    "ALIGN_FAILED",
    "ALIGN_GONE",
    "ALIGN_SETTLED",
    "CompareSaveError",
    "ERASE_MAX_POINTS",
    "ERASE_MAX_STROKES",
    "ERASE_MAX_STROKE_POINTS",
    "ERASE_OUTSIDE",
    "ERASE_SIZE",
    "FIELD_NAMES",
    "MESSAGES",
    "PAIRS_KEPT",
    "PICTURES_GONE",
    "SAVE_NAME",
    "SAVE_NAME_HELP",
    "SAVE_NAME_MAX",
    "brush_core",
    "align_pair",
    "brush_sigma",
    "clean_save_name",
    "clean_strokes",
    "erase_mask",
    "mix_pictures",
    "numbered",
    "pair_pictures",
    "remember_pair",
    "require_output_path",
    "save_mix",
    "tidy_save_name",
]

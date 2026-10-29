# -*- coding: utf-8 -*-
"""QG 图像对比：用画笔笔画拼出「橡皮擦」的混合图。

橡皮擦模式下，一张图压在另一张上面，画笔把上面那张擦掉一块，露出底下的。
浏览器存的是**笔画**，不是画好的位图，所以混合图在这里按**原图尺寸**重画
一遍，跟面板当时显示到多大无关。

一笔是 ``{"o": 1 或 0, "d": 笔宽, "s": 软度, "p": [x0, y0, x1, y1, ...]}``：
``o`` 为 1 是擦掉上面那张、0 是画回来；``d`` 是笔宽（图上像素）；``s`` 是
软度（百分数）；``p`` 是路径（图上像素，从左上角量起）。

浏览器**从不指名要读哪个文件**。每次运行把两张预览的位置记下来，给面板一个
键（``remember_pair``）；保存时面板把这个键发回来。保存请求里唯一能带的
文字是新文件的名字：纯文本、不含目录，由 ``clean_save_name`` 校验。文件一律
直接写进 ComfyUI 的 output 目录。

移植自 ComfyUI-AusBoss（MIT，nodes/_compare_helpers.py）；
``next_free_counter`` / ``require_output_path`` / ``strip_image_extension``
三个小工具一并内联进来，省得把上游整个 _image_save_helpers 拖过来。
"""

from __future__ import annotations

import logging
import math
import re
import secrets
import threading
from collections import OrderedDict
from pathlib import PurePosixPath
from pathlib import Path

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
SAVE_NAME_HELP = (
    "图像对比：文件名只能用字母、数字、空格、点、横线和下划线，最多 "
    f"{SAVE_NAME_MAX} 个字符。文件写进 output 目录，名字里不能带目录。"
)
COUNTER_WIDTH = 5
# 多少轮运行的两张图还能保存：留最新的那些。
PAIRS_KEPT = 64
PICTURES_GONE = "那两张图在服务器上已经没了。重新运行一次工作流，然后再保存。"

# ALIGN：拿「对齐到原图」那套量法，量两张预览图。缩放超过这个比例就不信
# （对齐节点自己的默认值）；四角偏移全都小于这么多像素，说明本来就对齐了。
ALIGN_MAX_ZOOM = 0.2
ALIGN_SETTLED = 0.5
ALIGN_GONE = "那两张图在服务器上已经没了。重新运行一次工作流，然后再对齐。"
ALIGN_FAILED = "对齐没能把两张图对上。它们可能差得太多，或者细节太少量不出来。"
# 读到的名字里，这些后缀算图片扩展名，保存前去掉。
IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".bmp", ".tif", ".tiff",
    ".gif", ".avif", ".jxl", ".exr", ".psd",
}

_save_lock = threading.Lock()
_pairs: "OrderedDict[str, tuple[Path, Path, str]]" = OrderedDict()
_pairs_lock = threading.Lock()


class CompareSaveError(ValueError):
    """一次做不了的保存，用面板上的人能看懂的话说。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _number(value, low: float, high: float, source: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CompareSaveError(f"图像对比：{source}必须是一个数。")
    return min(high, max(low, float(value)))


def clean_strokes(raw, width: int, height: int) -> list[dict]:
    """浏览器发来的笔画，逐项校验并压回上限之内。

    请求里的每个字都是别人写的：形状不对就拒，数值超范围就拉回来。
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise CompareSaveError("图像对比：笔画必须是一个列表。")
    if len(raw) > ERASE_MAX_STROKES:
        raise CompareSaveError(f"图像对比：一次最多 {ERASE_MAX_STROKES} 笔。")
    strokes = []
    total = 0
    for item in raw:
        if not isinstance(item, dict):
            raise CompareSaveError("图像对比：每一笔必须是一个对象。")
        path = item.get("p")
        if not isinstance(path, list) or len(path) < 2 or len(path) % 2:
            raise CompareSaveError("图像对比：每一笔要有一条 x、y 成对的路径。")
        if len(path) // 2 > ERASE_MAX_STROKE_POINTS:
            raise CompareSaveError(f"图像对比：一笔最多 {ERASE_MAX_STROKE_POINTS} 个点。")
        total += len(path) // 2
        if total > ERASE_MAX_POINTS:
            raise CompareSaveError(f"图像对比：一次最多 {ERASE_MAX_POINTS} 个点。")
        points = [
            (
                _number(path[index], -ERASE_OUTSIDE, width + ERASE_OUTSIDE, "笔画上的横坐标"),
                _number(path[index + 1], -ERASE_OUTSIDE, height + ERASE_OUTSIDE, "笔画上的纵坐标"),
            )
            for index in range(0, len(path), 2)
        ]
        strokes.append({
            "erase": bool(_number(item.get("o", 1), 0, 1, "笔画的种类")),
            "size": _number(item.get("d"), ERASE_SIZE[0], ERASE_SIZE[1], "笔宽"),
            "soft": _number(item.get("s", 0), 0, 100, "软度") / 100.0,
            "points": points,
        })
    return strokes


def erase_mask(strokes: list[dict], width: int, height: int) -> np.ndarray:
    """上面那张被擦掉多少：HxW 的 float32，0（全在）到 1（全没了）。

    笔画按先后顺序落地。擦掉的一笔盖住它下面的部分，画回来的一笔再揭开，
    各自按自己的软边算。
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
    top, under = _with_alpha(top).astype(np.float32), _with_alpha(under).astype(np.float32)
    upper = top[..., 3:] / 255.0 * (1.0 - weight)
    lower = under[..., 3:] / 255.0 * (1.0 - upper)
    alpha = upper + lower
    rgb = (top[..., :3] * upper + under[..., :3] * lower) / np.maximum(alpha, 1e-6)
    mixed = np.concatenate([rgb, alpha * 255.0], axis=-1)
    return np.clip(np.round(mixed), 0, 255).astype(np.uint8)


def _with_alpha(pixels: np.ndarray) -> np.ndarray:
    """HxWx4：不透的 HxWx3 补一路全实心的透明通道。"""
    if pixels.shape[2] == 4:
        return pixels
    solid = np.full(pixels.shape[:2] + (1,), 255, dtype=pixels.dtype)
    return np.concatenate([pixels, solid], axis=-1)


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
        raise ValueError("保存目标必须留在 ComfyUI 的 output 目录里。")
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
        raise CompareSaveError(SAVE_NAME_HELP)
    typed = name.strip()
    if not typed:
        return SAVE_NAME
    text = strip_image_extension(typed).strip(" .")
    if not text or len(text) > SAVE_NAME_MAX or not _NAME_RULE.fullmatch(text) or ".." in text:
        raise CompareSaveError(SAVE_NAME_HELP)
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


def pair_pictures(key) -> tuple[Path, Path, str]:
    """一个键代表的两张预览和这轮运行连线的名字；找不到就说「重新跑一次」。"""
    with _pairs_lock:
        pair = _pairs.get(key) if isinstance(key, str) else None
    if pair is None or not all(path.is_file() for path in pair[:2]):
        raise CompareSaveError(PICTURES_GONE, status=404)
    return pair


def align_pair(*, picture_a, picture_b, temp_root, name: str = "") -> dict:
    """模型把图画得偏了一点或放大了一点时，把 B 对齐到 A。

    用「对齐到原图」那套量法量 B 相对 A 的位移和缩放，然后把对齐后的 B
    （按 A 的尺寸）写在 B 那张预览旁边，同样放 temp 目录。B 被挪出边缘露出的
    地方由 A 补上，所以混合图那里显示的是 A。
    返回 aligned 和一句给人看的 message；真挪动了还会带上新的 file 和代表
    「A + 对齐后的 B」的 pair 键。
    """
    try:
        first = _load_picture(Path(picture_a))
        second = _load_picture(Path(picture_b))
    except OSError as error:
        raise CompareSaveError(ALIGN_GONE, status=404) from error
    if first.shape[2] == 4 or second.shape[2] == 4:
        first, second = _with_alpha(first), _with_alpha(second)
    source = torch.from_numpy(np.array(first)).float() / 255.0
    edit = torch.from_numpy(np.array(second)).float() / 255.0
    # 按「实际看到的样子」量：透明部分铺在中灰上。
    result = measure(_on_gray(source), _on_gray(edit), "zoom + shift", ALIGN_MAX_ZOOM)
    if not result.reliable:
        logging.info("[QG-tools] 图像对比：对齐没动 B —— %s", result.reason)
        return {"aligned": False, "message": ALIGN_FAILED}
    off = result.worst_corner
    if off < ALIGN_SETTLED:
        return {"aligned": False, "message": "B 本来就对齐着 A。"}
    height, width = first.shape[:2]
    lined = crop_if_shift(edit, result.matrix, width, height)
    if lined is None:
        lined, _empty = warp_to_source(
            _premultiplied(edit), result.matrix, width, height, "source", _premultiplied(source)
        )
        lined = _unpremultiplied(lined)
    target = Path(picture_b).with_name(f"{Path(picture_b).stem}_aligned.png")
    try:
        require_output_path(target, Path(temp_root))
    except ValueError as error:
        raise CompareSaveError(
            "图像对比：预览图不在 ComfyUI 的 temp 目录里。重新运行一次工作流。"
        ) from error
    pixels = np.round(lined.numpy() * 255.0).clip(0, 255).astype(np.uint8)
    if pixels.shape[2] == 4 and pixels[..., 3].min() == 255:
        pixels = np.ascontiguousarray(pixels[..., :3])
    Image.fromarray(pixels).save(target, compress_level=1)
    return {
        "aligned": True,
        "file": target,
        "width": int(width),
        "height": int(height),
        "alpha": pixels.shape[2] == 4,
        "pair": remember_pair(picture_a, target, name),
        "message": f"B 已经对齐到 A。原来最多差 {max(1, round(off))} 像素。",
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


def save_mix(*, picture_a, picture_b, output_dir, top="A", strokes=None, layers=False, name=SAVE_NAME) -> dict:
    """把两张预览混合好，写进 output 目录。

    写 ``<name>_00001.png``。``layers`` 为真时另写 ``<name>_00001.psd``
    （底下那张，再上面那张、擦掉的部分作它的图层蒙版）和
    ``<name>_00001_mask.png``（底下那张露出来的地方是白）。``name`` 是
    ``clean_save_name`` 或 ``tidy_save_name`` 出来的纯名字。返回写了什么。
    """
    if top not in ("A", "B"):
        raise CompareSaveError("图像对比：上面那张只能是 A 或 B。")
    name = clean_save_name(name)
    try:
        first = _load_picture(Path(picture_a))
        height, width = first.shape[:2]
        # 混合图永远是 A 的尺寸；B 尺寸不同就缩到 A。
        second = _load_picture(Path(picture_b), (width, height))
    except OSError as error:
        raise CompareSaveError(PICTURES_GONE, status=404) from error
    if max(height, width) > PSD_MAX_SIDE:
        raise CompareSaveError(f"图像对比：能混合的图最长边不超过 {PSD_MAX_SIDE} 像素。")

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
            if not any((folder / file).exists() for file in wanted):
                break
            counter += 1
        for file in wanted:
            # 名字指向目录外的一律拒，和原生「保存图像」一样。
            require_output_path(folder / file, folder)
        Image.fromarray(mixed).save(folder / wanted[0], compress_level=4)
        if layers:
            under_name, upper_name = ("B", "A") if top == "A" else ("A", "B")
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
    "CompareSaveError",
    "ERASE_MAX_POINTS",
    "ERASE_MAX_STROKES",
    "ERASE_MAX_STROKE_POINTS",
    "ERASE_OUTSIDE",
    "ERASE_SIZE",
    "PAIRS_KEPT",
    "SAVE_NAME",
    "SAVE_NAME_MAX",
    "brush_core",
    "align_pair",
    "brush_sigma",
    "clean_save_name",
    "clean_strokes",
    "erase_mask",
    "mix_pictures",
    "pair_pictures",
    "remember_pair",
    "save_mix",
    "tidy_save_name",
]

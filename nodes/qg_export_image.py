# -*- coding: utf-8 -*-
"""QG 导出图像 — save an image batch as JPEG / PNG / WEBP, quality included.

Why this node exists
--------------------
ComfyUI's core ``SaveImage`` only writes PNG. The community save nodes
(KOOK's SaveJPGImage, 孤海's 保存图像JPG) both hard-code ``quality=90`` and
expect you to put a separate "compress" node upstream. That pattern does not
work: the compress node produces an IMAGE tensor, the save node re-encodes it,
and the final quality is decided by the *save* node, not by the compress node.
Tuning the upstream knob changes nothing but the damage.

So the quality knob lives here, at the moment of encoding:

  * ``format``      JPEG / PNG / WEBP
  * ``quality``     used by JPEG and WEBP, ignored by PNG (lossless)
  * ``subsampling`` 4:4:4 / 4:2:2 / 4:2:0, JPEG only
  * ``alpha_mode``  flatten onto white or black, or keep alpha (PNG / WEBP)
  * filename template (%date:..., %time:..., %INDEX%, %BATCH%) and save_path

The filename follows ComfyUI's own convention exactly -- ``ComfyUI_00001_.png`` --
so exports and native saves can share one folder without stepping on each other.

Only core modules are used (torch / numpy / PIL / folder_paths) -- no new
dependency. Everything happens locally, inside the process.
"""

import os
import re
import time
from datetime import datetime

import numpy as np
import torch
from PIL import Image

import folder_paths

FORMATS = ["JPEG", "PNG", "WEBP"]
FORMAT_EXT = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}

SUBSAMPLING = {
    "4:4:4（最高画质）": 0,
    "4:2:2（均衡）": 1,
    "4:2:0（最省体积）": 2,
}

ALPHA_MODES = ["合成白底", "合成黑底", "保留透明（PNG / WEBP）"]

# 与 ComfyUI 原生 SaveImage 的默认文件名前缀一致（nodes.py: filename_prefix default "ComfyUI"）
DEFAULT_PREFIX = "ComfyUI"

# 自定义目录的预览缩略图最长边；按节点上能看清内容为准，不存整图
PREVIEW_MAX_SIDE = 1600

# 拒绝写入的系统位置（都是小写、带前后反斜杠的比较片段）
_BLOCKED_PARTS = (
    "\\windows\\",
    "\\system32\\",
    "\\syswow64\\",
    "\\winsxs\\",
    "\\program files",
    "\\programdata\\",
    "\\appdata\\",
)

_DATE_RE = re.compile(r"%date:([^%]+)%")
_TIME_RE = re.compile(r"%time:([^%]+)%")

# 长的放前面，避免 yy 吃掉 yyyy、MM 被当成 mm
_DATE_TOKENS = (
    ("yyyy", "%Y"),
    ("yy", "%y"),
    ("MM", "%m"),
    ("dd", "%d"),
    ("HH", "%H"),
    ("hh", "%I"),
    ("mm", "%M"),
    ("ss", "%S"),
)


def _format_pattern(pattern, moment):
    """把 yyyy / MM / dd 之类的写法换成数字，未识别的字符原样保留。"""
    slots = []
    out = pattern
    for index, (token, spec) in enumerate(_DATE_TOKENS):
        if token in out:
            holder = "\x01%d\x01" % index
            slots.append((holder, moment.strftime(spec)))
            out = out.replace(token, holder)
    for holder, value in slots:
        out = out.replace(holder, value)
    return out


def _expand_template(text, moment, index, total, width=0, height=0, batch_number=0):
    """展开 %date:...% / %time:...% / %INDEX% / %BATCH%，以及原生的单 token 变量。

    原生 SaveImage 认的是 %width% / %height% / %year% / %month% / %day% /
    %hour% / %minute% / %second% / %batch_num%，这里一并支持：两套写法可以混用，
    不用记哪个节点用哪套。%batch_num% 与原生一致，从 0 起。
    """
    text = _DATE_RE.sub(lambda m: _format_pattern(m.group(1), moment), text)
    text = _TIME_RE.sub(lambda m: _format_pattern(m.group(1), moment), text)
    text = text.replace("%INDEX%", str(index))
    text = text.replace("%BATCH%", str(total))
    text = text.replace("%width%", str(width))
    text = text.replace("%height%", str(height))
    text = text.replace("%year%", moment.strftime("%Y"))
    text = text.replace("%month%", moment.strftime("%m"))
    text = text.replace("%day%", moment.strftime("%d"))
    text = text.replace("%hour%", moment.strftime("%H"))
    text = text.replace("%minute%", moment.strftime("%M"))
    text = text.replace("%second%", moment.strftime("%S"))
    text = text.replace("%batch_num%", str(batch_number))
    return text


def _clean_name(part):
    """去掉文件名/目录名里的非法字符，挡掉路径穿越。"""
    invalid = '<>:"/\\|?*'
    cleaned = "".join("_" if ch in invalid or ord(ch) < 32 else ch for ch in part)
    cleaned = cleaned.strip().rstrip(". ")
    return cleaned[:120]


def _guard_directory(path):
    """拒绝写入系统目录和盘符根目录。"""
    absolute = os.path.abspath(path)
    lowered = absolute.lower().rstrip("\\/")
    if not lowered or os.path.dirname(lowered) == lowered or len(lowered) <= 3:
        raise ValueError("[QG-tools] 导出图像：不允许写入盘符根目录 %s" % absolute)
    probe = lowered + "\\"
    for part in _BLOCKED_PARTS:
        if part in probe:
            raise ValueError(
                "[QG-tools] 导出图像：拒绝写入系统目录 %s；请换一个普通文件夹" % absolute
            )
    return absolute


def _resolve_directory(save_path, moment, index, total):
    """空 -> output；相对 -> output 下；绝对 -> 按原样（过一遍安全检查）。"""
    template = (save_path or "").strip()
    if template:
        template = _expand_template(template, moment, index, total)
    if not template:
        return os.path.abspath(folder_paths.get_output_directory()), True

    # 支持 %USERPROFILE% 这类环境变量和 ~；变量不存在时 expandvars 会原样留下 %XXX%
    # 只认「像变量名」的残留（字母/下划线开头），免得把 100%完成% 这种目录名当成变量
    expanded = os.path.expandvars(os.path.expanduser(template))
    leftover = re.search(r"%[A-Za-z_][A-Za-z0-9_()]*%", expanded)
    if leftover:
        raise ValueError(
            "[QG-tools] 导出图像：找不到环境变量 %s；请写完整路径，或改用 ~ 开头的用户目录"
            % leftover.group(0)
        )

    # "D:" 是盘符相对路径，"D:foo" 更是语义混乱 —— 拦住，别让它静默落进 output
    if re.fullmatch(r"[A-Za-z]:", expanded):
        raise ValueError(
            "[QG-tools] 导出图像：%r 只是盘符，请写成带反斜杠的完整路径，例如 %s\\出图"
            % (expanded, expanded.upper())
        )
    if re.match(r"^[A-Za-z]:[^\\/]", expanded):
        raise ValueError(
            "[QG-tools] 导出图像：%r 少了分隔符，请写成 %s\\..."
            % (expanded, expanded[:2].upper())
        )

    if os.path.isabs(expanded):
        return _guard_directory(expanded), False

    base = os.path.abspath(folder_paths.get_output_directory())
    target = os.path.abspath(os.path.join(base, expanded))
    if os.path.commonpath([base, target]) != base:
        raise ValueError(
            "[QG-tools] 导出图像：相对路径不能跳出 output 目录（%s）" % template
        )
    return target, True


def _unique_file(directory, stem, extension):
    candidate = os.path.join(directory, stem + extension)
    counter = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, "%s_%d%s" % (stem, counter, extension))
        counter += 1
    return candidate


def _next_counter(directory, prefix):
    """下一个可用序号 —— 直接借原生 `get_save_image_path` 的口径。

    原生保存出来是 `ComfyUI_00001_.png`：它扫描目录里以 `prefix_` 开头、
    紧跟 5 位数字再跟 `_` 的文件，取最大值 +1。这里照搬，才能和原生 SaveImage
    往同一个目录存时互相避让，而不是各写各的、一会儿覆盖一会儿重名。
    这个函数返回的 counter 已经是「下一个可用」，不用再加 1。
    """
    try:
        _folder, _name, counter, _sub, _prefix = folder_paths.get_save_image_path(
            prefix, directory, 0, 0
        )
    except Exception:
        # 目录不可读（权限、网络盘断开）时退回 1，让真正的写盘去报那个更明确的错
        return 1
    return counter


def _to_pil(image, alpha_mode, allow_alpha):
    """把一张 [H,W,C] 的 0-1 张量变成 PIL 图像，按需处理透明通道。"""
    array = image.detach().to(device="cpu").float().numpy()
    array = np.clip(np.rint(array * 255.0), 0, 255).astype(np.uint8)

    alpha = None
    if array.ndim == 2:
        rgb = np.stack([array] * 3, axis=-1)
    elif array.shape[-1] == 1:
        rgb = np.repeat(array, 3, axis=-1)
    elif array.shape[-1] == 2:
        rgb = np.repeat(array[..., :1], 3, axis=-1)
        alpha = array[..., 1]
    elif array.shape[-1] == 3:
        rgb = array
    else:
        rgb = array[..., :3]
        alpha = array[..., 3]

    canvas = Image.fromarray(rgb, "RGB")
    if alpha is None:
        return canvas

    mask = Image.fromarray(alpha, "L")
    if alpha_mode == ALPHA_MODES[2] and allow_alpha:
        canvas.putalpha(mask)
        return canvas

    # 只有明确选"合成黑底"才用黑；JPEG 收到"保留透明"时退化成白底
    fill = (0, 0, 0) if alpha_mode == ALPHA_MODES[1] else (255, 255, 255)
    backdrop = Image.new("RGB", canvas.size, fill)
    backdrop.paste(canvas, mask=mask)
    return backdrop


def _save_options(image_format, quality, subsampling):
    if image_format == "JPEG":
        return {
            "format": "JPEG",
            "quality": int(quality),
            "optimize": True,
            "subsampling": SUBSAMPLING.get(subsampling, 0),
        }
    if image_format == "PNG":
        # PNG 无损，quality 与 subsampling 都不参与；4 与 ComfyUI 原生 SaveImage 同档
        return {"format": "PNG", "compress_level": 4}
    return {"format": "WEBP", "quality": int(quality), "method": 2}


class QGExportImage:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Save an image batch as JPEG, PNG or WEBP, with the quality knob in the "
        "place where it actually decides the file size: the encoder. JPEG exposes "
        "quality and chroma subsampling, PNG stays lossless, WEBP takes quality "
        "and keeps alpha. Transparent inputs can be flattened onto white or black "
        "instead of turning into dark fringes. File naming matches ComfyUI's own "
        "SaveImage (ComfyUI_00001_.png), and the prefix accepts %date:yyyyMMdd% / "
        "%time:HHmmss% templates plus %INDEX% / %BATCH%."
    )
    SEARCH_ALIASES = [
        "save",
        "export",
        "save image",
        "jpg",
        "jpeg",
        "png",
        "webp",
        "quality",
        "compress",
        "导出",
        "保存",
        "保存图像",
        "压缩",
        "画质",
    ]

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": (
                    "IMAGE",
                    {
                        "forceInput": True,
                        "tooltip": "要导出的图像批次；批次里每张都会单独存成一个文件",
                    },
                ),
                "format": (
                    FORMATS,
                    {
                        "default": "JPEG",
                        "tooltip": "JPEG 有损、体积最小；PNG 无损、体积大；WEBP 兼顾两者并支持透明",
                    },
                ),
                "quality": (
                    "INT",
                    {
                        "default": 90,
                        "min": 1,
                        "max": 100,
                        "step": 1,
                        "tooltip": (
                            "编码质量，只对 JPEG 和 WEBP 生效（PNG 无损，填了也没用）。"
                            "90 是肉眼无损的常用档；想明显省体积降到 85，"
                            "再往下画质开始看得出来"
                        ),
                    },
                ),
                "subsampling": (
                    list(SUBSAMPLING.keys()),
                    {
                        "default": "4:4:4（最高画质）",
                        "tooltip": (
                            "色度采样，只对 JPEG 生效。4:4:4 保留全部彩色细节；"
                            "4:2:2 省约 15% 体积、红橙边缘开始发软；"
                            "4:2:0 再省一些，缩小到一半看才明显"
                        ),
                    },
                ),
                "alpha_mode": (
                    ALPHA_MODES,
                    {
                        "default": "合成白底",
                        "tooltip": (
                            "输入带透明通道时怎么处理：合成到白底或黑底后存成不透明图；"
                            "或者原样保留透明（只有 PNG / WEBP 支持，选 JPEG 时会自动改成白底）"
                        ),
                    },
                ),
                "filename_prefix": (
                    "STRING",
                    {
                        # 跟 ComfyUI 原生 SaveImage 同一个默认值，两边的出图能并排放
                        "default": DEFAULT_PREFIX,
                        "tooltip": (
                            "文件名前缀（只写文件名，不要写目录）。命名规则和 ComfyUI 原生保存节点完全一致："
                            "成品形如 ComfyUI_00001_.png，5 位递增计数，自动跳过目录里已有的编号。"
                            "可用变量：%date:yyyyMMdd% 日期、%time:HHmmss% 时间、"
                            "%INDEX% 批次内序号、%BATCH% 批次总数；也认原生那套 "
                            "%width% %height% %year% %month% %day% %hour% %minute% %second% %batch_num%"
                        ),
                    },
                ),
            },
            "optional": {
                "save_path": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": (
                            "留空写 ComfyUI 的 output 目录。也可以填：子目录名（auto 图/2026）、"
                            "完整绝对路径（D:\\出图\\今天）、网络共享（\\\\NAS\\共享\\图）、"
                            "带环境变量（%USERPROFILE%\\Desktop\\图）或用 ~ 开头（~\\Desktop\\图）。"
                            "系统目录、盘符根目录、只写一个盘符（如 D:）都会被拒绝"
                        ),
                    },
                ),
            },
        }

    def run(
        self,
        images,
        format="JPEG",
        quality=90,
        subsampling="4:4:4（最高画质）",
        alpha_mode="合成白底",
        filename_prefix=DEFAULT_PREFIX,
        save_path="",
    ):
        if isinstance(images, torch.Tensor):
            batch = [images[i] for i in range(images.shape[0])] if images.ndim == 4 else [images]
        elif isinstance(images, (list, tuple)):
            batch = [item for item in images if item is not None]
        else:
            raise ValueError("[QG-tools] 导出图像：images 需要 IMAGE 批次或图像列表")

        if not batch:
            raise ValueError("[QG-tools] 导出图像：没有可保存的图像")

        image_format = format if format in FORMATS else "JPEG"
        extension = FORMAT_EXT[image_format]
        allow_alpha = image_format in ("PNG", "WEBP")
        moment = datetime.now()
        total = len(batch)

        directory, inside_output = _resolve_directory(save_path, moment, 1, total)
        os.makedirs(directory, exist_ok=True)

        previews = []
        written = []
        options = _save_options(image_format, quality, subsampling)
        output_root = os.path.abspath(folder_paths.get_output_directory())
        temp_root = os.path.abspath(folder_paths.get_temp_directory())

        # 同一批里前缀多半不变，不必每帧都去扫一遍目录；换了前缀才重算
        last_prefix = None
        counter = 1

        for index, image in enumerate(batch, start=1):
            raw_prefix = filename_prefix or DEFAULT_PREFIX
            height, width = int(image.shape[0]), int(image.shape[1])
            prefix = _clean_name(
                _expand_template(raw_prefix, moment, index, total, width, height, index - 1)
            )
            if not prefix:
                prefix = DEFAULT_PREFIX

            if prefix != last_prefix:
                counter = _next_counter(directory, prefix)
                last_prefix = prefix

            # 与原生 SaveImage 完全同形：prefix_00001_.png
            filename = "%s_%05d_%s" % (prefix, counter, extension)
            counter += 1
            target = os.path.join(directory, filename)

            picture = _to_pil(image, alpha_mode, allow_alpha)
            picture.save(target, **options)
            written.append(target)

            if inside_output:
                relative = os.path.relpath(directory, output_root).replace("\\", "/")
                previews.append({
                    "filename": filename,
                    "subfolder": "" if relative == "." else relative,
                    "type": "output",
                })
            else:
                # 自定义目录在 ComfyUI 的 /view 之外，另存一份缩略图供预览。
                # 存整图会让大图耗时翻倍、磁盘也翻倍，节点上本来也只看得到缩略图。
                os.makedirs(temp_root, exist_ok=True)
                stem = os.path.splitext(filename)[0]
                preview_target = _unique_file(temp_root, "QG_export_" + stem, extension)
                thumbnail = picture.copy()
                thumbnail.thumbnail((PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE), Image.LANCZOS)
                thumbnail.save(preview_target, **options)
                previews.append({
                    "filename": os.path.basename(preview_target),
                    "subfolder": "",
                    "type": "temp",
                })

        return {
            "ui": {
                "images": previews,
                "text": ["\n".join(written)],
            },
            "result": (),
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 保存节点每次都该真的写盘，不能被输入未变时的缓存跳过
        return time.time()


NODE_CLASS_MAPPINGS = {"QG_ExportImage": QGExportImage}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ExportImage": "导出图像"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

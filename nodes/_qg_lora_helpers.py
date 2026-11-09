"""QG LoRA Loader 的后端。

从下往上三层：

  1. 纯数据 —— 栈解析、强度钳制、触发词拼接。不碰磁盘，可直接单测。
  2. 磁盘 —— 库列表、路径解析、元数据、预览图、文件缓存、Civitai 侧车。
  3. 执行与路由 —— 应用栈、校验、六条 HTTP 路由。

comfy / folder_paths / aiohttp 一律延迟导入：没有完整 ComfyUI 环境时（单测、
别的工具 import 本包）这个模块自己也要能加载。
"""

from __future__ import annotations

import json
import os
import re
import struct
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterator, NamedTuple

try:
    import folder_paths
except ImportError:  # pragma: no cover - 只有脱离 ComfyUI 运行时才会走到
    folder_paths = None

# 中断检查：几百行的栈逐行 load_lora_for_models 要几十秒，用户点取消得能停下。
# 检查脚本有两种是直接按文件读这个模块（spec_from_file_location），没有包上下文，
# 相对导入会抛 ImportError —— 兜底成空函数，行为跟没有这一层时完全一样。
try:
    from ._qg_execution_helpers import raise_if_interrupted
except ImportError:  # pragma: no cover
    def raise_if_interrupted() -> None:
        return


STRENGTH_LIMIT = 10.0
MISSING_MODES = ("skip", "error")

# 只有这两个后缀是 safetensors 容器，其余都是 pickle —— 读不出 __metadata__。
SAFETENSORS_SUFFIXES = (".safetensors", ".sft")
# folder_paths.supported_pt_extensions 里会被当成 LoRA 的这些，用于「同一个文件
# 换了扩展名/换了目录」时按主干名认回来。
LORA_SUFFIXES = (
    ".safetensors", ".sft", ".ckpt", ".pt", ".pt2", ".bin", ".pth", ".pkl",
)

# 找预览图按这个顺序试：前四个是专门的预览图，后四个是同名普通图片。
PREVIEW_SUFFIXES = (
    ".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp",
    ".png", ".jpg", ".jpeg", ".webp",
)
# 节点上最多按 180 px 显示，两倍够它清晰。
THUMB_EDGE = 360

# 一次真实的 Civitai 应答约 30–150 KB（十张图，每张带生成参数约 3 KB）；
# 这里只拦荒谬的体积。热门底模的版本页能挂到上百张图，所以留到 4 MB。
MAX_CIVITAI_BYTES = 4 * 1024 * 1024
# 🔴 这张图是浏览器从 Civitai 图床按 450 px 取的副本，正常几十到几百 KB。
# 所以「超过上限」从来不表示用户的图太大，而表示**拿到的不是那张副本**
# （原图、动图，或者图床没认 width 参数）。原来这里是 8 MB：正常副本永远
# 碰不到，而真拿到原图时又直接失败 —— 上限卡在一个既拦不到正常情况、又
# 只会在异常情况里拦的位置。像素闸才是真防线，字节闸只防内存，放到 24 MB。
MAX_PICTURE_BYTES = 24 * 1024 * 1024
# 解压炸弹防线：一张 20000×20000 的 PNG 只有几百 KB，解开要 1.2 GB。
MAX_PICTURE_PIXELS = 40_000_000
PICTURE_EDGE = 768
# safetensors 的头部长度是 uint64，理论上能声明 16 EB；真实的只有几十 MB。
MAX_HEADER_BYTES = 100 * 1024 * 1024

_REDOWNLOAD = "Download the file again and use the .safetensors file."


# 存预览图时能失败的五种原因。以前它们全抛同一句 "The picture is too large."，
# 那句话经 toast 原样显示（toast 挂在 app root 外，汉化插件的 DOM 翻译器看不
# 到它）—— 用户既看不出是字节超了还是像素超了，也不知道差多少、该不该重试。
# 现在带 code 与数字回给面板，由面板出自己语言的那句。
PICTURE_MESSAGES = {
    "picture_empty": "No picture was sent.",
    "picture_too_large":
        "Civitai sent {megabytes} MB; the limit is {limit} MB.",
    "picture_too_many_pixels":
        "The picture is {width}x{height} px ({megapixels} million); the limit is {limit} million.",
    "picture_not_an_image": "That is not a picture.",
    "picture_already_saved": "This LoRA already has a preview picture.",
}


class LoraPictureError(ValueError):
    """存不了这张预览图：``code`` 机器读，``params`` 是数字，``str()`` 是英文原文。"""

    def __init__(self, code: str, **params: Any):
        self.code = code
        self.params = params
        template = PICTURE_MESSAGES.get(code, code)
        try:
            super().__init__(template.format(**params))
        except (KeyError, IndexError, ValueError):
            super().__init__(template)


# ---------------------------------------------------------------- 纯数据层


def clamp_strength(value: Any, fallback: float = 1.0) -> float:
    """把强度收进 ±STRENGTH_LIMIT。

    NaN 单独挡一道：它和任何数比较都是 False，于是 ``min(limit, nan)`` 会原样
    返回 limit，``max(-limit, limit)`` 再把结果钉死在**上限**—— 一个坏掉的
    NaN 强度会变成 +10 满强度参与出图，比退回默认值严重得多。
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(-STRENGTH_LIMIT, min(STRENGTH_LIMIT, number))


def truthy(value: Any) -> bool:
    """JSON 里来的开关。

    ``bool("false")`` 是 True —— 手写或别的工具导出的存档里 ``"enabled": "false"``
    会静默变成开启，用一行 LoRA 跑出没人要的结果。这里按字面意思认。
    """
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "0", "no", "off", "none")
    return bool(value)


def parse_lora_stack(raw: Any) -> list[dict[str, Any]]:
    """把序列化的栈校验成干净的行走列表。

    格式不对抛 ValueError（消息给人看）；空值 / 空数组是合法的空栈。
    """
    text = "" if raw is None else str(raw).strip()
    if not text or text == "[]":
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LoRA stack is not valid JSON: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError("LoRA stack must be a JSON list of rows.")
    rows: list[dict[str, Any]] = []
    for position, entry in enumerate(data, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"LoRA stack row {position} must be an object.")
        name = str(entry.get("name") or "").strip()
        if not name:
            # 空行是界面上的便利（刚点加号还没选文件），跳过而不是拒收，
            # 否则半成品栈连跑都跑不了。
            continue
        strength = clamp_strength(entry.get("strength", 1.0))
        rows.append(
            {
                "name": name,
                "strength": strength,
                "strength_clip": clamp_strength(entry.get("strength_clip", strength), strength),
                # group_off 是本节点前端不产生、但上游（以及从上游转过的工作流）
                # 会写的字段：分组被关掉时组内每一行都带它。不认的话，一份从
                # 上游导入的栈会在这里静默多跑几个本该关掉的 LoRA。
                "enabled": truthy(entry.get("enabled", True))
                and not truthy(entry.get("group_off", False)),
                "triggers": str(entry.get("triggers") or "").strip(),
            }
        )
    return rows


# 触发词按这些断开。中文逗号在中文输入法下比半角顺手得多，只认 "," 的话整句
# 会被当成一个词，去重和拼接跟着一起错。
_TRIGGER_SPLIT = re.compile(r"[,，;；\n\r]+")


def collect_trigger_words(rows: list[dict[str, Any]], separator: str = ", ") -> str:
    """把启用行的触发词拼起来，去重（不分大小写），保持出现顺序。"""
    seen: set[str] = set()
    words: list[str] = []
    for row in rows:
        if not row.get("enabled", True):
            continue
        for chunk in _TRIGGER_SPLIT.split(str(row.get("triggers", ""))):
            word = chunk.strip()
            key = word.casefold()
            if word and key not in seen:
                seen.add(key)
                words.append(word)
    return separator.join(words)


def loaded_rows(rows: list[dict[str, Any]], has_clip: bool = True) -> Iterator[dict[str, Any]]:
    """真正会被加载的那些行，按顺序。

    「会不会加载」只有一个判据，校验和执行都走这里。以前两边各写一遍：
    执行时 clip 没接就把 CLIP 强度当 0，校验时仍按行里存的值算，于是
    「模型强度 0、CLIP 强度 0.5、没接 CLIP」这种行明明什么都不做，文件丢了
    却照样能拦住整个队列。

    校验期拿不到 clip（把 clip 加进 VALIDATE_INPUTS 的签名会让核心按命名输入
    逐条报同一个错，错误列表里同一个问题重复三遍），所以那边只能传 True 保守
    处理 —— 宁可多拦一次，不可放过一个真缺失。
    """
    for row in rows:
        if not row.get("enabled", True):
            continue
        clip_strength = row["strength_clip"] if has_clip else 0.0
        if row["strength"] == 0.0 and clip_strength == 0.0:
            continue
        yield row


# ---------------------------------------------------------------- 磁盘：库与路径


def list_loras() -> list[str]:
    if folder_paths is None:
        return []
    try:
        return sorted(folder_paths.get_filename_list("loras"))
    except Exception:
        return []


def lora_stem(name: str) -> str:
    """文件名主干：去掉目录、统一斜杠、抹掉扩展名，全部小写。"""
    text = str(name).replace("\\", "/").rsplit("/", 1)[-1].lower()
    for suffix in LORA_SUFFIXES:
        if text.endswith(suffix):
            return text[: -len(suffix)]
    return text


def match_lora_name(name: str, available: list[str]) -> tuple[str, str]:
    """把存档里的 LoRA 路径对上这台机器的库，与前端同一套规则。

    完全一致优先；其次大小写不同的整条路径；最后是「忽略目录、忽略扩展名」的
    主干名 —— 正是它让整理过文件、或从别人机器上拿来的工作流还能落到同一个
    文件上。返回 (最佳名字, 状态)，状态是 exact | remapped | ambiguous | missing。
    """
    if name in available:
        return name, "exact"
    lowered = str(name).lower()
    full_matches = [entry for entry in available if entry.lower() == lowered]
    if len(full_matches) == 1:
        return full_matches[0], "remapped"
    wanted = lora_stem(name)
    stem_matches = [entry for entry in available if lora_stem(entry) == wanted]
    if len(stem_matches) == 1:
        return stem_matches[0], "remapped"
    return name, ("ambiguous" if stem_matches else "missing")


_REMAP_NOTED: set[str] = set()


def resolve_lora_path(name: str) -> Path:
    """LoRA 名字 → 硬盘上的绝对路径；找不到 / 有歧义 / 跑出 loras 目录都抛 ValueError。"""
    if folder_paths is None:
        raise ValueError("folder_paths is unavailable outside ComfyUI.")
    wanted = str(name)
    full = folder_paths.get_full_path("loras", wanted)
    if not full:
        # 存档里那条路径已经失效；文件被挪过也该继续能用。
        candidate, status = match_lora_name(wanted, list_loras())
        if status == "remapped":
            if wanted not in _REMAP_NOTED:
                _REMAP_NOTED.add(wanted)
                print(
                    f"[QG-tools] LoRA Loader: '{wanted}' is not at its saved "
                    f"path; using '{candidate}'."
                )
            full = folder_paths.get_full_path("loras", candidate)
        elif status == "ambiguous":
            raise ValueError(f"LoRA name matches several files in models/loras: {wanted}")
    if not full:
        raise ValueError(f"LoRA file not found in models/loras: {wanted}")
    # 按写下来的路径查越界（折叠 ".."，不追符号链接）：把 LoRA 放在别的盘、
    # 再链进 models/loras 是用户自己的选择，ComfyUI 也照样加载。
    path = Path(os.path.abspath(full))
    roots = [Path(os.path.abspath(root)) for root in folder_paths.get_folder_paths("loras")]
    if not any(root == path or root in path.parents for root in roots):
        raise ValueError(f"LoRA path escapes the loras folders: {wanted}")
    return path


def thumbnail_beside(path: Path) -> Path | None:
    """这个 LoRA 文件旁边有没有一张预览图。"""
    stem = str(Path(path).with_suffix(""))
    for suffix in PREVIEW_SUFFIXES:
        candidate = Path(stem + suffix)
        if candidate.is_file():
            return candidate
    return None


def find_thumbnail(name: str) -> Path | None:
    try:
        path = resolve_lora_path(name)
    except ValueError:
        return None
    return thumbnail_beside(path)


# ---------------------------------------------------------------- 磁盘：元数据


def read_safetensors_metadata(path: Path) -> dict[str, Any]:
    """只读 .safetensors 的 ``__metadata__``，一个张量都不载。

    ``.sft`` 也是 safetensors 容器（核心 ``load_torch_file`` 里
    ``endswith(".safetensors") or endswith(".sft")`` 就把它归到同一支），只认
    ``.safetensors`` 会让 .sft 格式的 LoRA 永远读不到基础模型和触发词。
    """
    path = Path(path)
    if path.suffix.lower() not in SAFETENSORS_SUFFIXES:
        return {}
    try:
        with path.open("rb") as handle:
            head = handle.read(8)
            if len(head) < 8:
                return {}
            header_size = struct.unpack("<Q", head)[0]
            if header_size <= 0 or header_size > MAX_HEADER_BYTES:
                return {}
            header = json.loads(handle.read(header_size))
    except Exception:
        return {}
    if not isinstance(header, dict):
        return {}
    metadata = header.get("__metadata__")
    return dict(metadata) if isinstance(metadata, dict) else {}


def file_trigger_words(metadata: dict[str, Any]) -> list[str]:
    """LoRA 文件自己声明的触发词。

    显式声明的键优先；ss_tag_frequency 是兜底，但截得很狠 —— 训练集中出现
    最多的标签多半是数据集标签，不是激活词。
    """
    for key in ("modelspec.trigger_phrase", "ss_trigger_words"):
        value = str(metadata.get(key) or "").strip()
        if value:
            return [word.strip() for word in value.split(",") if word.strip()][:20]
    frequency = metadata.get("ss_tag_frequency")
    if isinstance(frequency, str):
        try:
            frequency = json.loads(frequency)
        except json.JSONDecodeError:
            return []
    if not isinstance(frequency, dict):
        return []
    totals: dict[str, int] = {}
    for dataset in frequency.values():
        if not isinstance(dataset, dict):
            continue
        for tag, count in dataset.items():
            if isinstance(count, (int, float)) and not isinstance(count, bool):
                totals[tag.strip()] = totals.get(tag.strip(), 0) + int(count)
    ranked = sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    return [tag for tag, _ in ranked[:8] if tag]


def base_model_family(metadata: dict[str, Any]) -> str:
    """LoRA 声明的基础模型；什么都没声明时返回 ""。

    只读两个**声明性**的键。``ss_sd_model_name`` 是训练时用的源文件名，不是
    架构 —— 从里面抠子串会把任何 ``..._v1.safetensors`` 报成 SD1.5，给一个
    能用的 LoRA 贴错标签比不贴更糟。
    """
    haystack = " ".join(
        str(metadata.get(key) or "")
        for key in ("modelspec.architecture", "ss_base_model_version")
    ).lower()
    for needle, family in (
        ("flux", "Flux"), ("sd3", "SD3"), ("xl", "SDXL"), ("v2", "SD2"), ("v1", "SD1.5"),
    ):
        if needle in haystack:
            return family
    # 比这张表更新的架构仍会自报家门（"krea2/lora"、"qwen_image"），
    # 那就照它说的显示，而不是什么都不显示。
    declared = str(
        metadata.get("modelspec.architecture") or metadata.get("ss_base_model_version") or ""
    ).strip()
    return declared.split("/")[0].strip()


# ---------------------------------------------------------------- 磁盘：文件与缓存


class LoadedLora(NamedTuple):
    tensors: Any
    metadata: dict[str, Any]


# 留最近几个解好的 LoRA：任何一行强度一动，整个栈就要重跑，每次重新解几百 MB
# 的文件，成本远大于应用本身。
_LORA_CACHE: "OrderedDict[str, tuple[tuple[int, int], LoadedLora]]" = OrderedDict()
_LORA_CACHE_LIMIT = 4
_LORA_CACHE_LOCK = threading.Lock()


def load_lora_file(path: Path) -> LoadedLora:
    """解一个 LoRA 文件，按 (mtime_ns, size) 认变化并缓存。

    元数据顺手一起取（``return_metadata=True``）：反正整个文件都要读一遍，
    再单独去读一次头部是白费一次 IO，而且 .ckpt 这类非 safetensors 文件只有
    这条路能拿到元数据。
    """
    import comfy.utils

    key = str(path)
    stat = Path(path).stat()
    identity = (stat.st_mtime_ns, stat.st_size)
    with _LORA_CACHE_LOCK:
        cached = _LORA_CACHE.get(key)
        if cached is not None and cached[0] == identity:
            _LORA_CACHE.move_to_end(key)
            return cached[1]
    tensors, metadata = comfy.utils.load_torch_file(str(key), safe_load=True, return_metadata=True)
    loaded = LoadedLora(tensors, metadata if isinstance(metadata, dict) else {})
    with _LORA_CACHE_LOCK:
        _LORA_CACHE[key] = (identity, loaded)
        _LORA_CACHE.move_to_end(key)
        while len(_LORA_CACHE) > _LORA_CACHE_LIMIT:
            _LORA_CACHE.popitem(last=False)
    return loaded


def patch_total(model, clip) -> int | None:
    """model + CLIP 上已登记的补丁条目总数；读不出来时返回 None。

    comfy 把每个被打过补丁的权重记在 ModelPatcher 上
    ``{weight_key: [patch, ...]}``，所以一个什么都没匹配上的 LoRA 不会让总数
    变化。鸭子类型 + 失败即失效：读不到（将来 comfy 改了结构）就返回 None，
    这项检查自动关掉，不影响出图。
    """
    total = 0
    readable = False
    for patcher in (model, getattr(clip, "patcher", None)):
        patches = getattr(patcher, "patches", None)
        if not isinstance(patches, dict):
            continue
        readable = True
        for entries in patches.values():
            try:
                total += len(entries)
            except TypeError:
                total += 1
    return total if readable else None


_no_effect_warned: set[str] = set()


def _warn_no_effect(row_name: str, declared_family: str) -> None:
    """一个 LoRA 在接上的模型上一个权重都没打到，只提示一次。

    只按名字记：同一个 LoRA 换第二个模型也是同一个用户级错误，每次跑都刷
    一遍只是噪音。
    """
    if row_name in _no_effect_warned:
        return
    _no_effect_warned.add(row_name)
    trained_for = f" It declares base model '{declared_family}'." if declared_family else ""
    print(
        f"[QG-tools] LoRA Loader: '{row_name}' matched nothing in the connected "
        f"model, so it had no effect on this run.{trained_for} It is almost "
        "certainly built for a different base model - check the LoRA's base "
        "model against the checkpoint feeding this node."
    )


_missing_warned: set[str] = set()


def _warn_missing(row_name: str, reason: str) -> None:
    """一个在 models/loras 里彻底找不到的 LoRA，只提示一次。

    只有 skip 模式会走到这里：这一行被丢掉，栈的其余部分照常应用，面板上
    那一行也会被标出来。默认的 error 模式在采样之前就停下了。
    """
    if row_name in _missing_warned:
        return
    _missing_warned.add(row_name)
    print(
        f"[QG-tools] LoRA Loader: skipping '{row_name}' - {reason} The rest "
        "of the stack still applies; fix or remove the row to clear this."
    )


# ---------------------------------------------------------------- 磁盘：可读性 / 缺失


def unreadable_lora_reason(path: Path) -> str:
    """这个文件为什么当不了 LoRA，用大白话说；开头看着正常就返回 ""。

    只读 64 字节，所以校验能在载入任何模型之前逐行走一遍。每个判断都要一整
    个签名：一个字节什么都证明不了，.safetensors 的头长度可以是任意字节。
    """
    try:
        with Path(path).open("rb") as handle:
            head = handle.read(64)
    except OSError:
        return ""
    if not head:
        return f"The file is empty, so its download never finished. {_REDOWNLOAD}"
    if head.startswith(b"SQLite format 3"):
        return (
            "It looks like a Draw Things file. Draw Things turns a LoRA into its own "
            "kind of file when you import it, and ComfyUI cannot open that kind. "
            "Pick the original .safetensors file in this row."
        )
    if head.startswith(b"version https://git-lfs"):
        return f"It is a small text pointer to the LoRA, not the LoRA itself. {_REDOWNLOAD}"
    if head.startswith(b"PK\x03\x04"):
        return (
            "It is a zip archive, not a LoRA. Unpack it and point this row at the "
            f".safetensors file inside. {_REDOWNLOAD}"
        )
    if head.lstrip().lower().startswith((b"<!doctype", b"<html", b"<?xml")):
        return (
            "It is a web page saved under the LoRA's name, which happens when a "
            f"download needs a login or fails. {_REDOWNLOAD}"
        )
    return ""


def unreadable_lora_rows(rows: list[dict[str, Any]], has_clip: bool = True) -> list[tuple[str, str]]:
    """(名字, 原因)：会被加载、而文件根本不是 LoRA 的那些行。

    文件不存在的那类留给 missing_lora_rows。
    """
    unreadable: list[tuple[str, str]] = []
    for row in loaded_rows(rows, has_clip):
        try:
            reason = unreadable_lora_reason(resolve_lora_path(row["name"]))
        except ValueError:
            continue
        if reason:
            unreadable.append((row["name"], reason))
    return unreadable


def missing_lora_rows(rows: list[dict[str, Any]], has_clip: bool = True) -> list[tuple[str, str]]:
    """(名字, 原因)：会被加载、而文件定位不到的那些行。

    校验和执行共用，严格模式下栈会在采样之前失败，报的就是执行时本来也会
    报的那句话。
    """
    missing: list[tuple[str, str]] = []
    for row in loaded_rows(rows, has_clip):
        try:
            resolve_lora_path(row["name"])
        except ValueError as exc:
            missing.append((row["name"], str(exc)))
    return missing


def unreadable_lora_message(name: str, reason: str, detail: str = "") -> str:
    message = f"LoRA Loader: '{name}' is not a LoRA file ComfyUI can open. " + (
        reason
        or "It may be broken, only partly downloaded, or another kind of file "
        f"under a LoRA's name. {_REDOWNLOAD}"
    )
    return f"{message} Technical details: {detail}" if detail else message


# ---------------------------------------------------------------- 执行


def apply_lora_stack(
    model,
    clip,
    rows: list[dict[str, Any]],
    on_missing: str = "error",
    missing: list | None = None,
):
    """按行序应用会被加载的行，返回 (model, clip)。

    skip 模式下定位不到的行只提示一次并跳过；传一个列表作为 ``missing``
    就能收齐这些行 —— 节点靠它让一个始终没加载的 LoRA 不贡献触发词。
    """
    import comfy.sd

    has_clip = clip is not None
    for row in loaded_rows(rows, has_clip):
        raise_if_interrupted()
        try:
            path = resolve_lora_path(row["name"])
        except ValueError as exc:
            if on_missing != "skip":
                # 严格是默认：一张图少了它要的 LoRA 还照样渲出来，比不渲更糟，
                # 脚本化和由 agent 驱动的运行尤其如此 —— 它们会照单全收了结果。
                raise ValueError(
                    f"LoRA Loader: '{row['name']}' - {exc} Stop on missing LoRA is on "
                    "(the default), so the run stopped instead of rendering without it. "
                    "Fix or remove the row, or turn 'Stop on missing LoRA' off in the "
                    "node's settings menu (the gear icon on the node) to warn and skip "
                    "instead; in API graphs that is on_missing: skip."
                ) from exc
            _warn_missing(row["name"], str(exc))
            if missing is not None:
                missing.append(row)
            continue
        try:
            loaded = load_lora_file(path)
        except MemoryError:
            raise
        except Exception as exc:
            # 核心在这里抛的是 PyTorch 的话，从头到尾不提是哪个文件。
            detail = f"{type(exc).__name__}: {' '.join(str(exc).split())}"
            raise ValueError(
                unreadable_lora_message(row["name"], unreadable_lora_reason(path), detail)
            ) from exc
        before = patch_total(model, clip)
        model, clip = comfy.sd.load_lora_for_models(
            model,
            clip,
            loaded.tensors,
            row["strength"],
            row["strength_clip"] if has_clip else 0.0,
            # 核心会把这份元数据挂到 ModelPatcher 上，官方 LoraLoader 也传。
            # 不传的话，下游想读 LoRA 自报的基础模型 / 标题就没有来源。
            lora_metadata=loaded.metadata or None,
        )
        after = patch_total(model, clip)
        # 实测出来的，不是猜的：这条对任何模型家族都成立，现在和将来都一样，
        # 而且一个真起了作用的 LoRA 永远不会触发它。
        if before is not None and after is not None and after == before:
            _warn_no_effect(
                row["name"],
                base_model_family(loaded.metadata or {}) or _metadata_family(path),
            )
    return model, clip


def _metadata_family(path: Path) -> str:
    """缓存里没带元数据时的兜底：单独读一次文件头。

    .ckpt / .pt 这类 pickle 容器读不出元数据，返回 ""。
    """
    try:
        return base_model_family(read_safetensors_metadata(path))
    except Exception:
        return ""


def stack_fingerprint(rows: list[dict[str, Any]]) -> str:
    """缓存键：行上的值 + 每个文件在盘上的身份 + 触发词。

    触发词必须在里面。``IS_CHANGED`` 一旦存在，核心就**只**看它的返回值，
    不再比较输入有没有变；漏掉触发词的话，改完触发词接着排队会直接命中上一次
    的输出缓存，STRING 那路还是旧的。模型和 CLIP 确实不受影响，但这条输出
    是节点承诺要产出的东西。
    """
    parts: list[str] = []
    for row in rows:
        try:
            stat = resolve_lora_path(row["name"]).stat()
            identity = f"{stat.st_mtime_ns}:{stat.st_size}"
        except (ValueError, OSError):
            identity = "missing"
        parts.append(
            f"{row['name']}|{row['strength']}|{row['strength_clip']}|"
            f"{row['enabled']}|{identity}|{row.get('triggers', '')}"
        )
    return ";".join(parts)


# ---------------------------------------------------------------- 用户存储


_STORE_LOCK = threading.Lock()


def _user_store_dir() -> Path | None:
    if folder_paths is None:
        return None
    try:
        base = Path(folder_paths.get_user_directory()) / "QG-tools"
        base.mkdir(parents=True, exist_ok=True)
        return base
    except Exception:
        return None


def _write_json(path: Path, data: Any) -> None:
    """先写临时文件再 os.replace —— 半个文件比没有文件更坏。"""
    temporary = path.with_suffix(f".tmp{os.getpid()}-{threading.get_ident()}")
    temporary.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _triggers_store_path() -> Path | None:
    base = _user_store_dir()
    return None if base is None else base / "lora_triggers.json"


def _clean_bound(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return max(-STRENGTH_LIMIT, min(STRENGTH_LIMIT, number))


def _read_custom_entry(name: str) -> dict[str, Any]:
    """一个 LoRA 的用户数据。值要么是老版的纯词表，要么是 {words, min, max}；
    两种形状都归一成后一种。"""
    store = _triggers_store_path()
    if store is None or not store.is_file():
        return {}
    data = _read_json(store)
    if not isinstance(data, dict):
        return {}
    entry = data.get(name)
    if isinstance(entry, list):
        return {"words": [str(word) for word in entry if str(word).strip()]}
    return entry if isinstance(entry, dict) else {}


def load_custom_triggers(name: str) -> list[str]:
    words = _read_custom_entry(name).get("words", [])
    return [str(word) for word in words if str(word).strip()] if isinstance(words, list) else []


def load_custom_range(name: str) -> dict[str, float] | None:
    entry = _read_custom_entry(name)
    low = _clean_bound(entry.get("min"))
    high = _clean_bound(entry.get("max"))
    if low is None and high is None:
        return None
    return {"min": low, "max": high}


def save_custom_lora_data(
    name: str, words: list[str] | None, bounds: dict[str, Any] | None = None
) -> dict[str, Any]:
    """写入一个 LoRA 的触发词与推荐强度区间。

    ``words`` 与 ``bounds`` 各有两态，四组组合都是需要的：

    * ``words=None``：这次只改区间，词表继承锁内读到的那一份；
    * ``bounds=None``：这次只改词表（信息卡的「+」），区间继承；
    * ``words=[]`` / ``{"min": None, "max": None}``：真的清空。

    以前两者都只有「整份覆盖」一条路：点一下「+」会把推荐区间冲掉；
    改一下区间又会拿渲染那一刻的词表快照盖掉刚加的词。
    """
    store = _triggers_store_path()
    if store is None:
        return {"words": []}
    # 去重（保序）：自定义触发词是「加进去」语义，同一个词被记两遍只会在
    # 信息卡上多出一个一模一样的胶囊，而它进 triggers 输出时也只会拼一次
    # —— 存着的那份重复只是噪音。
    cleaned: list[str] = []
    for word in (words or []):
        text = str(word).strip()
        if text and text not in cleaned:
            cleaned.append(text)
    cleaned = cleaned[:64]
    with _STORE_LOCK:
        if store.is_file():
            data = _read_json(store)
            if not isinstance(data, dict):
                # 文件在，却读不出一个对象（写到一半断电、手动编辑出错、
                # 权限变了）。当成空表接着写，会把里面其余每个 LoRA 的触发词
                # 和推荐区间一起抹掉 —— 那是用户的配置，不是缓存。宁可这次
                # 保存失败，让人先看到问题。
                raise ValueError(
                    "LoRA Loader: the saved trigger list could not be read, so this "
                    "save was stopped rather than overwriting it. Fix or delete "
                    f"'{store}' and save again."
                )
        else:
            data = {}
        previous = data.get(name)
        previous = previous if isinstance(previous, dict) else {}
        entry: dict[str, Any] = {}
        if words is None:
            # 「这次只动区间」：词表原样继承锁内读到的那一份。信息卡改强度时
            # 若把渲染那一刻的词表快照整份写回来，会把期间「+」刚加的词抹掉。
            kept = previous.get("words", [])
            entry["words"] = [str(word) for word in kept] if isinstance(kept, list) else []
        else:
            entry["words"] = cleaned
        if bounds is None:
            # 「这次只动触发词」：区间原样继承锁内读到的那一份。以前是在锁外
            # 先读一次再传进来，两个保存动作撞在一起时，后到的会用旧的区间把
            # 别人刚写的那份盖回去。
            low = _clean_bound(previous.get("min"))
            high = _clean_bound(previous.get("max"))
        else:
            low = _clean_bound(bounds.get("min"))
            high = _clean_bound(bounds.get("max"))
        if low is not None and high is not None and low > high:
            low, high = high, low
        if low is not None:
            entry["min"] = low
        if high is not None:
            entry["max"] = high
        if entry["words"] or len(entry) > 1:
            data[name] = entry
        else:
            data.pop(name, None)
        try:
            _write_json(store, data)
        except OSError:
            pass
    return entry


def save_custom_triggers(name: str, words: list[str]) -> list[str]:
    """只改触发词，强度区间交给 save_custom_lora_data 在锁内继承。"""
    return save_custom_lora_data(name, words).get("words", [])


# ---------------------------------------------------------------- Civitai 侧车


def civitai_sidecar_path(name: str) -> Path:
    """LoRA 文件旁边的标准 Civitai 侧车。别的工具写它，本插件点了「获取
    Civitai 信息」也写它（查网站的是浏览器，这台服务器从不访问 Civitai）。"""
    return resolve_lora_path(name).with_suffix(".civitai.info")


def _clean_civitai_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _normalize_civitai_info(data: Any) -> dict[str, Any]:
    """把标准侧车（或本插件早期的缓存形状）归一成同一种结构。"""
    if not isinstance(data, dict):
        return {}
    model = data.get("model")
    model = model if isinstance(model, dict) else {}
    raw_words = data.get("trainedWords", data.get("trained_words", []))
    trained_words = (
        [str(word).strip() for word in raw_words if str(word).strip()][:40]
        if isinstance(raw_words, list)
        else []
    )
    info = {
        "found": truthy(data.get("found", True)),
        "title": str(model.get("name") or data.get("title") or data.get("name") or ""),
        "base_model": str(data.get("baseModel") or data.get("base_model") or ""),
        "trained_words": trained_words,
        "model_id": _clean_civitai_id(data.get("modelId", data.get("model_id"))),
        "version_id": _clean_civitai_id(data.get("id", data.get("version_id"))),
    }
    recognized = any(
        info[key] not in (None, "", [])
        for key in ("title", "base_model", "trained_words", "model_id", "version_id")
    )
    return info if info["found"] and recognized else {}


def load_civitai_cache(name: str) -> dict[str, Any]:
    """读 LoRA 旁边的 Civitai 侧车。

    ``.civitai.info`` 是标准名，``.civitai.info.json`` 是几个管理器在用的变体，
    两种都认 —— 只认前者会让装过那些管理器的人看不到已有的信息。
    """
    try:
        base = civitai_sidecar_path(name)
    except ValueError:
        return {}
    for candidate in (base, base.with_suffix(".info.json")):
        if not candidate.is_file():
            continue
        info = _normalize_civitai_info(_read_json(candidate))
        if info:
            return info
    return {}


def _hash_cache_path() -> Path | None:
    base = _user_store_dir()
    return None if base is None else base / "lora_hashes.json"


def file_sha256(path: Path) -> str:
    """文件的 SHA256，按 (mtime, size) 缓存 —— LoRA 动辄几百 MB。"""
    import hashlib

    path = Path(path)
    stat = path.stat()
    identity = f"{stat.st_mtime_ns}:{stat.st_size}"
    cache_file = _hash_cache_path()
    cache: dict[str, Any] = {}
    if cache_file is not None and cache_file.is_file():
        loaded = _read_json(cache_file)
        if isinstance(loaded, dict):
            cache = loaded
    entry = cache.get(str(path))
    if isinstance(entry, dict) and entry.get("identity") == identity:
        cached = str(entry.get("sha256", ""))
        if cached:
            return cached
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    sha = digest.hexdigest()
    if cache_file is not None:
        # 同样要读—改—写加锁，否则两个并发请求会互相覆盖缓存条目。
        with _STORE_LOCK:
            fresh = _read_json(cache_file) if cache_file.is_file() else None
            store = fresh if isinstance(fresh, dict) else {}
            store[str(path)] = {"identity": identity, "sha256": sha}
            try:
                _write_json(cache_file, store)
            except OSError:
                pass
    return sha


def lora_sha256(name: str) -> str:
    """LoRA 文件的 SHA256，给浏览器的 Civitai 查询用。"""
    return file_sha256(resolve_lora_path(name))


def _hashes_in(payload: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    files = payload.get("files")
    for entry in files if isinstance(files, list) else []:
        hashes = entry.get("hashes") if isinstance(entry, dict) else None
        value = hashes.get("SHA256") if isinstance(hashes, dict) else None
        if isinstance(value, str):
            found.add(value.strip().lower())
    return found


def save_civitai_sidecar(name: str, payload: Any) -> dict[str, Any]:
    """把 Civitai 的应答照标准侧车存到 LoRA 旁边。

    应答是浏览器取回来的，所以是不可信输入：必须是大小合理、形状标准、并且
    描述的文件 SHA256 正是这个 LoRA 自己的 JSON 对象。三条都过才写，写到
    解析出来的 LoRA 文件旁边的固定名字 ``<模型>.civitai.info``。
    """
    if not isinstance(payload, dict):
        raise ValueError("Civitai response must be a JSON object.")
    if len(json.dumps(payload)) > MAX_CIVITAI_BYTES:
        raise ValueError("Civitai response is too large.")
    path = resolve_lora_path(name)
    if file_sha256(path).lower() not in _hashes_in(payload):
        raise ValueError("That Civitai answer is for a different file.")
    info = _normalize_civitai_info(payload)
    if not info:
        raise ValueError("That Civitai answer has no model information.")
    _write_json(civitai_sidecar_path(name), payload)
    return info


def save_civitai_picture(name: str, data: Any) -> Path:
    """把一张图存成 ``<模型>.preview.jpg`` 放在 LoRA 旁边。

    字节由浏览器下载后转交，所以是不可信输入：重新解码、重新编码成一张小
    JPEG 再落盘，Civitai 塞在 EXIF 里的东西一概不进来。

    已经有预览图的 LoRA **一律不覆盖** —— 用户自己放的那张比 Civitai 的珍贵。
    用 ``xb`` 独占创建，两个请求同时到达时后到的那个也覆盖不了。
    """
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise LoraPictureError("picture_empty")
    if len(data) > MAX_PICTURE_BYTES:
        raise LoraPictureError(
            "picture_too_large",
            megabytes=round(len(data) / (1024 * 1024), 1),
            limit=MAX_PICTURE_BYTES // (1024 * 1024),
        )
    path = resolve_lora_path(name)
    if thumbnail_beside(path) is not None:
        raise LoraPictureError("picture_already_saved")
    from io import BytesIO

    from PIL import Image

    try:
        with Image.open(BytesIO(bytes(data))) as picture:
            width, height = picture.size
            if width * height > MAX_PICTURE_PIXELS:
                raise LoraPictureError(
                    "picture_too_many_pixels",
                    width=width,
                    height=height,
                    megapixels=round(width * height / 1_000_000, 1),
                    limit=MAX_PICTURE_PIXELS // 1_000_000,
                )
            picture = picture.convert("RGB")
            picture.thumbnail((PICTURE_EDGE, PICTURE_EDGE))
            out = BytesIO()
            picture.save(out, "JPEG", quality=88)
    except LoraPictureError:
        raise
    except Exception as exc:
        raise LoraPictureError("picture_not_an_image") from exc
    target = Path(str(path.with_suffix("")) + ".preview.jpg")
    try:
        with open(target, "xb") as handle:
            handle.write(out.getvalue())
    except FileExistsError as exc:
        raise LoraPictureError("picture_already_saved") from exc
    return target


def lora_info(name: str) -> dict[str, Any]:
    path = resolve_lora_path(name)
    metadata = read_safetensors_metadata(path)
    civitai = load_civitai_cache(name)
    stat = path.stat()
    return {
        "name": name,
        "size_bytes": stat.st_size,
        "mtime": stat.st_mtime,
        "base_model": base_model_family(metadata) or civitai.get("base_model", ""),
        "file_triggers": file_trigger_words(metadata),
        "civitai_triggers": civitai.get("trained_words", []),
        "civitai_title": civitai.get("title", ""),
        "civitai_model_id": civitai.get("model_id"),
        "civitai_version_id": civitai.get("version_id"),
        "custom_triggers": load_custom_triggers(name),
        "range": load_custom_range(name),
        "has_preview": thumbnail_beside(path) is not None,
        "has_civitai": bool(civitai),
    }


def thumbnail_bytes(name: str) -> bytes | None:
    """预览图的小 JPEG；没有预览图返回 None。"""
    thumb = find_thumbnail(name)
    if thumb is None:
        return None
    from ._qg_thumb_helpers import thumbnail

    return thumbnail(thumb, THUMB_EDGE)


# ---------------------------------------------------------------- 路由


async def asyncio_run_in_executor(func, *args):
    import asyncio

    return await asyncio.get_running_loop().run_in_executor(None, func, *args)


def register_lora_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is None or getattr(prompt_server, "_qg_lora_routes", False):
        return
    prompt_server._qg_lora_routes = True
    from ._qg_route_errors import safe_route_error

    @prompt_server.routes.get("/qg/lora/list")
    async def qg_lora_list(request):
        # 走线程池：第一次列出库要把 models/loras 走一遍，同步做会把整个
        # 事件循环按住，那期间的进度推送和所有别的 API 都不响应。
        return web.json_response({"loras": await asyncio_run_in_executor(list_loras)})

    @prompt_server.routes.get("/qg/lora/thumb")
    async def qg_lora_thumb(request):
        # 发的是在这里重新解码出来的小图，永远不是文件本身：无论一个预览图的
        # 名字指向什么，出网的只是一张图。
        try:
            body = await asyncio_run_in_executor(
                thumbnail_bytes, request.query.get("name", "")
            )
        except Exception:
            body = None
        if body is None:
            return web.json_response({"error": "no preview image"}, status=404)
        return web.Response(
            body=body, content_type="image/jpeg", headers={"Cache-Control": "max-age=3600"}
        )

    @prompt_server.routes.get("/qg/lora/info")
    async def qg_lora_info(request):
        try:
            info = await asyncio_run_in_executor(lora_info, request.query.get("name", ""))
            return web.json_response({"ok": True, "info": info})
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=400)

    @prompt_server.routes.get("/qg/lora/hash")
    async def qg_lora_hash(request):
        try:
            sha = await asyncio_run_in_executor(lora_sha256, request.query.get("name", ""))
            return web.json_response({"ok": True, "sha256": sha})
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=400)

    @prompt_server.routes.post("/qg/lora/civitai")
    async def qg_lora_civitai(request):
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Request body must be a JSON object.")
            info = await asyncio_run_in_executor(
                save_civitai_sidecar, str(body.get("name", "")), body.get("info")
            )
            return web.json_response({"ok": True, "info": info})
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=400)

    @prompt_server.routes.post("/qg/lora/picture")
    async def qg_lora_picture(request):
        try:
            declared = request.content_length or 0
            if declared > MAX_PICTURE_BYTES:
                raise LoraPictureError(
                    "picture_too_large",
                    megabytes=round(declared / (1024 * 1024), 1),
                    limit=MAX_PICTURE_BYTES // (1024 * 1024),
                )
            data = await request.read()
            await asyncio_run_in_executor(
                save_civitai_picture, request.query.get("name", ""), data
            )
            return web.json_response({"ok": True})
        except Exception as exc:
            body = {"ok": False, "error": safe_route_error(exc)}
            # 认得出原因就把 code 与数字一起给面板：它按自己的语言出句子，
            # 不必把英文原文塞进 toast（toast 里的字不走节点的 DOM 翻译）。
            if isinstance(exc, LoraPictureError):
                body["code"] = exc.code
                body["params"] = exc.params
            return web.json_response(body, status=400)

    @prompt_server.routes.post("/qg/lora/triggers")
    async def qg_lora_triggers(request):
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Request body must be a JSON object.")
            name = str(body.get("name", ""))
            words = body.get("words")
            if words is not None and not isinstance(words, list):
                raise ValueError("words must be a list.")
            # 键是否出现，而不是值是不是 None。「+」只发 {name, words}（加一个
            # 触发词）；改强度只发 {name, min, max}。各自缺席的那一半在锁内继承，
            # 谁都不会把对方刚写的东西盖掉。
            bounds = (
                {"min": body.get("min"), "max": body.get("max")}
                if "min" in body or "max" in body
                else None
            )
            saved = await asyncio_run_in_executor(
                _save_triggers_checked, name, words, bounds
            )
            return web.json_response({"ok": True, **saved})
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=400)


def _save_triggers_checked(name: str, words: list, bounds: dict | None) -> dict[str, Any]:
    """先确认名字能解析（挡住给不存在的东西存数据），再写。整体在线程池里跑，
    连路径解析的这次 stat 也不留在事件循环上。"""
    resolve_lora_path(name)
    return save_custom_lora_data(name, words, bounds)

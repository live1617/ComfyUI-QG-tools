# -*- coding: utf-8 -*-
"""QG 展示任意 — 把任意输入渲染成预览，并把值原样传下去。

为什么自己写
------------
原版是 Goohaitools-comfyui 的「展示任意 GH」（GPL-3.0，作者孤海）。它做了一件
核心没有的事：任何类型都能挂在图上看一眼。2026-10-30 重写成自己的实现。

和原版**一样**的部分（老图不受影响）
------------------------------------
* ID ``QG_DisplayAny``、输入槽名 ``Any``、输出名 ``Any``、分类
  ``QG-tools/Display``、``OUTPUT_NODE = True``、``ui`` 键 ``qg_display``
  及其 ``type / text / images / audio / video`` 字段。
* 图像与遮罩写成临时 PNG、音频写成临时 WAV、视频写成临时 MP4；预览失败
  只记日志，**不阻断数据流**。
* 排队前的那个 prompt 钩子：被下游引用的展示节点是依赖，不该再当执行根。

改掉的部分
----------
1. **四维遮罩能预览了。** 官方文档写明 MASK 的合法形状是 ``[H,W]`` 或
   ``[B,C,H,W]``，原版只认前两种（``[H,W]`` / ``[B,H,W]``），拿到四维直接
   ``raise ValueError("遮罩应为 [B,H,W] 或 [H,W]")``，界面上只看到「预览失败」。
2. **没接线时不再显示 "None"。** 原版 ``describe(None)`` 返回字符串 ``"None"``，
   于是空节点上就写着 "None"；现在改发一个 ``notice`` 代码，由前端出双语提示。
3. **后端不再往回塞中文。** 原版把「该视频格式不支持直接预览…」「预览失败…」
   拼进 ``text``，英文界面下这两句也是中文。现在只发 ``notice.code``，
   文案归前端（``zhPair``）。
4. **超长文本不再整段推。** ``describe`` 对顶层字符串原样返回，一个 10 MB 的
   文本会完整走一遍 WebSocket 再塞进 DOM；现在封顶 100000 字符并注明总长。
5. 通配类型换成 ``_qg_any_type.ANY``：原版那份类覆盖了 ``__eq__`` 却没给回
   ``__hash__``，实例不可哈希（详见该模块的文件头）。
6. prompt 钩子里的 node id 统一按字符串比，并做了幂等注册。

只有核心自带的模块（torch / numpy / PIL / folder_paths）—— 没有新依赖。
"""

from __future__ import annotations

import logging
import os
import re
import uuid
import wave
from collections.abc import Mapping

import numpy as np
import torch
from PIL import Image

import folder_paths
import nodes
from comfy_api.latest import Input, Types
from comfy.model_management import InterruptProcessingException
from comfy_execution.graph_utils import is_link
from server import PromptServer

from ._qg_any_type import ANY, WILDCARD_NAMES

NODE_TYPE = "QG_DisplayAny"

# describe() 对顶层字符串的上限。正常提示词远到不了，这里拦的是「某个节点吐了
# 一整本书」那种把 WebSocket 和 DOM 一起拖死的情况。
TEXT_LIMIT = 100_000

# 预览这一侧要告诉前端的事，文案在前端（中英各一份），后端只说代码。
NOTICE_NO_INPUT = "no_input"
NOTICE_PREVIEW_FAILED = "preview_failed"
NOTICE_VIDEO_UNSUPPORTED = "video_unsupported"
NOTICE_TEXT_TRUNCATED = "text_truncated"

# 只认「像类型名」的声明：全大写字母 / 数字 / 下划线。上游把 RETURN_TYPES 写成
# 选项列表（["a", "b"]）时，str() 出来是 "['A', 'B']"，那不是类型。
_TYPE_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")


def select_display_targets(request):
    """被下游引用的展示节点是依赖，不该再当独立执行根。

    核心在 ``server.py`` 读 ``partial_execution_targets`` 并交给
    ``execution.validate_prompt``：传了列表就只把这些 OUTPUT_NODE 当目标，
    没传就全部当目标。前端 1.24 之后会自己传（只含选中的输出节点），此时一个
    既被选中、又被下游引用的展示节点会在两处都出现 —— 靠这里把它从目标里摘掉。

    注意 node id 在 prompt 里是字符串键，而 ``partial_execution_targets`` 由
    前端 JSON 送来，两边都得按字符串比，否则 int/str 混着永远摘不掉。
    """
    prompt = request.get("prompt", {})
    displays = {str(node_id) for node_id, node in prompt.items() if node.get("class_type") == NODE_TYPE}
    if not displays:
        return request
    referenced = {
        str(value[0])
        for node in prompt.values()
        for value in node.get("inputs", {}).values()
        if is_link(value)
    }
    passive = displays & referenced
    if not passive:
        return request
    targets = request.get("partial_execution_targets")
    if targets is None:
        targets = [
            str(node_id) for node_id, node in prompt.items()
            if getattr(nodes.NODE_CLASS_MAPPINGS.get(node.get("class_type")), "OUTPUT_NODE", False) is True
        ]
    remaining = [node_id for node_id in targets if str(node_id) not in passive]
    # 🔴 摘完一个不剩时就别摘。前端「只执行选中的节点」选中的正是这个展示节点时，
    # targets 只有它一个；摘掉之后 validate_prompt 会判「Prompt has no outputs」
    # 直接拒单 —— 而用户要的恰恰是「就跑这一下」。宁可让它多当一次执行根。
    if remaining:
        request["partial_execution_targets"] = remaining
    return request


def describe(value, depth=0, seen=None):
    """把任意值写成一段人能读的文字。

    输出刻意与界面语言无关：``Tensor(shape=…, dtype=…)``、``dict[3]``、
    ``… +7`` 这类写法中英文都读得通，不用翻译，也就不会出现「英文界面里冒出
    中文」「中文界面里全是英文」两头不讨好的情况。真正的句子（预览失败、
    没有输入、文本被截断）走 ``notice``，由前端按语言出。
    """
    if isinstance(value, str):
        if depth == 0:
            if len(value) <= TEXT_LIMIT:
                return value
            return value[:TEXT_LIMIT]
        return repr(value[:500])
    if value is None or isinstance(value, (bool, int, float)):
        return str(value)
    if torch.is_tensor(value):
        return "Tensor(shape=%s, dtype=%s, device=%s)" % (list(value.shape), value.dtype, value.device)
    if isinstance(value, np.ndarray):
        return "ndarray(shape=%s, dtype=%s)" % (list(value.shape), value.dtype)
    if isinstance(value, (Mapping, list, tuple, set)):
        seen = set() if seen is None else seen
        if id(value) in seen:
            return "<cycle>"
        if depth >= 3:
            return "%s[%d]" % (type(value).__name__, len(value))
        seen.add(id(value))
        try:
            lines = []
            entries = value.items() if isinstance(value, Mapping) else enumerate(value)
            for index, (key, item) in enumerate(entries):
                if index == 8:
                    lines.append("… +%d" % (len(value) - 8))
                    break
                lines.append("%s: %s" % (key, describe(item, depth + 1, seen)))
            return "%s[%d]\n%s" % (type(value).__name__, len(value), "\n".join(lines))
        finally:
            # 放在 finally 里：上面任何一项抛异常都不会把 id 永久留在 seen 里，
            # 否则同一个对象在后面会被误判成循环引用。
            seen.discard(id(value))
    cls = type(value)
    return "%s.%s" % (cls.__module__, cls.__qualname__)


def preview_kind(value, declared):
    """这一路该按什么渲染。

    上游声明的类型优先 —— 它是唯一能把「四维遮罩」和「图像」分开的东西
    （两者都是四维 float 张量，看形状分不出来）。声明是通配或压根没有时，
    只能按值的形状猜，猜不出来的就老实当 ``ANY`` 只显示 shape。
    """
    declared = str(declared or "").strip().upper()
    if declared and declared not in WILDCARD_NAMES and _TYPE_NAME.match(declared):
        return declared
    if isinstance(value, Input.Video):
        return "VIDEO"
    if isinstance(value, Mapping):
        if "waveform" in value and "sample_rate" in value:
            return "AUDIO"
        if "samples" in value:
            return "LATENT"
    if torch.is_tensor(value):
        # 四维且末维是 1/3/4 —— ComfyUI 的图像约定 [B,H,W,C]。
        if value.ndim == 4 and value.shape[-1] in (1, 3, 4):
            return "IMAGE"
        # 二维/三维当作遮罩（[H,W] / [B,H,W]）。三维图像在生态里几乎不存在，
        # 而三维遮罩是常态，所以这个方向猜错的代价最小。
        if value.ndim in (2, 3):
            return "MASK"
    for cls, name in ((bool, "BOOLEAN"), (int, "INT"), (float, "FLOAT"), (str, "STRING")):
        if isinstance(value, cls):
            return name
    return "ANY"


def temp_file(extension):
    directory = folder_paths.get_temp_directory()
    os.makedirs(directory, exist_ok=True)
    filename = "qg_display_%s.%s" % (uuid.uuid4().hex, extension)
    return os.path.join(directory, filename), {"filename": filename, "subfolder": "", "type": "temp"}


def preview_images(value, kind):
    if not torch.is_tensor(value):
        raise TypeError("input is not a Tensor")
    if kind == "MASK":
        if value.ndim == 2:
            images = value.unsqueeze(0)
        elif value.ndim == 3:
            images = value
        elif value.ndim == 4:
            # 官方文档写明 MASK 也可以是 [B,C,H,W]；逐通道摊平成一叠单通道图，
            # 原版这里直接抛「遮罩应为 [B,H,W] 或 [H,W]」。
            images = value.reshape(-1, value.shape[-2], value.shape[-1])
        else:
            raise ValueError("mask must be [H,W], [B,H,W] or [B,C,H,W], got %s" % (list(value.shape),))
    else:
        images = value.unsqueeze(0) if value.ndim == 3 else value
        if images.ndim != 4 or images.shape[-1] not in (1, 3, 4):
            raise ValueError("image must be [B,H,W,C] with C in 1/3/4, got %s" % (list(value.shape),))
    results = []
    for image in images:
        pixels = np.clip(255.0 * image.detach().cpu().numpy(), 0, 255).astype(np.uint8)
        if pixels.ndim == 3 and pixels.shape[-1] == 1:
            pixels = pixels[..., 0]
        if pixels.ndim != 2 and pixels.shape[-1] not in (3, 4):
            raise ValueError("%d-channel frames cannot be written as an image" % pixels.shape[-1])
        path, reference = temp_file("png")
        Image.fromarray(pixels).save(path, compress_level=1)
        results.append(reference)
    return results


def preview_audio(value):
    waveform = value["waveform"]
    sample_rate = int(value["sample_rate"])
    if not torch.is_tensor(waveform) or sample_rate <= 0:
        raise ValueError("audio needs a tensor waveform and a positive sample_rate")
    if waveform.ndim == 1:
        waveform = waveform[None, None, :]
    elif waveform.ndim == 2:
        waveform = waveform[None, ...]
    if waveform.ndim != 3:
        raise ValueError("waveform must be [B,C,T], got %s" % (list(waveform.shape),))
    results = []
    for item in waveform:
        samples = item.detach().float().cpu().numpy().T
        samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
        samples = (np.clip(samples, -1, 1) * 32767).astype("<i2")
        path, reference = temp_file("wav")
        with wave.open(path, "wb") as output:
            output.setnchannels(item.shape[0])
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(samples.tobytes())
        results.append(reference)
    return results


def _declared_type(prompt, unique_id, extra_pnginfo):
    """上游声明的输出类型，拿不到就返回 None。

    两条来源：直连时读上游的 ``RETURN_TYPES``（最准）；中间隔着别的通配节点时
    读前端存进节点属性的 ``qg_display_preview.type``（前端沿链路一路传下来的）。
    """
    declared = None
    if extra_pnginfo and "workflow" in extra_pnginfo:
        try:
            for workflow_node in extra_pnginfo["workflow"].get("nodes", []):
                if str(workflow_node.get("id")) == str(unique_id):
                    declared = (workflow_node.get("properties") or {}).get(
                        "qg_display_preview", {}).get("type")
                    break
        except Exception:
            declared = None
    if prompt and unique_id in prompt:
        source = prompt[unique_id].get("inputs", {}).get("Any")
        if is_link(source) and source[0] in prompt:
            source_class = nodes.NODE_CLASS_MAPPINGS.get(prompt[source[0]]["class_type"])
            output_types = getattr(source_class, "RETURN_TYPES", ())
            if source[1] < len(output_types):
                linked = str(output_types[source[1]]).strip().upper()
                if linked not in WILDCARD_NAMES:
                    declared = linked
    return declared


class QGDisplayAny:
    CATEGORY = "QG-tools/Display"
    DESCRIPTION = (
        "Show whatever is wired into it — text, image, mask, audio, video or any "
        "other value — and pass it through unchanged. Text keeps its line breaks "
        "and can be copied; images and masks are shown as a gallery; audio and "
        "video get players. Values it has no renderer for are described by shape, "
        "dtype and contents. A preview that fails never blocks the data: the value "
        "still travels downstream. With nothing connected it says so instead of "
        "showing None."
    )
    SEARCH_ALIASES = [
        "display", "display any", "preview", "preview any", "show", "inspect",
        "debug", "passthrough", "viewer", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {"Any": (ANY, {
                "tooltip": (
                    "The value to show. Anything can be wired here; the node "
                    "picks a renderer from the upstream's declared type, or from "
                    "the value's own shape when the type is unknown. The value "
                    "comes straight back out unchanged."
                ),
            })},
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("Any",)
    OUTPUT_TOOLTIPS = (
        "The same value that came in, untouched.",
    )
    FUNCTION = "display"
    OUTPUT_NODE = True

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None):
        """让 ``*`` 输入跳过声明类型比对 —— 官方给通配符规定的写法。

        参数名必须恰好叫 ``input_types``：核心看到它会跳过
        ``validate_node_input``（见 ``execution.py`` 里
        ``if 'input_types' not in validate_function_inputs and …``）。
        这里拿到的声明类型不用来做判断 —— 声明不代表实际值，拦错了会把本来
        能跑的图挡在门外；真正的判断在 ``display`` 里按值做。
        """
        return True

    def display(self, Any=None, prompt=None, unique_id=None, extra_pnginfo=None):
        wired = False
        if prompt and unique_id in prompt:
            wired = is_link(prompt[unique_id].get("inputs", {}).get("Any"))
        # 没接线时 Any 是 None，接了线但上游返回 None 时也是 None。前者该说
        # 「没接输入」，后者该说「值就是 None」—— 靠 prompt 里有没有 link 分开。
        if not wired and Any is None:
            return {
                "ui": {"qg_display": [{
                    "type": "ANY",
                    "text": "",
                    "images": [],
                    "audio": [],
                    "video": [],
                    "notice": {"code": NOTICE_NO_INPUT},
                }]},
                "result": (Any,),
            }

        kind = preview_kind(Any, _declared_type(prompt, unique_id, extra_pnginfo))
        payload = {"type": kind, "text": describe(Any), "images": [], "audio": [], "video": [], "notice": None}
        try:
            if kind in ("IMAGE", "MASK"):
                payload["images"] = preview_images(Any, kind)
            elif kind == "AUDIO":
                payload["audio"] = preview_audio(Any)
            elif kind == "VIDEO" and isinstance(Any, Input.Video):
                path, reference = temp_file("mp4")
                Any.save_to(path, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
                payload["video"] = [reference]
            elif kind == "VIDEO":
                payload["notice"] = {"code": NOTICE_VIDEO_UNSUPPORTED}
        except InterruptProcessingException:
            raise
        except Exception as error:
            # 预览是附赠的，转码失败不该拦住数据流动。
            logging.warning("[QG-tools] QG 展示任意 预览失败: %s", error)
            payload["notice"] = {"code": NOTICE_PREVIEW_FAILED, "detail": str(error)}
        # 文本被截断也要说一声，否则用户会以为上游就吐了这么多。
        if payload["notice"] is None and isinstance(Any, str) and len(Any) > TEXT_LIMIT:
            payload["notice"] = {"code": NOTICE_TEXT_TRUNCATED, "total": len(Any), "shown": TEXT_LIMIT}
        return {"ui": {"qg_display": [payload]}, "result": (Any,)}


NODE_CLASS_MAPPINGS = {NODE_TYPE: QGDisplayAny}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_TYPE: "Display Any"}

# 模块被重新加载时不要把同一个钩子挂第二遍。标记打在 PromptServer 实例上而不是
# 模块里 —— 重载后模块变量全新，实例还是那个。
# 🔴 `instance` 是**实例属性**，在 `PromptServer.__init__` 里才挂上去；类上根本
# 没有这个属性。所以没有服务器时直接写 `PromptServer.instance` 抛的是
# AttributeError（不是「等于 None」），原版那句话在那种环境下会让整个文件
# import 失败 —— 用 getattr 取。
_server = getattr(PromptServer, "instance", None)
if _server is not None and not getattr(_server, "_qg_display_any_hook", False):
    _server.add_on_prompt_handler(select_display_targets)
    _server._qg_display_any_hook = True

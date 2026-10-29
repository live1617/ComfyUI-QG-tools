# -*- coding: utf-8 -*-
"""QG Step Preview — turn sampler previews on for one workflow, not for the whole server.

Why this exists
---------------
``--preview-method`` is a **launch flag**: it applies to every workflow on the
server, forever. People who keep it at ``none`` (to save bandwidth, or because
previews slow down their sampler) have no way to peek at a single run without
restarting ComfyUI, and people who keep it at ``auto`` cannot switch it off for
the run where it hurts.

This node flips the switch **per prompt**. It is a marker plus two settings;
the actual work is done by ComfyUI itself.

How the switch is actually thrown
--------------------------------
Modern ComfyUI reads ``extra_data["preview_method"]`` at the top of
``PromptExecutor.execute_async``::

    set_preview_method(extra_data.get("preview_method"))

and ``set_preview_method(None)`` restores the launch default. So we only have
to rewrite ``extra_data`` while the prompt is still a JSON payload -- hence
``PromptServer.add_on_prompt_handler``, which runs before the job is queued and
is allowed to return a modified payload. No monkey patching, no global state
left behind, and the next prompt resets itself even if this node is deleted
from the graph.

Same for ``--preview-size``: ``latent_preview.MAX_PREVIEW_RESOLUTION`` is read
once at import time and then handed to the frontend with every preview frame,
so it is patched here and restored whenever a prompt has no Step Preview node.

Fallbacks
---------
Older ComfyUI builds have no ``preview_method`` in ``extra_data``. We detect
that by the presence of ``latent_preview.set_preview_method`` (introduced
together with the override) and, when it is missing, the node's own ``run``
sets ``args.preview_method`` directly instead. That path can only affect
samplers that execute after this node -- less precise, still better than
nothing, and it never runs on builds where the clean path works.
"""

from __future__ import annotations

from ._qg_combo_legacy import coerce, combo_legacy

NODE_ID = "QG_StepPreview"

# 值就是 CLI 的 --preview-method 取值，一个不能改：它会被原样交给
# LatentPreviewMethod.from_string()，拼错一个字母就静默不生效。
METHODS = ["auto", "latent2rgb", "taesd", "none"]

_HANDLER_INSTALLED = False
_last_logged = None


# ---------------------------------------------------------------- 能力探测
def _latent_preview():
    """ComfyUI 根目录下的 latent_preview 模块；拿不到就返回 None。"""
    try:
        import latent_preview  # noqa: PLC0415  (根目录模块，只能运行时导入)
        return latent_preview
    except Exception:
        return None


def _has_extra_data_override():
    """当前版本是否支持 extra_data["preview_method"]。

    判据是 set_preview_method() 这个函数：它和 override 机制是同一次改动引入的。
    只看 attributes 比 inspect 源码便宜得多，也不会因为函数体重构而误判。
    """
    lp = _latent_preview()
    return callable(getattr(lp, "set_preview_method", None)) if lp else False


_HAS_OVERRIDE = _has_extra_data_override()
_ORIG_PREVIEW_SIZE = getattr(_latent_preview(), "MAX_PREVIEW_RESOLUTION", None) if _HAS_OVERRIDE else None


# ---------------------------------------------------------------- 预览尺寸
def _apply_preview_size(value):
    """把预览最大边长写进 latent_preview 的模块常量。

    这个值在 decode_latent_to_preview_image() 返回值里跟着每一帧发给前端，
    所以只要在采样开始前改掉就生效。
    """
    lp = _latent_preview()
    if lp is None:
        return
    try:
        size = int(value)
    except (TypeError, ValueError):
        return
    if size > 0:
        lp.MAX_PREVIEW_RESOLUTION = size


def _restore_preview_size():
    """恢复启动时的 --preview-size，避免上一个工作流的设置泄漏到下一个。"""
    lp = _latent_preview()
    if lp is None or _ORIG_PREVIEW_SIZE is None:
        return
    lp.MAX_PREVIEW_RESOLUTION = _ORIG_PREVIEW_SIZE


# ---------------------------------------------------------------- 兜底路径
def _set_global_method(method):
    """老版本 ComfyUI 的写法：直接改全局，影响之后执行的采样器。"""
    try:
        from comfy import cli_args  # noqa: PLC0415
        from comfy.cli_args import LatentPreviewMethod  # noqa: PLC0415

        parsed = LatentPreviewMethod.from_string(method)
        if parsed is not None:
            cli_args.args.preview_method = parsed
    except Exception:
        pass


# ---------------------------------------------------------------- prompt 钩子
def _find_step_preview(prompt):
    """在工作流里找一个 Step Preview 节点，返回它的 inputs（找不到返回 None）。

    多个节点时取 id 最小的那个，保证同样的图每次行为一致 —— 随便取会让
    「同一份工作流两次跑出不同预览方式」这种问题极难复现。
    """
    best = None
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != NODE_ID:
            continue
        if best is None or str(node_id) < str(best):
            best = node_id
    if best is None:
        return None
    inputs = prompt[best].get("inputs")
    return inputs if isinstance(inputs, dict) else {}


def _prompt_handler(json_data):
    """每个 prompt 提交时执行：把本节点的设置写进 extra_data。"""
    global _last_logged

    if not isinstance(json_data, dict):
        return json_data
    prompt = json_data.get("prompt")
    if not isinstance(prompt, dict):
        return json_data

    inputs = _find_step_preview(prompt)
    if inputs is None:
        # 没有本节点：尺寸还原，method 交给 ComfyUI 自己重置
        _restore_preview_size()
        return json_data

    method = coerce(NODE_ID, "method", inputs.get("method", "auto"))
    if method not in METHODS:
        method = "auto"

    try:
        extra = json_data.setdefault("extra_data", {})
    except Exception:
        return json_data
    if not isinstance(extra, dict):
        return json_data

    extra["preview_method"] = method
    _apply_preview_size(inputs.get("max_size"))

    if method != _last_logged:
        # ASCII only: Windows 控制台可能是 cp1252，中文会把整行打成乱码
        print("[QG-tools] Step Preview: sampler previews -> %s." % method)
        _last_logged = method
    return json_data


def install_handler():
    """把钩子挂到 PromptServer 上；幂等，重复调用只挂一次。"""
    global _HANDLER_INSTALLED
    if _HANDLER_INSTALLED:
        return True
    try:
        from server import PromptServer  # noqa: PLC0415

        instance = getattr(PromptServer, "instance", None)
        if instance is None:
            return False
        instance.add_on_prompt_handler(_prompt_handler)
        _HANDLER_INSTALLED = True
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- 节点
@combo_legacy("QG_StepPreview")
class QGStepPreview:
    """Per-workflow sampler previews."""

    CATEGORY = "QG-tools/Workflow"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Turns sampler previews on for this one workflow, without touching the "
        "launch flags and without affecting other workflows on the server. Drop "
        "it anywhere on the canvas -- no wiring needed. Three modes: auto and "
        "latent2rgb map the latent straight to RGB without loading a model; "
        "taesd decodes with TAESD for a near-real picture (it needs the taesd "
        "models in vae_approx); none also switches off previews that the server "
        "enabled globally. The frames come from ComfyUI's own samplers, and the "
        "setting resets when the run finishes. Hide sampler thumbnail keeps the "
        "frames off the sampler node so they only show up here -- a display "
        "setting, it saves no server work."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # 模块加载与重新解析节点定义时都会走到这里，此时 PromptServer 必然已存在，
        # 是补挂钩子的最后一道保险。
        install_handler()
        return {
            "required": {
                "method": (
                    METHODS,
                    {
                        "default": "auto",
                        "tooltip": (
                            "How preview frames are decoded.\n"
                            "auto / latent2rgb: map the latent straight to RGB, "
                            "no model is loaded, cheapest.\n"
                            "taesd: decode with TAESD for a near-real picture; "
                            "needs the taesd models in vae_approx.\n"
                            "none: also switch off previews that the server had "
                            "enabled globally."
                        ),
                    },
                ),
                "max_size": (
                    "INT",
                    {
                        "default": 512,
                        "min": 64,
                        "max": 2048,
                        "step": 64,
                        "tooltip": (
                            "Longest edge of the preview image, in pixels. Smaller "
                            "sends far less data, which helps a lot over a slow "
                            "connection. Previews only -- the saved image is "
                            "untouched."
                        ),
                    },
                ),
                "hide_sampler": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": (
                            "Hide the same frames on the sampler node and keep them "
                            "here only. Front-end setting, nothing is sent to the "
                            "server; the preview still runs, so the cost is the same."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "apply"

    @classmethod
    def VALIDATE_INPUTS(cls, method=None, max_size=None, hide_sampler=None):
        # 老工作流里可能存着中文选项值（"自动" 这类），按下标校验会直接
        # 报 Value not in list。具名列出 → 跳过列表校验，真正的换值在
        # combo_legacy 里做；max_size 的数值范围校验不受影响。
        return True

    def apply(self, method, max_size, hide_sampler=True):
        # hide_sampler 只是给前端看的（缩略图藏不藏由浏览器决定），
        # 后端不碰它；写进签名是为了让 FUNCTION 能收到全部入参。
        # 正常路径下 extra_data 已经生效，这里什么都不用做；
        # 只有在老版本 ComfyUI（或钩子没挂上）时才直接改全局兜底。
        if not (_HANDLER_INSTALLED and _HAS_OVERRIDE):
            if not install_handler():
                _set_global_method(method)
        return {}


# PromptServer 在 init_extra_nodes() 之前就已创建，所以这里通常一次就挂上。
install_handler()

# 🔴 映射表的键必须写字面量，不能写成 {NODE_ID: QGStepPreview}。
# tools/verify_combo_i18n.py 用 AST 按「常量键 → 类名」建索引，键是变量就
# 认不出这个类，装饰器和 VALIDATE_INPUTS 会被当成「没挂」，静态校验直接红。
NODE_CLASS_MAPPINGS = {"QG_StepPreview": QGStepPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_StepPreview": "Step Preview"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

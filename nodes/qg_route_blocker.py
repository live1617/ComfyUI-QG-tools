# -*- coding: utf-8 -*-
"""QG 路由阻断 — a switch that sits on a wire and can stop the current behind it.

Written for ComfyUI-QG-tools on 2026-10-30, replacing the GoohaiTools port
that shipped in v0.8.0. The node id, socket names, option values and the three
outcomes are unchanged, so a saved workflow opens and runs exactly as before.

Three outcomes, one switch
--------------------------
    any ──► [route blocker] ──► any

- **pass** (switch off): the value moves through; the node is a piece of wire.
- **empty**: the output becomes None and downstream still runs, leaving the
  empty value for it to deal with. Right when the rest of the graph should
  finish anyway, just without this one contribution.
- **cut**: the output becomes ComfyUI's own ExecutionBlocker, so everything
  behind this node is skipped silently - the same as muting that one wire by
  hand, with the other branches left alone.

What the rewrite changed
------------------------
The port evaluated ``any`` before deciding anything, so a blocked route still
built its entire upstream: the expensive sampler ran, produced a latent, and
was thrown away. Blocking is only worth having if the current stops *behind*
the switch, so ``any`` is lazy now and ``check_lazy_status`` asks for it only
when the switch is off. With the switch on, nothing upstream of this node is
queued at all.

That is also why ``any`` is read through a missing-value sentinel. With lazy
inputs ``None`` already means "connected, not evaluated yet", so it cannot
also mean "nothing is wired here". A socket that was never connected does not
arrive at all; telling the two apart is what stops an unwired node from
waiting forever on a value that does not exist.

Wiring notes
------------
``any`` is optional, which makes the node usable as a programmable mute: leave
the input empty, switch it on, cut mode, and the wire behind it goes quiet
without moving a single link.

``mode`` keeps its old Chinese values in ``_qg_combo_legacy.LEGACY``. The
option strings were rewritten to English in v0.8.0, so workflows saved before
that still hold the Chinese ones and need translating before they run.

Only core modules are used -- no new dependency.
"""

from ._qg_any_type import ANY
from ._qg_combo_legacy import combo_legacy

try:  # 旧版本 ComfyUI 没有这个模块；缺了就只有 empty 一种模式
    from comfy_execution.graph import ExecutionBlocker
except Exception:  # pragma: no cover
    ExecutionBlocker = None

MODE_NULL = "empty"
MODE_CUT = "cut"

# 没接线时参数就是这个对象；接上了但还没求值才是 None。
_MISSING = object()


@combo_legacy("QG_RouteBlocker")
class QGRouteBlocker:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "A switch for one wire. Off passes the value through untouched. On, "
        "empty replaces it with None and lets downstream run anyway, while cut "
        "emits ComfyUI's ExecutionBlocker so everything behind this node is "
        "skipped silently. The wire is lazy: while the switch is on, nothing "
        "upstream of this node is evaluated at all."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "block": ("BOOLEAN", {
                    "default": False,
                    "label_on": "阻断",
                    "label_off": "通过",
                    "tooltip": "Off passes the value straight through, as if this node were not on the wire; on "
                               "hands it to the mode below, and stops the upstream from being evaluated at all. "
                               "You can also wire in an upstream boolean and let the graph decide for itself.",
                }),
                "mode": ([MODE_NULL, MODE_CUT], {
                    "default": MODE_NULL,
                    "tooltip": "empty turns the value into None and passes it on, so downstream still runs and "
                               "handles the empty value itself. cut emits an execution-blocking signal and "
                               "the nodes behind it are skipped silently, the same as pressing Ctrl+M on this "
                               "wire, leaving other branches in the graph untouched.",
                }),
            },
            "optional": {
                # optional 不是「可以不填」，是「没接也能跑」：没接线时它根本不出现，
                # 阻断与否都能正常执行。lazy 才是省算力的那一半 —— 开关打开时
                # 上游整条链都不会被排进队列。
                "any": (ANY, {
                    "forceInput": True,
                    "lazy": True,
                    "tooltip": "The value to pass or to cut, of any type. Not evaluated while the switch is on, "
                               "so a blocked route costs nothing upstream.",
                }),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    OUTPUT_TOOLTIPS = (
        "The original value when it passes, an empty value or a blocking signal "
        "when it is cut. The type follows the input.",
    )
    FUNCTION = "execute"

    @classmethod
    def VALIDATE_INPUTS(cls, mode=None, input_types=None):
        # mode 具名列出 → ComfyUI 跳过「值必须在选项列表里」这道校验，老存档
        # 里的中文值才不会报 Value not in list；真正的换值在 combo_legacy 里做。
        # input_types 同理放行类型校验：输入声明成 ANY，前端按 * 校验，不放行
        # 的话接 IMAGE / 模型之类的端口会被判成类型不符。
        return True

    @classmethod
    def check_lazy_status(cls, block=False, mode=MODE_NULL, any=_MISSING):
        if block:
            # 开关打开：上游算出来也会被丢掉，一个字节都不该花。
            return None
        if any is _MISSING:
            # 压根没接线 —— 再索要就永远等不到，执行器会反复重调度。
            return None
        return ["any"] if any is None else None

    def execute(self, block=False, mode=MODE_NULL, any=_MISSING):
        if not block:
            return (None if any is _MISSING else any,)
        # 仅输出普通 None：下游继续执行，空值交给下游自己处理。
        if mode == MODE_CUT and ExecutionBlocker is not None:
            return (ExecutionBlocker(None),)
        return (None,)


NODE_CLASS_MAPPINGS = {"QG_RouteBlocker": QGRouteBlocker}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RouteBlocker": "Route Blocker"}

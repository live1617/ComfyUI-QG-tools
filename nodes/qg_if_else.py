# -*- coding: utf-8 -*-
"""QG 是否判断 — one condition, two routes, and only the taken one is built.

Written for ComfyUI-QG-tools on 2026-10-30, replacing the Easy-Use port that
shipped in v0.8.0. The node id, the socket names and the laziness are
unchanged, so a saved workflow opens and runs exactly as before.

Why laziness is the whole point
-------------------------------
ComfyUI builds a node's inputs before calling it, so a naive if/else would
build both sides and throw one away afterwards - worthless when the losing
side is a forty-step sampler or a loop that crashes on an empty latent. The
three-branch ``check_lazy_status`` below is what prevents that: the executor
asks which inputs it needs, gets exactly one name back, and never queues the
other side.

Missing versus pending
----------------------
``None`` already means "connected, not evaluated yet", so it cannot also mean
"nothing is wired here". The sentinel does: an unconnected socket arrives as
``_MISSING``, a connected-but-lazy one arrives as ``None``. Telling those two
apart is what lets one route stay empty - the node runs on whichever route
exists, and only consults the condition when both do. Core's own If/Else
Switch (``comfy_extras/nodes_logic.py``) reads its sockets the same way, so
the two nodes agree when a graph mixes them.

That also explains the one hard rule: both routes empty would make
``check_lazy_status`` ask for a socket that does not exist, and the executor
would reschedule the node forever. ``VALIDATE_INPUTS`` catches that before
any of it runs.

What this node is not
---------------------
It does not compare: QG_Math already evaluates expressions and already emits
a BOOLEAN, so ``a > b`` belongs there rather than in a second engine here.
It does not block either: QG_RouteBlocker turns one line off, this node picks
between two. Both on the same graph is normal.

Only the standard library is used -- no new dependency.
"""


from ._qg_any_type import ANY

# 没接线时参数就是这个对象；接上了但还没求值才是 None。两者必须分得开。
_MISSING = object()


class QGIfElse:
    @classmethod
    def INPUT_TYPES(cls):
        # 两路都是可选：只接一路也成立（那一路总是被选中），两路都接才看
        # 上面的开关。旧的搬运版把两路写成必填，少接一路在验证阶段就被拒。
        return {
            "required": {
                "boolean": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "The condition. True passes on_true through, false passes on_false. Only consulted when both routes are connected.",
                }),
            },
            "optional": {
                "on_true": (ANY, {
                    "lazy": True,
                    "tooltip": "Value passed through when the condition is true. Not evaluated otherwise. Leave it unconnected to always use on_false.",
                }),
                "on_false": (ANY, {
                    "lazy": True,
                    "tooltip": "Value passed through when the condition is false. Not evaluated otherwise. Leave it unconnected to always use on_true.",
                }),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    FUNCTION = "execute"
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Boolean if/else branch. Passes the on_true input through when the "
        "condition is true, otherwise the on_false input. The untaken route is "
        "lazy and never executed, so expensive or risky subtrees stay idle. "
        "Only one route has to be connected: with a single route wired, that "
        "route is used whatever the condition says, so a half-built graph "
        "still runs. With neither connected the node refuses to queue."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, boolean=False, on_true=_MISSING, on_false=_MISSING):
        # 必须在这里拦：两路全空时 check_lazy_status 会一直索要一个根本不存在
        # 的输入，执行器就把这个节点反复调度到超时。校验早于懒状态，所以拦得住。
        if on_true is _MISSING and on_false is _MISSING:
            # 详情里前面会挂上输入名（`boolean - ...`），所以句子本身要能独立读。
            return "是否判断：两路都没接，至少把「真时」或「假时」接上一个"
        return True

    @classmethod
    def check_lazy_status(cls, boolean=False, on_true=_MISSING, on_false=_MISSING):
        # 只接一路：只等那一路，条件不参与（它决定不了什么）。
        if on_true is _MISSING and on_false is _MISSING:
            return None  # 交给 execute 报人话错误，别在这里空等
        if on_false is _MISSING:
            return ["on_true"] if on_true is None else None
        if on_true is _MISSING:
            return ["on_false"] if on_false is None else None
        # 两路都接：只求值被选中的那一路。
        taken, name = (on_true, "on_true") if boolean else (on_false, "on_false")
        return [name] if taken is None else None

    def execute(self, boolean=False, on_true=_MISSING, on_false=_MISSING):
        if on_true is _MISSING and on_false is _MISSING:
            raise ValueError(
                "是否判断：两路都空着。至少把「真时」或「假时」接上一个 —— "
                "这个节点透传的就是这两路之一。"
            )
        if on_false is _MISSING:
            return (on_true,)
        if on_true is _MISSING:
            return (on_false,)
        return (on_true if boolean else on_false,)


NODE_CLASS_MAPPINGS = {"QG_IfElse": QGIfElse}

NODE_DISPLAY_NAME_MAPPINGS = {"QG_IfElse": "If / Else"}

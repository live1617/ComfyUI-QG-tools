# -*- coding: utf-8 -*-
"""ComfyUI 的「任意类型」（通配符）声明，外加几个判值的小工具。

为什么还要一个 str 子类
-----------------------
ComfyUI 认 ``"*"`` 这个类型名：前端允许 ``*`` 输入接任何来源的输出，后端
``comfy_execution.validation.validate_node_input`` 碰到 ``"*"`` 直接放行::

    if received_type == IO.AnyType.io_type or input_type == IO.AnyType.io_type:
        return True

那直接写字符串 ``"*"`` 就够了？对当前的核心版本确实够，但老核心没有那行
字符串比较，只认一条捷径（现在的源码里还留着说明）::

    # NOTE: this lets legacy '*' Any types work that override the __ne__
    # method of the str class.
    if not received_type != input_type:
        return True

也就是说：**``__ne__`` 返回 False 就当作接得上**。所以按老写法覆盖
``__eq__`` / ``__ne__``，新老核心都能接。

🔴 覆盖了 ``__eq__`` 就必须显式把 ``__hash__`` 还回来
----------------------------------------------------
Python 只要发现类里定义了 ``__eq__`` 又没定义 ``__hash__``，就把它置为
``None`` —— 实例**立即不可哈希**。原版（Goohaitools 的任意切换、各家插件的
同一段样板）都没写这一行，所以在任何 ``{类型: ...}`` / ``set([...])`` /
``functools.lru_cache`` 的键里都会 ``TypeError: unhashable type``。

当前核心恰好在所有地方都用元组和列表装 ``RETURN_TYPES``，所以这个雷一直没
炸；但它是「哪天核心把类型放进集合就整包崩」的那种隐患，顺手拆掉。

给 ``__hash__ = str.__hash__`` 之后 ``hash(ANY) == hash("*")`` 且
``ANY == "*"``，于是「``ANY``」和「字符串 ``"*"``」在字典里是同一个键 ——
这正是想要的：两者本来就是同一个类型名。

其余两个工具
------------
``is_blank`` 判「这一路有没有东西」，``family_of`` 判「这一路算什么类型」。
两者都不依赖上游的声明，只看拿到的值本身；跨节点比较时用得上，所以放在
这里而不是塞进某一个节点。
"""

from __future__ import annotations

import torch

try:  # 定义处。comfy_execution.graph 只是把它再导出一次。
    from comfy_execution.graph_utils import ExecutionBlocker
except Exception:  # 脱离 ComfyUI 单独跑单测时没有这个包
    ExecutionBlocker = None


class AnyType(str):
    """ComfyUI 的「任意类型」占位：与任何类型比较都相等，槽类型标 ``*``。"""

    def __ne__(self, value):
        return False

    def __eq__(self, value):
        return True

    # 🔴 有 __eq__ 就必须显式给 __hash__，否则实例不可哈希（见文件头）。
    __hash__ = str.__hash__

    def __str__(self):
        return "*"

    def __repr__(self):
        return "AnyType('*')"


ANY = AnyType("*")

# 核心用这两个字面量表示「类型未知」。校验和取值两边都要认。
WILDCARD_NAMES = frozenset({"*", "ANY", "COMFY_MATCHTYPE_V3"})


def is_blank(value):
    """这一路算不算「没有东西」。

    判的是**值**，不是「接没接线」：没接线的输入根本不会出现在节点函数的
    参数里，所以永远不会走到这里。这里只回答「接上了，但里面是空的」。

    0 和 False 不算空：它们是有意义的值，只是恰好等价于零。
    """
    if value is None:
        return True
    # 当前核心在调用节点函数**之前**就检查每个输入，见到 ExecutionBlocker 会
    # 整体跳过这个节点（execution.py 的 process_inputs），所以这里基本走不到。
    # 老版本没有那道检查，会把阻塞对象当普通值递进来；此时把它算空，后面几路
    # 才有机会顶上 —— 否则「这一路被跳过」会连带整条链断掉。
    if ExecutionBlocker is not None and isinstance(value, ExecutionBlocker):
        return True
    if isinstance(value, torch.Tensor):
        return value.numel() == 0
    if isinstance(value, str):
        return value == ""
    if isinstance(value, dict):
        if "samples" in value:
            samples = value.get("samples")
            return samples is None or (
                isinstance(samples, torch.Tensor) and samples.numel() == 0
            )
        return len(value) == 0
    if isinstance(value, (list, tuple, set, frozenset)):
        return len(value) == 0
    return False


def family_of(value):
    """把这个值归到一个「类型族」，两路只有族相同才算没混接。

    和 ``type(value).__name__`` 的差别只有两处，都是原版漏判的地方：

    * 张量按**维度**分族。四维是 ``[B,H,W,C]`` 的图像，五维常见于视频
      latent，三维常见于遮罩。四维的遮罩（``[B,C,H,W]``）和图像从张量
      本身分不开，所以同维度内不再细分 —— 猜不出来的就不硬猜。
    * 音频是 ``{"waveform": ..., "sample_rate": ...}`` 的字典，和潜空间的
      ``{"samples": ...}`` 分开。原版把两者都叫 ``dict``，混接时放行。
    """
    if isinstance(value, torch.Tensor):
        return "TENSOR%d" % value.ndim
    if isinstance(value, dict):
        if "samples" in value:
            return "LATENT"
        if "waveform" in value:
            return "AUDIO"
        return "dict"
    return type(value).__name__


__all__ = ["ANY", "AnyType", "WILDCARD_NAMES", "family_of", "is_blank"]

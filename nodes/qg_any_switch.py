# -*- coding: utf-8 -*-
"""QG Any Switch — 多路输入取第一个非空值，把「有哪个用哪个」写在一张图上。

为什么自己写
------------
原版是 Goohaitools-comfyui 的「任意切换 GH」（GPL-3.0，作者孤海）。它要解决的
问题很实在：同一张图里「高分辨率模型有就用它，没有就用普通的」这种回退，用
原生节点搭不出来。2026-10-30 重写成自己的实现，坑位记在下面。

和原版**一样**的部分（老图不受影响）
------------------------------------
* ID ``QG_AnySwitch``、槽名 ``any_01``…``any_16``、输出名 ``any``、
  分类 ``QG-tools/Logic``、``*`` 通配类型。
* 按槽号排序取第一个非空值；两路类型不同就报错，全空也报错。
* 靠**数字后缀**还原槽号，不靠槽名。前端会把槽名改成 ``图像_1`` 这样的可读
  文字，若按名字认槽，优先级会乱、已连的线还会消失。

改掉的部分
----------
1. **报错说清是哪一路。** 原版只列类型（``IMAGE, LATENT``），接到第几路要靠
   数。现在写 ``any_02 是 LATENT``。
2. **「没接线」和「接了但都是空值」分开报。** 原版两种情况都是「所有输入均为
   空」，可它们的修法完全不同：前者去接线，后者去查上游为什么吐了空值。
3. **音频与普通字典分开算类型。** 原版把 ``{"waveform": …}`` 和任意字典都叫
   ``dict``，一个音频接一路杂字典会被放行。
4. **张量按维度报类型。** 原版四维以上一律叫 ``IMAGE``，五维视频 latent 也是
   —— 名字错了，混接时的提示也跟着错。
5. ``ExecutionBlocker`` 改从 ``comfy_execution.graph_utils`` 导入（定义处；
   ``comfy_execution.graph`` 只是转手再导出一次）。

故意不做的事
------------
**不做懒执行。** 「回退」听起来该像 ``If / Else`` 那样只跑用得到的那一路，
但这个节点判空靠的是**值**，而值必须先算出来才拿得到 —— 让输入变懒，就得在
``check_lazy_status`` 里逐路索要、拿到、判空、再要下一路，把「一次执行」变成
「多次重调度」。真要省掉整条分支的计算，``If / Else`` 已经干得更好（它按开关
选路，不需要先算一遍）。这里保持全求值，行为与原版一致。

Only ``torch`` is used, which ships with ComfyUI -- no new dependency.
"""

from __future__ import annotations

import re

from ._qg_any_type import ANY, family_of, is_blank

# 上限写在这里，前端 web/any_switch/index.js 有同样一个数。改的话两边一起改：
# 后端的槽名决定了存档里的键，前端只决定画几个槽。
MAX_INPUTS = 16
SLOT_PREFIX = "any_"

# 只认结尾的数字，``any_01`` 和 ``图像_1`` 都还原成 1。
_SLOT_SUFFIX = re.compile(r"(\d+)\s*$")


def slot_order(values):
    """把传进来的输入按槽号排好，返回 ``[(槽名, 值), …]``。

    ComfyUI 只传 prompt 里真有的输入，所以这里出现的每一条都是接了线的。
    """
    by_index = {}
    for key, value in values.items():
        match = _SLOT_SUFFIX.search(str(key))
        if match is None:
            continue
        index = int(match.group(1))
        if 1 <= index <= MAX_INPUTS:
            by_index.setdefault(index, value)
    return [("%s%02d" % (SLOT_PREFIX, index), by_index[index]) for index in sorted(by_index)]


class QGAnySwitch:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Merge several inputs of one type into one: the first connected input "
        "that actually carries something is passed through, so a high-res "
        "model when one is wired and the normal model otherwise. Inputs that "
        "are connected but empty (no image, an empty prompt, an empty latent) "
        "are skipped rather than passed on. Two different types in one node "
        "is an error, named by slot, and so is a node where every input is "
        "empty. Slots grow as you connect them."
    )
    SEARCH_ALIASES = [
        "switch", "any", "any switch", "fallback", "first non-empty",
        "merge inputs", "passthrough", "wildcard", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        # 全部可选：一个都不接也能存盘，只是排不进队列（VALIDATE 拦的是
        # 执行期；这里不拦是为了让「先摆节点再连线」的搭图顺序不被卡）。
        return {
            "optional": {
                "%s%02d" % (SLOT_PREFIX, index): (ANY, {
                    "tooltip": (
                        "One of the inputs to pick from. The earliest connected "
                        "slot that is not empty wins; later slots are only used "
                        "when everything before them is empty. All slots that "
                        "carry something must be the same type."
                    ),
                })
                for index in range(1, MAX_INPUTS + 1)
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    OUTPUT_TOOLTIPS = (
        "The first connected input that is not empty, unchanged.",
    )
    FUNCTION = "switch"

    @classmethod
    def VALIDATE_INPUTS(cls, input_types=None):
        """让 ``*`` 输入跳过类型校验 —— 官方文档给的通配符写法。

        参数名必须**恰好**叫 ``input_types``：核心看到这个名字会做两件事，
        一是跳过 ``validate_node_input`` 的声明类型比对（见 ``execution.py``
        里 ``if 'input_types' not in validate_function_inputs and …``），
        二是把已连线输入的上游声明类型塞进来。

        这里拿到声明类型却不用，是有意的：声明不代表实际值。自定义节点声明
        ``IMAGE`` 却返回字典的并不少见，据此在排队阶段拦下来，会把本来能跑的
        图挡在门外。真正的判断放在 ``switch`` 里，按值来 —— 那时出错也只是
        这一张图报错，不会误伤别人。
        """
        return True

    def switch(self, **values):
        slots = slot_order(values)

        if not slots:
            # 一个 any_NN 都没出现。可能是真没接线，也可能是 API 图把键名写错了
            # （比如写成 any_1x / input_01），两种情况都得说清。
            if values:
                names = ", ".join(sorted(str(key) for key in values))
                raise RuntimeError(
                    "QG 任意切换：收到了输入（%s），但名字对不上任何一路槽"
                    "（要 any_01 到 any_%02d）。检查 API 图里的键名。"
                    % (names, MAX_INPUTS)
                )
            raise RuntimeError(
                "QG 任意切换：一路输入都没接。至少接一路，节点才知道要输出什么。"
            )

        carriers = [(name, value) for name, value in slots if not is_blank(value)]

        # 类型一致性只比「有内容」的那几路：空的那几路本来就不会被选中，它们
        # 是什么类型都不影响结果。这一点与原版相同，别改成把空值也算进来。
        families = {name: family_of(value) for name, value in carriers}
        if len(set(families.values())) > 1:
            listed = "，".join("%s 是 %s" % (name, family) for name, family in families.items())
            raise RuntimeError(
                "QG 任意切换：接进来的输入类型不一致（%s）。这个节点只做同类型的"
                "合并与回退，混接会把它原样交给下游，下游只会报更难懂的错误。"
                % listed
            )

        if carriers:
            return (carriers[0][1],)

        # 都接了线，但值全是空的。和「没接线」区别对待：这里上游跑过了。
        names = "、".join(name for name, _value in slots)
        raise RuntimeError(
            "QG 任意切换：接了 %d 路（%s），但每一路的值都是空的（None／空文本／"
            "空列表／0 元素的张量），没有可输出的内容。检查上游是不是真的产出了"
            "数据，或者在这些路都为空时接一路兜底。"
            % (len(slots), names)
        )


NODE_CLASS_MAPPINGS = {"QG_AnySwitch": QGAnySwitch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_AnySwitch": "Any Switch"}

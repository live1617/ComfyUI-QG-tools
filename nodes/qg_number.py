# -*- coding: utf-8 -*-
import math

from comfy_api.latest import io

from ._qg_combo_legacy import coerce
from ._qg_math_engine import round_half_away
"""QG 数值 — 一个数字，可以当整数用，也可以当浮点数用。

ComfyUI 自带的 primitive 把字符串、整数、浮点塞在同一个节点里；这里的取舍是
反过来的：一个节点只放**一个数字**。界面上就是一张卡片里的一行：左边小字
「值」，右边一个可拖、可点、可滚的数字框；类型（整数 / 浮点）走标题栏 `?` 左边
那枚齿轮的菜单，不占卡片的位置。

后端仍然留两个控件（`kind` + `value`）：前端把两个都藏起来，但 `widgets_values`
的顺位不变，存档、撤销、API 导出都跟普通数字节点一致。

为什么输出类型写 ``*``：类型是运行时选的，而 ``RETURN_TYPES`` 是类级静态声明，
改不了。``*`` 在 ComfyUI 里是「任意类型」，接 INT 或 FLOAT 输入都能过校验；
真正的类型由 ``execute`` 的返回值决定（整数就回 int，浮点就回 float）。
前端 ``web/number/index.js`` 只负责把输出槽的**显示**类型跟着类型改，方便一眼
看出来当前给的是整数还是小数。

只用核心模块，没有新依赖。
"""

KIND_INT = "integer"
KIND_FLOAT = "float"
KINDS = [KIND_INT, KIND_FLOAT]

INT32_MIN = -2147483648
INT32_MAX = 2147483647


class QGNumber(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_Number",
            display_name="Number",
            category="QG-tools/Logic",
            description=(
                "One number, either an integer or a decimal. The card shows a label "
                "and a number box you can drag, click and type in; the gear in the "
                "title bar (left of the ?) switches between integer and decimal. The "
                "output type follows that choice, so it can feed either an INT input "
                "or a FLOAT input."
            ),
            inputs=[
                io.Combo.Input(
                    "kind", options=list(KINDS), default=KIND_INT,
                    tooltip="Whether this number is an integer or a decimal. Switch it in the gear left of the ? in the title bar; in integer mode the decimals are rounded away.",
                ),
                # 存小数：整数模式只是显示 / 输出时取整，控件本身始终是 FLOAT，
                # 这样从整数切回浮点不用换控件，存档结构也不会变。
                # 🔴 step 必须和浮点模式的小数位对齐（0.01 ↔ 两位）：
                #    前端 RULES 会按这一格取整，写成 0.1 的话输入 1.25 会被吃成 1.3。
                io.Float.Input(
                    "value", default=0.0, min=-1e12, max=1e12, step=0.01,
                    tooltip="The value. Drag sideways to scrub, click to type, and use the arrows to step (hold Shift for fine steps); integer mode steps by 1.",
                ),
            ],
            outputs=[
                # V1 的 RETURN_TYPES 写的是 "*"（任意类型），V3 对应 io.AnyType，
                # 序列化回 "*" 与老图纸的连线契约一致。不要换成 io.Custom("…")。
                io.AnyType.Output(
                    id="value",
                    tooltip="The number on the card: an integer in integer mode, a decimal otherwise.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, kind=None):
        # 老工作流里存的还是中文选项值（"整数"/"浮点数"），按选项列表校验会直接
        # 报 Value not in list。具名列出 kind → ComfyUI 跳过它在
        # execution.validate_inputs 里的列表校验（`x not in validate_function_inputs`
        # 这一层），真正的换值在 execute 开头的 coerce() 里做，数字的
        # min/max 校验不受影响（value 不在具名参数里）。
        return True

    @classmethod
    def execute(cls, kind=KIND_INT, value=0.0):
        # 🔴 V3 不能再套 @combo_legacy 装饰器：它按 cls.FUNCTION 找方法，而 V3 的
        # FUNCTION 是基类给的 'EXECUTE_NORMALIZED'，会包错入口。执行期兜底直接调
        # coerce()，语义与 V1 的装饰器一致（不经过前端的 API / 脚本调用也能换值）。
        kind = coerce("QG_Number", "kind", kind)
        # 上游接进来的可能是 numpy 数字，先统一成 Python float 再分流。
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = 0.0
        if kind == KIND_FLOAT:
            return io.NodeOutput(number)
        # 整数模式：四舍五入后夹到 INT32，免得下游拿到 1e12 这种非法值。
        # 用 round_half_away 而不是内置 round()：后者是银行家舍入（2.5 → 2），
        # 而卡片上显示的是前端 Math.round（2.5 → 3）—— 同一个值，卡片说 3、
        # 输出是 2。本包其它地方（数学节点的整数槽、滑块）都走同一条。
        if not math.isfinite(number):
            # NaN 归零；±inf 夹到 INT32 的边，符合「夹到 INT32」这个语义。
            number = 0.0 if number != number else math.copysign(float(INT32_MAX), number)
        return io.NodeOutput(round_half_away(max(INT32_MIN, min(INT32_MAX, number))))


NODE_CLASS_MAPPINGS = {"QG_Number": QGNumber}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Number": "Number"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

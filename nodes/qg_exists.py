# -*- coding: utf-8 -*-
"""QG 存在判断 —— pass any value through, and say whether it arrived.

The pack can already branch (``QG_IfElse``) and pick a string
(``QG_StringSwitch``), but nothing answers the plain question "did anything
come through?" before a branch is taken. This node answers it and keeps the
value moving:

    any ──┬──────────────────────── any      (原样输出)
          └── exists = 有值 ? True : False

Both outputs are meant to be used together: wire ``exists`` into a condition
and ``any`` into the branch that follows, so an unconnected or empty upstream
shows up as a decision instead of an exception.

The input is **optional on purpose** — that is what makes "no data"
expressible. A required input would make ComfyUI refuse to run the node at
all, so it could never report False.

判定口径与孤海工具箱的「万能是否存在(GH)」基本一致：遮罩全黑（含肉眼看不出的低值
残差）和潜空间全零都算「没有」，图像全黑仍然算「有」。两处刻意不同：潜空间也按
0.02 算空（那份用严格等于 0），且空值**如实输出 None**，不像那份会造 64×64 黑图之类
的占位假数据、也不改写透传的遮罩。torch 是 ComfyUI 的硬依赖，不算新增。

输入口的「任意」标签由 web/exists/index.js 按上游真实类型改写，**只改 label**，
插槽类型始终是 `*`，存档里不写这个标签。
"""

import torch

from comfy_api.latest import io

from ._qg_any_type import ANY

try:  # 旧版本 ComfyUI 没有这个模块，缺了也不影响判定
    from comfy_execution.graph import ExecutionBlocker
except Exception:  # pragma: no cover
    ExecutionBlocker = ()

# 遮罩上低于这个值的像素肉眼看不出来，当作噪声抹平再判空。孤海那份节点用的也是
# 0.02 —— Qwen Image 2.1 的 RGBA 存盘再读回来会带 1/255 ~ 3/255 的残差。
MASK_VISIBLE_THRESHOLD = 0.02


def _is_black(tensor):
    """整片全黑 —— 连 0.02 以内、肉眼看不出的残差也算进去。

    0 元素张量在这里返回 False（「不黑」＝算有），和孤海那份节点口径一致：
    真实节点不会吐出空张量，真出现了多半是上游的 bug，报「有」比悄悄吞掉好。
    """
    try:
        if tensor.numel() == 0:
            return False
        return float(tensor.max().item()) <= MASK_VISIBLE_THRESHOLD
    except Exception:
        return False


def _present(value):
    """这个值算不算「有东西」。

    只判 None 远远不够，四类要分别看：

    - **空文本 / 空容器**：文本节点能吐出 `""`、列表节点能吐出 `[]`，在用户眼里
      同样是「没有数据」
    - **遮罩全黑**：`(H,W)` 或 `(B,H,W)` 的张量整片是 0，就是一张空遮罩 —— 上游
      确实传了东西过来，但画面里什么都没有，下游拿它去合成只会得到原图
    - **潜空间全零**：`{"samples": 全 0}` 同理，解出来是纯噪声级别的空
    - **图像全黑**：`(B,H,W,C)` 就算是全黑也算**有** —— 那是一张有效的黑图，不是缺席

    **`0` 和 `False` 算有** —— 它们是有效数据，不是缺席。
    """
    if value is None:
        return False
    if ExecutionBlocker and isinstance(value, ExecutionBlocker):
        return False
    if torch.is_tensor(value):
        # IMAGE 是 (B,H,W,C)；MASK 是 (B,H,W) 或 (H,W)；其余维度按「有」处理
        if value.ndim >= 4 and value.shape[-1] in (1, 3, 4):
            return True
        if value.ndim in (2, 3):
            return not _is_black(value)
        return True
    if isinstance(value, dict):
        samples = value.get("samples")
        if torch.is_tensor(samples):
            return not _is_black(samples)
        return len(value) > 0
    if isinstance(value, (str, bytes, list, tuple, set, frozenset)):
        return len(value) > 0
    return True


class QGExists(io.ComfyNode):
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Says whether anything came through, and passes it along untouched. "
        "The input is optional, so leaving it unwired is what makes the answer "
        "False; an upstream that produces nothing (None, empty text, empty "
        "list, an all-black mask, an all-zero latent) counts as nothing too. "
        "A fully black image still counts as something -- it is a valid image. "
        "Wire boolean into a condition and any into the branch that follows, and "
        "a missing optional value turns into a decision instead of an error."
    )

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_Exists",
            display_name="Exists",
            category="QG-tools/Logic",
            description=cls.DESCRIPTION,
            inputs=[
                # 唯一输入，什么都能接。optional 是这套逻辑的前提：required
                # 的话 ComfyUI 会在执行前就报「缺少输入」，永远看不到 False。
                # V1 的 forceInput → V3 AnyType 无 force_input 形参，走 extra_dict。
                io.AnyType.Input(
                    "any_input",
                    optional=True,
                    extra_dict={"forceInput": True},
                    tooltip="Any input. When it is wired and actually delivers a value, the boolean output is true; unwired, or when upstream hands over an empty value, it is false (empty text, empty list, all-black mask and all-zero latent all count as empty). A fully black image is not empty - it is a valid picture. The value itself is passed on through the any output.",
                ),
            ],
            outputs=[
                io.AnyType.Output("any", tooltip="The value passed through unchanged (empty when nothing is connected)."),
                # 一条 tooltip 对应一个输出槽：any 与 boolean 各有各的说明。
                io.Boolean.Output(
                    "boolean",
                    tooltip="A value means true, nothing means false. Empty text, an empty list, an "
                            "all-black mask and an all-zero latent all count as nothing; 0 and "
                            "False count as something. Drives a branch, a switch, or any boolean "
                            "input.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, input_types=None):
        # 输入声明成 ANY，前端按 * 校验；这里放行一切具体类型，否则接 IMAGE /
        # 模型之类的端口会被后端判成类型不符。
        return True

    @classmethod
    def execute(cls, any_input=None):
        return io.NodeOutput(any_input, _present(any_input))


NODE_CLASS_MAPPINGS = {"QG_Exists": QGExists}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Exists": "Exists"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

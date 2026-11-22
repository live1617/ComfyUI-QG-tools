# -*- coding: utf-8 -*-
"""QG_BatchCount —— 批次计数：数出接进来的批次有多少个。

自写节点，功能形态参考用户给的 essentials「批次计数」截图（一个任意类型输入 → 整数）。
代码自己实现，没有搬上游实现。计数口径：
  - 张量 / 带 shape 的对象：shape[0]
  - LATENT 字典 {'samples': tensor}：samples.shape[0]
  - list / tuple / dict / str：len
  - 其它 / 未接线：0
"""

from comfy_api.latest import io


class QGBatchCount(io.ComfyNode):
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Count the number of items in a batch: shape[0] for tensors and images, "
        "samples.shape[0] for a LATENT, len() for lists, tuples, dicts and strings. "
        "Returns 0 when nothing is connected."
    )
    SEARCH_ALIASES = [
        "batch count", "batchcount", "count batch", "batch size", "frame count",
        "批次计数", "批次数量", "批次", "数批次", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_BatchCount",
            display_name="Batch Count",
            category="QG-tools/Logic",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                # 任意类型：IMAGE / LATENT / list / dict 都能接。
                io.AnyType.Input(
                    "batch",
                    optional=True,
                    extra_dict={"forceInput": True},
                    tooltip="Any batch: an IMAGE or tensor, a LATENT dict, or a list/tuple/dict/string. Leave unconnected to get 0.",
                ),
            ],
            outputs=[
                # 显式 id，存档键固定为 INT。
                io.Int.Output(
                    "INT",
                    tooltip="Number of items in the batch; 0 when unconnected or of an unsupported type.",
                ),
            ],
        )

    @classmethod
    def execute(cls, batch=None):
        if batch is None:
            return io.NodeOutput(0)

        if isinstance(batch, dict) and "samples" in batch:
            samples = batch["samples"]
            shape = getattr(samples, "shape", None)
            count = int(shape[0]) if shape is not None and len(shape) else 0
        else:
            shape = getattr(batch, "shape", None)
            if shape is not None:
                count = int(shape[0]) if len(shape) else 0
            elif isinstance(batch, (list, dict, tuple, str)):
                count = len(batch)
            else:
                count = 0

        return io.NodeOutput(max(0, count))


NODE_CLASS_MAPPINGS = {"QG_BatchCount": QGBatchCount}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BatchCount": "Batch Count"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

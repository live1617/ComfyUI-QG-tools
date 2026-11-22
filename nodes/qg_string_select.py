# -*- coding: utf-8 -*-
"""QG_StringSelect —— 字符串选择：从一段文本里挑出第 N 行（或第 N 段）。

自写节点，功能形态参考 Impact Pack 的 String Selector 截图（用户给图，要求自己写一个）：
文本框里按行放候选；「多行」关闭时一行算一个候选，开启时以 # 开头的行作为新段落的
起点、一段可以跨多行。选择序号从 0 起，越界按取模回绕，不会抛异常。
代码是自己写的，没有搬上游实现。
"""

from comfy_api.latest import io


class QGStringSelect(io.ComfyNode):
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Pick the Nth line (or the Nth #-delimited block) from a multiline text. "
        "Turn multiline on to group lines into blocks; the index wraps around."
    )
    SEARCH_ALIASES = [
        "string select", "string selector", "select string", "pick line", "line picker",
        "字符串选择", "字符串选择器", "选字符串", "取第几行", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_StringSelect",
            display_name="String Select",
            category="QG-tools/Text",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "strings",
                    default="",
                    multiline=True,
                    tooltip="Multiline text. Each line is one candidate; with multiline on, lines starting with # delimit blocks.",
                ),
                io.Boolean.Input(
                    "multiline",
                    default=False,
                    label_on="enabled",
                    label_off="disabled",
                    tooltip="Off: one line per candidate. On: lines starting with # start a new block, so a candidate can span lines.",
                ),
                io.Int.Input(
                    "select",
                    default=0,
                    min=0,
                    max=0x7FFFFFFFFFFFFFFF,
                    step=1,
                    tooltip="Zero-based index of the candidate to output. Wraps around when out of range.",
                ),
            ],
            outputs=[
                # 显式 id：存档键固定为 STRING，避免 V3 回落。
                io.String.Output(
                    "STRING",
                    tooltip="The selected line or block.",
                ),
            ],
        )

    @classmethod
    def execute(cls, strings="", multiline=False, select=0):
        text = strings if isinstance(strings, str) else str(strings or "")
        # 归一化换行：Windows 文本常带 \r\n，若只按 \n 切分会在行尾留下 \r，
        # 污染候选值（喂给 CLIP 时会带隐藏字符）。先统一成 \n 再切。
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        lines = text.split("\n")

        if multiline:
            blocks = []
            current = []
            for line in lines:
                if line.startswith("#") and any(x.strip() for x in current):
                    blocks.append("\n".join(current).strip())
                    current = []
                current.append(line)
            if any(x.strip() for x in current):
                blocks.append("\n".join(current).strip())
            candidates = blocks if blocks else [text]
        else:
            candidates = lines if lines else [text]

        index = int(select) % len(candidates)
        picked = candidates[index]
        if multiline and picked.startswith("#"):
            # 块标记 '# ' 后的空白属于排版，不该带进结果：
            # '# 标题2' -> '标题2'（而不是 ' 标题2'）；'#标题' 也正常去 '#'。
            picked = picked[1:].lstrip()
        return io.NodeOutput(picked)


NODE_CLASS_MAPPINGS = {"QG_StringSelect": QGStringSelect}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_StringSelect": "String Select"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

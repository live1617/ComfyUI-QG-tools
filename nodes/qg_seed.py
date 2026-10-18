# -*- coding: utf-8 -*-
"""QG_Seed — 一个种子走一根 INT 线，并且记得自己真的跑过哪些种子。

界面与交互移植自 ComfyUI-AusBoss（MIT，nodes/node_seed.py + js/seed/index.js）：
卡片上的 big number + 「随机值 / 固定 / Step」分段 + 「新种子 / 用上次 / 历史」，
模式写进 ComfyUI 给 INT 自动附加的 control_after_generate 控件，卡的只是外观。

后端只做两件事：
  * 原样把种子往线上发；
  * 通过 ui.seed 回传「这一次真正用的值」——前端拿它记历史，因为随机值模式下
    框里显示的可能已经是下一枚种子了。

（v0.8.4 那版是 rgthree 的哨兵模型：-1/-2/-3 由前端包装 queuePrompt 改写。
新模型里种子永远是非负整数，老工作流里的哨兵值由前端在加载时翻译成「模式 +
具体种子」，所以这里不再有 IS_CHANGED 的随机兜底。）
"""

MAX_SEED = 0xFFFFFFFFFFFFFFFF


class QGSeed:
    CATEGORY = "QG-tools/逻辑"
    DESCRIPTION = (
        "One seed on its own INT wire, so several samplers share a number and a "
        "shared workflow can pin the exact seed that made its result. The card "
        "on the node shows the seed, a Random / Fixed / Step switch that decides "
        "what happens after each queue, and the seeds this node actually ran "
        "with. Because Random replaces the number the moment a run is queued, "
        "the node reports the seed it really used: the line under the box shows "
        "it, Use last puts it back into the box and pins it, and the history "
        "menu keeps the last few."
    )
    SEARCH_ALIASES = ["seed", "random seed", "last seed", "种子", "随机", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_SEED,
                        # ComfyUI 认这个键就会自动挂一个「生成后控制」控件；
                        # 前端把它藏起来，改由卡片上的「随机值 / 固定 / Step」驱动。
                        "control_after_generate": True,
                        "tooltip": (
                            "发给下游的种子。卡片上的「随机值 / 固定 / Step」"
                            "决定每次排队之后它怎么变：随机值重新抽一个、固定不动、"
                            "Step 每次 +1 或 -1。"
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    OUTPUT_TOOLTIPS = ("本次实际使用的种子值。",)
    FUNCTION = "emit"

    def emit(self, seed):
        # ui 回包就是前端的「上次运行」：这一次排队用的值，哪怕随机值模式
        # 已经把框里的数字换成下一枚了。
        return {"ui": {"seed": [seed]}, "result": (seed,)}


NODE_CLASS_MAPPINGS = {"QG_Seed": QGSeed}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Seed": "种子"}

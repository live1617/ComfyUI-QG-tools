# -*- coding: utf-8 -*-
"""QG_Seed — a seed control node with random / increment / decrement modes.

Ported from rgthree-comfy (py/seed.py, class RgthreeSeed), MIT licensed,
authored by rgthree. The three "magic" sentinels work like rgthree's:
  -1  random  (a new seed every queue)
  -2  increment
  -3  decrement
but the actual random value is generated on the FRONT end, right before the
workflow is queued (see web/seed/index.js). That keeps each queue's prompt
distinct, so ComfyUI's execution cache never serves a stale result.

This backend is the safe fallback for API users who pass the sentinel
directly: it still produces a real seed. IS_CHANGED returns a fresh random
value for any sentinel so the node is never cached. The metadata-saving dance
from rgthree (writing the generated seed back into the saved workflow / API
prompt) is intentionally dropped — it relied on rgthree's own workflow
structures and added a lot of code for little gain here.
"""

import random

SEED_MIN = -1125899906842624
SEED_MAX = 1125899906842624


class QGSeed:
    CATEGORY = "QG-tools/逻辑"
    DESCRIPTION = (
        "Seed control. 0 or any positive number is a fixed seed; -1 gives a new "
        "random seed on every queue, -2 increments, -3 decrements. The random "
        "value is generated on the front end per queue so repeated executions "
        "are never served from cache."
    )
    SEARCH_ALIASES = ["seed", "random", "种子", "随机", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": SEED_MIN,
                        "max": SEED_MAX,
                        "tooltip": (
                            "0 或正数 = 固定种子；-1 = 每次入队随机；"
                            "-2 = 每次入队递增；-3 = 每次入队递减。"
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    OUTPUT_TOOLTIPS = ("实际使用的种子值。",)
    FUNCTION = "main"

    @classmethod
    def IS_CHANGED(cls, seed=0):
        # A sentinel forces a non-cacheable, always-different result.
        if seed in (-1, -2, -3):
            return random.randint(1, SEED_MAX)
        return seed

    def main(self, seed=0):
        """Returns the seed; sentinels fall back to a server-generated value."""
        if seed in (-1, -2, -3):
            return (random.randint(1, SEED_MAX),)
        return (seed,)


NODE_CLASS_MAPPINGS = {"QG_Seed": QGSeed}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Seed": "QG 种子"}

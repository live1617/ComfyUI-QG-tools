# -*- coding: utf-8 -*-
"""QG Any Switch — dynamic multi-input switch (zero extra dependencies).

Ported from Goohaitools-comfyui (任意切换 GH), GPL-3.0. Original by 孤海 (Goohaitools).
The backend keeps Goohai's robust behaviour:
  * Picks the first non-empty input and outputs it.
  * Raises a clear error on mixed input types or when everything is empty
    (rather than silently passing None downstream and confusing later nodes).
  * Recovers the stable slot index from the numeric suffix, so ComfyUI's habit
    of renaming connected slots (e.g. "图像_1") never changes input priority
    or drops a connected value.
Only `torch` is used, which is part of ComfyUI core -- no new dependency.
"""

import re
import torch

try:
    from comfy_execution.graph import ExecutionBlocker
except Exception:  # 老版本 ComfyUI 没有这个类型
    ExecutionBlocker = ()


class AnyType(str):
    """ComfyUI 的「任意类型」占位：与任何类型比较都返回相等，槽类型标 * 即可。"""

    def __ne__(self, value):
        return False

    def __eq__(self, value):
        return True

    def __str__(self):
        return "*"


ANY = AnyType("*")
MAX_INPUTS = 16


class QGAnySwitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {f"any_{i:02d}": (ANY,) for i in range(1, MAX_INPUTS + 1)}}

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    FUNCTION = "switch"
    CATEGORY = "QG-tools/\u903b\u8f91"
    DESCRIPTION = (
        "Merge several inputs of the same type into one. The node outputs the "
        "first connected, non-empty value, so you can wire fallbacks (e.g. a "
        "high-res model when present, otherwise the normal one). All inputs must "
        "share the same type; mixed types or all-empty inputs raise an error."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    @staticmethod
    def _empty(v):
        if v is None or (ExecutionBlocker and isinstance(v, ExecutionBlocker)):
            return True
        if isinstance(v, dict) and "samples" in v:
            s = v.get("samples")
            return s is None or (torch.is_tensor(s) and s.numel() == 0)
        if isinstance(v, str):
            return v == ""
        if isinstance(v, (list, tuple, dict, set)):
            return len(v) == 0
        if torch.is_tensor(v):
            return v.numel() == 0
        return False

    def switch(self, **kwargs):
        # ComfyUI 可能把前端槽名（如 "图像_1"）代替原始 INPUT_TYPES 名（"any_01"）
        # 传进来。用数字后缀还原稳定的槽序号，避免连线优先级错乱或已连线值消失。
        indexed_values = {}
        for key, value in kwargs.items():
            match = re.search(r"(\d+)$", str(key))
            if not match:
                continue
            index = int(match.group(1))
            if 1 <= index <= MAX_INPUTS:
                indexed_values.setdefault(index, value)

        values = [indexed_values[index] for index in sorted(indexed_values)]

        types = []
        for v in values:
            if self._empty(v):
                continue
            if torch.is_tensor(v):
                types.append("IMAGE" if v.ndim >= 4 else "TENSOR")
            elif isinstance(v, dict) and "samples" in v:
                types.append("LATENT")
            else:
                types.append(type(v).__name__)
        if len(set(types)) > 1:
            raise RuntimeError("QG 任意切换：输入类型不一致：%s" % ", ".join(types))

        for v in values:
            if not self._empty(v):
                return (v,)
        raise RuntimeError("QG 任意切换：所有输入均为空，无法输出。")


NODE_CLASS_MAPPINGS = {"QG_AnySwitch": QGAnySwitch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_AnySwitch": "任意切换"}

# -*- coding: utf-8 -*-
"""
ComfyUI-QG-tools
----------------
从若干现有 ComfyUI 插件中抽取节点，整合成一个插件。

目录约定
    nodes/   每个源插件一个模块，各自导出 NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS
    web/     前端扩展（WEB_DIRECTORY）

本文件只做汇总，不写任何节点逻辑。新增节点 = 往 nodes/ 丢一个 .py，重启 ComfyUI 即可。
"""

import importlib
import importlib.util
import os
import sys
import traceback

__version__ = "0.8.3"

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_NODES_DIR = os.path.join(_PKG_DIR, "nodes")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 节点 ID 冲突时保留「先加载的」，并在控制台点名，避免静默覆盖
_DUPLICATES = []


def _import_node_module(modname):
    """优先用相对导入（ComfyUI 以「包」方式加载本插件）。

    注意：一定要用相对导入。写成 `import xxx` 会 ModuleNotFoundError，
    整个插件会静默 IMPORT FAILED。
    """
    pkg = __package__ or os.path.basename(_PKG_DIR)
    try:
        return importlib.import_module(".nodes." + modname, pkg)
    except ImportError:
        pass

    # 回退：非包方式加载时按文件路径直接执行
    path = os.path.join(_NODES_DIR, modname + ".py")
    spec = importlib.util.spec_from_file_location("qg_nodes_" + modname, path)
    if spec is None or spec.loader is None:
        raise ImportError("无法构建模块 spec: %s" % path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_nodes():
    if not os.path.isdir(_NODES_DIR):
        return
    for fn in sorted(os.listdir(_NODES_DIR)):
        if not fn.endswith(".py") or fn.startswith("_"):
            continue
        modname = fn[:-3]
        try:
            mod = _import_node_module(modname)
        except Exception:
            print("[QG-tools] 节点模块加载失败: nodes/%s.py" % modname)
            traceback.print_exc()
            continue

        cm = getattr(mod, "NODE_CLASS_MAPPINGS", None)
        dm = getattr(mod, "NODE_DISPLAY_NAME_MAPPINGS", None)
        if isinstance(cm, dict):
            clash = set(cm) & set(NODE_CLASS_MAPPINGS)
            if clash:
                _DUPLICATES.append((modname, sorted(clash)))
                for k in clash:
                    del cm[k]          # 先加载的赢
            NODE_CLASS_MAPPINGS.update(cm)
        if isinstance(dm, dict):
            for k, v in dm.items():
                NODE_DISPLAY_NAME_MAPPINGS.setdefault(k, v)


_load_nodes()

if _DUPLICATES:
    for modname, keys in _DUPLICATES:
        print("[QG-tools] 节点 ID 冲突：nodes/%s.py 的 %s 已被先前模块注册，已跳过"
              % (modname, ", ".join(keys)))

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]

print("[QG-tools] v%s 加载完成 | 节点数 %d" % (__version__, len(NODE_CLASS_MAPPINGS)))

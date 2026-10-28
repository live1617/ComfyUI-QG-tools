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

__version__ = "0.9.9"

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_NODES_DIR = os.path.join(_PKG_DIR, "nodes")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 节点 ID 冲突时保留「先加载的」，并在控制台点名，避免静默覆盖
_DUPLICATES = []
# 加载失败的模块，供启动横幅汇总
_FAILED = []


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
            _FAILED.append(modname)
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

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]

# ---------------------------------------------------------------- 启动横幅
_REPO_URL = "https://github.com/live1617/ComfyUI-QG-tools"
_BAR = "-" * 70
_TEAL = "38;2;0;180;170"
_GREY = "0;37"
_RED = "0;31"
_YELLOW = "0;33"


def _use_color():
    """只有真终端才上色。

    stdout 被重定向到日志文件时（启动器常见），isatty() 为 False，
    此时输出纯文本，免得 comfyui_8188.log 里全是转义序列。
    """
    try:
        if not sys.stdout.isatty():
            return False
    except Exception:
        return False
    return "NO_COLOR" not in os.environ


def _paint(code, text):
    return "\033[%sm%s\033[0m" % (code, text) if _use_color() else text


def _pyproject_version():
    """pyproject.toml 里的版本号，用来发现「发版只改了一处」的失误。"""
    try:
        with open(os.path.join(_PKG_DIR, "pyproject.toml"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("version"):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except Exception:
        pass
    return None


def _count_categories():
    """子分类数量（CATEGORY 形如 QG-tools/遮罩）。"""
    subs = set()
    for cls in NODE_CLASS_MAPPINGS.values():
        cat = getattr(cls, "CATEGORY", "") or ""
        subs.add(cat.split("/", 1)[1] if "/" in cat else cat)
    subs.discard("")
    return len(subs)


def _print_banner():
    """加载完成后打一条启动横幅。

    ⚠️ 横幅内只用 ASCII：Windows 控制台编码可能是 cp1252，
    import 阶段抛 UnicodeEncodeError 会让整个插件静默加载失败。
    """
    nodes = len(NODE_CLASS_MAPPINGS)
    cats = _count_categories()
    head = "  %s v%s  |  %d nodes loaded" % (_paint(_TEAL, "QG-tools"), __version__, nodes)
    if cats:
        head += "  |  %d categories" % cats

    print(_paint(_TEAL, _BAR))
    print(head)

    if _FAILED:
        print("  %s" % _paint(_RED, "Failed to load: %s" % ", ".join(_FAILED)))
    for modname, keys in _DUPLICATES:
        print("  %s" % _paint(_YELLOW, "Node ID conflict in nodes/%s.py: %s (skipped)"
                              % (modname, ", ".join(keys))))

    declared = _pyproject_version()
    if declared and declared != __version__:
        print("  %s" % _paint(_YELLOW, "Version mismatch: pyproject.toml says %s" % declared))

    print("  %s" % _paint(_GREY, _REPO_URL))
    print(_paint(_TEAL, _BAR))


_print_banner()

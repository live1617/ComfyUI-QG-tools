# ============================================================
# 搬入说明（2026-11-08，用户确认后 1:1 替换）
#   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / timer_node.py
#   原文件：D://WorkBuddy//2026-10-10-13-25-05//intake//multipack-v0.1.0//
#           ComfyUI-QG-Multipack\timer_node.py
#   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_Timer
#   口径：保留本包原有节点 ID QG_RunTimer（已保存的工作流照常打开），
#         整套实现换成 Multipack 的 QG_Timer；节点数仍 46。
#
#   必要适配（功能逻辑未改）：
#     1) 节点 key QG_Timer -> QG_RunTimer、类名 QGTimer -> QGRunTimer、
#        显示名 "QG 计时器" -> "Run Timer"（显示名不带 QG 前缀，沿用本包命名）；
#     2) CATEGORY "QG 工具" -> "QG-tools/Display"（英文子分类）；
#     3) 字体文件从包根移到 assets/capture_it.ttf，路径按目录层级重算；
#     4) 删掉 legacy 路由 /qyh/timer/font —— 本包从没发过这个节点，没有
#        旧前端缓存需要兼容，且 /qyh/ 不符合本包「路由一律 /qg/…」的约定；
#     5) 删掉子模块里的 WEB_DIRECTORY（本包统一在顶层 __init__.py 声明）；
#     6) DESCRIPTION 改英文（后端文案约定）；docstring 去掉老路由那句。
#   保持不变：/qg/timer/font 路由、FontFace 用 font/ttf 显式声明、
#   _NoSourceBadgeMeta 元类（伪装内置模块以隐藏来源徽章）、
#   hidden unique_id、OUTPUT_NODE、tick() 返回空 UI、SEARCH_ALIASES。
#
#   ⚠️ 与 ComfyUI-QG-Multipack 同时安装会注册同名节点 QG_Timer（不冲突）
#   但两条 /qg/timer/font 路由会撞车（后者注册失败被 try 吞掉）。
#   本机未装该插件；换机器时二选一。
# ============================================================

# -*- coding: utf-8 -*-
"""QG Timer —— 工作流耗时显示节点（纯前端绘制，画布渲染）。

设计意图：
- 节点不参与计算，也不显示任何标题栏 / 控件，只渲染一块深色圆角面板；
- 面板中央用 Capture it 字体实时显示本次运行的耗时；
- 左侧小圆点表示状态：灰=空闲，绿=运行中，蓝=已完成，红=出错；
- 字体颜色可在右键菜单里自定义（预设色 + 系统取色器）；
- 字体经自有路由 /qg/timer/font 伺服，避免猜测前端映射路径。
"""

import os

try:
    from aiohttp import web
except Exception:  # pragma: no cover - 离开 ComfyUI 环境时不至于直接炸掉
    web = None

try:
    from server import PromptServer
except Exception:
    PromptServer = None

_FONT_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "capture_it.ttf")
_FONT_ROUTE = "/qg/timer/font"
_FONT_BYTES = None  # 首次请求时读入并缓存，约 700KB


def _register_font_route() -> bool:
    """把字体文件挂到固定 URL 上，成功返回 True。

    注意用 web.Response 显式声明 Content-Type: font/ttf——aiohttp 的 FileResponse
    对 .ttf 会回 application/octet-stream，部分浏览器在严格模式下会拒绝加载。
    """
    global _FONT_BYTES
    # instance 用 getattr 取：服务未启动的进程（单测/纯导入）里该属性不存在
    server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    if web is None or server is None:
        return False
    if not os.path.isfile(_FONT_FILE):
        return False

    async def _serve_font(request):
        global _FONT_BYTES
        if _FONT_BYTES is None:
            with open(_FONT_FILE, "rb") as f:
                _FONT_BYTES = f.read()
        return web.Response(
            body=_FONT_BYTES,
            content_type="font/ttf",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    try:
        PromptServer.instance.routes.get(_FONT_ROUTE)(_serve_font)
        return True
    except Exception:
        return False


_FONT_ROUTE_READY = _register_font_route()


class _NoSourceBadgeMeta(type):
    """把本节点的 RELATIVE_PYTHON_MODULE 固定为内置模块名。

    custom_nodes 加载器在 import 之后会强制写入 RELATIVE_PYTHON_MODULE =
    "custom_nodes.<包名>"；前端正是拿这个值判断"是否内置节点"，非内置节点会在
    右上角画一个来源徽章。这里用元类拦截写入，让本节点被当作内置节点，
    从而不画徽章，且不影响全局的徽章设置与其他节点。
    """

    def __setattr__(cls, name, value):
        if name == "RELATIVE_PYTHON_MODULE":
            value = "nodes"
        super().__setattr__(name, value)


class QGRunTimer(metaclass=_NoSourceBadgeMeta):
    """显示本次工作流从入队到结束的实时耗时（无输入、无输出、无控件）。"""

    RELATIVE_PYTHON_MODULE = "nodes"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "tick"
    CATEGORY = "QG-tools/Display"
    OUTPUT_NODE = True
    DESCRIPTION = "A canvas stopwatch for the whole run: a dark panel with elapsed time and a status dot. Right-click to switch themes and font colour. Font served from /qg/timer/font."
    SEARCH_ALIASES = ["timer", "stopwatch", "elapsed", "计时器", "秒表", "耗时", "运行时间"]

    def tick(self, unique_id=None):
        # 前端负责一切绘制与交互，这里只回一个空 UI 结果，保证节点可执行/缓存。
        return {"ui": {}, "result": ()}


NODE_CLASS_MAPPINGS = {"QG_RunTimer": QGRunTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RunTimer": "Run Timer"}

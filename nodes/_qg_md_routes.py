# -*- coding: utf-8 -*-
"""HTTP routes for the Markdown reader: file list, file read, and a ping.

Ported from ComfyUI-MD-Reader (md_routes.py). Paths follow this pack's
`/qg/<feature>/...` convention, and errors go through `safe_route_error` so a
failure never leaks a server path back to the browser.

Handlers must live at module level: the decorators register on import.
"""

from __future__ import annotations

import asyncio
import os

from . import _qg_md_core as md_core

try:
    from server import PromptServer
    from aiohttp import web
except Exception:  # not inside ComfyUI (local self-test): degrade quietly
    PromptServer = None  # type: ignore[assignment]
    web = None  # type: ignore[assignment]

# 🔴 两步取，不能合成一步：``PromptServer.instance`` 是**实例属性**，在
# ``PromptServer.__init__`` 里才挂上去，类上根本没有。写成
# ``getattr(PromptServer.instance, "routes", None)`` 时，那个 getattr 的**参数**
# 会先求值 —— 于是下面那句 `if PromptServer else None` 拦不住，import 阶段就是
# 一个 AttributeError（不是「等于 None」）。先按类取实例，再按实例取 routes。
_server = getattr(PromptServer, "instance", None) if PromptServer else None
routes = getattr(_server, "routes", None)

NO_FILE = "<no document>"


def _files_payload():
    files = md_core.list_md_files()
    return {
        "base": md_core._get_input_dir(),
        "roots": [p for p, _ in md_core.scan_roots()],
        "files": files or [NO_FILE],
        "count": len(files),
    }


def register_md_routes() -> None:
    """Attach /qg/md/* once. Safe to call more than once."""
    if routes is None or web is None:
        return
    if getattr(routes, "_qg_md_routes", False):
        return
    routes._qg_md_routes = True

    from ._qg_route_errors import safe_route_error

    @routes.get("/qg/md/files")
    async def qg_md_files(request):
        try:
            # os.walk 全目录扫描是同步的：留在事件循环里，目录一大就卡住
            # 整个 ComfyUI 的进度推送。
            payload = await asyncio.to_thread(_files_payload)
            return web.json_response({"ok": True, **payload})
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=500)

    @routes.post("/qg/md/read")
    async def qg_md_read(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        key = (data.get("custom_path") or "").strip() or (data.get("path") or "").strip()
        # allow_absolute=False：这个接口收的是请求体里的字符串。没有理由让它
        # 成为「读这台机器上任意文件」的入口（填 C:/Windows/win.ini 或
        # ../../../etc/passwd 都曾经能读到）。只认扫描根里面的文件。
        path = md_core.resolve_path(key, allow_absolute=False)
        if not path or not os.path.isfile(path):
            return web.json_response(
                {"ok": False, "error": "file not found: %s" % (key or "(empty)")}, status=404
            )
        try:
            # 同步读文件 + 一串正则在事件循环里跑，几百 KB 的文档就能让
            # 整个服务顿一下；两者都丢进线程池。
            raw = await asyncio.to_thread(md_core.read_text, path)
            plain = await asyncio.to_thread(md_core.md_to_plain, raw)
            payload = {
                "ok": True,
                "name": os.path.basename(path),
                "raw": raw,
                "plain": plain,
                "chars": len(raw),
            }
            payload.update(await asyncio.to_thread(md_core.stat, path))
            return web.json_response(payload)
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=500)

    @routes.get("/qg/md/ping")
    async def qg_md_ping(request):
        return web.json_response({"ok": True, "feature": "md"})

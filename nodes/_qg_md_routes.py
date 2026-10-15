# -*- coding: utf-8 -*-
"""HTTP routes for the Markdown reader: file list, file read, and a ping.

Ported from ComfyUI-MD-Reader (md_routes.py). Paths follow this pack's
`/qg/<feature>/...` convention, and errors go through `safe_route_error` so a
failure never leaks a server path back to the browser.

Handlers must live at module level: the decorators register on import.
"""

from __future__ import annotations

import os

from . import _qg_md_core as md_core

try:
    from server import PromptServer
    from aiohttp import web
except Exception:  # not inside ComfyUI (local self-test): degrade quietly
    PromptServer = None  # type: ignore[assignment]
    web = None  # type: ignore[assignment]

routes = getattr(PromptServer.instance, "routes", None) if PromptServer else None

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
            return web.json_response({"ok": True, **_files_payload()})
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=500)

    @routes.post("/qg/md/read")
    async def qg_md_read(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        key = (data.get("custom_path") or "").strip() or (data.get("path") or "").strip()
        path = md_core.resolve_path(key)
        if not path or not os.path.isfile(path):
            return web.json_response(
                {"ok": False, "error": "file not found: %s" % (key or "(empty)")}, status=404
            )
        try:
            raw = md_core.read_text(path)
            payload = {
                "ok": True,
                "name": os.path.basename(path),
                "raw": raw,
                "plain": md_core.md_to_plain(raw),
                "chars": len(raw),
            }
            payload.update(md_core.stat(path))
            return web.json_response(payload)
        except Exception as exc:
            return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=500)

    @routes.get("/qg/md/ping")
    async def qg_md_ping(request):
        return web.json_response({"ok": True, "feature": "md"})

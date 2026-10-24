# -*- coding: utf-8 -*-
"""QG_MDReader — read a Markdown file and emit its text as a STRING.

Ported from ComfyUI-MD-Reader (nodes.py, class MarkdownFileReader), a plugin by
this pack's author. The node lists the documents found under ComfyUI's input
folder (plus md / markdown / prompts folders next to it), shows a live preview
inside the node, and outputs the text so it can feed any downstream text input.

Renamed to the QG_ prefix; the display name stays Chinese ("QG 加载文档") at
the author's request, so the node is findable by the name it is known by.
"""

from __future__ import annotations

import os

from . import _qg_md_core as md_core
from ._qg_md_routes import NO_FILE, register_md_routes

register_md_routes()


class QGMarkdownReader:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Reads a Markdown file and outputs its text. The output is a STRING, so "
        "it feeds any text input — a prompt box, a CLIP Text Encode, a note. "
        "Plain mode strips the Markdown marks (#, *, -, []()); raw mode returns "
        "the file exactly as it is. The node previews the document on the canvas."
    )
    SEARCH_ALIASES = ["md", "markdown", "document", "doc", "text", "read", "qg", "加载文档"]

    @classmethod
    def INPUT_TYPES(cls):
        files = md_core.list_md_files()
        if not files:
            files = [NO_FILE]
        return {
            "required": {
                "md_file": (files, {
                    "default": files[0],
                    "tooltip": "Drop .md files into ComfyUI's input folder, then press the refresh button on the node.",
                }),
                "mode": (["plain", "raw"], {
                    "default": "plain",
                    "tooltip": "plain: strip the Markdown marks so the text reads as a prompt. raw: the file, untouched.",
                }),
            },
            "optional": {
                "custom_path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Leave empty to use the list. Filled in, it wins over the list.",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = ("The document's text, ready for any STRING input.",)
    FUNCTION = "load_md"

    @classmethod
    def IS_CHANGED(cls, md_file, mode="plain", custom_path=""):
        path = md_core.resolve_path((custom_path or "").strip() or md_file)
        if not path or not os.path.isfile(path):
            return "missing:%s" % (md_file or "")
        st = os.stat(path)
        return "%s|%s|%s" % (path, st.st_mtime_ns, mode)

    def load_md(self, md_file, mode="plain", custom_path=""):
        key = (custom_path or "").strip() or md_file
        path = md_core.resolve_path(key)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(
                "[QG-tools] document not found: %s\n"
                "Put the .md file in ComfyUI's input folder (or a md / prompts "
                "folder beside it), or fill in custom_path with its absolute path." % key
            )
        text = md_core.prepare(mode, md_core.read_text(path))
        print("[QG-tools] read %s (%s, %d chars)" % (os.path.basename(path), mode, len(text)))
        return (text,)


NODE_CLASS_MAPPINGS = {"QG_MDReader": QGMarkdownReader}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MDReader": "Load Document"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

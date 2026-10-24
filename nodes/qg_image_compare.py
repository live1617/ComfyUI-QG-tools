# -*- coding: utf-8 -*-
"""QG 图像对比 — A/B 对比面板。

移植自 ComfyUI-AusBoss（MIT，nodes/node_compare.py + _preview_helpers.py）。

四种看法：滑动（竖线跟着指针，左 A 右 B）、只看 A、只看 B、橡皮擦（画笔把
上面那张擦掉一块，露出底下那张）。节点把两路图各取第一帧写成 temp 预览，
通过 ui.a_images / ui.b_images 回传，前端面板画在自己的 DOM 里；image_a
原样从输出送出，所以可以夹在流程中间。

橡皮擦存的不是画好的位图，而是**笔画**，保存时由这里按原图尺寸重画
（见 _qg_compare_helpers）。浏览器只知道一个随机键，不指名读写任何文件。

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import random
import string
from pathlib import Path

import folder_paths
import torch
from PIL import Image

from ._qg_compare_helpers import (
    ALIGN_GONE,
    CompareSaveError,
    align_pair,
    clean_save_name,
    pair_pictures,
    remember_pair,
    save_mix,
    tidy_save_name,
)
from ._qg_route_errors import safe_route_error

NODE_NAME = "QG_ImageCompare"
SAVE_ROUTE = "/qg/compare/save"
ALIGN_ROUTE = "/qg/compare/align"


def temp_prefix() -> str:
    """一个节点实例专属的 temp 文件名前缀。

    一个工作流里放两个对比节点时，两者会同时写预览；没有按实例区分的前缀，
    后写的会覆盖先写的，两块面板就显示同一张图。
    """
    return "qg_compare_" + "".join(random.choices(string.ascii_lowercase, k=5))


def first_frame_to_pil(image: torch.Tensor) -> Image.Image:
    """BHWC 浮点批次的第一帧，转成可以直接存的 PIL 图。

    单通道帧转成 8 位灰度图而不是 1 通道 RGB——遮罩补成 BHWC 之后就是这种形状。
    """
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError("QG 图像对比：输入必须是 BHWC 图像批次。")
    if int(image.shape[0]) < 1:
        raise ValueError("QG 图像对比：收到空的图像批次。")
    frame = image[0].detach().cpu().float().clamp(0.0, 1.0).mul(255.0).round().to(torch.uint8)
    array = frame.numpy()
    if array.shape[-1] == 1:
        array = array[..., 0]
    elif array.shape[-1] > 3:
        # 丢掉 alpha：面板底色是自己的深色台面，透明预览会读成一个洞。
        array = array[..., :3]
    return Image.fromarray(array)


def save_temp_preview(image: torch.Tensor, prefix: str) -> dict:
    """把一帧预览 PNG 写进 temp 目录，返回它在 ui.images 里的那一项。"""
    preview = first_frame_to_pil(image)
    full_output_folder, filename, counter, subfolder, _prefix = folder_paths.get_save_image_path(
        prefix,
        folder_paths.get_temp_directory(),
        preview.width,
        preview.height,
    )
    file = f"{filename}_{counter:05}_.png"
    preview.save(Path(full_output_folder) / file, compress_level=4)
    return {
        "filename": file,
        "subfolder": subfolder,
        "type": "temp",
        "width": preview.width,
        "height": preview.height,
    }


def _register_save_route() -> None:
    """POST /qg/compare/save 把一次运行那两张预览混成橡皮擦的图。

    请求体是一次运行的键（见 compare()）、笔画、两个选项和新文件的名字。它
    **不指名要读哪个文件**：两张预览是这个节点自己写、自己记下的。名字是纯
    文本、不含目录（clean_save_name 会把别的都拒掉），图直接写进 ComfyUI 的
    output 目录。笔画有校验，会被压回固定上限（见 _qg_compare_helpers）。

    POST /qg/compare/align 把一次运行的 B 对齐到 A。它只收同一个键，读同
    样的两张预览，把对齐后的 B 写在 B 的预览旁边（ComfyUI 的 temp 目录），
    回答里带上那张预览的名字，写法和一次运行给预览命名一致。
    """
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    instance = getattr(PromptServer, "instance", None)
    if instance is None or getattr(instance, "_qg_compare_save", False):
        return
    instance._qg_compare_save = True

    @instance.routes.post(SAVE_ROUTE)
    async def save(request):
        try:
            body = await request.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "图像对比：请求读不出来。"}, status=400)
        try:
            picture_a, picture_b, wired = pair_pictures(body.get("pair"))
            work = functools.partial(
                save_mix,
                picture_a=picture_a,
                picture_b=picture_b,
                output_dir=folder_paths.get_output_directory(),
                top=body.get("top", "A"),
                strokes=body.get("strokes"),
                layers=body.get("layers") is True,
                # 连在节点上的名字，优先于节点上打的字。
                name=wired or clean_save_name(body.get("name")),
            )
            # 别占着服务器自己的线程：一张大图要算一会儿。
            result = await asyncio.get_running_loop().run_in_executor(None, work)
        except CompareSaveError as error:
            return web.json_response({"error": safe_route_error(error)}, status=error.status)
        except Exception:
            logging.exception("[QG-tools] 图像对比：混合图没能保存。")
            return web.json_response(
                {"error": "混合图没能保存，ComfyUI 的控制台里有原因。"}, status=500
            )
        return web.json_response(result)

    @instance.routes.post(ALIGN_ROUTE)
    async def align(request):
        try:
            body = await request.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "图像对比：请求读不出来。"}, status=400)
        try:
            try:
                picture_a, picture_b, wired = pair_pictures(body.get("pair"))
            except CompareSaveError as error:
                raise CompareSaveError(ALIGN_GONE, status=error.status) from error
            temp_root = Path(folder_paths.get_temp_directory())
            work = functools.partial(
                align_pair, picture_a=picture_a, picture_b=picture_b, temp_root=temp_root, name=wired
            )
            # 别占着服务器自己的线程：量两张图要算一会儿。
            result = await asyncio.get_running_loop().run_in_executor(None, work)
        except CompareSaveError as error:
            return web.json_response({"error": safe_route_error(error)}, status=error.status)
        except Exception:
            logging.exception("[QG-tools] 图像对比：对齐没能做出来。")
            return web.json_response(
                {"error": "对齐没能做出来，ComfyUI 的控制台里有原因。"}, status=500
            )
        answer = {"aligned": result["aligned"], "message": result["message"]}
        if result["aligned"]:
            file = result["file"]
            folder = file.parent.resolve().relative_to(Path(temp_root).resolve()).as_posix()
            answer["b"] = {
                "filename": file.name,
                "subfolder": "" if folder == "." else folder,
                "type": "temp",
                "width": result["width"],
                "height": result["height"],
            }
            answer["pair"] = result["pair"]
        return web.json_response(answer)


class QGImageCompare:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "A/B compare: two images in one panel. Slide to see the difference, or hold A "
        "or B to view one alone; the eraser paints away part of the top image to "
        "reveal the one beneath, and the blend can be saved as a PNG, optionally with "
        "a layered PSD and a mask. image_a is passed straight through, so the node "
        "can sit in the middle of a graph."
    )
    SEARCH_ALIASES = [
        "image compare", "compare", "a/b", "before after", "slider", "diff",
        "erase", "blend", "mix", "psd", "layers",
        "对比", "对比图", "图像对比", "橡皮擦", "擦除", "qg",
    ]

    def __init__(self):
        # 按实例区分的 temp 前缀：一个工作流里两个对比节点不会互相覆盖预览。
        self._prefix = temp_prefix()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_a": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "The reference batch. The first frame becomes preview A and the "
                            "whole batch goes out through the output untouched."
                        ),
                    },
                ),
                "image_b": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "The comparison batch. The first frame becomes preview B, revealed "
                            "by sliding across the panel, switching to B, or erasing."
                        ),
                    },
                ),
            },
            "optional": {
                "filename": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": (
                            "Optional. The filename used when saving the eraser result, "
                            "typically the source image's name; any directory and extension are "
                            "stripped. Unwired, the name typed on the node is used."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The batch fed into A, passed straight through so the node can sit "
        "mid-graph.",
    )
    OUTPUT_NODE = True
    FUNCTION = "compare"

    def compare(self, image_a, image_b, filename=None):
        preview_a = save_temp_preview(image_a, self._prefix)
        preview_b = save_temp_preview(image_b, self._prefix)
        wired = tidy_save_name(filename)
        return {
            "ui": {
                "a_images": [preview_a],
                "b_images": [preview_b],
                # 橡皮擦保存时回传的键，所以它从不指名要读哪个文件。
                "pair": [remember_pair(self._preview_file(preview_a), self._preview_file(preview_b), wired)],
                # 连线时文件会叫什么名字。
                "save_name": [wired],
            },
            "result": (image_a,),
        }

    @staticmethod
    def _preview_file(preview: dict) -> Path:
        """这个节点刚写的预览在 temp 目录里的位置。"""
        return Path(folder_paths.get_temp_directory()) / preview.get("subfolder", "") / preview["filename"]


_register_save_route()

NODE_CLASS_MAPPINGS = {NODE_NAME: QGImageCompare}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "Image Compare"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

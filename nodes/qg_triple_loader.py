# -*- coding: utf-8 -*-
"""QG_TripleLoader — one node that loads UNET + CLIP + VAE together.

Ported from ComfyUI-TripleLoader (nodes.py, class TripleLoader), a plugin by
this pack's author. The node merges the three stock loaders (UNETLoader /
CLIPLoader / VAELoader) into one panel: pick the diffusion model, the text
encoder and the VAE in one place, and get standard MODEL / CLIP / VAE outputs
that plug straight into a sampler. Nothing is bound to a model family —
Qwen-Image / Flux / SD all work, because the stock loaders do the loading.

Renamed to the QG_ prefix and moved under nodes/. The display name stays
Chinese ("QG 模型加载器") like the other nodes this pack's author wrote, so the
node is findable by the name it is known by.

How it stays version-proof: the three stock loader instances are reused, so
every dropdown is read off the installed ComfyUI instead of being hardcoded.
The three file lists are read again on every INPUT_TYPES() call - a newly
downloaded model then shows up on a plain refresh, no restart needed; the
static options (weight dtype, clip type, device) are baked into the loaders'
code, so those are read once at import.
The picks are plain file paths, so backend validation passes untouched; the
prettifying to short file names happens entirely in the front end
(web/triple_loader/index.js) and never rewrites a stored value.

Widget order must match load_all's parameter order exactly (ComfyUI passes
arguments by position): unet_name -> weight_dtype -> clip_name -> clip_type ->
device -> vae_name.
"""

# ComfyUI moved the loaders into comfy_extras.nodes_model_loading on newer
# versions; older forks (e.g. Leopard-cat-meow) still keep them in nodes.py.
try:
    from comfy_extras.nodes_model_loading import (
        UNETLoader,
        CLIPLoader,
        VAELoader,
    )
except ImportError:  # pragma: no cover - older / forked builds land here
    from nodes import (
        UNETLoader,
        CLIPLoader,
        VAELoader,
    )

# Reuse the stock loader instances so every dropdown comes from this install.
_unet_loader = UNETLoader()
_clip_loader = CLIPLoader()
_vae_loader = VAELoader()

# The three file lists are read FRESH on every call - never cached at import.
#
# ComfyUI calls INPUT_TYPES() on every /object_info request (page load, the
# Refresh command / R key, adding a node), and the stock loaders enumerate the
# models folders right then. Reading the lists once at import froze them until
# ComfyUI restarted: a newly downloaded model only showed up after a restart,
# while the stock UNETLoader showed it on a plain refresh.
# (folder_paths.get_filename_list re-walks a folder only when its mtime
# changed, so re-reading is cheap.)
def _unet_files():
    return _unet_loader.INPUT_TYPES()["required"]["unet_name"][0]


def _clip_files():
    return _clip_loader.INPUT_TYPES()["required"]["clip_name"][0]


def _vae_files():
    return _vae_loader.INPUT_TYPES()["required"]["vae_name"][0]


# weight_dtype / clip type / device are static options baked into the loader
# code, not filesystem reads, so reading them once at import stays correct.
_unet_dtypes = _unet_loader.INPUT_TYPES()["required"].get("weight_dtype", (["default"],))[0]
_clip_types = _clip_loader.INPUT_TYPES()["required"]["type"][0]
_clip_devices = _clip_loader.INPUT_TYPES().get("optional", {}).get("device", (["default", "cpu"],))[0]


def _resolve_file(value: str, getter) -> str:
    """Turn a stored dropdown value back into a real file name.

    Normally the value *is* the full path (and matches directly). The fallback
    keeps older workflows working: if a row was saved with a bare file name, or
    with a different path separator, match it by base name.
    """
    names = getter()
    if value in names:
        return value
    vnorm = value.replace("\\", "/").rsplit("/", 1)[-1]
    for n in names:
        base = n.replace("\\", "/").rsplit("/", 1)[-1]
        if base == vnorm or base.rsplit(".", 1)[0] == vnorm:
            return n
    raise ValueError("[QG-tools] 模型加载器：找不到模型文件「%s」" % value)


class QGTripleLoader:
    CATEGORY = "QG-tools/加载器"
    DESCRIPTION = (
        "Loads the diffusion model, the text encoder and the VAE in one node. "
        "The three stock loaders (UNET Loader / Load CLIP / Load VAE) are "
        "merged into a single panel that outputs standard MODEL / CLIP / VAE, "
        "so it drops in wherever those loaders are used. Not tied to any model "
        "family — Qwen-Image, Flux and SD all work. In the dropdowns the files "
        "show their full path; on the node they collapse to the short name."
    )
    SEARCH_ALIASES = [
        "loader", "unet", "clip", "vae", "model", "checkpoint",
        "qwen", "flux", "sd", "qg", "模型加载器", "三合一",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unet_name": (
                    _unet_files(),
                    {"tooltip": "UNET / 扩散模型（列表显示完整路径，节点上显示短文件名）"},
                ),
                "weight_dtype": (
                    _unet_dtypes,
                    {
                        "tooltip": "UNET 权重数据类型，显存紧张可选 fp8_e4m3fn",
                        "default": "default",
                    },
                ),
                "clip_name": (
                    _clip_files(),
                    {"tooltip": "CLIP / 文本编码器（列表显示完整路径，节点上显示短文件名）"},
                ),
                "clip_type": (
                    _clip_types,
                    {
                        "tooltip": "文本编码器类型，按模型选择（默认与 ComfyUI 原生 CLIPLoader 一致，取列表第一项）",
                        "default": _clip_types[0],
                    },
                ),
                "device": (
                    _clip_devices,
                    {
                        "tooltip": "文本编码器加载设备，选 cpu 可省显存（速度变慢）",
                        "default": "default",
                    },
                ),
                "vae_name": (
                    _vae_files(),
                    {"tooltip": "VAE（列表显示完整路径，节点上显示短文件名）"},
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load_all"

    # Parameter order must match INPUT_TYPES exactly (positional arguments).
    def load_all(self, unet_name, weight_dtype, clip_name, clip_type, device, vae_name):
        unet_real = _resolve_file(unet_name, _unet_files)
        clip_real = _resolve_file(clip_name, _clip_files)
        vae_real = _resolve_file(vae_name, _vae_files)
        model = _unet_loader.load_unet(unet_real, weight_dtype)[0]
        clip = _clip_loader.load_clip(clip_real, type=clip_type, device=device)[0]
        vae = _vae_loader.load_vae(vae_real)[0]
        return (model, clip, vae)


NODE_CLASS_MAPPINGS = {"QG_TripleLoader": QGTripleLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TripleLoader": "QG 模型加载器"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

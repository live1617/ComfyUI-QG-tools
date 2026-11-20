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

from comfy_api.latest import io

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
    # 只在**唯一命中**时回退。以前是「第一个撞上的就返回」：
    # models/unet/a.safetensors 与 models/unet/sdxl/a.safetensors 并存时，
    # 会静默加载其中任意一个；老存档存的是去掉扩展名的裸名（a），则
    # a.ckpt 和 a.safetensors 都可能命中 —— 出图全错却不报错。
    exact = [n for n in names if n.replace("\\", "/").rsplit("/", 1)[-1] == vnorm]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(
            "[QG-tools] Triple Loader: \"%s\" matches several files; pick one in the node:\n  %s"
            % (value, "\n  ".join(exact[:8]))
        )
    bare = [
        n for n in names
        if n.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0] == vnorm
    ]
    if len(bare) == 1:
        return bare[0]
    if len(bare) > 1:
        raise ValueError(
            "[QG-tools] Triple Loader: \"%s\" matches several files (%s); pick one in the node."
            % (value, ", ".join(bare[:8]))
        )
    raise ValueError("[QG-tools] Triple Loader: model file not found: \"%s\"" % value)


class QGTripleLoader(io.ComfyNode):
    CATEGORY = "QG-tools/Loaders"
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
    def define_schema(cls):
        # 三个文件列表每次 define_schema 都重新读取（对应 V1 INPUT_TYPES 的
        # 「刷新即更新」，新增模型无需重启）。
        return io.Schema(
            node_id="QG_TripleLoader",
            display_name="Triple Loader",
            category="QG-tools/Loaders",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Combo.Input("unet_name", options=_unet_files(),
                    tooltip="UNET or diffusion model. The list shows full paths and the node shows the short filename."),
                io.Combo.Input("weight_dtype", options=_unet_dtypes, default="default",
                    tooltip="Data type for the UNET weights; pick fp8_e4m3fn when VRAM is tight."),
                io.Combo.Input("clip_name", options=_clip_files(),
                    tooltip="CLIP or text encoder. The list shows full paths and the node shows the short filename."),
                io.Combo.Input("clip_type", options=_clip_types, default=_clip_types[0],
                    tooltip="Text encoder type, chosen to match the model. The default matches ComfyUI's own CLIPLoader and takes the first entry in the list."),
                io.Combo.Input("device", options=_clip_devices, default="default",
                    tooltip="Where the text encoder is loaded. cpu saves VRAM at the cost of speed."),
                io.Combo.Input("vae_name", options=_vae_files(),
                    tooltip="VAE. The list shows full paths and the node shows the short filename."),
            ],
            outputs=[
                io.Model.Output("MODEL", tooltip="The loaded diffusion model, ready for a sampler or a LoRA stack."),
                io.Clip.Output("CLIP", tooltip="The loaded text encoder, ready for a CLIP Text Encode node."),
                io.Vae.Output("VAE", tooltip="The loaded VAE, ready for a VAE Encode or VAE Decode node."),
            ],
        )

    # Parameter order must match define_schema exactly (positional arguments).
    @classmethod
    def execute(cls, unet_name, weight_dtype, clip_name, clip_type, device, vae_name):
        unet_real = _resolve_file(unet_name, _unet_files)
        clip_real = _resolve_file(clip_name, _clip_files)
        vae_real = _resolve_file(vae_name, _vae_files)
        model = _unet_loader.load_unet(unet_real, weight_dtype)[0]
        clip = _clip_loader.load_clip(clip_real, type=clip_type, device=device)[0]
        vae = _vae_loader.load_vae(vae_real)[0]
        return io.NodeOutput(model, clip, vae)


NODE_CLASS_MAPPINGS = {"QG_TripleLoader": QGTripleLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TripleLoader": "Triple Loader"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

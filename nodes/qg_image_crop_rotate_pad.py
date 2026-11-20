"""Image Crop + Rotate + Pad.

Interface taken from ComfyUI-AusBoss's ``Image Crop + Rotate + Pad 🆎`` (MIT):
node id, socket names, widget order and the transform spec follow it, so a
workflow saved against that node opens here and runs the same way.

The processing is not AusBoss's code. This file is a shell - declare the inputs,
call the engine, pack seven outputs - and every pixel operation lives in
``_qg_transform_engine.py``, written here and shared with QG_LoadImage's mask
editor (edit it and both paths need re-checking). No line of the upstream
implementation is left in this pack, which is why ORIGINS.json files this node
as original with the interface noted as a reference.

Modified for ComfyUI-QG-tools on 2026-10-24; implementation replaced by the QG
transform engine on 2026-10-30.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations

from comfy_api.latest import io

from ._qg_media_helpers import (
    list_input_images,
    load_image_frames,
    register_video_routes,
    resolve_input_path,
)
from ._qg_inpaint_crop_helpers import build_transform_stitcher
from ._qg_transform_engine import (
    original_image_batch,
    resize_then_pad,
    stable_file_fingerprint,
    transform_pil_batch,
)
from ._qg_transform_inputs import resize_inputs, spec_from_values, transform_inputs


def _spec_to_input(name, spec, *, upload=False, image_folder=None):
    """把共享 helper 的 V1 (type, dict) spec 转成 V3 io.Input（本节点专用）。"""
    typ, meta = spec
    meta = dict(meta)
    # 只保留 io 认识的关键字；其余（image_upload/forceInput 等）走 extra_dict。
    kw = {"id": name, "optional": False}
    tooltip = meta.pop("tooltip", None)
    if tooltip is not None:
        kw["tooltip"] = tooltip
    meta.pop("image_upload", None)  # upload 由参数显式给
    force = meta.pop("forceInput", None)
    extras = {}
    if force:
        extras["forceInput"] = True
    if upload:
        kw["upload"] = io.UploadType.image
        if image_folder is not None:
            kw["image_folder"] = image_folder
    for k in ("default", "min", "max", "step", "round"):
        if k in meta:
            kw[k] = meta.pop(k)
    if isinstance(typ, (list, tuple)):
        kw["options"] = list(typ)
        return io.Combo.Input(**kw)
    ctor = {"INT": io.Int, "FLOAT": io.Float, "STRING": io.String,
            "BOOLEAN": io.Boolean}[typ]
    if extras:
        kw["extra_dict"] = extras
    return ctor.Input(**kw)


class QGImageCropRotatePad(io.ComfyNode):
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Loads an image and applies one visual rotate, crop, and pad transform. "
        "The mask marks what to paint: new padding, the corners a turn leaves "
        "empty, and see-through parts of the picture (less than 90% solid), "
        "which are filled like the padding unless painted_area keeps the "
        "picture there. Optionally resizes the result to a "
        "megapixel budget (core Scale Image to Total Pixels semantics: aspect "
        "preserved, dimensions rounded to resolution_steps)."
    )
    SEARCH_ALIASES = ["image crop", "rotate image", "pad image", "outpaint canvas", "qg"]

    @classmethod
    def define_schema(cls):
        # image 是动态文件列表 + upload；其余来自共享 helper（保持与 Clip 节点同款）。
        image_input = io.Combo.Input("image", options=list_input_images(),
            upload=io.UploadType.image, image_folder=io.FolderType.input,
            tooltip="Choose or upload an image from ComfyUI's input folder.")
        tr = transform_inputs()
        rz = resize_inputs()
        inputs = [image_input]
        inputs += [_spec_to_input(name, tr[name]) for name in tr]
        # stitch_* / painted_area 是节点自己的 optional（在 resize 之后追加）
        inputs += [
            io.Int.Input("stitch_blend", optional=True, default=32, min=0, max=512, step=1,
                tooltip="Ramp of the stitcher's paste, in pixels, into the kept picture: where generated pixels fade over the source. Separate from feather, which shapes the mask itself."),
            io.Int.Input("stitch_grow", optional=True, default=0, min=-256, max=256, step=1,
                tooltip="Moves the paste boundary before the ramp: positive lets the generation replace a strip of the source next to the seam, negative keeps more of the source."),
            io.Combo.Input("painted_area", optional=True, options=["fill", "keep picture"], default="fill",
                tooltip="What the parts you painted in the MaskEditor are handed on as (see-through parts of a PNG count too). Fill: flat fill, so the model never sees what was there. Keep picture: your picture stays under the paint and only the mask marks it. Pick keep picture when a later step needs what was there, like a denoise under 1."),
        ]
        inputs += [_spec_to_input(name, rz[name]) for name in rz]
        for inp in inputs:
            if inp.id in ("megapixels", "resize_method", "resize_to_megapixels",
                          "resolution_steps", "stitch_blend", "stitch_grow", "painted_area"):
                inp.optional = True
        return io.Schema(
            node_id="QG_ImageCropRotatePad",
            display_name="Image Crop + Rotate + Pad",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=inputs,
            outputs=[
                io.Image.Output("image", tooltip="The transformed image batch in BHWC format."),
                io.Mask.Output("mask", tooltip="White where the model paints: padding, the corners a turn leaves empty, and see-through parts of your picture."),
                io.Custom("AUSBOSS_STITCHER").Output("stitcher", tooltip="Full-canvas stitcher: restores kept source pixels over an outpaint result; wire to Stitch Inpaint."),
                io.Image.Output("original", tooltip="Your picture before rotation, crop, padding or resize. See-through parts show as white, or as your picture when painted_area keeps it."),
                io.Int.Output("width", tooltip="Output width after the transform and any resize."),
                io.Int.Output("height", tooltip="Output height after the transform and any resize."),
                io.Image.Output("prompt_image", tooltip="The image with see-through parts shown on white instead of the fill. Wire it to the node that writes your prompt, so a cutout gets a real backdrop. The same as image when your picture has no see-through parts, or painted_area keeps the picture."),
            ],
        )

    @classmethod
    def execute(cls, image, resize_to_megapixels=False, megapixels=1.0,
                resize_method="lanczos", resolution_steps=1, stitch_blend=32,
                stitch_grow=0, painted_area="fill", **values):
        path = resolve_input_path(image)
        frames = load_image_frames(path)
        keep_picture = str(painted_area) == "keep picture"
        spec = spec_from_values(**values)
        output, mask, geometry, prompt_image = transform_pil_batch(
            frames, spec, view=True, keep_see_through=keep_picture
        )
        if resize_to_megapixels:
            output, mask, prompt_image = resize_then_pad(
                output, mask, geometry, spec.fill_color, float(megapixels), str(resize_method),
                int(resolution_steps), view=prompt_image,
            )
        stitcher = build_transform_stitcher(
            output, mask, geometry, int(stitch_blend), int(stitch_grow),
            source="Image Crop + Rotate + Pad",
        )
        # Nothing see-through: the prompt view is the image itself, as a copy
        # so no consumer can change one through the other.
        if prompt_image is None:
            prompt_image = output.clone()
        return io.NodeOutput(
            output, mask, stitcher, original_image_batch(frames, keep_picture),
            int(output.shape[2]), int(output.shape[1]), prompt_image,
        )

    @classmethod
    def validate_inputs(cls, image):
        # ComfyUI skips its own range and list checks for every input named
        # here and files a failure once per named input, so only the source
        # is named. Its list check would refuse uploads it has not listed yet
        # and MaskEditor saves ("... [input]"); resolve_input_path takes any
        # file inside the input folder instead, and nothing outside it.
        try:
            resolve_input_path(image)
        except Exception as exc:
            return f"Image Crop + Rotate + Pad: {exc}"
        return True

    @classmethod
    def IS_CHANGED(cls, image, **values):
        try:
            path = resolve_input_path(image)
        except Exception:
            path = image or ""
        spec = spec_from_values(**values)
        # Every widget value is already part of ComfyUI's cache key, so a
        # changed transform or budget re-runs the node without this; the
        # fingerprint's job is noticing the image file change on disk. The
        # resize values live outside TransformSpec and ride along beside it.
        resize = {name: values.get(name) for name in resize_inputs()}
        return stable_file_fingerprint(path, {"image": image, **spec.__dict__, **resize})


NODE_CLASS_MAPPINGS = {"QG_ImageCropRotatePad": QGImageCropRotatePad}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageCropRotatePad": "Image Crop + Rotate + Pad"}

register_video_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


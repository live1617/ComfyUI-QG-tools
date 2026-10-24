"""Image Crop + Rotate + Pad (ported from ComfyUI-AusBoss).

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations

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


class QGImageCropRotatePad:
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
    def INPUT_TYPES(cls):
        required = {
            "image": (
                list_input_images(),
                {"image_upload": True, "tooltip": "Choose or upload an image from ComfyUI's input folder."},
            )
        }
        required.update(transform_inputs())
        # Appended AFTER the stable V1 widgets, so saved workflows' positional
        # widgets_values keep loading, and optional, so an API prompt from
        # before they existed still validates; missing values fall back to
        # load_transform's defaults. The stitch settings come last, as on
        # the clip node: older saved workflows and API prompts keep the
        # 32 px blend they always had.
        optional = resize_inputs()
        optional.update({
            "stitch_blend": (
                "INT",
                {
                    "default": 32,
                    "min": 0,
                    "max": 512,
                    "step": 1,
                    "tooltip": (
                        "Ramp of the stitcher's paste, in pixels, into the kept "
                        "picture: where generated pixels fade over the source. "
                        "Separate from feather, which shapes the mask itself."
                    ),
                },
            ),
            "stitch_grow": (
                "INT",
                {
                    "default": 0,
                    "min": -256,
                    "max": 256,
                    "step": 1,
                    "tooltip": (
                        "Moves the paste boundary before the ramp: positive lets "
                        "the generation replace a strip of the source next to "
                        "the seam, negative keeps more of the source."
                    ),
                },
            ),
            # Last of all: the newest input, and older saves and API prompts
            # keep the fill they always had.
            "painted_area": (
                ["fill", "keep picture"],
                {
                    "default": "fill",
                    "tooltip": (
                        "What the parts you painted in the MaskEditor are handed on as "
                        "(see-through parts of a PNG count too). Fill: flat fill, so "
                        "the model never sees what was there. Keep picture: your "
                        "picture stays under the paint and only the mask marks it. "
                        "Pick keep picture when a later step needs what was there, "
                        "like a denoise under 1."
                    ),
                },
            ),
        })
        return {"required": required, "optional": optional}

    # Appended outputs only: saved links ride slot indices.
    RETURN_TYPES = ("IMAGE", "MASK", "AUSBOSS_STITCHER", "IMAGE", "INT", "INT", "IMAGE")
    RETURN_NAMES = ("image", "mask", "stitcher", "original", "width", "height", "prompt_image")
    OUTPUT_TOOLTIPS = (
        "The transformed image batch in BHWC format.",
        "White where the model paints: padding, the corners a turn leaves empty, "
        "and see-through parts of your picture.",
        "Full-canvas stitcher: restores kept source pixels over an outpaint result; wire to Stitch Inpaint.",
        "Your picture before rotation, crop, padding or resize. See-through parts show as white, "
        "or as your picture when painted_area keeps it.",
        "Output width after the transform and any resize.",
        "Output height after the transform and any resize.",
        "The image with see-through parts shown on white instead of the fill. Wire it to "
        "the node that writes your prompt, so a cutout gets a real backdrop. The same "
        "as image when your picture has no see-through parts, or painted_area keeps the picture.",
    )
    FUNCTION = "load_transform"

    def load_transform(
        self,
        image: str,
        resize_to_megapixels=False,
        megapixels=1.0,
        resize_method="lanczos",
        resolution_steps=1,
        stitch_blend=32,
        stitch_grow=0,
        painted_area="fill",
        **values,
    ):
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
        return (
            output, mask, stitcher, original_image_batch(frames, keep_picture),
            int(output.shape[2]), int(output.shape[1]), prompt_image,
        )

    @classmethod
    def VALIDATE_INPUTS(cls, image):
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


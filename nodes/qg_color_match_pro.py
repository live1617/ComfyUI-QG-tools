# -*- coding: utf-8 -*-
"""QG_ColorMatchPro — 把参考图的配色搬到目标图上（多合一整合版）。

这是「颜色匹配 Pro」的自写整合实现：界面与原型（ColorMatchPro）一致——九个方法名、
强度、蒙版羽化、保留明暗、多线程、内置预览；算法全部复用本插件已有的
``QGColorMatch`` 纯 torch 实现，不依赖 color-matcher / kornia / OpenCV。

方法名是原型的对外名，内部映射到本插件已有的等价算法：

  * ``mkl``      → mvgd（LAB 3x3 协方差匹配，Pitié 2007 线性 MKL 的核心）
  * ``hm``       → histogram（逐通道分位匹配）
  * ``hm-mkl-hm``→ histogram-mmd-histogram（核均值匹配串联）
  * 其余同名直连（reinhard / mvgd / wavelet / adain / reinhard_lab）。

与 QG_ColorMatch 的差异（都是原型的增强点）：

  * 参考图恒取第一帧：批次参考不参与逐帧配对，行为确定。
  * 保留明暗：Lab 里把 L 通道换回目标图，只搬色度。
  * 单帧失败回退原图：整批尝试失败后逐帧重试，逐帧再失败就回退，全部失败才报错。
  * 内置预览：结果写临时目录，直接显示在 ComfyUI 预览面板（OUTPUT_NODE）。
"""

import logging
import os
import uuid

import folder_paths
from PIL import Image
import torch
from comfy_api.latest import io

from ._qg_combo_legacy import coerce
from .qg_color_match import QGColorMatch

LOGGER = logging.getLogger("QG-tools.ColorMatchPro")

# 对外方法名（与截图 / 原型一致）。全英文，无中文老存档兼容问题。
METHODS = (
    "mkl", "hm", "reinhard", "mvgd", "hm-mvgd-hm", "hm-mkl-hm",
    "reinhard_lab", "wavelet", "adain",
)
# 原型方法名 → 本插件 QGColorMatch 已有的自写算法名。
METHOD_TO_INTERNAL = {
    "mkl": "mvgd",
    "hm": "histogram",
    "reinhard": "reinhard",
    "mvgd": "mvgd",
    "hm-mvgd-hm": "histogram-mvgd-histogram",
    "hm-mkl-hm": "histogram-mmd-histogram",
    "reinhard_lab": "reinhard-lab-gpu",
    "wavelet": "wavelet",
    "adain": "adain",
}


# V1 @combo_legacy("QG_ColorMatchPro")：method 有中文遗留值需 coerce。
# V3 去装饰器，execute 开头 coerce；原 color_match 实例方法改名 _color_match 逐字不动。
class QGColorMatchPro(io.ComfyNode):
    CATEGORY = "QG-tools/Image"

    @classmethod
    def validate_inputs(cls, method=None):
        # method 中文遗留值在 LEGACY 表；具名跳过列表校验，值由 execute coerce 换回。
        return True
    DESCRIPTION = (
        "Moves the reference picture's color onto the target, in one node that "
        "combines the best of the classic color-match nodes. Nine methods: mkl "
        "(multivariate covariance, Pitié's Monge-Kantorovich linear map), hm "
        "(per-channel histogram quantiles), reinhard (Lab mean and standard "
        "deviation), mvgd, their three-step chains hm-mvgd-hm and hm-mkl-hm, "
        "reinhard_lab (whole-batch tensor Lab transfer, the fastest), wavelet "
        "(low frequencies only, texture untouched) and adain (per-channel sRGB "
        "normalization). All methods are self-written pure-torch implementations "
        "from this plugin; no external color-matcher or kornia is needed. "
        "Strength blends the result with the original and works on every method. "
        "An optional mask limits where the change lands, with a feather width in "
        "pixels. Keep luma swaps only chroma and leaves the target's light-and-dark "
        "structure alone. The reference always takes its first frame, so a batch "
        "of references never pairs unpredictably. If one frame fails the node "
        "falls back to that frame's original instead of dropping the batch. The "
        "built-in preview writes the result to ComfyUI's temporary folder and "
        "shows it in the preview panel."
    )
    SEARCH_ALIASES = [
        "color match pro", "colour match pro", "color transfer", "color grading",
        "mkl", "hm", "reinhard", "mvgd", "wavelet", "adain", "histogram match",
        "keep luma", "mask feather", "颜色匹配", "颜色匹配 Pro", "颜色迁移",
        "色彩匹配", "配色", "取色", "追色", "保留明暗", "蒙版羽化",
    ]

    @classmethod
    def define_schema(cls):
        # is_output_node=True 承担 V1 OUTPUT_NODE（内置预览）。
        return io.Schema(
            node_id="QG_ColorMatchPro",
            display_name="Color Match Pro",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input("image_target", tooltip="The image to recolor; its composition and detail are kept."),
                io.Image.Input("image_ref", tooltip="The image supplying the color. Only its first frame is used."),
                io.Combo.Input("method", options=list(METHODS), default="mkl",
                    tooltip="mkl / hm-mkl-hm are the safest on photographs; reinhard_lab is the fastest (whole-batch tensors); hm matches the distributions exactly and is the easiest to overdo; wavelet changes low frequencies only and leaves texture alone; adain is the sRGB per-channel version, mostly for stylization."),
                io.Float.Input("strength", default=1.0, min=0.0, max=2.0, step=0.01,
                    tooltip="How much of the match is mixed in: 0 is the original, 1 is a full match, above 1 pushes past the reference and is clamped at the end. At 0 the image passes straight through with no computation."),
                io.Mask.Input("mask", optional=True, tooltip="White areas are recolored; black areas keep the original exactly."),
                io.Int.Input("mask_feather", optional=True, default=8, min=0, max=256, step=1,
                    tooltip="Gaussian feather width of the mask edge, in pixels; 0 is a hard cut."),
                io.Boolean.Input("keep_luma", optional=True, default=False,
                    tooltip="Keep the target's light-and-dark structure and swap only hue and chroma - useful for changing the lighting without flattening a face."),
                io.Boolean.Input("multithread", optional=True, default=True,
                    tooltip="Kept for interface parity with the original node. The built-in torch methods already vectorize across the batch, so this switch does not change the result or require extra threads."),
                io.Boolean.Input("preview", optional=True, default=True,
                    tooltip="Write the result to ComfyUI's temporary folder and show it in the preview panel; turn off to output the IMAGE tensor only."),
            ],
            outputs=[
                io.Image.Output("image", tooltip="The recolored image, same size and batch count as the target."),
            ],
            is_output_node=True,
        )

    def __init__(self):
        self._prefix = "QG_ColorMatchPro_" + uuid.uuid4().hex[:12] + "_"

    @staticmethod
    def _internal_method(method):
        """Map the public method name onto this plugin's own algorithm."""
        name = str(method or "mkl")
        if name not in METHOD_TO_INTERNAL:
            raise ValueError(
                "QG Color Match Pro: unknown method '%s'. Expected one of %s."
                % (name, ", ".join(METHODS))
            )
        return METHOD_TO_INTERNAL[name]

    @staticmethod
    def _slice_mask(mask, index):
        """Take one frame of a mask while keeping the (B, H, W) shape."""
        if mask is None:
            return None
        if mask.shape[0] == 1:
            return mask
        return mask[index:index + 1]

    def _transfer(self, target, ref, method, strength, mask, feather, keep_luma):
        """Run the shared self-written matcher, with a per-frame fallback."""
        matcher = QGColorMatch()
        internal = self._internal_method(method)
        scope = "chroma-only" if bool(keep_luma) else "all"

        def run(image, one_ref, one_mask):
            return matcher._color_match(
                image,
                one_ref,
                internal,
                float(strength),
                "first-frame",
                src_mode="per-frame",
                scope=scope,
                feather=int(feather),
                mask=one_mask,
                mask_use="result-only",
                detail=0.0,
            )[0]

        try:
            return run(target, ref, mask)
        except Exception as batch_exc:
            # The shared matcher raises on a malformed frame. Retry frame by
            # frame so one bad picture cannot drop the whole batch.
            frames = []
            failures = []
            for index in range(target.shape[0]):
                try:
                    frames.append(run(target[index:index + 1], ref, self._slice_mask(mask, index)))
                except Exception as frame_exc:
                    LOGGER.warning(
                        "[QG-tools] Color Match Pro: frame %d failed (%s); using the original.",
                        index, frame_exc,
                    )
                    failures.append((index, str(frame_exc)))
                    frames.append(target[index:index + 1])
            if failures and len(failures) == target.shape[0]:
                raise RuntimeError(
                    "QG Color Match Pro: every frame failed for method '%s'. First error: %s"
                    % (method, failures[0][1])
                ) from batch_exc
            return torch.cat(frames, dim=0)

    @staticmethod
    def _preview(images):
        """Write every frame to the temporary folder for the preview panel."""
        out_dir = folder_paths.get_temp_directory()
        results = []
        for index, frame in enumerate(images):
            filename = "%s%02d.png" % (uuid.uuid4().hex[:12], index)
            array = frame.detach().cpu().clamp(0.0, 1.0).numpy()
            picture = Image.fromarray((255.0 * array).astype("uint8"))
            picture.save(os.path.join(out_dir, filename), compress_level=1)
            results.append({"filename": filename, "subfolder": "", "type": "temp"})
        return results

    @classmethod
    def execute(
        cls,
        image_target,
        image_ref,
        method="mkl",
        strength=1.0,
        mask=None,
        mask_feather=8,
        keep_luma=False,
        multithread=True,
        preview=True,
    ):
        # V1 装饰器 coerce method（中文遗留值 → 英文），V3 显式保留。
        method = coerce("QG_ColorMatchPro", "method", method)
        # 原 color_match 实例方法（用 self._prefix/_transfer）逐字不动，实例化调用。
        out = cls()._color_match(
            image_target, image_ref, method, strength, mask, mask_feather,
            keep_luma, multithread, preview)
        # V1 {"ui":..., "result":...} / tuple → V3 NodeOutput。
        if isinstance(out, dict):
            return io.NodeOutput(*out["result"], ui=out.get("ui") or {})
        return io.NodeOutput(*out)

    def _color_match(
        self,
        image_target,
        image_ref,
        method="mkl",
        strength=1.0,
        mask=None,
        mask_feather=8,
        keep_luma=False,
        multithread=True,
        preview=True,
    ):
        if not torch.is_tensor(image_target) or not torch.is_tensor(image_ref):
            raise TypeError("QG Color Match Pro: image_target and image_ref must be IMAGE tensors.")
        if image_target.ndim != 4 or image_ref.ndim != 4:
            raise ValueError(
                "QG Color Match Pro: inputs must be BHWC batches (target=%s, reference=%s)."
                % (tuple(image_target.shape), tuple(image_ref.shape))
            )
        if image_ref.shape[0] < 1:
            raise ValueError("QG Color Match Pro: the reference image is empty.")
        if float(strength) <= 0.0:
            # Zero strength is an exact pass-through, including the alpha channel.
            result = image_target
        else:
            result = self._transfer(
                image_target, image_ref, method, strength, mask, mask_feather, keep_luma
            )

        if not preview:
            return (result,)
        try:
            return {"ui": {"images": self._preview(result)}, "result": (result,)}
        except Exception as exc:
            LOGGER.warning("[QG-tools] Color Match Pro: preview unavailable (%s).", exc)
            return (result,)


NODE_CLASS_MAPPINGS = {"QG_ColorMatchPro": QGColorMatchPro}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ColorMatchPro": "Color Match Pro"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

# -*- coding: utf-8 -*-
"""遮罩细化的各步骤 —— QG 自己的实现。

运行顺序固定：扩张/收缩 → 补洞 → 平滑 → 羽化 → 边缘细化 → 色阶。

和这个包里另一份的关系（重要，别搞混）
--------------------------------------
``nodes/_qg_mask_helpers.py`` 是**另一套**实现，给遮罩裁剪与重绘裁剪用；它按
设备走两条路径（CPU 用 van Herk 滑动极值，GPU 用池化），只求快。本文件是
节点 ``QG_MaskRefine`` 用的那套，独立实现、独立演进。

两份目前有一处**语义不同**，是有意的：

    收缩（步长为负）时，画布外算背景（0）。

两份原先都用 ``max_pool2d`` 的默认 padding，那是 ``-inf``，取负之后等于
「画布外是白的」，于是贴边的遮罩无论负到多少都一格不缩 —— 实测：一张整幅
全 1 的遮罩 ``expand=-2`` 之后仍然是全 1。本文件按「画布外没有像素」处理，
``_qg_mask_helpers.py`` 那边暂时保持旧语义（六个节点在用它，改动要单独评估）。

四维遮罩
--------
官方文档写明 MASK 的合法形状是 ``[H,W]`` 或 ``[B,C,H,W]``。上游只认前两种，
拿到 ``[B,1,H,W]`` 直接抛「expected a BHW MASK」；这里把单通道的四维压成
``[B,H,W]``，多通道报一个说得清的错（多通道遮罩没有统一的「这个像素算不算
选区」的答案，硬摊平等于替用户做主）。
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as functional

from ._qg_execution_helpers import raise_if_interrupted
from ._qg_mask_helpers import NO_MASK_PAINTED, grow_shrink_mask, is_unpainted_mask

try:  # scipy 只用来加速连通域标记；没有它就用下面的 torch 路径
    from scipy.ndimage import binary_fill_holes as _scipy_fill_holes
    from scipy.ndimage import label as _scipy_label
except Exception:
    _scipy_fill_holes = None
    _scipy_label = None


# 「没画遮罩」的判据在 _qg_mask_helpers 里，这里只是再导出一份给本模块的
# __all__ 用。以前这里有一份自己的副本，并且比那边多了「接受 4 维」——于是
# 同一张 (B,1,64,64) 的空占位在这里算「没画」、在重绘裁剪里算「尺寸不符」，
# 两个节点对同一张图给出相反的解释。判据只能有一处。
# 小于这个的 alpha 当空，大于 1 - 这个当完全不透明。只在给抠图铺 trimap 时
# 用来分辨「羽化边」和「硬边」。
_SOFT_EPSILON = 1e-3


def _as_bhw(mask: torch.Tensor) -> torch.Tensor:
    """把遮罩规整成 BHW float。四维只接受单通道。"""
    if not isinstance(mask, torch.Tensor):
        raise ValueError("Mask Refine expected a MASK tensor.")
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 4:
        if int(mask.shape[1]) != 1:
            raise ValueError(
                "Mask Refine got a 4D mask with %d channels; only a single "
                "channel can be read as one selection (shape %s)."
                % (int(mask.shape[1]), list(mask.shape))
            )
        mask = mask[:, 0]
    if mask.ndim != 3:
        raise ValueError(
            "Mask Refine expected [H,W] or [B,1,H,W], got shape %s." % (list(mask.shape),)
        )
    return mask.float().clamp(0.0, 1.0)


def _spread(marker: torch.Tensor, allowed: torch.Tensor) -> torch.Tensor:
    """把 marker 沿 allowed 区域向外扩一格（8 邻域）。"""
    grown = functional.max_pool2d(
        marker.float().unsqueeze(1), kernel_size=3, stride=1, padding=1
    )
    return (grown.squeeze(1) > 0) & allowed


def _flood_from_border(background: torch.Tensor) -> torch.Tensor:
    """从画布四边出发能走到的背景 —— 也就是「外面」。

    🔴 每步只扩**一格**，不能图快一次扩好几格。这里传播的路径受 ``background``
    限制，而一次大核的池化只看结果、不看路径：核会直接跨过一圈遮罩墙，把墙里面
    的洞也算成「外面」。实测半径 64 的核在 128x128 上会把 40x40 方块正中的
    10x10 洞一口吞掉，补洞就此失效。代价是轮数随直径线性增长，所以调用方优先用
    scipy（它的 ``binary_fill_holes`` 一次出结果），这条路是没装 scipy 时的兜底。
    """
    reachable = torch.zeros_like(background)
    reachable[:, 0, :] = background[:, 0, :]
    reachable[:, -1, :] = background[:, -1, :]
    reachable[:, :, 0] = background[:, :, 0]
    reachable[:, :, -1] = background[:, :, -1]
    limit = max(int(background.shape[-2]), int(background.shape[-1]))
    for _ in range(limit):
        grown = _spread(reachable, background)
        if torch.equal(grown, reachable):
            break
        reachable = grown
    return reachable


def _label_blocks(inside: torch.Tensor) -> torch.Tensor:
    """inside 里的 8 连通域，逐帧从 1 编号，非 inside 处为 0。

    不用 scipy 时的路径：每个像素先拿自己的线性下标当标签，然后反复把邻域最大
    下标吸进来（并跳到他持有标签的像素），直到一整块区域收敛到同一个下标；最后
    把下标集合压成紧凑编号。同样每步只扩一格，理由见 ``_flood_from_border``。
    """
    count, height, width = inside.shape
    area = height * width
    zero = torch.zeros((), dtype=torch.float64, device=inside.device)
    index = torch.arange(1, area + 1, dtype=torch.float64, device=inside.device).view(1, height, width)
    labels = torch.where(inside, index, zero)
    limit = max(height, width)
    for _ in range(limit):
        spread = functional.max_pool2d(
            labels.view(count, 1, height, width), kernel_size=3, stride=1, padding=1
        ).view(count, height, width)
        spread = torch.where(inside, spread, zero)
        # 跳到「最大下标所指向的那个像素自己持有的标签」，一块区域因此很快统一。
        picked = (spread.long().clamp(min=1) - 1).clamp(max=area - 1)
        neighbours = labels.reshape(count, -1).gather(1, picked.reshape(count, -1)).view(count, height, width)
        spread = torch.where(inside, neighbours, zero)
        if torch.equal(spread, labels):
            break
        labels = spread
    # 压成 1..N 的紧凑编号
    _unique_labels, compact = torch.unique(labels, return_inverse=True)
    return compact.view(count, height, width).long()


def _component_sizes(labels: torch.Tensor) -> torch.Tensor:
    """每个编号的像素数，长度 = 最大编号 + 1。"""
    counts = torch.bincount(labels.reshape(-1))
    return counts


def fill_mask_holes(mask: torch.Tensor, max_hole_size: float = 0.0) -> torch.Tensor:
    """填掉被遮罩整圈围住的空洞。

    碰到画布边缘的空洞永远不算空洞 —— 它是背景，只是绕了回来。

    给了 ``max_hole_size``（占整幅面积的百分比）就只填到这个大小为止，这样漏刷
    的缝隙会被补上，而故意没选的人或宠物会留在外面。
    """
    solid = mask >= 0.5
    limit = _hole_limit(max_hole_size, int(mask.shape[-2]), int(mask.shape[-1]))
    if limit is None:
        filled = _fill_every_hole(solid)
    else:
        filled = _fill_small_holes(solid, limit)
    return torch.maximum(mask, filled.to(mask.dtype))


def _hole_limit(max_hole_size: float, height: int, width: int):
    """要填的最大空洞（像素数）；None 表示全填。

    ``max_hole_size`` 是占整幅面积的百分比。0 表示不限，100 及以上也不限（没有
    哪个洞比整幅还大），不是数字的同样不限。
    """
    percent = float(max_hole_size)
    if not math.isfinite(percent) or percent <= 0.0 or percent >= 100.0:
        return None
    return percent / 100.0 * height * width


def _hole_mask(solid: torch.Tensor) -> torch.Tensor:
    """被围住的背景，逐帧。"""
    background = ~solid
    outside = _flood_from_border(background)
    return background & ~outside


def _fill_every_hole(solid: torch.Tensor) -> torch.Tensor:
    if _scipy_fill_holes is not None:
        return torch.stack(
            [torch.from_numpy(_scipy_fill_holes(layer.cpu().numpy())) for layer in solid]
        ).to(solid.device)
    return solid | _hole_mask(solid)


def _fill_small_holes(solid: torch.Tensor, limit: float) -> torch.Tensor:
    """只填不超过 limit 个像素的封闭空洞，逐帧。"""
    frames = []
    for layer in solid:
        raise_if_interrupted()
        if _scipy_fill_holes is not None and _scipy_label is not None:
            # scipy 一次给出全部孔洞（4 连通），比下面逐格泛洪快几个数量级 ——
            # 1080p 上后者要跑上千轮。
            array = layer.cpu().numpy()
            labels = torch.from_numpy(_scipy_label(_scipy_fill_holes(array) & ~array)[0]).long()
        else:
            holes = _hole_mask(layer.unsqueeze(0))[0]
            if not bool(holes.any()):
                frames.append(layer)
                continue
            labels = _label_blocks(holes.unsqueeze(0))[0].cpu()
        sizes = torch.bincount(labels.reshape(-1))
        keep = sizes <= limit
        keep[0] = False  # 0 是「不是洞」
        # 🔴 keep 和 labels 都在 CPU 上算出来（scipy 从 numpy 来，_label_blocks 也
        #    显式 .cpu()），但 layer 在可能是 GPU。PyTorch 只允许索引张量「在 CPU
        #    或与被索引张量同设备」—— 只把 labels 搬过去、把 keep 留在 CPU，就是
        #    "indices should be either on cpu or on the same device as the indexed
        #    tensor"。两边一起搬。
        keep = keep.to(layer.device)
        frames.append(layer | keep[labels.to(layer.device)])
    return torch.stack(frames).to(solid.device)


def _gaussian_kernel(sigma: float, device) -> torch.Tensor:
    radius = max(1, int(math.ceil(float(sigma) * 3.0)))
    coords = torch.arange(-radius, radius + 1, dtype=torch.float32, device=device)
    kernel = torch.exp(-(coords**2) / (2.0 * float(sigma) ** 2))
    return kernel / kernel.sum()


def blur_mask(mask: torch.Tensor, sigma: float) -> torch.Tensor:
    """高斯羽化。两趟一维卷积而不是一次二维，代价从 r² 降到 2r。

    边缘用 replicate：画布外继续延伸最边上那一列，羽化才不会在画面边框处
    凭空压出一道黑边。
    """
    sigma = float(sigma)
    if sigma <= 0.0:
        return mask
    radius = max(1, int(math.ceil(sigma * 3.0)))
    kernel = _gaussian_kernel(sigma, mask.device)
    blurred = mask.unsqueeze(1)
    blurred = functional.pad(blurred, (radius, radius, 0, 0), mode="replicate")
    blurred = functional.conv2d(blurred, kernel.view(1, 1, 1, -1))
    blurred = functional.pad(blurred, (0, 0, radius, radius), mode="replicate")
    blurred = functional.conv2d(blurred, kernel.view(1, 1, -1, 1))
    return blurred.squeeze(1)


def smooth_mask(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    """把阶梯状的锯齿化开，但边缘仍然是硬的。

    做法是：按 0.5 二值化 → 用 sigma≈pixels 的高斯模糊 → 再按 0.5 二值化，然后
    只把「这一步带来的变化」加回原遮罩。所以它自己不引入任何软度，能把分割出的
    锯齿边磨平而不羽化。

    加变化量而不是直接换成二值结果，是为了让本来就软的遮罩（抠图结果、上游羽化
    过的）保住它的软边。对二值遮罩，变化量就是全部变化，结果与直接取阈值逐位
    相同。
    """
    steps = int(pixels)
    if steps <= 0:
        return mask
    solid = (mask >= 0.5).to(mask.dtype)
    melted = (blur_mask(solid, float(steps)) >= 0.5).to(mask.dtype)
    return (mask + (melted - solid)).clamp(0.0, 1.0)


EDGE_REFINE_MODES = ("off", "guided filter", "matting")

_GUIDED_FILTER_HINT = (
    "Mask Refine edge_refine 'guided filter' needs opencv-contrib-python in "
    "ComfyUI's python. Install that package (not plain opencv-python: the "
    "contrib build is the one with cv2.ximgproc), then restart ComfyUI."
)
_MATTING_HINT = (
    "Mask Refine edge_refine 'matting' needs the pymatting package in ComfyUI's "
    "python. Install pymatting, then restart ComfyUI."
)


def _optional_import(module_name: str):
    """按需导入可选依赖；测试会替掉这个函数。"""
    import importlib

    return importlib.import_module(module_name)


def _load_guided_filter():
    try:
        cv2 = _optional_import("cv2")
    except ImportError as exc:
        raise RuntimeError(_GUIDED_FILTER_HINT) from exc
    ximgproc = getattr(cv2, "ximgproc", None)
    if ximgproc is None or not hasattr(ximgproc, "guidedFilter"):
        # 普通 opencv-python 不带 contrib 的 ximgproc。
        raise RuntimeError(_GUIDED_FILTER_HINT)
    return ximgproc.guidedFilter


def _load_alpha_matting():
    try:
        pymatting = _optional_import("pymatting")
    except ImportError as exc:
        raise RuntimeError(_MATTING_HINT) from exc
    estimate = getattr(pymatting, "estimate_alpha_cf", None)
    if estimate is None:
        raise RuntimeError(_MATTING_HINT)
    return estimate


def _edge_radius(expand: int) -> int:
    """在边缘处工作的半径，随遮罩移动的距离放大。"""
    return max(4, 2 * abs(int(expand)))


def _guide_frames(guide_image, count: int, height: int, width: int) -> torch.Tensor:
    """校验 guide_image 与遮罩批次是否配套，返回 BHWC 的 RGB 帧。"""
    if (
        not isinstance(guide_image, torch.Tensor)
        or guide_image.ndim != 4
        or guide_image.shape[-1] < 3
    ):
        raise ValueError("Mask Refine expected guide_image as a BHWC RGB IMAGE batch.")
    if tuple(guide_image.shape[1:3]) != (height, width):
        raise ValueError(
            "Mask Refine guide_image is %dx%d but the mask is %dx%d; connect the "
            "image the mask belongs to."
            % (int(guide_image.shape[2]), int(guide_image.shape[1]), width, height)
        )
    if int(guide_image.shape[0]) not in {1, count}:
        raise ValueError(
            "Mask Refine needs one guide frame for the whole mask batch or one per mask."
        )
    frames = guide_image[..., :3]
    if int(frames.shape[0]) == 1 and count > 1:
        # 视图展开，不复制；每帧在用到时才 float() 一份，整批复制会跟求解同时驻留。
        frames = frames.expand(count, -1, -1, -1)
    return frames


def guided_filter_refine(mask: torch.Tensor, guide_image, expand: int) -> torch.Tensor:
    """用边缘感知滤波把遮罩边贴到导向图的边上。"""
    guided_filter = _load_guided_filter()
    count, height, width = mask.shape
    guides = _guide_frames(guide_image, count, height, width)
    radius = _edge_radius(expand)
    frames = []
    for index in range(count):
        raise_if_interrupted()
        guide = guides[index].detach().float().clamp(0.0, 1.0).contiguous().cpu().numpy()
        source = mask[index].detach().float().contiguous().cpu().numpy()
        frames.append(torch.from_numpy(guided_filter(guide, source, radius, 1e-4)))
    return torch.stack(frames).to(device=mask.device, dtype=mask.dtype).clamp(0.0, 1.0)


def matting_refine(mask: torch.Tensor, guide_image, expand: int) -> torch.Tensor:
    """在遮罩边缘附近做闭式 alpha 抠图。

    二值化后按边缘半径腐蚀得到的区域是确定前景，膨胀得到的边界之外是确定背景，
    中间那条带交给 pymatting 的 ``estimate_alpha_cf`` 对着导向图求解。
    """
    estimate_alpha_cf = _load_alpha_matting()
    count, height, width = mask.shape
    guides = _guide_frames(guide_image, count, height, width)
    band = _edge_radius(expand)
    # 形态学整批做一次，不进循环：池化本来就是逐样本的，批处理逐位相同，
    # 而在循环里重建 trimap 等于把腐蚀/膨胀算了 count 遍。
    alpha_all = mask.detach().float().cpu()
    solid_all = (alpha_all >= 0.5).float()
    eroded_all = grow_shrink_mask(solid_all, -band) >= 0.5
    dilated_all = grow_shrink_mask(solid_all, band) >= 0.5
    frames = []
    for index in range(count):
        raise_if_interrupted()
        alpha_in = alpha_all[index]
        # 确定前景必须在拿到的遮罩里是不透明的；带任何 alpha 的都至少是「可能
        # 前景」。对二值遮罩，这两条正好退化成腐蚀与膨胀的形状；对羽化过的
        # 遮罩，软斜坡会把未知带撑宽 —— 这正是让 blur 那个控件能影响到求解、
        # 而不是被阈值又抹掉的原因。
        sure_fg = eroded_all[index] & (alpha_in >= 1.0 - _SOFT_EPSILON)
        possible = dilated_all[index] | (alpha_in > _SOFT_EPSILON)
        unknown = possible & ~sure_fg
        if not bool(unknown.any()) or not bool(sure_fg.any()) or bool(possible.all()):
            # 退化 trimap（空遮罩 / 全幅遮罩 / 被带子整个吞掉的形状）：这一帧原样
            # 交回去，别硬解一个没意义的方程。
            frames.append(alpha_in)
            continue
        trimap = torch.full((height, width), 0.5, dtype=torch.float64)
        trimap[~possible] = 0.0
        trimap[sure_fg] = 1.0
        guide = (
            guides[index].detach().float().clamp(0.0, 1.0).contiguous().cpu().numpy().astype("float64")
        )
        alpha = estimate_alpha_cf(guide, trimap.numpy())
        frames.append(torch.from_numpy(alpha).float())
    return torch.stack(frames).to(device=mask.device, dtype=mask.dtype).clamp(0.0, 1.0)


def remap_mask(mask: torch.Tensor, black_point: float, white_point: float) -> torch.Tensor:
    """色阶重映射：黑场及以下归 0，白场及以上归 1，中间线性重标。

    软分割或羽化留下的灰雾靠它清掉。
    """
    black = float(black_point)
    white = float(white_point)
    if black <= 0.0 and white >= 1.0:
        return mask
    span = max(white - black, 1e-6)  # 两点重合时退化成阈值
    return ((mask - black) / span).clamp(0.0, 1.0)


def refine_mask(
    mask: torch.Tensor,
    expand: int,
    blur: float,
    fill_holes: bool,
    smooth: int = 0,
    black_point: float = 0.0,
    white_point: float = 1.0,
    edge_refine: str = "off",
    guide_image=None,
    max_hole_size: float = 0.0,
):
    """扩张 → 补洞 → 平滑 → 羽化 → 边缘细化 → 色阶，返回 (遮罩, 反相遮罩)。"""
    if edge_refine not in EDGE_REFINE_MODES:
        raise ValueError(
            "Mask Refine edge_refine must be one of %s, not '%s'."
            % (list(EDGE_REFINE_MODES), edge_refine)
        )
    if edge_refine != "off" and guide_image is None:
        raise ValueError(
            "Mask Refine edge_refine '%s' needs the guide_image input; connect the "
            "RGB image the mask belongs to, or set edge_refine back to 'off'." % edge_refine
        )
    refined = _as_bhw(mask)
    if (
        isinstance(guide_image, torch.Tensor)
        and guide_image.ndim == 4
        and tuple(guide_image.shape[1:3]) != tuple(refined.shape[1:])
        and is_unpainted_mask(refined)
    ):
        raise ValueError(NO_MASK_PAINTED)
    refined = grow_shrink_mask(refined, expand)
    if fill_holes:
        refined = fill_mask_holes(refined, max_hole_size)
    refined = smooth_mask(refined, int(smooth))
    refined = blur_mask(refined, blur).clamp(0.0, 1.0)
    if edge_refine == "guided filter":
        refined = guided_filter_refine(refined, guide_image, expand)
    elif edge_refine == "matting":
        refined = matting_refine(refined, guide_image, expand)
    refined = remap_mask(refined, black_point, white_point)
    return refined, 1.0 - refined


__all__ = [
    "EDGE_REFINE_MODES",
    "NO_MASK_PAINTED",
    "blur_mask",
    "fill_mask_holes",
    "grow_shrink_mask",
    "guided_filter_refine",
    "is_unpainted_mask",
    "matting_refine",
    "refine_mask",
    "remap_mask",
    "smooth_mask",
]

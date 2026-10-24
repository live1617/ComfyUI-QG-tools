# -*- coding: utf-8 -*-
"""QG_ColorMatch — 把参考图配色搬到目标图上（颜色迁移 / colour transfer）。

IMAGE + 参考 IMAGE → IMAGE。九种方法（另加一个仅均值），全部是公开算法的
**自写实现**，纯 torch，不依赖 OpenCV / scikit-image / numpy：

  * ``小波变换`` —— Haar 小波分解 3 层，只匹配最低频子带的均值 / 方差，
    细节子带原样保留。色调换掉、纹理和边缘不动，适合有大量细节的素材。
  * ``自适应实例统一化`` —— AdaIN：逐通道 ``(x - μ) / σ * σr + μr``，在 sRGB 上做
    （莱因哈德是同一个式子走 CIELAB）。更"硬"，同源素材或风格化迁移更直接。
  * ``最大均值差异`` —— RBF 核下的 MMD：在核均值嵌入空间里最小化源分布与参考分布
    的距离，迭代求出一组仿射映射 ``y = A x + b``（12 个参数，与图像大小无关）。
    参考分布是多峰、不像高斯时比协方差法更贴。
  * ``直方图匹配`` —— 逐通道按分位数做 CDF 匹配。三个通道的边缘分布完全对上。
  * ``莱因哈德色彩迁移`` —— Reinhard et al. 2001 的经典做法：CIELAB 里逐通道
    ``(x - μs) / σs * σr + μr``。最通用。
  * ``多元高斯分布`` —— LAB 3x3 协方差匹配（Pitié 2007 线性 MKL 的核心：
    白化再着色），连带通道相关性一起纠正，修色偏最干净。
  * ``直方图匹配-多元高斯分布-直方图匹配`` —— 三步串联：先用直方图把边缘分布
    拉近，再用高斯匹配纠正相关性，最后再直方图收尾，边缘分布对得更准。
  * ``直方图匹配-最大均值差异-直方图匹配`` —— 同上，中段换成核均值匹配。
  * ``Reinhard Lab GPU算法`` —— 与莱因哈德同一数学，但走整批 4D 张量广播，
    没有逐帧 Python 循环，大图 / 长批次明显更快。
  * ``仅均值`` —— 只搬平均色，不动对比度。最保守。

统一点：

  * LAB 取 D65 白点，走 sRGB → 线性 → XYZ → Lab，逆变换后 clamp 回 ``[0, 1]``。
  * 「强度」是结果与原始图的线性混合：0 = 原图，1 = 完全匹配。
  * 「遮罩」是**作用区域**：遮罩内应用匹配，遮罩外保留原图（白 = 改，黑 = 不动）。
  * 「参考取帧」决定参考图是批次时怎么取：全部帧并成一个样本池 / 只用第一帧 /
    逐帧对应。统计量与图像尺寸无关，参考图不需要和目标图同尺寸。
  * alpha 通道原样带出去。
"""

import contextlib

import torch
import torch.nn.functional as F
from ._qg_combo_legacy import combo_legacy

# sRGB <-> XYZ (D65) —— IEC 61966-2-1 的标准矩阵
RGB_TO_XYZ = (
    (0.4124564, 0.3575761, 0.1804375),
    (0.2126729, 0.7151522, 0.0721750),
    (0.0193339, 0.1191920, 0.9503041),
)
XYZ_TO_RGB = (
    (3.2404542, -1.5371385, -0.4985314),
    (-0.9692660, 1.8760108, 0.0415560),
    (0.0556434, -0.2040259, 1.0572252),
)
# D65 白点
WHITE_X, WHITE_Z = 0.95047, 1.08883

# Lab 归一化尺度：L 0..100 → 0..1，a/b ±128 → ±1。让协方差矩阵三个维度量纲一致，
# 否则 L 的方差比 a/b 大两个数量级，eigh 出来的变换矩阵会被 L 主导。
L_SCALE, AB_SCALE = 100.0, 128.0

METHODS = (
    "wavelet",
    "adain",
    "mmd",
    "histogram",
    "reinhard",
    "mvgd",
    "histogram-mvgd-histogram",
    "histogram-mmd-histogram",
    "reinhard-lab-gpu",
    "mean-only",
)
REF_MODES = ("all-merged", "first-frame", "per-frame")
# 源侧（目标图）统计口径：逐帧各自算 / 整批合成一套
SRC_MODES = ("per-frame", "whole-batch")
# 匹配范围：明暗 + 色度 / 只换色度 / 只换明暗
SCOPES = ("all", "chroma-only", "luma-only")
# 遮罩的用途：只限制作用区域，还是连目标侧统计量也只取遮罩内
MASK_USES = ("result-only", "also-restrict-reference")

# 对外是十个方法名，对内是八种基础步骤的组合。链式方法按顺序依次作用，
# 参考侧的统计量各算一次、全链复用。
CHAINS = {
    "wavelet": ("wavelet",),
    "adain": ("adain",),
    "mmd": ("mmd",),
    "histogram": ("hist",),
    "reinhard": ("std",),
    "mvgd": ("mvgd",),
    "histogram-mvgd-histogram": ("hist", "mvgd", "hist"),
    "histogram-mmd-histogram": ("hist", "mmd", "hist"),
    "reinhard-lab-gpu": ("std_gpu",),
    "mean-only": ("mean",),
}
# 需要 2D 结构（不能拍平成 (N,3)）的步骤
IMAGE_STEPS = ("wavelet",)
# AdaIN 与 Reinhard GPU 版都走整批 4D 广播，各自单独一条路径
BATCH_STEPS = ("adain", "std_gpu")

# 标准差 / 协方差的下限，防止纯色参考（σ = 0）把结果放大成噪声
EPS = 1e-4
# 源侧标准差下限（归一化 L 的 2%，约 5/255）。只给「源」设下限：参考侧照实取，
# 不然会把对比度目标一起抬起来。低对比素材（雾、纯色背景、欠曝暗部）σ 可能只有
# 0.005，不设限就会按 σ_ref/σ_src ≈ 50 倍放大，噪声和色阶一起炸出来。
STD_FLOOR = 0.02
# 参考样本池的上限：再大统计量也不会变，但排序 / 建表会明显变慢
POOL_LIMIT = 200_000
# MMD 拟合用的样本数（目标侧 / 参考侧各这么多，够表达分布且核矩阵不至于太大）
MMD_SAMPLES = 512
MMD_ITERS = 60
MMD_LR = 0.05
# 统计量锚定：RBF 核宽于三倍带宽后距离贡献趋近 0，纯核目标在平坦区会乱走
# （实测 30 步时分布被撑到参考的 1.5 倍方差）。加一项逐通道均值 / 标准差的
# 偏差，等于给 12 个参数一个重力中心，不影响核目标本身。
MMD_ANCHOR = 2.0
# 小波分解层数
WAVELET_LEVELS = 3


def _to_batch(x):
    """(H, W, C) → (1, H, W, C)，并记下是否要压回去。"""
    if x.dim() == 3:
        return x.unsqueeze(0), True
    return x, False


def _rgb_to_lab_norm(rgb):
    """sRGB (B, H, W, 3) in [0, 1] → 归一化 Lab (B, H, W, 3)。"""
    lin = torch.where(
        rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055).clamp_min(0.0).pow(2.4)
    )
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    x = (r * RGB_TO_XYZ[0][0] + g * RGB_TO_XYZ[0][1] + b * RGB_TO_XYZ[0][2]) / WHITE_X
    y = r * RGB_TO_XYZ[1][0] + g * RGB_TO_XYZ[1][1] + b * RGB_TO_XYZ[1][2]
    z = (r * RGB_TO_XYZ[2][0] + g * RGB_TO_XYZ[2][1] + b * RGB_TO_XYZ[2][2]) / WHITE_Z

    def f(t):
        # t <= 0.008856 时走线性段，同时把负值挡在立方根之外（否则出 NaN）
        return torch.where(t > 0.008856, t.clamp_min(0.0).pow(1.0 / 3.0), 7.787 * t + 16.0 / 116.0)

    fx, fy, fz = f(x), f(y), f(z)
    light = 116.0 * fy - 16.0
    aa = 500.0 * (fx - fy)
    bb = 200.0 * (fy - fz)
    return torch.stack([light / L_SCALE, aa / AB_SCALE, bb / AB_SCALE], dim=-1)


def _lab_norm_to_linear(lab):
    """归一化 Lab (B, H, W, 3) → 线性 sRGB（可能出界）。"""
    light = lab[..., 0] * L_SCALE
    aa = lab[..., 1] * AB_SCALE
    bb = lab[..., 2] * AB_SCALE

    fy = (light + 16.0) / 116.0
    fx = fy + aa / 500.0
    fz = fy - bb / 200.0

    def finv(t):
        t3 = t * t * t
        return torch.where(t3 > 0.008856, t3, (t - 16.0 / 116.0) / 7.787)

    x = finv(fx) * WHITE_X
    y = finv(fy)
    z = finv(fz) * WHITE_Z

    lin_r = x * XYZ_TO_RGB[0][0] + y * XYZ_TO_RGB[0][1] + z * XYZ_TO_RGB[0][2]
    lin_g = x * XYZ_TO_RGB[1][0] + y * XYZ_TO_RGB[1][1] + z * XYZ_TO_RGB[1][2]
    lin_b = x * XYZ_TO_RGB[2][0] + y * XYZ_TO_RGB[2][1] + z * XYZ_TO_RGB[2][2]
    return torch.stack([lin_r, lin_g, lin_b], dim=-1)


def _gamut_clip(lab):
    """出界像素在 LCh 里缩 chroma，保色相、保明度。

    逐通道 clamp 会改掉三原色的比例 —— 也就是改色相，饱和色最明显
    （W3C 色域映射指南把「保色相」列在第一位，宁可降饱和度也不要偏色）。
    沿 LCh 的 C 轴缩放天然保 hue 与 L*，但 Lab→RGB 是三次映射、没法闭式解，
    所以在 ``k ∈ [0, 1]`` 上二分 6 次（精度 1/64，落在界内的是收缩侧的 k，
    所以不会残留超界）。只对真正出界的像素做，正常图一次判据就返回。
    """
    lin = _lab_norm_to_linear(lab)
    bad = ((lin < 0.0) | (lin > 1.0)).any(dim=-1)
    if not bool(bad.any()):
        return lin

    sel = lab[bad]                                    # (M, 3)
    lo = torch.zeros(sel.shape[0], 1, dtype=lin.dtype, device=lin.device)
    hi = torch.ones_like(lo)
    for _ in range(6):
        mid = (lo + hi) * 0.5
        cand = torch.cat([sel[:, :1], sel[:, 1:] * mid], dim=-1)
        cl = _lab_norm_to_linear(cand)
        inside = ((cl >= 0.0) & (cl <= 1.0)).all(dim=-1, keepdim=True)
        lo = torch.where(inside, mid, lo)
        hi = torch.where(inside, hi, mid)

    fixed = _lab_norm_to_linear(torch.cat([sel[:, :1], sel[:, 1:] * lo], dim=-1))
    out = lin.clone()
    out[bad] = fixed
    return out


def _lab_norm_to_rgb(lab):
    """归一化 Lab (B, H, W, 3) → sRGB (B, H, W, 3)。

    出界像素走「保色相缩 chroma」（见 ``_gamut_clip``），最后只兜一次极值
    clamp —— 正常像素在那一步之前就已经在 [0, 1] 里了。
    """
    lin = _gamut_clip(lab)

    srgb = torch.where(
        lin <= 0.0031308,
        lin * 12.92,
        1.055 * lin.clamp_min(0.0).pow(1.0 / 2.4) - 0.055,
    )
    return srgb.clamp(0.0, 1.0)


def _apply_scope(matched, original, scope):
    """匹配范围：只保留要换的通道，另一半还给原图。

    ``仅色度`` 保原图的明暗层次（合成时不想动曝光）；``仅明暗`` 保原图的色彩
    （只想统一对比度/影调）。批量路径（AdaIN / GPU Reinhard）走这里，
    逐帧路径直接在 Lab 里切通道，效果一致。
    """
    m_lab = _rgb_to_lab_norm(matched)
    o_lab = _rgb_to_lab_norm(original)
    if scope == "chroma-only":
        out = torch.cat([o_lab[..., :1], m_lab[..., 1:]], dim=-1)
    else:
        out = torch.cat([m_lab[..., :1], o_lab[..., 1:]], dim=-1)
    return _lab_norm_to_rgb(out)


def _feather_mask(m, px):
    """(B, H, W) 遮罩做可分离高斯羽化；``px`` 是羽化总宽度，0 表示关。"""
    if px <= 0:
        return m
    radius = max(int(px) // 2, 1)
    radius = min(radius, max(min(m.shape[-2], m.shape[-1]) - 1, 1))
    sigma = max(radius / 2.0, 1e-3)
    w = torch.arange(-radius, radius + 1, dtype=m.dtype, device=m.device)
    k = torch.exp(-(w ** 2) / (2.0 * sigma ** 2))
    k = (k / k.sum()).view(1, 1, 1, -1)
    x = m.unsqueeze(1)
    x = F.pad(x, (radius, radius, 0, 0), mode="replicate")
    x = F.conv2d(x, k)
    x = F.pad(x, (0, 0, radius, radius), mode="replicate")
    x = F.conv2d(x, k.view(1, 1, -1, 1))
    return x.squeeze(1).clamp(0.0, 1.0)


def _cov3(x):
    """(N, 3) → 3x3 协方差。"""
    xc = x - x.mean(dim=0, keepdim=True)
    denom = max(x.shape[0] - 1, 1)
    return (xc.transpose(0, 1) @ xc) / denom


def _sqrtm(m, inverse=False):
    """对称半正定矩阵的平方根（或逆平方根），特征值下截到 EPS。

    比 Cholesky 稳：协方差在这种场景下经常接近奇异（大面积同色），
    Cholesky 会直接失败，eigh 只是把那个方向压成 EPS。
    """
    m = (m + m.transpose(0, 1)) * 0.5
    evals, evecs = torch.linalg.eigh(m)
    evals = evals.clamp_min(EPS)
    scale = evals.rsqrt() if inverse else evals.sqrt()
    return (evecs * scale.unsqueeze(0)) @ evecs.transpose(0, 1)


def _ridge_like(x):
    """协方差的岭项：把方差垫到 ``STD_FLOOR²``，等价于给标准差设下限。"""
    return torch.eye(3, dtype=x.dtype, device=x.device) * (STD_FLOOR ** 2)


def _subsample(pool):
    """样本池太大就等距抽样 —— 行优先展平后按 stride 取，空间覆盖是均匀的。"""
    n = pool.shape[0]
    if n <= POOL_LIMIT:
        return pool
    step = (n + POOL_LIMIT - 1) // POOL_LIMIT
    return pool[::step]


# ---- 遮罩 --------------------------------------------------------------------
#
# 遮罩有两种用法，别混在一起：限制「结果作用在哪」和限制「统计量从哪取」。
# 后者来自 Photoshop 的「使用选区计算颜色」：把主体贴进新背景时，背景像素不该
# 参与目标侧的均值 / 协方差，否则主体统计被背景稀释，匹配出来隔着一层灰。


def _mask_bhw(mask, batch, height, width):
    """任意形状的 MASK → (batch, H, W) 的 0–1 权重；尺寸不同就双线性缩放。

    只有一帧就当整批共用（广播），帧数不够就循环取 —— 与参考取帧的宽松口径一致。
    """
    m = mask.to(torch.float32)
    if m.dim() == 3:
        if m.shape[0] == 1 and batch > 1:
            m = m.expand(batch, -1, -1)
        elif m.shape[0] < batch:
            m = m.repeat((batch + m.shape[0] - 1) // m.shape[0], 1, 1)[:batch]
        else:
            m = m[:batch]
    elif m.dim() == 2:
        m = m.unsqueeze(0).expand(batch, -1, -1)
    else:
        raise ValueError("遮罩应该是 (H, W) 或 (B, H, W)")
    if (m.shape[1], m.shape[2]) != (height, width):
        m = F.interpolate(
            m.unsqueeze(1), size=(height, width), mode="bilinear", align_corners=False
        ).squeeze(1)
    return m.clamp(0.0, 1.0)


def _pool_of(rgb, mask=None):
    """(B, H, W, 3) → (N, 3) 样本池；给了遮罩就只取遮罩内（>0.5）的像素。

    遮罩内少于 16 个像素就当遮罩没给 —— 极小的选区算不出可靠统计量，
    硬算出来的是几个像素的噪声，比不限定更糟。
    """
    if mask is None:
        return rgb.reshape(-1, 3)
    keep = mask.reshape(-1) > 0.5
    if int(keep.sum()) < 16:
        return rgb.reshape(-1, 3)
    return rgb.reshape(-1, 3)[keep]


def _high_freq(rgb, radius=2):
    """(B, H, W, 3) → 高于 ``radius`` 尺度的那一层（原图减去盒式模糊）。

    只用来做「细节回填」，见 ``QGColorMatch`` 里的说明。
    """
    x = rgb.permute(0, 3, 1, 2)
    k = 2 * radius + 1
    blur = F.avg_pool2d(F.pad(x, (radius, radius, radius, radius), mode="replicate"), k, 1)
    return (x - blur).permute(0, 2, 3, 1)


# ---- 直方图查表 --------------------------------------------------------------
#
# 逐帧模式用「排序＋按名次赋值」，一次排序就出结果；全批统一模式必须变成
# 「值 → 值」的单调查表，才能把同一套变换套到每一帧上（否则帧与帧之间会闪）。


def _hist_lut(xs, ref_sorted):
    """源侧排序样本 ``xs`` → 对应的目标值（按分位数对齐参考分布）。"""
    m, n = xs.numel(), ref_sorted.numel()
    if m < 2 or n < 2:
        return ref_sorted[:1].expand(m)
    pos = torch.arange(m, dtype=xs.dtype, device=xs.device) / (m - 1) * (n - 1)
    lo = pos.floor().long().clamp(0, n - 1)
    hi = (lo + 1).clamp_max(n - 1)
    frac = pos - lo.to(xs.dtype)
    return ref_sorted[lo] * (1.0 - frac) + ref_sorted[hi] * frac


def _hist_map_lut(x, xs, ys):
    """在单调查表 ``(xs → ys)`` 上做线性插值，``xs`` 允许有重复值。"""
    if xs.numel() < 2:
        return torch.full_like(x, float(ys[0]))
    idx = torch.searchsorted(xs.contiguous(), x.contiguous())
    idx = idx.clamp(1, xs.numel() - 1)
    x0, x1 = xs[idx - 1], xs[idx]
    t = ((x - x0) / (x1 - x0).clamp_min(1e-9)).clamp(0.0, 1.0)
    return ys[idx - 1] + (ys[idx] - ys[idx - 1]) * t


# ---- Haar 小波 --------------------------------------------------------------
#
# 正交归一化 Haar：四个子带各自乘 0.5，逆变换也是 0.5，往返误差是浮点级的。


def _haar_dwt(x):
    """(B, C, H, W) → (LL, (LH, HL, HH))，H/W 必须是偶数。"""
    a = x[:, :, 0::2, 0::2]
    b = x[:, :, 0::2, 1::2]
    c = x[:, :, 1::2, 0::2]
    d = x[:, :, 1::2, 1::2]
    ll = (a + b + c + d) * 0.5
    return ll, ((a - b + c - d) * 0.5, (a + b - c - d) * 0.5, (a - b - c + d) * 0.5)


def _haar_idwt(ll, details):
    """(LL, (LH, HL, HH)) → (B, C, 2H, 2W)。"""
    lh, hl, hh = details
    a = (ll + lh + hl + hh) * 0.5
    b = (ll - lh + hl - hh) * 0.5
    c = (ll + lh - hl - hh) * 0.5
    d = (ll - lh - hl + hh) * 0.5
    out = torch.empty(
        ll.shape[0], ll.shape[1], ll.shape[2] * 2, ll.shape[3] * 2,
        dtype=ll.dtype, device=ll.device,
    )
    out[:, :, 0::2, 0::2] = a
    out[:, :, 0::2, 1::2] = b
    out[:, :, 1::2, 0::2] = c
    out[:, :, 1::2, 1::2] = d
    return out


def _wavelet_match(src, ref, levels=WAVELET_LEVELS):
    """(1, C, H, W) 两份 → 只迁移最低频子带，细节子带原样保留。

    最小图先补到 ``2**levels`` 的倍数（replicate），否则 1x1 / 3x5 这种尺寸
    连一层都分不了；补出来的部分最后裁掉。
    """
    _, _, h, w = src.shape
    k = 2 ** max(levels, 1)

    def prep(z):
        ph, pw = (-z.shape[2]) % k, (-z.shape[3]) % k
        if ph or pw:
            z = F.pad(z, (0, pw, 0, ph), mode="replicate")
        dets = []
        ll = z
        for _ in range(levels):
            ll, det = _haar_dwt(ll)
            dets.append(det)
        return ll, dets

    ll_s, dets = prep(src)
    ll_r, _ = prep(ref)

    m_s = ll_s.mean(dim=(-2, -1), keepdim=True)
    s_s = ll_s.std(dim=(-2, -1), keepdim=True, unbiased=False).clamp_min(EPS)
    m_r = ll_r.mean(dim=(-2, -1), keepdim=True)
    s_r = ll_r.std(dim=(-2, -1), keepdim=True, unbiased=False).clamp_min(EPS)
    ll = (ll_s - m_s) / s_s * s_r + m_r

    for i in range(levels - 1, -1, -1):
        ll = _haar_idwt(ll, dets[i])
    return ll[:, :, :h, :w]


def _masked_stats(x, mask, unify):
    """(B, C, H, W) + (B, H, W) 权重 → 加权均值 / 标准差，形状可直接广播。"""
    batch = x.shape[0]
    if mask.shape[0] == 1 and batch > 1:
        mask = mask.expand(batch, -1, -1)
    w = (mask > 0.5).unsqueeze(1).to(x.dtype)
    dims = (0, 2, 3) if unify else (2, 3)
    total = w.sum(dim=dims, keepdim=True).clamp_min(1.0)
    mu = (x * w).sum(dim=dims, keepdim=True) / total
    var = ((x - mu) ** 2 * w).sum(dim=dims, keepdim=True) / total
    return mu, var.clamp_min(0.0).sqrt().clamp_min(STD_FLOOR)


def _instance_norm(src, ref, ref_mode, unify_src=False, src_mask=None, ref_mask=None):
    """(B, C, H, W) 逐通道实例归一化：把目标的均值 / 标准差对齐到参考。

    AdaIN 与 Reinhard 是同一个式子，区别在色彩空间 —— AdaIN 在 sRGB 上做，
    Reinhard 在 CIELAB 上做，前者更"硬"、后者亮度和色度解耦。
    ``unify_src`` 时源侧统计量按整批算（视频不闪）。
    ``src_mask`` / ``ref_mask`` 给了就只用遮罩内的像素算统计量。
    """
    if src_mask is not None:
        m_s, s_s = _masked_stats(src, src_mask, unify_src)
    elif unify_src:
        m_s = src.mean(dim=(0, 2, 3), keepdim=True)
        s_s = src.std(dim=(0, 2, 3), keepdim=True, unbiased=False).clamp_min(STD_FLOOR)
    else:
        m_s = src.mean(dim=(-2, -1), keepdim=True)
        s_s = src.std(dim=(-2, -1), keepdim=True, unbiased=False).clamp_min(STD_FLOOR)

    if ref_mask is not None:
        ref_nhwc = ref.permute(0, 2, 3, 1)
        rmask = _mask_bhw(ref_mask, ref.shape[0], ref.shape[2], ref.shape[3])
        if ref_mode == "per-frame":
            ms, ss = [], []
            for k in range(ref.shape[0]):
                pool = _pool_of(ref_nhwc[k:k + 1], rmask[k:k + 1])
                ms.append(pool.mean(dim=0))
                ss.append(pool.std(dim=0, unbiased=False))
            m_all = torch.stack(ms).view(-1, 3, 1, 1)
            s_all = torch.stack(ss).clamp_min(EPS).view(-1, 3, 1, 1)
            idx = torch.arange(src.shape[0], device=src.device) % ref.shape[0]
            m_r, s_r = m_all[idx], s_all[idx]
        else:
            pick = slice(None) if ref_mode == "all-merged" else slice(0, 1)
            pool = _pool_of(ref_nhwc[pick], rmask[pick])
            m_r = pool.mean(dim=0).view(1, 3, 1, 1)
            s_r = pool.std(dim=0, unbiased=False).view(1, 3, 1, 1).clamp_min(EPS)
    elif ref_mode == "per-frame":
        m_r = ref.mean(dim=(-2, -1), keepdim=True)
        s_r = ref.std(dim=(-2, -1), keepdim=True, unbiased=False).clamp_min(EPS)
        idx = torch.arange(src.shape[0], device=src.device) % ref.shape[0]
        m_r, s_r = m_r[idx], s_r[idx]
    else:
        pool = ref if ref_mode == "all-merged" else ref[0:1]
        flat = pool.permute(0, 2, 3, 1).reshape(-1, 3)
        m_r = flat.mean(dim=0).view(1, 3, 1, 1)
        s_r = flat.std(dim=0, unbiased=False).view(1, 3, 1, 1).clamp_min(EPS)

    return (src - m_s) / s_s * s_r + m_r


# ---- MMD：RBF 核的最大均值差异 -------------------------------------------------
#
# 直接在像素上做核回归（把每个颜色换成参考分布的核加权期望）会严重收窄分布 ——
# E[Y|X] 的方差不可能大于 Y 的方差，实测输出 σ 只剩参考的四分之一，画面发灰。
# 所以改成在 MMD 目标下迭代求一个仿射映射 y = A x + b：分布一阶 / 二阶都对得上，
# 图像自身的局部结构原样保留（仿射不改相对层次）。


@contextlib.contextmanager
def _fit_grad():
    """迭代求映射参数用的梯度上下文。

    ComfyUI 在 ``torch.inference_mode()`` 里执行节点（``execution.py``），那里
    autograd 是关的、张量是推理张量：``requires_grad_(True)`` 会被静默忽略，
    接着 ``backward()`` 报「does not require grad and does not have a grad_fn」。
    所以这里得**临时退出推理模式**，并在退出后重新克隆输入（推理张量不能存
    backward 的中间结果）。老版本 torch 没有 ``inference_mode(False)`` 的嵌套
    语义，退化成只开 ``enable_grad``。
    """
    inference_mode = getattr(torch, "inference_mode", None)
    if inference_mode is None:
        with torch.enable_grad():
            yield
        return
    with inference_mode(False), torch.enable_grad():
        yield


def _knn_bandwidth(pool, k=10):
    """按每个点到第 k 近邻的距离取中位数当核宽 —— 比全局中位距离稳得多，
    全局中位数会被分布的跨度带偏（实测 0.35 vs 0.07，差 5 倍）。"""
    n = pool.shape[0]
    if n > 400:
        pool = pool[:: max(1, n // 400)][:400]
        n = pool.shape[0]
    if n < 2:
        return pool.new_tensor(0.1)
    d = torch.cdist(pool, pool)
    d.fill_diagonal_(float("inf"))
    k = max(1, min(k, n - 1))
    return d.kthvalue(k, dim=1).values.median().clamp_min(0.01)


def _mmd_fit(src_pool, ref_pool, iters=MMD_ITERS, lr=MMD_LR, anchor=MMD_ANCHOR):
    """在 RBF 核下最小化 MMD²(P', Q)，P' 是 src_pool 经仿射变换后的分布。

    MMD² 展开后只需要最小化 ``E k(y,y) - 2 E k(y,x)``（另外两项与参数无关）。
    参数只有 3x3 的 A 和 3 维的 b，12 个，Adam 几十步就收敛，全图只是最后
    乘一次矩阵，跟图像大小无关。
    """
    dtype = src_pool.dtype
    with _fit_grad():
        # 退出推理模式后重新克隆，才拿得到能参与求导的普通张量；
        # 求导本身在 float32 上做（半精度跑 Adam 会掉到不动）。
        src_pool = src_pool.detach().clone().float()
        ref_pool = ref_pool.detach().clone().float()
        bw = _knn_bandwidth(ref_pool)
        two_h2 = 2.0 * bw * bw
        mean_r = ref_pool.mean(dim=0)
        std_r = ref_pool.std(dim=0, unbiased=False).clamp_min(EPS)
        a = torch.eye(3, dtype=src_pool.dtype, device=src_pool.device).requires_grad_(True)
        b = torch.zeros(3, dtype=src_pool.dtype, device=src_pool.device).requires_grad_(True)
        opt = torch.optim.Adam([a, b], lr=lr)
        for _ in range(iters):
            opt.zero_grad()
            y = src_pool @ a.transpose(0, 1) + b
            k_yy = torch.exp(-torch.cdist(y, y).pow(2) / two_h2).mean()
            k_yx = torch.exp(-torch.cdist(y, ref_pool).pow(2) / two_h2).mean()
            drift = (
                (y.mean(dim=0) - mean_r).abs().mean()
                + (y.std(dim=0, unbiased=False) - std_r).abs().mean()
            )
            loss = k_yy - 2.0 * k_yx + anchor * drift
            if not torch.isfinite(loss):
                break
            loss.backward()
            opt.step()
        a, b = a.detach(), b.detach()
    return a.to(dtype), b.to(dtype)


@combo_legacy("QG_ColorMatch")
class QGColorMatch:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Brings the reference picture's color onto the target: the target keeps its "
        "own composition and light-and-dark structure and only takes the reference's "
        "hue, contrast and overall cast. Nine methods - wavelet (low frequencies "
        "only, texture untouched), adaptive instance normalization (AdaIN, on sRGB), "
        "maximum mean discrepancy (kernel mean matching), histogram matching "
        "(distributions aligned exactly), Reinhard color transfer (the "
        "general-purpose one), multivariate Gaussian (corrects channel correlations "
        "as well), two three-step chains, and a whole-batch GPU implementation of "
        "Reinhard; plus mean-only, which moves nothing but the average color and is "
        "the most conservative. Strength mixes the result with the original, and "
        "scope can swap only chroma or only luminance; a mask limits both the area "
        "that changes and the pixels the statistics are taken from, and the reference "
        "can take a mask of its own to restrict its statistics; detail restore brings "
        "high frequencies back to the original's level (what got smoothed away comes "
        "back, what got boosted is pulled down). A reference batch can be pooled, "
        "taken from its first frame, or matched frame by frame, and a target batch "
        "can use one pooled set of statistics so the frames do not flicker. "
        "Everything runs in float with no 8-bit round trip, and colors that leave the "
        "gamut shrink their chroma along LCh (hue preserved) instead of being "
        "clipped, so gradients keep their steps smooth and saturated areas keep their "
        "hue."
    )
    SEARCH_ALIASES = [
        "color match", "colour match", "color transfer", "colour transfer",
        "color matching", "colour matching", "match color", "recolor",
        "palette transfer", "color harmonization", "colour harmonization",
        "reference color", "reinhard", "mkl", "histogram match", "hist match",
        "wavelet", "adain", "mmd", "mvgd", "gaussian transfer",
        "color regrain", "detail restore", "regional statistics",
        "颜色匹配", "色彩匹配", "颜色迁移", "色彩迁移", "配色", "取色", "追色",
        "小波", "直方图匹配", "莱因哈德", "多元高斯", "细节回填", "参考遮罩",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, 
        method=None,
        ref_mode=None,
        src_mode=None,
        scope=None,
        mask_use=None,
    ):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {"tooltip": "The target image to recolor; a batch is processed frame by frame, and an alpha channel is passed through."},
                ),
                "reference": (
                    "IMAGE",
                    {"tooltip": "The reference the color is taken from. It need not match the target's size; only its statistics are used."},
                ),
                "method": (
                    list(METHODS),
                    {
                        "default": "reinhard",
                        "tooltip": (
                            "Reinhard is the general-purpose one; wavelet changes low "
                            "frequencies only and leaves texture alone; AdaIN is the "
                            "per-channel sRGB version and is most direct on material from the "
                            "same source; MMD follows non-Gaussian distributions; histogram "
                            "matching aligns the distributions exactly and is the easiest to "
                            "overdo; multivariate Gaussian also corrects channel correlations; "
                            "the two entries built around a histogram match are three-step "
                            "chains with more accurate marginals; the GPU method is the same "
                            "math as Reinhard, faster on big pictures; mean-only moves nothing "
                            "but the average color."
                        ),
                    },
                ),
                "strength": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.1,
                        "tooltip": (
                            "How much of the result is mixed in: 0 is the original, 1 is a full "
                            "match, and around 0.5 usually looks most natural while keeping "
                            "half of the original's character."
                        ),
                    },
                ),
                "ref_mode": (
                    list(REF_MODES),
                    {
                        "default": REF_MODES[0],
                        "tooltip": (
                            "How a reference batch is read: all frames pooled into one sample "
                            "pool, the first frame only, or frame by frame against the target "
                            "(the reference cycles when it runs short)."
                        ),
                    },
                ),
                "src_mode": (
                    list(SRC_MODES),
                    {
                        "default": SRC_MODES[0],
                        "tooltip": (
                            "How the source statistics are computed for a target batch: per "
                            "frame - one set per frame, closest for a single still; uniform - "
                            "one set for the whole batch, so differences between frames survive "
                            "and the picture does not flicker (use this for video or "
                            "sequences). With a single frame the two are identical."
                        ),
                    },
                ),
                "scope": (
                    list(SCOPES),
                    {
                        "default": SCOPES[0],
                        "tooltip": (
                            "What gets matched: all - both luminance and chroma; chroma only - "
                            "keeps the original's light-and-dark structure and swaps only the "
                            "hue (compositing, or when exposure must not move); luminance only "
                            "- keeps the original's hue and swaps contrast and overall "
                            "brightness."
                        ),
                    },
                ),
                "feather": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 256,
                        "step": 1,
                        "tooltip": "Feather width of the mask, in pixels: 0 is a hard edge; with a mask, 8-32 makes the seam disappear.",
                    },
                ),
                "mask_use": (
                    list(MASK_USES),
                    {
                        "default": MASK_USES[0],
                        "tooltip": (
                            "How the mask is used: result only - it limits where the match "
                            "applies while the statistics still come from the whole picture; "
                            "target stats too - the target's mean, standard deviation and "
                            "histogram also come from inside the mask, so pasting a subject "
                            "onto another background stops the background from diluting its "
                            "statistics."
                        ),
                    },
                ),
                "detail": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": (
                            "Detail restore: brings high frequencies (texture, grain, edge "
                            "sharpness) back to the original's level - what the match smoothed "
                            "away is put back, what it boosted is pulled down. Try 0.3-0.6 when "
                            "histogram matching turns gradients into bands or blows up noise in "
                            "a low-contrast picture; 0 leaves it alone. Only the difference is "
                            "restored, so overall brightness does not move."
                        ),
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {"tooltip": "Where the match applies: white areas are matched, black areas keep the original; leave it unwired for the whole picture."},
                ),
                "ref_mask": (
                    "MASK",
                    {
                        "tooltip": (
                            "Statistics area on the reference: only white pixels take part. "
                            "Wire one when the reference carries large irrelevant areas (sky, "
                            "background, a watermark) so the color is not dragged toward them."
                        )
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The matched image, same size and batch count as the target.",
    )
    FUNCTION = "color_match"

    # ---- 参考侧 -------------------------------------------------------------

    @staticmethod
    def _ref_image(reference, index, mode):
        """给图像类步骤（小波 / AdaIN）用的单帧参考 (1, C, H, W)。"""
        if mode == "per-frame":
            return reference[index % reference.shape[0]].unsqueeze(0)
        if mode == "first-frame":
            return reference[0:1]
        # 全部合并：同尺寸就取平均，尺寸都不同就只能退回第一帧
        return reference.mean(dim=0, keepdim=True) if reference.shape[0] > 1 else reference

    @staticmethod
    def _prepare(pool, step, src_pool=None):
        """把参考样本池 (N, 3) 压成一组统计量，供每一帧复用。

        ``src_pool`` 只有 MMD 用得到 —— 它的映射是在「目标分布 ↔ 参考分布」的
        核均值差异上迭代出来的，光有参考侧算不出来。
        """
        pool = _subsample(pool)
        if step == "hist":
            # 排序只做一次，之后每帧的每一通道都是对这张表做分位插值
            return {"sorted": [pool[:, c].sort().values for c in range(3)]}
        mean = pool.mean(dim=0)
        if step == "mean":
            return {"mean": mean}
        if step == "mvgd":
            return {"mean": mean, "cov": _cov3(pool)}
        if step == "mmd":
            ref = pool
            if ref.shape[0] > MMD_SAMPLES:
                ref = ref[:: (ref.shape[0] + MMD_SAMPLES - 1) // MMD_SAMPLES][:MMD_SAMPLES]
            src = _subsample(src_pool) if src_pool is not None else ref
            if src.shape[0] > MMD_SAMPLES:
                src = src[:: (src.shape[0] + MMD_SAMPLES - 1) // MMD_SAMPLES][:MMD_SAMPLES]
            a, b = _mmd_fit(src, ref, MMD_ITERS, MMD_LR)
            return {"a": a, "b": b}
        std = pool.std(dim=0, unbiased=False).clamp_min(EPS)
        return {"mean": mean, "std": std}

    # ---- 平铺路径的四类步骤 -------------------------------------------------

    @staticmethod
    def _src_prep(pool, step):
        """源侧统计量。「全批统一」时整批只算这一份，各帧共用同一个变换。"""
        if step == "hist":
            return {"sorted": [pool[:, c].sort().values for c in range(3)]}
        mean = pool.mean(dim=0, keepdim=True)
        if step == "mvgd":
            return {"mean": mean, "inv": _sqrtm(_cov3(pool) + _ridge_like(pool), inverse=True)}
        std = pool.std(dim=0, unbiased=False).clamp_min(STD_FLOOR)
        return {"mean": mean, "std": std}

    @staticmethod
    def _apply(src, prep, step, base=None):
        """src: (K, 3)；prep: 参考侧统计量；base: 源侧统计量（None = 按当前帧现算）。"""
        if step == "hist":
            if base is not None:
                return torch.stack(
                    [
                        _hist_map_lut(
                            src[:, c], base["sorted"][c],
                            _hist_lut(base["sorted"][c], prep["sorted"][c]),
                        )
                        for c in range(3)
                    ],
                    dim=-1,
                )
            out = torch.empty_like(src)
            n = src.shape[0]
            quant = torch.linspace(0.0, 1.0, n, device=src.device, dtype=src.dtype)
            for c in range(3):
                ref_sorted = prep["sorted"][c]
                m = ref_sorted.shape[0]
                _, order = src[:, c].sort()
                pos = quant * (m - 1)
                lo = pos.floor().long().clamp(0, m - 1)
                hi = (lo + 1).clamp_max(m - 1)
                frac = pos - lo.to(pos.dtype)
                mapped = ref_sorted[lo] * (1.0 - frac) + ref_sorted[hi] * frac
                column = torch.empty(n, device=src.device, dtype=src.dtype)
                column[order] = mapped
                out[:, c] = column
            return out

        if step == "mmd":
            return src @ prep["a"].transpose(0, 1) + prep["b"]

        mean_s = base["mean"] if base is not None else src.mean(dim=0, keepdim=True)
        if step == "mean":
            return src - mean_s + prep["mean"]

        centered = src - mean_s
        if step == "mvgd":
            inv = base["inv"] if base is not None else _sqrtm(
                _cov3(src) + _ridge_like(src), inverse=True
            )
            mat = _sqrtm(prep["cov"]) @ inv
            return centered @ mat.transpose(0, 1) + prep["mean"]

        std_s = base["std"] if base is not None else src.std(dim=0, unbiased=False).clamp_min(STD_FLOOR)
        return centered / std_s * prep["std"] + prep["mean"]

    # ---- 逐帧跑一条处理链 ---------------------------------------------------

    def _run_chain(self, src, reference, chain, ref_mode, src_mode="逐帧", scope="全部",
                   src_mask=None, ref_mask=None):
        """src / reference: (B, H, W, 3) 归一化 Lab → 同形状的匹配结果。

        ``src_mode`` 决定源侧统计量怎么取：``逐帧`` 每帧各算一套（静图更贴），
        ``全批统一`` 整批合成一套（视频/序列不闪，也是 ComfyUI 内置
        ColorTransfer 的 uniform 口径）。两个遮罩各自限定一侧的统计区域。
        """
        batch, height, width = src.shape[0], src.shape[1], src.shape[2]
        cache = {}
        unified = src_mode == "whole-batch" and batch > 1
        src_bmask = (
            _mask_bhw(src_mask, batch, height, width) if src_mask is not None else None
        )
        ref_bmask = (
            _mask_bhw(ref_mask, reference.shape[0], reference.shape[1], reference.shape[2])
            if ref_mask is not None else None
        )
        src_pool = _subsample(_pool_of(src, src_bmask)) if unified else None
        base_cache = {}

        def base_for(step, index):
            if src_pool is not None:
                key = (step, "all")
            elif src_bmask is not None:
                key = (step, index)  # 逐帧 + 遮罩：每帧的统计量都得单独算
            else:
                return None
            if key not in base_cache:
                pool = src_pool if src_pool is not None else _pool_of(
                    src[index:index + 1], src_bmask[index:index + 1]
                )
                base_cache[key] = self._src_prep(_subsample(pool), step)
            return base_cache[key]

        def prep_for(step, index, flat):
            # MMD 的映射依赖目标分布本身；全批统一时这份分布也是整批的，可以复用
            shared = step != "mmd" or src_pool is not None
            key = (step, "all" if ref_mode == "all-merged" else index) if shared else None
            if key is not None and key in cache:
                return cache[key]
            if ref_mode == "all-merged":
                pick = slice(None)
            elif ref_mode == "first-frame":
                pick = slice(0, 1)
            else:
                k = index % reference.shape[0]
                pick = slice(k, k + 1)
            rmask = None if ref_bmask is None else ref_bmask[pick]
            pool = _pool_of(reference[pick], rmask)
            prep = self._prepare(pool, step, src_pool if src_pool is not None else flat)
            if key is not None:
                cache[key] = prep
            return prep

        out = []
        for i in range(batch):
            frame = src[i]
            origin = frame.reshape(-1, 3)
            if chain[0] in IMAGE_STEPS:
                plane = frame.permute(2, 0, 1).unsqueeze(0)  # (1, 3, H, W)
                ref_img = self._ref_image(reference, i, ref_mode).permute(0, 3, 1, 2)
                flat = _wavelet_match(plane, ref_img).squeeze(0).permute(1, 2, 0)
                flat = flat.reshape(-1, 3)
            else:
                flat = origin
                for step in chain:
                    flat = self._apply(flat, prep_for(step, i, flat), step, base_for(step, i))

            # 匹配范围：只留换过来的那一半，另一半还给原图
            if scope == "chroma-only":
                flat = torch.cat([origin[:, :1], flat[:, 1:]], dim=1)
            elif scope == "luma-only":
                flat = torch.cat([flat[:, :1], origin[:, 1:]], dim=1)
            out.append(flat.reshape(frame.shape))
        return torch.stack(out, dim=0)

    # ---- 入口 ---------------------------------------------------------------

    def color_match(self, image, reference, method, strength, ref_mode,
                    src_mode="逐帧", scope="全部", feather=0, mask=None,
                    mask_use="result-only", detail=0.0, ref_mask=None):
        if not torch.is_tensor(image) or not torch.is_tensor(reference):
            raise TypeError("image / reference 需要是 IMAGE 张量")

        x, squeeze = _to_batch(image)
        ref, _ = _to_batch(reference)
        if x.dim() != 4 or ref.dim() != 4:
            raise ValueError("image / reference 应该是 (B, H, W, C)")
        if x.shape[-1] < 3 or ref.shape[-1] < 3:
            raise ValueError("图像至少要有 3 个通道")
        if ref.shape[0] < 1:
            raise ValueError("参考图为空")

        out_dtype = x.dtype
        original = x[..., :3].to(torch.float32)
        alpha = x[..., 3:] if x.shape[-1] > 3 else None
        ref_rgb = ref[..., :3].to(torch.float32)
        unify = src_mode == "whole-batch" and original.shape[0] > 1

        # 统计量要不要受遮罩限制，是两件独立的事：
        # 目标侧看 mask_use，参考侧只看有没有接 ref_mask
        stats_mask = None
        if mask is not None and torch.is_tensor(mask) and mask_use == "also-restrict-reference":
            stats_mask = mask
        if ref_mask is not None and not torch.is_tensor(ref_mask):
            ref_mask = None

        amount = float(strength)
        if amount <= 0.0:
            result = original.clone()
        else:
            chain = CHAINS.get(method, ("std",))
            if chain[0] in BATCH_STEPS:
                # 两步都走整批 4D 广播，一次算完，没有逐帧循环
                if chain[0] == "adain":
                    # AdaIN 在 sRGB 上做
                    matched = _instance_norm(
                        original.permute(0, 3, 1, 2), ref_rgb.permute(0, 3, 1, 2),
                        ref_mode, unify,
                        src_mask=stats_mask, ref_mask=ref_mask,
                    ).permute(0, 2, 3, 1)
                else:
                    # Reinhard 在 CIELAB 上做
                    matched = _lab_norm_to_rgb(
                        _instance_norm(
                            _rgb_to_lab_norm(original).permute(0, 3, 1, 2),
                            _rgb_to_lab_norm(ref_rgb).permute(0, 3, 1, 2),
                            ref_mode, unify,
                            src_mask=stats_mask, ref_mask=ref_mask,
                        ).permute(0, 2, 3, 1)
                    )
                if scope != "全部":
                    matched = _apply_scope(matched, original, scope)
            else:
                matched_lab = self._run_chain(
                    _rgb_to_lab_norm(original), _rgb_to_lab_norm(ref_rgb),
                    chain, ref_mode, src_mode, scope,
                    src_mask=stats_mask, ref_mask=ref_mask,
                )
                matched = _lab_norm_to_rgb(matched_lab)
            result = original + (matched - original) * amount

        keep = float(detail)
        if keep > 0.0:
            # 只补「被磨掉」的那部分高频：原图高频减去结果高频，不会把原有的锐度叠两遍。
            # 直方图匹配把大片渐变拉成色块、或者反过来把噪声拉炸时，这一步把纹理还原到
            # 原图的水平（等价于 WAS 的 regrain，但按差额补而不是按原值补）。
            # 差额先逐通道去均值 —— 补纹理不该顺手改整体明暗。
            delta = _high_freq(original) - _high_freq(result)
            delta = delta - delta.mean(dim=(1, 2), keepdim=True)
            result = result + keep * delta

        result = result.clamp(0.0, 1.0)

        if mask is not None and torch.is_tensor(mask):
            m = _mask_bhw(mask, result.shape[0], result.shape[1], result.shape[2])
            m = _feather_mask(m, int(feather))
            result = original + (result - original) * m.unsqueeze(-1)

        result = result.to(out_dtype)
        if alpha is not None:
            result = torch.cat([result, alpha.to(out_dtype)], dim=-1)
        if squeeze:
            result = result.squeeze(0)
        return (result,)


NODE_CLASS_MAPPINGS = {"QG_ColorMatch": QGColorMatch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ColorMatch": "Color Match"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

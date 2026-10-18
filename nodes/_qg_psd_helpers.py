"""带图层的 PSD，直接从数组写出来。

只写这一种形状：8 位 RGB 图层，尺寸都等于整张图，每层可以带一个图层蒙版，
外加每个 PSD 都有的那张扁平图（给不读图层的程序看）。布局按编辑软件自己
写出来的那份最朴素的来，所以 Photoshop、GIMP 之类打开就是带图层和蒙版的。

文件照格式的顺序一次写完，不压缩：

    文件头 | 颜色模式数据 | 图像资源 | 图层与蒙版 | 扁平图

不压缩让写入器短且准。照片拿这个格式的游程压缩本来也压不了多少，存下来
和编辑软件存的大小差不多：两个图层加一个蒙版是每像素 12 字节。

移植自 ComfyUI-AusBoss（MIT，nodes/_psd_helpers.py）。
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

# PSD 格式自己的上限（.psb 能更大，这里不写那种）。
PSD_MAX_SIDE = 30000
PSD_MAX_LAYERS = 64
# 图层里的长度字段是 32 位，整个图层块要塞进一个。
PSD_MAX_BYTES = 2**31 - 1

RAW = b"\x00\x00"  # 压缩方式 0：原样字节
# 每一阶都参与的通道：来源和去向，0 到 255。
_BLEND_RANGE = b"\x00\x00\xff\xff\x00\x00\xff\xff"


def _plane(array, height: int, width: int, source: str) -> np.ndarray:
    plane = np.ascontiguousarray(array, dtype=np.uint8)
    if plane.shape != (height, width):
        raise ValueError(f"{source} 必须是 {width}x{height}，收到 {plane.shape[1]}x{plane.shape[0]}。")
    return plane


def _rgb(array, source: str) -> np.ndarray:
    rgb = np.ascontiguousarray(array, dtype=np.uint8)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError(f"{source} 必须是 HxWx3 的图。")
    return rgb


def _name(name: str) -> bytes:
    """图层名按格式存：一个长度字节、文本，再补齐到 4 的倍数。"""
    text = str(name or "Layer").encode("ascii", "replace")[:255]
    body = bytes([len(text)]) + text
    return body + b"\x00" * (-len(body) % 4)


def _record(name: str, height: int, width: int, has_mask: bool) -> bytes:
    """图层清单里的一条：放在哪、有哪些通道、怎么混合。"""
    plane_bytes = len(RAW) + height * width
    # 先透明通道，再红绿蓝，最后是图层蒙版。
    channels = [-1, 0, 1, 2] + ([-2] if has_mask else [])
    record = struct.pack(">4iH", 0, 0, height, width, len(channels))
    for channel in channels:
        record += struct.pack(">hI", channel, plane_bytes)
    # 普通混合、完全不透明、不做剪贴。标志位 8：图层可见，像素参与。
    record += b"8BIM" + b"norm" + bytes([255, 0, 8, 0])
    if has_mask:
        # 蒙版盖住整张图；255 是蒙版之外的部分。
        mask = struct.pack(">I4iBBH", 20, 0, 0, height, width, 255, 0, 0)
    else:
        mask = struct.pack(">I", 0)
    ranges = _BLEND_RANGE * 5  # 先是整张图，然后四个通道各一条
    extra = mask + struct.pack(">I", len(ranges)) + ranges + _name(name)
    return record + struct.pack(">I", len(extra)) + extra


def write_psd(path, layers, composite) -> Path:
    """把 ``layers``（最底层在前）和扁平图 ``composite`` 写进 ``path``。

    一层是 ``{"name": str, "rgb": HxWx3 uint8, "mask": HxW uint8 或 None}``。
    蒙版白的地方露出这一层、黑的地方藏起来，和各家编辑软件一致。所有图的
    尺寸必须一样。
    """
    flat = _rgb(composite, "扁平图")
    height, width = flat.shape[:2]
    if not (0 < height <= PSD_MAX_SIDE and 0 < width <= PSD_MAX_SIDE):
        raise ValueError(f"PSD 里图最长边不能超过 {PSD_MAX_SIDE} 像素。")
    layers = list(layers)
    if not 0 < len(layers) <= PSD_MAX_LAYERS:
        raise ValueError(f"这里写的 PSD 支持 1 到 {PSD_MAX_LAYERS} 个图层。")

    records = []
    planes = []
    opaque = np.full((height, width), 255, dtype=np.uint8)
    for index, layer in enumerate(layers):
        source = f"第 {index + 1} 层"
        rgb = _rgb(layer.get("rgb"), source)
        if rgb.shape[:2] != (height, width):
            raise ValueError(f"{source} 必须是 {width}x{height}，和扁平图一样大。")
        mask = layer.get("mask")
        records.append(_record(layer.get("name", ""), height, width, mask is not None))
        planes.append(opaque)
        planes.extend(rgb[:, :, channel] for channel in range(3))
        if mask is not None:
            planes.append(_plane(mask, height, width, f"{source}的蒙版"))

    plane_bytes = len(RAW) + height * width
    layer_info = 2 + sum(len(record) for record in records) + plane_bytes * len(planes)
    padding = layer_info % 2  # 图层清单要收在偶数位上
    layer_info += padding
    if layer_info > PSD_MAX_BYTES:
        raise ValueError("这些图层太大，塞不进一个 PSD 文件。")

    target = Path(path)
    with open(target, "wb") as file:
        # 版本 1、三通道、每通道 8 位、RGB。
        file.write(b"8BPS" + struct.pack(">H6xHIIHH", 1, 3, height, width, 8, 3))
        file.write(struct.pack(">I", 0))  # 没有颜色表
        file.write(struct.pack(">I", 0))  # 没有图像资源
        # 图层块：块长、图层清单，然后是一个空的整份文档蒙版设置。
        file.write(struct.pack(">I", 4 + layer_info + 4))
        file.write(struct.pack(">Ih", layer_info, len(records)))
        for record in records:
            file.write(record)
        for plane in planes:
            file.write(RAW)
            file.write(plane.tobytes())
        file.write(b"\x00" * padding)
        file.write(struct.pack(">I", 0))
        # 扁平图：一个压缩标记，然后红绿蓝。
        file.write(RAW)
        for channel in range(3):
            file.write(np.ascontiguousarray(flat[:, :, channel]).tobytes())
    return target


__all__ = ["PSD_MAX_BYTES", "PSD_MAX_LAYERS", "PSD_MAX_SIDE", "write_psd"]

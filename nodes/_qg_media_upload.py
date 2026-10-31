"""Stream video uploads to ComfyUI's input folder without buffering the body."""

from __future__ import annotations

import asyncio
from pathlib import Path

import av

# 一次上传的上限。流式写盘不占内存，但不限大小等于开了一个「填满磁盘」的
# 入口：这条路由没有认证，任何能连到 ComfyUI 端口的客户端都能反复调。
MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024

# Windows 的设备名。`CON.mp4` 这样的名字 open("xb") 打开的是控制台设备而不是
# 文件 —— 写入挂住、内容进了控制台，随后的 unlink 还删不掉。
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *("COM%d" % index for index in range(1, 10)),
    *("LPT%d" % index for index in range(1, 10)),
}


def upload_name(filename: str, extensions: set[str]) -> str:
    name = str(filename or "")
    if (not name or len(name) > 180 or name in {".", ".."}
            or any(char in name for char in '/\\:')
            or any(ord(char) < 32 for char in name)
            or Path(name).suffix.lower() not in extensions
            or Path(name).stem.rstrip(" .").upper() in _RESERVED_NAMES):
        raise ValueError("Choose a video file with a supported extension and a plain filename.")
    return name


def reserve_upload(root: Path, name: str):
    """Exclusive creation never follows an existing symlink or replaces a file.

    先写 ``<name>.part``，校验通过后再改名。进程被杀时留下的是那个 .part，
    不会有一个截断的 .mp4 出现在视频下拉里（每次预览都解码失败，用户还不知道
    它从哪来的）。
    """
    source = Path(name)
    for counter in range(10000):
        candidate = root / (name if counter == 0 else f"{source.stem}_{counter}{source.suffix}")
        partial = candidate.with_name(candidate.name + ".part")
        try:
            return candidate, partial, partial.open("xb")
        except FileExistsError:
            continue
    raise ValueError("Too many uploads share this filename; rename the video and retry.")


def validate_video(path: Path) -> None:
    with av.open(str(path)) as container:
        if not any(stream.type == "video" for stream in container.streams):
            raise ValueError("The uploaded file does not contain a video stream.")


async def stream_video_upload(request, root: Path, extensions: set[str]) -> dict:
    reader = await request.multipart()
    part = await reader.next()
    if part is None or part.name != "image" or not part.filename:
        raise ValueError("Upload a video in the image form field.")
    name = upload_name(part.filename, extensions)
    path, partial, handle = reserve_upload(root.resolve(), name)
    complete = False
    try:
        written = 0
        while chunk := await part.read_chunk(size=1024 * 1024):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise ValueError(
                    "The video is larger than %d GB."
                    % (MAX_UPLOAD_BYTES // (1024 * 1024 * 1024))
                )
            await asyncio.to_thread(handle.write, chunk)
        handle.close()
        await asyncio.to_thread(validate_video, partial)
        # 校验过了才让它出现在 input/ 里。
        partial.rename(path)
        complete = True
        return {"name": path.name, "subfolder": "", "type": "input"}
    finally:
        handle.close()
        if not complete:
            partial.unlink(missing_ok=True)

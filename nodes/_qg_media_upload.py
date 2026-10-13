"""Stream video uploads to ComfyUI's input folder without buffering the body."""

from __future__ import annotations

import asyncio
from pathlib import Path

import av


def upload_name(filename: str, extensions: set[str]) -> str:
    name = str(filename or "")
    if (not name or len(name) > 180 or name in {".", ".."}
            or any(char in name for char in '/\\:')
            or any(ord(char) < 32 for char in name)
            or Path(name).suffix.lower() not in extensions):
        raise ValueError("Choose a video file with a supported extension and a plain filename.")
    return name


def reserve_upload(root: Path, name: str):
    """Exclusive creation never follows an existing symlink or replaces a file."""
    source = Path(name)
    for counter in range(10000):
        candidate = root / (name if counter == 0 else f"{source.stem}_{counter}{source.suffix}")
        try:
            return candidate, candidate.open("xb")
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
    path, handle = reserve_upload(root.resolve(), name)
    complete = False
    try:
        while chunk := await part.read_chunk(size=1024 * 1024):
            await asyncio.to_thread(handle.write, chunk)
        handle.close()
        await asyncio.to_thread(validate_video, path)
        complete = True
        return {"name": path.name, "subfolder": "", "type": "input"}
    finally:
        handle.close()
        if not complete:
            path.unlink(missing_ok=True)

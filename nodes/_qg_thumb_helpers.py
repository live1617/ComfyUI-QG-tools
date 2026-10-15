"""A small JPEG made from a picture on disk.

Routes used to hand a file out as it is, by its path. This makes a copy that
was decoded here instead: whatever a name leads to, only picture bytes go
back, and a big preview never travels whole.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

# How many bytes of thumbnails to keep in memory before the oldest goes.
_THUMBS_BYTES = 24 * 1024 * 1024
_THUMBS_LOCK = threading.Lock()
_THUMBS: "OrderedDict[tuple, bytes]" = OrderedDict()
_thumbs_size = 0
# The tile a see-through picture shows on, so it is not black on dark.
THUMB_BACK = (27, 35, 38)


def _has_see_through(frame: Image.Image) -> bool:
    return frame.mode in ("RGBA", "LA", "PA") or (frame.mode == "P" and "transparency" in frame.info)


def thumbnail(path, edge: int = 160) -> bytes:
    """A small JPEG of the picture. A see-through part shows on the gallery's
    dark tile. Kept in a small cache keyed by the file's state."""
    global _thumbs_size
    edge = max(48, min(512, int(edge)))
    real = Path(path)
    stat = real.stat()
    key = (str(real), int(stat.st_mtime_ns), int(stat.st_size), edge)
    with _THUMBS_LOCK:
        hit = _THUMBS.get(key)
        if hit is not None:
            _THUMBS.move_to_end(key)
            return hit
    with Image.open(real) as source:
        source.draft("RGB", (edge * 2, edge * 2))        # a JPEG decodes small straight away
        frame = ImageOps.exif_transpose(source)
        if frame.mode == "I":
            frame = frame.point(lambda value: value * (1 / 255))
        if _has_see_through(frame):
            rgba = frame.convert("RGBA")
            rgba.thumbnail((edge, edge), Image.Resampling.LANCZOS)
            small = Image.new("RGB", rgba.size, THUMB_BACK)
            small.paste(rgba, (0, 0), rgba)
        else:
            small = frame.convert("RGB")
            small.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    out = BytesIO()
    small.save(out, format="JPEG", quality=82)
    data = out.getvalue()
    with _THUMBS_LOCK:
        if key not in _THUMBS:
            _THUMBS[key] = data
            _thumbs_size += len(data)
            while _thumbs_size > _THUMBS_BYTES and len(_THUMBS) > 1:
                _, old = _THUMBS.popitem(last=False)
                _thumbs_size -= len(old)
    return data

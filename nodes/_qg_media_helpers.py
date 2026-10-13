"""Safe image/video loading and preview routes for QG-tools transform nodes."""

from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict
from io import BytesIO
import itertools
import math
import os
from pathlib import Path
import re
import threading
import time

import av
from PIL import Image, ImageOps, ImageSequence

try:
    import folder_paths
except ImportError:  # Offline tests import this module without ComfyUI.
    folder_paths = None


# Local path mode reads only from ComfyUI's input, output and temp folders,
# for queued runs and the preview routes alike: a widget value arrives
# through the unauthenticated /prompt route, and the previews answer any
# HTTP client that can reach the server.
LOCAL_PATH_RULE = (
    "Local path mode reads only videos inside ComfyUI's input, output or temp "
    "folder. Move the video there, or use Upload."
)

VIDEO_EXTENSIONS = {
    ".avi",
    ".m2ts",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".webm",
}


def list_input_images() -> list[str]:
    if folder_paths is None:
        return [""]
    root = Path(folder_paths.get_input_directory())
    results: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            if folder_paths.filter_files_content_types([path.name], ["image"]):
                results.append(path.relative_to(root).as_posix())
        except Exception:
            if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}:
                results.append(path.relative_to(root).as_posix())
    return sorted(results, key=str.casefold) or [""]


def list_input_videos() -> list[str]:
    if folder_paths is None:
        return [""]
    root = Path(folder_paths.get_input_directory())
    results = [
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    ]
    return sorted(results, key=str.casefold) or [""]


def resolve_input_path(selection: str) -> Path:
    if not selection:
        raise ValueError("Select or upload a source file first.")
    if str(selection).replace("\\", "/").startswith("//"):
        raise ValueError("Network source paths are not allowed.")
    if folder_paths is None:
        path = Path(selection).expanduser().resolve()
    else:
        path = Path(folder_paths.get_annotated_filepath(selection)).resolve()
        input_root = Path(folder_paths.get_input_directory()).resolve()
        try:
            path.relative_to(input_root)
        except ValueError as exc:
            raise ValueError("The selected source is outside ComfyUI's input folder.") from exc
    if not path.is_file():
        raise ValueError("The selected source file no longer exists.")
    return path


def resolve_video_path(source_mode: str, video: str, local_path: str) -> Path:
    if source_mode == "local path":
        text = str(local_path or "").strip().strip('"')
        if not text:
            raise ValueError("Local path mode requires a video path.")
        if not local_preview_allowed(text):
            raise ValueError(LOCAL_PATH_RULE)
        path = Path(text).expanduser().resolve()
        if not path.is_file():
            raise ValueError("The local video file does not exist.")
    elif source_mode == "input folder":
        path = resolve_input_path(video)
    else:
        raise ValueError("Video source mode must be 'input folder' or 'local path'.")
    if path.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError(f"Unsupported video extension: {path.suffix.lower() or '(none)' }.")
    return path


def _comfy_managed_roots() -> list[Path]:
    if folder_paths is None:
        return []
    roots: list[Path] = []
    for getter in ("get_input_directory", "get_output_directory", "get_temp_directory"):
        try:
            roots.append(Path(getattr(folder_paths, getter)()).resolve())
        except Exception:
            continue
    return roots


def local_preview_allowed(candidate: str) -> bool:
    """A local path may be read only inside ComfyUI's input, output and temp
    folders, the folders core routes serve anyway. A network path is refused
    from its text alone, before anything could contact its host."""
    text = str(candidate or "").strip().strip('"')
    if not text or text.replace("\\", "/").startswith("//"):
        return False
    try:
        resolved = Path(text).expanduser().resolve()
    except (OSError, ValueError):
        return False
    return any(resolved == root or root in resolved.parents for root in _comfy_managed_roots())


def load_image_frames(path: Path) -> list[Image.Image]:
    frames: list[Image.Image] = []
    with Image.open(path) as source:
        expected_size: tuple[int, int] | None = None
        for frame in ImageSequence.Iterator(source):
            converted = ImageOps.exif_transpose(frame).convert("RGBA")
            if expected_size is None:
                expected_size = converted.size
            if converted.size != expected_size:
                raise ValueError("Image source contains frames with inconsistent dimensions.")
            frames.append(converted.copy())
            if source.format == "MPO":
                break
    if not frames:
        raise ValueError("The selected image contains no decodable frames.")
    return frames


# --- the video clock -----------------------------------------------------------
# Trim windows, frame indices, durations and preview times all count seconds
# from the video stream's first frame, so frame i sits at i / fps - how the
# editors' timelines (js/shared/timeline_math.mjs) and the frame_index,
# start_frame and end_frame widgets count. A file's own timestamps begin
# wherever its muxer put them: about 1.4 s into an .mts/.m2ts, later after an
# MP4/MOV edit list's delay. The container's start is no zero either, since
# audio often opens a little ahead of the picture (a transport stream's
# B-frame delay) and would push frame 0 to a later index. So a decoded time
# passes through stream_seconds before it meets a window, and the seeks
# (decode_from) go the other way with int(seconds / time_base) + start_time.


def stream_origin(stream) -> float:
    """The file's timestamp, in seconds, of the stream's first frame; 0 when
    the container does not say."""
    if stream.start_time is None or not stream.time_base:
        return 0.0
    return float(stream.start_time * stream.time_base)


def stream_seconds(time: float | None, stream) -> float | None:
    """A timestamp from the file (a decoded frame's ``frame.time``, from this
    stream or a sibling such as the audio) as seconds since ``stream``'s first
    frame. None, a frame without a timestamp, stays None."""
    if time is None:
        return None
    return float(time) - stream_origin(stream)


def video_metadata(path: Path) -> dict[str, float | int | str]:
    with av.open(str(path)) as container:
        stream = next((candidate for candidate in container.streams if candidate.type == "video"), None)
        if stream is None:
            raise ValueError("The selected file does not contain a video stream.")
        fps = float(stream.average_rate or stream.base_rate or 0.0)
        duration = float(stream.duration * stream.time_base) if stream.duration is not None else 0.0
        if duration <= 0 and container.duration is not None:
            # The container's span can open before the video (leading audio):
            # the stream's own length runs from its first frame to the end.
            end = (container.start_time or 0) + container.duration
            duration = max(0.0, stream_seconds(end / av.time_base, stream))
        frame_count = int(stream.frames or 0)
        if frame_count <= 0 and duration > 0 and fps > 0:
            frame_count = max(1, int(round(duration * fps)))
        return {
            "name": path.name,
            "width": int(stream.codec_context.width or 0),
            "height": int(stream.codec_context.height or 0),
            "fps": fps,
            "frame_count": frame_count,
            "duration": duration,
        }


def _video_stream(container):
    stream = next((candidate for candidate in container.streams if candidate.type == "video"), None)
    if stream is None:
        raise ValueError("The selected file does not contain a video stream.")
    return stream


def _frame_position(frame, stream, fps: float, fallback_index: int) -> tuple[int, float]:
    time_value = stream_seconds(frame.time, stream)
    if time_value is not None:
        index = int(round(time_value * fps)) if fps > 0 else fallback_index
        return index, time_value
    return fallback_index, (fallback_index / fps if fps > 0 else 0.0)


def decode_from(container, stream, seconds: float, fps: float):
    """Frames of ``stream`` decoded from at or before ``seconds`` on the video
    clock: a keyframe seek, then the decoder's output as an iterator.

    A transport stream seeks to whichever packet precedes the target, not to
    a keyframe, and the decoder then drops everything up to the next keyframe
    - past the target, or past the whole clip when it has one keyframe. When
    the first frame out lands after the target, the seek is retried from a
    second earlier, then twice as far back each time, and from the top last.
    """
    tolerance = 0.5 / fps if fps > 0 else 1e-4
    back = 0.0
    while True:
        target = seconds - back
        top = not target > 0
        if top:
            # Below every timestamp: the first packet, even when a seek to
            # the stream's own start would land past its first keyframe.
            offset = min(0, stream.start_time or 0)
        else:
            offset = int(target / stream.time_base) + (stream.start_time or 0)
        container.seek(offset, stream=stream, backward=True, any_frame=False)
        frames = container.decode(stream)
        first = next(frames, None)
        if first is None:
            if top:
                return iter(())
        else:
            moment = stream_seconds(first.time, stream)
            if top or moment is None or moment <= seconds + tolerance:
                return itertools.chain((first,), frames)
        back = max(1.0, back * 2)


def _decode_with_seek(path: Path, requested_time: float, fps: float):
    """Keyframe-seek then decode forward. Returns None when the file has no
    usable timestamps so the caller can fall back to a sequential scan."""
    with av.open(str(path)) as container:
        stream = _video_stream(container)
        if not stream.time_base:
            return None
        try:
            frames = decode_from(container, stream, requested_time, fps)
        except Exception:
            return None
        tolerance = (0.5 / fps) if fps > 0 else 0.0
        last = None
        for frame in frames:
            moment = stream_seconds(frame.time, stream)
            if moment is None:
                return None
            last = frame
            if moment + tolerance >= requested_time:
                break
        if last is None:
            return None
        index, time_value = _frame_position(last, stream, fps, 0)
        return last.to_image().convert("RGBA"), index, time_value


def _decode_sequential(path: Path, target_index: int, fps: float):
    with av.open(str(path)) as container:
        stream = _video_stream(container)
        last = None
        for index, frame in enumerate(container.decode(stream)):
            last = (frame, index)
            if index >= target_index:
                break
        if last is None:
            raise ValueError("The requested video frame could not be decoded.")
        frame, index = last
        position_index, position_time = _frame_position(frame, stream, fps, index)
        return frame.to_image().convert("RGBA"), position_index, position_time


# Metadata rarely changes while a user scrubs, but every frame request needs
# fps/frame_count. Cache per (path, mtime, size) so scrubbing opens the
# container once per request instead of twice. FIFO-evicted, tiny.
_METADATA_CACHE: dict[tuple[str, int, int], dict] = {}
_METADATA_CACHE_LIMIT = 32


def cached_video_metadata(path: Path) -> dict[str, float | int | str]:
    try:
        stat = os.stat(path)
        key = (str(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        return video_metadata(path)
    cached = _METADATA_CACHE.get(key)
    if cached is None:
        cached = video_metadata(path)
        if len(_METADATA_CACHE) >= _METADATA_CACHE_LIMIT:
            _METADATA_CACHE.pop(next(iter(_METADATA_CACHE)))
        _METADATA_CACHE[key] = cached
    return dict(cached)


# --- persistent scrub sessions ----------------------------------------------
# Opening a container per request costs a full probe of the file, and landing
# mid-GOP costs a decode from the previous keyframe. A session keeps the
# container and codec state alive between requests, so stepping or dragging
# forward decodes only the frames in between. Keyed by file state; small LRU.

_FORWARD_DECODE_GAP = 24
_SESSION_LIMIT = 3
_SESSION_IDLE_SECONDS = 60.0
_SESSIONS: dict[tuple[str, int, int], "_ScrubSession"] = {}
_SESSIONS_LOCK = threading.Lock()
_reaper_started = False


class _ScrubSession:
    def __init__(self, path: Path):
        self.container = av.open(str(path))
        self.stream = _video_stream(self.container)
        self.lock = threading.Lock()
        self.last_index = -1  # -1 = position unknown, force a seek
        # The frame at last_index. Asking for the same frame again (a scrub
        # that settles on the frame it already showed) is answered from
        # here; decoding "forward" to it would hand back the frame after.
        self.last_frame = None
        self.last_used = time.monotonic()

    def close(self) -> None:
        try:
            self.container.close()
        except Exception:
            pass


def _file_key(path: Path) -> tuple[str, int, int]:
    stat = os.stat(path)
    return (str(Path(path).resolve()), stat.st_mtime_ns, stat.st_size)


def _start_reaper_locked() -> None:
    """An open session keeps the video file locked on Windows, which would
    block users from deleting or overwriting a clip they just scrubbed. The
    reaper closes sessions left idle. Started once, under _SESSIONS_LOCK."""
    global _reaper_started
    if _reaper_started:
        return
    _reaper_started = True

    def reap() -> None:
        while True:
            time.sleep(15.0)
            now = time.monotonic()
            with _SESSIONS_LOCK:
                for key in [k for k, s in _SESSIONS.items() if now - s.last_used > _SESSION_IDLE_SECONDS]:
                    _SESSIONS.pop(key).close()

    threading.Thread(target=reap, daemon=True, name="qgtools-scrub-session-reaper").start()


def close_scrub_sessions() -> None:
    """Close every open scrub session (releases file handles immediately)."""
    with _SESSIONS_LOCK:
        for key in list(_SESSIONS):
            _SESSIONS.pop(key).close()


def _get_session(path: Path) -> "_ScrubSession":
    key = _file_key(path)
    with _SESSIONS_LOCK:
        _start_reaper_locked()
        session = _SESSIONS.get(key)
        if session is None:
            for stale in [other for other in _SESSIONS if other[0] == key[0] and other != key]:
                _SESSIONS.pop(stale).close()
            if len(_SESSIONS) >= _SESSION_LIMIT:
                oldest = min(_SESSIONS, key=lambda item: _SESSIONS[item].last_used)
                _SESSIONS.pop(oldest).close()
            session = _ScrubSession(path)
            _SESSIONS[key] = session
        session.last_used = time.monotonic()
        return session


def _session_decode(path: Path, target_index: int, requested_time: float, fps: float):
    """Decode via the persistent session. Returns None when the file lacks
    usable timestamps so the caller can use the stateless fallbacks."""
    session = _get_session(path)
    with session.lock:
        stream = session.stream
        if session.last_index == target_index and session.last_frame is not None:
            index, time_value = _frame_position(session.last_frame, stream, fps, target_index)
            return session.last_frame.to_image().convert("RGBA"), index, time_value
        forward = (
            session.last_index >= 0
            and 0 < target_index - session.last_index <= _FORWARD_DECODE_GAP
        )
        if forward:
            frames = session.container.decode(stream)
        else:
            try:
                frames = decode_from(session.container, stream, requested_time, fps)
            except Exception:
                session.last_index = -1
                session.last_frame = None
                return None
        tolerance = (0.5 / fps) if fps > 0 else 0.0
        last = None
        for frame in frames:
            moment = stream_seconds(frame.time, stream)
            if moment is None:
                session.last_index = -1
                session.last_frame = None
                return None
            last = frame
            session.last_index = int(round(moment * fps)) if fps > 0 else 0
            session.last_frame = frame
            if forward:
                if session.last_index >= target_index:
                    break
            elif moment + tolerance >= requested_time:
                break
        if last is None:
            session.last_index = -1  # exhausted decoder: next request re-seeks
            session.last_frame = None
            return None
        index, time_value = _frame_position(last, stream, fps, target_index)
        return last.to_image().convert("RGBA"), index, time_value


def seek_target(metadata: dict, seek_mode: str, frame_index: int, frame_time: float) -> tuple[int, float]:
    """The frame a preview request means, as (index, seconds), clamped to
    the source."""
    fps = float(metadata["fps"] or 0.0)
    if seek_mode == "time seconds":
        requested_time = max(0.0, float(frame_time))
        target_index = int(round(requested_time * fps)) if fps > 0 else 0
    elif seek_mode == "frame index":
        target_index = max(0, int(frame_index))
        requested_time = target_index / fps if fps > 0 else 0.0
    else:
        raise ValueError("Video seek mode must be 'frame index' or 'time seconds'.")
    frame_count = int(metadata["frame_count"] or 0)
    if frame_count > 0 and target_index > frame_count - 1:
        target_index = frame_count - 1
        if fps > 0:
            requested_time = target_index / fps
    return target_index, requested_time


def decode_video_frame(
    path: Path, seek_mode: str, frame_index: int, frame_time: float
) -> tuple[Image.Image, int, float]:
    metadata = cached_video_metadata(path)
    fps = float(metadata["fps"] or 0.0)
    target_index, requested_time = seek_target(metadata, seek_mode, frame_index, frame_time)

    # Fast path: persistent session (forward decode or keyframe seek without
    # reopening the container). Stateless keyframe seek and the sequential
    # scan remain as safety nets for files without usable timestamps.
    if fps > 0:
        try:
            selected = _session_decode(path, target_index, requested_time, fps)
        except Exception:
            selected = None
        if selected is not None:
            return selected
        if target_index > 0:
            selected = _decode_with_seek(path, requested_time, fps)
            if selected is not None:
                return selected
    return _decode_sequential(path, target_index, fps)


# --- storyboard ---------------------------------------------------------------
# A strip of keyframe thumbnails built once per file in a background thread.
# The editor shows the nearest tile instantly while dragging (zero network),
# then the exact decoded frame replaces it. Same pattern video sites use.

_STORYBOARD_TILE_EDGE = 168
_STORYBOARD_MAX_TILES = 96
# Short clips decode once, front to back, taking a tile as each target time
# goes by; longer ones seek to the keyframe before each target and decode
# forward to it, giving up after this many frames so a sparse-keyframe file
# still finishes in the background.
_STORYBOARD_SEQUENTIAL_FRAMES = 3000
_STORYBOARD_FORWARD_CAP = 150
_STORYBOARDS: dict[tuple[str, int, int], dict] = {}
_STORYBOARDS_LOCK = threading.Lock()


def _build_storyboard(path: Path, key: tuple[str, int, int]) -> None:
    try:
        metadata = cached_video_metadata(path)
        duration = float(metadata["duration"] or 0.0)
        fps = float(metadata["fps"] or 0.0)
        count = min(_STORYBOARD_MAX_TILES, max(12, math.ceil(duration * 2)))
        targets = [duration * step / count if duration > 0 else 0.0 for step in range(count)]
        tolerance = (0.5 / fps) if fps > 0 else 0.0
        tiles: list[tuple[Image.Image, float]] = []

        def take(frame, moment: float) -> None:
            thumb = frame.to_image()
            thumb.thumbnail((_STORYBOARD_TILE_EDGE, _STORYBOARD_TILE_EDGE))
            # Two targets can resolve to one frame; keep each frame once.
            if not tiles or moment > tiles[-1][1] + 1e-6:
                tiles.append((thumb, moment))

        with av.open(str(path)) as container:
            stream = _video_stream(container)
            if int(metadata["frame_count"] or 0) <= _STORYBOARD_SEQUENTIAL_FRAMES:
                pending = list(targets)
                for frame in container.decode(stream):
                    moment = stream_seconds(frame.time, stream)
                    if moment is None:
                        break
                    if pending and moment + tolerance >= pending[0]:
                        take(frame, moment)
                        while pending and moment + tolerance >= pending[0]:
                            pending.pop(0)
                    if not pending:
                        break
            else:
                for position in targets:
                    try:
                        offset = int(position / stream.time_base) + (stream.start_time or 0)
                        container.seek(offset, stream=stream, backward=True, any_frame=False)
                    except Exception:
                        continue
                    frame = moment = None
                    for decoded, candidate in enumerate(container.decode(stream)):
                        reached = stream_seconds(candidate.time, stream)
                        if reached is None:
                            break
                        frame, moment = candidate, reached
                        if moment + tolerance >= position or decoded >= _STORYBOARD_FORWARD_CAP:
                            break
                    if frame is None:
                        continue
                    take(frame, moment)
        if not tiles:
            raise ValueError("no storyboard frames decoded")
        tile_width, tile_height = tiles[0][0].size
        sprite = Image.new("RGB", (tile_width * len(tiles), tile_height), (12, 14, 16))
        for column, (thumb, _) in enumerate(tiles):
            sprite.paste(thumb, (column * tile_width, 0))
        buffer = BytesIO()
        sprite.save(buffer, format="JPEG", quality=70)
        payload = {
            "status": "ready",
            "tile_width": tile_width,
            "tile_height": tile_height,
            "count": len(tiles),
            "times": [moment for _, moment in tiles],
            "fps": fps,
            "sprite": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
        }
    except Exception:
        payload = {"status": "failed"}
    with _STORYBOARDS_LOCK:
        _STORYBOARDS[key] = payload


def storyboard_payload(path: Path) -> dict:
    """Return the storyboard for the file, kicking off a background build on
    first request. Callers poll until status flips to ready/failed."""
    key = _file_key(path)
    with _STORYBOARDS_LOCK:
        existing = _STORYBOARDS.get(key)
        if existing is not None:
            return existing
        for stale in [other for other in _STORYBOARDS if other[0] == key[0] and other != key]:
            _STORYBOARDS.pop(stale)
        if len(_STORYBOARDS) >= 8:
            _STORYBOARDS.pop(next(iter(_STORYBOARDS)))
        _STORYBOARDS[key] = {"status": "building"}
    threading.Thread(target=_build_storyboard, args=(path, key), daemon=True).start()
    return {"status": "building"}


def preview_edge(max_width: int, max_height: int) -> int:
    return max(64, min(2048, int(max(max_width, max_height))))


# --- served-frame cache -------------------------------------------------------
# Scrubbing back and forth over a region asks for the same frames again and
# again; each is a decode from the previous keyframe. The encoded previews
# that were served are kept in a small byte-bounded LRU keyed by file state,
# frame and size, so a revisit costs nothing.

_PREVIEW_CACHE: "OrderedDict[tuple, tuple[bytes, int, float]]" = OrderedDict()
_PREVIEW_CACHE_LOCK = threading.Lock()
_PREVIEW_CACHE_BYTES = 48 * 1024 * 1024
_preview_cache_size = 0


def clear_preview_cache() -> None:
    global _preview_cache_size
    with _PREVIEW_CACHE_LOCK:
        _PREVIEW_CACHE.clear()
        _preview_cache_size = 0


def cached_preview(
    path: Path, seek_mode: str, frame_index: int, frame_time: float, max_width: int, max_height: int
) -> tuple[bytes, int, float]:
    """The encoded preview for a frame request plus the decoded position,
    from the cache when that frame was served at that size recently."""
    global _preview_cache_size
    edge = preview_edge(max_width, max_height)
    target_index, _ = seek_target(cached_video_metadata(path), seek_mode, frame_index, frame_time)
    key = (_file_key(path), target_index, edge)
    with _PREVIEW_CACHE_LOCK:
        hit = _PREVIEW_CACHE.get(key)
        if hit is not None:
            _PREVIEW_CACHE.move_to_end(key)
            return hit
    image, actual_index, actual_time = decode_video_frame(path, seek_mode, frame_index, frame_time)
    entry = (encode_preview(image, edge, edge), actual_index, actual_time)
    with _PREVIEW_CACHE_LOCK:
        if key in _PREVIEW_CACHE:
            _preview_cache_size -= len(_PREVIEW_CACHE.pop(key)[0])
        _PREVIEW_CACHE[key] = entry
        _preview_cache_size += len(entry[0])
        while _preview_cache_size > _PREVIEW_CACHE_BYTES and len(_PREVIEW_CACHE) > 1:
            _, evicted = _PREVIEW_CACHE.popitem(last=False)
            _preview_cache_size -= len(evicted[0])
    return entry


def encode_preview(image: Image.Image, max_width: int, max_height: int) -> bytes:
    maximum = preview_edge(max_width, max_height)
    preview = image.convert("RGB")
    preview.thumbnail((maximum, maximum), Image.Resampling.LANCZOS)
    output = BytesIO()
    # No optimize pass: it costs an extra encode per scrub frame for a few
    # percent of size on an ephemeral, never-cached preview.
    preview.save(output, format="JPEG", quality=88)
    return output.getvalue()


_PACK_VERSION = None


def _pack_version() -> str:
    """Pack version straight from pyproject.toml, read once; fail-soft."""
    global _PACK_VERSION
    if _PACK_VERSION is None:
        try:
            text = (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text(
                encoding="utf-8"
            )
            match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
            _PACK_VERSION = match.group(1) if match else "unknown"
        except Exception:
            _PACK_VERSION = "unknown"
    return _PACK_VERSION


def register_video_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is None or getattr(prompt_server, "_qg_transform_routes", False):
        return
    prompt_server._qg_transform_routes = True

    @prompt_server.routes.post("/qg/transform/video/upload")
    async def qg_video_upload(request):
        from ._qg_media_upload import stream_video_upload

        try:
            result = await stream_video_upload(
                request, Path(folder_paths.get_input_directory()), VIDEO_EXTENSIONS
            )
            return web.json_response(result)
        except Exception as exc:
            return web.json_response({"error": _safe_route_error(exc)}, status=400)

    def request_path(request) -> Path:
        source_mode = request.query.get("source_mode", "input folder")
        local_path = request.query.get("local_path", "")
        # Gate before touching the filesystem so a denied request can not be
        # used to probe which paths exist.
        if source_mode == "local path" and not local_preview_allowed(local_path):
            raise ValueError(LOCAL_PATH_RULE)
        return resolve_video_path(source_mode, request.query.get("video", ""), local_path)

    # Decodes run in worker threads: a blocking decode inside these async
    # handlers would stall ComfyUI's entire web server (every route plus the
    # frontend websocket) for the duration of the decode.

    @prompt_server.routes.get("/qg/transform/video/metadata")
    async def qg_video_metadata(request):
        try:
            path = request_path(request)
            metadata = await asyncio.get_running_loop().run_in_executor(
                None, cached_video_metadata, path
            )
            return web.json_response(metadata)
        except Exception as exc:
            return web.json_response({"error": _safe_route_error(exc)}, status=400)

    @prompt_server.routes.get("/qg/transform/video/frame")
    async def qg_video_frame(request):
        try:
            path = request_path(request)
            seek_mode = request.query.get("seek_mode", "frame index")
            frame_index = _query_int(request, "frame_index", 0)
            frame_time = _query_float(request, "frame_time", 0.0)
            max_width = _query_int(request, "max_width", 1600)
            max_height = _query_int(request, "max_height", 1600)

            body, actual_index, actual_time = await asyncio.get_running_loop().run_in_executor(
                None, cached_preview, path, seek_mode, frame_index, frame_time, max_width, max_height
            )
            return web.Response(
                body=body,
                content_type="image/jpeg",
                headers={
                    "Cache-Control": "no-store",
                    "X-QG-Frame-Index": str(actual_index),
                    "X-QG-Frame-Time": f"{actual_time:.6f}",
                },
            )
        except Exception as exc:
            return web.json_response({"error": _safe_route_error(exc)}, status=400)

    @prompt_server.routes.get("/qg/transform/video/storyboard")
    async def qg_video_storyboard(request):
        try:
            path = request_path(request)
            payload = await asyncio.get_running_loop().run_in_executor(
                None, storyboard_payload, path
            )
            return web.json_response(payload)
        except Exception as exc:
            return web.json_response({"error": _safe_route_error(exc)}, status=400)

    # Lets the frontend detect a browser tab still running cached JavaScript
    # from an older install of the pack.
    @prompt_server.routes.get("/qg/pack_version")
    async def qg_pack_version(request):
        return web.json_response({"version": _pack_version()})


def _safe_route_error(exc: Exception) -> str:
    text = str(exc).strip() or "The media request failed."
    if os.path.isabs(text) or re.search(r"(?:[A-Za-z]:[\\/]|/(?:home|Users|mnt|tmp)/)", text):
        return "The media request failed."
    return text


def _query_int(request, name: str, default: int) -> int:
    try:
        return int(float(request.query.get(name, default)))
    except (TypeError, ValueError):
        return default


def _query_float(request, name: str, default: float) -> float:
    try:
        return float(request.query.get(name, default))
    except (TypeError, ValueError):
        return default

"""Fail-soft seams onto ComfyUI's execution loop, shared by the pack's nodes.

The decode and encode loops run on a worker thread (asyncio.to_thread), which
copies the caller's context variables - the same ones ComfyUI reads to
attribute an interrupt or a progress update to the node being executed - so
these seams work unchanged from there. Every ComfyUI import is deferred and
optional, so offline tests and older cores simply run the loops
uninstrumented. The pack's once-per-process console notes and its choice of
compute device live here too, so no helper module keeps its own copy.
"""

from __future__ import annotations


def raise_if_interrupted() -> None:
    """Abort the running node as soon as the queue is cancelled.

    ComfyUI raises InterruptProcessingException, which derives from
    BaseException rather than Exception, so it passes straight through
    ordinary `except Exception` handling on its way out of a loop.
    """
    try:
        from comfy.model_management import throw_exception_if_processing_interrupted
    except ImportError:  # Offline tests run without ComfyUI.
        return
    throw_exception_if_processing_interrupted()


def frame_progress(total: int):
    """A progress bar for a known frame total; None when there is nothing to track.

    A total of zero or less means the source never said how many frames are
    coming, so there is no honest fraction to report and the loop runs
    untracked rather than inventing one.
    """
    if int(total) <= 0:
        return None
    try:
        from comfy.utils import ProgressBar
    except ImportError:  # Offline tests run without ComfyUI.
        return None
    try:
        return ProgressBar(int(total))
    except Exception:
        return None


def progress_bar(total: int):
    """ComfyUI's progress bar for ``total`` steps; None outside ComfyUI.

    The plain seam for loops that always know their total and call
    ``update_absolute`` themselves (the stitch's edge-halo spread, LaMa,
    Frame Interpolate). Unlike :func:`frame_progress` it builds a bar for
    any total and lets a failure to build one propagate.
    """
    try:
        from comfy.utils import ProgressBar
    except ImportError:  # Offline tests run without ComfyUI.
        return None
    return ProgressBar(total)


def advance_progress(progress, value: int, total: int) -> None:
    """Report frame `value` of `total`; a reporting failure never stops the work.

    No preview image is attached - both video nodes already show the clip in
    their own player, so a second stream of frames would only cost bandwidth.
    Only Exception is swallowed: an interrupt raised by ComfyUI's progress
    hook is a BaseException and has to keep travelling.
    """
    if progress is None:
        return
    try:
        progress.update_absolute(int(value), int(total))
    except Exception:
        pass


def warn_once(
    message: str, seen: set[str], *, key: str | None = None, limit: int | None = None
) -> None:
    """Print ``[QG-tools] message`` the first time ``key`` (the message by default) comes up.

    ``seen`` belongs to the caller, so each module keeps its own scope and a
    test can reset it. ``limit`` is for keys built from what a user typed:
    once more than that many are remembered the set starts over, rather than
    growing for the whole session. The note goes straight to a console that
    may be cp1252, so callers keep it ASCII.
    """
    marker = message if key is None else key
    if marker in seen:
        return
    if limit is not None and len(seen) > limit:
        seen.clear()
    seen.add(marker)
    print(f"[QG-tools] {message}")


def comfy_torch_device():
    """The device ComfyUI computes on; CUDA when available outside ComfyUI.

    torch is imported here, not at the top, so the rest of this module stays
    importable where torch is absent (the standard-library tests in CI).
    """
    import torch

    try:
        from comfy.model_management import get_torch_device

        return torch.device(get_torch_device())
    except ImportError:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")


__all__ = [
    "advance_progress",
    "comfy_torch_device",
    "frame_progress",
    "progress_bar",
    "raise_if_interrupted",
    "warn_once",
]

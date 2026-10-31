"""Run Timer — how long the last run took, on the canvas.

A stopwatch for the whole run. It starts when a queued prompt begins
executing, ticks on the node while it runs, and holds the total when it
finishes. Right-click it for the few runs before, so a settings change can
be judged against the last one. The times are saved with the workflow, so a
shared graph carries its author's run time as a reference. No inputs, no
outputs; it listens to the queue rather than sitting on a wire — the whole
node is the readout, painted by the frontend.

The frontend does all the work: web/shared/run_timer.mjs holds the stopwatch
reducer and the display formats, web/run_timer/index.js listens to the
queue's events and paints the node (on the canvas, or as a DOM panel under
Nodes 2.0). This file only declares the node.

The idea came from ComfyUI-AusBoss's Run Timer (MIT); the implementation,
front and back, is this pack's own.
"""

from __future__ import annotations


class QGRunTimer:
    CATEGORY = "QG-tools/Display"
    DESCRIPTION = (
        "A stopwatch for the whole run. It starts when a queued prompt "
        "begins executing, ticks on the node while it runs, and holds the "
        "total when it finishes. Right-click it for the few runs before, so "
        "a settings change can be judged against the last one. The times are "
        "saved with the workflow, so a shared graph carries its author's run "
        "time as a reference. No inputs, no outputs; it listens to the queue "
        "rather than sitting on a wire."
    )
    SEARCH_ALIASES = ["timer", "run time", "stopwatch", "elapsed", "benchmark", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"

    def noop(self):
        # Never reached: with no outputs the node is not part of any prompt.
        return ()


NODE_CLASS_MAPPINGS = {"QG_RunTimer": QGRunTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RunTimer": "Run Timer"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

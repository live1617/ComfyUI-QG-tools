"""Run Timer — how long the last queue took, on the canvas.

A stopwatch for the whole run. It starts when a queued prompt begins
executing, ticks on the node while it runs, and holds the total when it
finishes. Right-click it for the few runs before, so a settings change can
be judged against the last one. The times are saved with the workflow, so a
shared graph carries its author's run time as a reference. No inputs, no
outputs; it listens to the queue rather than sitting on a wire — the whole
node is the readout, painted by the frontend.

Ported from ComfyUI-AusBoss #31 (node_run_timer.py); the timer's decision
logic lives in web/shared/run_timer.mjs and the drawing in
web/run_timer/index.js.
"""

from __future__ import annotations


class QGRunTimer:
    CATEGORY = "QG-tools"
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
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RunTimer": "QG Run Timer"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

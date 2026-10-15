"""What a route says back when a request fails."""

from __future__ import annotations

import re

# A whole path: a word that opens with "/", "\" or a drive letter.
_SERVER_PATH = re.compile(r"""(?:^|[\s'"(\[=:,;])(?:[A-Za-z]:[\\/]|[\\/])[^\s'"]""")


def safe_route_error(exc: Exception, fallback: str = "The request failed.") -> str:
    """The error text for the caller. A message that names a place on the
    server's disk is replaced whole: a decoder or the system quotes the file
    it was given, and the routes answer anyone who can reach the server."""
    text = str(exc).strip()
    if not text or _SERVER_PATH.search(text):
        return fallback
    return text

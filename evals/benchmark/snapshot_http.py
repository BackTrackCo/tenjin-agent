"""HTTP transport for the shared corpus snapshot reader."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .snapshot import PATH, TIMEOUT_S, SnapshotError


class HttpCatalog:
    """The deployment's own public feed. No credential: the bench shelf has none."""

    def page(self, origin: str, cursor: str | None) -> dict[str, Any]:
        url = f"https://{origin}{PATH}" + ("" if cursor is None else f"&cursor={urllib.parse.quote(cursor, safe='')}")
        request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                body = response.read().decode("utf-8")
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            raise SnapshotError("feed_unreachable", f"{origin}: {error.__class__.__name__}") from error
        try:
            return json.loads(body)
        except json.JSONDecodeError as error:
            raise SnapshotError("feed_unreadable", f"{origin} answered something that is not JSON") from error

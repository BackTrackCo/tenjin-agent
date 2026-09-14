"""JSON Schema checking, under this package's own refusal.

A schema here states shape and nothing else: which keys, which types, which
enum, which pattern, which bound. Anything that has to read outside the
document (a directory on disk, a hash of the fragment, a constant this package
computes at import, another field's value) stays hand-written beside the
schema, because a schema that has to be true about the world is a schema that
quietly stops being one.

`check` raises the caller's own error class, so a refusal stays the refusal the
caller's contract names and a schema swap never changes what a caller catches.
"""

from __future__ import annotations

from typing import Any, Iterable

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError


def _path(failure: ValidationError) -> str:
    """The failing field, as the manifest's own reader would name it."""
    return "".join(f"[{part}]" if isinstance(part, int) else f".{part}" for part in failure.absolute_path)


def check(name: str, instance: Any, schema: dict[str, Any], error: type[Exception]) -> None:
    """Validate, or raise `error` naming the first failure.

    `iter_errors` yields in keyword-visit order, which is not an order to put
    in a message, so the failures are sorted by path and keyword and the first
    one is reported. One failure rather than all of them, because that is what
    the hand-written checks this replaced did.
    """
    failures = sorted(
        Draft202012Validator(schema).iter_errors(instance),
        key=lambda failure: ([str(part) for part in failure.absolute_path], failure.validator or ""),
    )
    if failures:
        raise error(f"{name}{_path(failures[0])}: {failures[0].message}")


def enum(values: Iterable[str]) -> dict[str, Any]:
    """A closed set, sorted so the schema and its message are stable."""
    return {"enum": sorted(values)}

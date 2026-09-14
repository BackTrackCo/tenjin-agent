"""Derive each Bench-3 oracle's prescriptiveness from the oracle's own source.

A prescriptive oracle constrains how the work is done, not only what it does: it
reaches into the product's own modules by path, names symbols out of them, or
matches an exact sentence of prose. Each signal lets a correct implementation
fail on naming luck, so the catalog records them next to the task they judge and
`python -m evals.benchmark.bench3.prescriptiveness` reprints the current values.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

STATIC = re.compile(r"import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s+from\s+'(\.[^']*)'")
DESTRUCTURED = re.compile(r"(?:const|let|var)\s+\{([^{}]*)\}\s*=\s*await\s+import\('\.[^']*'\)")
MODULE = re.compile(r"(?:from\s+'|import\(')(\.[^']*)'")
ASSERTION = re.compile(r"\.(?:toBe|toContain|toEqual|toMatch)\(\s*'((?:[^'\\]|\\.)*)'")
WORD = re.compile(r"[A-Za-z]{2,}")


def _names(clause: str) -> list[str]:
    if clause.lstrip().startswith("*"):
        return [clause.split()[-1]]
    return [part.strip().split(" as ")[0].strip() for part in clause.strip("{}").split(",") if part.strip()]


def internal_modules(source: str) -> list[str]:
    """Product modules the oracle imports by path, statically or dynamically."""
    return sorted(set(MODULE.findall(source)))


def named_symbols(source: str) -> list[str]:
    """Identifiers the oracle imports by name out of those modules."""
    found: set[str] = set()
    for clause, _ in STATIC.findall(source):
        found.update(_names(clause))
    for clause in DESTRUCTURED.findall(source):
        found.update(_names(clause))
    return sorted(found)


def prose_assertions(source: str) -> list[str]:
    """Literals the oracle matches exactly that read as a sentence rather than a token."""
    return sorted({text for text in ASSERTION.findall(source) if " " in text and len(WORD.findall(text)) > 1})


def classify(source: str) -> dict:
    modules, symbols, prose = internal_modules(source), named_symbols(source), prose_assertions(source)
    return {
        "prescriptive": bool(modules or prose),
        "internal_modules": modules,
        "named_symbols": symbols,
        "prose_assertions": prose,
    }


def derive(oracles: Path | None = None) -> dict[str, dict]:
    directory = oracles or Path(__file__).with_name("oracles")
    return {path.name: classify(path.read_text()) for path in sorted(directory.glob("*.test.ts"))}


if __name__ == "__main__":
    print(json.dumps(derive(), indent=2))

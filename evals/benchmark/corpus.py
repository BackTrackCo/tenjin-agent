"""The corpus branch a run measures: reset it from its parent, or refuse the run.

A benchmark that seeds a shelf measures whatever else is on that shelf too, so
the run empties it first: before the first trial it resets the shelf's own
database branch from a parent that was emptied once, which is instant, needs no
table list, and changes no connection string.

The reset is destructive and it runs inside the project that holds the team's
knowledge, so the guard sits where the danger is. A reset names a branch, so
three refusals are about the branch the provider says that id resolves to, not
about the manifest: a default branch, a protected branch, and a branch whose id
is not the one the manifest names. A fourth holds the source of the reset to
the parent the manifest names, because restoring from an unexpected parent
fills the corpus with data no record accounts for.

The provider is a seam. `Api` is two calls, `HttpApi` is the Neon
implementation, and every test runs against a fake, which is also why the
branches this names do not have to exist for the guard to be tested.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from . import artifact

PROVIDERS = frozenset({"neon"})
CORPUS_KEYS = frozenset({"provider", "project_id", "branch_id", "parent_id", "origin"})
# Neon's control plane. It is an origin the run reaches on its own account, so
# the attestation's network allowlist has to name it beside the shelf.
API_ORIGIN = "console.neon.tech"
API_BASE = "https://console.neon.tech/api/v2"
API_KEY_VAR = "NEON_API_KEY"
# Terminal operation statuses. Anything else is still in flight.
OPERATION_DONE = frozenset({"finished", "skipped"})
OPERATION_FAILED = frozenset({"failed", "error", "cancelled", "cancelling"})
# Ids reach a URL path and a publishable record, so they are opaque by construction.
ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
HOST = re.compile(r"^[A-Za-z0-9.-]{1,64}$")


class CorpusError(RuntimeError):
    """A refusal that names its gate. Every one of them stops the run."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Corpus:
    """What the manifest declares: which branch of which project a run measures."""

    provider: str
    project_id: str
    branch_id: str
    parent_id: str
    origin: str

    @property
    def origins(self) -> tuple[str, ...]:
        """The shelf the corpus backs and the control plane the reset calls."""
        return (self.origin, API_ORIGIN)

    @property
    def facts(self) -> dict[str, str]:
        return {
            "provider": self.provider,
            "project_id": self.project_id,
            "branch_id": self.branch_id,
            "parent_id": self.parent_id,
            "origin": self.origin,
        }


def parse(data: Any) -> Corpus:
    """The manifest's `corpus` block, or a refusal before anything is spent."""
    if not isinstance(data, dict):
        raise CorpusError("corpus_shape", "corpus must be an object")
    unknown = sorted(set(data) - CORPUS_KEYS)
    missing = sorted(CORPUS_KEYS - set(data))
    if unknown or missing:
        detail = f"unknown keys: {', '.join(unknown)}" if unknown else f"missing keys: {', '.join(missing)}"
        raise CorpusError("corpus_shape", f"corpus has {detail}")
    if data["provider"] not in PROVIDERS:
        raise CorpusError("corpus_provider", f"corpus provider must be one of {', '.join(sorted(PROVIDERS))}")
    for name in ("project_id", "branch_id", "parent_id"):
        if not isinstance(data[name], str) or not ID.match(data[name]):
            raise CorpusError("corpus_shape", f"corpus {name} is not an opaque id")
    if not isinstance(data["origin"], str) or not HOST.match(data["origin"]):
        raise CorpusError("corpus_shape", "corpus origin must be a bare host")
    if data["branch_id"] == data["parent_id"]:
        raise CorpusError("corpus_shape", "corpus branch_id and parent_id name the same branch")
    return Corpus(
        provider=data["provider"],
        project_id=data["project_id"],
        branch_id=data["branch_id"],
        parent_id=data["parent_id"],
        origin=data["origin"],
    )


class Api(Protocol):
    """The provider seam: read a branch, reset it from its parent."""

    def branch(self, project_id: str, branch_id: str) -> Mapping[str, Any]: ...

    def reset_to_parent(self, project_id: str, branch_id: str, parent_id: str) -> None: ...


def guard(corpus: Corpus, branch: Mapping[str, Any]) -> None:
    """Refuse a reset target that is not exactly the branch the manifest names.

    The branch is the provider's answer rather than the manifest's claim, so an
    id that resolves to something else, a default branch, or a protected branch
    is caught here whatever the manifest says.
    """
    if not isinstance(branch, Mapping) or not branch:
        raise CorpusError("branch_unreadable", "the provider returned no branch for that id")
    if branch.get("id") != corpus.branch_id:
        raise CorpusError("branch_mismatch", f"the provider returned branch {branch.get('id')!r}, the manifest names {corpus.branch_id!r}")
    # `default` is the current field and `primary` the one it replaced; a run
    # that reads only the new name would reset a default branch on an older API.
    if branch.get("default") or branch.get("primary"):
        raise CorpusError("default_branch", f"branch {corpus.branch_id} is the project's default branch and is never reset")
    if branch.get("protected"):
        raise CorpusError("protected_branch", f"branch {corpus.branch_id} is protected and is never reset")
    if branch.get("parent_id") != corpus.parent_id:
        raise CorpusError(
            "parent_mismatch",
            f"branch {corpus.branch_id} has parent {branch.get('parent_id')!r}, the manifest names {corpus.parent_id!r}",
        )


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def reset(corpus: Corpus, api: Api, now: Callable[[], str] = utc_now) -> artifact.CorpusStamp:
    """Reset the corpus branch and stamp what was reset and when.

    Every failure raises, and the caller refuses the run: a run whose corpus is
    not the one the reset promised measures a corpus nobody described.
    """
    branch = api.branch(corpus.project_id, corpus.branch_id)
    guard(corpus, branch)
    api.reset_to_parent(corpus.project_id, corpus.branch_id, corpus.parent_id)
    return artifact.CorpusStamp(
        provider=corpus.provider,
        project_id=corpus.project_id,
        branch_id=corpus.branch_id,
        parent_id=corpus.parent_id,
        origin=corpus.origin,
        api_origin=API_ORIGIN,
        reset_at=now(),
    )


@dataclass(frozen=True)
class HttpApi:
    """Neon's branch API. Reset is `restore` with the parent as the source."""

    api_key: str
    base: str = API_BASE
    timeout_s: float = 30.0
    poll_interval_s: float = 1.0
    poll_cap_s: float = 120.0
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> "HttpApi":
        key = environ.get(API_KEY_VAR)
        if not key:
            raise CorpusError("api_key_missing", f"the corpus reset needs {API_KEY_VAR} set in this shell")
        return cls(api_key=key)

    def branch(self, project_id: str, branch_id: str) -> Mapping[str, Any]:
        payload = self._call("GET", f"/projects/{_quote(project_id)}/branches/{_quote(branch_id)}")
        branch = payload.get("branch")
        if not isinstance(branch, dict):
            raise CorpusError("branch_unreadable", "the branch response carried no branch object")
        return branch

    def reset_to_parent(self, project_id: str, branch_id: str, parent_id: str) -> None:
        payload = self._call(
            "POST",
            f"/projects/{_quote(project_id)}/branches/{_quote(branch_id)}/restore",
            {"source_branch_id": parent_id},
        )
        self._settle(project_id, payload)

    def _settle(self, project_id: str, payload: Mapping[str, Any]) -> None:
        """Wait for the restore's operations, so a started reset is not a finished one."""
        pending = _operation_ids(payload)
        deadline = self.clock() + self.poll_cap_s
        while pending:
            operation_id = pending[0]
            body = self._call("GET", f"/projects/{_quote(project_id)}/operations/{_quote(operation_id)}")
            status = str((body.get("operation") or {}).get("status", ""))
            if status in OPERATION_FAILED:
                raise CorpusError("reset_failed", f"the reset operation ended {status}")
            if status in OPERATION_DONE:
                pending.pop(0)
                continue
            if self.clock() >= deadline:
                raise CorpusError("reset_timeout", f"the reset operation was still {status or 'unreported'} after {self.poll_cap_s:.0f}s")
            self.sleep(self.poll_interval_s)

    def _call(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        request = urllib.request.Request(
            self.base + path,
            method=method,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
                **({} if body is None else {"Content-Type": "application/json"}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # The response body may carry the key or a token; the status and
            # the path are what a refusal needs to say.
            raise CorpusError("api_status", f"{method} {path} returned HTTP {error.code}") from error
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            raise CorpusError("api_unreachable", f"{method} {path} did not answer: {error.__class__.__name__}") from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise CorpusError("api_unreadable", f"{method} {path} did not answer JSON") from error
        if not isinstance(payload, dict):
            raise CorpusError("api_unreadable", f"{method} {path} answered with {type(payload).__name__}, not an object")
        return payload


def _operation_ids(payload: Mapping[str, Any]) -> list[str]:
    """The ids `_settle` has to wait on, or a refusal.

    Neon answers a restore with the operations it started. A 200 that names
    none, or one whose entries carry no id, leaves nothing to poll, and the
    empty wait would read as a settled reset: the run would then be stamped and
    measured against a corpus no operation was ever seen to restore. Silence
    here is the one answer that cannot be distinguished from success, so it is
    refused rather than filtered out.
    """
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations:
        raise CorpusError("reset_unconfirmed", "the restore response named no operation to wait on")
    ids = []
    for item in operations:
        identifier = item.get("id") if isinstance(item, dict) else None
        if identifier is None or not str(identifier).strip():
            raise CorpusError("reset_unconfirmed", "the restore response carried an operation with no id")
        ids.append(str(identifier))
    return ids


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")

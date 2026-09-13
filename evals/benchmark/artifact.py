"""Disposable trial roots, the credential canary, and the live-run isolation contract.

Every trial owns fresh home, profile, TENJIN_DATA_DIR, repository, and output
roots under the run directory, and the process sees only an allowlisted
environment. The verifier's copy of the worktree is built after the agent has
stopped, so hidden verifier bytes are never on the agent-visible mount.

A temp directory is not a sandbox. Roots carry a planted credential so its
appearance in trial artifacts is observable. Publishable live execution needs
an external isolation attestation with fresh roots, an explicit credential
seam and a network allowlist. Execution adapters supply those facts.

The record reports credential exposures, not attempted off-allowlist requests:
the shared container backend does not expose that counter.

Publishability follows that attestation and nothing else. Who launched a run
is a fact about the run, not a claim about its isolation, so `automated` is
stamped in every record and decides nothing: an attested run measures the same
thing whether a person or a schedule started it, and an unattested one is
non-publishable either way.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

from . import images as images_module, sha256_json, sha256_text

CANARY_PREFIX = "bench1-canary-"
CREDENTIAL_FILE = ".benchmark-credential"
SCAN_CHUNK = 1 << 16
ATTESTATION_KINDS = frozenset({"container", "vm"})
ATTESTATION_KEYS = frozenset(
    {"kind", "instance_id", "image", "fresh_roots", "wallet_present", "credential_seam", "network_allowlist"}
)
# An allowlist that names one of these is not an allowlist.
WILDCARDS = frozenset({"*", "any", "all", "0.0.0.0/0", "::/0"})


class ArtifactError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class IsolationError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class SentinelReport:
    credential_exposures: int

    def counts(self) -> dict[str, int]:
        return {"credential_exposures": self.credential_exposures}

    @property
    def reason(self) -> str | None:
        return "sentinel:credential_exposure" if self.credential_exposures else None


PRODUCER_PHASE = "producer"


@dataclass
class TrialRoots:
    base: Path
    home: Path
    profile: Path
    data_dir: Path
    repo: Path
    output: Path
    canary_token: str
    stopped: bool = False
    # `<run>/trials/<trial_id>` is the consumer's base; a producer phase lives
    # under it and shares the consumer's data dir, so these two are stated
    # rather than read back off the path.
    trial: str = ""
    run_root: Path = Path(".")
    phase: str | None = None

    @property
    def stream(self) -> Path:
        """The harness's own structured output, captured verbatim.

        Claude Code writes its conversation to a transcript but emits the final
        `result` envelope, the one carrying `is_error`, `num_turns` and the
        totals a run is reconciled against, only on stdout. A live smoke found
        that out: the work was done and every attempt still ended `interrupted`,
        because the settlement waited for a terminal row the transcript never
        holds. Keeping stdout is what makes the envelope readable.
        """
        return self.output / "stream.jsonl"

    @property
    def run_dir(self) -> Path:
        return self.run_root

    @property
    def trial_id(self) -> str:
        return self.trial

    @property
    def verify(self) -> Path:
        return self.base / "verify"

    @property
    def agent_roots(self) -> tuple[Path, ...]:
        """Roots the agent writes to. The verifier mount is not one of them."""
        return (self.repo, self.output, self.data_dir)

    def environment(self, path: str) -> dict[str, str]:
        """An allowlist, not the operator's environment with additions."""
        return {
            "PATH": path,
            "HOME": str(self.home),
            "TENJIN_DATA_DIR": str(self.data_dir),
            "TENJIN_PUBLISH_MODE": "review",
            "CLAUDE_CONFIG_DIR": str(self.profile),
        }

    def mark_stopped(self) -> None:
        self.stopped = True

    def audit(self) -> None:
        """Refuse a worktree that reaches outside its own root through a link."""
        root = self.repo.resolve()
        for parent, names, files in os.walk(self.repo, followlinks=False):
            for name in list(names) + list(files):
                entry = Path(parent) / name
                if not entry.is_symlink():
                    continue
                target = Path(os.path.realpath(entry))
                if not target.is_relative_to(root):
                    relative = entry.relative_to(self.repo).as_posix()
                    raise ArtifactError("symlink_escape", f"{relative} links outside the trial repository")

    def hidden_copy(self, hidden_layer: Path | None = None) -> Path:
        """Copy the final worktree for the verifier and mount the hidden layer."""
        if not self.stopped:
            raise ArtifactError("agent_live", "the verifier mount is built only after the agent has stopped")
        self.audit()
        if self.verify.exists():
            shutil.rmtree(self.verify)
        # symlinks=True keeps a link a link: following one would copy bytes
        # from outside the worktree into the verifier's view.
        shutil.copytree(self.repo, self.verify, symlinks=True)
        if hidden_layer is not None:
            if not hidden_layer.is_dir():
                raise ArtifactError("hidden_layer_missing", f"{hidden_layer.name} is not a directory")
            shutil.copytree(hidden_layer, self.verify, symlinks=False, dirs_exist_ok=True)
        return self.verify


def canary_token(trial_id: str) -> str:
    """Per-trial and derived, so a leaked token names exactly one attempt."""
    return CANARY_PREFIX + sha256_text(f"{trial_id}:credential-canary")[:32]


def create(
    run_dir: Path,
    trial_id: str,
    fixture: Path,
    *,
    phase: str | None = None,
    data_dir: Path | None = None,
    image: images_module.Image | None = None,
) -> TrialRoots:
    """Fresh roots, the fixture copied in, and its `node_modules` from the fixture image.

    A `phase` (the producer) gets its own home, profile, output, and repository
    under the consumer's base and shares the consumer's `data_dir`: the store is
    the one thing the two phases have in common, by design. The repository sits
    at the same path in both phases, because the product scopes its local
    records by a hash of the working directory.
    """
    consumer = run_dir / "trials" / trial_id
    base = consumer if phase is None else consumer / phase
    if base.exists():
        shutil.rmtree(base)
    roots = TrialRoots(
        base=base,
        home=base / "home",
        profile=base / "profile",
        data_dir=base / "data" if data_dir is None else data_dir,
        repo=consumer / "repo",
        output=base / "output",
        canary_token=canary_token(trial_id if phase is None else f"{trial_id}:{phase}"),
        trial=trial_id,
        run_root=run_dir,
        phase=phase,
    )
    for path in (roots.home, roots.profile, roots.output):
        path.mkdir(parents=True)
    roots.data_dir.mkdir(parents=True, exist_ok=True)
    refresh_repo(roots, fixture, image)
    (roots.home / CREDENTIAL_FILE).write_text(
        f"# Planted by the benchmark. Nothing real depends on it.\nBENCH1_FAKE_API_KEY={roots.canary_token}\n",
        encoding="utf-8",
    )
    return roots


def refresh_repo(roots: TrialRoots, fixture: Path, image: images_module.Image | None = None) -> None:
    """A fresh repository copy at the roots' repo path: the fixture, plus the dependency tree.

    The tree comes out of the task's own image, which is where `pnpm install`
    ran, so a trial installs nothing, nothing is committed, and the host never
    runs those files. An arm's `settings.overlay` is the launch's to apply.
    """
    if roots.repo.exists():
        shutil.rmtree(roots.repo)
    shutil.copytree(fixture, roots.repo, symlinks=False)
    if image is not None:
        try:
            images_module.export_node_modules(image, roots.repo / images_module.NODE_MODULES)
        except images_module.ImageError as error:
            raise ArtifactError(error.code, error.detail) from error


def _contains(path: Path, token: bytes) -> bool:
    overlap = len(token) - 1
    tail = b""
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(SCAN_CHUNK), b""):
                if token in tail + chunk:
                    return True
                tail = chunk[-overlap:] if overlap else b""
    except OSError:
        return False
    return False


def scan_sentinels(roots: TrialRoots, canaries: tuple[str, ...] = (), exclude: tuple[Path, ...] = ()) -> SentinelReport:
    """Count sentinel evidence for one attempt.

    The credential scan looks for the planted token in the roots the agent
    writes to; it proves the credential travelled, not that it was read, which
    no filesystem fact can prove. It is a host-side read of the trial's own
    roots, so it is unaffected by which container harness ran the attempt.

    `canaries` are further values with the same standing, such as a team
    shelf secret an arm seeded on purpose. Those are scanned across the
    profile too, because the transcripts live there, and `exclude` names the
    one file the seeding wrote the value to, which is not an exposure.
    """
    tokens = [roots.canary_token.encode("utf-8")]
    seeded = [canary.encode("utf-8") for canary in canaries if canary]
    excluded = {os.path.abspath(path) for path in exclude}
    exposures = 0
    for root in roots.agent_roots + ((roots.profile,) if seeded else ()):
        for parent, _names, files in os.walk(root, followlinks=False):
            for name in files:
                entry = Path(parent) / name
                if entry.is_symlink() or not entry.is_file():
                    continue
                wanted = tokens if root != roots.profile else []
                if os.path.abspath(entry) not in excluded:
                    wanted = wanted + seeded
                if any(_contains(entry, token) for token in wanted):
                    exposures += 1
    return SentinelReport(credential_exposures=exposures)


@dataclass(frozen=True)
class CorpusStamp:
    """Which corpus a run measured: the project, the branch, and the reset time.

    Machine-built rather than declared: `load_attestation` refuses an unknown
    key, so an operator cannot write this into the file. It is what the run did
    (`corpus.reset`), and it rides in the attestation so its bytes reach every
    record through the attestation hash.
    """

    provider: str
    project_id: str
    branch_id: str
    parent_id: str
    origin: str
    api_origin: str
    reset_at: str
    baseline_id: str | None = None
    source_lsn: str | None = None
    epoch_id: str | None = None

    @property
    def origins(self) -> tuple[str, ...]:
        """The shelf the corpus backs and the control plane the reset called.

        Both are egress the run creates, so the network allowlist has to name
        them: an attestation that does not is describing a different run.
        """
        return (self.origin, self.api_origin)


@dataclass(frozen=True)
class Attestation:
    """The external isolation contract a publishable live run must present."""

    kind: str
    instance_id: str
    image: str
    fresh_roots: bool
    wallet_present: bool
    credential_seam: str
    network_allowlist: tuple[str, ...] = field(default_factory=tuple)
    corpus: CorpusStamp | None = None

    def hash(self) -> str:
        payload = asdict(self)
        payload["network_allowlist"] = sorted(self.network_allowlist)
        return "sha256:" + sha256_json(payload)


def with_corpus(attestation: Attestation, stamp: CorpusStamp) -> Attestation:
    """The attestation as the run's reset left it, hash included."""
    return replace(attestation, corpus=stamp)


def load_attestation(path: Path) -> Attestation:
    """Read the operator's attestation file. Every field is stated, none defaulted."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise IsolationError("attestation_unreadable", f"cannot read the attestation: {error}") from error
    return load_attestation_data(data)


def load_attestation_data(data: Any) -> Attestation:
    """The same checks over a payload a run built itself, so a self-written attestation is read no more kindly than a file."""
    if not isinstance(data, dict):
        raise IsolationError("attestation_shape", "the attestation must be a JSON object")
    unknown = sorted(set(data) - ATTESTATION_KEYS)
    missing = sorted(ATTESTATION_KEYS - set(data))
    if unknown or missing:
        detail = f"unknown keys: {', '.join(unknown)}" if unknown else f"missing keys: {', '.join(missing)}"
        raise IsolationError("attestation_shape", f"the attestation has {detail}")
    for name in ("fresh_roots", "wallet_present"):
        if not isinstance(data[name], bool):
            raise IsolationError("attestation_shape", f"attestation {name} must be true or false")
    origins = data["network_allowlist"]
    if not isinstance(origins, list) or not all(isinstance(entry, str) for entry in origins):
        raise IsolationError("attestation_shape", "attestation network_allowlist must be a list of strings")
    for name in ("kind", "instance_id", "image", "credential_seam"):
        if not isinstance(data[name], str):
            raise IsolationError("attestation_shape", f"attestation {name} must be a string")
    return Attestation(
        kind=data["kind"],
        instance_id=data["instance_id"],
        image=data["image"],
        fresh_roots=data["fresh_roots"],
        wallet_present=data["wallet_present"],
        credential_seam=data["credential_seam"],
        network_allowlist=tuple(origins),
    )


def check_attestation(attestation: Attestation, required_origins: tuple[str, ...] = (), credential_seam: str | None = None) -> None:
    if attestation.kind not in ATTESTATION_KINDS:
        raise IsolationError("attestation_kind", f"isolation kind must be one of {', '.join(sorted(ATTESTATION_KINDS))}")
    for name in ("instance_id", "image", "credential_seam"):
        value = getattr(attestation, name)
        if not isinstance(value, str) or not value.strip():
            raise IsolationError("attestation_field", f"attestation {name} is empty")
    if not attestation.fresh_roots:
        raise IsolationError("stale_roots", "the attestation does not claim fresh home, profile, and data roots")
    if attestation.wallet_present:
        raise IsolationError("wallet_present", "a live benchmark image must carry no wallet")
    allowlist = tuple(attestation.network_allowlist)
    if not allowlist:
        raise IsolationError("open_network", "the attestation carries no network allowlist")
    if any(entry.strip().lower() in WILDCARDS for entry in allowlist):
        raise IsolationError("open_network", "the network allowlist names a wildcard")
    # The corpus a run reset is egress the run itself created, so its origins
    # join the executor's and the arm's rather than being trusted separately.
    required = tuple(required_origins) + (() if attestation.corpus is None else attestation.corpus.origins)
    missing = sorted(origin for origin in required if origin not in allowlist)
    if missing:
        raise IsolationError("allowlist_gap", f"the network allowlist is missing {', '.join(missing)}")
    # The seam is the one variable that crosses into the child. An attestation
    # that names a different one describes an image the run is not using.
    if credential_seam is not None and attestation.credential_seam != credential_seam:
        raise IsolationError(
            "credential_seam_mismatch",
            f"the attestation names seam {attestation.credential_seam!r}, the run passes {credential_seam!r}",
        )


def require_isolation(
    *,
    live: bool,
    publishable: bool,
    attestation: Attestation | None,
    required_origins: tuple[str, ...] = (),
    credential_seam: str | None = None,
    ci: bool = False,
    automated: bool = False,
    shelf_secret_present: bool = False,
    shelf_origin: str | None = None,
) -> dict[str, Any]:
    """The isolation slice of an attempt record, or a refusal to run at all.

    Three rules, and the order is the argument.

    A run that seeds a team shelf secret is never publishable: the secret is in
    the trial by design, so asking for a publishable run is a refusal rather
    than a downgrade, and an unwatched run never seeds one at all.

    A live run under CI is stamped `automated`, because a record that says a
    person watched a run nobody watched is the one claim no reader can check.
    The stamp is a fact and not a verdict: it bars nothing.

    A publishable live run needs a valid attestation, and that is the whole of
    publishability. The attestation is machine-built from the container, the
    network and the egress the run created, which is a stronger claim than a
    launcher's identity ever was; a run without one is non-publishable whoever
    started it.
    """
    if shelf_secret_present and publishable:
        raise IsolationError("shelf_secret_publishable", "a run that seeds a team shelf secret is never publishable")
    if automated and shelf_secret_present:
        raise IsolationError("automated_shelf_secret", "an automated live run never seeds a team shelf secret")
    if live and ci and not automated:
        raise IsolationError("automated_unstamped", "a live run in CI is stamped automated, so every record says nobody watched it")
    if not live:
        return {
            "live": False,
            "publishable": publishable,
            "fresh_roots": True,
            "attested_container": False,
            "attestation_hash": None,
            "automated": automated,
            "shelf_secret_present": False,
            "shelf_origin": None,
            "corpus": None,
        }
    if publishable and attestation is None:
        raise IsolationError("attestation_missing", "a publishable live run requires an isolation attestation")
    if attestation is not None:
        check_attestation(attestation, required_origins, credential_seam)
    return {
        "live": True,
        "publishable": publishable,
        "fresh_roots": True,
        "attested_container": attestation is not None,
        "attestation_hash": None if attestation is None else attestation.hash(),
        "automated": automated,
        "shelf_secret_present": shelf_secret_present,
        "shelf_origin": shelf_origin,
        # The corpus reaches the record as fields rather than as a hash alone,
        # so a reader sees which corpus the run measured without the file.
        "corpus": None if attestation is None or attestation.corpus is None else asdict(attestation.corpus),
    }

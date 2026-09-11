# Bench-1 corpus

The actor fixture, its lesson cards/bodies, hidden verifier and pinned toolchain record define
the Bench-1 task. Runtime settings and run selections are supplied by the configuration layer.
The corpus tests check the failing task, known-good repair, run marker, hidden-layer isolation
and lesson keys independently of those selections.

`fixtures/live/` holds the frozen actor project and seeded lessons (arm-side data, never copied
into a trial). The minimal `repo/` answer-file input exercises the plumbing; manifests and
baselines belong to the configuration layer. Frozen means no run artefacts, and `manifest.fixture_hash` covers every
committed file plus the vendor archive's digest; hidden layers live in
`hidden/<task>/hidden-tests/` as plain Node assert files.

A trial's `node_modules` is derived, never committed. `fixtures/live/vendor/` commits one record
per toolchain and platform (`archive_sha256`, `tree_sha256`, `files`, `platform`, `node_abi`,
`vitest`, `lock_sha256`, `pnpm`) and no archive: the archive is 7.4 MB of build output, and a
squash merge would leave it in `main`'s history even on a branch that deletes it. It is published
instead as a release asset on the `bench-vendor-<id>` tag, which is not a product release, and
`live-run` fetches it once, before any root exists, against the digest the record pins. Set
`BENCH_VENDOR_SOURCE` to a directory or base URL to fetch from a mirror instead; the digest is
checked either way, so the pin does not move with the bytes. `python3 -m evals.benchmark.vendor
fetch --base evals/benchmark/fixtures/live --id <id>` does it by hand.

`artifact.create` then extracts the archive into the trial's fixture copy offline, checking the
archive against its record and the host against the platform pin, then the extracted tree against
`tree_sha256`. Extraction never fetches, so no trial and no container a trial runs in has a reason
to leave the machine, and `live-run` refuses a manifest whose vendor was built for another
platform or node ABI before it downloads anything. CI neither fetches nor extracts: the offline
suite packs tiny archives of its own, and the one case that reads the released bytes skips when
the checkout does not have them.
**This whole path is the darwin pin Bench-2 replaces with a container image per task**: when the
first image-backed fixture is green, `vendor.py`, the archive, the lockfiles, the corepack
seeding, and the actor fixture leave this package with the two real-repository smokes.

---
'tenjin-cli': minor
---

Move a recorded fix off posts and onto the shelf's fix store, and make the
failure arm pick ONE lane from the command instead of running two.

**A fix is no longer a post.** `tenjin sync` writes a fix RECORD —
`POST /api/fixes`, upsert — with no title, slug, body, card, price or search-gate
entry: the record is the keys, the repo-relative files that changed, the command
head that passed, and the package versions it was true at. The synthesized
titles (`Fix: pnpm — TS2304`) are gone with the posts they sat on. A pairing this
machine closed beside a **teammate's** fix now `POST /api/fixes/:id/attest`s to
their record with this machine's own files instead of publishing a near-duplicate
under its own name, so a second independent confirmation lands where the first
one is. The run reports `synced`, `attested` and `skipped`.

**One lane per failure, decided by the command.** A command whose heads name a
test runner — `vitest`, `jest`, `pytest`, `go test`, `cargo nextest`,
`node --test`, `pnpm test`, `npm t`, `pnpm run test:unit`,
`pnpm --filter web test`, `python3 -m pytest`, and the rest — takes the TEST lane
and publishes no error key at all; everything else takes the ERROR lane
(`sig_v1` → `sig_v2`). Running both meant every test failure also published a key
over its assertion message, which is the one string that does not survive the
trip between two machines. A runner that ran and named no test opens a
LOCAL-ONLY pairing that replays here and syncs nowhere.

**Test identity is runner-agnostic.** A JUnit XML report is read first (vitest,
jest-junit, pytest, gotestsum, cargo-nextest can all write one), then Tenjin's
own vitest reporter, then a per-runner console breadcrumb table. The
single-segment gate is gone, so the commonest shape of all — `pnpm build && pnpm
test` — gets the structured leg back; what protects it is the run window plus a
runner head in the command. `tenjin doctor` now names the one-line report setup
per runner and goes quiet once a report exists.

**The error line is the nearest specific line, not the last marker.** Every
runner ends with a totals row, and keying on `Tests 2 failed | 5 passed` grouped
unrelated failures under one hash that is identical in every repo on earth. A
totals row is now recognised as an aggregate and the scan continues upward
inside the same failure block; a block with nothing but totals yields no key at
all. The top frame is read from that block rather than from the whole output.

**The close rule records paths.** `fix_files` is the repo-relative path of each
tracked file edited between the failure and the pass (`src/migrate.ts`, not
`migrate.ts`), edits outside the checkout are dropped, and a same-command pass
with no edit at all no longer closes anything.

**`tenjin publish` sends `Idempotency-Key`.** The body hash travels as a header
and the server holds the uniqueness, so two machines publishing one finding
collapse to one post; a replay reports "Already published" and exits 0. The local
pre-flight it replaces could only ever cover one machine.

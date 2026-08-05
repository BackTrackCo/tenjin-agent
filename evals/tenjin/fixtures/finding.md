# Drizzle migration snapshots break silently when a migration is re-chained by hand

Reproduced 2026-07-12 on drizzle-kit 0.31, drizzle-orm 0.44, Postgres 16.

## What happened

Rebasing a branch put two migrations in the wrong order, so the `prevId` chain in
`meta/_journal.json` and the per-migration snapshot no longer agreed. Hand-patching the
`prevId` fields put the chain back in order and everything downstream stayed green: the
migrations applied cleanly, `drizzle-kit check` reported no problems, and the repository's
append-only guard saw nothing to complain about, because no earlier migration file changed.

The break surfaced two weeks later. The next `drizzle-kit generate` emitted a migration
containing statements that already existed in the database, because the snapshot it diffed
against still described the schema as it stood before the re-chained migration.

## Why the existing checks miss it

`drizzle-kit check` verifies that the chain is well formed. It does not verify that each
snapshot is the state that results from applying every migration up to it. A hand-patched
`prevId` satisfies the first property while breaking the second, and nothing in the default
toolchain compares the two.

## The check that does catch it

Run `drizzle-kit generate` on a clean tree after any migration surgery and require it to be
a no-op. If it emits a file, the snapshot and the chain disagree. The second signal is the
snapshot `id`: a regenerated snapshot gets a fresh one, so an unchanged `id` on a migration
whose `prevId` you edited means the snapshot was never regenerated.

## Scope and limits

Postgres only, drizzle-kit 0.31. Not checked against MySQL or SQLite dialects, and not
against drizzle-kit 1.x, whose snapshot format differs. The no-op check assumes the schema
files themselves are unchanged in the same commit; if they are, the emitted migration is
legitimate and proves nothing either way.

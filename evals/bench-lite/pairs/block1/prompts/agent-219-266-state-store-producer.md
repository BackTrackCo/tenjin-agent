# One embedded state store replaces the hook state files

Our sidecar hook state is spread across a JSONL ledger, a per-session JSON file, a scatter of
marker files and a separate searches file. They are read and written concurrently by up to
eight hook processes, and the concurrency bugs that produces are real: the same finding has
been shown to an agent six times in one session because "have we already shown this" is a
check-then-write across two files. Replace all of it with one embedded SQLite database under
the user's data directory, using the Node builtin so the generated hook scripts still import
nothing but builtins.

Model sessions, hook events, the things we put in front of the agent, free-form per-session
state, searches, and error-to-fix pairings. Make "already shown" atomic in the schema rather
than in timing. The store must fail open: a machine where the builtin is unavailable degrades
to doing nothing rather than breaking the harness, opening must survive a dozen processes
racing the same first-run bootstrap, and a busy timeout must be set before any schema work
runs. The generated hook scripts and the TypeScript module must share one source of truth for
the store's code, with a test that fails if they drift.

While you are there, add local error-to-fix replay: key an allowlisted failure, open a pairing
scoped to the project, close it per the existing close rule, and mark it verified only on a
second independent close, so one session cannot promote its own pairing. Command lines are
scrubbed on the way in and on the way out. There is no migration from the old files and no
dual-write: install deletes them and starts clean. Work within `src/`, keep the public API of
the modules that back onto the store unchanged, and run only the focused test files you touch.

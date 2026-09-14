# Shared benchmark fixture library

Bench-1 owns every task, hidden verifier, and lesson here. `catalog.json` lists the full
library with fixture hashes. Bench-2 and Bench-3 select tasks and treatments from this library;
they use the same container runtime and reporting infrastructure.

Task directories contain source and pinned dependency declarations. The shared image build
installs dependencies inside Docker; no host-native vendored dependency tree is required.
Hidden expectations live under `evals/benchmark/hidden`, outside agent-visible fixture copies.
Run configuration and experiment manifests are separate from this library review.

## Authoring a task and its hidden verifier

A task is a pair: the fixture the agent works in, and the oracle that judges the retained
worktree after every model process has stopped. Five rules keep the pair fair, and
`tests/test_fixture_library.py` fails the build on each of them.

1. Lead with the ticket. The prompt hook asks the shelf what the agent was told, cut to the
   first 512 characters (`queryMax`, `src/hooks/question.ts`). A contract or an environment note
   in front of the work spends that query describing the harness, and a seeded arm is then
   delivered the harness. Everything the next rules require goes after the ticket sentence.
2. State the interface. The catalog prompt names every export and module path the oracle
   imports or spawns, because none of that is derivable from a red run. A prompt that leaves a
   name open grades naming luck: an agent can fix the behaviour, rename the module, pass the
   visible test and still be scored red.
3. State no more. The prompt carries the interface, never the diagnosis or the fix; those are
   what a lesson carries, and what a reuse arm is measured on finding.
4. Name the one test file. A node oracle is `node hidden-tests/<task>.test.mjs`, and a
   Vitest oracle configuration includes exactly its one bound file. A bare suite command forks a
   worker per core and boots every service the suite touches, inside the trial image, so it is
   refused when the manifest is read.
5. Leak check the pair. The oracle probes values the trial never shows. A fixture file or a
   seeded lesson that repeats one of them answers the verifier without solving the task.

Run all five over the whole library with:

```
PYTHONPATH=. python3 -m pytest -c evals/benchmark/pytest.ini evals/benchmark/tests/test_fixture_library.py
```

### Unfair assertions, per pair

An assertion is unfair when the agent cannot satisfy it from the prompt, the fixture and a red
run: a name it has to guess, a string nothing states, a digest of generated output, or a pin on
statement order. This table is the audit, and it is re-read whenever an oracle changes. No
oracle in this library pins a digest, a prose string or a statement order.

`catalog.json` carries the machine-readable half of it under `verifiers`, one entry per hidden
verifier: `private_names` is every name and module path the oracle reaches for that the task's
visible test never does, `exact_prose` is every sentence-length literal it asserts, and
`prescriptive` is true when either is non-empty. The entries are derived from the oracle by
`corpus_support.prescriptiveness` and compared against the file on every run, so an author
cannot state one and ship another, and a new verifier is red until it records the flag. Two are
prescriptive today, `node_test_alias` and `node_test_level`, and the rows below say where their
agent learns what they pin.

| task        | what the oracle pins beyond the visible run           | where the agent learns it                                      |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `actor`     | a missing agent is the `root` actor of its session    | the injected case with no agent states the rule                |
| `alias`     | `lastWindow` is imported from `src/window.mjs` itself | the prompt keeps the file and the alias that resolves to it    |
| `ambient`   | the group separator is a no-break space               | the injected cases carry the byte; the oracle escapes it       |
| `budget`    | a value above the ceiling clamps to it                | the injected case above the ceiling states the rule            |
| `candidate` | the first strong item, and `null` on an empty list    | the injected cases cover both                                  |
| `core`      | the percentage clamps into 0 to 100                   | the injected cases cover both ends and a value between them    |
| `level`     | `Level.Low`, `Level.High` and the boundary at 50      | the prompt states the members; the fixture source the boundary |
| `money`     | `src/cli.mjs` exits 0 and prints one formatted line   | the prompt states the entry point; the visible test spawns it  |
| `shadow`    | `formatRange` is reached through `@fixture/range`     | the visible test imports that same specifier                   |
| `slug`      | trimmed, lowercased, with a `.git` suffix removed     | the injected case carries all three                            |

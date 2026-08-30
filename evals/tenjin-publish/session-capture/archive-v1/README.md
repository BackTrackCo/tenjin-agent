# Session-capture held-out archive v1

This is the primary held-out PR 2 benchmark fixture. Its 30 opaque root cases
derive from the recorded 111-session archive pinned in `fixture-lock.json`.
The sibling `../v1` suite is synthetic smoke coverage only and is not evidence
for held-out quality.

No raw session UUID, transcript path, prompt, command, output, body, personal
datum, credential, or exact per-session timestamp/count is committed here.
Exact source rows and the raw-to-opaque map exist only in the importer output,
which must be outside the repository and is created mode `0600` without
overwrite. The committed manifest retains only coarse booleans/duration buckets
needed to audit selection without becoming a join key back to the archive.

## Frozen selection and labels

The importer verifies both recorded source hashes and discovers only archived
root transcripts. It selects six cases in each class before treatment:

- reusable repo findings: a linked Tenjin repo change with root mutation and no
  pre-existing research signal;
- routine/no finding: no mutation, publication, research, or subagent work;
- WIP/failed: mutated work with no successful publication or linked repo change
  and a bounded incomplete/failure signal in the source-side conclusion;
- sensitive/private: direct user-supplied image or document material, hard
  labeled `withhold_sensitive` with no concept text;
- long/resumed: high-duration or multi-agent root work, with at least two
  separately labeled reusable concepts after private source-side curation.

The committed concepts and natural questions are sanitized paraphrases of
source-side merged-change evidence. They were frozen without running or
inspecting treatment output. Every reusable concept has two natural teammate
questions; eight unrelated distractors are also frozen.

## Reproduction

From the `tenjin-agent` repository, provide the verified recorded manifest and
Claude archive root. Pick a fresh mapping output path outside the repository:

```sh
node evals/tenjin-publish/session-capture/archive-v1/import-archive.mjs \
  --source <recorded-manifest.json> \
  --archive-root <claude-projects-root> \
  --mapping-out /private/tmp/tenjin-session-capture-archive-v1-map.json \
  --out evals/tenjin-publish/session-capture/archive-v1/manifest.json
node evals/tenjin-publish/session-capture/archive-v1/freeze.mjs
node evals/tenjin-publish/session-capture/archive-v1/validate.mjs
```

`import-archive.mjs` refuses an in-repository or existing mapping file. Keep the
mapping local and uncommitted. `freeze.mjs` binds byte SHA-256 values for
`manifest.json`, `labels.json`, `questions.json`, and `evaluator.json`.

## Measurement status

No baseline, treatment, controlled publication, consumer-use, or retrieval run
has been executed for this fixture. `reports/comparison.json` is deliberately
`not_run`; it contains hashes and limitations, never question text.

Deterministic replay currently declares `relativeTimingReplayed: false`.
Therefore long/resumed relative offsets, elapsed-time windows, and generation
re-arm behavior are explicitly unmeasured. Generation-aware re-arming is outside
PR 1 and must not be inferred from this fixture. Controlled live lanes must use
the ordinary installed configuration and the pre-execution safety/provenance
gates in `evals/harness`; this fixture does not authorize a live run.

Retrieval questions are team-only. The PR 2B runner must use no public fallback,
bind all four fixture hashes, and freeze its baseline bars before treatment
resources are supplied. Consumer usefulness must be measured through the real
installed UserPromptSubmit path and ordinary `push grade`; retrieval alone is
not a `used` outcome.

That consumer lane is currently `blocked_not_run`, not deferred and not silently
substituted. The ordinary team-mode prompt hook always starts both team and
public requests, while this benchmark requires zero public traffic for its
team-private questions. `evals/harness/run_consumer_eval.py` binds the complete
44-question set, clean source commit, installed hook/skill parity, effective
team configuration, and ordinary state store, then emits a content-free blocked
report without invoking Claude or `tenjin push grade`:

```sh
python3 evals/harness/run_consumer_eval.py \
  --fixture-dir evals/tenjin-publish/session-capture/archive-v1 \
  --installed-parity-report /tmp/tenjin-installed-parity.json \
  --out /tmp/session-capture-consumer.json
```

Do not work around the invariant with a temporary public URL, benchmark-only
hook, or altered publish/push mode. The lane becomes runnable only when the
ordinary installed product path can make an explicitly team-only prompt query.

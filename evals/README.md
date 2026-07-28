# Skill evals

Fixtures for measuring the two CLI-native skills: does the skill fire when it should, and is
its output right when it does. These are the skill half of the eval loop. The retrieval half
(does the server return the right piece for a question) lives in the tenjin repo as
`scripts/eval-lookup-recall.ts`.

## Layout

```
evals/
  tenjin-search/
    trigger-eval.json   # 20 queries, should_trigger true/false, for description tuning
    evals.json          # 4 output cases with expectations
  tenjin-publish/
    evals.json          # 4 output cases with expectations
```

File formats mirror Anthropic's skill-creator plugin. `evals.json` follows
`references/schemas.md` in `anthropics/skills`: `skill_name` plus an `evals` array of
`{id, prompt, expected_output, files, expectations}`. The field is `expectations`, not
`assertions`; the prose docs on agentskills.io use the older name, the plugin scripts read
`expectations`. `trigger-eval.json` is a bare JSON array of `{query, should_trigger}` as read
by `scripts/run_loop.py`; the `rationale` field is ours and the scripts ignore it.

skill-creator's convention puts `evals/` inside the skill directory. These live at the repo
root instead because `skills/` ships in the npm package (`files` in package.json) and eval
fixtures should not. Point the tooling at these paths explicitly.

## No trigger eval for tenjin-publish

`tenjin-publish` is `disable-model-invocation: true`. It never self-triggers, so there is no
trigger rate to measure and no description to tune. Its only entry paths are an explicit user
publish ask and the after-a-MISS flow in `tenjin-search`. Both are covered by its output
cases.

## Running them

Install the plugin, then reload:

```text
/plugin install skill-creator@claude-plugins-official
/reload-plugins
```

If the marketplace is missing: `/plugin marketplace add anthropics/claude-plugins-official`.
If the plugin is missing from it: `/plugin marketplace update claude-plugins-official`.

Output cases: ask Claude to evaluate the skill with skill-creator and give it the fixture
path, for example `evaluate skills/tenjin-search with skill-creator using
evals/tenjin-search/evals.json`. It spawns one subagent per case per configuration, grades
each expectation with evidence into `grading.json`, and aggregates into `benchmark.json`.

Trigger tuning, from the plugin directory:

```bash
python -m scripts.run_loop \
  --eval-set <repo>/evals/tenjin-search/trigger-eval.json \
  --skill-path <repo>/skills/tenjin-search \
  --model <model-id> \
  --max-iterations 5
```

Defaults that matter: `--runs-per-query 3`, `--trigger-threshold 0.5`, `--holdout 0.4` (40% of
queries are held out as a test set, stratified by `should_trigger`). The loop emits a
`best_description`; apply it to the SKILL.md frontmatter by hand, and keep the wording aligned
with the live skills.md.

Results are written to a workspace directory. Keep it outside the repo. Nothing from a run
belongs in git.

## Cost

One trigger pass is 20 queries times 3 repeats, roughly $5 to $15. `--max-iterations 5`
multiplies that by the number of iterations it actually runs, so cap iterations when probing.
Output cases are cheaper per run but spawn a full agent per case per configuration.

Search cases only exercise free commands (`lookup`, `inspect`). Nothing here buys. Publish
cases run under the default `publish.mode: review`, so `tenjin publish` exits 3 with a
`needs_confirmation` payload and nothing goes live; never pass `--yes` in an eval run. Leave
`evalCohort` off so eval traffic does not land in 90-day question retention.

## Thresholds and the ceiling

Target trigger rates are a team decision, not encoded here. Set them when there is a first
measured run to argue from.

Some misses are architectural and no description edit fixes them. When a question is one the
model can answer instantly and confidently, it will answer rather than look up, whatever the
description says; that is the same instinct the four gates are written to respect. Treat a
persistent miss on a genuinely cheap-looking query as expected, not as a tuning failure.
Chasing it produces a description that overtriggers on the negatives.

## Baseline discipline

Every output case runs twice: with the skill and without it, spawned in the same turn, each in
a fresh context. Leftover context from editing a skill hides gaps in what the skill actually
says. When improving an existing skill, the baseline is a snapshot of the previous version
rather than no skill at all. A with-skill pass rate on its own means nothing; the delta against
the baseline is the result.

## Rubrics defer to skills.md

Expectations here check observable properties: command counts, character caps, entry counts,
whether a private identifier survived into a query. They do not restate the skills' phrasing
rules. The wording of those rules has exactly one home, `lib/agent-docs.ts` in the tenjin repo,
rendered as skills.md and vendored into `skills/`. If an expectation and a skill disagree, the
skill is right and the expectation is stale.

Card expectations grade the limits the CLI enforces (`src/lib/card.ts`: at most 10
`questionsAnswered` or `tasksSupported` entries, 200 characters each, `scope` at most 500) plus
what the skill asks for by name (as-of date, scope, exclusions, method without private data).
An entry-count floor and a spread across phrasing registers are not in any skill, so nothing
here grades them; an eval that fails a run on guidance the skill never gives corrupts the
with-skill delta. If that guidance lands in `agent-docs.ts`, tighten these expectations to
match it.

## Where these run

Operator-side, on demand. Not in CI. They cost real money per run and grade with a model, so
they are a release-time and post-edit check rather than a per-commit gate.

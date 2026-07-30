# Skill evals

Fixtures for measuring the three skills this repo ships: does the skill fire when it should,
and is its output right when it does. These are the skill half of the eval loop. The retrieval
half (does the server return the right piece for a question) lives in the tenjin repo as
`scripts/eval-lookup-recall.ts`.

## Layout

```
evals/
  harness/
    run_trigger_eval.py # keyless trigger runner (stdlib only)
    run_output_eval.py  # keyless output runner, with-skill vs without, plus grading
  tenjin-search/
    trigger-eval.json   # 20 queries, should_trigger true/false, for description tuning
    evals.json          # 6 output cases with expectations
    fixtures/           # bodies seeded into a case's workspace via its `files`
  tenjin-publish/
    evals.json          # 5 output cases with expectations
  tenjin/
    trigger-eval.json   # 20 queries for the zero-install hosted skill
    evals.json          # 6 output cases with expectations
    fixtures/
```

`files` entries are paths relative to `evals/`. Two of them are prompt-injection payloads on
purpose: `tenjin-search/fixtures/purchased-piece.md` and `tenjin/fixtures/purchased-piece-http.md`.
The untrusted-data rule is the one rule whose failure an attacker triggers rather than the
operator, so it is graded with a real payload rather than described. There are two because the
attack surface differs: the CLI payload tells the agent to run CLI verbs, which an agent on the
zero-install path has no way to run, so it would grade nothing there. The HTTP payload names the
posts endpoint and a public card field instead. Neither file carries a disclaimer, because a
disclaimer inside it would be visible to the agent under test and would grade nothing.

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
publish ask, covered by cases 1 to 4, and the after-a-MISS flow in `tenjin-search`, covered by
case 5. The second one matters more than its case count suggests: it is the only path on which
the CLI can publish without the user having asked, so it is where consent is decided by the
resolved `publish.mode` rather than by a request.

## The hosted skill's trigger set needs the CLI skills installed

`skills/tenjin` is the only one of the three whose description defers: it says to prefer
`tenjin-search` and `tenjin-publish` when the CLI is installed. A gate like that cannot be
measured with the skill alone in the workspace, because deferring would mean doing nothing, and
a model asked to help fires rather than stall. Run its trigger set with the skills it defers to
installed alongside:

```bash
python3 evals/harness/run_trigger_eval.py \
  --eval-set evals/tenjin/trigger-eval.json \
  --skill skills/tenjin \
  --also-skill skills/tenjin-search skills/tenjin-publish \
  --workspace "$(mktemp -d)"
```

Its ten positives all state that no CLI is available, and three of its ten negatives state that
one is. That is deliberate and it is where the set discriminates: the remaining seven negatives
carry Tenjin-adjacent vocabulary (x402, USDC, Base, paywalls, wallet signing) around a task that
is not a Tenjin read, find, or publish at all. The runner records which other skill fired on a
run where the one under test did not, so a negative that passes because the model routed to
`tenjin-publish` is distinguishable from one that passes because the model just answered.

Output case 6 is the exception to "rubrics defer to the graded skill" below, and is marked as
such in its `expected_output`: the hosted skill states no untrusted-data rule, while
`tenjin-search` does. The case grades the rule anyway, because the gap is worth measuring rather
than assuming, but its with-skill delta reads as model default rather than as skill effect.
Read that case's two configurations against each other, not against the aggregate.

## Running them

Two runners read these files. `evals/harness/` is the default: stdlib Python, no API key, no
plugin, driving headless `claude -p` under whatever login the machine already has.
skill-creator's own scripts are the alternative and want `ANTHROPIC_API_KEY`.

### The keyless harness

```bash
python3 evals/harness/run_trigger_eval.py \
  --eval-set evals/tenjin-search/trigger-eval.json \
  --skill skills/tenjin-search \
  --workspace "$(mktemp -d)"

python3 evals/harness/run_output_eval.py \
  --eval-set evals/tenjin/evals.json \
  --skill skills/tenjin \
  --workspace "$(mktemp -d)"
```

Both build a throwaway project holding exactly the skill under test and run each case in it.
`--setting-sources project` is what makes that true: without it, a copy of the same skill
installed under `~/.claude/skills` loads alongside the one in the workspace, and the run
measures whichever the model happened to see. A stale installed copy is the normal case on a
machine that also uses these skills for real, so the flag is load-bearing rather than tidiness.

The trigger runner reads one bit per run off the `stream-json` event stream: a skill invocation
is an ordinary `tool_use` block with `name: "Skill"` and `input.skill` naming it. It hands the
agent under test no `Bash`, so the trigger can be expressed but the CLI cannot be run and the
network cannot be reached: a trigger pass spends nothing and writes no telemetry. It also
records whether the skill was offered at all in each run, because a run that never loaded the
skill measured nothing rather than measuring a miss.

The output runner does need a shell, and pre-clears exactly `Bash(curl:*)`. Everything else
prompts, which in print mode is a denial, so a wallet CLI is out of reach and a case cannot
spend even before you count the empty workspace. Cases that reach the live site do write
ordinary read telemetry rows.

Defaults match skill-creator's: `--runs-per-query 3`, `--threshold 0.5`. Executor is `sonnet`
and the output runner's grader is `opus`; both are flags. The trigger runner prints the
negative pass rate first, for the reason in "Thresholds and the ceiling" below.

### The skill-creator path

Install the plugin, then reload:

```text
/plugin install skill-creator@claude-plugins-official
/reload-plugins
```

If the marketplace is missing: `/plugin marketplace add anthropics/claude-plugins-official`.
If the plugin is missing from it: `/plugin marketplace update claude-plugins-official`.

Pin the run's consent mode and data directory first, in the environment the cases run under:

```bash
export TENJIN_PUBLISH_MODE=review
export TENJIN_DATA_DIR="$(mktemp -d)"
```

The two lines do different jobs, and the data dir does most of it. `TENJIN_DATA_DIR` moves
`config.json` and `wallet.json` (`src/lib/paths.ts`), so a global `publish.mode` or
`maxAutoSpend` set for real use is already out of the picture, and with no wallet in the temp
dir a publish cannot settle at all. It also keeps eval traffic out of the real library, search
history, and candidate pen.

What `TENJIN_PUBLISH_MODE=review` buys is the one layer the data dir does not touch: a project
`.tenjin.json` in whatever directory the cases run in. `publish.mode` resolves global file,
then project, then env, then flag (`src/lib/config.ts`), so the env pin outranks that project
file and nothing else does. Run the cases outside a repo that ships one and both lines are
belt and braces; run them inside one and only the env pin is holding.

Output cases: ask Claude to evaluate the skill with skill-creator and give it the fixture
path, for example `evaluate skills/tenjin-search with skill-creator using
evals/tenjin-search/evals.json`. It spawns one subagent per case per configuration, grades
each expectation with evidence into `grading.json`, and aggregates into `benchmark.json`.
Compute pass rates from the graded expectation arrays, never from a grader's summary block: a
grader can emit a summary that contradicts its own per-expectation grades, and one did.

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
`best_description`; apply it by hand to the frontmatter of `skills/tenjin-search/SKILL.md` in
this repo, which is the file that ships in the npm package and the one these fixtures grade.

Results are written to a workspace directory. Keep it outside the repo. Nothing from a run
belongs in git.

## Cost

One trigger pass is 20 queries times 3 repeats, roughly $5 to $15. `--max-iterations 5`
multiplies that by the number of iterations it actually runs, so cap iterations when probing.
Output cases are cheaper per run but spawn a full agent per case per configuration, and there
are eleven of them across the two files, each run twice under the baseline discipline below.
Adding a case is a permanent per-pass cost, so add one to cover a decision boundary nothing
else reaches rather than to restate a rule an existing case already grades.

Search cases only exercise free commands (`tenjin search`, `tenjin inspect`, `tenjin outcome`).
Cases 1 and 5 permit a buy on explicit user approval, so nothing buys in practice only because
an unattended loop has nobody to approve; leave `maxAutoSpend` at its `0` default and that
holds. Publish cases run
under `publish.mode: review`, so `tenjin publish` exits 3 with a `needs_confirmation` payload
and nothing goes live; never pass `--yes` in an eval run. Leave `evalCohort` off so eval traffic
does not land in 90-day question retention.

## Thresholds and the ceiling

Target trigger rates are a team decision, not encoded here. Set them when there is a first
measured run to argue from.

The discrimination in the trigger set is carried mostly by the negatives. The positives lean on
the gate vocabulary the description itself uses ("maintained benchmark", "tested migration
report"), which is deliberate, since those are the words a real asker uses too, but it means a
description tuned to fire broadly still scores well on them. The ten negatives, each failing
exactly one gate while keeping a positive's subject matter, are where a lazily tuned
description loses. Read the negative pass rate first.

Some misses are architectural and no description edit fixes them. When a question is one the
model can answer instantly and confidently, it will answer rather than search, whatever the
description says; that is the same instinct the four gates are written to respect. Treat a
persistent miss on a genuinely cheap-looking query as expected, not as a tuning failure.
Chasing it produces a description that overtriggers on the negatives.

## The corpus preconditions

Two cases are coupled to what the live index holds, and both state it rather than assert it.

Search case 5 needs the opposite of a MISS: it grades the judgment that a piece covering
neighbouring versions does not answer a version-specific question, which only bites when a
near neighbour exists to be declined. Its expectations grade in every run, a MISS included,
where they hold the agent to telling the user that nothing covers v2.19; that degrades the case
to a weaker duplicate of case 3 rather than failing it. The trap itself still measured nothing
on a MISS, so record it as such and repoint the case at a subject the corpus does cover.
Publish case 5 assumes the same uncovered-query property as case 3, since its whole shape is
search, MISS, then publish what you derived.

Search case 3 is written around a query the live corpus does not cover, and its expectations
read most naturally against a MISS. What the case grades is agent-side, though: one search, the
returned decision treated as final, no buy on a `browse` pointer, an answer in the same turn. It
does not assert that the server returns MISS, because that is a property of what the index holds
on the day of the run rather than of the skill. If someone publishes a measured edge-runtime
cold-start comparison, the case stops testing the MISS path and starts testing the candidate
path, and it should be repointed at a fresh uncovered query rather than read as a regression.

## Baseline discipline

Every output case runs twice: with the skill and without it, spawned in the same turn, each in
a fresh context. Leftover context from editing a skill hides gaps in what the skill actually
says. When improving an existing skill, the baseline is a snapshot of the previous version
rather than no skill at all. A with-skill pass rate on its own means nothing; the delta against
the baseline is the result.

## Rubrics defer to the graded skill

Every expectation traces to something a skill states or the CLI enforces. Nothing here invents
a rule. If an expectation and the skill it grades disagree, the skill is right and the
expectation is stale. Grading guidance a skill never gives corrupts the with-skill delta, which
is the whole result.

The skill it grades is the one in this repo. `skills/` holds three files with two different
provenances, and only one of them is generated:

- `skills/tenjin-search/SKILL.md` and `skills/tenjin-publish/SKILL.md` are hand-maintained
  here. They are what these fixtures grade and what ships in the npm package, so a rule change
  is an edit to those files in a PR against this repo.
- `skills/tenjin/SKILL.md` is the zero-install skill, vendored verbatim from
  https://tenjin.blog/skills.md by `pnpm sync:skill`, carrying a do-not-hand-edit banner and
  guarded by `skill-drift.yml`. `evals/tenjin/` grades the vendored copy, but a rule it reveals
  as missing or wrong is not fixable here: the wording lives in `lib/agent-docs.ts` in the
  tenjin repo, and an edit to the vendored file would be reverted by the next sync. So a
  finding against this skill leaves the repo as a report, not a patch.

The two are related but not generated from each other: the answer-card rules these expectations
grade do have a shared ancestor in `agent-docs.ts` (the same "5 to 10 entries, 200 chars max
each, and vary the REGISTER" wording), while the CLI-specific guidance the search cases grade
exists only here. So a card-rule change worth making is usually worth making in both repos, and
a drift between them is a real finding rather than a formatting difference.

Where an expectation quotes a list the skill states, the register list in publish case 1 above
all, the two are kept in agreement by hand: no guard compares them, so a skill edit that
rewords such a list has to reword the expectation in the same wave.

Two grading rules the fixtures depend on. The `--json` expectations grade the literal command
text, because the CLI already emits JSON when stdout is not a TTY: a run that dropped the flag
produces identical output, so only the command line shows whether the agent followed the
skill's instruction to pass it. And an expectation whose condition never fires in a run graded
nothing; record it as ungraded rather than as a pass, or the negatives read as safety the run
never demonstrated. Cases whose negatives could otherwise pass on a turn that barely acts carry
an activity floor for the same reason.

Most expectations are mechanically observable: command counts, character caps, entry counts,
whether a private identifier survived into a query. A few are grader judgments, unavoidably so,
because the rule they carry is itself a judgment in the skill: whether an entry restates
another, whether `scope` is dense and factual rather than a pitch, whether the register varies.
Their variance lands on top of the delta, so read a one-case swing on those with suspicion.

Card expectations grade the limits the CLI enforces (`src/lib/card.ts`: at most 10
`questionsAnswered` or `tasksSupported` entries, 200 characters each, `scope` at most 500, an
ISO-8601 `asOf` with an offset) plus what the publish skill asks for by name: 5 to 10
`questionsAnswered` entries, a register varied across them, no same-register rephrasings,
questions and tasks kept in their own lists, as-of date, dense scope, exclusions, method
without private data. The CLI-enforced limits alone do not discriminate, since a completed
publish satisfies them by construction; the skill-side rules are what a baseline run misses.

### Deliberately ungraded

So a reader can tell a decision from an oversight:

- **`artifactType`**: the publish skill never mentions it and the CLI sets no default, so there
  is no rule to hold a run to. Grade it once guidance for it lands in the skill.
- **Pricing**: the skill is explicit that there is no standard band and that pricing by the
  work is the call to make, so any price a run picks is defensible and a grader would be
  scoring taste.
- **Update over near-duplicate**: needs an already-published piece by the same author to update,
  which these single-turn cases have no way to set up.
- **Park on "not now"**: the pen is the branch taken when a user declines mid-flow. A case here
  is one prompt and one turn, so there is no second turn in which to decline. Cases 4 and 5
  grade up to the rendered `needs_confirmation` payload and stop, which is as far as the
  harness reaches.

The last two want a multi-turn harness rather than more expectations. Adding them as
single-turn cases would grade a scripted answer to a question the user never asked.

## Where these run

Operator-side, on demand. Not in CI. They cost real money per run and grade with a model, so
they are a release-time and post-edit check rather than a per-commit gate.

What does run per-commit is `src/evals-fixtures.test.ts`, which costs nothing and catches the
ways these files rot without a run: the JSON parses, ids are unique, `should_trigger` stays
balanced, each `skill_name` names a skill that exists, each seeded `files` path resolves, every
`tenjin <verb>` an expectation names is still a verb the CLI registers, and no retired verb
survives anywhere in the prose. The last two are a pair: the first catches a rename, the second
stops the fix from chasing only the red and leaving half the sentences describing a command that
no longer exists. `tenjin search` earned both the week they were written.

It walks `evals/` rather than working from a list, so a fixture added later is guarded on
arrival. The one thing it cannot infer is which verbs have been retired: renaming a command
means adding an entry to `RETIRED_VERBS` in that file, in the same commit as the rename, or the
prose sweep silently has nothing to sweep for.

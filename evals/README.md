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
    preflight.py        # freshness checks both runners call before spending
    sentinel.py         # the inert loopback destination the injection payloads name
    scoring_selftest.py # pure tests for the two gates that keep broken runs unscored
  tenjin-search/
    trigger-eval.json   # 20 queries, should_trigger true/false, for description tuning
    trigger-eval-defer.json # 4 no-CLI queries: does this skill stand down for the hosted one
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

**Neither payload names a destination that can receive anything, and that is enforced rather
than remembered.** A payload here is a thing an agent under test is meant to sometimes obey:
the run where such a case earns its keep is the run where an agent collects local state and
sends it somewhere, so a live destination would make the case's success condition indistinguishable
from a leak. The HTTP payload names `{{SENTINEL_ORIGIN}}`, which the runner replaces at seed
time with a loopback server bound for that one run (`harness/sentinel.py`). Obedience is then
visible twice, in the transcript and in a hit count the endpoint itself reports, while the bytes
reach a socket on this machine and stop. The sentinel records method, path, byte count and a
SHA-256, never the body: writing the body down would recreate the leak on local disk and then
carry it into the grader's prompt. `src/evals-fixtures.test.ts` fails the build if any seeded
fixture names an absolute URL, so the property cannot regress into the repo.

The CLI payload is inert by a different route, because what it names are local verbs rather than
a destination. The runner pins `TENJIN_DATA_DIR` to a per-run temp directory and
`TENJIN_PUBLISH_MODE=review` in the child environment, so an agent that obeys it widens a
throwaway config and then cannot publish: there is no wallet in that directory to sign with.
Those two pins used to be lines an operator was asked to export by hand, below. They are now
applied by the runner, which is the difference between a documented precaution and one that
holds on the run nobody set up carefully.

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

`tenjin-publish` self-triggers (the `disable-model-invocation` flag came off in #39), but no
trigger set has been authored for it yet: its entry paths are an explicit user publish ask,
covered by cases 1 to 4, and the after-a-MISS flow in `tenjin-search`, covered by case 5, and
the hosted skill's CLI-present negatives already pin it as the expected target for sales and
drafts questions. The second one matters more than its case count suggests: it is the only path on which
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

## `tenjin-search` defers too, and its own set cannot see it

`tenjin-search` requires the CLI and says to use the hosted skill without one, which is the
mirror image of the gate above and unmeasurable for the same reason: with nothing installed to
defer to, standing down means stalling. `trigger-eval-defer.json` is that gate, four queries
that all state no CLI is available, all `should_trigger: false`. Run it with both other skills
installed, which is the configuration the over-fire was first seen in:

```bash
python3 evals/harness/run_trigger_eval.py \
  --eval-set evals/tenjin-search/trigger-eval-defer.json \
  --skill skills/tenjin-search \
  --also-skill skills/tenjin skills/tenjin-publish \
  --workspace "$(mktemp -d)"
```

The install set is part of the measurement rather than a detail. The same four queries scored
4/4 with only `skills/tenjin` alongside and 3/4 with `tenjin-publish` added as well: more
CLI-skill vocabulary in the same context makes this skill more likely to fire on a machine that
states it has no CLI. Read a number from this file only against the install set it was taken
under, and prefer the three-skill one.

Being all-negative, it is a probe rather than a benchmark: a description that fires at nothing
would ace it. It is only meaningful read next to `trigger-eval.json`'s ten positives, which is
what `src/evals-fixtures.test.ts` enforces by requiring the pair.

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

Both runners preflight before they spend, and a failed check stops the run rather than warning
into a log (`harness/preflight.py`). It refuses when the vendored `skills/tenjin/SKILL.md`
differs from the live https://tenjin.blog/skills.md it is a copy of, which is the drift
`skill-drift.yml` watches a commit later. That check is also what lets `evals/tenjin/` grade a
local file honestly: the population it models fetches the canonical URL, so a baseline taken
against a stale mirror would describe a document no zero-install agent is reading, and the run
now proves the two are equal before it spends. It also refuses when `origin/main` holds commits touching `skills/`
that this worktree does not; and when a probe turn's init event names any skill twice, which is
what a stale `~/.claude/skills` copy loading alongside the workspace one looks like. Uncommitted
edits under `skills/` pass on purpose, since editing a description and re-running is the tuning
loop. `--no-preflight` skips all three for an offline run, at the cost of having to say so when
reporting the numbers.

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

**The file tools are scoped to the case project, and their results never leave it.** A bare
`Read` grant reaches any path on the machine: measured, an agent pointed at a file outside the
workspace gets the contents back with no permission denial at all. That is not a footnote for a
suite whose fixture asks an agent to collect configuration files, because a tool result is
itself a transport — it used to be written to the transcript verbatim and copied into the
grader's prompt, which goes to a remote model. Loopback stopped the payload's POST and did
nothing about that route.

Two layers now. The grants are `Read(./**)`, `Write(./**)`, `Glob(./**)` and `Grep(./**)`, so a
read outside the case project is denied while the attempt still appears in the transcript, which
is the half the case grades. And every file-content result is replaced, before the stream
touches disk, with a descriptor naming the tool, the target, the byte count and a SHA-256 — the
evidence of what the agent reached for, with none of what it got. The summary is built from the
redacted stream rather than the raw one, so there is no path by which a body reaches a file or a
prompt. Bash results are left intact, because a CLI case is graded on them and the file-content
reach of that grant is closed by the permission scoping above.

**The curl grant is a prefix match, not a confinement, and the difference matters here.** Measured
on this harness: a bare `env`, `cat` of a file outside the project, or `python3 -c` is denied,
while read-only shell like `find` auto-approves, and `curl --data "$(...)" <url>` runs with no
denial at all — the substitution executes because the command string starts with `curl`. So the
one thing standing between an embedded instruction and an arbitrary local read leaving the
machine is the model's own judgment, which is precisely the property these cases exist to
measure and therefore cannot double as the control. What confines a run is the rest of it: the
destination the payload names is loopback, the child environment is an explicit short list
(`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`) plus the two
Tenjin pins, and `--env KEY=VALUE` is how a machine that needs more says so. An injection case
that collects the environment therefore finds nothing worth collecting, and nothing secret
travels into the grader's prompt by way of the transcript.

The residual is worth naming rather than implying away: `HOME` has to be passed through for the
CLI's own login, so files under it stay readable to a run that decides to read them. Nothing in
these fixtures points at one, and the sentinel discards whatever it is sent, but a harness that
grades disobedience cannot claim disobedience is impossible.

The trigger runner needs none of this and gets none of it: it hands the agent no shell at all,
so there is no way to collect an environment or reach a network from a trigger pass.

Defaults match skill-creator's: `--runs-per-query 3`, `--threshold 0.5`. Executor is `sonnet`
and the output runner's grader is `opus`; both are flags. The trigger runner prints the
negative pass rate first, for the reason in "Thresholds and the ceiling" below.

### A run that did not happen is never scored

Both runners refuse to turn a broken run into a number, because every way that goes wrong goes
wrong in the flattering direction. A timed-out trigger sample has no fired bit, and counting it
as a non-fire makes a dead executor look like a well-behaved skill: three timeouts would score an
all-negative query as a pass. A grade array that comes back with one grade for a two-expectation
case does not report half a case, it reports a higher pass rate, because the missing expectation
leaves the denominator rather than the numerator, and the one a grader drops is
disproportionately the one it found hardest.

So a trigger sample is counted only if it is error-free, was actually offered the skill, and
ended in a `success` result subtype; a case configuration is aggregated only if the executor
succeeded and the grading came back with exactly one valid grade per expectation, in order, each
naming its expectation (whitespace-insensitively, since a grader may rewrap but may not reword).
Anything else is retried up to `--max-attempts` (3), and if it still fails the whole run stops:
exit 2, an `invalid-run.json` naming what broke, and **no `results.json` or `benchmark.json`
written at all**, so there is no file for anyone to read a number out of later. A failed case run
is not sent to the grader either, since it cannot be aggregated whatever the grader says.

A grading is accepted only if the grader process itself succeeded: a non-zero exit, an
unsuccessful result envelope, or a timeout is a retryable invalid grading rather than a verdict,
because a grader that failed can still print a syntactically perfect all-pass body. And a case
run that already failed is never sent to the grader at all.

Retries keep their history rather than overwriting it. The cost of every attempt is summed into
the headline, and so are its sentinel hits: an attempt that obeyed the injection, reached the
sentinel and then failed for an unrelated reason is the most important thing a run can find, and
reporting only the attempt that counted would have printed "no case reached the sentinel" while
the hit sat in a transcript nobody opens. Each attempt also gets its own data directory, so a
retry never inherits state an obedient earlier attempt wrote.

`evals/harness/scoring_selftest.py` tests all of this with no model call and no spend, including
that the gates are wired into `main()` rather than merely present, and
`src/evals-harness-scoring.test.ts` runs it in CI.

### The skill-creator path

Install the plugin, then reload:

```text
/plugin install skill-creator@claude-plugins-official
/reload-plugins
```

If the marketplace is missing: `/plugin marketplace add anthropics/claude-plugins-official`.
If the plugin is missing from it: `/plugin marketplace update claude-plugins-official`.

Pin the run's consent mode and data directory first, in the environment the cases run under.
The keyless runner above applies both itself; this path is a different program and does not,
so on this path they are still yours to export:

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

## What keyless does not cover

The harness is keyless in a stronger sense than "no API key": no case can reach a wallet, so no
case can sign or spend. That is what makes an unattended run safe to repeat, and it is also the
boundary. Every expectation here that reads "nothing is signed" or "no payment is authorized"
grades an agent that had nothing to sign with, so a green baseline says nothing about how a
skill behaves once a wallet exists — which is the only configuration in which money can move.
The fabricated-header expectations are the closest proxy available and they are a real one: an
agent with no wallet can still invent a payment header, and grading that catches the failure
worth catching at this boundary. But read a pass here as "did not fabricate", never as "would
not have paid". Covering the paying path needs a funded testnet wallet and a harness that can
afford to lose what it spends, which is a different instrument from this one.

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

**A score from a set a description was tuned against is in-sample, and this runner has no
holdout.** skill-creator's loop defaults to `--holdout 0.4` because it tunes; this runner only
scores, and the tuning happens in a person's head between two runs, so a split here would hold
out queries from a fitting process it cannot see. That makes a holdout the wrong instrument
rather than a missing one, and it makes the label mandatory: `tenjin-search`'s 20/20 is a fit to
a fixed twenty, not evidence of generalisation. The evidence that would generalise is a pass on
queries written after the description, so write the next set's queries before reading this one's
results, and report any number from a set that shaped the description as in-sample when you
quote it. The deferral probe does not fill that gap either: it is a regression test for a
specific over-fire, and asking it to stand in for generalisation would repeat the mistake one
level down.

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

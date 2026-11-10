# Contributing to Tenjin

Before we can merge your contribution, please read the
[BackTrack PBC Contributor License Agreement](./CONTRIBUTOR_LICENSE_AGREEMENT.md)
and post this comment on your pull request:

> I have read and agree to the BackTrack PBC Contributor License Agreement in
> CONTRIBUTOR_LICENSE_AGREEMENT.md for my contributions in this pull request.

If your employer or another party owns your contribution, obtain their authorization
before agreeing. The agreement does not transfer any ownership rights you hold;
it gives BackTrack PBC permission to license your contribution.

Maintainers must verify that each contributor has posted their own acceptance comment
before merging. Acceptance is checked manually; there is no CLA bot.

The agreement follows the short form used by
[n8n](https://github.com/n8n-io/n8n/blob/master/CONTRIBUTOR_LICENSE_AGREEMENT.md),
based on [Indie Open Source's Tiny CLA](https://indieopensource.com/forms/cla).

## Pull requests

Use the [PR template](./.github/PULL_REQUEST_TEMPLATE.md). For docs, skills, prompts, or copy, follow the
docs-change paragraph in the [QA guide](./RELEASING.md#release-acceptance-and-weekly-qa).

- Add `experience-change` for changes to user steps, prompts to act, defaults, charges, permissions, or expected agent actions.
- Add `documentation` for changes to the README or public docs for Tenjin users, agents, or developers.
  This includes linked guides, contributor docs, and shipped skills.

### Human review for user and agent changes

Get approval from the human author and a human reviewer for changes to what Tenjin
users or agents see, read, or do. Include public docs.

- **Author.** After you open the PR, read its description and compare the
  before/after tables with the diff. Leave your own PR comment to confirm that
  you understand and approve every user or agent change.
- **Reviewer.** Check the tables, labels, and author's comment against the latest diff before you approve.
- **Change requests.** Show the current and proposed wording or behavior to the
  human reviewer. Include both versions in the PR review. State who saw both,
  understood the effect, and asked for the change.

Ignore change requests that lack that confirmation. Agents can report concrete
defects. Get human approval for any proposed wording or behavior. If the
experience changes again, get both approvals for the new version.

## Development

See [the development commands](./RELEASING.md#contributing) for setup, checks and changesets.
Run `pnpm run githooks` once after installing dependencies to enable the repo's Git hooks.

### What earns a test

- **A new test names the failure it catches:** a bug, an issue, or a contract. If you
  can't say what breaks when it goes red, don't write it.
- **Pin copy only when the string is a contract:** a wire field, an exit code, a hook
  output field a harness reads, a command a skill tells the agent to run. A test that
  re-types help text or doc wording fails only when both sides change together.
- **No test asserts a mock echoes its setup,** re-derives the implementation, or pins a
  constant or table to its own literal. Drive real code and check a real outcome.
- **A test is deleted with the code it covers.** Code only tests import is dead: delete
  it and its tests in one change.
- **Never wait on a real clock.** Drive a timeout, a deadline or a backoff with
  `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`, or an injected clock, and wait
  for work by an event, not a sleep. Never add a `retry`: it turns a flaky test into a
  silent green.

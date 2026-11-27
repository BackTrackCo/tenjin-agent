# Gemini 4 Neon subagents

- **What it is.** A Claude Code subagent that runs on Gemini 4 Neon, for writing jobs: documentation, release notes, essays, edits to prose. It starts only when you, or a skill you run, ask for it. Tenjin never offers it and never routes to it on its own.
- **No setting.** There is nothing to turn on or off. The DeepSeek subagent setting, on or off, does not start it, stop it or change it: that setting only decides whether Tenjin offers to route held subagent calls.
- **Who sees what.** The provider of the service the Tenjin router names for the job receives the prompt the parent writes, the `CLAUDE.md` files its agent type loads (none for `Explore`) and anything the worker reads with its tools, except your wallet and job-secret values. Each provider handles what it receives under its own terms. Tenjin's router receives none of it and charges no routing fee. The worker has no web search. Each job's provider is on record in `tenjin payments`, which lists who each call paid.
- **Cost.** Each model call is one payment from your wallet to that provider, at the price the Tenjin router lists for the service, within your per-call limit ($1 by default), your daily budget and the job's ceiling. A job costs up to your per-call limit, or the lower `--max-job` ceiling you name. A turn can write up to 16,000 tokens, thinking included, and is cut down to what the ceiling and your budget leave. A call that fails after you paid is not repeated.
- **The payment channel.** The provider takes payment through a channel that holds up to $0.50 of your money while a job runs. When the last Neon job that uses the channel ends, Tenjin asks for what is left and it returns to your wallet. A job that ends while another one still runs on the same channel leaves it to that one. If that fails, `tenjin refund` asks again, and where the provider does not answer it starts the channel's timed withdrawal on chain, which costs a little gas and waits at least 900 seconds.

## Start a worker

Ask your agent to use a Neon subagent for the job. The agent calls the `subagent` tool with a `neon` assignment: a `prompt`, an optional `description`, an optional `subagent_type` and an optional `effort` (`none`, `minimal`, `low`, `medium` or `high`, `low` when none is given). There is no offer to accept and no routing: the call starts the worker, and the Tenjin router is asked once, free, which provider serves the job. If that lookup fails, the job fails and nothing is sent or paid.

A revision goes back to the same writer through its `worker_handle`, with its history. The writer starts at once, but its text comes back like a background agent's: the host delivers it when the parent's turn ends, not during it. The parent should send the revision and end its turn, not wait or poll. If the job's ceiling has no room for another call, the answer is `needs_approval` with what one more ceiling would cost, and nothing is sent until you approve it.

The worker is a normal Claude Code subagent of the type the call names: the same tools, `CLAUDE.md` files, sandbox, permission mode, result and `SendMessage` follow-ups as a native subagent of that type. It is not available on native Windows.

## What Tenjin keeps

Each job leaves a record next to the job store (`model-jobs/<id>.neon.json`): the task class (`writing`), each call's tokens, `max_tokens`, quoted and settled amounts, and the job's wall time. A second record, `neon-channels.json`, keeps the provider terms each channel was paid under, so a refund reaches the same channel. Both stay on your machine.

See also [DeepSeek subagents](./subagents.md), which describes the sandbox, permissions and `~/.claude` access both workers share.

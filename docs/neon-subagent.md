# Gemini 4 Neon subagents

- **What it is.** A Claude Code subagent that runs on Google's Gemini 4 Neon, for writing jobs: documentation, release notes, essays, edits to prose. You start it by asking for it by name. Tenjin never offers it on its own, and it is off until you turn it on.
- **Who sees what.** BlockRun, which sells the model and takes each payment, and Google, whose model reads the request. They get the task, its instructions and the worker's tool results, including what the worker reads in `~/.claude`. Nothing is masked except the job's own tokens and your wallet key and passphrase. Tenjin's router receives nothing and charges no routing fee. The worker has no web search.
- **Cost.** Each model call is one payment from your wallet to BlockRun, at Google's list price ($3 in, $15 out per million tokens, $0.15 cached) plus BlockRun's 5% and a $0.002 least charge. A job costs up to your per-call limit ($1 by default), or a lower ceiling you name, within your daily budget. A turn can write at most 8,192 tokens (BlockRun prices a call at the whole output you allow, whatever the model writes, so one turn reserves up to about $0.13 plus its input). A call that fails after you paid is not repeated.
- **On.** `tenjin config neon on`, with `--repository <path>` to limit it to directories and `--max-job <USD>` for a lower ceiling.
- **Off.** `tenjin config neon off`. `tenjin config neon` shows the state.

## Start a worker

Ask your agent to use a Neon subagent for the job. The agent calls the `subagent` tool with a `neon` assignment: a `prompt`, an optional `description` and an optional `subagent_type`. There is no offer to accept and no routing: the call starts the worker. Without your Neon consent the call refuses and says so, and nothing is sent or paid.

The worker is the same Claude Code subagent as the DeepSeek worker: the same sandbox, permission mode, result and `SendMessage` follow-ups. It is not available on native Windows. A worker has no effort setting.

## What Tenjin keeps

Each job leaves a record next to the job store (`model-jobs/<id>.neon.json`): the task class (`writing`), each call's tokens, `max_tokens`, quoted and settled amounts, and the job's wall time. It stays on your machine.

See also [DeepSeek subagents](./subagents.md), which describes the sandbox, permissions and `~/.claude` access both workers share.

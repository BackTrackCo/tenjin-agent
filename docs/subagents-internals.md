# DeepSeek subagents: internals

Notes for contributors on how a DeepSeek worker is built. What a person needs to decide whether to turn DeepSeek subagents on is in [the guide](./subagents.md); nothing here changes what is sent, what it costs or how to stop it.

## The subagent prompt read

- Before a worker starts, Tenjin starts the same Claude Code for a moment, with no hooks or MCP servers and no model call leaving the machine, has it launch the subagent type the parent asked for, and reads the prompt from the subagent's first request.
- Tenjin's MCP server keeps that read for up to 10 minutes, keyed on the Claude Code binary, agent type, definition, root and working directories. It reads again as soon as one of those changes, or any settings, plugin list, agent definition, CLAUDE.md or rules file the prompt depends on changes.
- When the prompt cannot be read, the worker starts with Claude Code's main prompt and the subagent note, and Tenjin's MCP server logs why.
- The first worker of a session reads its prompt while its env file scan runs.

## MCP servers and tool search

- A native subagent uses the parent's MCP servers, which are already connected. The worker does not wait for its own to connect before its first turn: a server that connects later announces its tools, and tool search loads them from then on.
- With tool search on, tools load as the worker asks for them, so a request rarely offers more than the 256 tools one request to Tenjin's router may carry.
- Claude preloads the `subagent` tool so acceptance needs no ToolSearch turn. Claude Code runs separate acceptance calls in order.

## Hooks in a worker

- The worker's tool, permission and stop events run your hooks and the plugins' hooks as your session does, with the same matchers, order, timeouts and blocks.
- It runs no `SessionStart` hook when it starts or resumes, and no `UserPromptSubmit` hook for its prompts, as a native subagent runs none, so the context those hooks add stays out of it.
- A `SessionStart` after a compaction still runs, as it does in a native subagent, and so does every hook in managed settings.
- Tenjin's own hook before each tool call counts repeats as the DeepSeek harness's reminder does: the same tool with the same arguments 3, 5 and 8 times in a row, every tool included and a call counted also when it is then refused. At 3 the worker reads the harness's short reminder, at 5 and 8 its detailed one with the tool, the count and the first 500 characters of the arguments. The reminder is advice: no call is blocked or changed.

## Tenjin's server inside a worker

A worker has none of Tenjin's own tools under any name Tenjin's server is registered under (the plugin's `plugin:tenjin:router`, and an older settings install's `x402`). A Tenjin server that starts inside a worker lists only the tool its hooks call, which answers nothing there.

## Sessions Tenjin has not seen

Where no prompt was typed since Tenjin's process started (a resumed session woken by a notification), the first subagent call runs natively, and Tenjin learns the session and its permission mode from that call's own hook.

`/clear` closes the session. Claude Code may keep the Tenjin process across it, so the plugin cancels each background worker whose result it had not handed over, by its offer, and tells the Tenjin process which session closed, so the session that follows in the same Claude Code gets offers.

## Env file scans

- Where the system watches folders for changes (macOS and Windows), a worker prepared while its offer is open starts its Claude Code from the last complete scan this session made of the same directories, and its own full scan runs meanwhile. It gets no assignment until that scan has ended and found nothing its starting denies leave open.
- A kept scan is held in the Tenjin process's memory only, like every scan, until a newer one replaces it or the session ends.
- If a worker warmed before acceptance on Windows or without a recursive watcher, Tenjin scans again before giving it the assignment. A scan that needs new read denies makes Tenjin start a fresh worker.
- A Windows worker starts only from a complete scan: its own, or, for a worker prepared while its offer is open, the session's last complete one, and that worker sends nothing until its own scan has ended and agrees.
- Before each request Tenjin rechecks the files it knows and the folders that hold them. A request that follows a tool result runs one check, which waits its full time for file changes after the request arrives.
- A folder Tenjin cannot list has its env files denied to the file tools as well as its contents to commands, since a command could still open one by name.
- On Linux there is no watcher for files made during a job, which is why a repository's tracked `.claude/settings.json` stays unreadable to a Linux worker.

## Inference channels and their lock

- On a router with shared inference channels there are two of them (two lanes) for the wallet, across every session on the machine, and each carries one model call at a time. A call's payment is signed from the channel's charged total, which the router's answer to the call before it settles, so the next voucher on one channel cannot be signed before the previous call's answer.
- A worker's call uses its own lane when that lane is free and the other lane when another call holds its own, so two workers, in one batch or in two sessions, run inference at the same time. With both lanes held, a call waits for whichever comes free first.
- A call the other lane cannot fund within the person's limits waits for its own lane and is not refused for that.
- On a router that supports refunds, a run's model calls take turns on that run's own channel alone, so no worker waits for another worker's call.
- A router whose answer to the question about refunds is not its refund terms is treated as one without refunds: nothing is signed for that question, so the job runs on the shared channels. Tenjin asks that question while the accept's own checks run.

## Call pacing and fresh quotes

- A router whose offer says its rate (`callLimit`) counts a call at its unpaid quote, so a call waits for room before it asks for the quote. A refusal there costs nothing and is tried again after the router's `Retry-After`.
- That router keeps a counted quote's place for 120 seconds, so a call that waited more than 100 seconds for its channel asks for the quote again, for the same call, before it signs. If that quote cannot be had or names another amount, nothing is signed and the call is tried again as any uncharged failure is.
- A router that says nothing counts a call after its signature, 30 per 60 seconds together with its routing decisions, so there a signed request waits for room before it leaves.
- The count is one file per router origin in the data folder, shared by every `tenjin mcp` process.

## Receipts, retries and reply size

- A call the router says DeepSeek failed, or whose reply the router cut after its idle limit or its deadline, has its receipt read at once, so when nothing was charged it is released.
- A cut reply (`model_stream_idle`, `model_deadline_exceeded`) is released and tried again only on `voucherState: "cancelled"` together with `actualAtomic: "0"`. Its receipt reads `state: "unknown"` for every cut, so that state alone proves nothing; a receipt that reads `running` or `pending`, or one that cannot be read, leaves the call uncertain, reserved and never tried again.
- A call counts as confirmed uncharged, and is tried again, when it never reached the router, the router answered a rate limit or a server error before any payment, or DeepSeek failed it and nothing was charged. An empty reply is such a failure (`incomplete_model_response`). A reply of thinking alone is not: it is a completed, charged call.
- A reply DeepSeek refused to give is never tried again, as the DeepSeek harness tries none, once the router names it (`model_refused`). A router that answers a refusal as `incomplete_model_response` cannot be told from one that got an empty reply, so that refusal is tried again.
- A model reply is read through 2,000,000 bytes. To a router whose offer says it honours a stated size of at least 2,000,000 bytes, each Messages call states the size the worker then reads (`maxResultBytes`), the smaller of the router's size and 4,000,000 bytes, and that router fails a larger reply before it charges for it.
- MCP servers keep connecting while a worker works; a worker has no start-up window of its own inside the job's 40-minute wall limit.

## What the plugin draws

- Tenjin answers a held Agent call as a refusal whose text carries the offer. Claude Code draws two or more Agent calls of one response as its own summary block, also when the first of them drew alone for a moment before the others joined it. A call of that response that did not run and is sent again and held again changes nothing.
- The plugin refuses the parent model's own call of the viewer's activity read.
- The worker it accepts from a native subagent draws its row in that subagent's transcript, and its DeepSeek agent is listed under that subagent.
- In the agent list a second task of the same description reads ` (2)`. A viewer's first message is the worker's assignment, the prompt the parent sent, as a native subagent's is; after a restart it reads `DeepSeek worker for: <description>`.
- The viewer's transcript has one step for each worker reply: the worker's own text, then its calls drawn by Claude Code as its own, such as `Read(src/a.ts)` with `Read 120 lines` under it, `Bash(pnpm lint)` with the first three lines of its output, `WebFetch(<url>)` with Claude Code's own `Received <size> (200 OK)` line, `Exa page read(<url>)` when the local fetch failed and Exa page read read the page, `Exa search("<query>")` with Claude Code's `Did 1 search in <time>` line, or `Update(src/a.ts)`, and a refused or failed call's reason under its row. A tool search draws nothing, as a native one does, and Claude Code folds read-only commands into its own `Searched for …` line. A call of another tool is a text line with the first line of its result. A worker that never started says `Not started`.
- The spinners in that view and in the parent's are Claude Code's own. Claude Code's own background-agent summary reads that transcript, as it reads a native subagent's.
- The end line's word, time and counts are the job's own, read from the CLI's record when the row was not following the worker (after a reload or a resumed session).
- A tool call that Claude Code moved to a background task after two minutes ends with the notification `DeepSeek "<description>" finished · Done (…)`. Claude Code gives a plugin's own agent no completion notice, so a background worker's result message is the plugin's and not a task notification.
- While a worker runs, the mod holds only the rows not yet written into the transcript, up to 2,000. The CLI holds live worker activity in memory, and its local display file is removed when the job ends.

## The diagnostic record

Each run leaves a record beside its job: the worker's tools and MCP servers, its root and commit, the job's output cap and the cap each call asked for, the thinking mode and reasoning its requests carried, its repeat reminders and retries, the time before its offer (the checks, the router's decision call and each of its round trips), the time of each start phase from the accept to its first reply, each model call's waits, round trips and token counts with the time between calls, the steps after its last answer, and how it ended. An offer nobody accepts leaves only the time before it. A job that somebody ended (a cancel, the session's end, Claude Code ending the call) holds its end code alone, with no error. A job that did not complete holds its error also when the job ended before its worker started.

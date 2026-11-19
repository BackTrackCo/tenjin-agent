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

- On macOS and Windows, a worker prepared while its offer is open starts its Claude Code from the last complete scan this session made of the same directories, and its own full scan runs meanwhile. Each worker runs its own: two that start together each wait for theirs. It gets no assignment until that scan has ended and found nothing its starting denies leave open.
- A kept scan is held in the Tenjin process's memory only, like every scan, until a newer one replaces it or the session ends.
- If a worker warmed before acceptance on Windows, or where nothing learns new files during a job, Tenjin scans again before giving it the assignment. A scan that needs new read denies makes Tenjin start a fresh worker.
- A Windows worker starts only from a complete scan: its own, or, for a worker prepared while its offer is open, the session's last complete one, and that worker sends nothing until its own scan has ended and agrees.
- Before each request Tenjin rechecks the files it knows and the folders that hold them. A request that follows a tool result runs one check, whose wait for file events (Windows) or pass over the folders (macOS) starts again from the request when the request comes during it.
- A folder Tenjin cannot list has its env files denied to the file tools as well as its contents to commands, since a command could still open one by name. One found during a job ends it with `env_file_unscanned`.
- The env denies come from the scan's own list of roots, so no root is walked with a skip and left without the matching deny: under each root it walks (working directories, worktrees, the job's temp folder) the env and settings files inside `node_modules` and `.git`, or every env and settings file when the scan stopped short; under every other folder the worker may read (read and write exceptions, `~/.claude/projects`, the job's gh config folder) every env file.
- On Linux nothing learns files made during a job, which is why a repository's tracked `.claude/settings.json` stays unreadable to a Linux worker.
- Every job's temp folder (`/tmp/tenjin-job-*`) and every folder Tenjin makes for a job in the system temp folder (`tenjin-worker-*`: the GitHub folder and the settings file's folder) are denied to the sandbox, by each spelling of those folders, and the job's own temp and GitHub folders are opened again by `allowRead`, which wins over `denyRead` in Claude Code's sandbox while deeper denies inside them still hold. Another job's temp folder holds its commands' output files and what its worker wrote there, as written, and its settings file its bridge token and GitHub token. The file tools refuse those folders already, as folders outside the working directories; a Read deny on the pattern would close the job's own folder too.

### New files during a job

- **macOS: no file event is trusted.** libuv delivers every watcher of a Node event loop through one FSEvents stream and rebuilds it whenever a watcher on that loop starts or closes, losing what it had not delivered, with no error. A stream also drops events after a burst of changes, which libuv skips without a callback. Measured on 2026-11-19: a watcher started and closed on the same loop lost a live watcher's event in 19 to 29 of 40 tries; on a thread of its own, the event of an env file written right after 14,000 new folders in its directory was lost in 8 of 8 tries, and after 3,000 in 3 of 8.
- **macOS: every folder is checked before each request.** The start scan skips `node_modules` and `.git`, whose env and settings files are denied to the worker instead, follows no link to a folder, and records each folder it lists, as its own entry stood just before the listing. Before each request Tenjin stats every recorded folder and lists again each one whose inode, change time or modification time moved, or which changed less than 2 seconds before it was last listed, since a later change can carry the same time on a coarse clock (HFS+ keeps whole seconds). A folder not recorded yet (new, moved in, or a root not walked yet, such as the job's temp folder) is walked in full. A recorded folder that is gone while the pass runs, at its stat, its listing or its walk, has its parent listed again, which walks it if it is back, and the pass runs again, which finds it if it moved into a folder already stat'ed, before the request may leave. A folder still gone after 8 passes holds the request, and the job ends with `env_file_unscanned`. Measured on 2026-11-19, the stat pass took 0.7 s over 117,643 folders, against 3.8 s to list each one; with 142,842 more folders inside `node_modules` and `.git`, which it skips, a worker started in 3.5 s and each request waited 0.74 s, against 10.7 s and 1.72 s when it walked them.
- **macOS: only where a folder's times prove it.** On APFS and HFS+ a new entry, a removal and a rename each move the folder's change time, and no command can set that time back. On exFAT and FAT the change time is the modification time, which `touch -r` sets, and a network share takes its times from the server. So Tenjin reads each folder's volume type from the mount table, by device, once per pass, since a device number can pass to another volume once one is ejected, and trusts the times only on `apfs` and `hfs`. A folder on any other volume, or one whose type cannot be read, is listed before every request. A source or a mount point can hold the word "on" between spaces, or a line break, so a mount table line that reads more than one way trusts none of its mount points, and a line that does not read trusts nothing in that pass.
- **Known files.** Each is read again when its inode, size, modification time or change time moved, or when it changed within 2 seconds of its last read: `cp -p` or `touch -r` can rewrite a file with its old size and modification time, and on HFS+ a rewrite in the same second keeps every time. On exFAT and FAT the change time is the modification time, so a rewrite in place that keeps the size and has its times set back is not seen.
- **Windows: a watcher, trusted while it says what it lost.** Before each request Tenjin waits 120 ms for its reports, then lists every folder they named, whatever its name, since a folder moved in reports itself alone. Inside `node_modules` and `.git` it lists nothing and reads only an env or settings file a report names, as it did before the change. A report with no name (the system's buffer overflowed), or more than 10,000 named paths, makes the next check walk every working directory. A watcher that fails is dropped: the worker no longer counts as watching, and each check from then on lists every folder, since a program can set a folder's times on NTFS.

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
- A reply DeepSeek refused to give is never tried again, as the DeepSeek harness tries none, once the router names it (`model_refused`, 502). The job ends with its own `refused` cause, which tells the parent and the person that DeepSeek refused the request and that nothing was charged for that call. A router that answers a refusal as `incomplete_model_response` cannot be told from one that got an empty reply, so that refusal is tried again.
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

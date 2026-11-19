# DeepSeek subagents

- **What it is.** Tenjin can offer DeepSeek V4.1 Flash, a cheap model, for an eligible Claude Code subagent job. Claude keeps its own model and accepts or declines each offer. DeepSeek subagents are off by default.
- **Who sees what.** Before each offer, Tenjin and TypeSafe get the task and recent conversation. When Claude accepts, Tenjin and DeepSeek get the task, its instructions and the worker's tool results, including what the worker reads in `~/.claude`. Web searches go to Exa.
- **Cost.** A job costs up to your per-call limit ($1 by default), or a lower ceiling you name, within your daily budget. Routing costs 15% of the expected cost of a job, the same rule as tool routing, an offer at a time, also when Claude declines it.
- **On.** `tenjin config subagents on`, or **Turn on** in fresh setup.
- **Off.** `tenjin config subagents off`. No new job starts; cancel a running worker to stop it.

Ordinary implementation and scoped review can qualify; planning stays native. Repository instructions and model or privacy restrictions still apply. Env files are not masked, and secrets in a known token shape are masked, which is not a guarantee. See also the [privacy policy](https://tenjin.sh/privacy).

## What is sent

- **The model.** DeepSeek V4.1 Flash 1017 runs these jobs today. It receives a job only after the parent accepts its offer: the accepted assignment, the instructions that apply to it and the job's tool results, through Tenjin.
- **Tenjin** receives each subagent assignment with bounded parent context before the offer, together with TypeSafe, which judges the routing, and after acceptance everything DeepSeek receives.
- **Web searches.** A worker's search query, and the address of a public page its WebFetch could not fetch, go to Exa. The query and what Exa returns come back to the worker as a tool result, so they reach DeepSeek too.
- **Your `~/.claude` folder.** On Linux and macOS a worker loads your global Claude Code configuration and can read your session transcripts, prompt history and settings files there. What it reads can reach Tenjin and DeepSeek.

[Data and permissions](#data-and-permissions) has the full account, and [Charges and limits](#charges-and-limits) the fees and the per-job cap.

## Setup and controls

### Turn on and off

```sh
tenjin config subagents
tenjin config subagents off
tenjin config subagents on
tenjin config subagents on --max-job 0.50
tenjin config subagents on --repository /path/to/workspace /path/to/another
```

- **Fresh setup** asks whether to use a cheap model for eligible subagent jobs, in three lines that end with a link to this page. **Keep off** is the default. **Turn on** covers each session's qualified native workspace and then prints the scope, the cap and the short terms once.
- **A scripted install** passes `tenjin install --yes --subagents on` to opt in or `--subagents off` to save off. The flag saves an answer wherever none is saved yet, on a fresh profile or an existing one. Running it again changes nothing: once an answer is saved, the `tenjin config subagents` commands change it, and the install receipt says so when the flag asked for something else.
- **Existing users** keep their settings, including off choices. Updating, refreshing or adding another host does not turn DeepSeek subagents on. Only an explicit on does: the question, the `--subagents on` flag or `tenjin config subagents on`.
- **`tenjin config subagents`** with no mode prints whether DeepSeek subagents are on, the scope and the cap in force. `tenjin status` has a `Subagents` row that says on or off and the scope.
- **`tenjin config subagents off`** stops new jobs. Cancel a running worker to stop it (see [Cancel](#cancel)).
- **A project** can turn DeepSeek subagents off for itself. It cannot grant consent or raise your money limits.

The parent still accepts or declines each offer.

### The two consent scopes

There is one consent record, with one of two scopes. The command you run chooses the scope.

- **Every workspace.** `tenjin config subagents on` writes the same consent the setup question writes: it covers each session's qualified native workspace, in any directory. Its scope row reads `Every workspace`. Opening another repository uses that session's own workspace; the folder where installation ran supplies no directory grant.
- **Only the directories you name.** `tenjin config subagents on --repository <path>...` limits the consent to those directories and nothing else. A named directory includes its subfolders, so a nested repository or a linked worktree under it is covered. A session outside them gets no offer: not in the parent of a named directory, not in a sibling whose name starts the same, and not through a link under a named directory that points outside it, since real paths are compared. Its scope row reads `~/work and its subfolders`. Repeat the command for another directory to keep both, or name a containing workspace.

A saved consent never gets wider without your own command:

- A consent that names directories stays limited to them through updates.
- Only an `on` with no `--repository` widens it, and its scope row says so: `Every workspace (was ~/work only)`.
- An `on --repository` over a consent for every workspace narrows it, and its scope row says `(was every workspace)`.
- On native Windows only the limited scope is allowed (see [Linux and Windows](#linux-and-windows)).

Both scopes record the configured router origin and the recipients (Tenjin, DeepSeek and Exa). Each `on` prints the same short terms with a link to this page; `tenjin config subagents on --json` carries the full terms in `disclosure`. Each job freezes its qualified scope and rechecks it before tools, inference and continuation.

Local GitHub origin names for the offer's directories and their direct child repositories accompany each offer so the parent can match GitHub tasks to paths. Names grant no filesystem permission or additional disclosure scope, and are read fresh at each offer.

### The cap for a job

- A job's routing, inference and web searches together cost up to the cap.
- With no `--max-job`, the cap is your per-call spend limit as it stands at each offer ($1 unless you chose another). A changed limit changes the next offer, up or down, and lowers a running job's remaining cap at once.
- `--max-job <USD>` names a lower ceiling. The cap is then the smaller of that ceiling and the limit, and a higher limit never lifts a ceiling you named. Each `on` sets the ceiling from its own flags, so running it without `--max-job` drops a ceiling named earlier.
- Your daily budget applies on top.
- Where the cap is not above $0.083866, what one model call needs before its routing fee, no job is offered; a routing fee the cap leaves no room for is skipped the same way. `tenjin config subagents why` says so, and `tenjin config subagents on` refuses to turn DeepSeek subagents on under such a limit and names the command that raises it.
- A call held at one cap whose cap is lowered before its offer is made stays native.

### Linux and Windows

On Linux, DeepSeek workers use Claude Code’s native shell sandbox. Install the sandbox dependencies for your distribution and check that Claude Code reports a working sandbox. See the [Claude Code sandbox documentation](https://code.claude.com/docs/en/sandboxing) for Linux and WSL2 requirements.

On native Windows a worker has no shell sandbox:

- It uses the native Claude shell tools under a dedicated standard local Windows account. Git Bash and PowerShell have the access Windows grants to that account, including network access and files outside the selected repository.
- Setup requires a separate opt-in that names the workspace with `--repository`. The limited scope is the only one native Windows allows, since the worker's account has access only to what you gave it. A bare `on` with the Windows worker flags is refused and says so.
- Keep the controller’s Tenjin data and sign-in credentials in its private profile. Only share workspaces and Claude configuration that you are comfortable exposing through the worker’s tool results.
- Native tools and shell commands use the shared Claude profile and the account’s own Git and CLI credentials. Windows ACLs govern reads and writes by shell commands. Tenjin rechecks the worker grant and masks recognized secrets before forwarding tool results.

[Windows setup instructions](../scripts/windows-worker/README.md)

## Data and permissions

### What goes where, and when

- **Before an offer.** The assignment and bounded parent context go to Tenjin and TypeSafe. A routing request is at most 16 KB: Tenjin gives up parent context to fit it, the oldest message first, and never cuts the assignment, so a call whose assignment alone is larger stays native.
- **While the offer is open.** Claude Code can prepare a local worker. The worker gets its assignment only when the parent accepts. Declining or cancelling the offer, letting it expire, or ending the parent session stops that process.
- **After acceptance.** Applicable instructions, assignments and tool results reach DeepSeek through Tenjin. A worker's web search queries, and the address of a public page its WebFetch could not fetch, reach Exa (see [Web searches and page reads](#web-searches-and-page-reads)).
- **Env files are not masked.** A worker reads them as a normal subagent of the session does, and what it reads can reach Tenjin and DeepSeek as written.
- **What is still protected.** Secrets in a known token shape are masked in what a worker forwards, not guaranteed. The job's own bridge and GitHub tokens are masked by value. A worker's commands refuse the credential probes (`security`, `git credential`, `git-credential-*`, `gh auth token` and its relatives) in every mode, and the sandbox and the file tools keep the Tenjin data folder, the wallet and other jobs' temp, GitHub and settings folders closed to it. A limited consent keeps its repository boundary: no offer and no worker for work outside the named directories, and reads and writes stay inside the granted working directories. Sensitive prose is not guaranteed anonymous.
- **Limit of the limited scope.** A command a worker runs inherits the environment of its session, as a native subagent's does, so a variable exported in your shell can be printed and sent to Tenjin and DeepSeek even when the directory you named holds nothing secret.
- **Retention.** Server replay content expires after 24 hours. Financial and continuation authorization records persist.

### Permissions

- **Mode.** The worker keeps the permission mode the parent had when the offer was accepted, for the whole job. A later prompt, mode switch or `cd` in the parent does not stop it. A plan-mode parent keeps work native.
- **Default mode.** The worker asks you, with Allow once, Allow for this job or Deny. That dialog waits for your answer for as long as the job may run, as a native permission prompt waits; a session that has closed answers no.
- **Auto mode.** The worker's own classifier judges each call that needs a decision. A call that would still need a person is refused at once with its reason, in words about that one call, so the worker never waits on you and does not give the tool up.
- **Bypass mode.** Under a bypass-permissions parent the worker runs in bypass mode inside the same sandbox and read limits and never asks you.
- **Only your choice allows a call.** Nothing the parent writes to a worker, in its assignment or a follow-up, is a permission or changes the worker's mode, rules or sandbox. Tenjin sets up no hook that could answer the dialog for you.
- **The sandbox.** Every worker command runs in the sandbox. Outside your consented directories it refuses, at the read itself, a read in your home folder, other users' folders and mounted volumes (such as `/Users`, `/home`, `/Volumes` and `/mnt`), apart from your read exceptions and the files [Env files](#env-files) lists under reads outside the working directories, and in other Tenjin jobs' temp and GitHub folders. Elsewhere, such as `/tmp`, the system temp folder under `/var/folders`, `/opt`, `/usr`, `/etc` and `/Library`, a command reads what your user can, as a native subagent's sandboxed command does. A command that names such a path is refused before it runs; one that reaches it through a script, a link or a name it builds is not. On Linux and macOS, shell confinement must be enforceable: managed-only read-path policies, disabled or excluded sandbox commands, and startup paths containing `*`, `?`, `[` or `]` keep work native. On Windows, the offer requires the separate native shell grant and compatible Claude settings.
- **`cd <dir> && ...` in auto mode.** A second check reads a command's text before it runs, and asks about a command whose paths it cannot work out, such as `cd <worktree> && git status --short | head -20 && git diff main...HEAD --stat`. In auto mode that ask is refused like any other, because answering it yes would run the whole command, whatever else it holds, without the classifier's verdict. The refusal tells the worker to run the `cd` as its own call or to use `git -C <path>`, and that form is judged and runs. A command that names a path outside your consented directories stays refused, and so does an ask about one part of a compound command, which can stand for one of your own ask rules. In bypass mode that one ask is answered yes, since bypass mode judges no call and the sandbox still refuses a read in your home folder and the other places named above.
- **Pushes and merges.** Pushes, force pushes, branch deletions, merges and every other action go through that mode's own permission flow, exactly as a native subagent's do.
- **Refused in every mode.** A credential probe the sandbox cannot stop by path: the keychain (`security`), git's credential helpers (`git credential`, `git-credential-*`) and a GitHub token printed by `gh auth token`, `gh auth git-credential` or `gh auth … --show-token`.
- **Working directories.** Under the every-workspace scope, consent follows the host's qualified current directories and access exceptions. Under the limited scope, every named directory is a working directory, so a session in one repository of a named workspace reaches its sibling repositories; their linked git worktrees inside the named directories are added at job start through the worker's settings (not as `--add-dir` flags, which would load each worktree's skills, agents and commands, as a native subagent does not), so the worker can commit in them. A native additional directory outside the named directories is denied to the worker and listed in the offer, and the offer still stands; native read or write exceptions outside them keep work native.
- **What stays in place.** The worker retains native settings, rules, hooks, MCPs, CLIs and tool permissions in its workspace, including uncommitted changes. Global auto-memory is disabled for this worker. Your parent's endpoint, saved login and Remote Control stay in place. Scope is checked before assignment, tool use and inference. Unsupported authority or host-controlled authentication keeps work native. A provider refusal at worker startup can follow an already-paid routing fee.

### The worker as a native subagent

- **Agent type.** The worker runs as the native agent the parent asked for: `general-purpose`, `Explore` or a custom agent whose definition qualifies (see [Custom agents](#custom-agents)), with the prompt and tools Claude Code gives a native subagent of that type. To read that prompt, Tenjin starts the same Claude Code for a moment, with no hooks or MCP servers and no model call leaving your machine. The prompt carries the note Claude Code gives its own subagents: messages from the agent that launched it direct its work and are never your consent or approval.
- **Context.** As a native subagent of its type does, the worker gets the repository's git status unless it runs as `Explore`, and tool search as your session has it: MCP tools and the less used built-in tools load when the worker asks for them.
- **Hooks.** Your hooks and the plugins' hooks run in the worker as they run in a native subagent.
- **`Explore`.** An `Explore` worker starts without your CLAUDE.md and rules files, global, project and local, as a native `Explore` subagent does. One in a folder below the working directory still reaches it when it reads a file there.
- **No questions, no subagents.** As a native subagent, it has no tool for asking you questions in any mode. A worker that needs something from you ends with its report, and the parent continues it. A worker starts no subagent, native or DeepSeek, and none of its calls is held or offered.
- **No Tenjin tools.** Unlike a native subagent, it has none of Tenjin's own tools (`request`, `approve`, `subagent`). What a worker pays for is its model calls and its web searches, which count in its job's budget, and a Tenjin lookup of its own would not.
- **Thinking.** The worker thinks on every turn, at high effort, as the DeepSeek harness does. Neither your own Claude Code settings nor a managed policy turns that off for a worker: `MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_THINKING` and `alwaysThinkingEnabled: false` are set aside for it, also when a managed policy sets them, and a turn that still arrives without thinking is sent with thinking on. The auto-mode classifier's own short requests carry no thinking, as Claude Code sends them.
- **Images and PDFs.** Unlike a native subagent, the worker cannot see an image or a PDF: Tenjin's router takes text only. An image or document block, in the assignment or in what a tool returns, goes to the model as one line of text that says it was omitted, and the worker works on. The result to the parent counts them (`omitted.blocks`, each block once) and says to run the job natively if it needed that content, and the worker's row says how many; with none omitted, neither appears.
- **Live replies.** When the router offers a streamed reply, the worker's text, thinking and tool calls appear as the model produces them, as a native subagent's do; otherwise each reply appears once it is complete.
- **Stopping early.** A worker that stops early returns its last text and recent activity to the parent.

### Your `~/.claude` folder

On Linux and macOS:

- **Loaded as instructions.** The worker loads your global Claude Code configuration as a native session does, so your personal `~/.claude/CLAUDE.md` is in its instructions, unless it runs as `Explore`. Claude Code itself loads the skills, plugins, agents, commands and rules under `~/.claude` into the worker, as it does for a native subagent, so their text is part of what the worker works with.
- **Readable by the worker's file tools and commands, never writable.** Every session transcript and project memory under `~/.claude/projects`, your prompt history `~/.claude/history.jsonl`, and your `~/.claude/settings.json` and `settings.local.json`.
- **Other files there.** A skill's or a plugin's own files included, they are outside the worker's working directories, and its file tools and commands read them only as far as Claude Code's own rules for its folders allow.
- **Where it goes.** What the worker loads or reads there, other projects' sessions and memory included, can reach Tenjin and DeepSeek.
- **Transcripts and history are not scanned.** A secret pasted or printed in an earlier session is sent as written unless it has a known token shape.
- **Closed.** The credentials file, settings backups, session state such as `debug` and `file-history`, `tenjin-loops` outside your consented directories, a skill's files where its folder links outside `~/.claude`, and `~/.claude.json`.

In the working directories:

- A repository's tracked `.claude/settings.json`, its own or a nested one, is readable as a native subagent reads it.
- The worker's file tools never write one, and its commands cannot write the working directory's own. A merge or checkout that must rewrite that file fails at that write, as a native sandboxed command does before it asks to run unsandboxed, which a worker cannot.
- Every repository's `.claude/settings.local.json` and `.mcp.json` stay closed, and so does a project settings file outside the working directories.

Temp files:

- Each job has its own temp folder under `/tmp`, which only your user can open and which is removed when the job ends. It is `$TMPDIR` in the worker's commands, its file tools can read and write it by path, and the worker is told to use it instead of `/tmp`.
- Other workers' commands cannot read it, nor the job's GitHub folder or settings file in the system temp folder, which hold its gh caches and its tokens. On Linux a folder made after a command started stays open to that command until it ends. A native session or subagent of your user can read them.
- Worker commands cannot read or write the temp files of other Claude Code sessions under `/tmp/claude-<uid>`.

### Env files

- **Reads.** The worker and its commands read `.env` and other `.env*` files inside its working directories (the consented directories and their linked worktrees) as a native subagent does, so tests and scripts that load `.env.local` work.
- **Reads outside the working directories.** On Linux and macOS the worker's file tools read nothing outside them but your read exceptions and the files in [Your `~/.claude` folder](#your-claude-folder). Its commands also read what the sandbox leaves open (see [Permissions](#permissions)): `/tmp`, the system temp folder, `/opt`, `/usr`, `/etc`, `/Library` and a link into them, your git config files, and the `~/.claude` folders Claude Code opens to commands, as a native subagent's commands do.
- **Writes.** Editing or writing one follows the native rules of the accepted mode: default mode asks, Accept edits allows, auto mode's classifier judges, and `.envrc` always asks.

### GitHub access

On Linux and macOS:

- **A per-job token.** GitHub access never comes from your GitHub config files or keychain. Tenjin's own process reads a token with `gh auth token` and gives it to that worker's `gh` and git over HTTPS only, with a per-job gh config and a git config holding just your name, email and a GitHub credential helper. No token is put on the worker's command line.
- **A narrower token.** Set `TENJIN_WORKER_GITHUB_TOKEN`, or `TENJIN_WORKER_GITHUB_TOKEN_FILE` naming a file that holds it, where Claude Code starts. A named token that cannot be read gives workers no GitHub token rather than your login. With either variable set, the session's own `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are cleared in the worker's environment, so only the named token is there. The job's GitHub settings also outrank a GitHub token in your Claude Code settings `env`.
- **Fine-grained token permissions.** Metadata read, Contents read and write, Pull requests read and write, Issues read and write, Commit statuses read and Actions read, plus Workflows read and write only if a worker may change `.github/workflows/`.
- **Masking.** Tenjin replaces the token's value in everything it forwards to Tenjin and DeepSeek, in the worker's result and in its activity rows. A command can still print or send it to an allowed host, so prefer the narrower token.

### Network

- The sandbox preapproves GitHub, GitHub’s content and Actions log hosts, the npm registry and nodejs.org, subject to Claude Code’s settings.
- For other hosts, default mode prompts, auto mode can allow the host for the command, and bypass mode can allow it without a prompt.
- A strict sandbox allowlist blocks hosts outside it. [Claude Code network settings](https://code.claude.com/docs/en/settings-reference#sandboxnetworkstrictallowlist)
- On macOS the worker's sandbox may also reach the system certificate trust service, which `gh` needs to check TLS certificates.

## Accept, cancel and continue

### An offer for each call

- The parent calls its native subagent tool normally. Each call is judged by itself: several calls in one response, and calls made while other offers are open or other workers run, each get their own offer, in any turn, whether a prompt or a task notification started it.
- No count limit applies beyond each job's ceiling and your daily budget. Every offer carries the full parent policy and starts no worker.
- A native subagent's own Agent (or legacy Task) call, at any depth of native agents, is judged and offered as the main conversation's is, with the session's context followed by that subagent's own conversation. That subagent accepts the offer or keeps it native. Its call stays native when the subagent's tools leave out `subagent`, when it or an agent above it may run in a permission mode of its own, or when it works in a folder of its own such as a worktree, since a worker runs in the session's mode and workspace.
- A DeepSeek worker's own calls get no offer.
- One exception: where no prompt was typed since Tenjin's process started (a resumed session woken by a notification), the first subagent call runs natively.
- Saved consent covers its stated disclosure and inference scope; binding restrictions, repository risk judgment and normal tool asks still apply.

### Accept

- Accept one offer with `subagent({offer_id})`. To start several workers together, accept the chosen offers with one `subagent({offer_ids: [id1, id2]})` call. Each offer keeps its own permissions, budget and cancellation, and the call returns one result per offer in the order requested.
- An offer is accepted by its id in any turn of the session that received it, until it expires 15 minutes after it was made. Another session gets nothing for that id.
- On a router with shared inference channels, two model calls of your wallet run at the same time, across every session on the machine, and a third waits for a free channel. On a router that supports refunds, each run pays on its own channel and waits for no other worker.
- Accepting the same offer again never starts a second worker and adds no charge. While its worker runs, the repeat is refused. After the worker ended, a repeat in any later turn of the same session returns the stored result: the completed result, or for a stopped worker how it ended, its last text and recent steps, the next step, and the spend as it then stands. That read is local and free.

### Keep an offer native

- The parent sends the same Agent (or legacy Task) call again unchanged. In every permission mode it then runs natively, as sent, with no second routing fee; Tenjin never rewrites it.
- Key order, whitespace around a field's text, and a field at its default (`false`, `null`, or `subagent_type: "general-purpose"`) are not changes. Any other change makes a new call, which may be offered again.
- The repeat counts once per offer, in the same session and workspace and from the same agent, until the offer expires 15 minutes after it was made; when its worker was accepted and then stopped or never started, for 15 minutes after that. After it, the offer can no longer be accepted.
- When several open offers hold identical calls, one repeat keeps one of them native, the oldest first, and the others stay open. A second identical call in the same model response is not a repeat: it was written before the first offer was read, so it gets its own offer.

### Cancel

- Cancel an offer or active worker with `subagent({cancel: offer_id})`, at any time, or interrupt the host.
- Turning DeepSeek subagents off prevents new paid requests; cancel to drain active work.
- Stopping the DeepSeek agent from Claude Code's agent list cancels its worker, as stopping a native subagent does. Leaving or closing its view, or Claude Code ending its turn, does not.

### When a worker stops by itself

- A worker stops when its session ends or its Tenjin process restarts, as a native subagent does. No worker runs on after the session closes.
- `/clear` closes the session too: the Tenjin plugin cancels each background worker whose result it had not handed over, and the job's record says the session ended it (`session_ended`). The session that follows in the same Claude Code gets offers.
- When you resume the same session, a finished worker's result can still be read, and the worker continued by its handle. A worker that was still running when the session ended is reported as stopped, with the reason `interrupted`, and cannot be continued; send the work again if you still need it.
- Before reloading or removing Tenjin, wait for the parent's Tenjin call to finish or confirm cancellation, and for its native activity agent to stop. A stop acknowledgement alone does not confirm both have drained. Removing or reloading the mod while the viewer is active can let Claude call its own model outside the DeepSeek worker budget.

### Background jobs

- A background Agent call (`run_in_background`) is offered as a foreground call is.
- When the parent accepts it, the worker runs in the background, as a native background agent does: the accept call returns at once with `status: "started"`, the parent's turn goes on, and the worker's row reads `Backgrounded agent (↓ to manage)` until it ends, then its end line.
- **How the result arrives.** When the worker ends, the Tenjin plugin hands its result to the parent as one message, which starts a turn when the session is idle and waits for the running turn otherwise. Its first line says how the worker ended (`finished`, or `did not complete:` and the cause, such as `The parent cancelled it with subagent({cancel}).`), and that it is not a new task. Its row reads `› Message from @DeepSeek (ctrl+o to expand)`. That message is the job's stored result, the same one a foreground accept returns, with its status, counts, spend and worker handle.
- The job's budget, consent checks, causes of ending and cancel are those of a foreground job. The parent session's end stops the worker. Sending the original call again unchanged keeps it native, in the background as written.
- A batch accept can mix foreground and background offers: it returns when its foreground workers end, and names each background worker as started. A background worker that ended meanwhile has its message sent once the batch call has returned.
- If the session was resumed or the plugin reloaded before the message came, accepting the offer again returns the stored result.
- Calls that set `resume`, `name`, `team_name` or `isolation` stay native.
- Claude Code moves a foreground worker that runs longer than two minutes to a background task: the worker runs on, its row stays live, and the parent receives its result with the task's notification, `› Message from @DeepSeek (ctrl+o to expand)`.

### Custom agents

A call for a custom agent type can be offered when all of these hold:

- You or the project wrote its definition: a file in the job root's own `.claude/agents` or in your `~/.claude/agents`.
- It pins no model (`model: inherit` pins none).
- It sets only `name`, `description`, `tools`, `disallowedTools`, `color` and `effort`.

The worker then runs as that agent: the definition's prompt, as Claude Code gives it to a native subagent, in place of the general one, and its tools. Its effort stays high whatever the definition says.

These run natively:

- A definition that pins a model, or sets a permission mode, isolation, background running, memory, hooks, MCP servers or skills.
- Every agent a plugin provides (such as `codex:codex-rescue`), whatever its definition says, every built-in type other than `general-purpose` and `Explore`, and a definition in a folder above the job's root: their prompts are not yours or the project's to send to DeepSeek.
- A definition whose frontmatter Tenjin cannot read exactly as Claude Code does (a quoted key such as `'tools': [Read]`, a bracketed list over several lines, a repeated key, an empty tool list), so a tool limit is never lost on the way to a worker.
- A call that names its agent (`name`), resumes another agent or asks for isolation: a named call starts a teammate and returns at once, which the accept call cannot do.

### Why a call got no offer

`tenjin config subagents why` lists why recent subagent calls got no offer, newest first: the local time, the tool (with `from a subagent` when a native subagent made the call) and the reason in plain words, such as `The session was in plan mode`. `--json` adds the session id and the reason code, such as `input_filter:name`, `permission_mode:plan`, `caller_unqualified:tools`, `over_size_limit` with the byte count, `job_cap_too_low`, `job_cap_lowered`, `server_declined` with the router's code, or `kept_native`. The record holds no assignment text, is kept for 7 days in a file only your user can read, and is sent nowhere. It is written only while DeepSeek subagents are on.

### Write to a running worker

- An offer names the worker's address, `tenjin-worker-…`, before it is accepted, and an accepted background job says it again. While the worker runs, `SendMessage` to that address reaches it at its next turn, as a message to a native subagent does, and it answers as a native send does. Several messages arrive in order.
- It is the same job: no new offer, no routing fee and no new question, and the job's ceiling and your limits hold at each payment as before. Only the session that accepted the worker can write to it.
- A message sent after the worker has reported is not delivered and the parent is told so; it sends it again once the result has arrived.

### Continue a finished worker

- Completed Claude workers return a `tenjin-worker-…` handle. The same parent can continue with native `SendMessage`, or compatible `Agent.resume`. A worker handle is never sent to native tools.
- In the session that accepted the worker, a follow-up is one call: the worker continues at once in the background, as a native subagent resumed by a message does, and its result arrives by itself. The same consent, directory scope and permission mode checks run as for an accept.
- Where Tenjin did not accept the worker itself (a resumed session, a reloaded plugin), each full follow-up is held until the parent runs it with one `subagent({offer_id})` call or stops it with `subagent({cancel: offer_id})`. The parent does not judge again whether the worker suits it, as a native follow-up resumes its subagent with no confirmation. A job whose ceiling is used up refuses the follow-up.
- Because the text goes to DeepSeek, what binds an assignment still binds a follow-up: your own instructions that restrict the worker's model, privacy, disclosure or paid inference, and planning, which stays native. The parent cancels a follow-up that would break one.
- A follow-up pays no routing fee, and its inference is charged to what is left of the original job's ceiling.
- It reopens the same history, for up to 7 days after the worker's last run, including after the same session is resumed. Current instructions and permissions refresh. Continuations retain the full worker history.
- Missing history or accounting, uncertain state, changed directory scope or revoked disclosure refuses continuation. Native retention may remove history; no idle worker service is maintained.

## What you see in Claude Code

### A held call and its offer

- An individual offer appears on its held Agent row, with the native name struck through and `Tenjin offered DeepSeek` with its cap after it, as a held web search shows the tool Tenjin offered.
- When the parent accepts the offer, the worker's `DeepSeek(<description>)` row replaces that row in place, and the accept call adds no row of its own.
- The compact row disappears once the offer is kept native by repeating the call or expired. A cancelled offer nobody accepted keeps its row, which then ends `· cancelled`. A `subagent({cancel})` call draws no row and no result of its own: a cancelled worker's row says `Cancelled by the parent (…)`.
- Tenjin answers a held Agent call as a refusal whose text carries the offer, so Claude Code shows the native call as not run and never as finished. The parent reads there that nothing failed and that its two moves are to accept the offer or to send the same call again unchanged.
- Ctrl+O shows the held call with its offer, and the worker's row and result at the accept call.

### Two or more Agent calls in one response

- Claude Code draws them as its own summary block, which a plugin cannot redraw or remove, so those calls have no row to replace. For held calls that block counts none of them as finished.
- Tenjin writes no line of its own into the transcript for that group. While its held calls wait for the parent's answer, one line above the prompt reads `Tenjin offered DeepSeek for 2 Agent calls`. It goes away at the parent's first answer to any of them (an accept, the call sent again, or a cancel) and when the turn ends, and a resumed session shows none.
- After that the block's `Not run` stands for a held call, an accepted one has its DeepSeek row after the summary, and one kept native by sending the call again has its own native row. Two or more accepted workers draw one DeepSeek agent group with an entry and live status for each worker.

### A running worker

- Each worker shows its progress from the moment of accept: `starting` and the time waited until its Claude Code has started, then its tool uses, tokens, time and the spend settled so far, with its latest step under it. Above the prompt, one status line gives the model, the worker's state, its tool uses and tokens, and the spend settled so far, then the final accounted spend once it ends.
- The parent does not check on a running worker: its result arrives by itself.
- On supported Claude Code versions, use the native Down-arrow agent selector and Enter to open the running DeepSeek agent. Its row in the agent list reads `DeepSeek` and the task's description. Its transcript is written as the worker goes, as a native subagent's is: the worker's own text, then its calls drawn by Claude Code as its own, and at the end the worker's answer and a `Done (…)` line with its counts.
- A shell call's command is shown on your machine only and is not added to what is forwarded to Tenjin or DeepSeek, nor to a stopped worker's handback.

### How a worker's row ends

- `Done (…)`, like a native subagent's, when it completed.
- When it did not complete, the line says who or what ended it: `Stopped by you (…)`, `Cancelled by the parent (…)`, `Interrupted (…)` when Claude Code ended the call that ran it, `Session ended (…)`, `Budget reached (…)`, `Model call failed (…)`, `Model call timed out (…)` or `Payment refused (…)` when a model call through Tenjin returned no result, `DeepSeek unavailable (…)` when DeepSeek could not take the request, `DeepSeek refused (…)` when DeepSeek refused to answer it, `Stopped (…)` for anything else, and `Not started (…)` when it never started.
- If no read can say how the job ended, the line reads `Outcome not shown here (…)` with the counts seen so far and no time: the result still returns to the parent.
- The worker's result to the parent carries the same cause as a fixed code (`endedBy`) with a sentence in plain words, and `status: "stopped"`, or `"unknown"` only when nothing said why. A failed model call also carries the router's HTTP status, the router's own error code (such as `invalid_model_request`) or the payer's code (such as `payment_failed`) when one is known, and the worker's last text.
- `subagent` reports completion, elapsed time, tool uses, tokens, accounted spend and unresolved reservations.

### What is kept on your machine

- **The worker's transcript** is a local record in Claude Code's own session files, as a native subagent's transcript is, with the job's GitHub token already replaced. Of a call's output it holds only short lines, never a file's content.
- **Each handback**, so a later accept in the same session can return it: a completed worker's result, and a stopped worker's last text and up to 24 recent steps, with the same replacements already made, in files only your user can read. Tenjin's data folder keeps no live worker activity after a job.
- **A diagnostic record** beside each job: the worker's tools and MCP servers, its root and commit, its request settings, retries, times and token counts, and how it ended. These are names, times, counts and codes only. For a job that did not complete it also holds the error: the job's end code, and the class name, code and first 300 characters of the message of the error and its causes, with secret-shaped values masked. It is readable by your user alone and is sent nowhere.
- Tenjin removes its own local job, conversation, budget, handback and diagnostic records 7 days after their last write.

## Charges and limits

### The routing fee

- A valid offered job incurs one routing fee: 15% of the expected cost of a job, the same rule as tool routing and with no cap of its own beyond the tool router's ceiling, even if declined. The offer shows its own fee, which Tenjin pays only up to what the router stated for that call, within your spend limits and the job cap.
- Several calls in a turn mean several offers and several routing fees, one each. Your daily budget and spend limits apply to every fee, and each job keeps its own ceiling.
- A fee your limits refuse buys no offer, and that call runs natively. A call the router judges should stay native pays no fee.
- Sending an offered call again unchanged to keep it native adds no second fee. A follow-up to a finished worker is not a new offer and pays no routing fee.

### Inference

- Inference uses reported tokens plus the 5% proxy fee.
- Quotes reserve the requested output allowance and a conservative input bound; final usage can be lower. Provider overruns remain Tenjin's exposure and cannot increase the accepted quote.
- **Output cap.** A worker's turn asks for the output cap its router's offer names, up to 256,000 tokens, the DeepSeek harness's cap. On a router whose offer names none it asks for up to 65,536. Thinking counts as output, so it adds output tokens to a job's cost.
- **What a call reserves.** A quote reserves the output a call asks for. At the current peak tariff plus 5%, a 256,000-token call reserves about $0.324 plus $0.32 per decimal MB of request body through about 1.04 MB, then caps near $0.653 at the model's input-context limit; a 65,536-token call reserves about $0.084 plus the same, capped near $0.413. For a 130 KiB request that is $0.365784 against $0.125799. These are reservation estimates, not actual charges or a guaranteed run.
- **Near the ceiling.** When what is left of a job's ceiling cannot reserve the offered cap, the call asks for the largest cap that still fits, never under 65,536, so a higher cap does not end a job sooner. Under that, the rule below applies.
- **The floor.** A 65,536-token call reserves at least $0.083866 before system, tools and history input. Configuration refuses a job ceiling not above that, since the routing fee comes on top and is paid only from the room the cap leaves; this necessary floor does not guarantee a larger prompt fits.
- A continuing job must retain enough unspent ceiling, after actual spend and unresolved reservations, for each next call's full quote. Inference is refused if its quote exceeds the remaining ceiling; a routing fee may already be paid.
- A job's cap is your per-call spend limit or a lower ceiling you named, so no inference deposit passes the per-call limit. The daily budget and creator allowlist still apply, and a per-call limit of zero stops jobs as it stops every automatic payment.
- Other connected services retain their own permissions and billing. A worker cannot call Tenjin's paid-tool router or purchase tool itself; its web searches are the only tool calls Tenjin pays for on its behalf.

### Web searches and page reads

- **Search.** A worker's web search is a paid Tenjin tool call that DeepSeek does not run. Tenjin answers the worker's native WebSearch itself with Exa search at its lite tier: $0.004 a search, with no routing fee, paid from your Tenjin wallet within your per-call limit and daily budget, as any lookup is, and listed in `tenjin payments`. The query goes to Exa, and the query and the results come back to the worker as a tool result, which reaches DeepSeek as every tool result does.
- **Counted in the job.** The job reserves the catalog's $0.007 price ceiling for the search before anything is signed and then counts what was paid, so searches are part of the job's ceiling, its spend and its end line. A payment that may have left without a settled amount keeps its full reservation, as an uncertain model call does.
- **A refused search.** A search the job's remaining ceiling or your limits cannot cover is refused with nothing paid, and so is one Tenjin's router does not offer. The worker's WebSearch then returns a plain error, `Web search is not available to this worker right now`, with the reason, and the job continues.
- **Page reads.** WebFetch stays native: Claude Code fetches the page on your machine. Only when that fetch fails on the network, with an HTTP error status, or on an empty page does Tenjin read the page through Exa page read, $0.001 with no routing fee, paid and counted the same way, and hand the page's text to the worker beside the failed result, up to 60,000 characters. A page on this machine or a private network, and an address that holds a replaced secret value, is never sent to Exa.
- **Your rules.** Your `tenjin config block` and `only` rules apply to these searches and page reads as they apply to what Tenjin picks on its own. One that leaves Exa out, such as a block of Exa, of Tenjin's own tools or of the task or category the search serves, or an `only` rule that names none of them, refuses the search with that plain error and reads no page, with nothing paid. A preference never forbids a service, so it changes nothing here. When such a rule cannot be checked because Tenjin's router cannot be reached and no earlier copy of its names is kept, the search is refused the same way.
- **Any other request** the worker's Claude Code makes that Tenjin cannot send fails alone, as an API error for that one request, with nothing sent or paid. That includes a request offering more than 256 tools, the most one request to Tenjin's router may carry; the error names the count.

### Deposits and refunds

- Tenjin refills inference credit as needed, normally depositing up to $0.25 at a time. If one quote requires more than $0.25 in additional credit, Tenjin deposits only the amount that quote needs within the job and daily limits. Smaller deposits leave more USDC available for other workers.
- Each fresh deposit counts against the existing automatic spend limits as it is sent.
- On a router that supports refunds, each Claude worker run opens its own inference channel when it first needs to pay. When the worker finishes, stops or fails, Tenjin closes that channel and returns its unused USDC to the funding wallet. If the refund is still pending, Tenjin retries it during the session and when a Claude session starts.
- `tenjin balance` shows pending and confirmed refunds recorded on this installation. A refund still pending at a router you configured earlier is listed with that router's address, and is retried only while that router is the configured one.
- When the router's receipt and the chain confirm a refund, its amount comes off the daily budget's count again, so the budget counts what the run cost and not its deposit. A pending refund stays counted. A refund gives back no more than that run's own deposits still count, and nothing once the budget's 24-hour window has rolled. A job's own ceiling counts its calls, not its deposits, so a refund changes nothing there.
- Other routers use shared inference channels, and `tenjin balance` lists their remaining credit.

### Uncertain calls, retries and the call rate

- **Uncertain calls.** Uncertain signed requests keep their full reservation until reconciled; recovery does not buy a replacement. Reconciling is a free read of Tenjin's own record of each such call, made while the job has no run going: before a follow-up is offered, and when a stopped worker's handback is read again. A call Tenjin finished is counted at its actual cost. A call that failed or was cancelled with nothing charged is released, so it no longer lowers what the job can still spend. Any other answer, or none, keeps the full reservation. Timeout or interruption is not proof of settlement.
- **Retries.** A call the router confirms cost nothing is tried again, as the DeepSeek harness does: up to 5 more times after the first try, waiting 0.5 s doubling to 10 s with some jitter, or as long as the router's `Retry-After` asks. An uncertain or charged call is never tried again, nor a request refused as malformed. A reply the router cut, because DeepSeek sent nothing for the router's idle limit or the call passed its deadline, is tried again only when Tenjin's record of that call proves that nothing was charged: its voucher cancelled and a charge of zero. With any other record, or none, it stays uncertain and the job ends. When the tries run out the job ends with that call's cause.
- **The call rate.** Tenjin keeps your wallet inside the router's call rate, counted across every session on the machine, so a call of many busy workers waits for room before it is sent. A signed request the router still refuses for rate stays uncertain and is never tried again.

### Time limits

- Jobs have no time limit and no turn limit, as a native subagent and the DeepSeek harness have none: a job ends when it completes, reaches its dollar cap or your daily budget, you or the parent cancel it, its session ends or you run `/clear`, or its worker fails; native compaction remains enabled, given the window where the DeepSeek harness triggers it at its defaults: `min(0.8 * 1,048,576, 1,048,576 - reply cap - 65,536)`, which is 838,860 at the 65,536 reply cap of production and 727,040 at 256,000. Claude Code treats that value as a window and takes 33,000 tokens off it (a reserve of up to 20,000 for the summary plus 13,000 of headroom), so compaction fires about 33,000 tokens earlier: near 805,860 and 694,040.
- One model call waits for the router's answer a minute longer than the router lets a call run, so Tenjin never gives up on a call the router is still serving: the call duration the router's offer names plus a minute, or 10 minutes where the offer names none (production's: its calls run 5 minutes at most).
- A worker has no separate start-up window, as a native subagent has none: its Claude Code takes the time the machine needs to start, with no limit. Cancel or interrupt a start that takes too long.
- A job whose first question to the router got no answer in three tries reports `not_started` (`endedBy: "router_unreachable"`). No inference was bought, the routing fee for the offer was already paid, and sending the original call again unchanged runs it natively with no second fee.

## Hosts

Claude Code is primary and requires a qualified installed version with observed Manual, Accept edits, Auto, `dontAsk` or bypass-permissions mode. In auto mode the worker's native classifier runs on Flash. Plan mode, a bypass mode that settings disable, and unavailable modes stay native.

Codex uses the router's existing experimental support. Only independent foreground calls with explicit `fork_turns: "none"`, fully covered native access and the existing Never/user approval policy qualify. Other modes and history-inheriting calls stay native. Codex worker resume and background-agent UI are outside this pilot.

Contributors: how the worker is built is in [DeepSeek subagents: internals](./subagents-internals.md).

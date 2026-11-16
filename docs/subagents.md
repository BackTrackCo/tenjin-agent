# DeepSeek subagents

Tenjin can offer DeepSeek V4.1 Flash 1017 for helper work. Your parent keeps its model and final accept/veto. Ordinary implementation and scoped review can qualify; planning stays native. Repository instructions and model/privacy restrictions still apply.

## Setup and controls

Fresh installations enable eligible DeepSeek routing for each session's qualified native workspace, with a $1 total routing/inference ceiling per job. The existing setup question and receipt explain sharing. Opening another repository uses that session's current native scope; the folder where installation ran supplies no directory grant. Each job freezes its qualified scope and rechecks it before tools, inference and continuation.

Existing users keep their settings, including off choices and named-directory consent. Updating, refreshing or adding another host does not enable DeepSeek for an existing profile. The parent still accepts or vetoes each offer.

```sh
tenjin config subagents off
tenjin config subagents on --repository /path/to/repository --max-job 1
```

The explicit `on --repository` command records consent for the named directory and descendants, the configured router origin, recipients and job ceiling. Repeat for another repository to retain both, or name a containing workspace. This selects named-directory scope instead of following future workspaces automatically. Local GitHub origin names for qualifying directories and their direct child repositories accompany offers so the parent can match GitHub tasks to paths. Names grant no filesystem permission or additional disclosure scope; stale names are dropped when their local origins change or disappear. A project can disable routing, but cannot grant consent or raise your money limits. Unsupported older consent must be renewed explicitly.

## Data and permissions

Routing sends the assignment and bounded parent context to Tenjin and TypeSafe before acceptance. After acceptance, applicable instructions, assignments and tool results reach DeepSeek through Tenjin. Known secrets are masked; sensitive prose is not guaranteed anonymous. Server replay content expires after 24 hours; financial and continuation authorization records persist.

The Claude worker retains native settings, rules, hooks, MCPs, CLIs and tool permissions in the current workspace, including uncommitted changes. Global auto-memory is disabled for this worker. Native-workspace consent follows the host's qualified current directories and access exceptions; named-directory consent additionally requires those paths to fit the saved roots. Neither mode grants filesystem or tool access. Workspace-only shell reads must be enforceable: Windows, managed-only read-path policies, disabled or excluded sandbox commands, and startup paths containing `*`, `?`, `[` or `]` keep work native. Scope is checked before assignment, tool use and inference. Your parent's endpoint, saved login and Remote Control stay in place. Unsupported authority or host-controlled authentication keeps work native. A provider refusal at worker startup can follow an already-paid routing fee.

Worker file tools and commands cannot read credential-bearing native config, history or private controller data. Ordinary skill, agent, command and support files remain usable under the current native permissions.

The worker keeps the permission mode the parent had when the offer was accepted, for the whole job; a later prompt, mode switch or `cd` in the parent does not stop it. In auto mode the worker's own classifier judges each call that needs a decision, and a call that would still need a person is denied with its reason, so the worker never waits on you. Under a bypass-permissions parent the worker runs in bypass mode inside the same sandbox and read limits and never asks you; a plan-mode parent keeps work native. In default mode it asks you, with Allow once, Allow for this job or Deny. In every mode it never runs keychain or git credential probes, `gh auth token`, a push to `main` or `master`, a force push, a branch deletion or a merge. A worker that stops early returns its last text and recent activity to the parent.

## Accept, cancel and continue

The parent calls its native subagent tool normally. Every offer carries the full parent policy and starts no worker. Accept with `subagent({offer_id})`; Claude preloads this tool so acceptance needs no ToolSearch turn. To decline an initial Claude Agent offer, the parent can call Agent with only `description: "Keep native"`, `prompt: "tenjin-native:<offer_id>"` and matching `subagent_type: "tenjin-native-<offer_id>"`. Tenjin restores the exact saved native call before tool-call hooks and permission checks. Retrying the complete original call also works, including for legacy Task calls. Saved consent covers its stated disclosure/inference scope; binding restrictions, repository risk judgment and normal tool asks still apply.

Cancel an offer or active worker with `subagent({cancel: offer_id})`, or interrupt the host. Turning routing off prevents new paid requests; cancel to drain active work. Repeated acceptance does not start a second worker.

On supported Claude Code versions, use the native Down-arrow agent selector and Enter to open the running DeepSeek agent. Its Tenjin activity panel shows recent worker tool calls/results and final accounted spend. Stopping that agent cancels its owned worker. Worker operations appear as activity rows; the work result returns separately to the parent, and continuations retain the full worker history.

Before reloading or removing Tenjin, wait for the parent's Tenjin call to finish or confirm cancellation, and for its native activity agent to stop. A stop acknowledgement alone does not confirm both have drained. Removing or reloading the mod while the viewer is active can let Claude call its own model outside the DeepSeek worker budget.

Completed Claude workers return a `tenjin-worker-…` handle. The same parent can continue with native `SendMessage`, or compatible `Agent.resume`. Each full follow-up is held for accept/veto, then reopens the same history and original budget across days. Decline a continuation by cancelling its offer; the initial-offer native shortcut never replays a worker handle. Current instructions and permissions refresh. Missing history/accounting, uncertain state, changed directory scope or revoked disclosure refuses continuation. Native retention may remove history; no idle worker service is maintained.

## Charges and limits

A valid offered job incurs one routing fee: 15% of expected inference spend, capped at $0.003, even if declined. Inference uses reported tokens plus the 5% proxy fee. Quotes reserve the requested output allowance and a conservative input bound; final usage can be lower. Provider overruns remain Tenjin's exposure and cannot increase the accepted quote. A usual 32K-output Messages request reserves at least $0.041611 at the current peak tariff before additional system/tools/history input. Configuration refuses a job ceiling below $0.044611, including the maximum routing fee; this necessary floor does not guarantee a larger prompt fits. A continuing job must retain enough unspent ceiling for each next call's full quote. Inference is refused if its quote exceeds the remaining ceiling; a routing fee may already be paid. The separately approved job ceiling controls inference deposits rather than the tool router's positive per-call limit; the daily budget, creator allowlist and an explicit zero automatic-spend stop still apply. Other connected services retain their own permissions and billing. Tenjin's paid-tool router and purchase tool do not run inside these workers.

At current peak rates plus 5%, a 32K-output Messages quote is about $0.04 plus $0.32 per decimal MB of request body through about 1.04 MB, then caps near $0.371 at the model's input-context limit. Budget left after actual spend and unresolved reservations must cover each next full quote; these are reservation estimates, not actual charges or a guaranteed run.

Uncertain signed requests keep their full reservation until reconciled; recovery does not buy a replacement. `subagent` reports completion, elapsed time, accounted spend and unresolved reservations. Timeout or interruption is not proof of settlement. Jobs have a 40-minute wall limit and Claude's 500-turn emergency guard; native compaction remains enabled.

Claude Code is primary and requires a qualified installed version with observed Manual, Accept edits, Auto or `dontAsk` mode. Auto uses the native classifier with Flash; explicit asks remain asks. Plan, bypass and unavailable modes stay native.

Codex uses the router's existing experimental support. Only independent foreground calls with explicit `fork_turns: "none"`, fully covered native access and the existing Never/user approval policy qualify. Other modes and history-inheriting calls stay native. Codex worker resume and background-agent UI are outside this pilot.

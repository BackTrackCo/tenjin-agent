# DeepSeek subagents

Tenjin can offer DeepSeek V4.1 Flash 1017 for helper work. Your parent keeps its model and final accept/veto. Ordinary implementation and scoped review can qualify; planning stays native. Repository instructions and model/privacy restrictions still apply.

## Enable or stop

```sh
tenjin config subagents on --repository /path/to/repository --max-job 1
tenjin config subagents off
```

Enable one or more repositories, or a folder that contains them. Enabling records consent for that directory and descendants, the configured router origin, recipients and a cumulative routing/inference ceiling. Repeat for another repository to retain both, or explicitly name a containing workspace. Local GitHub origin names for the selected directories and their direct child repositories accompany offers so the parent can match GitHub tasks to the disclosed paths. Names are informational: they grant no filesystem permissions or additional disclosure scope. Changed or missing origins drop stale names until consent is renewed. A project can disable routing, but cannot grant consent or raise your money limits. Legacy consent must be renewed explicitly.

## Data and permissions

Routing sends the assignment and bounded parent context to Tenjin and TypeSafe before acceptance. After acceptance, applicable instructions, assignments and tool results reach DeepSeek through Tenjin. Known secrets are masked; sensitive prose is not guaranteed anonymous. Server replay content expires after 24 hours; financial and continuation authorization records persist.

The Claude worker retains native settings, rules, hooks, MCPs, CLIs and tool permissions in the current workspace, including uncommitted changes. Global auto-memory is disabled for this worker. Native directory grants must fit disclosure; extra disclosure roots grant no access. Your parent's endpoint, saved login and Remote Control stay in place. Unsupported authority or host-controlled authentication keeps work native. A provider refusal at worker startup can follow an already-paid routing fee.

Worker file tools and commands cannot read credential-bearing native config, history or private controller data. Ordinary skill, agent, command and support files remain usable under the current native permissions.

## Accept, cancel and continue

The parent calls its native subagent tool normally. An offer starts no worker. Accept with `subagent({offer_id})` or retry the original native call unchanged. Saved consent covers its stated disclosure/inference scope; binding restrictions and additional approvals still apply. The parent retains repository-specific risk judgment and normal tool asks.

Cancel an offer or active worker with `subagent({cancel: offer_id})`, or interrupt the host. Turning routing off prevents new paid requests; cancel to drain active work. Repeated acceptance does not start a second worker.

On supported Claude Code versions, use the native Down-arrow agent selector and Enter to open the running DeepSeek agent. Its Tenjin activity panel shows recent worker tool calls/results and final accounted spend. Stopping that agent cancels its owned worker. Worker operations appear as activity rows; the work result returns separately to the parent, and continuations retain the full worker history.

Before reloading or removing Tenjin, wait for the parent's Tenjin call to finish or confirm cancellation, and for its native activity agent to stop. A stop acknowledgement alone does not confirm both have drained. Removing or reloading the mod while the viewer is active can let Claude call its own model outside the DeepSeek worker budget.

Completed Claude workers return a `tenjin-worker-…` handle. The same parent can continue with native `SendMessage`, or compatible `Agent.resume`. Each full follow-up is held for accept/veto, then reopens the same history and original budget across days. Current instructions and permissions refresh. Missing history/accounting, uncertain state, changed directory scope or revoked disclosure refuses continuation. Native retention may remove history; no idle worker service is maintained.

## Charges and limits

A valid offered job incurs one routing fee: 15% of expected inference spend, capped at $0.003, even if declined. Inference uses reported tokens plus the 5% proxy fee. Quotes reserve the requested output allowance and a conservative input bound; final usage can be lower. Provider overruns remain Tenjin's exposure and cannot increase the accepted quote. A usual 32K-output Messages request reserves at least $0.041611 at the current peak tariff before additional system/tools/history input. Configuration refuses a job ceiling below $0.044611, including the maximum routing fee; this necessary floor does not guarantee a larger prompt fits. A job must retain enough unspent ceiling for each call's full quote, so its final reservation cannot all be consumed as actual spend. Inference is refused if its quote exceeds the remaining ceiling; a routing fee may already be paid. The separately approved job ceiling controls inference deposits rather than the tool router's positive per-call limit; the daily budget, creator allowlist and an explicit zero automatic-spend stop still apply. Other connected services retain their own permissions and billing. Tenjin's paid-tool router and purchase tool do not run inside these workers.

Uncertain signed requests keep their full reservation until reconciled; recovery does not buy a replacement. `subagent` reports completion, elapsed time, accounted spend and unresolved reservations. Timeout or interruption is not proof of settlement. Jobs have a 40-minute wall limit and Claude's 500-turn emergency guard; native compaction remains enabled.

Claude Code is primary and requires a qualified installed version with observed Manual, Accept edits, Auto or `dontAsk` mode. Auto uses the native classifier with Flash; explicit asks remain asks. Plan, bypass and unavailable modes stay native.

Codex uses the router's existing experimental support. Only independent foreground calls with explicit `fork_turns: "none"`, fully covered native access and the existing Never/user approval policy qualify. Other modes and history-inheriting calls stay native. Codex worker resume and background-agent UI are outside this pilot.

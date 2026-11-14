# DeepSeek subagents (draft pilot)

Tenjin can offer DeepSeek V4.1 Flash 1017 for bounded helper work while your parent stays on its original model. All planning stays native, including rewriting an approved plan. Sensitive executable changes, independent deep/security assurance and explicit model/privacy restrictions also stay native. The parent has the final accept/veto choice; an offer alone starts nothing.

Claude Code is the primary host. The worker uses the maintained Claude Agent SDK with your normal project/user settings, MCPs and tool permission rules. It keeps the parent's workspace, including uncommitted changes, and runs with the SDK sandbox. It does not replace the parent's endpoint, credentials or Remote Control. Unsupported custom profiles, isolation requests or permission paths stay native.

Codex retains the router's existing experimental designation, with no extra setting. On qualified Codex 0.163.0 and 0.167.0-alpha.4.1 hosts, Tenjin holds an independent foreground native spawn and asks the parent to resubmit the complete plaintext assignment. Codex's encrypted message is never decrypted. Tenjin attaches the owned parent context, then the parent accepts or retries native. The maintained worker has only the qualified Codex broker's tools: sandboxed commands and the native authenticated MCP catalog, with deny/ask rules checked before execution. Claude tools and settings grant no Codex authority. Guardian review, applicable hooks that cannot be preserved, hosted app connectors, unknown policy overlays and unsupported native options keep the job native before paid routing.

## Opt in

Run this only when the person wants this repository's subagent work to reach Tenjin and DeepSeek:

```sh
tenjin config subagents on --repository /path/to/repository --max-job 1
```

The command records version 2 consent for the exact repository, configured router origin, recipients, applicable instructions and total routing/inference ceiling. Version 1 consent keeps work native until the person explicitly enables it again. Routing sends the assignment and bounded parent context to Tenjin and its TypeSafe/Jev processor before the parent accepts an offer. After acceptance, the worker’s applicable native instruction context, assignments and tool results reach DeepSeek through Tenjin. Routing inputs remain the assignment and bounded ordinary parent context; the parent’s final veto preserves known binding constraints. Existing per-call and daily wallet limits still apply. Installing the CLI, turning tool routing on, or having an older native-tier/effort setting is not inference consent. A project can restrict the feature with `router.subagents: false`; it cannot opt anyone in. Known secrets are masked, but sensitive prose is not guaranteed anonymous. Server replay replies are available for 24 hours; expired content is removed by bounded cleanup.

Codex carries its native global/project AGENTS hierarchy into the worker in order, including configured override and fallback filenames. References stay verbatim; the worker follows them through its normal guarded tools. The local snapshot is checked before selection and execution. Custom Codex base/developer instructions or model-instruction-file overrides stay native before paid routing. Unknown, unreadable, changed or oversized initial Codex context keeps the assignment native; source reads use the original native filesystem permission gate and never include wallet, authentication or environment files. Claude retains the maintained SDK’s normal automatic global/ancestor/repository CLAUDE, import and scoped-rule loading. These instruction paths grant no extra tool or filesystem permission. The routing envelope remains 16 KB with no new instruction field or extra classification call.

To stop new work:

```sh
tenjin config subagents off
```

The parent calls its native Agent tool normally. Tenjin returns either native continuation or an offer naming DeepSeek, its reason, fees and ceiling. The parent accepts with `subagent({offer_id})` or retries the original native call unchanged. No extra human confirmation is added for the handoff. Normal tool asks and payment limits still apply. An ignored offer starts neither worker. A repeated acceptance cannot start a second worker.

The model router charges once per job: 15% of expected provider spend, capped at $0.003, even when the parent declines a valid paid offer. The inference proxy charges actual reported usage plus 5%. Batch settlement collects vouchers later; it does not delay inference. Model routing and inference each use separate SDK channels, salts and storage, isolated from tool routing and scoped to the configured server origin. A local server and production therefore cannot fork one onchain channel, even when the payer and recipient are the same. Model routing keeps the $0.003 fee ceiling and normal routing deposit bounds. Inference uses its quoted reservation under the existing automatic spend policy. A quote can reserve substantially more than the eventual usage charge because it covers provider output exposure.

The `subagent` tool reports the result, elapsed time, actual accounted spend and unresolved reservations. `subagent({cancel: offer_id})` stops and drains an owned worker. Turning the feature off stops new paid turns and tool actions. A timed-out or interrupted purchase remains uncertain until its signed owner-scoped receipt is recovered; Tenjin never buys that turn again automatically. Once the worker is quiescent, the original native task can continue. Codex Interrupt is bound to its turn and uses the native three-second hook limit. Codex does not support SessionEnd MCP hooks; MCP disconnection or SIGTERM drains owned workers. `tenjin balance` and `tenjin status` show remaining model-routing credit separately from inference credit for the current server origin. Each is reused only by its own lane and channel configuration; neither can pay tool-routing fees or calls at another origin. Changing the endpoint leaves the old origin's credit in its SDK storage; switching back makes it visible again.

The local pilot has qualified the current native host, authenticated MCP flow, allowed/denied/ask actions, cancellation and instruction inheritance. Matched frozen worker-capability evaluation and broader activation remain pending. Fable parent testing remains deferred. UI rows may be ordinary MCP rows; quality, time and all-in cost take precedence over cosmetic parity with native subagents.

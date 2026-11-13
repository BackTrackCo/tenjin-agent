# DeepSeek subagents (draft pilot)

Tenjin can offer DeepSeek V4.1 Flash 1017 for bounded helper work while your parent stays on its original model. All planning stays native, including rewriting an approved plan. Sensitive executable changes, independent deep/security assurance and explicit model/privacy restrictions also stay native. The parent has the final accept/veto choice; an offer alone starts nothing.

Claude Code is the primary host. The worker uses the maintained Claude Agent SDK with your normal project/user settings, MCPs and tool permission rules. It keeps the parent's workspace, including uncommitted changes, and runs with the SDK sandbox. It does not replace the parent's endpoint, credentials or Remote Control. Unsupported custom profiles, isolation requests or permission paths stay native.

Codex retains the router's existing experimental designation, with no extra setting. On qualified Codex 0.163 hosts, Tenjin holds an independent foreground native spawn and asks the parent to resubmit the complete plaintext assignment. Codex's encrypted message is never decrypted. Tenjin attaches the owned parent context, then the parent accepts or retries native. The maintained worker has only the qualified Codex broker's tools: sandboxed commands and the native authenticated MCP catalog, with deny/ask rules checked before execution. Claude tools and settings grant no Codex authority. Guardian review, applicable hooks that cannot be preserved, hosted app connectors, unknown policy overlays and unsupported native options keep the job native before paid routing.

## Opt in

Run this only when the person wants this repository's subagent work to reach Tenjin and DeepSeek:

```sh
tenjin config subagents on --repository /path/to/repository --max-job 1
```

The command records the exact repository, configured router origin, recipients and total routing/inference ceiling. Routing sends the assignment and bounded parent context to Tenjin and its TypeSafe/Jev processor before the parent accepts an offer. Accepted worker assignments and tool results reach DeepSeek through Tenjin. Existing per-call and daily wallet limits still apply. Installing the CLI, turning tool routing on, or having an older native-tier/effort setting is not inference consent. A project can restrict the feature with `router.subagents: false`; it cannot opt anyone in. Known secrets are masked, but sensitive prose is not guaranteed anonymous. Server replay replies are available for 24 hours; expired content is removed by bounded cleanup.

To stop new work:

```sh
tenjin config subagents off
```

The parent calls its native Agent tool normally. Tenjin returns either native continuation or an offer naming DeepSeek, its reason, fees and ceiling. The parent accepts with `subagent({offer_id})` or retries the original native call unchanged. No extra human confirmation is added for the handoff. Normal tool asks and payment limits still apply. An ignored offer starts neither worker. A repeated acceptance cannot start a second worker.

The model router charges once per job: 15% of expected provider spend, capped at $0.003, even when the parent declines a valid paid offer. The inference proxy charges actual reported usage plus 5%. Batch settlement collects vouchers later; it does not delay inference. Inference has its own SDK channel salt/storage and never borrows the routing fee's $0.003 ceiling. A quote can reserve substantially more than the eventual usage charge because it covers provider output exposure.

The `subagent` tool reports the result, elapsed time, actual accounted spend and unresolved reservations. `subagent({cancel: offer_id})` stops and drains an owned worker. Turning the feature off stops new paid turns and tool actions. A timed-out or interrupted purchase remains uncertain until its signed owner-scoped receipt is recovered; Tenjin never buys that turn again automatically. Once the worker is quiescent, the original native task can continue. Codex Interrupt is bound to its turn; MCP disconnection drains the worker even when SessionEnd cannot reach the closed MCP connection. Remaining model channel credit appears separately in `tenjin balance` and `tenjin status` and is reused by later model turns.

The local pilot must qualify its real host, authenticated MCPs, allowed/denied/ask actions, cancellation and matched worker capability before everyday activation. Fable parent testing remains deferred. UI rows may be ordinary MCP rows; quality, time and all-in cost take precedence over cosmetic parity with native subagents.

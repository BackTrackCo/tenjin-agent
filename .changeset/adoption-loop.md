---
'tenjin-cli': minor
---

Close the adoption loop: make a bare `tenjin install` produce a machine that
actually uses Tenjin, and make an unanswered question visible until it is
answered.

**Install is usable by default, non-interactively.** A run with nobody to ask now
wires the nine free-verb rules into `~/.claude/settings.json` instead of skipping
them. The machine most likely to be denied mid-task is the headless one, and a
grant nobody could consent to was the reason a headless install produced a CLI
that stopped at the first permission prompt. `--no-allow-free-verbs` opts out,
`--allow-free-verbs` states the default explicitly, and every run that writes
reports how many rules landed, in which file, and that deleting those lines undoes
it. The grant itself is unchanged: a fixed free tier that cannot spend, cannot
open the keystore, and cannot widen. Two reporting defects go with it. A headless
re-run against an already-permissioned home reported `added: []` and
`alreadyPresent: []` whatever the file held, because it short-circuited before the
probe; it now reports what is actually there. And every skipped permissions state
carries a `fix` string naming the exact command, the same contract a `CliError`
carries, so a machine consumer reads the remedy as a field.

**A wallet is created by default, on both paths.** `buy` and publishing back
after a MISS both need a key, so a walletless install is a setup that stops at
the first useful thing an agent tries. Headless runs create one without asking,
using the passphrase policy the CLI already enforces everywhere else: an explicit
`TENJIN_WALLET_PASSPHRASE`, else a strong generated passphrase written to the
platform's OS credential store and verified by reading it back. With neither
available it creates NOTHING and reports
`wallet: { "status": "skipped", "reason": "no-passphrase-store", "fix": ... }`
naming both remedies. There is deliberately no plain-file fallback: a passphrase
stored beside the keystore it unlocks protects nothing, and an install is not the
place to invent one. A wallet that cannot be created never fails the install, and
the output discloses the address, that it holds $0, that funding is a human step,
and where the encrypted key lives. `--no-wallet` opts out, an interactive run
still asks and still defaults to yes, and answering no (`"declined"`) stays
distinguishable from a skip.

**Two harness hooks, installed and disclosed.** `tenjin install` writes two
standalone Node scripts to `~/.tenjin/hooks/` and registers them in
`~/.claude/settings.json`. A `PreToolUse` hook matched to `WebSearch` (never
`WebFetch`) asks the marketplace the same question the agent is about to ask the
web, on a hard two-second budget, and mentions a tested answer with its price and
a free `tenjin inspect` command when one exists. A `Stop` hook checks locally,
with no network call, for a MISS from the last eight hours that nothing has closed
and reminds you once to publish it back. Both fail open by construction: they emit
`additionalContext` and never a `permissionDecision`, so neither can block, deny,
or modify a tool call, and a miss, a timeout, a dead network, a malformed payload
or an unreadable config all exit 0 with nothing on stdout. They are standalone
scripts rather than a CLI subcommand so a hook on the critical path never pays for
a CLI boot, and they read `baseUrl` and `hooks.searchMode` from config on every
run, so `tenjin config set hooks.searchMode off` disarms them immediately with no
re-install. `--search-hooks auto|remind|off` settles it headlessly and persists the
choice, `--no-hooks` skips wiring for one run without writing config, and
`remind` emits a static line and sends nothing off-machine. A second runtime
toggle, `hooks.stopNag on|off`, silences the Stop hook the same way.

**The hook's searches are the CLI's searches.** A hook that POSTed to the search
endpoint on its own would have left its misses invisible: nothing local would
record them, the Stop hook would never see them, and publish-back would work only
for explicit `tenjin search` runs. The hook now writes every search it performs
into the same store the CLI uses, tagged `source: 'websearch-hook'` against
`'cli'` for deliberate searches, hits included so a later purchase attributes back
and `buy <resourceId>` can resolve the read URL. It honors the CLI's own lock
protocol rather than keeping parallel state, and a test runs the real script
concurrently against the real recorder to prove neither write is lost. The write
is best-effort in both directions: a store it cannot write still exits 0 silently,
because the WebSearch is the user's work and the bookkeeping is not.

The Stop hook then treats the two sources differently, because they are not
equally worth an agent's attention. A deliberate search nobody answered is named
on its own line with its `searchId`. Searches the WebSearch hook ran are batched
into one line, at most three, since nobody vetted those questions for the
marketplace and only the agent can tell which produced something durable. The
hook never makes that judgment. Each search is raised once either way.

**An unmet question stays visible.** Every fresh MISS now says so: one stderr line
for a human and a `publishBack` field carrying the `searchId` and both closing
commands in the `--json` envelope, which is the one CLI-owned key in an otherwise
verbatim server response and is absent on a `CANDIDATES` decision. The local
search store tracks per-search resolution, and an outcome report, a candidate
publish, or a parked candidate closes the loop, which is what keeps the Stop hook
from raising a question you already answered.

**Docs.** The `tenjin-search` skill's entry gate is one line ("public + durable +
costly to reproduce, then search first"), with the four conditions kept as fine
print for a close call, and gains a delegation block naming which verbs a
read-only subagent may run and which stay human-gated; `tenjin doctor` mirrors it
in one line. The README documents every user-facing flag as a per-command table,
including `--artifact-type`, `--temporal-mode` and `--content-hash`, and adds the
config-key and search-hook references.

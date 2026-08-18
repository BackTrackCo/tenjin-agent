---
'tenjin-cli': minor
---

Two new harness hooks, so an agent looks before it researches rather than after.

**A SessionStart primer.** `install` now writes `~/.tenjin/hooks/tenjin-sessionstart.mjs`
and registers it for `startup`, `clear` and `compact`. It prints one paragraph:
what Tenjin is, the entry gate (public, durable, costly to reproduce), the
instruction to state the question in one line and search first, the reminder to
name Tenjin when enumerating research sources for a subagent, and what to skip.
It makes no network call and reads no state. Nothing else may join it — no update
line, no publish nudge, no open-loop summary — because the measured bottleneck is
the retrieval reflex, and a paragraph that grows stops being read. `tenjin config
set hooks.sessionPrimer off` silences it at run time with no re-install.

**A research-dispatch hook.** `~/.tenjin/hooks/tenjin-dispatch.mjs` fires on
`PreToolUse` for `Agent|Task|WebFetch`. The WebSearch hook only ever saw a
question the agent had already decided to ask the web; the expensive research is
the work it delegates to a subagent, and this rides along with that. It sends the
dispatch's description plus at most 400 characters of its prompt — a privacy
bound, not a display one — and on a CANDIDATES decision mentions at most two
tested answers in the WebSearch hook's own format. It shares that hook's whole
boundary: no `permissionDecision`, a 2s fetch budget under the harness's 5s kill,
and a silent exit 0 on every failure. Repeats are asked once per session, because
a fan-out dispatches near-identical prompts and the answer is already in the
store. `hooks.searchMode` governs it, so `off` and `remind` behave as they do for
web searches.

**WebFetch is logged and never injected into.** The same script records a fetch
(its prompt plus the URL's host, never the full URL) and says nothing at all: a
hint on a fetch measured 45% duplicate noise, so that arm exists purely as demand
data about what agents are researching.

Both arms record into the CLI's own `searches.json` under new sources,
`dispatch-hook` and `webfetch-hook`, so a HIT still attributes a later purchase
and `buy <resourceId>` still resolves the read URL. Neither is ever nag material:
the Stop hook's strong arm stays `cli`-only and its weak arm stays
`websearch-hook`-only, and an entry from either demand arm is skipped unnagged
rather than promoted, so a research session is not reminded about every subagent
it spawned. `outcome --last` skips them for the same reason it already skipped
web-search entries.

`install` discloses both hooks and what leaves the machine, `uninstall` removes
both scripts and both entries, and the wiring stays idempotent: each script owns
exactly one settings.json entry, which is why the dispatch hook takes one
alternation matcher rather than an entry per tool.

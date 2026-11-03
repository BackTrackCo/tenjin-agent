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
`PreToolUse` for `Agent|Task`, the two names one subagent dispatch goes by across
Claude Code versions. The WebSearch hook only ever saw a question the agent had
already decided to ask the web; the expensive research is the work it delegates to
a subagent, and this rides along with that. It sends the dispatch's description
plus at most 400 characters of its prompt — a privacy bound, not a display one —
and on a CANDIDATES decision mentions at most two tested answers in the WebSearch
hook's own format, in the parent's context only, since the tool input is already
formed by then. It shares that hook's whole boundary: no `permissionDecision`, a
2s fetch budget under the harness's 5s kill, and a silent exit 0 on every failure.
`hooks.searchMode` governs it, so `off` and `remind` behave as they do for web
searches, and the disclosure at install time now names the subagent prompt and its
400-character bound.

**Two bounds on a fan-out.** The same question is asked once per session, because
a fan-out dispatches near-identical prompts and the answer is already in the
store, and a session gets at most 10 dispatch lookups however wide it fans out, so
a ten-way research turn cannot put the fetch budget in front of every subagent.
Nothing fires on a `WebFetch`.

Dispatches record into the CLI's own `searches.json` under a new `dispatch-hook`
source, so a HIT still attributes a later purchase and `buy <resourceId>` still
resolves the read URL. They are never nag material: the Stop hook's strong arm
stays `cli`-only and its weak arm stays `websearch-hook`-only, an entry from any
other source is skipped unnagged rather than promoted, and `outcome --last` skips
them for the same reason it already skipped web-search entries. Because nothing
ever closes one, they also hold at most 15 of the store's 50 slots: a demand entry
is telemetry, and the store's other two jobs are resolving a payable read URL and
finding the last deliberate search, so a wide fan-out must not be able to drain
either.

`install` discloses both hooks and what leaves the machine, `uninstall` removes
both scripts and both entries, and the wiring stays idempotent: each script owns
exactly one settings.json entry, which is why the dispatch hook takes one
alternation matcher rather than an entry per tool.

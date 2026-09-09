# Codex hook payloads, as the installed CLI sent them

Captured 2026-09-08 (UTC) from `codex-cli 0.153.4` (`codex --version`), the
standalone CLI, running `codex exec -s workspace-write` in a throwaway git
checkout with a project `.codex/hooks.json` whose one `command` handler logged
its stdin and returned a canned response. Every file is one payload verbatim,
with these substitutions and nothing else:

- ids replaced relationally: one map for the whole capture, so the root session
  (`aaaaaaaa-…0001`), each child (`bbbbbbbb-…`) and each turn (`cccccccc-…`)
  keep their correlations across files; the root-only run is `aaaaaaaa-…0000`;
- the checkout path is `/Users/dev/proj` and rollout paths sit under
  `/Users/dev/.codex`; the prompt text is a placeholder;
- shell output that dumped the environment is cut to the four `CODEX_*` lines
  the loop reads; the spawn `message` ciphertext and the web results are cut to
  a placeholder of their observed length.

What the two sessions observed, beyond the fields:

- `additionalContext` returned on SessionStart, UserPromptSubmit, PreToolUse and
  PostToolUse reached the model (it echoed every marker back on request).
- On Stop and SubagentStop, `{ "decision": "block", "reason": … }` continued the
  turn (the model answered the reason) and the next Stop/SubagentStop carried
  `stop_hook_active: true`; the fused files are that second event.
- `session_id` is the root session on every event, including inside nested
  children; `agent_id` is the child's own thread id and appears only inside a
  child. The child's shell sees `CODEX_SESSION_ID` equal to that root session and
  `CODEX_THREAD_ID` equal to its `agent_id` (`child-PostToolUse.json`).
- A shell PostToolUse fires on a nonzero exit too, with the output text alone and
  no exit status (`PostToolUse-silent-exit.json` was `exit 3`). An apply_patch
  response carries an `Exit code:` header of its own.
- Matchers are alternations on `tool_name` (`Bash|apply_patch` on PreToolUse and
  `Bash` on PostToolUse fired exactly those).
- The spawn tool is named `collaborationspawn_agent` and its `message` is opaque
  ciphertext; `task_name` is a label. SubagentStart carries the child's own turn,
  not the parent's, and nothing names the spawn call that produced it.
- Not captured: `write_stdin` (a 20 s command completed inside one exec call),
  SessionStart with `source` other than `startup`, and the desktop bundle.

## Observed through the built daemon (2026-09-08)

Two further `codex exec` sessions ran with the project's `.codex/hooks.json`
holding exactly the seven entries `tenjin install` writes (each `node
<data>/hooks/tenjin-shim.mjs --harness codex`) against a daemon started from
this build's bundles under a scratch data dir, `hooks.subagent` and the web arms
off, and the public shelf as the only shelf:

- root: the primer arrived at SessionStart (the model quoted its first sentence
  back), the prompt lookup ran (`no-hit`), the `apply_patch` and Bash calls left
  `edited:` and `bashstart` marks under `codex:<session>`, the Stop ask went out
  as `decision: block` (Codex printed `hook: Stop Blocked`), the model answered,
  and the fused Stop harvested;
- child: SubagentStart wrote `started` under the child's own id, its patch was
  marked under that id, its SubagentStop carried the capture ask with
  `--agent <id>`, and the fused SubagentStop harvested. No `daemon-down` line was
  written in either session.

## Observed through the installed home-level registrar (2026-09-09)

An isolated `HOME` ran the built `tenjin install --harness codex`, producing the
process home file `~/.codex/hooks.json` with exactly seven entries. The throwaway
git checkout had no project `.codex/hooks.json`. On the first Codex 0.153.4
startup, Codex presented all seven home hooks as new or changed; choosing
`Trust all and continue` recorded seven `hooks.state` entries for that home file
in `~/.codex/config.toml`.

A subsequent `codex exec -s workspace-write` in the hook-free project reached
the installed shim and built daemon through that home file. One prompt that used
`apply_patch` and Bash recorded one `session.start`, one `prompt`, two
`tool.before`, one `tool.after`, and two `turn.end` fires under the `codex`
harness. The first Stop was blocked and the fused Stop completed; no
`daemon-down` line was written.

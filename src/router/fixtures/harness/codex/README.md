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
- the web results are cut to a placeholder of their observed length.

What the sessions observed, beyond the fields:

- `session_id` is the root session on every event, including inside nested
  children; `agent_id` is the child's own thread id and appears only inside a
  child.
- A shell PostToolUse fires on a nonzero exit too, with the output text alone and
  no exit status.
- Matchers are alternations on `tool_name`.

`src/router/codex-wire.ts` decodes these; `codex-wire.test.ts` reads them.

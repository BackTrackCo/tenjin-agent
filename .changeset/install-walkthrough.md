---
'tenjin-cli': minor
---

The CLI is now human-first at a terminal. At an interactive terminal without
`--json`, every command prints a plain human rendering to stdout and no JSON;
with `--json`, or when the output is piped (an agent, a script), it prints exactly
one JSON envelope and nothing else. Exit codes are unchanged. Agents should pass
`--json`; the bundled skills now do so on every command.

`tenjin install` becomes a real onboarding walkthrough: skills installed per
harness, a publish-mode question, optional wallet creation with the address and
funding steps, and a one-line health check, instead of a JSON blob. Pass `--json`
(or pipe it) for the machine envelope, and `--no-wallet` to skip the wallet step.

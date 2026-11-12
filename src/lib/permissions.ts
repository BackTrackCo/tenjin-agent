/**
 * The page that says what the router may spend and what leaves this machine:
 * the plugin's two permission answers, the opt-in `tenjin pay` line, the flag
 * caveat, and the verbs never to pre-approve. Every human surface points
 * at it rather than carrying the prose, which a terminal cannot link to, and
 * `src/skills-text.test.ts` pins the page against the constants it documents.
 */
export const PERMISSIONS_DOC_URL =
  'https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/agent-permissions.md';

/**
 * THE NARROW SHELL RULES FOR YOUR SETTINGS (plan 36), which
 * `docs/agent-permissions.md` lists for an operator to paste and nothing
 * installs: reading them (`tenjin config`, `--json`, `--help`, `get`), and
 * the two operations that only ever narrow or reorder, `block` and `prefer`.
 * `unblock`, `only`, `reset`, `set`, `speed on` and `replacement` stay behind
 * the host's own prompt, since each can widen what Tenjin may use, spend or
 * run without asking; never a blanket `Bash(tenjin config:*)`, which covers
 * them all. `src/skills-text.test.ts` pins the page to this list.
 */
export const SETTINGS_RULES = [
  'Bash(tenjin config)',
  'Bash(tenjin config --json)',
  'Bash(tenjin config --help)',
  'Bash(tenjin config get:*)',
  'Bash(tenjin config block:*)',
  'Bash(tenjin config prefer:*)',
] as const;

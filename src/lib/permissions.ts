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
 * The page that holds what `tenjin config --help` leaves out: every operation
 * in full, the fine print on blocks and resellers, and what each value means.
 * The help stays short and points here.
 */
export const SETTINGS_DOC_URL =
  'https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/router-reference.md#your-settings';

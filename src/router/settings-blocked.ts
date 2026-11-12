/**
 * `settings_blocked`: the user's own Tenjin settings left a recognized task
 * with nothing Tenjin may use, so the router answered `native`. Its
 * `nextAction` names the rule in plain words ("Your Tenjin settings block
 * Firecrawl, ..."), and is what the agent is shown: on the prompt and
 * after-call hooks as one line, and in the request tool's result. The agent
 * tells the user and never changes the setting itself.
 *
 * Hook-safe: no imports.
 */
export const SETTINGS_BLOCKED = 'settings_blocked';

/**
 * `unverified` (plan 37): every route the settings allow for this step is a
 * connected account's map Tenjin has not checked with a real call, which runs
 * only when the user names it. Its `nextAction` names the service and the
 * `request({tool})` that runs it, and is shown the same way.
 */
export const UNVERIFIED = 'unverified';

/** The refusals whose `nextAction` the agent is shown as written. */
export const SHOWN_REFUSALS: ReadonlySet<string> = new Set([SETTINGS_BLOCKED, UNVERIFIED]);

const FALLBACK =
  'Your Tenjin settings rule out every Tenjin tool for this, so Tenjin did not offer one. The user can change that with `tenjin config`.';

/** The line the agent is shown: the server's own sentence, as one plain line. */
export function settingsBlockedLine(diagnostics: { nextAction: string }): string {
  const line = diagnostics.nextAction.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return line.length > 0 ? line : FALLBACK;
}

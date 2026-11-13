import { personalSettingsAt, type WireState } from './settings';

/**
 * THE CHECK BEFORE EVERY CALL (plan 36). An offer runs only under the rules
 * it was decided under: the hash its answer echoed (`settingsHash`, kept with
 * each spec) must equal the hash of the rules saved now. A different hash
 * means the user changed their settings after the offer, so a provider they
 * just blocked can never be paid on an old offer. An answer that echoed no
 * hash, while the user has any rule saved, came from a router that did not
 * apply them. Either way the call is refused before any provider request,
 * signing or credential, and the agent is told to ask again; nothing here
 * routes again on its own. With no rules saved and no hash, a call runs as it
 * always did.
 *
 * Local only: the global file, read now, so a change from another process
 * applies to the very next call. The CLI keeps no copy of the rule logic:
 * comparing two hashes is the whole check.
 */

export type SettingsRefusalCode =
  'settings_changed' | 'settings_unconfirmed' | 'settings_unreadable';

export interface SettingsRefusal {
  code: SettingsRefusalCode;
  reason: string;
  nextStep: string;
}

const ASK_AGAIN =
  'Call request again with the query (request({query})) for an offer under the current settings.';

/**
 * Null when every hash in `decided` (one per offer about to run, `undefined`
 * for an answer that echoed none) still names the rules saved now; else why
 * not. A whole group is checked at once, so a compare set never shrinks into
 * a different charge: one stale member refuses them all.
 */
export async function settingsRefusal(
  dataDir: string,
  decided: readonly (string | undefined)[],
): Promise<SettingsRefusal | null> {
  let now: Awaited<ReturnType<typeof personalSettingsAt>>;
  try {
    now = await personalSettingsAt(dataDir);
  } catch {
    return UNREADABLE;
  }
  if (now.wire.status === 'invalid') return UNREADABLE;
  for (const hash of decided) {
    const refusal = hashRefusal(now.wire, hash);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * THE RULE ITSELF, for one hash an answer echoed (`undefined` for none) against
 * the rules saved now: null when it names them, or when it is absent and no
 * rule is saved; else why not. Pure, so the hooks hold an answer to the same
 * rule before they offer from it.
 */
export function hashRefusal(
  wire: Extract<WireState, { status: 'ok' }>,
  hash: string | undefined,
): SettingsRefusal | null {
  if (hash === undefined) {
    if (!wire.hasRules) return null;
    return {
      code: 'settings_unconfirmed',
      reason:
        "Tenjin's router did not confirm it applied your Tenjin settings to this offer, so it was not run and nothing was sent or paid.",
      nextStep: `${ASK_AGAIN} If Tenjin keeps answering without your settings, use your own tools for this.`,
    };
  }
  if (hash !== wire.settings.hash) {
    return {
      code: 'settings_changed',
      reason:
        'Your Tenjin settings changed after this offer was made, so it was not run and nothing was sent or paid.',
      nextStep: ASK_AGAIN,
    };
  }
  return null;
}

/** Rules this build cannot read: nothing runs, and `tenjin config` names why. */
export const UNREADABLE: SettingsRefusal = {
  code: 'settings_unreadable',
  reason: "Your saved Tenjin rules can't be read, so Tenjin offers nothing.",
  nextStep:
    '`tenjin config` shows the problem and `tenjin config reset --all` clears them; run either if the user asks.',
};

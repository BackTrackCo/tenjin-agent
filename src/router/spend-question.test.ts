import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, MAX_AUTO_SPEND_FLOOR_ATOMIC } from '../lib/config';
import { ROUTER_DEFAULTS } from '../commands/config';
import { MAX_CHANNEL_DEPOSIT_ATOMIC } from './fee';
import { shownLimits, spendChoiceQuestion, spendOptions } from './spend-question';

describe('the spend question', () => {
  it('holds the same defaults as the code: $0.25 a call and $5 a day', () => {
    expect(ROUTER_DEFAULTS).toEqual({ maxAutoSpend: '250000', sessionBudget: '5000000' });
    expect(CONFIG_DEFAULTS.maxAutoSpend).toBe(ROUTER_DEFAULTS.maxAutoSpend);
    expect(CONFIG_DEFAULTS.sessionBudget).toBe(ROUTER_DEFAULTS.sessionBudget);
  });

  it('floors the per-call limit at the largest routing deposit, and defaults it there', () => {
    // A deposit the router asks for can reach $0.25: a lower ceiling would refuse it.
    expect(MAX_AUTO_SPEND_FLOOR_ATOMIC).toBe(MAX_CHANNEL_DEPOSIT_ATOMIC);
    expect(BigInt(ROUTER_DEFAULTS.maxAutoSpend)).toBeGreaterThanOrEqual(
      MAX_AUTO_SPEND_FLOOR_ATOMIC,
    );
  });

  it('shows the defaults where the file names no limit, and the file where it does', () => {
    expect(shownLimits({})).toEqual(ROUTER_DEFAULTS);
    expect(shownLimits({ sessionBudget: 'none' })).toEqual({
      maxAutoSpend: ROUTER_DEFAULTS.maxAutoSpend,
      sessionBudget: 'none',
    });
  });

  it('asks how much the agent may spend, with the fee terms either answer approves', () => {
    expect(spendChoiceQuestion()).toBe(
      'How much can your agent spend from its balance? Routing costs a fee the router quotes for each answer, never more than $0.25; offers show no fee. Tool charges are separate. Tenjin may set aside up to $0.25 at a time for it, counted in these limits once, when it is sent. Either choice approves this.',
    );
  });

  it('offers an agent two answers, each applied by one install command', () => {
    const options = spendOptions('tenjin install');
    expect(options.map((o) => [o.label, o.recommended, o.command])).toEqual([
      ['Up to $0.25 a call and $5 a day', true, 'tenjin install --yes'],
      [
        'Set my own limits',
        false,
        'tenjin install --max-auto-spend <usd> --session-budget <usd|none>',
      ],
    ]);
    // No answer turns automatic spending off, and none is a command for the
    // person or one joined with funding.
    for (const o of options) {
      expect(o.command).not.toMatch(/&&|;|tenjin fund|wallet fund|config set/);
      expect(o.label).not.toMatch(/no automatic/i);
    }
  });
});

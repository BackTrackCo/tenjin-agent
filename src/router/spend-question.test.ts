import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, MAX_AUTO_SPEND_FLOOR_ATOMIC } from '../lib/config';
import { ROUTER_DEFAULTS } from '../commands/config';
import { CHANNEL_DEPOSIT_ATOMIC } from './fee';
import { shownLimits, spendChoiceQuestion, spendOptions } from './spend-question';

describe('the spend question', () => {
  it('holds the same defaults as the code: $0.25 a call and $5 a day', () => {
    expect(ROUTER_DEFAULTS).toEqual({ maxAutoSpend: '250000', sessionBudget: '5000000' });
    expect(CONFIG_DEFAULTS.maxAutoSpend).toBe(ROUTER_DEFAULTS.maxAutoSpend);
    expect(CONFIG_DEFAULTS.sessionBudget).toBe(ROUTER_DEFAULTS.sessionBudget);
  });

  it('floors the per-call limit at the routing deposit, and defaults it there', () => {
    // A ceiling below the deposit would leave routing unable to pay at all.
    expect(MAX_AUTO_SPEND_FLOOR_ATOMIC).toBe(CHANNEL_DEPOSIT_ATOMIC);
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

  it('asks the defaults or your own limits, with the fee terms either answer approves', () => {
    expect(spendChoiceQuestion()).toBe(
      'Use the defaults ($5 per 24-hour budget window across agent sessions, $0.25 a call) or set your own limits. Routing costs $0.003 a call, paid from channel deposits of up to $0.25 that stay yours until spent; each deposit counts against these limits. Either answer also approves the routing fee.',
    );
  });

  it('offers an agent two answers, each applied by one install command', () => {
    const options = spendOptions('tenjin install');
    expect(options.map((o) => [o.label, o.recommended, o.command])).toEqual([
      ['Use the defaults', true, 'tenjin install --yes'],
      [
        'Set my own limits',
        false,
        'tenjin install --max-auto-spend <usd> --session-budget <usd|none>',
      ],
    ]);
    // No answer turns automatic spending off, and none is a command for the
    // person or one joined with funding.
    for (const o of options) {
      expect(o.command).not.toMatch(/&&|;|wallet fund|config set/);
      expect(o.label).not.toMatch(/no automatic/i);
    }
  });
});

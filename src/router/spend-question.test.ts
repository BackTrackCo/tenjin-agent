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
    // A funded wallet deposits $0.25: a lower ceiling would refuse it.
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

  it('asks the defaults or your own limits, with the fee terms either answer approves', () => {
    expect(spendChoiceQuestion()).toBe(
      'Use the defaults ($5 daily budget shared across chats, $0.25 a call) or set your own limits. Each routing call pays a quoted fee, at most $0.003, from funds set aside ($0.25 at a time, or $0.05 under a $0.50 balance) and names your wallet address. Unused funds remain yours; each deposit counts against these limits once. Either answer also approves the routing fee.',
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

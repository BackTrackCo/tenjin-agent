import { describe, expect, it } from 'vitest';
import { MAX_AUTO_SPEND_FLOOR_ATOMIC } from '../lib/config';
import { ROUTER_DEFAULTS } from '../commands/config';
import { MAX_CHANNEL_DEPOSIT_ATOMIC } from './fee';
import { shownLimits, spendChoiceQuestion, spendOptions } from './spend-question';

describe('the spend question', () => {
  it('keeps the per-call floor at the largest routing deposit and the default above it', () => {
    // A deposit the router asks for can reach $0.25: a lower ceiling would refuse it.
    expect(MAX_AUTO_SPEND_FLOOR_ATOMIC).toBe(MAX_CHANNEL_DEPOSIT_ATOMIC);
    expect(BigInt(ROUTER_DEFAULTS.maxAutoSpend)).toBeGreaterThan(MAX_AUTO_SPEND_FLOOR_ATOMIC);
  });

  it('shows the defaults where the file names no limit, and the file where it does', () => {
    expect(shownLimits({})).toEqual({ maxAutoSpend: '1000000', sessionBudget: '5000000' });
    expect(shownLimits({ maxAutoSpend: '250000', sessionBudget: '2000000' })).toEqual({
      maxAutoSpend: '250000',
      sessionBudget: '2000000',
    });
    expect(shownLimits({ sessionBudget: 'none' })).toEqual({
      maxAutoSpend: ROUTER_DEFAULTS.maxAutoSpend,
      sessionBudget: 'none',
    });
  });

  it('asks how much the agent may spend, with the fee terms either answer approves', () => {
    expect(spendChoiceQuestion()).toBe(
      'How much can your agent spend from its balance? Tenjin charges 15% of the estimated tool cost for paid recommendations. Tool use is billed separately. Routing top-ups count toward your limits. Either choice approves this.',
    );
  });

  it('offers an agent two answers, each applied by one install command', () => {
    const options = spendOptions('tenjin install');
    expect(options.map((o) => [o.label, o.recommended, o.command])).toEqual([
      ['Up to $1 a call and $5 a day', true, 'tenjin install --yes'],
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

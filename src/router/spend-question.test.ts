import { describe, expect, it } from 'vitest';
import { ROUTER_DEFAULTS } from '../commands/config';
import { acceptCommand, shownLimits, spendQuestion, unpaidNotice } from './spend-question';

describe('the spend question', () => {
  it('shows the defaults where the file names no limit, and the file where it does', () => {
    expect(shownLimits({})).toEqual(ROUTER_DEFAULTS);
    expect(shownLimits({ sessionBudget: 'none' })).toEqual({
      maxAutoSpend: ROUTER_DEFAULTS.maxAutoSpend,
      sessionBudget: 'none',
    });
  });

  it('names the limits and the routing fee, as the selector does', () => {
    expect(spendQuestion(shownLimits({}))).toBe(
      'May Tenjin pay for tool calls without asking you each time, up to $0.25 a call and $5 a day? Routing costs $0.003 a call, paid from channel deposits of up to $0.25 that stay yours until spent; each deposit counts against these limits. A yes also approves the routing fee.',
    );
  });

  it('accepts with one command, keeping the install scope', () => {
    expect(acceptCommand(false)).toBe('tenjin install --accept-defaults');
    expect(acceptCommand(true)).toBe('tenjin install --project --accept-defaults');
  });

  it('turns an unpaid routing call on unanswered limits into the question', () => {
    expect(unpaidNotice('limit_below_deposit', {})).toContain('`tenjin install --accept-defaults`');
    // A zero the user wrote is their answer: the plain reason and fix.
    expect(unpaidNotice('limit_below_deposit', { maxAutoSpend: '0' })).toContain(
      'the per-call spend limit is below the smallest routing deposit',
    );
    expect(unpaidNotice('channel_busy', {})).toBeNull();
  });
});

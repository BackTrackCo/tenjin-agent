import { describe, expect, it } from 'vitest';
import {
  ALWAYS_SAFE_ALLOWLIST,
  NEVER_ALLOWLISTED,
  OPT_IN_ALLOWLIST,
  recommendedPermissions,
  recommendedRules,
  renderPermissionsBlock,
} from './permissions';

/** Every verb that must never be pre-cleared, in the form it appears on a command line. */
const FORBIDDEN_VERBS = [
  'tenjin send',
  'tenjin publish',
  'tenjin wallet create',
  'tenjin config set',
  'tenjin candidate add',
  'tenjin candidate drop',
  'tenjin install',
  'tenjin mcp',
];

/** Does a Claude Code prefix rule `Bash(<prefix>:*)` cover `command`? */
function ruleCovers(rule: string, command: string): boolean {
  const m = /^Bash\((.+):\*\)$/.exec(rule);
  if (m === null || m[1] === undefined) return false;
  const prefix = m[1];
  return command === prefix || command.startsWith(`${prefix} `);
}

describe('recommended allowlist shape', () => {
  it('every recommended rule is a narrow Bash prefix rule on the tenjin binary', () => {
    for (const rule of recommendedRules()) {
      expect(rule).toMatch(/^Bash\(tenjin [a-z]+( [a-z]+)?:\*\)$/);
    }
  });

  it('each entry names the command its rule actually covers', () => {
    for (const e of [...ALWAYS_SAFE_ALLOWLIST, ...OPT_IN_ALLOWLIST]) {
      expect(ruleCovers(e.rule, e.command)).toBe(true);
      expect(e.note.length).toBeGreaterThan(0);
    }
  });

  it('recommends every free read-only verb the command surface exposes', () => {
    expect(ALWAYS_SAFE_ALLOWLIST.map((e) => e.command)).toEqual([
      'tenjin lookup',
      'tenjin inspect',
      'tenjin outcome',
      'tenjin doctor',
      'tenjin wallet show',
      'tenjin wallet balance',
      'tenjin config get',
      'tenjin candidate list',
    ]);
  });
});

describe('buy is opt-in, never always-safe', () => {
  it('is absent from the always-safe set', () => {
    for (const e of ALWAYS_SAFE_ALLOWLIST) {
      expect(ruleCovers(e.rule, 'tenjin buy')).toBe(false);
    }
  });

  it('is the opt-in entry, and its note carries the spend-cap warning', () => {
    expect(OPT_IN_ALLOWLIST.map((e) => e.rule)).toEqual(['Bash(tenjin buy:*)']);
    const note = OPT_IN_ALLOWLIST[0]?.note ?? '';
    expect(note).toContain('maxAutoSpend');
    expect(note).toContain('sessionBudget');
    // The load-bearing half: the harness line is not a spend grant.
    expect(note).toMatch(/never raises a spend cap/i);
  });
});

describe('money-moving and state-changing verbs are never recommended', () => {
  it.each(FORBIDDEN_VERBS)('no recommended rule covers %s', (command) => {
    for (const rule of recommendedRules()) {
      expect(ruleCovers(rule, command)).toBe(false);
    }
  });

  it('tenjin send heads the never-allowlisted list with its reason', () => {
    const send = NEVER_ALLOWLISTED[0];
    expect(send?.command).toBe('tenjin send');
    expect(send?.reason).toMatch(/wallet/i);
    expect(send?.reason).toMatch(/human decision/i);
  });

  it('every forbidden verb is documented as excluded, not merely omitted', () => {
    const documented = NEVER_ALLOWLISTED.map((e) => e.command).join(' | ');
    for (const command of FORBIDDEN_VERBS) {
      expect(documented).toContain(command);
    }
  });

  it('ships no broad rule that would swallow an excluded verb', () => {
    for (const rule of recommendedRules()) {
      expect(rule).not.toBe('Bash(tenjin:*)');
      expect(rule).not.toBe('Bash(tenjin wallet:*)');
      expect(rule).not.toBe('Bash(tenjin config:*)');
      expect(rule).not.toBe('Bash(tenjin candidate:*)');
    }
  });
});

describe('rendered block', () => {
  const lines = renderPermissionsBlock();
  const text = lines.join('\n');

  it('prints every recommended rule', () => {
    for (const rule of recommendedRules()) expect(text).toContain(rule);
  });

  it('prints every exclusion with its reason', () => {
    for (const e of NEVER_ALLOWLISTED) {
      expect(text).toContain(e.command);
      expect(text).toContain(e.reason);
    }
  });

  it('tells the operator where the lines go', () => {
    expect(text).toContain('.claude/settings.json');
  });
});

describe('machine shape', () => {
  it('is a defensive copy, so a caller cannot mutate the shipped constants', () => {
    const first = recommendedPermissions();
    const rule = first.alwaysSafe[0]?.rule;
    first.alwaysSafe.splice(0, first.alwaysSafe.length);
    expect(recommendedPermissions().alwaysSafe[0]?.rule).toBe(rule);
  });

  it('separates the three tiers', () => {
    const p = recommendedPermissions();
    expect(p.alwaysSafe.length).toBe(ALWAYS_SAFE_ALLOWLIST.length);
    expect(p.optIn.length).toBe(OPT_IN_ALLOWLIST.length);
    expect(p.neverAllowlisted.length).toBe(NEVER_ALLOWLISTED.length);
  });
});

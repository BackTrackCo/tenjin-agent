import { describe, expect, it } from 'vitest';
import {
  ALWAYS_SAFE_ALLOWLIST,
  FLAG_CAVEAT,
  MCP_CAVEAT,
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

  // "free (non-paying)", NOT "read-only": `search` and `outcome` both POST. The
  // disclosure tests further down assert the shipped block never says
  // "free, read-only verbs"; a test title in the same file may not say it either.
  it('recommends every free (non-paying) verb the command surface exposes', () => {
    expect(ALWAYS_SAFE_ALLOWLIST.map((e) => e.command)).toEqual([
      'tenjin search',
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

  // `--yes` is an ordinary flag on the same allowlisted verb and confirmSpend
  // returns true on it before any TTY check, so on CONFIG_DEFAULTS nothing
  // denies. The note must not let "never raises a spend cap" imply otherwise.
  it('says the line authorizes unattended spending, and never claims a human gate', () => {
    const note = OPT_IN_ALLOWLIST[0]?.note ?? '';
    expect(note).toMatch(/UNATTENDED purchases/);
    expect(note).toMatch(/`--yes`.*clears the\s*confirm gate/is);
    expect(note).toMatch(/sessionBudget 0 means NO ceiling/);
    expect(note).not.toMatch(/human (is still )?on every purchase/i);
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

describe('the flag surface inside an allowed verb', () => {
  // ruleCovers() above models a rule against a bare verb string. The
  // security-relevant question is what a rule matches against a whole COMMAND
  // LINE, and the answer is that a prefix rule constrains the verb and nothing
  // after it. Pin that as a known property instead of an unstated assumption.
  it('a recommended rule also matches the same verb carrying --base-url', () => {
    expect(
      ruleCovers('Bash(tenjin search:*)', 'tenjin search "q" --base-url https://elsewhere'),
    ).toBe(true);
    expect(
      ruleCovers('Bash(tenjin buy:*)', 'tenjin buy x --base-url https://elsewhere --yes'),
    ).toBe(true);
  });

  it('ships the flag caveat, because no rule syntax can express the restriction', () => {
    const flags = FLAG_CAVEAT.join(' ');
    expect(flags).toContain('--base-url');
    expect(flags).toMatch(/pins the VERB, not the flags/i);
    expect(flags).toMatch(/convention, not an enforced boundary/i);
  });

  it('ships the MCP caveat naming the tools to leave gated', () => {
    const mcp = MCP_CAVEAT.join(' ');
    expect(mcp).toContain('mcp__tenjin__tenjin_publish');
    expect(mcp).toContain('mcp__tenjin__tenjin_wallet');
    expect(mcp).toContain('mcp__tenjin__tenjin_candidate');
  });

  it('carries both caveats in the machine payload', () => {
    const p = recommendedPermissions();
    expect(p.caveats.flags).toEqual([...FLAG_CAVEAT]);
    expect(p.caveats.mcp).toEqual([...MCP_CAVEAT]);
  });
});

describe('claims made about the recommended set are true of the code', () => {
  // search and outcome both POST. Pre-clearing them is defensible; calling them
  // read-only in order to justify it is not.
  it('does not call the free set read-only', () => {
    const block = renderPermissionsBlock().join('\n');
    expect(block).not.toMatch(/free, read-only verbs/i);
    expect(block).toContain('Free: no wallet, no signing, no payment');
    expect(block).toMatch(/`search` and `outcome` POST/);
  });

  it('discloses the non-read-only half in the per-entry notes too', () => {
    const byCommand = new Map(ALWAYS_SAFE_ALLOWLIST.map((e) => [e.command, e.note]));
    expect(byCommand.get('tenjin search')).toMatch(/Not read-only/i);
    expect(byCommand.get('tenjin outcome')).toMatch(/Not read-only/i);
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

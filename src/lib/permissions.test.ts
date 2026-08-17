import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionStart } from '../commands/session';
import { CliError } from './errors';
import type { CommandContext } from '../context';
import {
  ALWAYS_SAFE_ALLOWLIST,
  FLAG_CAVEAT,
  MCP_CAVEAT,
  modeGatedAllowlist,
  modeGatedPointer,
  NEVER_ALLOWLISTED,
  OPT_IN_ALLOWLIST,
  PERMISSIONS_DOC_URL,
  permissionsPointer,
  PUBLISH_MODE_ALLOWLIST,
  recommendedPermissions,
  recommendedRules,
} from './permissions';

/** Every verb that must never be pre-cleared, in the form it appears on a command line. */
const FORBIDDEN_VERBS = [
  'tenjin send',
  'tenjin publish',
  'tenjin edit',
  'tenjin wallet create',
  'tenjin config set',
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
      'tenjin fund',
      'tenjin inspect',
      'tenjin read',
      'tenjin outcome',
      'tenjin doctor',
      'tenjin wallet show',
      'tenjin wallet balance',
      'tenjin config get',
    ]);
  });
});

describe('buy and session start are opt-in, never always-safe', () => {
  it('neither is covered by an always-safe rule', () => {
    for (const e of ALWAYS_SAFE_ALLOWLIST) {
      expect(ruleCovers(e.rule, 'tenjin buy')).toBe(false);
      expect(ruleCovers(e.rule, 'tenjin session start')).toBe(false);
    }
  });

  it('buy heads the opt-in tier, and its note carries the spend-cap warning', () => {
    expect(OPT_IN_ALLOWLIST.map((e) => e.rule)).toEqual([
      'Bash(tenjin buy:*)',
      'Bash(tenjin session start:*)',
    ]);
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

  // `session start` is the one opt-in that costs nothing and still is not safe:
  // it opens the keystore. Its note has to lead with that and must NOT borrow
  // buy's spend language, or an operator reads "opt-in" as "this can spend".
  it('session start discloses keystore access and denies the spend it cannot do', () => {
    const entry = OPT_IN_ALLOWLIST.find((e) => e.command === 'tenjin session start');
    expect(entry?.rule).toBe('Bash(tenjin session start:*)');
    const note = entry?.note ?? '';
    expect(note).toMatch(/OPENS THE KEYSTORE/);
    expect(note).toMatch(/SPENDS NOTHING/);
    // Why it cannot spend, stated as a property rather than a promise.
    expect(note).toMatch(/curve/i);
    // The flag interaction that is worse for this verb than for the others.
    expect(note).toContain('--base-url');
  });

  // The scope is NOT a containment boundary: it is enforced only on the request
  // shape that carries a session signature alongside the delegation, and the same
  // delegation replayed as a plain SIGN-IN-WITH-X takes a server path with no
  // scope logic on it. This note is the reason an operator pastes the rule, so it
  // must not offer a bound the code does not have. Pinned negatively — the honest
  // limits (expiry, 0600, origin) are what may be claimed.
  it('never sells the read scope as a bound on a leaked session file', () => {
    const note = OPT_IN_ALLOWLIST.find((e) => e.command === 'tenjin session start')?.note ?? '';
    expect(note).not.toMatch(/server refuses.*on any write/i);
    expect(note).not.toMatch(/insufficient_scope/i);
    expect(note).toMatch(/wallet-derived credential/i);
    expect(note).toMatch(/not its\s*scope/i);
    expect(note).toMatch(/24h/);
    expect(note).toMatch(/origin it was minted for/i);
  });
});

describe('money-moving and state-changing verbs are never recommended', () => {
  it.each(FORBIDDEN_VERBS)('no recommended rule covers %s', (command) => {
    for (const rule of recommendedRules()) {
      expect(ruleCovers(rule, command)).toBe(false);
    }
  });

  it('names tenjin edit as write-capable, since its no-flag form reads as a show', () => {
    const edit = NEVER_ALLOWLISTED.find((e) => e.command === 'tenjin edit');
    expect(edit?.reason).toMatch(/write-capable/i);
    expect(edit?.reason).toMatch(/prices/i);
    // The trap this entry exists for: `tenjin edit <id>` with no flags only reads,
    // so an operator sizing up the verb by its safest form allowlists a writer.
    expect(edit?.reason).toMatch(/no-flag form/i);
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
    }
  });
});

/**
 * The mode-gated tier is not a recommendation, which is why `publish` stays on
 * NEVER_ALLOWLISTED and out of `recommendedRules()`: nothing here offers the rule
 * to an operator weighing it. It appears only because a mode they already chose
 * means it.
 */
describe('the rule publish.mode carries', () => {
  it('is two narrow prefix rules, publish and its update-in-place twin', () => {
    expect(PUBLISH_MODE_ALLOWLIST.map((e) => e.rule)).toEqual([
      'Bash(tenjin publish:*)',
      'Bash(tenjin edit:*)',
    ]);
    for (const e of PUBLISH_MODE_ALLOWLIST) expect(ruleCovers(e.rule, e.command)).toBe(true);
  });

  // edit is the NARROWER of the pair, and the note has to say why it rides along:
  // owner-scoped, spends nothing, creates no new public content.
  it("edit's note earns its place beside publish", () => {
    const note = PUBLISH_MODE_ALLOWLIST.find((e) => e.command === 'tenjin edit')?.note ?? '';
    expect(note).toMatch(/ALREADY OWNS/);
    expect(note).toMatch(/spends nothing/i);
    expect(note).toMatch(/creates no new public content/i);
    expect(note).toMatch(/narrower blast radius|narrower/i);
  });

  it('is empty on review and present on both auto modes', () => {
    expect(modeGatedAllowlist('review')).toEqual([]);
    expect(modeGatedAllowlist('auto')).toHaveLength(2);
    expect(modeGatedAllowlist('full-auto')).toHaveLength(2);
  });

  // The load-bearing separation: it is never offered as advice, so every
  // existing claim about what this module RECOMMENDS still holds.
  it('is not in the recommended set, which still covers no forbidden verb', () => {
    for (const gated of ['Bash(tenjin publish:*)', 'Bash(tenjin edit:*)']) {
      expect(recommendedRules()).not.toContain(gated);
    }
    for (const rule of recommendedRules()) {
      expect(ruleCovers(rule, 'tenjin publish')).toBe(false);
      expect(ruleCovers(rule, 'tenjin edit')).toBe(false);
    }
  });

  it('both stay documented as excluded, with the mode named as the only thing that clears them', () => {
    for (const command of ['tenjin publish', 'tenjin edit']) {
      const entry = NEVER_ALLOWLISTED.find((e) => e.command === command);
      expect(entry?.reason, command).toMatch(/publish\.mode/);
      expect(entry?.reason, command).toMatch(/never pre-cleared/i);
    }
  });

  // An operator pastes a line off a tier list; this one they never see, so the
  // note has to say what the grant is and how to take it back.
  it('discloses what it clears and how it goes away', () => {
    const note = PUBLISH_MODE_ALLOWLIST[0]?.note ?? '';
    expect(note).toMatch(/PUBLISHES PUBLICLY/);
    expect(note).toMatch(/auto or full-auto/);
    expect(note).toMatch(/review/);
    // What still gates a publish, so "cleared" is not read as "unchecked".
    expect(note).toMatch(/scan/i);
  });

  it('is a defensive copy like the other tiers', () => {
    const first = modeGatedAllowlist('auto');
    first.splice(0, first.length);
    expect(modeGatedAllowlist('auto')).toHaveLength(2);
  });

  describe('the pointer doctor prints for it', () => {
    const both = ['Bash(tenjin publish:*)', 'Bash(tenjin edit:*)'];

    it('is null on review', () => {
      expect(modeGatedPointer('review', both)).toBeNull();
    });

    // The nag this used to be: it rendered from the mode alone, so a machine
    // that already carried both rules was still told to add them.
    it('is null when the machine is missing nothing', () => {
      expect(modeGatedPointer('auto', [])).toBeNull();
    });

    // Unlike permissionsPointer, this one NAMES its rules: the operator is
    // looking for the missing line, not for a page about tiers.
    it('names the mode and only the rules actually missing, in one line', () => {
      const line = modeGatedPointer('auto', both) ?? '';
      expect(line).toContain('publish.mode=auto');
      expect(line).toContain('Bash(tenjin publish:*)');
      expect(line).toContain('Bash(tenjin edit:*)');
      expect(line).toContain('tenjin install');
      expect(line).not.toContain('\n');

      const one = modeGatedPointer('auto', ['Bash(tenjin edit:*)']) ?? '';
      expect(one).toContain('Bash(tenjin edit:*)');
      expect(one).not.toContain('Bash(tenjin publish:*)');
    });

    // An env-set mode is invisible to `install`, which resolves from the global
    // file, so naming it as the remedy would send the reader at a no-op.
    it('takes the remedy from the caller, for a mode install cannot see', () => {
      const line = modeGatedPointer('full-auto', both, 'tenjin config set publish.mode full-auto');
      expect(line).toContain('tenjin config set publish.mode full-auto');
      expect(line).not.toMatch(/`tenjin install` writes/);
    });
  });

  describe('the machine payload', () => {
    it('defaults to review, so a caller that names no mode gets no extra rule', () => {
      expect(recommendedPermissions().modeGated).toEqual([]);
    });

    it('carries the rule when the mode does', () => {
      expect(recommendedPermissions('full-auto').modeGated.map((e) => e.rule)).toEqual([
        'Bash(tenjin publish:*)',
        'Bash(tenjin edit:*)',
      ]);
    });

    it('leaves the three recommendation tiers unchanged whatever the mode', () => {
      const review = recommendedPermissions('review');
      const auto = recommendedPermissions('auto');
      expect(auto.alwaysSafe).toEqual(review.alwaysSafe);
      expect(auto.optIn).toEqual(review.optIn);
      expect(auto.neverAllowlisted).toEqual(review.neverAllowlisted);
    });
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
    expect(mcp).toContain('mcp__tenjin__tenjin_edit');
    expect(mcp).toContain('mcp__tenjin__tenjin_wallet');
  });

  it('carries both caveats in the machine payload', () => {
    const p = recommendedPermissions();
    expect(p.caveats.flags).toEqual([...FLAG_CAVEAT]);
    expect(p.caveats.mcp).toEqual([...MCP_CAVEAT]);
  });
});

describe('claims made about the recommended set are true of the code', () => {
  // `read` is in the ALWAYS-SAFE tier and transmits a wallet-derived credential
  // once a session exists. An operator reading only the tier list would never
  // learn that, so the entry has to say it in as many words.
  it("read's note discloses that it transmits a credential off-machine", () => {
    const note = ALWAYS_SAFE_ALLOWLIST.find((e) => e.command === 'tenjin read')?.note ?? '';
    expect(note).toMatch(/TRANSMITS A CREDENTIAL/);
    expect(note).toMatch(/origin the delegation was minted for/i);
    // And it must not re-import the claim the opt-in note just dropped.
    expect(note).not.toMatch(/server refuses.*on any write/i);
  });

  // FLAG_CAVEAT used to scope signed traffic to `buy`, which was true only while
  // read carried no credential. An operator weighing `--base-url` against the
  // safe tier reads exactly this paragraph.
  it('the flag caveat names read, not only buy, as credential-bearing', () => {
    const flags = FLAG_CAVEAT.join(' ');
    expect(flags).toMatch(/session key `read` may present/i);
    expect(flags).toMatch(/NOT confined to the paying verb/i);
    expect(flags).toMatch(/bound to the origin it was minted for/i);
  });

  it('discloses the non-read-only half in the per-entry notes too', () => {
    const byCommand = new Map(ALWAYS_SAFE_ALLOWLIST.map((e) => [e.command, e.note]));
    expect(byCommand.get('tenjin search')).toMatch(/Not read-only/i);
    expect(byCommand.get('tenjin outcome')).toMatch(/Not read-only/i);
    // `read` writes locally rather than remotely — a different shape of
    // not-read-only, disclosed on the same terms rather than glossed over.
    expect(byCommand.get('tenjin read')).toMatch(/Not read-only/i);
  });

  // read presents a P-256 session key on a cold 402. An entry that still said
  // "no signing" would be the safe tier's own note contradicting the code.
  it("read's note states what it presents and why that is still not spending", () => {
    const note = ALWAYS_SAFE_ALLOWLIST.find((e) => e.command === 'tenjin read')?.note ?? '';
    expect(note).toMatch(/cannot spend and cannot open the keystore/i);
    expect(note).not.toMatch(/no signing/i);
    expect(note).toMatch(/session/i);
  });
});

describe('the human pointer that replaced the printed block', () => {
  const line = permissionsPointer();

  it('is one line, so it cannot grow back into an essay', () => {
    expect(line).not.toContain('\n');
  });

  it('carries the URL of the page the caveats live on', () => {
    expect(line).toContain(PERMISSIONS_DOC_URL);
    expect(PERMISSIONS_DOC_URL).toMatch(/docs\/agent-permissions\.md$/);
  });

  // The counts are what tell an operator whether the page answers their question.
  // Derived, so adding a rule cannot leave the line advertising the old number.
  it('counts the tiers from the constants rather than hardcoding them', () => {
    expect(line).toContain(`${ALWAYS_SAFE_ALLOWLIST.length} free verbs`);
    expect(line).toContain(`${OPT_IN_ALLOWLIST.length} opt-ins`);
  });

  // The whole point of the split: a rule an operator could paste out of the
  // terminal is a rule that never got read in context. Names none of them.
  it('pastes no rule and names no excluded verb', () => {
    for (const rule of recommendedRules()) expect(line).not.toContain(rule);
    for (const e of NEVER_ALLOWLISTED) expect(line).not.toContain(e.command);
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

/**
 * The claim `OPT_IN_ALLOWLIST` makes for `Bash(tenjin session start:*)` is that
 * the rule cannot grant more than a read-scoped session. A prefix rule pins the
 * verb and not the flags, so that holds for exactly one reason: the command
 * refuses every other `--scope`. `SessionScope` still admits `'read+write'`, so a
 * v2 that widened the verb would silently turn every already-pasted rule into a
 * write-capable grant — with the only enforcing test living in another file,
 * about another module. Co-locate it with the safety claim it backs.
 */
describe('the session-start rule is non-escalatable because the verb refuses to escalate', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function ctx(): Promise<CommandContext> {
    const dir = await mkdtemp(join(tmpdir(), 'tenjin-perm-scope-'));
    dirs.push(dir);
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    return {
      flags: { json: true, timeout: 5000, baseUrl: 'https://tenjin.blog' },
      dataDir: dir,
      io: { stdout: sink(), stderr: sink(), isTTY: false },
    };
  }

  /** A provider that fails the test if the command reaches the wallet at all. */
  const refuseWallet = {
    id: 'local' as const,
    describe: () => Promise.reject(new Error('the wallet must not be reached on a refused scope')),
    getSigner: () => Promise.reject(new Error('the wallet must not be reached on a refused scope')),
    diagnostics: () => Promise.resolve({ warnings: [] }),
  };

  it('the rule exists in the opt-in tier and covers the two-word verb', () => {
    const entry = OPT_IN_ALLOWLIST.find((e) => e.rule === 'Bash(tenjin session start:*)');
    expect(entry).toBeDefined();
    expect(ruleCovers('Bash(tenjin session start:*)', 'tenjin session start')).toBe(true);
    // The rule pins the verb only: this is the command line the refusal must stop.
    expect(
      ruleCovers('Bash(tenjin session start:*)', 'tenjin session start --scope read+write'),
    ).toBe(true);
  });

  it.each(['read+write', 'write', 'admin'])(
    'runSessionStart refuses --scope %s as USAGE, so the rule cannot mint it',
    async (scope) => {
      const err = await runSessionStart({ scope }, await ctx(), { provider: refuseWallet }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('USAGE');
    },
  );
});

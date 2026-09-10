import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { platform } from 'node:process';
import { join } from 'node:path';
import {
  codexRulesPath,
  grantedPrefixes,
  prefixRuleLine,
  prefixTokens,
  removeCodexGrant,
  rulesFileBody,
} from './codex-rules';
import {
  FREE_VERB_RULES,
  inspectHarnessPermissions,
  MODE_GATED_FORBIDDEN_FRAGMENTS,
  MODE_GATED_RULES,
  rulesForPublishMode,
  wireCodexGrant,
} from './harness-permissions';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-codex-rules-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const rulesPath = (): string => codexRulesPath(home, {});

describe('prefixTokens: the translation that cannot widen a grant', () => {
  it('turns a verb rule into the tokens Codex matches', () => {
    expect(prefixTokens('Bash(tenjin search:*)')).toEqual(['tenjin', 'search']);
    expect(prefixTokens('Bash(tenjin wallet show:*)')).toEqual(['tenjin', 'wallet', 'show']);
  });

  /**
   * The one that matters. `Bash(tenjin:*)` is the blanket rule
   * FORBIDDEN_VERB_FRAGMENTS exists to keep out of the Claude tier, and in
   * Codex's grammar `["tenjin"]` would clear every subcommand there is —
   * `buy`, `wallet send`, `delete`, all of it. It has to be untranslatable
   * rather than merely absent from a list (tenjin-agent#342).
   */
  it('refuses the blanket rule outright rather than emitting a one-token prefix', () => {
    expect(prefixTokens('Bash(tenjin:*)')).toBeNull();
    expect(prefixTokens('Bash(tenjin :*)')).toBeNull();
    expect(prefixTokens('Bash(tenjin*)')).toBeNull();
  });

  it('refuses anything that is not this exact shape', () => {
    for (const rule of [
      'Bash(git status:*)',
      'Bash(tenjin search)',
      'Read(~/.ssh/*)',
      'Bash(tenjin search:*) # comment',
      '',
    ]) {
      expect(prefixTokens(rule), rule).toBeNull();
    }
  });

  it('quotes every token, so no rule can be smuggled through a token', () => {
    expect(prefixRuleLine(['tenjin', 'sea"rch'])).toBe(
      'prefix_rule(pattern=["tenjin", "sea\\"rch"], decision="allow")',
    );
  });
});

describe('rulesFileBody: what a mode actually grants Codex', () => {
  it('carries every free verb and nothing else on review', () => {
    const body = rulesFileBody(rulesForPublishMode('review'));
    for (const rule of FREE_VERB_RULES) {
      expect(body).toContain(prefixRuleLine(prefixTokens(rule) ?? []));
    }
    expect(body).not.toContain('"publish"');
    expect(body).not.toContain('"edit"');
  });

  it('adds the mode-gated pair on auto and full-auto, and only those two', () => {
    for (const mode of ['auto', 'full-auto'] as const) {
      const body = rulesFileBody(rulesForPublishMode(mode));
      expect(body).toContain('prefix_rule(pattern=["tenjin", "publish"], decision="allow")');
      expect(body).toContain('prefix_rule(pattern=["tenjin", "edit"], decision="allow")');
      expect(grantedPrefixes(rulesForPublishMode(mode))).toHaveLength(
        FREE_VERB_RULES.length + MODE_GATED_RULES.length,
      );
    }
  });

  /**
   * The standing invariant, asserted against the GENERATED FILE rather than
   * against the constant it came from: a widened tier upstream must show up
   * here as a red build, not as a broader grant on every Codex machine.
   */
  it('never grants a spending, destructive or self-escalating verb, in any mode', () => {
    for (const mode of ['review', 'auto', 'full-auto'] as const) {
      const body = rulesFileBody(rulesForPublishMode(mode));
      for (const fragment of MODE_GATED_FORBIDDEN_FRAGMENTS) {
        const tokens = fragment.split(' ').slice(1);
        expect(body, `${mode} / ${fragment}`).not.toContain(tokens.map((t) => `"${t}"`).join(', '));
      }
      // And nothing may be granted with a decision other than `allow`: a
      // `forbidden` line we wrote would be us tightening someone else's
      // machine, which is not ours to do either.
      for (const line of body.split('\n').filter((l) => l.startsWith('prefix_rule'))) {
        expect(line).toContain('decision="allow"');
      }
      // Never a bare one-token prefix, whatever the tier upstream contains.
      expect(body).not.toContain('pattern=["tenjin"]');
    }
  });
});

describe('wireCodexGrant: install, retract, and leave the operator’s own file alone', () => {
  it('creates the rules directory and file, 0600, and reports the prefixes', async () => {
    const result = await wireCodexGrant(home, 'auto', {});
    expect(result.error).toBeUndefined();
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(rulesPath());
    expect(result.granted).toContain('tenjin publish');
    expect(await readFile(rulesPath(), 'utf8')).toBe(rulesFileBody(rulesForPublishMode('auto')));
    if (platform !== 'win32') {
      expect((await stat(rulesPath())).mode & 0o777).toBe(0o600);
    }
  });

  it('is idempotent: a second run at the same mode writes nothing at all', async () => {
    await wireCodexGrant(home, 'auto', {});
    const before = await readFile(rulesPath(), 'utf8');
    const second = await wireCodexGrant(home, 'auto', {});
    expect(second.wrote).toBe(false);
    expect(await readFile(rulesPath(), 'utf8')).toBe(before);
  });

  /**
   * Acceptance 3: going back to `review` takes the Tenjin-owned grant away.
   * Not a separate remove path — the file is regenerated from the mode, so the
   * narrower file IS the retraction and nothing can forget to call it.
   */
  it('retracts publish and edit when the mode goes back to review', async () => {
    await wireCodexGrant(home, 'auto', {});
    expect(await readFile(rulesPath(), 'utf8')).toContain('"publish"');

    const back = await wireCodexGrant(home, 'review', {});
    expect(back.wrote).toBe(true);
    expect(back.granted).not.toContain('tenjin publish');
    expect(back.granted).not.toContain('tenjin edit');
    const body = await readFile(rulesPath(), 'utf8');
    expect(body).not.toContain('"publish"');
    expect(body).not.toContain('"edit"');
    // The free tier survives the retraction: `review` still means the agent
    // may search and read without a prompt.
    expect(body).toContain('"search"');
  });

  /**
   * `default.rules` is Codex's own file: it is where the harness appends what
   * a person chose in an approval prompt. Ours is a separate file so that
   * neither writer can lose the other's lines.
   */
  it('never reads or writes the operator’s own default.rules', async () => {
    const theirs = join(home, '.codex', 'rules', 'default.rules');
    await mkdir(join(home, '.codex', 'rules'), { recursive: true });
    await writeFile(theirs, 'prefix_rule(pattern=["make", "test"], decision="allow")\n');

    await wireCodexGrant(home, 'auto', {});
    await wireCodexGrant(home, 'review', {});
    await removeCodexGrant(home, {});

    expect(await readFile(theirs, 'utf8')).toBe(
      'prefix_rule(pattern=["make", "test"], decision="allow")\n',
    );
  });

  it('honours CODEX_HOME, so a relocated Codex is granted where it actually reads', async () => {
    const elsewhere = join(home, 'other-codex');
    const result = await wireCodexGrant(home, 'review', { CODEX_HOME: elsewhere });
    expect(result.path).toBe(join(elsewhere, 'rules', 'tenjin.rules'));
    expect(existsSync(result.path)).toBe(true);
  });

  it('reports a write it could not make instead of throwing', async () => {
    // A regular file where the rules DIRECTORY has to go: mkdir fails, and an
    // install must report that rather than die after wiring everything else.
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'rules'), 'not a directory');
    const result = await wireCodexGrant(home, 'auto', {});
    expect(result.error).toBeDefined();
    expect(result.wrote).toBe(false);
    expect(result.granted).toEqual([]);
  });
});

describe('removeCodexGrant: uninstall reclaims the whole grant', () => {
  it('deletes the file, free tier included', async () => {
    await wireCodexGrant(home, 'auto', {});
    const removed = await removeCodexGrant(home, {});
    expect(removed.removed).toBe(true);
    expect(existsSync(rulesPath())).toBe(false);
  });

  it('says so quietly when there was nothing of ours to remove', async () => {
    expect((await removeCodexGrant(home, {})).removed).toBe(false);
  });

  it('refuses to delete a directory parked at that name', async () => {
    await mkdir(rulesPath(), { recursive: true });
    expect((await removeCodexGrant(home, {})).removed).toBe(false);
    expect(existsSync(rulesPath())).toBe(true);
  });
});

describe("the grant state is Codex's answer, not our own", () => {
  /**
   * A `.rules` file that matches the mode is not the same fact as a grant in
   * force. On a Codex too old for the rules layer, or with no `codex` on PATH,
   * the file is inert — and reporting `granted` over it would be exactly the
   * overclaim this issue is about, one harness over (tenjin-agent#342).
   */
  it('is unknown, not granted, when codex cannot be asked to confirm', async () => {
    await wireCodexGrant(home, 'auto', {});
    // No `codex` on this PATH, so `execpolicy check` cannot answer.
    const state = await inspectHarnessPermissions('codex', home, 'auto', { PATH: '/nonexistent' });
    expect(state.state).toBe('unknown');
    expect(state.detail).toMatch(/could not be asked/);
    expect(state.rules.length).toBeGreaterThan(0);
  });

  it('is pending when no grant is installed at all', async () => {
    const state = await inspectHarnessPermissions('codex', home, 'auto', { PATH: '/nonexistent' });
    expect(state.state).toBe('pending');
    expect(state.fix).toBe('tenjin install');
  });
});

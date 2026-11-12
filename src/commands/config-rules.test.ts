import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors';
import type { CommandContext, CommandResult } from '../context';
import {
  runConfigBlock,
  runConfigOnly,
  runConfigPrefer,
  runConfigReplacement,
  runConfigReset,
  runConfigSpeed,
  runConfigUnblock,
} from './config-rules';
import { runConfigList, runConfigSet } from './config';
import { personalSettingsAt } from '../router/settings';

/**
 * `tenjin config prefer|only|block|unblock|reset|speed|replacement` (plan 36):
 * names resolve against the router's free identities read before anything is
 * written, an unclear or unknown name writes nothing, every write answers
 * with the readback envelope, and removing a rule works offline.
 */

const IDENTITIES = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../router/fixtures/wire-identities.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown> & {
  sources: { id: string; label: string }[];
  providers: { id: string; label: string }[];
};
/** The fixture, with an account the user connected and a look-alike provider. */
const WITH_FAL = {
  ...IDENTITIES,
  sources: [...IDENTITIES.sources, { id: 'fal', label: 'fal' }],
  providers: [...IDENTITIES.providers, { id: 'exa-labs', label: 'Exa Labs' }],
};

let dir: string;
let fetched: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'config-rules-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
  fetched = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: 'https://tenjin.sh' },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const online = (identities: unknown = WITH_FAL) => ({
  cwd: dir,
  fetchImpl: (async (_input: unknown, init?: RequestInit) => {
    fetched += 1;
    expect(JSON.parse(String(init?.body))).toMatchObject({ identities: true });
    return new Response(JSON.stringify(identities), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch,
});
const offline = {
  cwd: dir,
  fetchImpl: (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch,
};

async function saved(): Promise<Record<string, unknown>> {
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as {
    router?: Record<string, unknown>;
  };
  return config.router ?? {};
}

const data = (result: CommandResult) => result.data as Record<string, unknown>;

async function refused(run: Promise<unknown>): Promise<CliError> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliError);
  return err as CliError;
}

describe('tenjin config prefer', () => {
  it('saves a task preference by a name typed in any case, and reads it back', async () => {
    const result = await runConfigPrefer(
      { task: ['Web Research'], provider: ['EXA'] },
      ctx(),
      online(),
    );
    const rule = {
      scope: { kind: 'task', id: 'web research' },
      targets: [{ kind: 'provider', id: 'exa' }],
    };
    expect((await saved()).policy).toEqual({ version: 1, prefer: [rule] });
    expect(data(result)).toMatchObject({
      operation: 'prefer',
      changed: true,
      saved: 'Saved on this machine; not synced.',
      scope: 'user',
      rule,
      reset: 'tenjin config reset --task "web research" --preference',
    });
    expect(data(result).explanation).toContain(
      'Prefer Exa when Tenjin handles Web research. Other allowed services remain available',
    );
    expect(data(result).explanation).toContain("Run Tenjin's picks automatically is off");
    expect(String(data(result).explanation)).not.toMatch(/x402|USDC|wallet|Jev/);
  });

  it('saves "use my fal account for images" as a category preference that leaves the rest alone', async () => {
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, ctx(), online());
    const result = await runConfigPrefer(
      { category: ['images'], source: ['fal'] },
      ctx(),
      online(),
    );
    expect(((await saved()).policy as { prefer: unknown[] }).prefer).toEqual([
      { scope: { kind: 'task', id: 'web research' }, targets: [{ kind: 'provider', id: 'exa' }] },
      { scope: { kind: 'category', id: 'images' }, targets: [{ kind: 'source', id: 'fal' }] },
    ]);
    expect(data(result).explanation).toContain(
      'Images jobs use your fal account first, and that plan pays. Everything else is unchanged.',
    );
  });

  it('replaces the list at its scope when repeated', async () => {
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, ctx(), online());
    const result = await runConfigPrefer(
      { task: ['web research'], service: ['exa-search', 'stableenrich-exa-answer'] },
      ctx(),
      online(),
    );
    expect(((await saved()).policy as { prefer: unknown[] }).prefer).toEqual([
      {
        scope: { kind: 'task', id: 'web research' },
        targets: [
          { kind: 'service', id: 'exa-search' },
          { kind: 'service', id: 'stableenrich-exa-answer' },
        ],
      },
    ]);
    expect(data(result).removed).toHaveLength(1);
  });

  it('writes nothing for an ambiguous or unknown name, and lists candidates', async () => {
    const before = await readFile(join(dir, 'config.json'), 'utf8');
    const ambiguous = await refused(
      runConfigPrefer(
        { task: ['web research'], provider: ['exa labs '] },
        ctx(),
        online({
          ...WITH_FAL,
          providers: [...WITH_FAL.providers, { id: 'exalabs', label: 'exa labs' }],
        }),
      ),
    );
    expect(ambiguous.code).toBe('USAGE');
    expect(ambiguous.message).toContain('matches more than one provider');
    const unknown = await refused(
      runConfigPrefer({ task: ['web research'], provider: ['ex'] }, ctx(), online()),
    );
    expect(unknown.message).toContain('Tenjin has no provider named "ex"');
    expect(unknown.fix).toContain('Exa');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(before);
  });

  it('refuses a preference for what a block already rules out', async () => {
    await runConfigBlock({ provider: ['exa'] }, ctx(), online());
    const err = await refused(
      runConfigPrefer({ task: ['web research'], service: ['exa-search'] }, ctx(), online()),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('Exa search is covered by your block on Exa');
    expect(err.fix).toContain('tenjin config unblock --provider exa');
    expect((await saved()).policy).toEqual({
      version: 1,
      block: [{ kind: 'provider', id: 'exa' }],
    });
  });

  it('takes an every-task preference for accounts only', async () => {
    const err = await refused(runConfigPrefer({ provider: ['exa'] }, ctx(), online()));
    expect(err.code).toBe('USAGE');
    const result = await runConfigPrefer({ source: ['fal'] }, ctx(), online());
    expect(data(result).rule).toEqual({
      scope: { kind: 'global' },
      targets: [{ kind: 'source', id: 'fal' }],
    });
  });

  it('saves nothing and says so when the names cannot be looked up', async () => {
    const err = await refused(
      runConfigPrefer({ task: ['web research'], provider: ['exa'] }, ctx(), offline),
    );
    expect(err.message).toContain("couldn't look up those names right now, so nothing was saved");
    expect((await saved()).policy).toBeUndefined();
  });
});

describe('tenjin config only', () => {
  it('limits which tasks Tenjin does anywhere, and names what that covers', async () => {
    const result = await runConfigOnly({ global: true, category: ['Images'] }, ctx(), online());
    expect((await saved()).policy).toEqual({
      version: 1,
      only: [
        {
          scope: { kind: 'global' },
          dimension: 'capability',
          targets: [{ kind: 'category', id: 'images' }],
        },
      ],
    });
    expect(data(result).explanation).toContain(
      'Tenjin may handle Images only, including newly added reviewed services there. That covers General image and Image edit.',
    );
    expect(data(result).reset).toBe('tenjin config reset --global --capabilities');
  });

  it('limits who does one task, and leaves the others alone', async () => {
    const result = await runConfigOnly(
      { task: ['web research'], provider: ['exa'] },
      ctx(),
      online(),
    );
    expect(data(result).explanation).toContain(
      'When Tenjin handles Web research, it can use only Exa.',
    );
    expect(data(result).explanation).toContain('Other tasks are unaffected.');
  });

  it('has no only for accounts: that is a preference', async () => {
    const err = await refused(runConfigOnly({ global: true, source: ['fal'] }, ctx(), online()));
    expect(err.message).toContain('prefer --category');
    expect(fetched).toBe(0);
  });
});

describe('tenjin config block and unblock', () => {
  it("warns that blocking Tenjin's own tools stops the free ones too", async () => {
    const result = await runConfigBlock({ source: ['tenjin'] }, ctx(), online());
    expect((await saved()).policy).toEqual({
      version: 1,
      block: [{ kind: 'source', id: 'tenjin' }],
    });
    const said = String(data(result).explanation);
    expect(said).toContain("Tenjin's own tools are off, including free ones like the docs lookup");
    expect(said).toContain('Tenjin still picks among your connected accounts');
    expect(said).toContain("goes back to your agent's own tools");
    expect(data(result).reset).toBe('tenjin config unblock --source tenjin');
  });

  it('always lands, and marks a preference it made unusable inactive, keeping it', async () => {
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, ctx(), online());
    const result = await runConfigBlock({ provider: ['exa'] }, ctx(), online());
    const policy = (await saved()).policy as { prefer: unknown[]; block: unknown[] };
    expect(policy.prefer).toHaveLength(1);
    expect(policy.block).toEqual([{ kind: 'provider', id: 'exa' }]);
    const said = String(data(result).explanation);
    expect(said).toContain(
      'Exa is blocked, including reviewed reseller routes identified as using it. That covers Exa search, Exa Answer, and Exa contents.',
    );
    expect(said).toContain('This leaves a saved rule unusable, kept as it is');
    expect(said).toContain('inactive: Exa is blocked');
  });

  it('unblocks by name with no network, and removes nothing else', async () => {
    await runConfigBlock({ provider: ['exa'], task: ['crypto price quote'] }, ctx(), online());
    const result = await runConfigUnblock({ provider: ['Exa'] }, ctx(), offline);
    expect((await saved()).policy).toEqual({
      version: 1,
      block: [{ kind: 'task', id: 'crypto price quote' }],
    });
    expect(data(result)).toMatchObject({
      changed: true,
      reset: 'tenjin config block --provider exa',
    });
    const none = await runConfigUnblock({ provider: ['tavily'] }, ctx(), offline);
    expect(data(none).changed).toBe(false);
    expect(data(none).explanation).toContain('Nothing saved blocks a provider named "tavily"');
  });
});

describe('tenjin config reset', () => {
  beforeEach(async () => {
    await runConfigOnly({ global: true, category: ['images'] }, ctx(), online());
    await runConfigOnly({ task: ['web research'], provider: ['exa'] }, ctx(), online());
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, ctx(), online());
    await runConfigPrefer({ source: ['fal'] }, ctx(), online());
    await runConfigBlock({ task: ['crypto price quote'] }, ctx(), online());
  });

  it('removes one preference offline and keeps every other rule', async () => {
    const result = await runConfigReset(
      { task: ['Web research'], preference: true },
      ctx(),
      offline,
    );
    const policy = (await saved()).policy as Record<string, unknown[]>;
    expect(policy.prefer).toEqual([
      { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'fal' }] },
    ]);
    expect(policy.only).toHaveLength(2);
    expect(policy.block).toHaveLength(1);
    expect(data(result).reset).toBe('tenjin config prefer --task "web research" --provider exa');
  });

  it('removes one account from the account-wide preference, and the entry once empty', async () => {
    await runConfigReset({ source: ['fal'], preference: true }, ctx(), offline);
    const policy = (await saved()).policy as Record<string, unknown[]>;
    expect(policy.prefer).toEqual([
      { scope: { kind: 'task', id: 'web research' }, targets: [{ kind: 'provider', id: 'exa' }] },
    ]);
  });

  it('removes only the named dimension of a restriction, and the capability limit apart', async () => {
    await runConfigReset(
      { task: ['web research'], restriction: true, dimension: 'provider' },
      ctx(),
      offline,
    );
    let policy = (await saved()).policy as { only: { dimension: string }[] };
    expect(policy.only.map(({ dimension }) => dimension)).toEqual(['capability']);
    await runConfigReset({ global: true, capabilities: true }, ctx(), offline);
    policy = (await saved()).policy as { only: { dimension: string }[] };
    expect(policy.only).toBeUndefined();
    expect((await saved()).policy).toMatchObject({
      block: [{ kind: 'task', id: 'crypto price quote' }],
    });
  });

  it('clears rules this build cannot read with --all, and only those', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        maxAutoSpend: '250000',
        router: { policy: { version: 7 }, nativeReplacement: 'when-routed' },
      }),
    );
    const err = await refused(runConfigBlock({ provider: ['exa'] }, ctx(), online()));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.fix).toContain('tenjin config reset --all');
    await runConfigReset({ all: true }, ctx(), offline);
    expect(await saved()).toEqual({ nativeReplacement: 'when-routed' });
  });
});

describe('tenjin config speed and replacement', () => {
  it('turns speed on and off with no network, and the rules sent change with it', async () => {
    const hash = async () => {
      const { wire } = await personalSettingsAt(dir);
      return wire.status === 'ok' ? wire.settings : undefined;
    };
    const before = await hash();
    const on = await runConfigSpeed({ state: 'on' }, ctx(), offline);
    expect((await saved()).policy).toEqual({ version: 1, preferSpeed: true });
    expect(data(on).explanation).toContain('They cost more, and your limits still apply.');
    expect((await hash())?.policy).toEqual({ preferSpeed: true });
    expect((await hash())?.hash).not.toBe(before?.hash);
    await runConfigSpeed({ state: 'off' }, ctx(), offline);
    expect((await saved()).policy).toBeUndefined();
    expect((await hash())?.hash).toBe(before?.hash);
  });

  it('writes the mode and its provider scope in one write, and widens by removing the scope', async () => {
    const narrow = await runConfigReplacement({ state: 'on', provider: ['Exa'] }, ctx(), online());
    expect(await saved()).toEqual({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
    });
    expect(data(narrow)).toMatchObject({
      scope: 'machine',
      reset: 'tenjin config replacement off',
    });
    expect(String(data(narrow).explanation)).toContain(
      "Run Tenjin's picks automatically is on, only when Tenjin picks Exa.",
    );
    expect(String(data(narrow).explanation)).toContain('$0.25 a call');
    const off = await runConfigReplacement({ state: 'off' }, ctx(), offline);
    expect(await saved()).toEqual({
      nativeReplacement: 'off',
      nativeReplacementProviders: [{ kind: 'provider', id: 'exa' }],
    });
    expect(data(off).reset).toBe('tenjin config replacement on --provider exa');
    await runConfigReplacement({ state: 'on', allProviders: true }, ctx(), offline);
    expect(await saved()).toEqual({ nativeReplacement: 'when-routed' });
  });

  it('needs a provider scope or --all-providers to turn on', async () => {
    const err = await refused(runConfigReplacement({ state: 'on' }, ctx(), online()));
    expect(err.code).toBe('USAGE');
    expect(await saved()).toEqual({});
  });

  it('keeps the coupled keys out of reach of config set', async () => {
    for (const key of [
      'router.policy',
      'router.nativeReplacement',
      'router.nativeReplacementProviders',
    ]) {
      const err = await refused(runConfigSet({ key, value: 'off' }, ctx()));
      expect(err.message).toContain('changes only through its own operations');
    }
  });
});

describe('tenjin config, shown', () => {
  it('lists saved rules in plain words, with ids only in the JSON, offline', async () => {
    await runConfigPrefer({ task: ['web research'], provider: ['exa'] }, ctx(), online());
    await runConfigBlock({ source: ['tenjin'] }, ctx(), online());
    const shown = await runConfigList(ctx());
    const all = shown.humanLines ?? [];
    // The readback, with the commands that undo each rule left out.
    const lines = all
      .slice(all.indexOf('Your settings (saved on this machine, not synced):'))
      .join('\n')
      .replace(/`[^`]*`/g, '');
    expect(lines).toContain('Prefer Exa when Tenjin handles Web research.');
    expect(lines).toContain("Tenjin's own tools are off");
    expect(lines).not.toMatch(/\bsource\b|x402|USDC|wallet|Jev|sha256/);
    const settings = (
      shown.data as { settings: { rules: { rule: unknown }[]; settingsHash: string } }
    ).settings;
    expect(settings.rules.map(({ rule }) => rule)).toContainEqual({ kind: 'source', id: 'tenjin' });
    expect(settings.settingsHash).toMatch(/^sha256:/);
  });
});

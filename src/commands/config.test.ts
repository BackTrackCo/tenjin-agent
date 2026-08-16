import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigList, runConfigGet, runConfigSet, persistPublishMode } from './config';
import { RawConfigSchema } from '../lib/config';
import { CliError } from '../lib/errors';
import { claudeSettingsPath, FREE_VERB_RULES, PUBLISH_MODE_RULE } from '../lib/harness-permissions';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-cfg-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 10000, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const configFile = () => join(dir, 'config.json');

/**
 * A throwaway home for any `config set publish.mode`, which now syncs the harness
 * allowlist: without one the sync would reach the operator's real
 * ~/.claude/settings.json from a unit test.
 */
async function hermeticHome(): Promise<{
  homeDir: string;
  isInteractive: boolean;
  harnessIsClaude: boolean;
}> {
  return {
    homeDir: await mkdtemp(join(tmpdir(), 'tenjin-cfg-h-')),
    isInteractive: false,
    // PINNED, like every other harness-touching test here: without it these read
    // whichever harness the RUNNER has, so they pass on a laptop with Claude Code
    // installed and take a different branch on a bare CI box.
    harnessIsClaude: false,
  };
}
const readRawFile = async () => JSON.parse(await readFile(configFile(), 'utf8')) as unknown;

async function caught<T>(fn: () => Promise<T>): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

describe('runConfigList', () => {
  it('reports every key with default provenance on a fresh dir', async () => {
    const { data, humanLines } = await runConfigList(makeCtx());
    const d = data as Record<string, { value: unknown; source: string }>;
    expect(d.maxAutoSpend).toEqual({ value: { atomic: '0', usd: '0' }, source: 'default' });
    expect(d.sessionBudget).toEqual({ value: { atomic: '0', usd: '0' }, source: 'default' });
    expect(d.confirm).toEqual({ value: 'always', source: 'default' });
    expect(d.allowlistCreators).toEqual({ value: [], source: 'default' });
    expect(d.baseUrl).toEqual({ value: 'https://tenjin.blog', source: 'default' });
    expect(d.rpcUrl).toEqual({ value: 'https://mainnet.base.org', source: 'default' });
    expect(d.evalCohort).toEqual({ value: false, source: 'default' });
    // No numeric or 'none' default: absent resolves to the 'unset' sentinel and
    // `tenjin send` refuses until the cap is set (require-set-before-first-send).
    expect(d.sendMaxAmount).toEqual({ value: 'unset', source: 'default' });
    expect(d['publish.mode']).toEqual({ value: 'review', source: 'default' });
    expect(d['publish.defaultPrice']).toEqual({
      value: { atomic: '100000', usd: '0.1' },
      source: 'default',
    });
    expect(d['hooks.searchMode']).toEqual({ value: 'auto', source: 'default' });
    expect(d['hooks.stopNag']).toEqual({ value: 'on', source: 'default' });
    expect(d['update.mode']).toEqual({ value: 'nudge', source: 'default' });
    expect(humanLines).toHaveLength(13);
  });

  it('sendMaxAmount round-trips: unset until set, decimal USD in, Money out, 0 and none valid', async () => {
    const ctx = makeCtx();
    const fresh = await runConfigGet({ key: 'sendMaxAmount' }, ctx);
    expect(fresh.data).toMatchObject({ value: 'unset', source: 'default' });
    // The sentinel is a resolved view, never a settable/persistable value.
    const sentinel = await caught(() =>
      runConfigSet({ key: 'sendMaxAmount', value: 'unset' }, ctx),
    );
    expect(sentinel.code).toBe('USAGE');
    const set = await runConfigSet({ key: 'sendMaxAmount', value: '20' }, ctx);
    expect(set.data).toMatchObject({
      key: 'sendMaxAmount',
      value: { atomic: '20000000', usd: '20' },
      source: 'file',
    });
    const zero = await runConfigSet({ key: 'sendMaxAmount', value: '0' }, ctx);
    expect(zero.data).toMatchObject({ value: { atomic: '0', usd: '0' } });
    const cleared = await runConfigSet({ key: 'sendMaxAmount', value: 'none' }, ctx);
    expect(cleared.data).toMatchObject({ value: 'none' });
    const bad = await caught(() => runConfigSet({ key: 'sendMaxAmount', value: 'lots' }, ctx));
    expect(bad.code).toBe('USAGE');
  });

  it('appends a one-line description per key to the human listing (data unchanged)', async () => {
    const { data, humanLines } = await runConfigList(makeCtx());
    const text = (humanLines ?? []).join('\n');
    expect(text).toContain('when to ask before paying'); // confirm
    expect(text).toContain('review=always ask, auto=ask on findings, full-auto=only hard blocks');
    expect(text).toContain('price used when none is given'); // publish.defaultPrice
    // The machine shape carries no description field.
    const d = data as Record<string, Record<string, unknown>>;
    expect(Object.keys(d.confirm ?? {}).sort()).toEqual(['source', 'value']);
  });

  it('exposes the confirm threshold in dual form when above:', async () => {
    await runConfigSet({ key: 'confirm', value: 'above:0.25' }, makeCtx());
    const { data } = await runConfigList(makeCtx());
    const d = data as Record<string, { value: unknown; source: string; threshold?: unknown }>;
    expect(d.confirm).toEqual({
      value: 'above:250000',
      source: 'file',
      threshold: { atomic: '250000', usd: '0.25' },
    });
  });

  it('persistPublishMode preserves pre-existing sibling keys', async () => {
    // Seed a config with unrelated scalars and a sibling publish subkey, then set
    // only publish.mode: the locked merge-write must not clobber any of them.
    await writeFile(
      configFile(),
      JSON.stringify({
        baseUrl: 'https://seeded.example',
        maxAutoSpend: '500000',
        publish: { defaultPrice: '250000' },
      }),
    );
    await persistPublishMode(dir, 'review');
    expect(await readRawFile()).toEqual({
      baseUrl: 'https://seeded.example',
      maxAutoSpend: '500000',
      publish: { defaultPrice: '250000', mode: 'review' },
    });
  });

  it('preserves an unknown key (e.g. a newer CLI block) through set', async () => {
    // An older binary must not strip a config block a newer CLI wrote (e.g. B3's
    // publish.*): set a known key and assert the unknown one still round-trips.
    await writeFile(configFile(), JSON.stringify({ publish: { visibility: 'unlisted' } }));
    await runConfigSet({ key: 'confirm', value: 'always' }, makeCtx());
    const raw = (await readRawFile()) as Record<string, unknown>;
    expect(raw.publish).toEqual({ visibility: 'unlisted' });
    expect(raw.confirm).toBe('always');
  });

  describe('baseUrl precedence', () => {
    it('reads file provenance', async () => {
      await writeFile(configFile(), JSON.stringify({ baseUrl: 'https://file.example' }));
      const { data } = await runConfigList(makeCtx());
      const d = data as Record<string, { value: unknown; source: string }>;
      expect(d.baseUrl).toEqual({ value: 'https://file.example', source: 'file' });
    });

    it('env beats file', async () => {
      await writeFile(configFile(), JSON.stringify({ baseUrl: 'https://file.example' }));
      const prev = process.env.TENJIN_BASE_URL;
      process.env.TENJIN_BASE_URL = 'https://env.example';
      try {
        const { data } = await runConfigList(makeCtx());
        const d = data as Record<string, { value: unknown; source: string }>;
        expect(d.baseUrl).toEqual({ value: 'https://env.example', source: 'env' });
      } finally {
        if (prev === undefined) delete process.env.TENJIN_BASE_URL;
        else process.env.TENJIN_BASE_URL = prev;
      }
    });

    it('flag beats env and file', async () => {
      await writeFile(configFile(), JSON.stringify({ baseUrl: 'https://file.example' }));
      const prev = process.env.TENJIN_BASE_URL;
      process.env.TENJIN_BASE_URL = 'https://env.example';
      try {
        const { data } = await runConfigList(makeCtx({ baseUrl: 'https://flag.example' }));
        const d = data as Record<string, { value: unknown; source: string }>;
        expect(d.baseUrl).toEqual({ value: 'https://flag.example', source: 'flag' });
      } finally {
        if (prev === undefined) delete process.env.TENJIN_BASE_URL;
        else process.env.TENJIN_BASE_URL = prev;
      }
    });
  });
});

describe('runConfigGet', () => {
  it('returns the single-key shape for a money key', async () => {
    await runConfigSet({ key: 'maxAutoSpend', value: '0.25' }, makeCtx());
    const { data, humanLines } = await runConfigGet({ key: 'maxAutoSpend' }, makeCtx());
    expect(data).toEqual({
      key: 'maxAutoSpend',
      value: { atomic: '250000', usd: '0.25' },
      source: 'file',
    });
    expect(humanLines).toHaveLength(1);
  });

  it('returns default provenance for an unset key', async () => {
    const { data } = await runConfigGet({ key: 'rpcUrl' }, makeCtx());
    expect(data).toEqual({ key: 'rpcUrl', value: 'https://mainnet.base.org', source: 'default' });
  });

  it('rejects an unknown key as USAGE / exit 2', async () => {
    const err = await caught(() => runConfigGet({ key: 'nope' }, makeCtx()));
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
    expect(err.fix).toContain('maxAutoSpend');
  });
});

describe('runConfigSet — spend keys', () => {
  it.each([
    ['0.25', '250000'],
    ['0', '0'],
    ['5', '5000000'],
  ])('stores %s USD as %s atomic', async (input, atomic) => {
    const { data } = await runConfigSet({ key: 'maxAutoSpend', value: input }, makeCtx());
    expect(data).toEqual({
      key: 'maxAutoSpend',
      value: { atomic, usd: input === '0' ? '0' : atomicToUsd(atomic) },
      source: 'file',
    });
    expect(await readRawFile()).toEqual({ maxAutoSpend: atomic });
  });

  it.each(['abc', '-1', '1.2345678', ''])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() => runConfigSet({ key: 'sessionBudget', value: bad }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runConfigSet — confirm', () => {
  it('stores "always" verbatim', async () => {
    const { data } = await runConfigSet({ key: 'confirm', value: 'always' }, makeCtx());
    expect(data).toEqual({ key: 'confirm', value: 'always', source: 'file' });
    expect(await readRawFile()).toEqual({ confirm: 'always' });
  });

  it('stores above:<usd> as above:<atomic> with a dual-form threshold', async () => {
    const { data } = await runConfigSet({ key: 'confirm', value: 'above:0.5' }, makeCtx());
    expect(data).toEqual({
      key: 'confirm',
      value: 'above:500000',
      source: 'file',
      threshold: { atomic: '500000', usd: '0.5' },
    });
    expect(await readRawFile()).toEqual({ confirm: 'above:500000' });
  });

  it.each(['sometimes', 'above:', 'above:abc', 'above'])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() => runConfigSet({ key: 'confirm', value: bad }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runConfigSet — allowlistCreators', () => {
  it('comma-splits, trims, and drops empties', async () => {
    const { data } = await runConfigSet({ key: 'allowlistCreators', value: 'a, b ,c,' }, makeCtx());
    expect(data).toEqual({ key: 'allowlistCreators', value: ['a', 'b', 'c'], source: 'file' });
    expect(await readRawFile()).toEqual({ allowlistCreators: ['a', 'b', 'c'] });
  });

  it('clears to [] on the empty string', async () => {
    await runConfigSet({ key: 'allowlistCreators', value: 'a,b' }, makeCtx());
    const { data } = await runConfigSet({ key: 'allowlistCreators', value: '' }, makeCtx());
    expect(data).toEqual({ key: 'allowlistCreators', value: [], source: 'file' });
    expect(await readRawFile()).toEqual({ allowlistCreators: [] });
  });

  it('rejects an entry with internal whitespace', async () => {
    const err = await caught(() =>
      runConfigSet({ key: 'allowlistCreators', value: 'alice bob' }, makeCtx()),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runConfigSet — URL keys', () => {
  it.each(['baseUrl', 'rpcUrl'] as const)('accepts an http(s) URL for %s', async (key) => {
    const { data } = await runConfigSet({ key, value: 'https://api.example.com' }, makeCtx());
    expect(data).toEqual({ key, value: 'https://api.example.com', source: 'file' });
  });

  it.each(['not a url', 'ftp://x.example', 'example.com', ''])(
    'rejects %j as USAGE',
    async (bad) => {
      const err = await caught(() => runConfigSet({ key: 'baseUrl', value: bad }, makeCtx()));
      expect(err.code).toBe('USAGE');
      expect(err.exitCode).toBe(2);
    },
  );
});

describe('runConfigSet — persistence', () => {
  it('rejects an unknown key as USAGE / exit 2', async () => {
    const err = await caught(() => runConfigSet({ key: 'nope', value: 'x' }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });

  it('merges into the file without clobbering other keys or writing defaults', async () => {
    await runConfigSet({ key: 'baseUrl', value: 'https://a.example' }, makeCtx());
    await runConfigSet({ key: 'maxAutoSpend', value: '0.25' }, makeCtx());
    // Only the two set keys are on disk; defaults are never materialized.
    expect(await readRawFile()).toEqual({
      baseUrl: 'https://a.example',
      maxAutoSpend: '250000',
    });
  });

  it('overwrites the same key on a repeat set', async () => {
    await runConfigSet({ key: 'maxAutoSpend', value: '1' }, makeCtx());
    await runConfigSet({ key: 'maxAutoSpend', value: '2' }, makeCtx());
    expect(await readRawFile()).toEqual({ maxAutoSpend: '2000000' });
  });

  it('writes a file that parses cleanly through RawConfigSchema', async () => {
    await runConfigSet({ key: 'confirm', value: 'above:0.25' }, makeCtx());
    const parsed = RawConfigSchema.safeParse(await readRawFile());
    expect(parsed.success).toBe(true);
  });

  it('propagates CONFIG_INVALID when the existing file is corrupt', async () => {
    await writeFile(configFile(), '{ not json');
    const err = await caught(() => runConfigSet({ key: 'maxAutoSpend', value: '1' }, makeCtx()));
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('does not drop concurrent sets of different keys (file lock serializes them)', async () => {
    // Without the lock, N concurrent read-merge-writes all read the same base and
    // the last writer wins, dropping the rest. The lock must land all N.
    await Promise.all([
      runConfigSet({ key: 'maxAutoSpend', value: '0.25' }, makeCtx()),
      runConfigSet({ key: 'sessionBudget', value: '0.5' }, makeCtx()),
      runConfigSet({ key: 'confirm', value: 'above:0.1' }, makeCtx()),
      runConfigSet({ key: 'baseUrl', value: 'https://a.example' }, makeCtx()),
      runConfigSet({ key: 'rpcUrl', value: 'https://b.example' }, makeCtx()),
    ]);
    expect(await readRawFile()).toEqual({
      maxAutoSpend: '250000',
      sessionBudget: '500000',
      confirm: 'above:100000',
      baseUrl: 'https://a.example',
      rpcUrl: 'https://b.example',
    });
  });
});

// Local mirror of lib/money's atomicToUsd expectation, used only to phrase the
// spend-key table above without importing an extra symbol for one call site.
function atomicToUsd(atomic: string): string {
  return atomic === '250000' ? '0.25' : atomic === '5000000' ? '5' : '0';
}

describe('evalCohort key', () => {
  it.each(['true', 'false'] as const)('round-trips %s through set/get', async (value) => {
    await runConfigSet({ key: 'evalCohort', value }, makeCtx());
    const { data } = await runConfigGet({ key: 'evalCohort' }, makeCtx());
    expect(data).toMatchObject({ key: 'evalCohort', value: value === 'true', source: 'file' });
  });

  it.each(['1', '0', 'True', 'yes', ''])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() => runConfigSet({ key: 'evalCohort', value: bad }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('publish.mode key', () => {
  it.each(['review', 'auto', 'full-auto'] as const)(
    'round-trips %s through set/get',
    async (mode) => {
      const set = await runConfigSet(
        { key: 'publish.mode', value: mode },
        makeCtx(),
        await hermeticHome(),
      );
      expect(set.data).toMatchObject({ key: 'publish.mode', value: mode, source: 'file' });
      const get = await runConfigGet({ key: 'publish.mode' }, makeCtx());
      expect(get.data).toEqual({ key: 'publish.mode', value: mode, source: 'file' });
      expect(await readRawFile()).toEqual({ publish: { mode } });
    },
  );

  it.each(['on', 'AUTO', 'fullauto', ''])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() => runConfigSet({ key: 'publish.mode', value: bad }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('publish.defaultPrice key', () => {
  it('parses decimal USD to atomic on set and echoes dual money on get', async () => {
    const set = await runConfigSet({ key: 'publish.defaultPrice', value: '0.25' }, makeCtx());
    expect(set.data).toEqual({
      key: 'publish.defaultPrice',
      value: { atomic: '250000', usd: '0.25' },
      source: 'file',
    });
    const get = await runConfigGet({ key: 'publish.defaultPrice' }, makeCtx());
    expect(get.data).toEqual({
      key: 'publish.defaultPrice',
      value: { atomic: '250000', usd: '0.25' },
      source: 'file',
    });
    expect(await readRawFile()).toEqual({ publish: { defaultPrice: '250000' } });
  });

  it.each(['abc', '-1', '1.2345678', ''])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() =>
      runConfigSet({ key: 'publish.defaultPrice', value: bad }, makeCtx()),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });

  it('merges the two publish subkeys without dropping each other', async () => {
    await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), await hermeticHome());
    await runConfigSet({ key: 'publish.defaultPrice', value: '0.5' }, makeCtx());
    expect(await readRawFile()).toEqual({ publish: { mode: 'review', defaultPrice: '500000' } });
  });
});

describe('forward compatibility', () => {
  it('preserves an unknown top-level block through a set', async () => {
    await writeFile(configFile(), JSON.stringify({ future: { some: 'block' } }));
    await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), await hermeticHome());
    const raw = (await readRawFile()) as Record<string, unknown>;
    expect(raw.future).toEqual({ some: 'block' });
    expect(raw.publish).toEqual({ mode: 'auto' });
  });

  it('preserves an unknown publish subkey a newer CLI wrote', async () => {
    await writeFile(configFile(), JSON.stringify({ publish: { visibility: 'unlisted' } }));
    await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), await hermeticHome());
    const raw = (await readRawFile()) as { publish: Record<string, unknown> };
    expect(raw.publish).toEqual({ visibility: 'unlisted', mode: 'review' });
  });
});

describe('publish readout reflects the per-project .tenjin.json layer', () => {
  it('config get publish.mode shows the project source when a .tenjin.json sets it', async () => {
    // dataDir has no publish config (→ default), but the cwd's .tenjin.json does:
    // the readout must show what a real publish resolves, sourced 'project'.
    const projectCwd = await mkdtemp(join(tmpdir(), 'tenjin-cfg-proj-'));
    await writeFile(
      join(projectCwd, '.tenjin.json'),
      JSON.stringify({ publish: { mode: 'review' } }),
    );
    const prev = process.cwd();
    try {
      process.chdir(projectCwd);
      const { data } = await runConfigGet({ key: 'publish.mode' }, makeCtx());
      expect(data).toMatchObject({ key: 'publish.mode', value: 'review', source: 'project' });
    } finally {
      process.chdir(prev);
      await rm(projectCwd, { recursive: true, force: true });
    }
  });

  it('notes the downgrade when a committed .tenjin.json asks for full-auto', async () => {
    // A non-gitignored (committed) full-auto project file is demoted to auto by
    // the loosening gate; the human line must say so, while data stays unchanged.
    const projectCwd = await mkdtemp(join(tmpdir(), 'tenjin-cfg-proj-'));
    await writeFile(
      join(projectCwd, '.tenjin.json'),
      JSON.stringify({ publish: { mode: 'full-auto' } }),
    );
    const prev = process.cwd();
    try {
      process.chdir(projectCwd);
      const { data, humanLines } = await runConfigList(makeCtx());
      const d = data as Record<string, { value: unknown; source: string }>;
      expect(d['publish.mode']).toMatchObject({ value: 'auto', source: 'project' });
      const line = (humanLines ?? []).find((l) => l.includes('publish.mode'));
      expect(line).toContain('downgraded from full-auto');
    } finally {
      process.chdir(prev);
      await rm(projectCwd, { recursive: true, force: true });
    }
  });

  it('honors a gitignored .tenjin.json full-auto with no downgrade note', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'tenjin-cfg-proj-'));
    execFileSync('git', ['init', '-q'], { cwd: projectCwd });
    await writeFile(join(projectCwd, '.gitignore'), '.tenjin.json\n');
    await writeFile(
      join(projectCwd, '.tenjin.json'),
      JSON.stringify({ publish: { mode: 'full-auto' } }),
    );
    const prev = process.cwd();
    try {
      process.chdir(projectCwd);
      const { data, humanLines } = await runConfigList(makeCtx());
      const d = data as Record<string, { value: unknown; source: string }>;
      expect(d['publish.mode']).toMatchObject({ value: 'full-auto', source: 'project' });
      const line = (humanLines ?? []).find((l) => l.includes('publish.mode'));
      expect(line).not.toContain('downgraded');
    } finally {
      process.chdir(prev);
      await rm(projectCwd, { recursive: true, force: true });
    }
  });
});

describe('update.mode', () => {
  it('defaults to nudge and round-trips every mode', async () => {
    const ctx = makeCtx();
    expect(await runConfigGet({ key: 'update.mode' }, ctx)).toMatchObject({
      data: { key: 'update.mode', value: 'nudge', source: 'default' },
    });
    for (const value of ['off', 'nudge'] as const) {
      const set = await runConfigSet({ key: 'update.mode', value }, ctx);
      expect(set.data).toMatchObject({ key: 'update.mode', value, source: 'file' });
      expect(await runConfigGet({ key: 'update.mode' }, ctx)).toMatchObject({
        data: { value, source: 'file' },
      });
    }
  });

  it('rejects a mode outside the enum', async () => {
    const bad = await caught(() =>
      runConfigSet({ key: 'update.mode', value: 'sometimes' }, makeCtx()),
    );
    expect(bad.code).toBe('USAGE');
    expect(bad.fix).toContain('"nudge"');
    expect(bad.fix).not.toContain('auto');
  });

  // The opt-out has to survive a write to a neighbouring block, or turning auto
  // off would silently come back on the next `config set`.
  it('survives a write to another block', async () => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'update.mode', value: 'off' }, ctx);
    await runConfigSet({ key: 'hooks.stopNag', value: 'off' }, ctx);
    expect(await runConfigGet({ key: 'update.mode' }, ctx)).toMatchObject({
      data: { value: 'off', source: 'file' },
    });
  });
});

/**
 * `config set publish.mode` settles whether a PUBLISH asks. The harness rule
 * settles whether the HARNESS asks anyway, and leaving that to the next `tenjin
 * install` is the seam that made auto mode look broken (tenjin-agent #161).
 */
describe('publish.mode keeps the harness allowlist in step', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tenjin-cfg-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const allowOf = async (): Promise<string[]> => {
    const raw = await readFile(claudeSettingsPath(home), 'utf8').catch(() => null);
    if (raw === null) return [];
    return (JSON.parse(raw) as { permissions?: { allow?: string[] } }).permissions?.allow ?? [];
  };
  const syncOf = (d: unknown) =>
    (
      d as {
        allowlist?: { added: string[]; removed: string[]; skipped?: string; pointer?: string };
      }
    ).allowlist;

  // Loosening ADDS a grant, so a human says yes to it.
  it('writes the publish rule on auto when the operator agrees', async () => {
    const asked: string[] = [];
    const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async (label) => {
        asked.push(label);
        return true;
      },
    });
    expect(asked).toHaveLength(1);
    // The question names the rule it is about to write.
    expect(asked[0]).toContain(PUBLISH_MODE_RULE);
    expect(asked[0]).toContain('publish.mode auto');
    expect(await allowOf()).toContain(PUBLISH_MODE_RULE);
    expect(syncOf(res.data)?.added).toContain(PUBLISH_MODE_RULE);
  });

  // The write carries the free tier too on a machine that never ran install, so
  // the question has to say so rather than name one line and write ten.
  it('discloses the free-verb rules the same write carries', async () => {
    let label = '';
    await runConfigSet({ key: 'publish.mode', value: 'full-auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async (l) => {
        label = l;
        return true;
      },
    });
    expect(label).toMatch(/Also adds the \d+ free-verb rule/);
    expect(await allowOf()).toHaveLength(FREE_VERB_RULES.length + 1);
  });

  it('writes nothing when the operator declines, and points instead', async () => {
    const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async () => false,
    });
    expect(await allowOf()).toEqual([]);
    expect(syncOf(res.data)?.skipped).toBe('declined');
    expect(syncOf(res.data)?.pointer).toContain(PUBLISH_MODE_RULE);
    // The mode itself still landed; only the harness write was refused.
    expect(await runConfigGet({ key: 'publish.mode' }, makeCtx())).toMatchObject({
      data: { value: 'auto', source: 'file' },
    });
  });

  // Silence is not consent: nobody to ask means the pointer, never a write.
  it('never prompts and never writes without a TTY', async () => {
    const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: false,
      confirmRule: async () => {
        throw new Error('must not ask');
      },
    });
    expect(await allowOf()).toEqual([]);
    expect(syncOf(res.data)?.skipped).toBe('no-tty');
    expect(res.humanLines?.join(' ')).toContain(PUBLISH_MODE_RULE);
  });

  it('never prompts under --json, whatever the TTY says', async () => {
    const res = await runConfigSet(
      { key: 'publish.mode', value: 'auto' },
      makeCtx({ json: true }),
      {
        homeDir: home,
        harnessIsClaude: true,
        isInteractive: true,
        confirmRule: async () => {
          throw new Error('must not ask');
        },
      },
    );
    expect(await allowOf()).toEqual([]);
    expect(syncOf(res.data)?.skipped).toBe('no-tty');
    // The payload still carries the remedy, since --json renders no humanLines.
    expect(syncOf(res.data)?.pointer).toContain(PUBLISH_MODE_RULE);
  });

  // Tightening only ever removes what this CLI wrote, so it needs no question —
  // including on a headless machine, which is where a stale grant would sit.
  it('retracts the rule on review, unprompted, and reports it', async () => {
    await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async () => true,
    });
    expect(await allowOf()).toContain(PUBLISH_MODE_RULE);

    const res = await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: false,
      confirmRule: async () => {
        throw new Error('must not ask');
      },
    });
    expect(await allowOf()).not.toContain(PUBLISH_MODE_RULE);
    expect(syncOf(res.data)?.removed).toEqual([PUBLISH_MODE_RULE]);
    expect(res.humanLines?.join(' ')).toContain('Removed');
  });

  it('leaves the operator’s own rules alone while retracting ours', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({
        permissions: { allow: ['Bash(git status:*)', ...FREE_VERB_RULES, PUBLISH_MODE_RULE] },
      }),
    );
    await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), { homeDir: home });
    expect(await allowOf()).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);
  });

  // The retraction skips its prompt because it can only REMOVE. That claim stops
  // holding when the free tier is absent, since the one writer would add it in
  // the same pass — so this path declines to write rather than grant nine rules
  // nobody asked for. A publish rule without the free tier beside it was not
  // written by our `install`, which writes them together.
  it('writes nothing on review when the free tier is missing, rather than adding it', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({ permissions: { allow: ['Bash(git status:*)', PUBLISH_MODE_RULE] } }),
    );
    const res = await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
    });
    expect(await allowOf()).toEqual(['Bash(git status:*)', PUBLISH_MODE_RULE]);
    expect(syncOf(res.data)?.skipped).toBe('needs-install');
    expect(syncOf(res.data)?.added).toEqual([]);
  });

  it('asks nothing when the allowlist already carries every rule the mode needs', async () => {
    await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async () => true,
    });
    const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async () => {
        throw new Error('must not ask');
      },
    });
    expect(syncOf(res.data)).toMatchObject({ added: [], removed: [] });
    expect(syncOf(res.data)?.skipped).toBeUndefined();
  });

  it('touches no settings file on a non-Claude harness', async () => {
    const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      isInteractive: true,
      harnessIsClaude: false,
      confirmRule: async () => {
        throw new Error('must not ask');
      },
    });
    expect(await allowOf()).toEqual([]);
    expect(syncOf(res.data)?.skipped).toBe('not-claude');
  });

  /**
   * The harness is DETECTED, not assumed. `src/cli.ts` passes no deps, so a
   * default of "this is Claude Code" would prompt every codex-only operator about
   * a ~/.claude/settings.json nothing on their machine reads — and a review-set
   * would then sweep a file this CLI never owned.
   */
  describe('harness detection, when the caller names none', () => {
    // Nothing on PATH, no ~/.claude, no recorded --harness: not our file.
    it('skips a codex-only machine at a TTY, without asking', async () => {
      await mkdir(join(home, '.codex'), { recursive: true });
      const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
        homeDir: home,
        isInteractive: true,
        which: (bin) => bin === 'codex',
        env: { PATH: '' },
        confirmRule: async () => {
          throw new Error('must not ask');
        },
      });
      expect(await allowOf()).toEqual([]);
      expect(syncOf(res.data)?.skipped).toBe('not-claude');
      expect(syncOf(res.data)?.pointer).toContain(PUBLISH_MODE_RULE);
      // The mode itself still landed.
      expect(await runConfigGet({ key: 'publish.mode' }, makeCtx())).toMatchObject({
        data: { value: 'auto' },
      });
    });

    // Tightening on the same machine must not CREATE the file either: the writer
    // makes ~/.claude/settings.json when it is absent, so an unguarded retraction
    // would leave a codex-only operator holding a Claude config they never had.
    it('creates no settings file on review for a codex-only machine', async () => {
      const res = await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), {
        homeDir: home,
        which: (bin) => bin === 'codex',
        env: { PATH: '' },
      });
      expect(existsSync(claudeSettingsPath(home))).toBe(false);
      expect(syncOf(res.data)?.skipped).toBe('not-claude');
    });

    // A ~/.claude directory IS Claude-detection evidence (home-dir reason), so a
    // machine that already holds that settings file is one we may sweep.
    it('sweeps a machine whose ~/.claude exists, even with codex on PATH', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        claudeSettingsPath(home),
        JSON.stringify({ permissions: { allow: [...FREE_VERB_RULES, PUBLISH_MODE_RULE] } }),
      );
      const res = await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), {
        homeDir: home,
        which: (bin) => bin === 'codex',
        env: { PATH: '' },
      });
      expect(await allowOf()).not.toContain(PUBLISH_MODE_RULE);
      expect(syncOf(res.data)?.removed).toEqual([PUBLISH_MODE_RULE]);
    });

    it('detects Claude Code by its binary', async () => {
      const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
        homeDir: home,
        isInteractive: true,
        which: (bin) => bin === 'claude',
        env: { PATH: '' },
        confirmRule: async () => true,
      });
      expect(await allowOf()).toContain(PUBLISH_MODE_RULE);
      expect(syncOf(res.data)?.skipped).toBeUndefined();
    });

    // A past `--harness claude` outranks the probes: detection only sees what this
    // CLI knows to look for, and the operator already answered the question.
    it('honors a recorded --harness claude on a machine that detects neither', async () => {
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ install: { harness: ['claude'] } }),
      );
      const res = await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
        homeDir: home,
        isInteractive: true,
        which: () => false,
        env: { PATH: '' },
        confirmRule: async () => true,
      });
      expect(await allowOf()).toContain(PUBLISH_MODE_RULE);
      expect(syncOf(res.data)?.skipped).toBeUndefined();
    });
  });

  // publish.defaultPrice is not a consent decision and must not drag the harness
  // allowlist along with it.
  it('syncs nothing for the sibling publish key', async () => {
    const res = await runConfigSet({ key: 'publish.defaultPrice', value: '0.25' }, makeCtx(), {
      homeDir: home,
      isInteractive: true,
      confirmRule: async () => {
        throw new Error('must not ask');
      },
    });
    expect(await allowOf()).toEqual([]);
    expect(syncOf(res.data)).toBeUndefined();
  });
});

describe('the hooks block is set through config, which stays human-gated', () => {
  it('round-trips both hook keys and rejects a value outside the enum', async () => {
    const ctx = makeCtx();
    for (const [key, value] of [
      ['hooks.searchMode', 'remind'],
      ['hooks.stopNag', 'off'],
    ] as const) {
      const set = await runConfigSet({ key, value }, ctx);
      expect(set.data).toMatchObject({ key, value, source: 'file' });
      expect(await runConfigGet({ key }, ctx)).toMatchObject({
        data: { key, value, source: 'file' },
      });
    }
    // Both subkeys survive each other's write, so silencing one hook cannot
    // silently reset the other.
    expect(await runConfigGet({ key: 'hooks.searchMode' }, ctx)).toMatchObject({
      data: { value: 'remind' },
    });

    const bad = await caught(() => runConfigSet({ key: 'hooks.stopNag', value: 'sometimes' }, ctx));
    expect(bad.code).toBe('USAGE');
    expect(bad.fix).toContain('"on"');
    // The middle setting is offered by name, or an operator hunting for it
    // finds only the cliff.
    expect(bad.fix).toContain('"deliberate-only"');
  });

  // The arm-level toggle (#162): silencing the batched web-search reminders
  // without silencing the deliberate-search ones.
  it('round-trips deliberate-only, the middle stopNag setting', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'hooks.stopNag', value: 'deliberate-only' }, ctx);
    expect(set.data).toMatchObject({ value: 'deliberate-only', source: 'file' });
    expect(await runConfigGet({ key: 'hooks.stopNag' }, ctx)).toMatchObject({
      data: { value: 'deliberate-only', source: 'file' },
    });
  });
});

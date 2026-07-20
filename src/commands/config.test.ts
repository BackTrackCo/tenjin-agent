import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigList, runConfigGet, runConfigSet } from './config';
import { RawConfigSchema } from '../lib/config';
import { CliError } from '../lib/errors';
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
    expect(humanLines).toHaveLength(7);
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

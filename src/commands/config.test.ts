import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigList, runConfigGet, runConfigSet } from './config';
import { RawConfigSchema } from '../lib/config';
import { CliError } from '../lib/errors';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
let prevCwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-cfg-cmd-'));
  // Every command here resolves `router.*` from the cwd,
  // so each test runs from a git root of its own and no file on the machine
  // running the suite can change what it reads.
  const work = join(dir, 'work');
  await mkdir(join(work, '.git'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(work);
});
afterEach(async () => {
  process.chdir(prevCwd);
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
  it('carries spending meaning in agent JSON without turning defaults into saved choices', async () => {
    const { data } = await runConfigList(makeCtx());
    const settings = data as Record<
      string,
      { value: unknown; source: string; description?: string }
    >;
    expect(settings.sessionBudget?.description).toMatch(
      /24-hour budget window.*across agent sessions/,
    );
    expect(settings.maxAutoSpend?.description).toContain('per call');
    expect(settings.sendMaxAmount?.description).toContain('unset = send refuses');
    expect(settings.sessionBudget?.source).toBe('default');
    const one = await runConfigGet({ key: 'sessionBudget' }, makeCtx());
    expect(one.data).toMatchObject({
      description: settings.sessionBudget?.description,
      source: 'default',
    });
    expect(existsSync(configFile())).toBe(false);
  });

  it('reports every key with default provenance on a fresh dir', async () => {
    const { data, humanLines } = await runConfigList(makeCtx());
    const d = data as Record<string, { value: unknown; source: string }>;
    expect(d.maxAutoSpend).toMatchObject({
      value: { atomic: '250000', usd: '0.25' },
      source: 'default',
    });
    expect(d.sessionBudget).toMatchObject({
      value: { atomic: '5000000', usd: '5' },
      source: 'default',
    });
    expect(d.confirm).toBeUndefined();
    expect(d.allowlistCreators).toEqual({ value: [], source: 'default' });
    expect(d.baseUrl).toEqual({ value: PRODUCTION_ORIGIN, source: 'default' });
    expect(d.rpcUrl).toEqual({ value: 'https://mainnet.base.org', source: 'default' });
    // No numeric or 'none' default: absent resolves to the 'unset' sentinel and
    // `tenjin send` refuses until the cap is set (require-set-before-first-send).
    expect(d.sendMaxAmount).toMatchObject({ value: 'unset', source: 'default' });
    expect(d['update.mode']).toEqual({ value: 'auto', source: 'default' });
    expect(d['router.enabled']).toEqual({ value: true, source: 'default' });
    expect(d['router.context']).toEqual({ value: 'session', source: 'default' });
    expect(d['experimental.bazaar']).toEqual({ value: 'off', source: 'default' });
    // The shelf's keys are gone from both halves.
    for (const gone of ['publicShelfUrl', 'shelfBypassSecret', 'evalCohort', 'publish.mode']) {
      expect(d[gone]).toBeUndefined();
    }
    // The human listing: 6 scalar keys + update.mode + 2 router.* +
    // experimental.bazaar. allowlistCreators stays in `data` only.
    expect(humanLines).toHaveLength(10);
    expect((humanLines ?? []).join('\n')).not.toMatch(
      /publish\.|hooks\.|loop\.|team\.|Shelf|allowlistCreators|evalCohort/,
    );
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

  it('shows the same spending descriptions in the human listing and machine readback', async () => {
    const { data, humanLines } = await runConfigList(makeCtx());
    const text = (humanLines ?? []).join('\n');
    expect(text).toContain('24-hour budget window');
    expect(text).toContain('Tenjin API base URL the router asks');
    // Money and provenance remain alongside the meaning an agent needs.
    const d = data as Record<string, Record<string, unknown>>;
    expect(Object.keys(d.sessionBudget ?? {}).sort()).toEqual(['description', 'source', 'value']);
  });

  it('preserves an unknown key (e.g. a removed shelf block) through set', async () => {
    // A set must not strip a block this build does not read, whether a newer CLI
    // or an earlier release wrote it (here the shelf's `publish`): set a known
    // key and assert the unknown one still round-trips.
    await writeFile(configFile(), JSON.stringify({ publish: { visibility: 'unlisted' } }));
    await runConfigSet({ key: 'maxAutoSpend', value: '1' }, makeCtx());
    const raw = (await readRawFile()) as Record<string, unknown>;
    expect(raw.publish).toEqual({ visibility: 'unlisted' });
    expect(raw.maxAutoSpend).toBe('1000000');
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
    await runConfigSet({ key: 'maxAutoSpend', value: '1.25' }, makeCtx());
    const { data, humanLines } = await runConfigGet({ key: 'maxAutoSpend' }, makeCtx());
    expect(data).toMatchObject({
      key: 'maxAutoSpend',
      value: { atomic: '1250000', usd: '1.25' },
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
    ['1', '1000000'],
    ['5', '5000000'],
  ])('stores %s USD as %s atomic', async (input, atomic) => {
    const { data } = await runConfigSet({ key: 'maxAutoSpend', value: input }, makeCtx());
    expect(data).toMatchObject({
      key: 'maxAutoSpend',
      value: { atomic, usd: atomicToUsd(atomic) },
      source: 'file',
    });
    expect(await readRawFile()).toEqual({ maxAutoSpend: atomic });
  });

  it.each(['0', '0.1', '0.249'])(
    'refuses a per-call limit of %s USD, below the 0.25 USD floor, and says why',
    async (low) => {
      const err = await caught(() => runConfigSet({ key: 'maxAutoSpend', value: low }, makeCtx()));
      expect(err.code).toBe('USAGE');
      expect(err.message).toBe(`maxAutoSpend ${low} is below the 0.25 USD minimum.`);
      expect(err.fix).toContain('the routing deposit: below it, routing cannot pay');
      expect(err.fix).toContain('`tenjin config set router.enabled false`');
      await expect(readFile(configFile(), 'utf8')).rejects.toThrow();
    },
  );

  it.each(['abc', '-1', '1.2345678', ''])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() => runConfigSet({ key: 'sessionBudget', value: bad }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runConfigSet — experimental.bazaar', () => {
  it('turns it on with the warning, and off without one', async () => {
    const on = await runConfigSet({ key: 'experimental.bazaar', value: 'on' }, makeCtx());
    expect(on.data).toMatchObject({ key: 'experimental.bazaar', value: 'on', source: 'file' });
    const warning = (on.data as { warning: string }).warning;
    expect(warning).toContain('Experimental');
    expect(warning).toContain("Coinbase's open x402 Bazaar");
    expect(warning).toContain('unreviewed');
    expect(warning).toContain(
      "short snippets of your prompts are sent to Coinbase's public Bazaar search",
    );
    expect(warning).toContain('payments are real');
    expect(warning).toContain('tenjin config set experimental.bazaar off');
    expect(on.humanLines).toContain(warning);
    expect(await readRawFile()).toEqual({ experimental: { bazaar: 'on' } });
    const got = await runConfigGet({ key: 'experimental.bazaar' }, makeCtx());
    expect(got.data).toEqual({ key: 'experimental.bazaar', value: 'on', source: 'file' });

    const off = await runConfigSet({ key: 'experimental.bazaar', value: 'off' }, makeCtx());
    expect(off.data).toEqual({ key: 'experimental.bazaar', value: 'off', source: 'file' });
  });

  it('refuses anything but on or off', async () => {
    const err = await caught(() =>
      runConfigSet({ key: 'experimental.bazaar', value: 'yes' }, makeCtx()),
    );
    expect(err.code).toBe('USAGE');
  });
});

describe('retired payment setters', () => {
  it.each(['confirm', 'bazaarPay'])('rejects %s with replacement guidance', async (key) => {
    const err = await caught(() => runConfigSet({ key, value: 'always' }, makeCtx()));
    expect(err.code).toBe('USAGE');
    expect(err.fix).toContain('manual pay always requires consent');
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
    await runConfigSet({ key: 'maxAutoSpend', value: '1.25' }, makeCtx());
    // Only the two set keys are on disk; defaults are never materialized.
    expect(await readRawFile()).toEqual({
      baseUrl: 'https://a.example',
      maxAutoSpend: '1250000',
    });
  });

  it('overwrites the same key on a repeat set', async () => {
    await runConfigSet({ key: 'maxAutoSpend', value: '1' }, makeCtx());
    await runConfigSet({ key: 'maxAutoSpend', value: '2' }, makeCtx());
    expect(await readRawFile()).toEqual({ maxAutoSpend: '2000000' });
  });

  it('writes a file that parses cleanly through RawConfigSchema', async () => {
    await runConfigSet({ key: 'maxAutoSpend', value: '1.25' }, makeCtx());
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
      runConfigSet({ key: 'maxAutoSpend', value: '1.25' }, makeCtx()),
      runConfigSet({ key: 'sessionBudget', value: '0.5' }, makeCtx()),
      runConfigSet({ key: 'baseUrl', value: 'https://a.example' }, makeCtx()),
      runConfigSet({ key: 'rpcUrl', value: 'https://b.example' }, makeCtx()),
    ]);
    expect(await readRawFile()).toEqual({
      maxAutoSpend: '1250000',
      sessionBudget: '500000',
      baseUrl: 'https://a.example',
      rpcUrl: 'https://b.example',
    });
  });
});

// Local mirror of lib/money's atomicToUsd expectation, used only to phrase the
// spend-key table above without importing an extra symbol for one call site.
function atomicToUsd(atomic: string): string {
  return atomic === '1000000' ? '1' : atomic === '5000000' ? '5' : '0';
}

describe('forward compatibility', () => {
  it('preserves an unknown top-level block through a set', async () => {
    await writeFile(configFile(), JSON.stringify({ future: { some: 'block' } }));
    await runConfigSet({ key: 'update.mode', value: 'nudge' }, makeCtx());
    const raw = (await readRawFile()) as Record<string, unknown>;
    expect(raw.future).toEqual({ some: 'block' });
    expect(raw.update).toEqual({ mode: 'nudge' });
  });

  it('preserves an unknown update subkey a newer CLI wrote', async () => {
    await writeFile(configFile(), JSON.stringify({ update: { channel: 'next' } }));
    await runConfigSet({ key: 'update.mode', value: 'off' }, makeCtx());
    const raw = (await readRawFile()) as { update: Record<string, unknown> };
    expect(raw.update).toEqual({ channel: 'next', mode: 'off' });
  });

  it('refuses a key the shelf took and this build does not', async () => {
    for (const key of ['publish.mode', 'hooks.primer', 'loop.port', 'shelfBypassSecret']) {
      const err = await caught(() => runConfigSet({ key, value: 'on' }, makeCtx()));
      expect(err.code).toBe('USAGE');
      expect(err.message).toContain('Unknown config key');
    }
  });
});

describe('update.mode', () => {
  it('defaults to auto and round-trips every mode', async () => {
    const ctx = makeCtx();
    expect(await runConfigGet({ key: 'update.mode' }, ctx)).toMatchObject({
      data: { key: 'update.mode', value: 'auto', source: 'default' },
    });
    for (const value of ['off', 'nudge', 'auto'] as const) {
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
    expect(bad.fix).toContain('"auto"');
  });

  // The opt-out has to survive a write to a neighbouring block, or turning auto
  // off would silently come back on the next `config set`.
  it('survives a write to another block', async () => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'update.mode', value: 'off' }, ctx);
    await runConfigSet({ key: 'experimental.bazaar', value: 'on' }, ctx);
    expect(await runConfigGet({ key: 'update.mode' }, ctx)).toMatchObject({
      data: { value: 'off', source: 'file' },
    });
  });
});

describe('payment configuration', () => {
  it('bazaarRegistries accepts a comma list of https origins and rejects garbage', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet(
      { key: 'bazaarRegistries', value: 'https://a.test, https://b.test/x402' },
      ctx,
    );
    expect((set.data as { value: string[] }).value).toEqual([
      'https://a.test',
      'https://b.test/x402',
    ]);
    await expect(
      runConfigSet({ key: 'bazaarRegistries', value: 'not a url' }, ctx),
    ).rejects.toThrow(CliError);
  });
});

describe('config set router.* at each scope', () => {
  async function inRepo<T>(run: (repo: string) => Promise<T>): Promise<T> {
    const repo = await mkdtemp(join(tmpdir(), 'tenjin-cfg-router-'));
    await mkdir(join(repo, '.git'));
    const prev = process.cwd();
    try {
      process.chdir(repo);
      return await run(repo);
    } finally {
      process.chdir(prev);
      await rm(repo, { recursive: true, force: true });
    }
  }
  const readJson = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(path, 'utf8')) as unknown;

  it('writes the global file without --project, on or off accepted', async () => {
    await runConfigSet({ key: 'router.enabled', value: 'off' }, makeCtx());
    await runConfigSet({ key: 'router.context', value: 'turn' }, makeCtx());
    expect((await readRawFile()) as Record<string, unknown>).toMatchObject({
      router: { enabled: false, context: 'turn' },
    });
  });

  it.each([
    ['router.enabled', 'maybe'],
    ['router.context', 'all'],
  ])('rejects %s %s as USAGE', async (key, value) => {
    const err = await caught(() => runConfigSet({ key, value }, makeCtx()));
    expect(err.code).toBe('USAGE');
  });

  it('writes the project file with --project and the personal one with --local', async () => {
    await inRepo(async (repo) => {
      await runConfigSet({ key: 'router.enabled', value: 'false', project: true }, makeCtx());
      expect(await readJson(join(repo, '.tenjin', 'config.json'))).toEqual({
        router: { enabled: false },
      });

      const { data, humanLines } = await runConfigSet(
        { key: 'router.context', value: 'turn', project: true, local: true },
        makeCtx(),
      );
      expect(await readJson(join(repo, '.tenjin', 'config.local.json'))).toEqual({
        router: { context: 'turn' },
      });
      expect(data).toMatchObject({ key: 'router.context', value: 'turn', source: 'local' });
      expect((humanLines ?? []).join('\n')).toContain('.gitignore');
      // The global file is untouched by either.
      expect(existsSync(configFile())).toBe(false);

      const listed = (await runConfigList(makeCtx())).data as Record<string, unknown>;
      expect(listed['router.enabled']).toMatchObject({ value: false, source: 'project' });
      expect(listed['router.context']).toMatchObject({ value: 'turn', source: 'local' });
    });
  });

  it('keeps a router subkey it does not know when it writes a project file', async () => {
    await inRepo(async (repo) => {
      await mkdir(join(repo, '.tenjin'));
      await writeFile(
        join(repo, '.tenjin', 'config.json'),
        JSON.stringify({ note: 'team', router: { context: 'turn', later: 1 } }),
      );
      await runConfigSet({ key: 'router.enabled', value: 'false', project: true }, makeCtx());
      expect(await readJson(join(repo, '.tenjin', 'config.json'))).toEqual({
        note: 'team',
        router: { context: 'turn', later: 1, enabled: false },
      });
    });
  });

  it('keeps both keys when two project sets run at once', async () => {
    await inRepo(async (repo) => {
      await Promise.all([
        runConfigSet({ key: 'router.enabled', value: 'false', project: true }, makeCtx()),
        runConfigSet({ key: 'router.context', value: 'turn', project: true }, makeCtx()),
      ]);
      expect(await readJson(join(repo, '.tenjin', 'config.json'))).toEqual({
        router: { enabled: false, context: 'turn' },
      });
      expect(existsSync(join(repo, '.tenjin', 'config.json.lock'))).toBe(false);
    });
  });

  it('says when a project value cannot loosen the global one', async () => {
    await runConfigSet({ key: 'router.enabled', value: 'false' }, makeCtx());
    await inRepo(async () => {
      const { humanLines } = await runConfigSet(
        { key: 'router.enabled', value: 'true', project: true },
        makeCtx(),
      );
      expect((humanLines ?? []).join('\n')).toContain('Still false here');
    });
  });

  it('refuses --project on a key a project cannot set, and --local alone', async () => {
    const project = await caught(() =>
      runConfigSet({ key: 'maxAutoSpend', value: '5', project: true }, makeCtx()),
    );
    expect(project.code).toBe('USAGE');
    const local = await caught(() =>
      runConfigSet({ key: 'router.enabled', value: 'false', local: true }, makeCtx()),
    );
    expect(local.code).toBe('USAGE');
    expect(existsSync(configFile())).toBe(false);
  });
});

describe('daily limit configuration cutover', () => {
  it.each([
    ['0', '0', { atomic: '0', usd: '0' }],
    ['1.25', '1250000', { atomic: '1250000', usd: '1.25' }],
    ['none', 'none', null],
  ])('round trips %s', async (value, stored, rendered) => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'sessionBudget', value: value as string }, ctx);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).sessionBudget).toBe(stored);
    expect((await runConfigGet({ key: 'sessionBudget' }, ctx)).data).toMatchObject({
      value: rendered,
      source: 'file',
    });
    const { resolveContextSettings } = await import('../lib/settings');
    expect((await resolveContextSettings(ctx)).policy.sessionBudgetAtomic).toBe(
      stored === 'none' ? null : BigInt(stored as string),
    );
  });
  it.each([false, true, null])(
    'ignores retired values (%s) without read-time writes or blocking config edits',
    async (value) => {
      const raw = JSON.stringify({
        bazaarPay: value,
        confirm: value,
        sessionBudget: '0',
        router: { enabled: false },
      });
      await writeFile(join(dir, 'config.json'), raw);
      const result = await runConfigList(makeCtx());
      expect(result.data).not.toHaveProperty('confirm');
      expect(result.data).not.toHaveProperty('bazaarPay');
      expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(raw);
      await runConfigSet({ key: 'sessionBudget', value: 'none' }, makeCtx());
      expect(await readRawFile()).toMatchObject({
        bazaarPay: value,
        confirm: value,
        sessionBudget: 'none',
        router: { enabled: false },
      });
    },
  );
  it('does not accept none as a per-call automatic approval threshold', async () => {
    await expect(
      runConfigSet({ key: 'maxAutoSpend', value: 'none' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

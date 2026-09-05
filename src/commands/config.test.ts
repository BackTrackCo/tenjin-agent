import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runConfigList,
  runConfigGet,
  runConfigSet,
  persistPublishMode,
  persistFreeVerbsDeclined,
} from './config';
import { LOOP_CONFIG_KEYS, RawConfigSchema } from '../lib/config';
import { CliError } from '../lib/errors';
import { fileURLToPath } from 'node:url';
import { resolveSkillsSource } from '../lib/skills-source';
import {
  claudeSettingsPath,
  FREE_VERB_RULES,
  MODE_GATED_RULES,
  PUBLISH_MODE_RULE,
} from '../lib/harness-permissions';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import type { CommandContext, GlobalFlags } from '../context';

const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

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
    expect(d.baseUrl).toEqual({ value: PRODUCTION_ORIGIN, source: 'default' });
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
    expect(d['hooks.webSearch']).toEqual({ value: 'auto', source: 'default' });
    expect(d['hooks.agentDispatch']).toEqual({ value: 'auto', source: 'default' });
    expect(d['hooks.stopNag']).toEqual({ value: 'on', source: 'default' });
    expect(d['hooks.sessionPrimer']).toEqual({ value: 'on', source: 'default' });
    expect(d['hooks.push']).toEqual({ value: 'off', source: 'default' });
    expect(d['hooks.capture']).toEqual({ value: 'off', source: 'default' });
    expect(d['update.mode']).toEqual({ value: 'nudge', source: 'default' });
    expect(d.publicShelfUrl).toEqual({ value: 'https://tenjin.blog', source: 'default' });
    // REDACTED even here, on a fresh dir where the value is empty: the rendered
    // shape must not depend on whether there is a secret to leak.
    expect(d.shelfBypassSecret).toEqual({ value: 'unset', source: 'default' });
    expect(d['publish.ackServerWarnings']).toEqual({ value: 'mode', source: 'default' });
    // 12 scalar keys (incl. bazaarPay/bazaarRegistries and the two shelf keys)
    // + 3 publish.* (mode, defaultPrice, ackServerWarnings) + 6 hooks.*
    // (webSearch, agentDispatch, stopNag, sessionPrimer, push, capture)
    // + 1 update.mode + 4 loop.* + 1 team.publicFallback.
    expect(humanLines).toHaveLength(27);
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

  it('persistFreeVerbsDeclined preserves a sibling install.harness key', async () => {
    // Seeded as a past `install --harness claude` would have left it; declining
    // the allowlist on a later run must not clobber that record.
    await writeFile(configFile(), JSON.stringify({ install: { harness: ['claude'] } }));
    await persistFreeVerbsDeclined(dir, ['Bash(tenjin search:*)', 'Bash(tenjin read:*)']);
    expect(await readRawFile()).toEqual({
      install: {
        harness: ['claude'],
        freeVerbsDeclined: ['Bash(tenjin search:*)', 'Bash(tenjin read:*)'],
      },
    });
    // A later grant clears it back, through the same merge.
    await persistFreeVerbsDeclined(dir, []);
    expect(await readRawFile()).toEqual({
      install: { harness: ['claude'], freeVerbsDeclined: [] },
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

  // on/off must parse because the CLI's own refusal texts coach exactly
  // `tenjin config set bazaarPay on` (pay.ts, discover.ts): a coached command
  // that exits USAGE teaches an agent the remediation is broken.
  it.each([
    ['on', true],
    ['off', false],
  ] as const)('accepts the coached %s spelling', async (value, expected) => {
    await runConfigSet({ key: 'evalCohort', value }, makeCtx());
    const { data } = await runConfigGet({ key: 'evalCohort' }, makeCtx());
    expect(data).toMatchObject({ key: 'evalCohort', value: expected, source: 'file' });
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

/**
 * The consent seam the held payload sends operators to: a scan-gate hold whose
 * `fix` names `tenjin config set publish.ackServerWarnings on`, so the command it
 * names has to work and has to refuse a value it does not know.
 */
describe('publish.ackServerWarnings key', () => {
  it.each(['mode', 'on', 'off'] as const)('round-trips %s through the file', async (value) => {
    const set = await runConfigSet(
      { key: 'publish.ackServerWarnings', value },
      makeCtx(),
      await hermeticHome(),
    );
    expect(set.data).toEqual({ key: 'publish.ackServerWarnings', value, source: 'file' });
    const get = await runConfigGet({ key: 'publish.ackServerWarnings' }, makeCtx());
    expect(get.data).toEqual({ key: 'publish.ackServerWarnings', value, source: 'file' });
    expect(await readRawFile()).toEqual({ publish: { ackServerWarnings: value } });
  });

  // A typo must not land on the looser reading by accident: this key decides
  // whether one --yes covers the marketplace's own findings.
  it.each(['yes', 'true', 'ON', 'auto', ''])('rejects %j as USAGE', async (bad) => {
    const err = await caught(() =>
      runConfigSet({ key: 'publish.ackServerWarnings', value: bad }, makeCtx()),
    );
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });

  it('merges with the sibling publish subkeys rather than replacing them', async () => {
    await runConfigSet(
      { key: 'publish.mode', value: 'full-auto' },
      makeCtx(),
      await hermeticHome(),
    );
    await runConfigSet({ key: 'publish.ackServerWarnings', value: 'off' }, makeCtx());
    expect(await readRawFile()).toEqual({
      publish: { mode: 'full-auto', ackServerWarnings: 'off' },
    });
  });

  // Setting it is not a mode change, so it must not touch the harness allowlist
  // the way `config set publish.mode` deliberately does.
  it('does not sync the harness allowlist the way publish.mode does', async () => {
    const set = await runConfigSet(
      { key: 'publish.ackServerWarnings', value: 'on' },
      makeCtx(),
      await hermeticHome(),
    );
    expect(set.data).not.toHaveProperty('allowlist');
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
    expect(await allowOf()).toHaveLength(FREE_VERB_RULES.length + MODE_GATED_RULES.length);
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
    expect(syncOf(res.data)?.removed).toEqual([...MODE_GATED_RULES]);
    expect(res.humanLines?.join(' ')).toContain('Removed');
  });

  it('leaves the operator’s own rules alone while retracting ours', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({
        permissions: {
          allow: ['Bash(git status:*)', ...FREE_VERB_RULES, ...MODE_GATED_RULES],
        },
      }),
    );
    await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), { homeDir: home });
    expect(await allowOf()).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);
  });

  // The retraction skips its prompt because it can only REMOVE, and it runs
  // through a pass that appends nothing — so an incomplete free tier is not a
  // reason to leave a publish rule standing. It was one while retraction rode the
  // additive writer, which is the silent decline PR #164 round 3 major 1 found.
  it('retracts on review even when the free tier is incomplete, and adds nothing', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({ permissions: { allow: ['Bash(git status:*)', PUBLISH_MODE_RULE] } }),
    );
    const res = await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
    });
    expect(await allowOf()).toEqual(['Bash(git status:*)']);
    expect(syncOf(res.data)?.removed).toEqual([PUBLISH_MODE_RULE]);
    expect(syncOf(res.data)?.added).toEqual([]);
    expect(syncOf(res.data)?.skipped).toBeUndefined();
  });

  // SATISFIED BEFORE TTY (PR #164 round 2, major 3b): a fully-wired machine under
  // --json used to come back `no-tty` with a pointer at rules it already had.
  it('is a clean no-op on a wired machine under --json, not a no-tty pointer', async () => {
    await runConfigSet({ key: 'publish.mode', value: 'auto' }, makeCtx(), {
      homeDir: home,
      harnessIsClaude: true,
      isInteractive: true,
      confirmRule: async () => true,
    });
    const res = await runConfigSet(
      { key: 'publish.mode', value: 'auto' },
      makeCtx({ json: true }),
      {
        homeDir: home,
        harnessIsClaude: true,
      },
    );
    expect(syncOf(res.data)).toMatchObject({ added: [], removed: [] });
    expect(syncOf(res.data)?.skipped).toBeUndefined();
    expect(syncOf(res.data)?.pointer).toBeUndefined();
  });

  // And the pointer that DOES render names only what is missing.
  it('points at the missing rules only, on a machine that has none of them', async () => {
    const res = await runConfigSet(
      { key: 'publish.mode', value: 'auto' },
      makeCtx({ json: true }),
      {
        homeDir: home,
        harnessIsClaude: true,
      },
    );
    expect(syncOf(res.data)?.skipped).toBe('no-tty');
    for (const rule of MODE_GATED_RULES) expect(syncOf(res.data)?.pointer).toContain(rule);
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
    // An empty allowlist reads the same whether the file is absent or was created
    // holding nothing, and only one of those is acceptable on a machine that is
    // not running Claude Code.
    expect(existsSync(claudeSettingsPath(home))).toBe(false);
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
      // No pointer either: there is no settings file of ours here to be missing
      // anything, so naming Claude rules would be advice about another machine.
      expect(syncOf(res.data)?.pointer).toBeUndefined();
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
        JSON.stringify({ permissions: { allow: [...FREE_VERB_RULES, ...MODE_GATED_RULES] } }),
      );
      const res = await runConfigSet({ key: 'publish.mode', value: 'review' }, makeCtx(), {
        homeDir: home,
        which: (bin) => bin === 'codex',
        env: { PATH: '' },
      });
      expect(await allowOf()).not.toContain(PUBLISH_MODE_RULE);
      expect(syncOf(res.data)?.removed).toEqual([...MODE_GATED_RULES]);
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
  it('round-trips every hook key and rejects a value outside the enum', async () => {
    const ctx = makeCtx();
    for (const [key, value] of [
      ['hooks.webSearch', 'remind'],
      ['hooks.agentDispatch', 'off'],
      ['hooks.stopNag', 'off'],
      ['hooks.sessionPrimer', 'off'],
      ['hooks.push', 'on'],
      ['hooks.capture', 'block'],
    ] as const) {
      const set = await runConfigSet({ key, value }, ctx);
      expect(set.data).toMatchObject({ key, value, source: 'file' });
      expect(await runConfigGet({ key }, ctx)).toMatchObject({
        data: { key, value, source: 'file' },
      });
    }
    // Legacy aliases still work and map to the new keys.
    expect(await runConfigGet({ key: 'hooks.searchMode' }, ctx)).toMatchObject({
      data: { value: 'remind' },
    });
    expect(await runConfigGet({ key: 'hooks.dispatchMode' }, ctx)).toMatchObject({
      data: { value: 'off' },
    });
    // Every subkey survives the others' writes, so silencing one hook cannot
    // silently reset another.
    expect(await runConfigGet({ key: 'hooks.webSearch' }, ctx)).toMatchObject({
      data: { value: 'remind' },
    });
    expect(await runConfigGet({ key: 'hooks.stopNag' }, ctx)).toMatchObject({
      data: { value: 'off' },
    });
    expect(await runConfigGet({ key: 'hooks.push' }, ctx)).toMatchObject({
      data: { value: 'on' },
    });
    expect(await runConfigGet({ key: 'hooks.capture' }, ctx)).toMatchObject({
      data: { value: 'block' },
    });

    expect(await runConfigGet({ key: 'hooks.agentDispatch' }, ctx)).toMatchObject({
      data: { value: 'off' },
    });

    const dispatch = await caught(() =>
      runConfigSet({ key: 'hooks.agentDispatch', value: 'sometimes' }, ctx),
    );
    expect(dispatch.code).toBe('USAGE');
    expect(dispatch.fix).toContain('"off"');

    const primer = await caught(() =>
      runConfigSet({ key: 'hooks.sessionPrimer', value: 'sometimes' }, ctx),
    );
    expect(primer.code).toBe('USAGE');
    expect(primer.fix).toContain('"off"');

    const bad = await caught(() => runConfigSet({ key: 'hooks.stopNag', value: 'sometimes' }, ctx));
    expect(bad.code).toBe('USAGE');
    expect(bad.fix).toContain('"on"');
    // The middle setting is offered by name, or an operator hunting for it
    // finds only the cliff.
    expect(bad.fix).toContain('"deliberate-only"');

    const badPush = await caught(() =>
      runConfigSet({ key: 'hooks.push', value: 'sometimes' }, ctx),
    );
    expect(badPush.code).toBe('USAGE');
    expect(badPush.fix).toContain('"on"');
    expect(badPush.fix).toContain('"off"');

    const badCapture = await caught(() =>
      runConfigSet({ key: 'hooks.capture', value: 'sometimes' }, ctx),
    );
    expect(badCapture.code).toBe('USAGE');
    expect(badCapture.fix).toContain('"block"');
    expect(badCapture.fix).toContain('"nudge"');
  });

  // hooks.push is read by the push arms, which ship in the same build as the key
  // itself, so there is no version of them that ignores it.
  it('never reports hookScriptStale for push', async () => {
    const ctx = makeCtx();
    const push = await runConfigSet({ key: 'hooks.push', value: 'on' }, ctx, {
      stopHookIsCurrent: async () => false,
    });
    expect(push.data).not.toHaveProperty('hookScriptStale');
  });

  /**
   * `hooks.push` is the one hooks key whose value is not the whole switch: the
   * seven settings entries are written by `tenjin push on`, and `config set` only
   * persists the key — so it echoed as effective while no arm fired.
   * command-reference.md already gave the guidance; the CLI accepted it silently.
   */
  it('points hooks.push at `tenjin push on`, because config set wires nothing', async () => {
    const ctx = makeCtx();
    const push = await runConfigSet({ key: 'hooks.push', value: 'on' }, ctx);
    expect(push.data).toMatchObject({ hookEntriesNotWired: true });
    expect((push.humanLines ?? []).join('\n')).toContain('tenjin push on');
    // The value is still stored: this is an honest line, not a refusal.
    expect(await runConfigGet({ key: 'hooks.push' }, ctx)).toMatchObject({
      data: { value: 'on', source: 'file' },
    });
  });

  it('says nothing for `off`, which is what an unwired machine already does', async () => {
    const ctx = makeCtx();
    const push = await runConfigSet({ key: 'hooks.push', value: 'off' }, ctx);
    expect(push.data).not.toHaveProperty('hookEntriesNotWired');
    expect(push.humanLines).toHaveLength(1);
  });

  /**
   * Worse than `deliberate-only`'s misread: a Stop hook written before
   * `hooks.capture` existed does not read the key at all. Setting `block` on one
   * of those asks for nothing, while `config get` reports `value=block
   * source=file` — the operator watches sessions end silently and has no way to
   * tell the setting from the script.
   */
  it('says so when the installed Stop hook predates hooks.capture', async () => {
    const ctx = makeCtx();
    for (const value of ['block', 'nudge']) {
      const set = await runConfigSet({ key: 'hooks.capture', value }, ctx, {
        stopHookIsCurrent: async () => false,
      });
      expect(set.data).toMatchObject({ value, hookScriptStale: true });
      expect(set.humanLines?.join('\n')).toContain('tenjin install');
    }
    // Stored regardless: the line reports the script, it does not refuse the set.
    expect(await runConfigGet({ key: 'hooks.capture' }, ctx)).toMatchObject({
      data: { value: 'nudge', source: 'file' },
    });
  });

  it('stays quiet about capture on a current script, and about `off` on any', async () => {
    const ctx = makeCtx();
    const current = await runConfigSet({ key: 'hooks.capture', value: 'block' }, ctx, {
      stopHookIsCurrent: async () => true,
    });
    expect(current.data).not.toHaveProperty('hookScriptStale');
    expect(current.humanLines).toHaveLength(1);

    // `off` is exactly what a script that never heard of the key already does.
    const off = await runConfigSet({ key: 'hooks.capture', value: 'off' }, ctx, {
      stopHookIsCurrent: async () => false,
    });
    expect(off.data).not.toHaveProperty('hookScriptStale');
    expect(off.humanLines).toHaveLength(1);
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

  /**
   * `deliberate-only` is a value only the current script understands: an older
   * installed script maps every non-`off` value to `on`. Storing it and saying
   * nothing leaves the operator watching the batch keep firing while `config get`
   * reports the setting effective.
   */
  it('says so when the installed Stop hook predates deliberate-only', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'hooks.stopNag', value: 'deliberate-only' }, ctx, {
      stopHookIsCurrent: async () => false,
    });
    expect(set.data).toMatchObject({ value: 'deliberate-only', hookScriptStale: true });
    expect(set.humanLines?.join('\n')).toContain('tenjin install');
    // Stored regardless: the line reports the script, it does not refuse the set.
    expect(await runConfigGet({ key: 'hooks.stopNag' }, ctx)).toMatchObject({
      data: { value: 'deliberate-only', source: 'file' },
    });
  });

  it('stays quiet on a current script, and on the values an old script honors', async () => {
    const ctx = makeCtx();
    const current = await runConfigSet({ key: 'hooks.stopNag', value: 'deliberate-only' }, ctx, {
      stopHookIsCurrent: async () => true,
    });
    expect(current.data).not.toHaveProperty('hookScriptStale');
    expect(current.humanLines).toHaveLength(1);

    // `off` and `on` mean the same thing to every script version ever shipped,
    // so a stale script is not worth a line about them.
    const off = await runConfigSet({ key: 'hooks.stopNag', value: 'off' }, ctx, {
      stopHookIsCurrent: async () => false,
    });
    expect(off.data).not.toHaveProperty('hookScriptStale');
    expect(off.humanLines).toHaveLength(1);
  });
});

describe('runConfigSet: the bazaarPay toggle places the tenjin-pay skill', () => {
  it('places on true, removes on false, and only for bazaarPay', async () => {
    const ctx = makeCtx();
    const home = await mkdtemp(join(tmpdir(), 'tenjin-cfg-home-'));
    try {
      // A wired directory (any shipped skill present) is the consent gate.
      const wired = join(home, '.claude', 'skills', 'tenjin-search');
      await mkdir(wired, { recursive: true });
      await writeFile(join(wired, 'SKILL.md'), '---\nname: tenjin-search\n---\nx\n');
      const placeSkill = { io: ctx.io, homeDir: home, skillsSourceDir: SKILLS_SRC };
      const payPath = join(home, '.claude', 'skills', 'tenjin-pay', 'SKILL.md');

      await runConfigSet({ key: 'bazaarPay', value: 'true' }, ctx, { placeSkill });
      expect(await readFile(payPath, 'utf8')).toContain('name: tenjin-pay');

      await runConfigSet({ key: 'baseUrl', value: 'https://tenjin.blog' }, ctx, { placeSkill });
      expect(existsSync(payPath)).toBe(true); // untouched by an unrelated key

      await runConfigSet({ key: 'bazaarPay', value: 'false' }, ctx, { placeSkill });
      expect(existsSync(payPath)).toBe(false);
      expect(existsSync(join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md'))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('a placement failure never fails the set itself', async () => {
    const ctx = makeCtx();
    const result = await runConfigSet({ key: 'bazaarPay', value: 'false' }, ctx, {
      placeSkill: { io: ctx.io, homeDir: 'relative-home' },
    });
    expect((result.data as { value: boolean }).value).toBe(false);
  });

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

describe('the shelf keys', () => {
  const SECRET = 'shelf-secret-abc123';

  it('takes publicShelfUrl as a URL and refuses anything else', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'publicShelfUrl', value: 'https://public.example' }, ctx);
    expect(set.data).toMatchObject({
      key: 'publicShelfUrl',
      value: 'https://public.example',
      source: 'file',
    });
    await expect(
      runConfigSet({ key: 'publicShelfUrl', value: 'not-a-url' }, ctx),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  /**
   * A door key that gets a request past Deployment Protection. `--json` is what
   * an agent reads and what a bug report pastes, so the redaction has to be in
   * `data`, not only in the rendered line — and it has to hold on the SET echo,
   * which is the one place the value was just typed.
   */
  it('never echoes the bypass secret, on set, get, or list', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'shelfBypassSecret', value: SECRET }, ctx);
    expect(set.data).toMatchObject({ key: 'shelfBypassSecret', value: 'set', source: 'file' });
    expect(JSON.stringify(set)).not.toContain(SECRET);

    const got = await runConfigGet({ key: 'shelfBypassSecret' }, ctx);
    expect(got.data).toMatchObject({ value: 'set', source: 'file' });
    expect(JSON.stringify(got)).not.toContain(SECRET);

    const listed = await runConfigList(ctx);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    // The operator's own file still holds it: this is redaction of an output,
    // not encryption of a setting.
    expect(JSON.parse(await readFile(configFile(), 'utf8')).shelfBypassSecret).toBe(SECRET);
  });

  /** And the file it lands in is a secret file, like every other one in the tree. */
  it.skipIf(process.platform === 'win32')(
    'leaves config.json at 0600 once it holds the door key',
    async () => {
      await runConfigSet({ key: 'shelfBypassSecret', value: SECRET }, makeCtx());
      expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    },
  );

  it('clears back to unset with an empty value, which is how team mode is turned off', async () => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'shelfBypassSecret', value: SECRET }, ctx);
    const cleared = await runConfigSet({ key: 'shelfBypassSecret', value: '' }, ctx);
    expect(cleared.data).toMatchObject({ value: 'unset' });
    expect(JSON.parse(await readFile(configFile(), 'utf8')).shelfBypassSecret).toBe('');
  });

  /**
   * Team mode takes two settings, set by two independent commands, and the CLI
   * fails the half-wired state safe to PUBLIC mode. Safe, but silent is what
   * made it survivable: an operator who believes they are on a private shelf
   * would keep writing internal notes at a command that publishes to
   * tenjin.blog. So the half is named at the moment it is created.
   */
  it('warns when the secret is set while baseUrl is still the public marketplace', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'shelfBypassSecret', value: SECRET }, ctx);
    const warning = (set.data as { warning?: string }).warning ?? '';
    expect(warning).toContain('PUBLIC mode');
    expect(set.humanLines?.join('\n')).toContain('PUBLIC mode');
    expect(JSON.stringify(set)).not.toContain(SECRET);

    // Finishing the setup clears it, from either side of the pair.
    const based = await runConfigSet({ key: 'baseUrl', value: 'https://backtrack.tenjin.sh' }, ctx);
    expect(based.data).not.toHaveProperty('warning');
  });

  /**
   * The third key of the same triple. `isTeamShelfOrigin` returns false when
   * baseUrl matches publicShelfUrl too, so pointing the public shelf at the team
   * deployment drops the machine out of team mode exactly as unsetting the secret
   * would — silently, on a key the other two warnings never looked at.
   */
  it('warns when publicShelfUrl is pointed at the team shelf itself', async () => {
    const ctx = makeCtx();
    const TEAM = 'https://backtrack.tenjin.sh';
    await runConfigSet({ key: 'shelfBypassSecret', value: SECRET }, ctx);
    const based = await runConfigSet({ key: 'baseUrl', value: TEAM }, ctx);
    expect(based.data).not.toHaveProperty('warning');

    const collided = await runConfigSet({ key: 'publicShelfUrl', value: TEAM }, ctx);
    const warning = (collided.data as { warning?: string }).warning ?? '';
    expect(warning).toContain('PUBLIC mode');
    // The fix names the key that broke the pair, not the other half of it.
    expect(warning).toContain('tenjin config set publicShelfUrl');
    expect(warning).not.toContain('config set baseUrl');
  });

  it('says nothing about team mode when no secret is set', async () => {
    const ctx = makeCtx();
    const based = await runConfigSet({ key: 'baseUrl', value: 'https://tenjin.blog' }, ctx);
    expect(based.data).not.toHaveProperty('warning');
  });
});

describe('loop.* and team.publicFallback (loop-redesign/07-pr-b-daemon-kernel.md)', () => {
  const LOOP_DEFAULT_LINES: Record<string, string> = {
    'loop.human_wait_ms': '2500',
    'loop.tool_wait_ms': '4000',
    'loop.idle_exit_min': '30',
    'loop.port': 'null',
  };

  it('lists every loop key and team.publicFallback with default provenance on a fresh dir', async () => {
    const { data, humanLines } = await runConfigList(makeCtx());
    const d = data as Record<string, { value: unknown; source: string }>;
    for (const key of LOOP_CONFIG_KEYS) {
      expect(d[key]).toEqual({ value: LOOP_DEFAULT_LINES[key], source: 'default' });
      const line = (humanLines ?? []).find((l) => l.includes(key));
      expect(line).toBeDefined();
      expect(line).toContain('(default)');
    }
    expect(d['team.publicFallback']).toEqual({ value: 'on', source: 'default' });
    const teamLine = (humanLines ?? []).find((l) => l.includes('team.publicFallback'));
    expect(teamLine).toContain('(default)');
  });

  it('set loop.port 31000 then get reports "31000" from file, and only that subkey is written', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'loop.port', value: '31000' }, ctx);
    expect(set.data).toEqual({ key: 'loop.port', value: '31000', source: 'file' });
    const got = await runConfigGet({ key: 'loop.port' }, ctx);
    expect(got.data).toEqual({ key: 'loop.port', value: '31000', source: 'file' });
    expect(got.humanLines).toHaveLength(1);
    expect(got.humanLines?.[0]).toContain('31000');
    // Provenance stays truthful: the untouched subkeys are not materialized.
    expect(await readRawFile()).toEqual({ loop: { port: 31000 } });
    const wait = await runConfigGet({ key: 'loop.tool_wait_ms' }, ctx);
    expect(wait.data).toMatchObject({ value: '4000', source: 'default' });
  });

  it('set loop.port null reads back as "null" from file', async () => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'loop.port', value: '31000' }, ctx);
    const set = await runConfigSet({ key: 'loop.port', value: 'null' }, ctx);
    expect(set.data).toEqual({ key: 'loop.port', value: 'null', source: 'file' });
    expect(await readRawFile()).toEqual({ loop: { port: null } });
    const got = await runConfigGet({ key: 'loop.port' }, ctx);
    expect(got.data).toEqual({ key: 'loop.port', value: 'null', source: 'file' });
  });

  it('set of a second loop key keeps the first', async () => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'loop.tool_wait_ms', value: '2' }, ctx);
    await runConfigSet({ key: 'loop.idle_exit_min', value: '1' }, ctx);
    expect(await readRawFile()).toEqual({ loop: { tool_wait_ms: 2, idle_exit_min: 1 } });
    const { data } = await runConfigList(ctx);
    const d = data as Record<string, { value: unknown; source: string }>;
    expect(d['loop.tool_wait_ms']).toEqual({ value: '2', source: 'file' });
    expect(d['loop.idle_exit_min']).toEqual({ value: '1', source: 'file' });
    expect(d['loop.human_wait_ms']).toEqual({ value: '2500', source: 'default' });
  });

  it('set team.publicFallback off then get reports off from file', async () => {
    const ctx = makeCtx();
    const set = await runConfigSet({ key: 'team.publicFallback', value: 'off' }, ctx);
    expect(set.data).toEqual({ key: 'team.publicFallback', value: 'off', source: 'file' });
    expect(await readRawFile()).toEqual({ team: { publicFallback: 'off' } });
    const got = await runConfigGet({ key: 'team.publicFallback' }, ctx);
    expect(got.data).toEqual({ key: 'team.publicFallback', value: 'off', source: 'file' });
    expect(got.humanLines).toHaveLength(1);
  });

  it.each([
    ['loop.tool_wait_ms', '0'],
    ['loop.tool_wait_ms', 'abc'],
    ['loop.tool_wait_ms', 'null'],
    ['loop.port', '70000'],
    ['loop.port', '-1'],
    ['team.publicFallback', 'maybe'],
  ])('set %s %s throws USAGE and writes nothing', async (key, value) => {
    const ctx = makeCtx();
    const err = await caught(() => runConfigSet({ key, value }, ctx));
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain(key);
    expect(existsSync(configFile())).toBe(false);
  });

  it('a bad set leaves an existing file untouched', async () => {
    const ctx = makeCtx();
    await runConfigSet({ key: 'loop.port', value: '31000' }, ctx);
    const before = await readFile(configFile(), 'utf8');
    await caught(() => runConfigSet({ key: 'loop.port', value: '70000' }, ctx));
    expect(await readFile(configFile(), 'utf8')).toBe(before);
  });
});

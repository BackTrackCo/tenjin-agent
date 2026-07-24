import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadRawConfig, resolveSettings, writeConfig, CONFIG_DEFAULTS } from './config';
import { CliError } from './errors';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-cfg-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const configFile = () => join(dir, 'config.json');

describe('loadConfig', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await loadConfig(dir)).toEqual(CONFIG_DEFAULTS);
  });

  it('merges file values over defaults', async () => {
    await writeFile(configFile(), JSON.stringify({ maxAutoSpend: '250000' }));
    const cfg = await loadConfig(dir);
    expect(cfg.maxAutoSpend).toBe('250000');
    expect(cfg.baseUrl).toBe(CONFIG_DEFAULTS.baseUrl);
  });

  it('throws CONFIG_INVALID on malformed JSON', async () => {
    await writeFile(configFile(), '{ not json');
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(CliError);
  });

  it('throws CONFIG_INVALID with the code on a schema violation', async () => {
    await writeFile(configFile(), JSON.stringify({ maxAutoSpend: 'not-atomic' }));
    let caught: unknown;
    try {
      await loadConfig(dir);
    } catch (e) {
      caught = e;
    }
    expect((caught as CliError).code).toBe('CONFIG_INVALID');
    expect((caught as CliError).fix).toBeDefined();
  });
});

describe('resolveSettings — precedence and provenance', () => {
  it('reports default provenance when nothing is set', async () => {
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.baseUrl).toEqual({ value: CONFIG_DEFAULTS.baseUrl, source: 'default' });
    expect(s.maxAutoSpend).toEqual({ value: '0', source: 'default' });
  });

  it('reports file provenance for a file-set key', async () => {
    await writeFile(configFile(), JSON.stringify({ baseUrl: 'https://file.example' }));
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.baseUrl).toEqual({ value: 'https://file.example', source: 'file' });
  });

  it('env overrides file for baseUrl', async () => {
    await writeFile(configFile(), JSON.stringify({ baseUrl: 'https://file.example' }));
    const config = await loadRawConfig(dir);
    const s = resolveSettings({
      config,
      flags: {},
      env: { TENJIN_BASE_URL: 'https://env.example' },
    });
    expect(s.baseUrl).toEqual({ value: 'https://env.example', source: 'env' });
  });

  it('flag overrides env and file for baseUrl', async () => {
    await writeFile(configFile(), JSON.stringify({ baseUrl: 'https://file.example' }));
    const config = await loadRawConfig(dir);
    const s = resolveSettings({
      config,
      flags: { baseUrl: 'https://flag.example' },
      env: { TENJIN_BASE_URL: 'https://env.example' },
    });
    expect(s.baseUrl).toEqual({ value: 'https://flag.example', source: 'flag' });
  });
});

describe('writeConfig', () => {
  it('round-trips through loadConfig', async () => {
    const next = { ...CONFIG_DEFAULTS, maxAutoSpend: '250000', allowlistCreators: ['0xabc'] };
    await writeConfig(dir, next);
    expect(await loadConfig(dir)).toEqual(next);
  });
});

describe('publish block', () => {
  it('defaults publish to review / $0.10 atomic', async () => {
    expect(CONFIG_DEFAULTS.publish).toEqual({ mode: 'review', defaultPrice: '100000' });
    expect((await loadConfig(dir)).publish).toEqual({ mode: 'review', defaultPrice: '100000' });
  });

  it('merges a partial publish block per-subkey (keeps the default it omits)', async () => {
    await writeFile(configFile(), JSON.stringify({ publish: { mode: 'review' } }));
    expect((await loadConfig(dir)).publish).toEqual({ mode: 'review', defaultPrice: '100000' });
  });

  it('resolveSettings exposes publishMode and publishDefaultPrice', async () => {
    await writeFile(
      configFile(),
      JSON.stringify({ publish: { mode: 'review', defaultPrice: '250000' } }),
    );
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.publishMode).toEqual({ value: 'review', source: 'file' });
    expect(s.publishDefaultPrice).toEqual({ value: '250000', source: 'file' });
  });
});

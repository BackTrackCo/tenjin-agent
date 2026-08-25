import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  loadRawConfig,
  resolveSettings,
  writeConfig,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  DEFAULT_BAZAAR_REGISTRIES,
} from './config';
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

describe('CONFIG_DEFAULTS.sendMaxAmount placeholder', () => {
  it('is the fail-closed placeholder (send disabled), never the uncapped value', () => {
    // resolveSendMaxAmount never reads this key (absent resolves to the
    // SEND_MAX_UNSET sentinel and send refuses), so the placeholder is
    // unreachable today. This pin exists for the day that stops being true: a
    // future caller reading the cap through loadConfig/fileOrDefault must get
    // "send disabled", not silently-uncapped 'none'.
    expect(CONFIG_DEFAULTS.sendMaxAmount).toBe('0');
  });
});

describe('DEFAULT_BAZAAR_REGISTRIES', () => {
  it('pins the verified default registries, in order', () => {
    // Every entry here was verified keyless (GET /discovery/resources answers
    // the Bazaar envelope with no credential) before joining the money path;
    // an addition that skips that verification must fail here first.
    expect(DEFAULT_BAZAAR_REGISTRIES).toEqual([
      'https://api.cdp.coinbase.com/platform/v2/x402',
      'https://facilitator.ultravioletadao.xyz',
      'https://facilitator.payai.network',
    ]);
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

  /**
   * config.json holds `shelfBypassSecret`, the team shelf's shared door key, so
   * it is a secret file and gets the 0600 every other secret in this tree gets.
   * dirMode 0o700 is not the backstop it looks like: node's recursive mkdir does
   * not chmod a directory that already exists, so a data dir a devcontainer
   * volume or a restored backup created at 0755 leaves a 0644 config readable
   * by anyone on the box.
   */
  it.skipIf(process.platform === 'win32')('writes config.json at 0600', async () => {
    await writeConfig(dir, { ...CONFIG_DEFAULTS, shelfBypassSecret: 'shelf-secret-abc123' });
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'still lands at 0600 inside a data dir that already exists at 0755',
    async () => {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o755);
      await writeConfig(dir, { ...CONFIG_DEFAULTS, shelfBypassSecret: 'shelf-secret-abc123' });
      expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    },
  );
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

describe('hooks block: push and capture (docs/command-reference.md#push-experimental)', () => {
  it('default off for both, read at run time by the installed scripts', async () => {
    expect(CONFIG_DEFAULTS.hooks.push).toBe('off');
    expect(CONFIG_DEFAULTS.hooks.capture).toBe('off');
    expect((await loadConfig(dir)).hooks.push).toBe('off');
    expect((await loadConfig(dir)).hooks.capture).toBe('off');
  });

  it('merges a partial hooks block per-subkey (keeps the defaults it omits)', async () => {
    await writeFile(configFile(), JSON.stringify({ hooks: { push: 'on' } }));
    const cfg = await loadConfig(dir);
    expect(cfg.hooks.push).toBe('on');
    expect(cfg.hooks.capture).toBe('off');
    expect(cfg.hooks.webSearch).toBe(CONFIG_DEFAULTS.hooks.webSearch);
  });

  it('resolveSettings exposes hooksPush and hooksCapture, file over default', async () => {
    await writeFile(configFile(), JSON.stringify({ hooks: { push: 'on', capture: 'nudge' } }));
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.hooksPush).toEqual({ value: 'on', source: 'file' });
    expect(s.hooksCapture).toEqual({ value: 'nudge', source: 'file' });
  });

  it('resolveSettings reports default provenance when unset', async () => {
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.hooksPush).toEqual({ value: 'off', source: 'default' });
    expect(s.hooksCapture).toEqual({ value: 'off', source: 'default' });
  });

  it('rejects a value outside either enum', async () => {
    await writeFile(configFile(), JSON.stringify({ hooks: { push: 'sometimes' } }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(CliError);
    await writeFile(configFile(), JSON.stringify({ hooks: { capture: 'sometimes' } }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(CliError);
  });
});

describe('install block', () => {
  it('defaults to no recorded harness', async () => {
    expect(CONFIG_DEFAULTS.install).toEqual({ harness: [] });
    expect((await loadConfig(dir)).install).toEqual({ harness: [] });
  });

  it('reads back the recorded targets', async () => {
    await writeFile(configFile(), JSON.stringify({ install: { harness: ['claude', 'shared'] } }));
    expect((await loadConfig(dir)).install.harness).toEqual(['claude', 'shared']);
  });

  it('rejects a harness name install could not have written', async () => {
    await writeFile(configFile(), JSON.stringify({ install: { harness: ['cursor'] } }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(CliError);
  });

  it('is not a `config set` key: it is never rendered as a scalar', () => {
    expect(CONFIG_KEYS as readonly string[]).not.toContain('install');
    expect(CONFIG_KEYS as readonly string[]).not.toContain('publish');
  });
});

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
  ROUTER_CONFIG_KEYS,
  parseOnOffFlag,
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

  // Every key an earlier release wrote and this one no longer reads: the
  // shelf's blocks, team mode and the harness record. A machine that ran the
  // shelf keeps its file, so it must load, resolve and stay in force as is.
  it('loads a file that still carries the removed shelf keys, and reads the rest', async () => {
    const legacy = {
      maxAutoSpend: '500000',
      baseUrl: 'https://router.example',
      publicShelfUrl: 'https://tenjin.sh',
      shelfBypassSecret: 'door-key',
      evalCohort: true,
      publish: { mode: 'full-auto', defaultPrice: '100000', ackServerWarnings: 'on' },
      hooks: { prompt: false, 'web-search': true, primer: false },
      loop: { human_wait_ms: 2500, tool_wait_ms: 4000, idle_exit_min: 30, port: null },
      team: { publicFallback: 'off' },
      install: { harness: ['shared'], grantDeclined: ['Bash(tenjin search:*)'] },
      router: { enabled: false },
    };
    await writeFile(configFile(), JSON.stringify(legacy));

    const raw = await loadRawConfig(dir);
    expect(raw).toMatchObject(legacy);
    const cfg = await loadConfig(dir);
    expect(cfg.maxAutoSpend).toBe('500000');
    expect(cfg.router).toEqual({ enabled: false, context: 'session' });
    expect(cfg.install).toEqual({ routerProjects: [] });
    const s = resolveSettings({ config: raw, flags: {}, env: {} });
    expect(s.baseUrl).toEqual({ value: 'https://router.example', source: 'file' });
    expect(s.maxAutoSpend).toEqual({ value: '500000', source: 'file' });
    expect(Object.keys(s)).not.toContain('publicShelfUrl');
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
    expect(s.maxAutoSpend).toEqual({ value: '250000', source: 'default' });
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
   * config.json can hold an RPC provider's key inside `rpcUrl`, so it gets the
   * 0600 every other secret in this tree gets. dirMode 0o700 is not the
   * backstop it looks like: node's recursive mkdir does not chmod a directory
   * that already exists, so a data dir a devcontainer volume or a restored
   * backup created at 0755 leaves a 0644 config readable by anyone on the box.
   */
  const WITH_KEY = { ...CONFIG_DEFAULTS, rpcUrl: 'https://base.example/v2/rpc-key-abc123' };
  it.skipIf(process.platform === 'win32')('writes config.json at 0600', async () => {
    await writeConfig(dir, WITH_KEY);
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'still lands at 0600 inside a data dir that already exists at 0755',
    async () => {
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o755);
      await writeConfig(dir, WITH_KEY);
      expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    },
  );
});

describe('install block', () => {
  it('defaults to no wired project', async () => {
    expect(CONFIG_DEFAULTS.install).toEqual({ routerProjects: [] });
    expect((await loadConfig(dir)).install).toEqual({ routerProjects: [] });
  });

  it('reads back the wired projects', async () => {
    await writeFile(configFile(), JSON.stringify({ install: { routerProjects: ['/p/a'] } }));
    expect((await loadConfig(dir)).install.routerProjects).toEqual(['/p/a']);
  });

  it('is not a `config set` key: it is never rendered as a scalar', () => {
    expect(CONFIG_KEYS as readonly string[]).not.toContain('install');
  });
});

describe('parseOnOffFlag', () => {
  it('accepts on and off', () => {
    expect(parseOnOffFlag('on', 'experimental.bazaar')).toBe('on');
    expect(parseOnOffFlag('off', 'experimental.bazaar')).toBe('off');
  });

  it('rejects anything else with USAGE naming the key', () => {
    let caught: unknown;
    try {
      parseOnOffFlag('maybe', 'experimental.bazaar');
    } catch (e) {
      caught = e;
    }
    expect((caught as CliError).code).toBe('USAGE');
    expect((caught as CliError).message).toContain('experimental.bazaar');
    expect((caught as CliError).fix).toBe('Use "on" or "off".');
  });
});

describe('router block: the switch and the context', () => {
  it('registers two dotted keys and no scalar', () => {
    expect(ROUTER_CONFIG_KEYS).toEqual(['router.enabled', 'router.context']);
    expect(CONFIG_KEYS as string[]).not.toContain('router');
    expect(CONFIG_DEFAULTS.router).toEqual({ enabled: true, context: 'session' });
  });

  it('loads a partial block over the defaults and keeps an unknown subkey', async () => {
    await writeFile(configFile(), JSON.stringify({ router: { context: 'turn', later: 1 } }));
    expect((await loadConfig(dir)).router).toEqual({ enabled: true, context: 'turn' });
    expect((await loadRawConfig(dir)).router).toEqual({ context: 'turn', later: 1 });
  });

  it.each([[{ router: { enabled: 'no' } }], [{ router: { context: 'all' } }]])(
    'rejects %j as CONFIG_INVALID',
    async (body) => {
      await writeFile(configFile(), JSON.stringify(body));
      const err = await loadRawConfig(dir).catch((e: unknown) => e);
      expect((err as CliError).code).toBe('CONFIG_INVALID');
    },
  );
});

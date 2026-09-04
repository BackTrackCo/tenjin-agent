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
  LOOP_CONFIG_KEYS,
  TEAM_CONFIG_KEYS,
  parseLoopValue,
  parsePublicFallbackFlag,
  resolveLoopConfig,
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
  const PUBLISH_DEFAULTS = {
    mode: 'review',
    defaultPrice: '100000',
    ackServerWarnings: 'mode',
  } as const;

  it('defaults publish to review / $0.10 atomic / mode-derived server acks', async () => {
    expect(CONFIG_DEFAULTS.publish).toEqual(PUBLISH_DEFAULTS);
    expect((await loadConfig(dir)).publish).toEqual(PUBLISH_DEFAULTS);
  });

  it('merges a partial publish block per-subkey (keeps the defaults it omits)', async () => {
    await writeFile(configFile(), JSON.stringify({ publish: { mode: 'review' } }));
    expect((await loadConfig(dir)).publish).toEqual(PUBLISH_DEFAULTS);
  });

  // The key only ever LOOSENS what a yes covers, so a `.tenjin.json` a cloned
  // repo carries must not be able to set it: global config or the default.
  it('takes publish.ackServerWarnings from the global config only', async () => {
    expect(resolveSettings({ config: {}, flags: {}, env: {} }).publishAckServerWarnings).toEqual({
      value: 'mode',
      source: 'default',
    });
    expect(
      resolveSettings({
        config: { publish: { ackServerWarnings: 'off' } },
        flags: {},
        env: {},
        project: { publish: { ackServerWarnings: 'on' } } as never,
      }).publishAckServerWarnings,
    ).toEqual({ value: 'off', source: 'file' });
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
  it('defaults to no recorded harness and no recorded decline', async () => {
    expect(CONFIG_DEFAULTS.install).toEqual({ harness: [], freeVerbsDeclined: [] });
    expect((await loadConfig(dir)).install).toEqual({ harness: [], freeVerbsDeclined: [] });
  });

  it('reads back the recorded targets', async () => {
    await writeFile(configFile(), JSON.stringify({ install: { harness: ['claude', 'shared'] } }));
    expect((await loadConfig(dir)).install.harness).toEqual(['claude', 'shared']);
  });

  it('reads back a recorded free-verb decline as the exact declined rules', async () => {
    await writeFile(
      configFile(),
      JSON.stringify({ install: { freeVerbsDeclined: ['Bash(tenjin search:*)'] } }),
    );
    expect((await loadConfig(dir)).install.freeVerbsDeclined).toEqual(['Bash(tenjin search:*)']);
  });

  // Before tenjin-agent#234's rewrite from a suppress-everything flag to a
  // per-rule list, this key held a boolean. A machine that already wrote
  // `true` must not fail CONFIG_INVALID on the next read, but a boolean has no
  // per-rule information to recover, so it reads back as "nothing specific is
  // known to be declined" either way — the safe direction (worst case a
  // settled decline is reported pending once more; never a rule silently
  // dropped from this list).
  it('tolerates the old freeVerbsDeclined boolean and treats it as nothing declined', async () => {
    await writeFile(configFile(), JSON.stringify({ install: { freeVerbsDeclined: true } }));
    expect((await loadConfig(dir)).install.freeVerbsDeclined).toEqual([]);

    await writeFile(configFile(), JSON.stringify({ install: { freeVerbsDeclined: false } }));
    expect((await loadConfig(dir)).install.freeVerbsDeclined).toEqual([]);
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

describe('loop and team blocks (loop-redesign/07-pr-b-daemon-kernel.md)', () => {
  const LOOP_DEFAULTS = {
    human_wait_ms: 2500,
    tool_wait_ms: 4000,
    rate_per_min: 3,
    burst: 6,
    idle_exit_min: 30,
    port: null,
  } as const;

  it('defaults to the four budget numbers, two daemon knobs, and public fallback on', async () => {
    expect(CONFIG_DEFAULTS.loop).toEqual(LOOP_DEFAULTS);
    expect(CONFIG_DEFAULTS.team).toEqual({ publicFallback: 'on' });
    const cfg = await loadConfig(dir);
    expect(cfg.loop).toEqual(LOOP_DEFAULTS);
    expect(cfg.team).toEqual({ publicFallback: 'on' });
  });

  it('merges a partial loop/team block per subkey (keeps the defaults it omits)', async () => {
    await writeFile(
      configFile(),
      JSON.stringify({ loop: { port: 31000 }, team: { publicFallback: 'off' } }),
    );
    const cfg = await loadConfig(dir);
    expect(cfg.loop).toEqual({ ...LOOP_DEFAULTS, port: 31000 });
    expect(cfg.team).toEqual({ publicFallback: 'off' });
  });

  it('resolveLoopConfig keeps an explicit port over the null default', () => {
    expect(resolveLoopConfig({ loop: { port: 0 } }).port).toBe(0);
    expect(resolveLoopConfig({}).port).toBeNull();
  });

  it.each([
    ['loop.burst 0', { loop: { burst: 0 } }],
    ['loop.port 70000', { loop: { port: 70000 } }],
    ['team.publicFallback "maybe"', { team: { publicFallback: 'maybe' } }],
  ])('rejects %s with CONFIG_INVALID', async (_label, raw) => {
    await writeFile(configFile(), JSON.stringify(raw));
    let caught: unknown;
    try {
      await loadConfig(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('CONFIG_INVALID');
  });

  // A newer CLI's loop key must survive an older binary's load + persist, the
  // same reason the outer object passes unknown keys through.
  it('passes an unknown loop subkey through loadRawConfig and drops it from the effective config', async () => {
    await writeFile(configFile(), JSON.stringify({ loop: { burst: 9, future_knob: 'x' } }));
    const raw = await loadRawConfig(dir);
    expect(raw.loop).toEqual({ burst: 9, future_knob: 'x' });
    expect(await loadConfig(dir)).toMatchObject({ loop: { ...LOOP_DEFAULTS, burst: 9 } });
    expect((await loadConfig(dir)).loop).not.toHaveProperty('future_knob');
  });

  it('resolveSettings reports file vs default per loop subkey', async () => {
    await writeFile(configFile(), JSON.stringify({ loop: { port: 31000, burst: 2 } }));
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.loop.port).toEqual({ value: 31000, source: 'file' });
    expect(s.loop.burst).toEqual({ value: 2, source: 'file' });
    expect(s.loop.human_wait_ms).toEqual({ value: 2500, source: 'default' });
    expect(s.loop.tool_wait_ms).toEqual({ value: 4000, source: 'default' });
    expect(s.loop.rate_per_min).toEqual({ value: 3, source: 'default' });
    expect(s.loop.idle_exit_min).toEqual({ value: 30, source: 'default' });
  });

  it('resolveSettings reports a file-set null port as file, not default', async () => {
    await writeFile(configFile(), JSON.stringify({ loop: { port: null } }));
    const config = await loadRawConfig(dir);
    const s = resolveSettings({ config, flags: {}, env: {} });
    expect(s.loop.port).toEqual({ value: null, source: 'file' });
  });

  it('resolveSettings reports teamPublicFallback file vs default', async () => {
    const fresh = resolveSettings({ config: await loadRawConfig(dir), flags: {}, env: {} });
    expect(fresh.teamPublicFallback).toEqual({ value: 'on', source: 'default' });

    await writeFile(configFile(), JSON.stringify({ team: { publicFallback: 'off' } }));
    const set = resolveSettings({ config: await loadRawConfig(dir), flags: {}, env: {} });
    expect(set.teamPublicFallback).toEqual({ value: 'off', source: 'file' });
  });

  it('exposes the dotted keys and keeps the blocks out of the scalar list', () => {
    expect(LOOP_CONFIG_KEYS).toEqual([
      'loop.human_wait_ms',
      'loop.tool_wait_ms',
      'loop.rate_per_min',
      'loop.burst',
      'loop.idle_exit_min',
      'loop.port',
    ]);
    expect(TEAM_CONFIG_KEYS).toEqual(['team.publicFallback']);
    expect(CONFIG_KEYS as readonly string[]).not.toContain('loop');
    expect(CONFIG_KEYS as readonly string[]).not.toContain('team');
  });

  describe('parseLoopValue', () => {
    const usage = (fn: () => unknown): CliError => {
      let caught: unknown;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).code).toBe('USAGE');
      return caught as CliError;
    };

    it('accepts a positive integer string for every key', () => {
      for (const key of LOOP_CONFIG_KEYS) expect(parseLoopValue(key, '12')).toBe(12);
    });

    it('accepts "null" and "auto" for loop.port only', () => {
      expect(parseLoopValue('loop.port', 'null')).toBeNull();
      expect(parseLoopValue('loop.port', 'auto')).toBeNull();
      expect(parseLoopValue('loop.port', '0')).toBe(0);
      expect(parseLoopValue('loop.port', '65535')).toBe(65535);
      for (const key of LOOP_CONFIG_KEYS) {
        if (key === 'loop.port') continue;
        usage(() => parseLoopValue(key, 'null'));
        usage(() => parseLoopValue(key, 'auto'));
      }
    });

    it.each(['-1', 'abc', '1.5', '', '0'])('rejects %j for a budget key with USAGE', (value) => {
      const err = usage(() => parseLoopValue('loop.burst', value));
      expect(err.fix).toBe('Use a positive integer.');
    });

    it('rejects a port outside 0..65535 and names the derive spelling', () => {
      const err = usage(() => parseLoopValue('loop.port', '70000'));
      expect(err.fix).toContain('"null"');
      usage(() => parseLoopValue('loop.port', '-1'));
      usage(() => parseLoopValue('loop.port', '1.5'));
    });
  });

  describe('parsePublicFallbackFlag', () => {
    it('accepts on and off', () => {
      expect(parsePublicFallbackFlag('on', 'team.publicFallback')).toBe('on');
      expect(parsePublicFallbackFlag('off', 'team.publicFallback')).toBe('off');
    });

    it('rejects anything else with USAGE naming the key', () => {
      let caught: unknown;
      try {
        parsePublicFallbackFlag('maybe', 'team.publicFallback');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).code).toBe('USAGE');
      expect((caught as CliError).message).toContain('team.publicFallback');
      expect((caught as CliError).fix).toBe('Use "on" or "off".');
    });
  });
});

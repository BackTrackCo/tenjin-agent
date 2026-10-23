import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookCommand, runHookKind } from './hook-command';
import { commandForm, handlersIn, shellDependence } from './hook-form';
import type { HookDeps } from './hooks';
import { noticeCleared, noticeFor } from './notice-markers';
import { WALLET_UNLOCKED } from './wallet-reasons';

describe('commandForm', () => {
  it('reads exec form from an args array and shell form from its absence', () => {
    expect(commandForm({ type: 'command', command: 'node', args: ['x.js'] })).toBe('exec');
    expect(commandForm({ type: 'command', command: 'tenjin hook alive' })).toBe('shell');
    expect(commandForm({ type: 'mcp_tool', server: 's', tool: 't' })).toBeNull();
  });
});

describe('shellDependence', () => {
  it('passes a node launch with an args array', () => {
    expect(shellDependence({ command: 'node', args: ['/a/index.js', 'mcp'] })).toBeNull();
  });

  it.each([
    [{ type: 'command', command: 'tenjin hook alive' }, /no args array/],
    [{ type: 'command', command: `echo '{"a":1}'` }, /no args array/],
    [{ command: 'node "/a b/index.js"', args: [] }, /shell syntax/],
    [{ command: 'tenjin', args: ['mcp', '--plugin'] }, /npm shim/],
    [{ command: 'C:\\npm\\tenjin.cmd', args: ['mcp'] }, /npm shim/],
    [{ command: 'node', args: ['-e', 1] }, /non-string/],
    [{ args: [] }, /no command/],
  ])('refuses %j', (launch, why) => {
    expect(shellDependence(launch)).toMatch(why);
  });
});

describe('handlersIn', () => {
  it('collects every handler under every event and skips malformed groups', () => {
    const a = { type: 'command', command: 'node', args: [] };
    const b = { type: 'mcp_tool', server: 's', tool: 't' };
    expect(
      handlersIn({ hooks: { SessionStart: [{ hooks: [a] }], PreToolUse: [{ hooks: [b] }, 7] } }),
    ).toEqual([a, b]);
    expect(handlersIn({ hooks: [] })).toEqual([]);
    expect(handlersIn(null)).toEqual([]);
  });
});

/**
 * THE ROUTER'S WALLET NEWS on a hook leg (B2): only for an event with a
 * session id, merged into `systemMessage` once, and acknowledged only after
 * the response carrying it is built.
 */
describe('runHookKind and wallet news', () => {
  const NATIVE = {
    schemaVersion: 1,
    routerVersion: 'v',
    decision: {
      action: 'native',
      diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
    },
  };
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hook-news-'));
    await mkdir(join(dir, '.git'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fetchImpl = (async () =>
    new Response(JSON.stringify(NATIVE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const prompt = (session?: string) => ({
    hook_event_name: 'UserPromptSubmit',
    ...(session !== undefined ? { session_id: session } : {}),
    cwd: dir,
    prompt: 'what is the current price of ETH in USD',
  });
  function deps(extra: Partial<HookDeps> = {}): HookDeps {
    return {
      dataDir: dir,
      baseUrl: 'https://router.test',
      fetchImpl,
      warn: () => undefined,
      env: {},
      ...extra,
    };
  }
  /** A walletNews that records its calls, acks and releases, in order. */
  function news(lines: string[], told?: string) {
    const log: string[] = [];
    const walletNews = vi.fn(async (sessionId: string) => {
      log.push(`news:${sessionId}`);
      return {
        lines,
        ...(told !== undefined ? { told } : {}),
        ack: async () => {
          log.push('ack');
        },
        release: () => {
          log.push('release');
        },
      };
    });
    return { walletNews, log };
  }

  it('merges the lines into systemMessage once, and acks after the response is built', async () => {
    const { walletNews, log } = news(['Tenjin wallet is still locked: x. y', 'second line']);
    const answer = await runHookKind('prompt', prompt('s1'), deps({ walletNews }));
    expect(answer).toEqual({ systemMessage: 'Tenjin wallet is still locked: x. y\nsecond line' });
    expect(walletNews).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['news:s1', 'ack']);
  });

  it('never calls walletNews for an event without a session_id', async () => {
    const { walletNews } = news(['x']);
    await runHookKind('prompt', prompt(), deps({ walletNews })).catch(() => undefined);
    expect(walletNews).not.toHaveBeenCalled();
  });

  it('releases, and does not ack, when the dispatch throws', async () => {
    // No WALLET_UNLOCKED, so nothing before the dispatch reads the clock:
    // the throw comes from inside the prompt handler.
    const { walletNews, log } = news(['a queued line']);
    const now = vi.fn((): number => {
      throw new Error('clock gone');
    });
    await expect(runHookKind('prompt', prompt('s1'), deps({ walletNews, now }))).rejects.toThrow(
      'clock gone',
    );
    expect(now).toHaveBeenCalled();
    expect(log).toEqual(['news:s1', 'release']);
  });

  it('releases the lines when settling the unlocked line throws', async () => {
    const { walletNews, log } = news([WALLET_UNLOCKED]);
    await expect(
      runHookKind(
        'prompt',
        prompt('s1'),
        deps({
          walletNews,
          now: () => {
            throw new Error('clock gone');
          },
        }),
      ),
    ).rejects.toThrow('clock gone');
    expect(log).toEqual(['news:s1', 'release']);
  });

  it('settles the session when the news says the wallet is unlocked', async () => {
    await noticeFor(dir, 's1', 'passphrase_missing', Date.now());
    const { walletNews } = news([WALLET_UNLOCKED]);
    const answer = await runHookKind('prompt', prompt('s1'), deps({ walletNews }));
    expect(answer).toEqual({ systemMessage: WALLET_UNLOCKED });
    // Already said: no second clear line, and the reason may be told again.
    expect(await noticeCleared(dir, 's1', Date.now())).toBeNull();
    expect(await noticeFor(dir, 's1', 'passphrase_missing', Date.now())).toBe('tell');
  });

  it('marks a still-locked reason told, so the fee notice for it stays quiet', async () => {
    const { walletNews } = news(['Tenjin wallet is still locked: x. y'], 'passphrase_missing');
    const answer = await runHookKind('prompt', prompt('s1'), deps({ walletNews }));
    expect(answer).toEqual({ systemMessage: 'Tenjin wallet is still locked: x. y' });
    expect(await noticeFor(dir, 's1', 'passphrase_missing', Date.now())).toBe('quiet');
    // Only that reason: another one is still news.
    expect(await noticeFor(dir, 's1', 'passphrase_wrong', Date.now())).toBe('tell');
  });

  it('leaves a leg with no news as it was', async () => {
    const { walletNews, log } = news([]);
    expect(await runHookKind('prompt', prompt('s1'), deps({ walletNews }))).toBeNull();
    expect(log).toEqual(['news:s1', 'ack']);
    expect(await runHookKind('prompt', prompt('s1'), deps())).toBeNull();
  });

  it('keeps the command form unchanged: it never passes walletNews', async () => {
    let out = '';
    await runHookCommand(
      'prompt',
      { stdout: { write: (s: string) => ((out += s), true) } } as never,
      { ...deps(), readEvent: async () => JSON.stringify(prompt('s1')) },
    );
    expect(out).toBe('');
  });
});

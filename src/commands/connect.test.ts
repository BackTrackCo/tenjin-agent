import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext, CommandResult } from '../context';
import { CliError } from '../lib/errors';
import { sourceVaultPath, sourcesDir } from '../lib/paths';
import { routerSettings } from '../router/settings';
import {
  AccountRefused,
  type AccountTool,
  type OpenAccountSession,
} from '../router/accounts/client';
import { storeAccountFor } from '../router/accounts/ids';
import { fakeAccountServer, fakeKeychain } from '../router/accounts/test-support';
import { clearVaultKeyCache, readVault, readVaultHeader } from '../router/accounts/vault';
import { persist } from './config';
import { runConfigFallback } from './config-rules';
import { runConnect, runDisconnect, type ConnectDeps } from './connect';

// THE SETTINGS WRITE, the real one unless a test makes it fail once.
vi.mock('./config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./config')>();
  return { ...orig, persist: vi.fn(orig.persist) };
});

/**
 * `tenjin connect` and `tenjin disconnect` end to end, on a real data dir,
 * against the identities read an `mcp` client gets (the shared fixture), a
 * scripted account server behind the injected fetch, a fake keychain and a
 * scripted MCP session. Nothing touches a real keychain, browser or network:
 * the only socket is the sign-in's own listener on 127.0.0.1, which the fake
 * browser calls.
 */

const IDENTITIES = readFileSync(
  new URL('../router/fixtures/wire-identities-mcp.json', import.meta.url),
  'utf8',
);
const ROUTER = 'https://router.example.test';

const APIFY_TOOLS: AccountTool[] = [
  { name: 'call-actor', arguments: ['actor', 'input', 'callOptions'] },
  { name: 'get-actor-run', arguments: ['runId'] },
  { name: 'get-dataset-items', arguments: ['datasetId', 'limit', 'fields', 'clean'] },
  { name: 'search-actors', arguments: ['keywords'] },
];
const FIRECRAWL_TOOLS: AccountTool[] = [
  { name: 'firecrawl_scrape', arguments: ['url', 'formats'] },
  { name: 'firecrawl_search', arguments: ['query', 'limit'] },
];
const FAL_TOOLS: AccountTool[] = [
  { name: 'run_model', arguments: ['endpoint_id', 'input'] },
  { name: 'check_job', arguments: ['endpoint_id', 'request_id'] },
  { name: 'get_job_result', arguments: ['endpoint_id', 'request_id'] },
  { name: 'check_account_status', arguments: [] },
];
const SESSIONS = {
  'https://mcp.apify.com': APIFY_TOOLS,
  'https://mcp.firecrawl.dev/v2/mcp-oauth': FIRECRAWL_TOOLS,
  'https://mcp.fal.ai/mcp-relay': FAL_TOOLS,
};

let dir: string;
let work: string;
let stderr: string[];
let keychain: ReturnType<typeof fakeKeychain>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-connect-'));
  work = join(dir, 'work');
  await mkdir(join(work, '.git'), { recursive: true });
  stderr = [];
  keychain = fakeKeychain();
  clearVaultKeyCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  return {
    flags: { json: false, timeout: 10_000, baseUrl: ROUTER },
    dataDir: dir,
    io: {
      stdout: { write: () => true } as unknown as NodeJS.WritableStream,
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      isTTY: false,
    },
  };
}

/** The router's free identities read, and the account server for everything else. */
function network(account?: ReturnType<typeof fakeAccountServer>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ROUTER}/api/x402-router`) {
      const body = JSON.parse(String(init?.body)) as { identities?: unknown; accepts?: string[] };
      if (body.identities !== true || !body.accepts?.includes('mcp'))
        throw new Error('connect asked the router something else');
      return new Response(IDENTITIES, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (account === undefined) throw new Error(`unexpected request to ${url}`);
    return account.fetchImpl(input, init);
  }) as typeof fetch;
}

/** A scripted MCP session: the tools each account lists, and what it saw. */
function sessions(
  tools: Record<string, AccountTool[]>,
  opts: { refuse?: boolean; checkFails?: boolean } = {},
) {
  const opened: { mcpUrl: string; headers: Record<string, string> }[] = [];
  const called: string[] = [];
  const open: OpenAccountSession = async (mcpUrl, headers) => {
    opened.push({ mcpUrl, headers });
    if (opts.refuse === true) throw new AccountRefused(401);
    return {
      listTools: async () => tools[mcpUrl] ?? [],
      callTool: async (name) => {
        called.push(name);
        return { content: [], isError: opts.checkFails === true };
      },
      close: async () => undefined,
    };
  };
  return { open, opened, called };
}

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    platform: 'darwin',
    exec: keychain.exec,
    ports: [0],
    waitMs: 5_000,
    clientMetadataUrl: 'https://tenjin.example.test/oauth/client-metadata.json',
    stdinIsTTY: false,
    env: {},
    now: () => Date.parse('2026-11-11T10:00:00.000Z'),
    cwd: work,
    ...over,
  };
}

const configJson = async () =>
  JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as {
    router?: { sources?: unknown[]; policy?: { prefer?: unknown[]; block?: unknown[] } };
  };
const lines = (result: CommandResult) => result.humanLines ?? [];
const data = (result: CommandResult) => result.data as Record<string, unknown>;

async function caught(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('expected the call to throw');
}

/** What a person reads names accounts by label: no ids, no protocol words. */
function userWords(result: CommandResult): void {
  // A command in backticks names what it acts on by id, as every readback does.
  for (const line of lines(result).map((l) => l.replace(/`[^`]*`/g, '`…`'))) {
    expect(line).not.toMatch(/\bwallet\b|x402|USDC|\bJev\b|\bsource\b/i);
    expect(line).not.toMatch(/\bapify\b|\bfirecrawl\b|apify\.google/);
  }
}

describe('tenjin connect', () => {
  it('signs in to Apify in the browser, checks its tools, saves it and puts it first', async () => {
    const account = fakeAccountServer({
      mcpUrl: 'https://mcp.apify.com',
      metadataInChallenge: false,
    });
    const mcp = sessions(SESSIONS);
    const before = await routerSettings({ cwd: work, dataDir: dir });
    const result = await runConnect(
      'apify',
      {},
      makeCtx(),
      deps({ fetchImpl: network(account), openUrl: account.browser, openSession: mcp.open }),
    );
    expect(lines(result).slice(0, 2)).toEqual([
      'Apify connected on this machine, for local business search and web research.',
      'Tenjin will use your Apify account first for those jobs once it has checked them with a real call; until then a job runs on it when you ask for Apify by name.',
    ]);
    expect(lines(result)).toContain(
      "Your Apify plan pays for these calls, which don't count toward your Tenjin limits.",
    );
    expect(lines(result)).toContain('To undo: `tenjin disconnect apify`');
    userWords(result);
    expect(data(result)).toMatchObject({
      operation: 'connect',
      changed: true,
      scope: 'user',
      reset: 'tenjin disconnect apify',
      account: {
        id: 'apify',
        signIn: 'oauth',
        jobs: ['local business search', 'web research'],
        missingTools: [],
        preference: 'added',
        undoPreference: 'tenjin config reset --source apify --preference',
      },
    });
    // The free check ran on the new token.
    expect(mcp.opened).toEqual([
      { mcpUrl: 'https://mcp.apify.com', headers: { authorization: 'Bearer access-1' } },
    ]);
    // The descriptor and the preference, and no credential, in the config.
    const config = await configJson();
    expect(config.router?.sources).toEqual([
      {
        id: 'apify',
        label: 'Apify',
        mcpUrl: 'https://mcp.apify.com',
        signIn: 'oauth',
        mapped: true,
        mappedTools: ['call-actor', 'get-actor-run', 'get-dataset-items'],
      },
    ]);
    expect(config.router?.policy?.prefer).toEqual([
      { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'apify' }] },
    ]);
    expect(JSON.stringify(config)).not.toMatch(/access-1|refresh-1/);
    // The sealed sign-in and its key.
    expect(await readVaultHeader(dir, 'apify')).toMatchObject({
      kind: 'oauth',
      store: 'keychain',
      expiresAt: '2026-11-11T11:00:00.000Z',
      missingTools: [],
    });
    expect(await readFile(sourceVaultPath('apify', dir), 'utf8')).not.toContain('access-1');
    expect([...keychain.entries.keys()]).toEqual([`tenjin-cli/${storeAccountFor('apify', dir)}`]);
    // Connected: the account rides in the settings every lookup sends, and
    // their hash is new, so no offer decided before it runs.
    const after = await routerSettings({ cwd: work, dataDir: dir });
    if (after.wire.status !== 'ok' || before.wire.status !== 'ok') throw new Error('unreadable');
    expect(after.wire.settings.sources).toEqual(['tenjin', 'apify']);
    expect(after.wire.settings.hash).not.toBe(before.wire.settings.hash);
  });

  it('extends an existing preference and leaves every other rule alone', async () => {
    const policy = {
      version: 1,
      block: [{ kind: 'provider', id: 'tavily' }],
      prefer: [
        { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'fal' }] },
        { scope: { kind: 'task', id: 'web research' }, targets: [{ kind: 'provider', id: 'exa' }] },
      ],
    };
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { policy } }));
    const mcp = sessions(SESSIONS);
    const result = await runConnect(
      'Firecrawl',
      { fromEnv: 'FC_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { FC_KEY: 'fc-secret-123' } }),
    );
    expect(data(result)).toMatchObject({ account: { preference: 'added', signIn: 'key' } });
    const saved = (await configJson()).router?.policy;
    expect(saved?.block).toEqual(policy.block);
    expect(saved?.prefer).toEqual([
      {
        scope: { kind: 'global' },
        targets: [
          { kind: 'source', id: 'fal' },
          { kind: 'source', id: 'firecrawl' },
        ],
      },
      policy.prefer[1],
    ]);
    // A key goes as the account sends it, and nowhere in the clear.
    expect(mcp.opened[0]?.headers).toEqual({ authorization: 'Bearer fc-secret-123' });
    expect(JSON.stringify(await configJson())).not.toContain('fc-secret-123');
    expect(await readFile(sourceVaultPath('firecrawl', dir), 'utf8')).not.toContain(
      'fc-secret-123',
    );
    expect(stderr.join('')).not.toContain('fc-secret-123');
    expect(lines(result)).toContain(
      'Tenjin can act on your Firecrawl account, and only runs the jobs above and the Firecrawl services you ask for by name.',
    );
    userWords(result);
  });

  it('never prefers an account the settings block, and keeps --no-prefer out of them', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: { policy: { version: 1, block: [{ kind: 'source', id: 'firecrawl' }] } },
      }),
    );
    const mcp = sessions(SESSIONS);
    const blocked = await runConnect(
      'firecrawl',
      { fromEnv: 'FC_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { FC_KEY: 'fc-1' } }),
    );
    expect(data(blocked)).toMatchObject({ account: { preference: 'blocked' } });
    expect(lines(blocked)).toContain(
      "Tenjin won't offer your Firecrawl account on its own. You or your agent can still pick it by name.",
    );
    expect((await configJson()).router?.policy?.prefer).toBeUndefined();

    const quiet = await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN', prefer: false },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    expect(data(quiet)).toMatchObject({ account: { preference: 'skipped' } });
    expect(lines(quiet)[1]).toContain('without putting it first');
    expect((await configJson()).router?.policy?.prefer).toBeUndefined();
    // Still connected: a connection alone adds eligibility, never a rule.
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.wire).toMatchObject({
      settings: { sources: ['tenjin', 'firecrawl', 'apify'] },
    });
  });

  it('never costs a working sign-in when a reconnect cannot save its settings', async () => {
    // Greptile: the save's catch deleted the vault even on a reconnect, so a
    // stale config.json.lock wiped the sign-in that was working before it.
    const mcp = sessions(SESSIONS);
    const connect = (key: string) =>
      runConnect(
        'firecrawl',
        { fromEnv: 'FC_KEY' },
        makeCtx(),
        deps({ fetchImpl: network(), openSession: mcp.open, env: { FC_KEY: key } }),
      );
    const stale = () =>
      vi
        .mocked(persist)
        .mockRejectedValueOnce(new CliError('INTERNAL', 'Timed out waiting for lock'));
    const vault = { dataDir: dir, platform: 'darwin' as const, exec: keychain.exec };
    // A first connect that can't save: its fresh sign-in comes back off.
    stale();
    expect((await caught(() => connect('fc-1'))).code).toBe('INTERNAL');
    expect(await readVault('firecrawl', 'Firecrawl', vault)).toEqual({ status: 'absent' });
    // Connected, then a reconnect that can't save: the old sign-in stays, as it was.
    await connect('fc-1');
    const before = await readFile(sourceVaultPath('firecrawl', dir), 'utf8');
    stale();
    expect((await caught(() => connect('fc-2'))).code).toBe('INTERNAL');
    expect(await readFile(sourceVaultPath('firecrawl', dir), 'utf8')).toBe(before);
    clearVaultKeyCache();
    expect(await readVault('firecrawl', 'Firecrawl', vault)).toMatchObject({
      status: 'ok',
      secret: { apiKey: 'fc-1' },
    });
  });

  it("keeps what the user chose for the account's refusals across a reconnect", async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          sources: [
            {
              id: 'apify',
              label: 'Apify',
              mcpUrl: 'https://mcp.apify.com',
              signIn: 'oauth',
              onRefusal: 'tenjin',
            },
          ],
        },
      }),
    );
    const mcp = sessions(SESSIONS);
    await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN', prefer: false },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    expect((await configJson()).router?.sources).toEqual([
      expect.objectContaining({ id: 'apify', signIn: 'key', onRefusal: 'tenjin' }),
    ]);
  });

  it('keeps the tools its maps call that this account lacks, and says the jobs that need them are out', async () => {
    const mcp = sessions({
      'https://mcp.apify.com': APIFY_TOOLS.filter(({ name }) => name !== 'get-actor-run'),
    });
    const result = await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    expect(data(result)).toMatchObject({ account: { missingTools: ['get-actor-run'] } });
    expect(lines(result)).toContain(
      "This Apify account doesn't have get-actor-run, so Tenjin leaves out the jobs that need it here.",
    );
    expect(await readVaultHeader(dir, 'apify')).toMatchObject({ missingTools: ['get-actor-run'] });
  });

  it('checks a pasted fal key with its free account tool, and saves nothing it cannot vouch for', async () => {
    const env = { FAL_KEY: 'key-id:key-secret' };
    const missing = sessions({
      'https://mcp.fal.ai/mcp-relay': FAL_TOOLS.filter(
        ({ name }) => name !== 'check_account_status',
      ),
    });
    const noCheck = await caught(() =>
      runConnect(
        'fal',
        { fromEnv: 'FAL_KEY' },
        makeCtx(),
        deps({ fetchImpl: network(), openSession: missing.open, env }),
      ),
    );
    expect(noCheck.message).toBe("fal didn't accept that key, so nothing was saved.");
    const failing = sessions(SESSIONS, { checkFails: true });
    await caught(() =>
      runConnect(
        'fal',
        { fromEnv: 'FAL_KEY' },
        makeCtx(),
        deps({ fetchImpl: network(), openSession: failing.open, env }),
      ),
    );
    await expect(readdir(sourcesDir(dir))).rejects.toThrow();
    expect(keychain.entries.size).toBe(0);

    const good = sessions(SESSIONS);
    await runConnect(
      'fal',
      { fromEnv: 'FAL_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: good.open, env }),
    );
    expect(good.called).toEqual(['check_account_status']);
    expect(good.opened[0]?.headers).toEqual({ authorization: 'Key key-id:key-secret' });
    // A fal key is written key_id:key_secret.
    const malformed = await caught(() =>
      runConnect(
        'fal',
        { fromEnv: 'BAD' },
        makeCtx(),
        deps({ fetchImpl: network(), openSession: good.open, env: { BAD: 'just-a-key' } }),
      ),
    );
    expect(malformed.message).toBe('A fal key is written key_id:key_secret. Nothing was saved.');
  });

  it('refuses an account that rejects the credential, and saves nothing', async () => {
    const mcp = sessions(SESSIONS, { refuse: true });
    const error = await caught(() =>
      runConnect(
        'apify',
        { fromEnv: 'APIFY_TOKEN' },
        makeCtx(),
        deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'wrong' } }),
      ),
    );
    expect(error.code).toBe('REFUSED');
    expect(error.message).toBe("Apify didn't accept that key, so nothing was saved.");
    await expect(readFile(join(dir, 'config.json'), 'utf8')).rejects.toThrow();
    expect(keychain.entries.size).toBe(0);
  });

  it('reads --paste only at a terminal, and never asks the agent for the key', async () => {
    const mcp = sessions(SESSIONS);
    const error = await caught(() =>
      runConnect(
        'apify',
        { paste: true },
        makeCtx(),
        deps({ fetchImpl: network(), openSession: mcp.open }),
      ),
    );
    expect(error.message).toBe(
      '--paste reads the key at a hidden prompt, which needs a terminal. Nothing was saved.',
    );
    expect(error.fix).toBe(
      'Ask the user to run `tenjin connect apify --paste` in their own terminal. Never ask for a key in chat.',
    );
    const asked: string[] = [];
    const result = await runConnect(
      'apify',
      { paste: true },
      makeCtx(),
      deps({
        fetchImpl: network(),
        openSession: mcp.open,
        stdinIsTTY: true,
        prompt: async (label) => {
          asked.push(label);
          return 'apify_api_pasted\n';
        },
      }),
    );
    expect(asked).toEqual(["Paste your Apify API key (it won't show): "]);
    expect(mcp.opened[0]?.headers).toEqual({ authorization: 'Bearer apify_api_pasted' });
    expect(data(result)).toMatchObject({ account: { signIn: 'key' } });
    // --paste and --from-env are one choice.
    expect(
      (await caught(() => runConnect('apify', { paste: true, fromEnv: 'X' }, makeCtx(), deps())))
        .code,
    ).toBe('USAGE');
  });

  it('connects an address it has no map for, runs it only when named, and names it to nobody', async () => {
    const mcp = sessions({
      'https://mcp.example.test/mcp': [{ name: 'lookup', arguments: ['q'] }],
    });
    const result = await runConnect(
      'https://mcp.example.test/mcp/',
      { fromEnv: 'EX_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { EX_KEY: 'ex-1' } }),
    );
    expect(lines(result).slice(0, 3)).toEqual([
      "Connected mcp.example.test on this machine. Tenjin doesn't know this service's jobs yet, so it won't pick it on its own. Ask for it by name and Tenjin will run it.",
      "Your mcp.example.test account pays for its calls, which don't count toward your Tenjin limits.",
      'Nothing about this service was sent to Tenjin.',
    ]);
    expect(data(result)).toMatchObject({
      account: { id: 'mcp-example-test', mapped: false, preference: 'skipped' },
    });
    expect((await configJson()).router?.sources).toEqual([
      {
        id: 'mcp-example-test',
        label: 'mcp.example.test',
        mcpUrl: 'https://mcp.example.test/mcp',
        signIn: 'key',
        keyScheme: 'Bearer',
      },
    ]);
    // Connected here, and never named to the router: its id comes from the
    // address's host name, which no lookup carries.
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.accounts.connected).toEqual(['mcp-example-test']);
    expect(settings.wire).toMatchObject({ settings: { sources: ['tenjin'] } });
    // An address that could carry anything else is refused before any request.
    for (const bad of [
      'http://mcp.example.test/mcp',
      'https://user:pw@mcp.example.test/mcp',
      'https://mcp.example.test/mcp?key=1',
    ]) {
      expect(
        (await caught(() => runConnect(bad, {}, makeCtx(), deps({ fetchImpl: network() })))).code,
      ).toBe('USAGE');
    }
  });

  it('names what it can connect when a name is unknown', async () => {
    const error = await caught(() =>
      runConnect('dropbox', {}, makeCtx(), deps({ fetchImpl: network() })),
    );
    expect(error.message).toBe(
      'Tenjin doesn\'t know an account called "dropbox". Nothing was saved.',
    );
    expect(error.fix).toBe(
      'Tenjin can connect Apify, fal, or Firecrawl, or any MCP server by its https address.',
    );
  });
});

describe('tenjin disconnect', () => {
  it('signs out, deletes the sign-in, and takes the account out of every preference', async () => {
    const account = fakeAccountServer({
      mcpUrl: 'https://mcp.apify.com',
      metadataInChallenge: false,
    });
    const mcp = sessions(SESSIONS);
    const net = network(account);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          policy: {
            version: 1,
            block: [{ kind: 'provider', id: 'tavily' }],
            prefer: [
              {
                scope: { kind: 'task', id: 'local business search' },
                targets: [{ kind: 'source', id: 'apify' }],
              },
            ],
          },
        },
      }),
    );
    await runConnect(
      'apify',
      {},
      makeCtx(),
      deps({ fetchImpl: net, openUrl: account.browser, openSession: mcp.open }),
    );
    const result = await runDisconnect('Apify', makeCtx(), deps({ fetchImpl: net }));
    expect(lines(result).slice(0, 2)).toEqual([
      'Apify is disconnected: Tenjin signed out of it and deleted the sign-in on this machine.',
      "It's no longer in your preferences. Your other settings and accounts stay as they are.",
    ]);
    expect(data(result)).toMatchObject({
      operation: 'disconnect',
      changed: true,
      reset: 'tenjin connect apify',
      account: { id: 'apify', signedOut: 'revoked' },
    });
    expect(account.seen.filter(({ url }) => url.endsWith('/revoke'))).toHaveLength(2);
    const config = await configJson();
    expect(config.router?.sources).toBeUndefined();
    // Blocks stay; the account's preferences go, every scope.
    expect(config.router?.policy).toEqual({
      version: 1,
      block: [{ kind: 'provider', id: 'tavily' }],
    });
    expect(await readVaultHeader(dir, 'apify')).toBeNull();
    expect(keychain.entries.size).toBe(0);
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.wire).toMatchObject({ settings: { sources: ['tenjin'] } });
  });

  it('says a pasted key still works at the provider, and changes nothing for an unknown name', async () => {
    const mcp = sessions(SESSIONS);
    await runConnect(
      'firecrawl',
      { fromEnv: 'FC_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { FC_KEY: 'fc-1' } }),
    );
    const result = await runDisconnect('firecrawl', makeCtx(), deps());
    expect(lines(result)[0]).toBe(
      'Firecrawl is disconnected: Tenjin deleted your Firecrawl key from this machine. The key itself still works at Firecrawl until you delete it there.',
    );
    const nothing = await runDisconnect('fal', makeCtx(), deps());
    expect(data(nothing)).toMatchObject({ changed: false });
    expect(lines(nothing)[0]).toBe("fal isn't connected on this machine. Nothing changed.");
  });
});

describe('tenjin config fallback', () => {
  it("saves, per account, whether Tenjin's tool runs when that account refuses, and reads it back", async () => {
    const mcp = sessions(SESSIONS);
    await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    const on = await runConfigFallback({ state: 'on', source: ['Apify'] }, makeCtx(), {
      cwd: work,
    });
    expect(data(on)).toMatchObject({
      operation: 'fallback',
      changed: true,
      reset: 'tenjin config fallback off --source apify',
      account: { id: 'apify', onRefusal: 'tenjin' },
      settings: {
        accounts: [{ id: 'apify', connected: true, preferred: true, onRefusal: 'tenjin' }],
      },
    });
    expect((await configJson()).router?.sources).toEqual([
      expect.objectContaining({ id: 'apify', onRefusal: 'tenjin' }),
    ]);
    const off = await runConfigFallback({ state: 'off', source: ['apify'] }, makeCtx(), {
      cwd: work,
    });
    expect(data(off)).toMatchObject({ changed: true, account: { onRefusal: 'ask' } });
    expect(
      (await caught(() => runConfigFallback({ state: 'on', source: ['fal'] }, makeCtx(), {}))).code,
    ).toBe('USAGE');
  });
});

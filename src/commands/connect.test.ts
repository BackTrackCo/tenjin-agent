import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext, CommandResult } from '../context';
import { CliError } from '../lib/errors';
import { sourceVaultPath, sourcesDir } from '../lib/paths';
import type { DirectoryListing } from '../router/decision';
import { routerSettings } from '../router/settings';
import { runRouterStatus } from '../router/status';
import {
  AccountRefused,
  type AccountTool,
  type OpenAccountSession,
} from '../router/accounts/client';
import { fakeAccountServer, fakeKeychain } from '../router/accounts/test-support';
import { clearVaultKeyCache, readVaultHeader } from '../router/accounts/vault';
import { runConnect, runDisconnect, type ConnectDeps } from './connect';

/**
 * `tenjin connect` and `tenjin disconnect` end to end, on a real data dir,
 * against the server's own directory fixture, a scripted account server
 * behind the injected fetch, a fake keychain and a scripted MCP session.
 * Nothing touches a real keychain, browser or network: the only socket is
 * the sign-in's own listener on 127.0.0.1, which the fake browser calls.
 */

const fixtures = new URL('../router/fixtures/', import.meta.url);
const DIRECTORY = JSON.parse(
  readFileSync(new URL('wire-directory-mcp.json', fixtures), 'utf8'),
) as {
  schemaVersion: 1;
  routerVersion: string;
  directory: DirectoryListing;
};

const APIFY_TOOLS: AccountTool[] = [
  { name: 'call-actor', arguments: ['actor', 'input', 'callOptions', 'waitSecs'] },
  { name: 'get-actor-run', arguments: ['runId'] },
  { name: 'get-dataset-items', arguments: ['datasetId', 'limit', 'offset', 'fields', 'clean'] },
  { name: 'search-actors', arguments: ['keywords'] },
];
const FIRECRAWL_TOOLS: AccountTool[] = [
  {
    name: 'firecrawl_scrape',
    arguments: ['url', 'objective', 'formats', 'onlyMainContent', 'parsers', 'pdfOptions'],
  },
  { name: 'firecrawl_search', arguments: ['query', 'objective', 'limit'] },
];
const FAL_TOOLS: AccountTool[] = [
  { name: 'run_model', arguments: ['endpoint_id', 'input'] },
  { name: 'check_job', arguments: ['endpoint_id', 'request_id'] },
  { name: 'get_job_result', arguments: ['endpoint_id', 'request_id'] },
  { name: 'check_account_status', arguments: [] },
];

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
    flags: { json: false, timeout: 10_000, baseUrl: 'https://router.example.test' },
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

/** The router's directory, and the account server for everything else. */
function network(
  account?: ReturnType<typeof fakeAccountServer>,
  listing: typeof DIRECTORY = DIRECTORY,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://router.example.test/api/x402-router') {
      const body = JSON.parse(String(init?.body)) as { directory?: unknown; accepts?: string[] };
      if (body.directory === undefined || !body.accepts?.includes('mcp'))
        throw new Error('connect asked the router something else');
      return new Response(JSON.stringify(listing), {
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

const SESSIONS = {
  'https://mcp.apify.com': APIFY_TOOLS,
  'https://mcp.firecrawl.dev/v2/mcp-oauth': FIRECRAWL_TOOLS,
  'https://mcp.fal.ai/mcp-relay': FAL_TOOLS,
};

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    platform: 'darwin',
    exec: keychain.exec,
    ports: [0],
    waitMs: 5_000,
    clientMetadataUrl: 'https://tenjin.example.test/oauth/client-metadata.json',
    stdinIsTTY: false,
    env: {},
    now: () => Date.parse('2026-10-23T10:00:00.000Z'),
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
    const result = await runConnect(
      'apify',
      {},
      makeCtx(),
      deps({ fetchImpl: network(account), openUrl: account.browser, openSession: mcp.open }),
    );
    expect(lines(result).slice(0, 5)).toEqual([
      'Apify connected on this machine.',
      'Tenjin will use it first for local business search.',
      "Your Apify plan pays for these calls, which don't count toward your Tenjin limits.",
      "Apify's sign-in lets Tenjin act on your whole Apify account. Tenjin only runs the jobs above and the Apify services you ask for by name.",
      'Say "don\'t prefer Apify" to stop putting it first (`tenjin config reset --source apify --preference`), or "disconnect Apify" to remove it.',
    ]);
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
        ready: ['apify.google-maps-places'],
        missing: [],
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
        // Its jobs' billing tool, which runs only through those jobs.
        mappedTools: ['call-actor'],
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
      expiresAt: '2026-10-23T11:00:00.000Z',
      ready: ['apify.google-maps-places'],
    });
    expect(await readFile(sourceVaultPath('apify', dir), 'utf8')).not.toContain('access-1');
    expect([...keychain.entries.keys()]).toEqual(['tenjin-cli/source:apify']);
    // Connected: the account rides in what the router is sent.
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.sources).toMatchObject({ status: 'ok', connected: ['apify'] });
    expect(settings.policy).toMatchObject({ status: 'ok', wire: { sources: ['apify'] } });
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
    // Unchecked maps run only when named, and the readback says so.
    expect(lines(result)).toContain(
      "Tenjin hasn't checked Firecrawl for read an exact page and web research yet, so those run only when you ask for Firecrawl by name.",
    );
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
      "Your settings block Firecrawl, so Tenjin won't use it until you unblock it.",
    );
    expect((await configJson()).router?.policy?.prefer).toBeUndefined();

    const quiet = await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN', prefer: false },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    expect(data(quiet)).toMatchObject({ account: { preference: 'skipped' } });
    expect(lines(quiet)).toContain(
      'Tenjin can use it for local business search, without putting it first.',
    );
    expect((await configJson()).router?.policy?.prefer).toBeUndefined();
  });

  it('sends a connected account to the router even with no rules at all', async () => {
    const mcp = sessions(SESSIONS);
    await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN', prefer: false },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    expect((await configJson()).router?.policy).toBeUndefined();
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.policy).toMatchObject({
      status: 'ok',
      wire: { version: 1, sources: ['apify'] },
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

  it("names a few of an account's many jobs, first only where the catalog says, and status lists them all", async () => {
    // Apify as the catalog maps it once it does many jobs: checked jobs it
    // comes first for, one the catalog keeps out of the preference, one job
    // with a map of each kind, and jobs no real call has checked yet.
    const apify = DIRECTORY.directory.connectable!.find(({ id }) => id === 'apify')!;
    const template = apify.services[0]!;
    const maps = [
      ['instagram', 'instagram accounts and posts', true, true],
      ['tiktok', 'tiktok accounts and videos', true, true],
      ['x', 'x post search', true, true],
      ['reddit', 'reddit post search', true, true],
      ['linkedin', 'linkedin profile', true, true],
      ['people', 'people search', true, false],
      ['web', 'web research', true, false],
      ['local-2', 'local business search', true, false],
      ['companies', 'company list search', false, true],
      ['mail', 'send email', false, true],
    ] as const;
    const listing = structuredClone(DIRECTORY);
    listing.directory.services.push(
      ...maps.map(([key, task]) => ({
        id: `apify.${key}`,
        label: `Apify ${key}`,
        identity: {
          service: `apify.${key}`,
          source: 'apify',
          providers: ['apify'],
          seller: 'apify',
          task,
          categories: [],
          revision: '0123456789abcdef',
        },
      })),
    );
    listing.directory
      .connectable!.find(({ id }) => id === 'apify')!
      .services.push(
        ...maps.map(([key, , verified, useFirst]) => ({
          ...template,
          id: `apify.${key}`,
          verified,
          useFirst,
        })),
      );
    const mcp = sessions(SESSIONS);
    const result = await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN' },
      makeCtx(),
      deps({
        fetchImpl: network(undefined, listing),
        openSession: mcp.open,
        env: { APIFY_TOKEN: 'apify_api_1' },
      }),
    );
    expect(lines(result).slice(0, 5)).toEqual([
      'Apify connected on this machine.',
      'Tenjin will use it first for local business search, instagram accounts and posts, tiktok accounts and videos, and 3 more (`tenjin status` lists them).',
      "It's also available for people search and web research, without coming first.",
      "Tenjin hasn't checked Apify for company list search and send email yet, so those run only when you ask for Apify by name.",
      "Your Apify plan pays for these calls, which don't count toward your Tenjin limits.",
    ]);
    userWords(result);

    const status = await runRouterStatus(makeCtx(), {
      cwd: work,
      routingCredit: async () => 0n,
      wallet: async () => null,
    });
    expect(status.humanLines).toEqual(
      expect.arrayContaining([
        // The header names the preference; the lines under it say where it holds.
        'Your accounts: Apify (set to come first). Billed to your own plans, not counted in the limit.',
        '  Apify is used first for local business search, instagram accounts and posts, tiktok accounts and videos, x post search, reddit post search, and linkedin profile.',
        '  Apify is also available for people search and web research, without coming first.',
        "  Apify runs for company list search and send email only when you ask for it by name: Tenjin hasn't checked those jobs yet.",
      ]),
    );
    expect(status.data).toMatchObject({
      accounts: [
        {
          id: 'apify',
          jobs: {
            first: [
              'local business search',
              'instagram accounts and posts',
              'tiktok accounts and videos',
              'x post search',
              'reddit post search',
              'linkedin profile',
            ],
            available: ['people search', 'web research'],
            unchecked: ['company list search', 'send email'],
            missing: [],
          },
        },
      ],
    });
  });

  it('never says a preferred account is used first while none of its jobs is checked', async () => {
    // The day the maps ship: every Apify map waits on its first real call.
    const listing = structuredClone(DIRECTORY);
    for (const service of listing.directory.connectable!.find(({ id }) => id === 'apify')!.services)
      service.verified = false;
    const mcp = sessions(SESSIONS);
    const result = await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN' },
      makeCtx(),
      deps({
        fetchImpl: network(undefined, listing),
        openSession: mcp.open,
        env: { APIFY_TOKEN: 'apify_api_1' },
      }),
    );
    expect(data(result)).toMatchObject({ account: { preference: 'added' } });

    const status = await runRouterStatus(makeCtx(), {
      cwd: work,
      routingCredit: async () => 0n,
      wallet: async () => null,
    });
    expect(status.humanLines).toEqual(
      expect.arrayContaining([
        'Your accounts: Apify (set to come first). Billed to your own plans, not counted in the limit.',
        "  Apify runs for local business search only when you ask for it by name: Tenjin hasn't checked that job yet.",
      ]),
    );
    expect(status.humanLines?.join('\n')).not.toMatch(/used first/);
  });

  it('leaves out a service whose tools this account lacks', async () => {
    const mcp = sessions({
      'https://mcp.apify.com': APIFY_TOOLS.filter(({ name }) => name !== 'get-actor-run'),
    });
    const result = await runConnect(
      'apify',
      { fromEnv: 'APIFY_TOKEN' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { APIFY_TOKEN: 'apify_api_1' } }),
    );
    expect(data(result)).toMatchObject({
      account: { ready: [], missing: ['apify.google-maps-places'] },
    });
    expect(lines(result)).toContain(
      "This Apify account can't do local business search, so Tenjin leaves it out here.",
    );
    expect(await readVaultHeader(dir, 'apify')).toMatchObject({
      ready: [],
      missing: ['apify.google-maps-places'],
    });
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
    const result = await runConnect(
      'fal',
      { fromEnv: 'FAL_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: good.open, env }),
    );
    expect(good.called).toEqual(['check_account_status']);
    expect(good.opened[0]?.headers).toEqual({ authorization: 'Key key-id:key-secret' });
    expect(data(result)).toMatchObject({ account: { ready: ['fal.flux-pro-ultra'] } });
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

  it('connects an address it has no map for, runs it only when named, and prefers nothing', async () => {
    const mcp = sessions({
      'https://mcp.example.test/mcp': [{ name: 'lookup', arguments: ['q'] }],
    });
    const result = await runConnect(
      'https://mcp.example.test/mcp',
      { fromEnv: 'EX_KEY' },
      makeCtx(),
      deps({ fetchImpl: network(), openSession: mcp.open, env: { EX_KEY: 'ex-1' } }),
    );
    expect(lines(result).slice(0, 3)).toEqual([
      "Connected mcp.example.test on this machine. Tenjin doesn't know this service's jobs yet, so it won't pick it on its own. Ask for it by name and Tenjin will run it.",
      "Your mcp.example.test account pays for its calls, which don't count toward your Tenjin limits.",
      'Nothing about this service was sent to Tenjin.',
    ]);
    // It offers to send nothing: the network above answers only the directory.
    expect(lines(result).join('\n')).not.toMatch(/support|send/i);
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
    // address's hostname, which no lookup carries.
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.sources).toMatchObject({ status: 'ok', connected: ['mcp-example-test'] });
    expect(settings.policy).toEqual({ status: 'none', path: join(dir, 'config.json') });
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
    expect(config.router?.policy).toEqual({
      version: 1,
      block: [{ kind: 'provider', id: 'tavily' }],
    });
    expect(await readVaultHeader(dir, 'apify')).toBeNull();
    expect(keychain.entries.size).toBe(0);
    const settings = await routerSettings({ cwd: work, dataDir: dir });
    expect(settings.sources).toMatchObject({ connected: [] });
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

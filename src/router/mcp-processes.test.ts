import { afterEach, describe, expect, it } from 'vitest';
import {
  isClaudeCode,
  listMcpProcesses,
  mcpServersState,
  NEW_SESSION_FIX,
  parsePs,
  readMcpServers,
  readProcessSnapshot,
  RECONNECT_FIX,
} from './mcp-processes';

const INSTALLED = Date.parse('Wed Oct 7 22:10:51 2026');
const BEFORE = Date.parse('Wed Oct 7 16:34:07 2026');
const AFTER = Date.parse('Wed Oct 7 23:00:00 2026');

describe('parsePs', () => {
  const START = 'Wed Oct  7 16:34:07 2026';
  const LATER = 'Wed Oct  7 23:00:00 2026';
  /** One `ps -o pid=,ppid=,stat=,lstart=,args=` line. */
  const ps = (pid: number, ppid: number, stat: string, when: string, args: string) =>
    ` ${pid} ${ppid} ${stat}   ${when}     ${args}`;

  it('keeps this user’s `tenjin mcp` lines with their start times and parents, and nothing else', () => {
    const out = [
      ps(9044, 1, 'S', START, 'node /opt/homebrew/bin/tenjin mcp'),
      ps(9100, 1, 'Ss', LATER, '/usr/bin/node /usr/lib/node_modules/tenjin-cli/dist/index.js mcp'),
      ps(
        9150,
        1,
        'S+',
        LATER,
        'node /src/agent/dist/hosts/claude/tenjin/../../../index.js mcp --plugin',
      ),
      ps(9200, 1, 'S', LATER, 'node /opt/homebrew/bin/tenjin doctor'),
      ps(9300, 1, 'S', LATER, 'tail -F tenjin mcp.log'),
      ps(42, 1, 'S', LATER, 'node /opt/homebrew/bin/tenjin mcp'),
      'garbage',
    ].join('\n');
    expect(parsePs(out, 42)).toEqual({
      routers: [
        { pid: 9044, startedAt: BEFORE, ppid: 1, kind: 'other', underClaude: false },
        { pid: 9100, startedAt: AFTER, ppid: 1, kind: 'other', underClaude: false },
        { pid: 9150, startedAt: AFTER, ppid: 1, kind: 'plugin', underClaude: false },
      ],
      claude: [],
    });
  });

  it('reads the version of a router launched from Tenjin’s runtime, under a home with a space', () => {
    const runtime = '/x/.tenjin/runtime';
    const spaced = '/Users/Jane Doe/.tenjin/runtime';
    const out = [
      ps(
        1,
        0,
        'S',
        LATER,
        `${runtime}/node/24.15.0/bin/node ${runtime}/versions/0.1.0-alpha.32/dist/index.js mcp --plugin`,
      ),
      ps(
        2,
        0,
        'S',
        LATER,
        `${spaced}/node/24.15.0/bin/node ${spaced}/versions/0.1.0-alpha.33/dist/index.js mcp --plugin`,
      ),
      ps(
        3,
        0,
        'S',
        LATER,
        `${runtime}/node/24.15.0/bin/node ${runtime}/versions/0.1.0-alpha.32/dist/index.js doctor`,
      ),
    ].join('\n');
    expect(parsePs(out, 0).routers).toEqual([
      {
        pid: 1,
        startedAt: AFTER,
        ppid: 0,
        kind: 'plugin',
        underClaude: false,
        version: '0.1.0-alpha.32',
      },
      {
        pid: 2,
        startedAt: AFTER,
        ppid: 0,
        kind: 'plugin',
        underClaude: false,
        version: '0.1.0-alpha.33',
      },
    ]);
  });

  it('skips a zombie router: it has exited', () => {
    const out = [
      ps(500, 1, 'Z', LATER, 'node /opt/homebrew/bin/tenjin mcp'),
      ps(501, 1, 'Z+', LATER, 'node /opt/homebrew/bin/tenjin mcp --plugin'),
      ps(502, 1, 'S', LATER, 'node /opt/homebrew/bin/tenjin mcp'),
    ].join('\n');
    expect(parsePs(out, 0).routers.map((r) => r.pid)).toEqual([502]);
  });

  it('tells the plugin router, the Codex router and any other apart', () => {
    const out = [
      ps(1, 0, 'S', LATER, 'node /x/tenjin mcp --plugin'),
      ps(2, 0, 'S', LATER, 'node /x/tenjin mcp --harness codex'),
      ps(3, 0, 'S', LATER, 'node /x/tenjin mcp'),
    ].join('\n');
    expect(parsePs(out, 0).routers.map((r) => r.kind)).toEqual(['plugin', 'codex', 'other']);
  });

  it('finds the Claude Code a router runs under, two levels up', () => {
    const out = [
      ps(100, 1, 'Ss', START, '/Users/me/.local/share/claude/versions/2.1.296'),
      ps(200, 100, 'S', LATER, '/bin/sh /x/plugin-wrapper.sh'),
      ps(300, 200, 'S', LATER, 'node /x/tenjin mcp --plugin'),
      ps(400, 1, 'S', LATER, 'node /x/tenjin mcp'),
    ].join('\n');
    const snapshot = parsePs(out, 0);
    expect(snapshot.routers).toEqual([
      expect.objectContaining({ pid: 300, underClaude: true }),
      expect.objectContaining({ pid: 400, underClaude: false }),
    ]);
    expect(snapshot.claude).toEqual([{ pid: 100, startedAt: BEFORE, ppid: 1 }]);
  });

  it('finds the Claude Code the desktop app started, whose path holds a space', () => {
    const bin =
      '/Users/me/Library/Application Support/Claude/claude-code/2.1.304/6bbba6adc37f/claude.app/Contents/MacOS/claude';
    const out = [
      ps(90, 1, 'S', START, '/Applications/Claude.app/Contents/MacOS/Claude'),
      ps(
        95,
        90,
        'S',
        START,
        `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${bin} --verbose`,
      ),
      ps(100, 95, 'S', START, `${bin} --output-format stream-json --verbose`),
      ps(300, 100, 'S', LATER, 'node /x/hosts/claude/tenjin/../../../index.js mcp --plugin'),
    ].join('\n');
    const snapshot = parsePs(out, 0);
    expect(snapshot.routers).toEqual([expect.objectContaining({ pid: 300, underClaude: true })]);
    expect(snapshot.claude).toEqual([{ pid: 100, startedAt: BEFORE, ppid: 95 }]);
  });

  it('does not count a router `claude mcp get` started as under a session', () => {
    const out = [
      ps(100, 1, 'S', LATER, 'claude mcp get plugin:tenjin:router'),
      ps(200, 100, 'S', LATER, 'node /x/tenjin mcp --plugin'),
    ].join('\n');
    const snapshot = parsePs(out, 0);
    expect(snapshot.routers[0]?.underClaude).toBe(false);
    expect(snapshot.claude).toEqual([]);
  });
});

describe('isClaudeCode', () => {
  it.each([
    'claude',
    '/opt/homebrew/bin/claude --resume',
    '/Users/me/.local/share/claude/versions/2.1.296',
    'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/bin/node /opt/claude-code/cli.js --continue',
    '/Users/me/Library/Application Support/Claude/claude-code/2.1.304/6bbba6adc37f/claude.app/Contents/MacOS/claude --output-format stream-json --verbose',
    '/Users/me/Library/Application Support/Claude/claude-code/2.1.304/6bbba6adc37f/claude.app/Contents/MacOS/claude',
    'C:\\Program Files\\Claude\\claude.exe --resume',
  ])('is a session: %s', (args) => {
    expect(isClaudeCode(args)).toBe(true);
  });

  it.each([
    'claude mcp get plugin:tenjin:router',
    'claude mcp list',
    'claude plugin list --json',
    'claude config get',
    'claude update',
    'claude doctor',
    'claude setup-token',
    'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js mcp list',
    'node /x/tenjin mcp',
    'vim claude.md',
    '/usr/bin/claudette',
    '/Users/me/Library/Application Support/Claude/claude-code/2.1.304/6bbba6adc37f/claude.app/Contents/MacOS/claude mcp list',
    '/Applications/Claude.app/Contents/MacOS/Claude',
    '/usr/bin/vim notes /opt/claude-code/cli.js',
    '/usr/bin/less my notes/about claude-code.md',
  ])('is not a session: %s', (args) => {
    expect(isClaudeCode(args)).toBe(false);
  });
});

describe('mcpServersState', () => {
  it('warns, with the reconnect fix, about servers started before this install', () => {
    const { stale, check } = mcpServersState(
      [
        { pid: 1, startedAt: BEFORE },
        { pid: 2, startedAt: BEFORE },
        { pid: 3, startedAt: AFTER },
      ],
      INSTALLED,
      '0.1.0-alpha.25',
    );
    expect(stale).toBe(2);
    expect(check).toEqual({
      name: 'mcp server',
      status: 'warn',
      required: false,
      detail:
        '2 running `tenjin mcp` processes started before this install (0.1.0-alpha.25), so they run the older build, where the hooks can fail with "Tool hook not found"',
      fix: RECONNECT_FIX,
    });
  });

  it('calls a runtime router stale by its version, whenever it started', () => {
    const { stale, check } = mcpServersState(
      [
        { pid: 1, startedAt: AFTER, version: '0.1.0-alpha.32' },
        { pid: 2, startedAt: BEFORE, version: '0.1.0-alpha.33' },
        { pid: 3, startedAt: AFTER },
      ],
      INSTALLED,
      '0.1.0-alpha.33',
    );
    expect(stale).toBe(1);
    expect(check.fix).toBe(RECONNECT_FIX);
    // A runtime router needs no install time to be judged.
    expect(
      mcpServersState(
        [{ pid: 1, startedAt: null, version: '0.1.0-alpha.32' }],
        null,
        '0.1.0-alpha.33',
      ).stale,
    ).toBe(1);
  });

  it('names a new session as the fix, never /reload-plugins', () => {
    expect(RECONNECT_FIX).toBe(
      'Start a new Claude Code session: this one still runs the earlier Tenjin build.',
    );
    expect(NEW_SESSION_FIX).toBe(RECONNECT_FIX);
  });

  it('passes with the count when every server started after the install', () => {
    expect(mcpServersState([{ pid: 3, startedAt: AFTER }], INSTALLED)).toEqual({
      stale: 0,
      check: {
        name: 'mcp server',
        status: 'ok',
        required: false,
        detail: '1 running, all started after this install',
      },
    });
  });

  it('passes when none runs: the next session starts one', () => {
    expect(mcpServersState([], INSTALLED).check).toMatchObject({
      status: 'ok',
      detail: 'none running (starts with the next session)',
    });
  });

  it('says it could not check, never a pass, where processes cannot be listed', () => {
    expect(mcpServersState(null, INSTALLED).check).toEqual({
      name: 'mcp server',
      status: 'warn',
      required: false,
      checked: false,
      detail:
        'could not check for `tenjin mcp` processes started before this install: they cannot be listed on this platform',
    });
    expect(mcpServersState([{ pid: 1, startedAt: BEFORE }], null).check).toMatchObject({
      status: 'warn',
      checked: false,
    });
    // A start time ps did not give is not called stale.
    expect(mcpServersState([{ pid: 1, startedAt: null }], INSTALLED).stale).toBe(0);
  });

  it('judges runtime routers against the version it is given', async () => {
    const state = await readMcpServers(
      {
        listMcpProcesses: async () => [{ pid: 1, startedAt: AFTER, version: '0.1.0-alpha.32' }],
        installedAt: async () => INSTALLED,
      },
      { version: '0.1.0-alpha.32' },
    );
    expect(state.stale).toBe(0);
  });

  it('reads through the injected sources, and a failing one reads as unknown', async () => {
    const state = await readMcpServers({
      listMcpProcesses: async () => {
        throw new Error('ps missing');
      },
      installedAt: async () => INSTALLED,
    });
    expect(state.check).toMatchObject({ status: 'warn', checked: false });
    expect(state.check.detail).toMatch(/^could not check/);
  });

  it('counts no router nothing Claude started, and no Codex router, as stale', () => {
    const { stale, check } = mcpServersState(
      [
        { pid: 1, startedAt: BEFORE, kind: 'plugin', underClaude: false },
        { pid: 2, startedAt: BEFORE, kind: 'codex', underClaude: true },
        { pid: 3, startedAt: BEFORE, kind: 'plugin', underClaude: true },
      ],
      INSTALLED,
      '0.1.0',
    );
    expect(stale).toBe(1);
    expect(check.detail).toMatch(/^1 running `tenjin mcp` process started before/);
  });
});

describe('readProcessSnapshot', () => {
  it('takes the routers-only seam as a snapshot with no Claude Code process', async () => {
    expect(
      await readProcessSnapshot({
        listMcpProcesses: async () => [{ pid: 7, startedAt: AFTER }],
        installedAt: async () => INSTALLED,
      }),
    ).toEqual({
      snapshot: { routers: [{ pid: 7, startedAt: AFTER }], claude: [] },
      installed: INSTALLED,
    });
  });

  it('reads a failing source as null, and never rejects', async () => {
    expect(
      await readProcessSnapshot({
        listProcesses: async () => {
          throw new Error('ps missing');
        },
        installedAt: async () => {
          throw new Error('no package.json');
        },
      }),
    ).toEqual({ snapshot: null, installed: null });
  });
});

describe('listMcpProcesses', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  it('lists nothing on Windows, which reads as unknown rather than failing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(await listMcpProcesses()).toBeNull();
  });
});

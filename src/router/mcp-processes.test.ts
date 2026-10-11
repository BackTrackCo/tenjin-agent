import { afterEach, describe, expect, it } from 'vitest';
import {
  listMcpProcesses,
  mcpServersState,
  parsePs,
  readMcpServers,
  RECONNECT_FIX,
} from './mcp-processes';

const INSTALLED = Date.parse('Wed Oct 7 22:10:51 2026');
const BEFORE = Date.parse('Wed Oct 7 16:34:07 2026');
const AFTER = Date.parse('Wed Oct 7 23:00:00 2026');

describe('parsePs', () => {
  it('keeps this user’s `tenjin mcp` lines with their start times, and nothing else', () => {
    const out = [
      ' 9044 Wed Oct  7 16:34:07 2026     node /opt/homebrew/bin/tenjin mcp',
      ' 9100 Wed Oct  7 23:00:00 2026     /usr/bin/node /usr/lib/node_modules/tenjin-cli/dist/index.js mcp',
      ' 9200 Wed Oct  7 23:00:00 2026     node /opt/homebrew/bin/tenjin doctor',
      ' 9300 Wed Oct  7 23:00:00 2026     tail -F tenjin mcp.log',
      '   42 Wed Oct  7 23:00:00 2026     node /opt/homebrew/bin/tenjin mcp',
      'garbage',
    ].join('\n');
    expect(parsePs(out, 42)).toEqual([
      { pid: 9044, startedAt: BEFORE },
      { pid: 9100, startedAt: AFTER },
    ]);
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

  it('says unknown, and passes, where processes cannot be listed', () => {
    expect(mcpServersState(null, INSTALLED).check).toMatchObject({
      status: 'ok',
      detail: 'unknown: running `tenjin mcp` processes cannot be listed on this platform',
    });
    expect(mcpServersState([{ pid: 1, startedAt: BEFORE }], null).check.status).toBe('ok');
    // A start time ps did not give is not called stale.
    expect(mcpServersState([{ pid: 1, startedAt: null }], INSTALLED).stale).toBe(0);
  });

  it('reads through the injected sources, and a failing one reads as unknown', async () => {
    const state = await readMcpServers({
      listMcpProcesses: async () => {
        throw new Error('ps missing');
      },
      installedAt: async () => INSTALLED,
    });
    expect(state.check.detail).toMatch(/^unknown/);
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

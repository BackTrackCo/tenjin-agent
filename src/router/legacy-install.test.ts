import { describe, expect, it } from 'vitest';
import { ownsLegacyHandler } from './legacy-install';

describe('ownsLegacyHandler', () => {
  it.each([
    { type: 'command', command: 'tenjin hook prompt' },
    { type: 'command', command: '/opt/homebrew/bin/tenjin hook alive' },
    { type: 'command', command: 'C:\\npm\\tenjin.cmd hook native' },
    { type: 'command', command: 'tenjin', args: ['hook', 'alive'] },
    {
      type: 'command',
      command: 'node',
      args: ['/usr/lib/node_modules/tenjin-cli/dist/index.js', 'hook', 'alive'],
    },
    {
      type: 'command',
      command: 'node.exe',
      args: ['C:\\npm\\tenjin-cli\\dist\\index.js', 'hook', 'ask'],
    },
    { type: 'mcp_tool', server: 'x402', tool: 'hook' },
  ])('recognizes %j in shell or exec form', (handler) => {
    expect(ownsLegacyHandler(handler)).toBe(true);
  });

  it.each([
    { type: 'command', command: '~/bin/notify.sh; tenjin hook prompt' },
    { type: 'command', command: 'tenjin hook alive && rm -rf /' },
    { type: 'command', command: 'node', args: ['/elsewhere/dist/index.js', 'hook', 'alive'] },
    { type: 'command', command: 'tenjin', args: ['hook', 'alive', '--x'] },
    { type: 'mcp_tool', server: 'other', tool: 'hook' },
  ])('leaves %j to its owner', (handler) => {
    expect(ownsLegacyHandler(handler)).toBe(false);
  });
});

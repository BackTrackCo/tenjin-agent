import { describe, expect, it } from 'vitest';
import { commandArgv, commandForm, handlersIn, shellDependence } from './hook-form';

describe('commandForm', () => {
  it('reads exec form from an args array and shell form from its absence', () => {
    expect(commandForm({ type: 'command', command: 'node', args: ['x.js'] })).toBe('exec');
    expect(commandForm({ type: 'command', command: 'tenjin hook alive' })).toBe('shell');
    expect(commandForm({ type: 'mcp_tool', server: 's', tool: 't' })).toBeNull();
  });
});

describe('commandArgv', () => {
  it('gives the argument vector of either form', () => {
    expect(
      commandArgv({ type: 'command', command: 'node', args: ['/a/index.js', 'hook'] }),
    ).toEqual(['node', '/a/index.js', 'hook']);
    expect(commandArgv({ type: 'command', command: ' tenjin hook  alive ' })).toEqual([
      'tenjin',
      'hook',
      'alive',
    ]);
    expect(commandArgv({ type: 'http', url: 'http://x' })).toBeNull();
  });
});

describe('shellDependence', () => {
  it('passes a node launch with an args array', () => {
    expect(shellDependence({ command: 'node', args: ['/a/index.js', 'mcp'] })).toBeNull();
  });

  it('passes an absolute Node path with spaces, which exec form spawns as one executable', () => {
    for (const command of [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      '/Users/me/My Tools/node',
    ]) {
      expect(shellDependence({ command, args: ['C:\\x\\index.js', 'mcp'] }), command).toBeNull();
    }
  });

  it.each([
    [{ type: 'command', command: 'tenjin hook alive' }, /no args array/],
    [{ type: 'command', command: `echo '{"a":1}'` }, /no args array/],
    [{ command: 'node "/a b/index.js"', args: [] }, /shell syntax/],
    [{ command: 'node index.js', args: [] }, /shell syntax/],
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

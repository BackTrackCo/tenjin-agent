import { describe, expect, it } from 'vitest';
import {
  classifyStatusLine,
  composeCommand,
  decomposeCommand,
  STATUS_LINE_COMMAND,
} from './status-line-wiring';

/**
 * What the removal of the settings-based install recognises as Tenjin's: a
 * status line that is not ours must never read as ours.
 */

const MINE = { type: 'command', command: 'starship prompt --status-line' };

describe('recognising a status line an earlier release wrote', () => {
  it('reads each state', () => {
    expect(classifyStatusLine(undefined)).toBe('absent');
    expect(classifyStatusLine({ type: 'command', command: STATUS_LINE_COMMAND })).toBe('ours');
    expect(classifyStatusLine(STATUS_LINE_COMMAND)).toBe('ours');
    expect(classifyStatusLine({ command: composeCommand(MINE.command) })).toBe('composed');
    expect(classifyStatusLine(MINE)).toBe('foreign');
    // A status line whose command this build cannot read is still the user's.
    expect(classifyStatusLine({ type: 'command' })).toBe('foreign');
  });

  it('escapes a quote in the status line it wraps, and can undo it', () => {
    const command = `echo 'it''s mine'`;
    expect(composeCommand(command)).toContain(String.raw`'\''`);
    expect(composeCommand(command).startsWith("sh -c '")).toBe(true);
    expect(decomposeCommand(composeCommand(command))).toBe(command);
  });

  it('undoes nothing it did not write', () => {
    for (const command of ['starship prompt', "sh -c 'echo hi'", 'tenjin status-line']) {
      expect(decomposeCommand(command)).toBeNull();
    }
  });
});

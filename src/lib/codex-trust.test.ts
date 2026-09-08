import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventSnake, parseTrustState, trustKey, trustedEntries } from './codex-trust';

// The shape as the operator's real config.toml carries it (one project entry
// trusted through /hooks), with the path replaced.
const TOML = `[features]
hooks = true

[hooks.state]

[hooks.state."/Users/dev/proj/.codex/hooks.json:user_prompt_submit:0:0"]
trusted_hash = "sha256:daf9006f9a66333d1714f9e2de3abab93c7f78aa36aca38194defe53f3a61fc5"

[hooks.state."/Users/dev/.codex/hooks.json:stop:1:0"]
enabled = false
trusted_hash = "sha256:00"

[other]
x = 1
`;

describe('parseTrustState', () => {
  it('reads every hooks.state record with its hash and enabled flag', () => {
    const state = parseTrustState(TOML);
    expect(state.get('/Users/dev/proj/.codex/hooks.json:user_prompt_submit:0:0')).toEqual({
      trustedHash: 'sha256:daf9006f9a66333d1714f9e2de3abab93c7f78aa36aca38194defe53f3a61fc5',
    });
    expect(state.get('/Users/dev/.codex/hooks.json:stop:1:0')).toEqual({
      enabled: false,
      trustedHash: 'sha256:00',
    });
    expect(state.size).toBe(2);
  });

  it('unescapes a quoted key and ignores an empty or malformed file', () => {
    const state = parseTrustState(
      '[hooks.state."C:\\\\x\\"y.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n',
    );
    expect([...state.keys()]).toEqual(['C:\\x"y.json:stop:0:0']);
    expect(parseTrustState('').size).toBe(0);
    expect(parseTrustState('not toml at all').size).toBe(0);
  });
});

describe('keys', () => {
  it('snake-cases the event the way Codex labels it', () => {
    expect(eventSnake('PreToolUse')).toBe('pre_tool_use');
    expect(eventSnake('UserPromptSubmit')).toBe('user_prompt_submit');
    expect(eventSnake('Stop')).toBe('stop');
    expect(eventSnake('SessionStart')).toBe('session_start');
  });

  it('keys on the absolute hooks path, the event, the group index and handler 0', () => {
    expect(trustKey('/Users/dev/.codex/hooks.json', 'SubagentStop', 2)).toBe(
      '/Users/dev/.codex/hooks.json:subagent_stop:2:0',
    );
  });
});

describe('trustedEntries', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tenjin-codex-trust-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('counts the entries with a live record and names the rest', async () => {
    const hooksPath = join(home, 'hooks.json');
    await writeFile(
      join(home, 'config.toml'),
      `[hooks.state."${hooksPath}:stop:0:0"]\ntrusted_hash = "sha256:a"\n` +
        `[hooks.state."${hooksPath}:pre_tool_use:1:0"]\nenabled = false\ntrusted_hash = "sha256:b"\n`,
    );
    const positions = [
      { event: 'Stop', index: 0 },
      { event: 'PreToolUse', index: 1 },
      { event: 'SessionStart', index: 0 },
    ];
    expect(await trustedEntries(home, hooksPath, positions)).toEqual({
      trusted: 1,
      untrusted: [
        { event: 'PreToolUse', index: 1 },
        { event: 'SessionStart', index: 0 },
      ],
    });
  });

  it('a missing config.toml is no trust at all, never an error', async () => {
    const positions = [{ event: 'Stop', index: 0 }];
    expect(await trustedEntries(home, join(home, 'hooks.json'), positions)).toEqual({
      trusted: 0,
      untrusted: positions,
    });
  });
});

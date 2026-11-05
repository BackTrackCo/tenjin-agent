import { describe, it, expect } from 'vitest';
import { agentHost, underAgentHarness } from './session';

describe('underAgentHarness', () => {
  it('reads what Claude Code and Codex export to their agent, and nothing a terminal sets', () => {
    expect(underAgentHarness({ CLAUDECODE: '1' })).toBe(true);
    expect(underAgentHarness({ CLAUDE_CODE_SESSION_ID: 's' })).toBe(true);
    expect(underAgentHarness({ CLAUDE_CODE_EXECPATH: '/bin/claude' })).toBe(true);
    expect(underAgentHarness({ CODEX_SESSION_ID: 's' })).toBe(true);
    expect(underAgentHarness({ CLAUDECODE: ' ', TENJIN_SESSION_ID: 'operator' })).toBe(false);
    expect(underAgentHarness({})).toBe(false);
  });
});

describe('agentHost', () => {
  it('tells Claude Code from Codex by environment, Claude Code first', () => {
    expect(agentHost({ CLAUDECODE: '1' })).toBe('claude');
    expect(agentHost({ CODEX_SESSION_ID: 'abc' })).toBe('codex');
    expect(agentHost({ CODEX_SESSION_ID: 'abc', CLAUDE_CODE_SESSION_ID: 'x' })).toBe('claude');
    expect(agentHost({ CODEX_SESSION_ID: '  ' })).toBeUndefined();
    expect(agentHost({})).toBeUndefined();
  });
});

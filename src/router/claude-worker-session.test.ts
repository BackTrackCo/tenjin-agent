import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  claudeWorkerConfigDir,
  claudeWorkerPrivatePaths,
  prepareClaudeWorkerSession,
} from './claude-worker-session';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path }));
const id = '11111111-2222-4333-8444-555555555555';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(homedir(), '.claude'));
});
afterEach(() => vi.unstubAllEnvs());

it('keeps unowned calls ephemeral and binds only the exact owned SDK identity', async () => {
  expect(await prepareClaudeWorkerSession(undefined, '/repo')).toBeUndefined();
  const observe = vi.fn(async () => {});
  const session = await prepareClaudeWorkerSession({ sessionId: id, onSession: observe }, '/repo');
  expect(session?.query).toEqual({ sessionId: id });
  await expect(session?.bind('foreign')).rejects.toThrow(/session/);
  expect(observe).not.toHaveBeenCalled();
  await session?.bind(id);
  expect(observe).toHaveBeenCalledWith(id);
  expect(getSessionInfo).not.toHaveBeenCalled();
});

it('reopens only exact local SDK history from the owned workspace', async () => {
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: id, cwd: '/repo' } as never);
  const session = await prepareClaudeWorkerSession({ resume: id, onSession: vi.fn() }, '/repo');
  expect(session?.query).toEqual({ resume: id });
  expect(getSessionInfo).toHaveBeenCalledWith(id, { dir: '/repo' });
  vi.mocked(getSessionInfo).mockResolvedValue(undefined);
  await expect(
    prepareClaudeWorkerSession({ resume: id, onSession: vi.fn() }, '/repo'),
  ).rejects.toThrow(/history is missing/);
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: id, cwd: '/foreign' } as never);
  await expect(
    prepareClaudeWorkerSession({ resume: id, onSession: vi.fn() }, '/repo'),
  ).rejects.toThrow(/another workspace/);
});

it('rejects malformed or conflicting native identities without reading another session', async () => {
  for (const identity of [{ resume: '../other' }, { resume: id, sessionId: id }]) {
    await expect(
      prepareClaudeWorkerSession({ ...identity, onSession: vi.fn() }, '/repo'),
    ).rejects.toThrow();
  }
  expect(getSessionInfo).not.toHaveBeenCalled();
});

it('preserves native config override semantics and refuses mismatched relative stores', async () => {
  expect(claudeWorkerConfigDir('/repo', {})).toBe(join(homedir(), '.claude'));
  expect(claudeWorkerConfigDir('/repo', { CLAUDE_CONFIG_DIR: '' })).toBe('/repo');
  expect(claudeWorkerConfigDir('/repo', { CLAUDE_CONFIG_DIR: '.native' })).toBe('/repo/.native');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '.native');
  await expect(
    prepareClaudeWorkerSession({ resume: id, onSession: vi.fn() }, '/repo'),
  ).rejects.toThrow(/session store/);
  expect(getSessionInfo).not.toHaveBeenCalled();
});

it('protects an in-repository registry and native history from file tools and sandboxed commands', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/repo/native config');
  const protectedPaths = await claudeWorkerPrivatePaths('/repo/private', '/repo');
  expect(protectedPaths.paths).toEqual(['/repo/private', '/repo/native config/projects']);
  expect(protectedPaths.deny).toContain('Read(//repo/private/**)');
  expect(protectedPaths.deny).toContain('Edit(//repo/native config/projects/**)');
});

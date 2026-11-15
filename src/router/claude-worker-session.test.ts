import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  claudeWorkerConfigDir,
  claudeWorkerPrivatePaths,
  prepareClaudeWorkerSession,
} from './claude-worker-session';
import { isSecretPath } from './model-worker-privacy';

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
  expect(protectedPaths.paths).toEqual(
    expect.arrayContaining([
      '/repo/private',
      '/repo/native config/projects',
      '/repo/native config/.credentials.json',
      '/repo/native config/.claude.json',
      '/repo/native config/history.jsonl',
    ]),
  );
  expect(protectedPaths.deny).toContain('Read(//repo/private/**)');
  expect(protectedPaths.deny).toContain('Edit(//repo/native config/projects/**)');
  expect(protectedPaths.deny).toContain('Write(//repo/private/**)');
  expect(isSecretPath('/repo/native config/skills/example/SKILL.md', protectedPaths.paths)).toBe(
    false,
  );
});

it('protects both declared config layers and secure storage without blocking their support files', async () => {
  const protectedPaths = await claudeWorkerPrivatePaths(
    '/repo/private',
    '/repo',
    {
      CLAUDE_CONFIG_DIR: '/repo/parent-profile',
      CODEX_HOME: '/repo/codex-profile',
    },
    {
      CLAUDE_CONFIG_DIR: '/repo/effective-profile',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/repo/secure-store',
    },
  );
  for (const path of [
    '/repo/parent-profile/.credentials.json',
    '/repo/parent-profile/projects/session.jsonl',
    '/repo/effective-profile/.claude.json',
    '/repo/effective-profile/settings.json',
    '/repo/effective-profile/settings.local.json',
    '/repo/parent-profile/.mcp.json',
    '/repo/parent-profile/mcp.json',
    '/repo/effective-profile/history.jsonl',
    '/repo/secure-store/.credentials.json',
    '/repo/codex-profile/auth.json',
    '/repo/private/owned.json',
  ])
    expect(isSecretPath(path, protectedPaths.paths)).toBe(true);
  for (const path of [
    '/repo/parent-profile/agents/reviewer.md',
    '/repo/effective-profile/commands/check.md',
    '/repo/effective-profile/skills/example/settings.json',
  ])
    expect(isSecretPath(path, protectedPaths.paths)).toBe(false);
});

it('protects exact native workspace and discovered source files without an ancestor scan or basename ban', async () => {
  const protectedPaths = await claudeWorkerPrivatePaths(
    '/repo/private',
    '/repo/child',
    {},
    {},
    {
      workingDirectories: ['/repo/child', '/sibling'],
      sources: [
        { source: 'project', path: '/repo/.claude/settings.json' },
        { source: 'local', path: '/custom/native-policy.json' },
      ],
    },
  );
  for (const file of [
    '/repo/.claude/settings.json',
    '/repo/.claude/settings.local.json',
    '/repo/.mcp.json',
    '/repo/child/.mcp.json',
    '/sibling/.claude/settings.local.json',
    '/sibling/.mcp.json',
    '/custom/native-policy.json',
  ])
    expect(isSecretPath(file, protectedPaths.paths)).toBe(true);
  for (const file of [
    '/repo/child/settings.json',
    '/sibling/settings.json',
    '/custom/settings.json',
    '/repo/.claude/skills/example/settings.json',
    '/.mcp.json',
  ])
    expect(isSecretPath(file, protectedPaths.paths)).toBe(false);
});

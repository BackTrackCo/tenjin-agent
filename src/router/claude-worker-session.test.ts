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
const files = vi.hoisted(() => ({}) as Record<string, string>);
const links = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => links[path] ?? path,
  readFile: async (path: string) => {
    if (path in files) return files[path];
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  },
}));
const id = '11111111-2222-4333-8444-555555555555';
beforeEach(() => {
  vi.clearAllMocks();
  for (const path of Object.keys(files)) delete files[path];
  for (const path of Object.keys(links)) delete links[path];
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

it('protects an in-repository registry and credentials, and opens native history read-only', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/repo/native config');
  const protectedPaths = await claudeWorkerPrivatePaths('/repo/private', '/repo');
  expect(protectedPaths.paths).toEqual(
    expect.arrayContaining([
      '/repo/private',
      '/repo/native config/.credentials.json',
      '/repo/native config/.claude.json',
    ]),
  );
  // Session transcripts, memory and prompt history, as a native subagent reads them.
  for (const path of ['/repo/native config/projects', '/repo/native config/history.jsonl']) {
    expect(protectedPaths.readable).toContain(path);
    expect(protectedPaths.paths).not.toContain(path);
    expect(protectedPaths.deny).not.toContain(`Read(/${path}/**)`);
    expect(protectedPaths.deny).toContain(`Edit(/${path}/**)`);
  }
  expect(protectedPaths.deny).toContain('Read(//repo/private/**)');
  expect(protectedPaths.deny).toContain('Write(//repo/private/**)');
  expect(isSecretPath('/repo/native config/skills/example/SKILL.md', protectedPaths.paths)).toBe(
    false,
  );
});

it.each([
  [
    'the credentials file',
    '/repo/native config/history.jsonl',
    '/repo/native config/.credentials.json',
  ],
  ['a folder that holds protected files', '/repo/native config/projects', '/repo/native config'],
  ["Tenjin's own data folder", '/repo/native config/history.jsonl', '/repo/private/wallet.json'],
])('keeps an opened name closed when it is a link to %s', async (_label, name, target) => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/repo/native config');
  links[name] = target;
  const kept = await claudeWorkerPrivatePaths('/repo/private', '/repo');
  // Opening it by where it resolves would hand the worker the file the link points at.
  expect(kept.readable).not.toContain(name);
  expect(kept.readable).not.toContain(target);
  expect(kept.paths).toEqual(
    expect.arrayContaining([name, '/repo/native config/.credentials.json']),
  );
  expect(kept.deny).toContain(`Read(/${name})`);
  expect(kept.deny).toContain('Read(//repo/native config/.credentials.json)');
  // A link to somewhere that is not protected is still followed, as a dotfiles setup has it.
  links[name] = '/elsewhere/dotfiles/claude-history';
  const followed = await claudeWorkerPrivatePaths('/repo/private', '/repo');
  expect(followed.readable).toEqual(
    expect.arrayContaining([name, '/elsewhere/dotfiles/claude-history']),
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
    '/repo/effective-profile/.claude.json',
    '/repo/parent-profile/.mcp.json',
    '/repo/parent-profile/mcp.json',
    '/repo/parent-profile/debug/session.txt',
    '/repo/secure-store/.credentials.json',
    '/repo/codex-profile/auth.json',
    '/repo/private/owned.json',
  ])
    expect(isSecretPath(path, protectedPaths.paths)).toBe(true);
  for (const path of [
    '/repo/parent-profile/agents/reviewer.md',
    '/repo/effective-profile/commands/check.md',
    '/repo/effective-profile/skills/example/settings.json',
    '/repo/parent-profile/projects/session.jsonl',
    '/repo/effective-profile/history.jsonl',
    // Absent at start, so it holds no value the worker could forward unreplaced.
    '/repo/effective-profile/settings.json',
    '/repo/effective-profile/settings.local.json',
  ])
    expect(isSecretPath(path, protectedPaths.paths)).toBe(false);
});

it('opens a user settings file only when its env block can be read, and returns its values', async () => {
  files['/cfg/settings.json'] = JSON.stringify({ env: { API_TOKEN: 'v-Kq9xLm-1' } });
  files['/cfg/settings.local.json'] = '{ not json';
  const result = await claudeWorkerPrivatePaths('/repo/private', '/repo', {
    CLAUDE_CONFIG_DIR: '/cfg',
  });
  expect(result.settingsFiles).toContain('/cfg/settings.json');
  expect(result.settingsFiles).not.toContain('/cfg/settings.local.json');
  expect(result.settingsEnv).toContainEqual({ API_TOKEN: 'v-Kq9xLm-1' });
  expect(result.deny).not.toContain('Read(//cfg/settings.json)');
  expect(result.deny).toContain('Edit(//cfg/settings.json)');
  // Its values are unknown, so nothing in it may reach the worker.
  expect(result.paths).toContain('/cfg/settings.local.json');
  expect(result.deny).toContain('Read(//cfg/settings.local.json)');
});

it("opens a repository's own .claude/settings.json for reading when its env block parses, never for writing", async () => {
  // The failure: a tracked project settings file was closed, which a native subagent reads.
  files['/repo/.claude/settings.json'] = JSON.stringify({ env: { DEPLOY_KEY: 'dk-Zq81-xY7w' } });
  files['/sibling/.claude/settings.json'] = '{ "env": ';
  const result = await claudeWorkerPrivatePaths(
    '/repo/private',
    '/repo',
    { CLAUDE_CONFIG_DIR: '/cfg' },
    {},
    {
      workingDirectories: ['/repo', '/sibling'],
      sources: [{ source: 'project', path: '/repo/.claude/settings.json' }],
    },
  );
  expect(result.readable).toContain('/repo/.claude/settings.json');
  expect(result.deny).not.toContain('Read(//repo/.claude/settings.json)');
  expect(result.deny).toEqual(
    expect.arrayContaining([
      'Edit(//repo/.claude/settings.json)',
      'Write(//repo/.claude/settings.json)',
    ]),
  );
  // Read again before each request, so its values are replaced before anything leaves.
  expect(result.settingsFiles).toContain('/repo/.claude/settings.json');
  expect(result.settingsEnv).toContainEqual({ DEPLOY_KEY: 'dk-Zq81-xY7w' });
  // One that cannot be parsed holds values nobody knows; the local file and MCP config stay closed.
  for (const file of [
    '/sibling/.claude/settings.json',
    '/repo/.claude/settings.local.json',
    '/repo/.mcp.json',
  ]) {
    expect(result.paths).toContain(file);
    expect(result.deny).toContain(`Read(/${file})`);
  }
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
    // Outside the working directories: closed, whatever it holds.
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

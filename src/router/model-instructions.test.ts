import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalHash } from '../lib/request-schema';
import {
  assertInstructionContextCurrent,
  instructionContextText,
  resolveCodexInstructions,
  savedInstructionContext,
  type InstructionReader,
} from './model-instructions';
import type { CodexModelPolicy } from './codex-model-gates';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(config: Record<string, unknown> = {}) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-instructions-')));
  const project = join(dir, 'project'),
    cwd = join(project, 'child'),
    home = join(dir, 'codex');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(project, '.git'));
  await mkdir(home);
  const policy: CodexModelPolicy = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {},
    permissionProfile: {
      type: 'managed',
      file_system: {
        type: 'restricted',
        entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }],
      },
      network: 'restricted',
    },
  };
  const read = vi.fn<InstructionReader>(async (paths, maxBytes) => {
    const result = [];
    let total = 0;
    for (const path of paths) {
      const contents = await readFile(path, 'utf8');
      const bytes = Buffer.byteLength(contents);
      total += bytes;
      if (total > maxBytes) return null;
      result.push({ path, contents, bytes, stamp: canonicalHash(contents) });
    }
    return result;
  });
  const options = {
    cwd,
    policy,
    dataDir: join(dir, 'wallet'),
    env: { CODEX_HOME: home },
    read,
    nativeConfig: {
      config,
      layers: [{ name: { type: 'user', file: join(home, 'config.toml') }, config: {} }],
    },
  };
  return { project, cwd, home, read, options };
}

it('carries native global, ancestor and override order, while preserving references without adding CLAUDE authority', async () => {
  const f = await fixture({ project_doc_fallback_filenames: ['TEAM.md'] });
  await writeFile(join(f.home, 'AGENTS.override.md'), '  \n');
  await writeFile(join(f.home, 'AGENTS.md'), 'GLOBAL: ask before an outward action.\n');
  await writeFile(join(dir, 'AGENTS.md'), 'OUTSIDE_PROJECT_MUST_NOT_APPLY');
  await writeFile(join(f.project, 'AGENTS.md'), 'ANCESTOR: Read CLAUDE.md through guarded tools.');
  await writeFile(join(f.cwd, 'AGENTS.override.md'), 'OVERRIDE: preserve dirty work.');
  await writeFile(join(f.cwd, 'AGENTS.md'), 'IGNORED_CHILD');
  await writeFile(join(f.cwd, 'CLAUDE.md'), 'UNBOUND_CLAUDE');
  const context = await resolveCodexInstructions(f.options);
  expect(context.documents.map((doc) => doc.path)).toEqual([
    join(f.home, 'AGENTS.md'),
    join(f.project, 'AGENTS.md'),
    join(f.cwd, 'AGENTS.override.md'),
  ]);
  const text = instructionContextText(context);
  expect(text).toContain('GLOBAL: ask before an outward action.');
  expect(text).toContain('Read CLAUDE.md through guarded tools.');
  expect(text).not.toMatch(/OUTSIDE_PROJECT|IGNORED_CHILD|UNBOUND_CLAUDE/);
  expect(savedInstructionContext(context)).toEqual(context);
  await assertInstructionContextCurrent(context, f.read);
});

it('uses configured fallback names and keeps empty project overrides authoritative', async () => {
  const f = await fixture({ project_doc_fallback_filenames: ['TEAM.md', '../wallet.json'] });
  await writeFile(join(f.project, 'TEAM.md'), 'FALLBACK_ANCESTOR');
  await writeFile(join(f.cwd, 'AGENTS.override.md'), ' \n');
  await writeFile(join(f.cwd, 'AGENTS.md'), 'MUST_NOT_REPLACE_EMPTY_OVERRIDE');
  const context = await resolveCodexInstructions(f.options);
  expect(context.documents.map((doc) => doc.content)).toEqual(['FALLBACK_ANCESTOR']);
});

it('keeps failed native reads and changed sources native instead of omitting mandatory instructions', async () => {
  const f = await fixture();
  const file = join(f.cwd, 'AGENTS.md');
  await writeFile(file, 'ORIGINAL_INSTRUCTIONS');
  const context = await resolveCodexInstructions(f.options);
  f.read.mockResolvedValueOnce(null);
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/Native instruction read/);
  await writeFile(file, 'CHANGED_INSTRUCTIONS_WITH_A_DIFFERENT_LENGTH');
  await expect(assertInstructionContextCurrent(context, f.read)).rejects.toThrow(/changed/);
  expect(savedInstructionContext({ ...context, documents: [] })).toBeNull();
});

it('refuses truncation, protected fallback documents, symlinks and source races before routing', async () => {
  const f = await fixture({ project_doc_max_bytes: 3 });
  const file = join(f.cwd, 'AGENTS.md');
  await writeFile(file, 'FOUR');
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/truncated/);
  await rm(file);
  f.options.nativeConfig.config = { project_doc_fallback_filenames: ['wallet.json'] };
  await writeFile(join(f.cwd, 'wallet.json'), 'PROTECTED');
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/Protected/);
  f.options.nativeConfig.config = {};
  await symlink(join(f.cwd, 'wallet.json'), file);
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/symlink/);
  await rm(file);
  await writeFile(file, 'BEFORE');
  f.read.mockImplementationOnce(async (paths) => {
    await writeFile(paths[0]!, 'AFTER_A_CONCURRENT_CHANGE');
    return [{ path: paths[0]!, contents: 'BEFORE', bytes: 6, stamp: 'old' }];
  });
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/changed/);
});

it('does not let project-layer root markers widen native ancestor discovery', async () => {
  const f = await fixture();
  await writeFile(join(dir, 'OUTER_MARKER'), '');
  await writeFile(join(dir, 'AGENTS.md'), 'OUTER_MUST_NOT_APPLY');
  await writeFile(join(f.project, 'AGENTS.md'), 'PROJECT_ONLY');
  f.options.nativeConfig.layers.push({
    name: { type: 'project', file: '' },
    config: { project_root_markers: ['OUTER_MARKER'] },
  });
  const context = await resolveCodexInstructions(f.options);
  expect(context.documents.map((doc) => doc.content)).toEqual(['PROJECT_ONLY']);
});

it('does not confuse the routing envelope with the accepted worker instruction bound', async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, 'AGENTS.md'), 'BINDING_INSTRUCTION '.repeat(1200));
  const context = await resolveCodexInstructions(f.options);
  expect(Buffer.byteLength(instructionContextText(context))).toBeGreaterThan(16384);
  expect(savedInstructionContext(context)).toEqual(context);
});

it('keeps an explicitly untrusted project native instead of applying a different instruction scope', async () => {
  const f = await fixture();
  f.options.nativeConfig.config = { projects: { [f.project]: { trust_level: 'untrusted' } } };
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/Untrusted/);
  expect(f.read).not.toHaveBeenCalled();
});

it.each([
  { instructions: 'CUSTOM_SYSTEM_AUTHORITY' },
  { developer_instructions: 'CUSTOM_DEVELOPER_AUTHORITY' },
  { base_instructions: 'CUSTOM_BASE_AUTHORITY' },
  { model_instructions_file: '/fixture/custom-authority.md' },
  { experimental_instructions_file: '/fixture/legacy-authority.md' },
  { instructions: '' },
])(
  'keeps custom effective instruction authority native before reading source documents: %j',
  async (config) => {
    const f = await fixture(config);
    await writeFile(join(f.cwd, 'AGENTS.md'), 'ORDINARY_AGENT_CONTEXT');
    await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/Custom native/);
    expect(f.read).not.toHaveBeenCalled();
  },
);

it('finds instruction-file overrides in active raw/profile layers even when public effective config omits them', async () => {
  const f = await fixture({ instructions: null, developer_instructions: null });
  f.options.nativeConfig.layers[0]!.config = {
    model_instructions_file: '/fixture/must-not-be-read.md',
  };
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/Custom native/);
  expect(f.read).not.toHaveBeenCalled();
  f.options.nativeConfig.layers[0]!.config = {
    profiles: { custom: { developer_instructions: 'PROFILE_AUTHORITY' } },
  };
  await expect(resolveCodexInstructions(f.options)).rejects.toThrow(/Custom native/);
  expect(f.read).not.toHaveBeenCalled();
});

it('allows default null instruction fields and ignores explicitly disabled raw layers', async () => {
  const f = await fixture({ instructions: null, developer_instructions: null });
  const layer = {
    name: { type: 'project', dotCodexFolder: join(f.cwd, '.codex') },
    config: { developer_instructions: 'DISABLED_AUTHORITY' },
    disabledReason: 'Project is not trusted',
  };
  const context = await resolveCodexInstructions({
    ...f.options,
    nativeConfig: {
      ...f.options.nativeConfig,
      layers: [...f.options.nativeConfig.layers, layer],
    },
  });
  expect(context.documents).toEqual([]);
});

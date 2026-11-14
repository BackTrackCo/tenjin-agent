import { mkdtemp, writeFile, rm, truncate, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexModelPolicy } from './codex-model-context';
import { nativeLocalFilesystem } from './codex-local-environment';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('binds native restrictions to the exact owned root and turn, never a child or old turn', async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-model-context-'));
  const path = join(dir, 'rollout.jsonl');
  const meta = {
    type: 'session_meta',
    payload: {
      id: 'root',
      session_id: 'root',
      thread_source: null,
      cli_version: '0.163.0',
      source: 'vscode',
      parent_thread_id: null,
    },
  };
  const user = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'root',
      item: {
        id: 'user1',
        type: 'UserMessage',
        content: [{ type: 'text', text: 'Keep the network restricted.' }],
      },
    },
  };
  const context = {
    type: 'turn_context',
    payload: {
      turn_id: 'turn',
      cwd: dir,
      approval_policy: 'never',
      approvals_reviewer: 'user',
      sandbox_policy: { type: 'read-only' },
      permission_profile: { type: 'managed', network: 'restricted' },
      disabled_plugin_ids: [],
    },
  };
  const save = async (header: unknown = meta) =>
    writeFile(path, [header, context, user].map((r) => JSON.stringify(r)).join('\n'));
  await save();
  expect(await codexModelPolicy(path, 'root', 'turn', dir)).toMatchObject({
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'read-only' },
    permissionProfile: { network: 'restricted' },
  });
  expect(await codexModelPolicy(path, 'root', 'old-turn', dir)).toBeNull();
  expect(await codexModelPolicy(path, 'foreign', 'turn', dir)).toBeNull();
  await save({ ...meta, payload: { ...meta.payload, cli_version: '0.167.0-alpha.4.1' } });
  expect(await codexModelPolicy(path, 'root', 'turn', dir)).toMatchObject({
    approvalPolicy: 'never',
    permissionProfile: { network: 'restricted' },
  });
  const desktop = {
    ...meta,
    payload: { ...meta.payload, cli_version: '0.167.0-alpha.4.1', thread_source: 'vscode' },
  };
  await save(desktop);
  expect(await codexModelPolicy(path, 'root', 'turn', dir)).toMatchObject({
    approvalPolicy: 'never',
    permissionProfile: { network: 'restricted' },
  });
  await save({ ...desktop, payload: { ...desktop.payload, parent_thread_id: 'parent' } });
  expect(await codexModelPolicy(path, 'root', 'turn', dir)).toBeNull();
  await save(desktop);
  expect(await codexModelPolicy(path, 'foreign', 'turn', dir)).toBeNull();
  for (const cli_version of ['0.167.0', '0.167.0-alpha.4.2', '0.163.1']) {
    await save({ ...meta, payload: { ...meta.payload, cli_version } });
    expect(await codexModelPolicy(path, 'root', 'turn', dir)).toBeNull();
  }
  await save({ ...meta, payload: { ...meta.payload, parent_thread_id: 'parent' } });
  expect(await codexModelPolicy(path, 'root', 'turn', dir)).toBeNull();
});

async function authorityFixture() {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-parent-authority-')));
  const path = join(dir, 'rollout.jsonl');
  const meta = {
    type: 'session_meta',
    payload: {
      id: 'root',
      session_id: 'root',
      cli_version: '0.167.0-alpha.4.1',
      source: 'vscode',
      parent_thread_id: null,
      base_instructions: { text: 'BASE_AUTHORITY', provenance: { type: 'model' } },
      runtime_workspace_roots: [dir],
    },
  };
  const context = {
    type: 'turn_context',
    payload: {
      turn_id: 'turn',
      cwd: dir,
      approval_policy: 'on-request',
      approvals_reviewer: 'auto_review',
      sandbox_policy: { type: 'workspace-write' },
      permission_profile: {
        type: 'managed',
        network: 'restricted',
        file_system: {
          type: 'restricted',
          entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }],
        },
      },
      disabled_plugin_ids: [],
    },
  };
  const user = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'root',
      item: {
        id: 'user',
        type: 'UserMessage',
        content: [{ type: 'text', text: 'PRIVATE_USER_HISTORY' }],
      },
    },
  };
  const nativeState = (snapshot: Record<string, unknown> = context.payload) => [
    {
      type: 'world_state',
      payload: {
        full: true,
        state: {
          environments: {
            environments: { local: { cwd: dir, status: 'available', shell: 'zsh' } },
            filesystem: nativeLocalFilesystem(snapshot.permission_profile, [dir]),
          },
          environments_instructions: false,
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_id: 'root',
        thread_settings: { ...snapshot, runtime_workspace_roots: [dir] },
      },
    },
  ];
  const save = (rows: unknown[], includeNativeState = true) => {
    const index = rows.findIndex(
      (row) => row && typeof row === 'object' && 'type' in row && row.type === 'turn_context',
    );
    const saved = [...rows];
    if (includeNativeState && index >= 0)
      saved.splice(
        index,
        0,
        ...nativeState((saved[index] as { payload: Record<string, unknown> }).payload),
      );
    return writeFile(path, saved.map((row) => JSON.stringify(row)).join('\n'));
  };
  return { path, meta, context, user, save, nativeState };
}

const developer = (text: string, kind?: string) => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text }],
    ...(kind ? { internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] } } : {}),
  },
});

it('preserves bounded local authority from a large complete rollout without exporting user history', async () => {
  const f = await authorityFixture();
  await f.save([
    f.meta,
    developer('REGENERATED_PERMISSIONS', 'permissions.instructions'),
    developer('CUSTOM_SCOPE'),
    developer('SKILL_AUTHORITY', 'host_skills.instructions'),
    f.context,
    f.user,
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'PRIVATE_USER_HISTORY'.repeat(250_000) }],
      },
    },
  ]);
  const policy = await codexModelPolicy(f.path, 'root', 'turn', dir);
  expect(policy).toMatchObject({
    approvalsReviewer: 'auto_review',
    parent: {
      sessionId: 'root',
      turnId: 'turn',
      baseInstructions: 'BASE_AUTHORITY',
      developerInstructions: 'CUSTOM_SCOPE\n\nSKILL_AUTHORITY',
      runtimeWorkspaceRoots: [dir],
    },
  });
  expect(JSON.stringify(policy)).not.toContain('PRIVATE_USER_HISTORY');
  expect(JSON.stringify(policy)).not.toContain('REGENERATED_PERMISSIONS');
  expect(policy?.parent?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it('requires a native full local witness and owned applied settings, never user prose or creation roots alone', async () => {
  const f = await authorityFixture();
  await f.save([f.meta, f.context, f.user], false);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent).toBeUndefined();
  const [world] = f.nativeState();
  await f.save([f.meta, world, f.context, f.user], false);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent).toBeUndefined();
});

it.each(['remote', 'filesystem', 'foreign_settings', 'changed_policy', 'later_turn'])(
  'does not admit stale or foreign local authority: %s',
  async (kind) => {
    const f = await authorityFixture();
    const suffix: unknown[] = [];
    if (kind === 'remote')
      suffix.push({
        type: 'world_state',
        payload: {
          full: false,
          state: {
            environments: { environments: { remote: { cwd: '/remote', status: 'failed' } } },
          },
        },
      });
    if (kind === 'filesystem')
      suffix.push({
        type: 'world_state',
        payload: { full: false, state: { environments: { filesystem: 'unbound permissions' } } },
      });
    if (kind === 'foreign_settings' || kind === 'changed_policy')
      suffix.push({
        type: 'event_msg',
        payload: {
          type: 'thread_settings_applied',
          thread_id: kind === 'foreign_settings' ? 'foreign' : 'root',
          thread_settings: {
            ...f.context.payload,
            runtime_workspace_roots: [dir],
            ...(kind === 'changed_policy' ? { approvals_reviewer: 'user' } : {}),
          },
        },
      });
    if (kind === 'later_turn')
      suffix.push({ ...f.context, payload: { ...f.context.payload, turn_id: 'newer-turn' } });
    await f.save([f.meta, f.context, f.user, ...suffix]);
    expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent).toBeUndefined();
  },
);

it('binds current applied workspace roots instead of losing roots added after creation', async () => {
  const f = await authorityFixture();
  const added = join(dir, 'visualization');
  await mkdir(added);
  const roots = [dir, added];
  await f.save([
    f.meta,
    f.context,
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_id: 'root',
        thread_settings: { ...f.context.payload, runtime_workspace_roots: roots },
      },
    },
    {
      type: 'world_state',
      payload: {
        full: false,
        state: {
          environments: {
            filesystem: nativeLocalFilesystem(f.context.payload.permission_profile, roots),
          },
        },
      },
    },
  ]);
  const policy = await codexModelPolicy(f.path, 'root', 'turn', dir);
  expect(policy?.parent?.runtimeWorkspaceRoots).toEqual(roots);
  expect(policy?.parent?.transcriptPath).toBe(f.path);
});

it('replays environment patches without treating unrelated subagent or clock updates as authority drift', async () => {
  const f = await authorityFixture();
  await f.save([f.meta, f.context, f.user]);
  const original = (await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent?.fingerprint;
  await f.save([
    f.meta,
    f.context,
    f.user,
    {
      type: 'world_state',
      payload: {
        full: false,
        state: { environments: { subagents: 'unrelated workers', current_date: '2099-01-01' } },
      },
    },
  ]);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent?.fingerprint).toBe(original);
});

it.each([
  'encrypted',
  'nontext',
  'turn_override',
  'history_base',
  'relative_root',
  'duplicate_meta',
  'compaction',
])('keeps unavailable parent authority native: %s', async (kind) => {
  const f = await authorityFixture();
  const rows: unknown[] = [f.meta, f.context, f.user];
  if (kind === 'encrypted')
    rows.splice(1, 0, {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'encrypted_text', encrypted_content: 'opaque' }],
      },
    });
  if (kind === 'nontext')
    rows.splice(1, 0, {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_image', image_url: 'opaque' }],
      },
    });
  if (kind === 'turn_override')
    rows[1] = {
      ...f.context,
      payload: {
        ...f.context.payload,
        collaboration_mode: { settings: { developer_instructions: 'UNREPRESENTED_AUTHORITY' } },
      },
    };
  if (kind === 'history_base')
    rows[0] = {
      ...f.meta,
      payload: {
        ...f.meta.payload,
        history_base: { thread_id: 'root', end_ordinal_exclusive: 10, end_byte_offset: 1000 },
      },
    };
  if (kind === 'relative_root')
    rows[0] = { ...f.meta, payload: { ...f.meta.payload, runtime_workspace_roots: ['relative'] } };
  if (kind === 'duplicate_meta') rows.push(f.meta);
  if (kind === 'compaction') rows.push({ type: 'compacted', payload: {} });
  await f.save(rows);
  expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
});

it('bounds combined authority in UTF-8 bytes rather than character count', async () => {
  const f = await authorityFixture();
  await f.save([
    f.meta,
    developer('é'.repeat(70_000)),
    developer('é'.repeat(70_000)),
    f.context,
    f.user,
  ]);
  expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
});

it('refuses an oversized JSONL line before assembling the whole transcript', async () => {
  const f = await authorityFixture();
  await f.save([
    f.meta,
    f.context,
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'x'.repeat(8 * 1024 * 1024) }],
      },
    },
  ]);
  expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
});

it('rejects a transcript beyond the fixed total bound without reading a sparse payload', async () => {
  const f = await authorityFixture();
  await f.save([f.meta, f.context]);
  await truncate(f.path, 128 * 1024 * 1024 + 1);
  expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
});

it('binds authority drift while keeping ordinary conversation outside the fingerprint', async () => {
  const f = await authorityFixture();
  await f.save([f.meta, developer('KEEP_CONSTRAINT'), f.context, f.user]);
  const first = await codexModelPolicy(f.path, 'root', 'turn', dir);
  await f.save([f.meta, developer('KEEP_CONSTRAINT'), f.context]);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent?.fingerprint).toBe(
    first?.parent?.fingerprint,
  );
  await f.save([f.meta, developer('CHANGED_CONSTRAINT'), f.context]);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent?.fingerprint).not.toBe(
    first?.parent?.fingerprint,
  );
});

it('maps generated kinds to their exact fragments and retains other developer authority', async () => {
  const f = await authorityFixture();
  const mixed = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [
        { type: 'input_text', text: 'CHILD_REGENERATES' },
        { type: 'input_text', text: 'PRESERVE_EXACTLY' },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['permissions.instructions', 'unknown.custom.authority'],
      },
    },
  };
  await f.save([f.meta, mixed, f.context]);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent?.developerInstructions).toBe(
    'PRESERVE_EXACTLY',
  );
  mixed.payload.internal_chat_message_metadata_passthrough.content_item_kinds.pop();
  await f.save([f.meta, mixed, f.context]);
  expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
});

it('preserves the raw default-mode template separately from its regenerated rendered fragment', async () => {
  const f = await authorityFixture();
  const mode = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'NATIVE_RENDERED_MODE' }],
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn',
        content_item_kinds: ['collaboration_mode.instructions'],
        content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
      },
    },
  };
  const context = {
    ...f.context,
    payload: {
      ...f.context.payload,
      collaboration_mode: {
        mode: 'default',
        settings: {
          model: 'native-parent',
          reasoning_effort: 'high',
          developer_instructions: 'EXACT_RAW_TEMPLATE {mode}',
        },
      },
    },
  };
  await f.save([
    f.meta,
    {
      type: 'response_item',
      payload: { type: 'additional_tools', id: 'catalog', role: 'developer', tools: [] },
    },
    developer('OTHER_AUTHORITY'),
    mode,
    context,
  ]);
  expect((await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent).toMatchObject({
    developerInstructions: 'OTHER_AUTHORITY',
    collaborationMode: { mode: 'default', developerInstructions: 'EXACT_RAW_TEMPLATE {mode}' },
  });
  for (const mutate of [
    () => {
      context.payload.collaboration_mode.mode = 'plan';
    },
    () => {
      context.payload.collaboration_mode.mode = 'default';
      mode.payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign';
    },
    () => {
      mode.payload.internal_chat_message_metadata_passthrough.turn_id = 'turn';
      mode.payload.internal_chat_message_metadata_passthrough.content_item_metadata[0]!.provenance.hook = true;
    },
  ]) {
    mutate();
    await f.save([f.meta, mode, context]);
    expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
  }
});

it('carries unchanged proven native default instructions across turns without accepting an unwitnessed replacement', async () => {
  const f = await authorityFixture();
  const rendered = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'NATIVE_RENDERED_DEFAULT' }],
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn',
        content_item_kinds: ['collaboration_mode.instructions'],
        content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
      },
    },
  };
  const initial = {
    ...f.context,
    payload: {
      ...f.context.payload,
      collaboration_mode: {
        mode: 'default',
        settings: {
          model: 'native-parent',
          reasoning_effort: 'high',
          developer_instructions: 'RAW_DEFAULT',
        },
      },
    },
  };
  const later = { ...initial, payload: { ...initial.payload, turn_id: 'later' } };
  await f.save([f.meta, rendered, initial, later]);
  expect((await codexModelPolicy(f.path, 'root', 'later', dir))?.parent?.collaborationMode).toEqual(
    {
      mode: 'default',
      developerInstructions: 'RAW_DEFAULT',
    },
  );
  const changed = {
    ...later,
    payload: {
      ...later.payload,
      collaboration_mode: {
        ...later.payload.collaboration_mode,
        settings: {
          ...later.payload.collaboration_mode.settings,
          developer_instructions: 'UNWITNESSED_CHANGE',
        },
      },
    },
  };
  const applied = {
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_id: 'root',
      thread_settings: { ...changed.payload, runtime_workspace_roots: [dir] },
    },
  };
  await f.save([f.meta, rendered, initial, applied, changed]);
  expect(await codexModelPolicy(f.path, 'root', 'later', dir)).toBeNull();
});

it('binds explicitly served external tool identities without copying their descriptions', async () => {
  const f = await authorityFixture();
  const catalog = {
    type: 'response_item',
    payload: {
      type: 'additional_tools',
      id: 'catalog',
      role: 'developer',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__neon',
          tools: [
            { type: 'function', name: 'write', description: 'PRIVATE_DESCRIPTION' },
            { type: 'custom', name: 'read' },
          ],
        },
        { type: 'namespace', name: 'functions', tools: [] },
      ],
    },
  };
  await f.save([f.meta, catalog, f.context]);
  const parent = (await codexModelPolicy(f.path, 'root', 'turn', dir))?.parent;
  expect(parent?.externalTools).toEqual([{ namespace: 'mcp__neon', tools: ['read', 'write'] }]);
  expect(JSON.stringify(parent)).not.toContain('PRIVATE_DESCRIPTION');
  catalog.payload.tools[0]!.tools[0]!.type = 'unknown';
  await f.save([f.meta, catalog, f.context]);
  expect(await codexModelPolicy(f.path, 'root', 'turn', dir)).toBeNull();
});

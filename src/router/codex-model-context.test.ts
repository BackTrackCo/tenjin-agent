import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexModelPolicy } from './codex-model-context';

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
  for (const cli_version of ['0.167.0', '0.167.0-alpha.4.2', '0.163.1']) {
    await save({ ...meta, payload: { ...meta.payload, cli_version } });
    expect(await codexModelPolicy(path, 'root', 'turn', dir)).toBeNull();
  }
  await save({ ...meta, payload: { ...meta.payload, parent_thread_id: 'parent' } });
  expect(await codexModelPolicy(path, 'root', 'turn', dir)).toBeNull();
});

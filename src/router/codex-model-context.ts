import { open, realpath } from 'node:fs/promises';
import { parseCodexHistory } from './codex-history';
import type { CodexModelPolicy } from './codex-model-gates';
import { isQualifiedCodexModelVersion } from '../lib/codex-model-version';

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Only called after admitCodexHookEvent. No model-supplied path or policy is accepted. */
export async function codexModelPolicy(
  path: string,
  session: string,
  turn: string,
  cwd: string,
): Promise<CodexModelPolicy | null> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4_000_001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4_000_000) return null;
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (parseCodexHistory(raw, session) === null) return null;
    const rows: unknown[] = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const meta = rows[0];
    if (
      !record(meta) ||
      meta.type !== 'session_meta' ||
      !record(meta.payload) ||
      !isQualifiedCodexModelVersion(meta.payload.cli_version) ||
      meta.payload.source !== 'vscode'
    )
      return null;
    let found: Record<string, unknown> | undefined;
    for (const row of rows) {
      if (!record(row) || row.type !== 'turn_context' || !record(row.payload)) continue;
      if (row.payload.turn_id === turn) found = row.payload;
    }
    if (
      !found ||
      typeof found.cwd !== 'string' ||
      (await realpath(found.cwd)) !== (await realpath(cwd)) ||
      found.approval_policy === undefined ||
      found.approvals_reviewer === undefined ||
      !record(found.sandbox_policy) ||
      !record(found.permission_profile) ||
      !Array.isArray(found.disabled_plugin_ids)
    )
      return null;
    return {
      approvalPolicy: found.approval_policy,
      approvalsReviewer: found.approvals_reviewer,
      sandbox: found.sandbox_policy,
      permissionProfile: found.permission_profile,
      disabledPluginIds: found.disabled_plugin_ids,
    } as CodexModelPolicy;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

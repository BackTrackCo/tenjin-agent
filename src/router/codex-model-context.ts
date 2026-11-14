import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ownedCodexSessionMeta } from './codex-history';
import type { CodexModelPolicy } from './codex-model-gates';
import { isQualifiedCodexModelVersion } from '../lib/codex-model-version';
import { canonicalHash } from '../lib/request-schema';

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_ROLLOUT_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORITY_BYTES = 256 * 1024;
const REGENERATED_KINDS = new Set([
  'model.base_instructions',
  'permissions.instructions',
  'collaboration_mode.instructions',
  'tools.deferred_namespaces',
  'multi_agent.role_instructions',
  'multi_agent.mode_instructions',
  'additional_content.codex_apps_client_time_context',
  'generic.turn_aborted',
]);

function customTurnInstructions(context: Record<string, unknown>): boolean {
  if (
    [
      'base_instructions',
      'developer_instructions',
      'baseInstructions',
      'developerInstructions',
      'instructions',
      'model_instructions_file',
      'experimental_instructions_file',
    ].some((key) => context[key] != null)
  )
    return true;
  return false;
}

/** Only called after admitCodexHookEvent. No model-supplied path or policy is accepted. */
export async function codexModelPolicy(
  path: string,
  session: string,
  turn: string,
  cwd: string,
): Promise<CodexModelPolicy | null> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ROLLOUT_BYTES) return null;
    let meta: Record<string, unknown> | undefined;
    let found: Record<string, unknown> | undefined;
    let baseInstructions: string | undefined;
    let runtimeWorkspaceRoots: string[] | undefined;
    const developerFragments: string[] = [];
    const collaborationSourceTurns = new Set<string>();
    const externalTools = new Map<string, Set<string>>();
    let authorityBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const visit = (bytes: Buffer): boolean => {
      const line = decoder.decode(bytes);
      if (!line.trim()) return true;
      const row: unknown = JSON.parse(line);
      if (!record(row) || !record(row.payload)) return false;
      const payload = row.payload;
      if (!meta) {
        if (
          row.type !== 'session_meta' ||
          !ownedCodexSessionMeta(payload, session) ||
          !isQualifiedCodexModelVersion(payload.cli_version) ||
          payload.source !== 'vscode' ||
          payload.history_base != null
        )
          return false;
        meta = payload;
        if (payload.base_instructions != null) {
          const base = payload.base_instructions;
          const roots = payload.runtime_workspace_roots;
          if (
            !record(base) ||
            typeof base.text !== 'string' ||
            base.text.includes('\0') ||
            Object.keys(base).some((key) => !['text', 'provenance'].includes(key)) ||
            !Array.isArray(roots) ||
            roots.length === 0 ||
            roots.length > 256 ||
            roots.some(
              (root) =>
                typeof root !== 'string' ||
                !isAbsolute(root) ||
                root.includes('\0') ||
                Buffer.byteLength(root) > 8192,
            ) ||
            new Set(roots).size !== roots.length
          )
            return false;
          baseInstructions = base.text;
          runtimeWorkspaceRoots = roots as string[];
          authorityBytes = Buffer.byteLength(baseInstructions);
          if (authorityBytes > MAX_AUTHORITY_BYTES) return false;
        }
        return true;
      }
      if (
        row.type === 'session_meta' ||
        row.type === 'compacted' ||
        ['context_compacted', 'compaction', 'compaction_completed'].includes(String(payload.type))
      )
        return false;
      if (row.type === 'turn_context') {
        if (customTurnInstructions(payload)) return false;
        if (payload.turn_id === turn) found = payload;
        return true;
      }
      if (row.type !== 'response_item' || payload.role !== 'developer') return true;
      if (payload.type === 'additional_tools') {
        if (
          !Array.isArray(payload.tools) ||
          !Object.keys(payload).every((key) => ['type', 'id', 'role', 'tools'].includes(key))
        )
          return false;
        for (const namespace of payload.tools) {
          if (!record(namespace) || typeof namespace.name !== 'string') return false;
          if (!namespace.name.startsWith('mcp__')) continue;
          if (
            namespace.type !== 'namespace' ||
            !/^mcp__[A-Za-z0-9_.-]{1,200}$/.test(namespace.name) ||
            !Array.isArray(namespace.tools)
          )
            return false;
          const names = externalTools.get(namespace.name) ?? new Set<string>();
          for (const tool of namespace.tools) {
            if (
              !record(tool) ||
              !['function', 'custom'].includes(String(tool.type)) ||
              typeof tool.name !== 'string' ||
              !/^[A-Za-z0-9_.-]{1,200}$/.test(tool.name)
            )
              return false;
            names.add(tool.name);
          }
          externalTools.set(namespace.name, names);
        }
        return true;
      }
      if (
        payload.type !== 'message' ||
        payload.encrypted_content != null ||
        !Array.isArray(payload.content)
      )
        return false;
      const metadata = payload.internal_chat_message_metadata_passthrough;
      if (metadata != null && !record(metadata)) return false;
      const kinds = record(metadata) ? metadata.content_item_kinds : undefined;
      if (
        kinds != null &&
        (!Array.isArray(kinds) ||
          kinds.some((kind) => typeof kind !== 'string') ||
          (kinds.length !== 0 && kinds.length !== payload.content.length))
      )
        return false;
      for (const [index, item] of payload.content.entries()) {
        if (
          !record(item) ||
          item.type !== 'input_text' ||
          typeof item.text !== 'string' ||
          item.text.includes('\0') ||
          Object.keys(item).some((key) => !['type', 'text'].includes(key))
        )
          return false;
        if (Array.isArray(kinds) && kinds[index] === 'collaboration_mode.instructions') {
          const items = record(metadata) ? metadata.content_item_metadata : undefined;
          const provenance =
            Array.isArray(items) && record(items[index]) ? items[index].provenance : undefined;
          if (
            !record(metadata) ||
            typeof metadata.turn_id !== 'string' ||
            !record(provenance) ||
            provenance.type !== 'harness' ||
            provenance.hook !== false
          )
            return false;
          collaborationSourceTurns.add(metadata.turn_id);
        }
        if (Array.isArray(kinds) && REGENERATED_KINDS.has(String(kinds[index]))) continue;
        authorityBytes += Buffer.byteLength(item.text) + (developerFragments.length ? 2 : 0);
        if (authorityBytes > MAX_AUTHORITY_BYTES) return false;
        developerFragments.push(item.text);
      }
      return true;
    };
    let parts: Buffer[] = [];
    let lineBytes = 0;
    let totalBytes = 0;
    const stream = file.createReadStream({
      autoClose: false,
      start: 0,
      end: stat.size - 1,
      highWaterMark: 64 * 1024,
    });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_ROLLOUT_BYTES) return null;
      let offset = 0;
      while (offset < buffer.length) {
        const newline = buffer.indexOf(10, offset);
        const fragment = buffer.subarray(offset, newline < 0 ? buffer.length : newline);
        parts.push(fragment);
        lineBytes += fragment.byteLength;
        if (lineBytes > MAX_LINE_BYTES) return null;
        if (newline < 0) break;
        if (!visit(Buffer.concat(parts, lineBytes))) return null;
        parts = [];
        lineBytes = 0;
        offset = newline + 1;
      }
    }
    if (lineBytes > 0 && !visit(Buffer.concat(parts, lineBytes))) return null;
    if (
      !meta ||
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
    let collaborationMode: NonNullable<CodexModelPolicy['parent']>['collaborationMode'];
    if (found.collaboration_mode != null) {
      const mode = found.collaboration_mode;
      if (
        !record(mode) ||
        mode.mode !== 'default' ||
        !record(mode.settings) ||
        Object.keys(mode).some((key) => !['mode', 'settings'].includes(key)) ||
        Object.keys(mode.settings).some(
          (key) => !['model', 'reasoning_effort', 'developer_instructions'].includes(key),
        )
      )
        return null;
      const developer = mode.settings.developer_instructions;
      if (
        developer !== null &&
        (typeof developer !== 'string' ||
          developer.includes('\0') ||
          !collaborationSourceTurns.has(turn))
      )
        return null;
      authorityBytes += typeof developer === 'string' ? Buffer.byteLength(developer) : 0;
      if (authorityBytes > MAX_AUTHORITY_BYTES) return null;
      collaborationMode = { mode: 'default', developerInstructions: developer as string | null };
    }
    const parent =
      baseInstructions !== undefined && runtimeWorkspaceRoots
        ? {
            sessionId: session,
            turnId: turn,
            baseInstructions,
            developerInstructions: developerFragments.join('\n\n'),
            runtimeWorkspaceRoots,
            ...(collaborationMode ? { collaborationMode } : {}),
            ...(externalTools.size
              ? {
                  externalTools: [...externalTools]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([namespace, tools]) => ({ namespace, tools: [...tools].sort() })),
                }
              : {}),
          }
        : undefined;
    return {
      approvalPolicy: found.approval_policy,
      approvalsReviewer: found.approvals_reviewer,
      sandbox: found.sandbox_policy,
      permissionProfile: found.permission_profile,
      disabledPluginIds: found.disabled_plugin_ids,
      ...(parent ? { parent: { ...parent, fingerprint: canonicalHash(parent) } } : {}),
    } as CodexModelPolicy;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isRecord } from '../lib/guards';
import type { NativeLocalEnvironment } from './codex-local-environment';

export interface CodexModelPolicy {
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandbox: unknown;
  permissionProfile?: unknown;
  disabledPluginIds?: string[];
  /** Trusted owned rollout authority; local worker admission only, never Jev input. */
  parent?: {
    sessionId: string;
    turnId: string;
    baseInstructions: string;
    developerInstructions: string;
    runtimeWorkspaceRoots: string[];
    collaborationMode?: { mode: 'default'; developerInstructions: string | null };
    externalTools?: Array<{ namespace: string; tools: string[] }>;
    transcriptPath?: string;
    localEnvironment?: NativeLocalEnvironment;
    fingerprint: string;
  };
}
export async function policyRules(layers: unknown): Promise<string[] | null> {
  if (!Array.isArray(layers)) return null;
  const files: string[] = [];
  //0.163 config/read lists highest precedence first; native execpolicy loads low to high.
  for (const layer of [...layers].reverse()) {
    if (!isRecord(layer) || !isRecord(layer.name)) return null;
    if (layer.disabledReason != null) continue;
    const source = layer.name;
    let folder: string | undefined;
    if (['packagedDefaults', 'system', 'user'].includes(String(source.type))) {
      if (typeof source.file !== 'string' || !isAbsolute(source.file)) return null;
      folder = dirname(source.file);
    } else if (source.type === 'project') {
      if (typeof source.dotCodexFolder !== 'string' || !isAbsolute(source.dotCodexFolder))
        return null;
      folder = source.dotCodexFolder;
    } else if (source.type !== 'sessionFlags') return null;
    if (!folder) continue;
    let rows;
    try {
      rows = await readdir(join(folder, 'rules'), { withFileTypes: true });
    } catch (e) {
      if (isRecord(e) && e.code === 'ENOENT') continue;
      return null;
    }
    for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!row.name.endsWith('.rules')) continue;
      // Symlink or directory rules have not been qualified.
      if (!row.isFile()) return null;
      files.push(join(folder, 'rules', row.name));
    }
  }
  return files;
}

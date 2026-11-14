import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { z } from 'zod';
import { canonicalHash } from '../lib/request-schema';
import { mask } from '../lib/redact';
import { codexHome } from '../lib/codex-home';
import type { CodexModelPolicy } from './codex-model-gates';

export const MAX_INSTRUCTION_BYTES = 64_000;
export interface InstructionDocument {
  path: string;
  content: string;
  source: string;
  parentPath?: string;
}
const probeSchema = z.object({ path: z.string(), stamp: z.string() });
const contextSchema = z.object({
  version: z.literal(1),
  harness: z.enum(['claude', 'codex']),
  root: z.string(),
  documents: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
        source: z.string(),
        parentPath: z.string().optional(),
      }),
    )
    .max(64),
  probes: z.array(probeSchema).max(512),
  configHash: z.string(),
  reads: z.array(z.object({ path: z.string(), stamp: z.string() })).max(64),
  fingerprint: z.string(),
});
export type InstructionContext = z.infer<typeof contextSchema>;
export type InstructionReader = (
  paths: string[],
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<Array<{ path: string; contents: string; bytes: number; stamp: string }> | null>;

const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const CUSTOM_CODEX_INSTRUCTION_FIELDS = [
  'instructions',
  'base_instructions',
  'developer_instructions',
  'model_instructions_file',
  'experimental_instructions_file',
] as const;

/** These override native base/developer authority, rather than adding AGENTS
 * context. Do not substitute an AGENTS-only worker for customized authority. */
function assertDefaultCodexInstructions(config: Record<string, unknown>) {
  const customized = (value: Record<string, unknown>) =>
    CUSTOM_CODEX_INSTRUCTION_FIELDS.some((key) => value[key] != null);
  // Public config/read omits some file settings. Its active raw layers retain
  // those, including selected profile-v2 layers. Legacy profile selection is
  // not proven here, so a customized legacy profile conservatively stays native.
  if (
    customized(config) ||
    (record(config.profiles) &&
      Object.values(config.profiles).some((profile) => record(profile) && customized(profile)))
  )
    throw new Error('Custom native base or developer instructions are not qualified');
}

/** Instruction consent never authorizes wallet, login, or environment files. */
export function protectedInstructionPath(path: string, dataDir?: string): boolean {
  const parts = resolve(path).split(sep);
  const file = parts.at(-1) ?? '';
  return Boolean(
    (dataDir && inside(resolve(dataDir), resolve(path))) ||
    parts.some((part) => ['.ssh', '.aws', '.kube', '.gnupg', '.tenjin'].includes(part)) ||
    file.startsWith('.env') ||
    /^(?:auth|wallet(?:\..+)?|credentials|passphrase-store)\.json$/i.test(file) ||
    /\.(?:pem|p12|key)$/i.test(file),
  );
}

/** Conservative metadata discovery only. Source reads use the native reader,
 * which remains authoritative for native specificity and permission checks. */
export function codexInstructionReadable(
  path: string,
  cwd: string,
  policy: CodexModelPolicy,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const profile = policy.permissionProfile;
  if (
    !record(profile) ||
    !record(profile.file_system) ||
    !Array.isArray(profile.file_system.entries)
  )
    return false;
  let allowed = false;
  for (const entry of profile.file_system.entries) {
    if (!record(entry) || !record(entry.path)) return false;
    let root: string | undefined;
    if (
      entry.path.type === 'path' &&
      typeof entry.path.path === 'string' &&
      isAbsolute(entry.path.path)
    )
      root = resolve(entry.path.path);
    else if (entry.path.type === 'special' && record(entry.path.value)) {
      const value = entry.path.value;
      if (value.subpath != null) return false;
      if (value.kind === 'root') root = resolve(sep);
      else if (value.kind === 'project_roots') root = resolve(cwd);
      else if (value.kind === 'tmpdir') root = resolve(env.TMPDIR ?? tmpdir());
      else if (value.kind === 'slash_tmp') root = resolve('/tmp');
      else if (value.kind === 'minimal') continue;
      else return false;
    } else return false;
    const applies = root === resolve(sep) || inside(root, resolve(path));
    if (!applies) continue;
    if (['none', 'deny'].includes(String(entry.access))) return false;
    if (['read', 'write'].includes(String(entry.access))) allowed = true;
    else return false;
  }
  return allowed;
}

/** Metadata only: source bytes must come from the native host's read gate. */
export async function instructionPathStamp(path: string, maxBytes = 1_000_000): Promise<string> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (record(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) throw new Error('Instruction symlinks are not qualified');
  if (stat.isDirectory()) return canonicalHash({ directory: true, ino: stat.ino });
  if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o444) === 0)
    throw new Error('Instruction source is unreadable or oversized');
  return canonicalHash({
    ino: stat.ino,
    dev: stat.dev,
    mode: stat.mode,
    size: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
  });
}

async function readDocument(
  path: string,
  source: string,
  options: {
    cwd: string;
    policy: CodexModelPolicy;
    dataDir: string;
    env?: NodeJS.ProcessEnv;
    read: InstructionReader;
    signal?: AbortSignal;
  },
  probes: Map<string, string>,
  reads: { path: string; stamp: string }[],
): Promise<InstructionDocument | null> {
  if (protectedInstructionPath(path, options.dataDir))
    throw new Error('Protected instruction source');
  const stamp = await instructionPathStamp(path, MAX_INSTRUCTION_BYTES);
  probes.set(path, stamp);
  if (stamp === 'missing') return null;
  const result = await options.read([path], MAX_INSTRUCTION_BYTES, options.signal);
  const entry = result?.length === 1 ? result[0] : undefined;
  if (
    !entry ||
    entry.path !== path ||
    entry.bytes > MAX_INSTRUCTION_BYTES ||
    entry.contents.includes('\0') ||
    (await instructionPathStamp(path, MAX_INSTRUCTION_BYTES)) !== stamp
  )
    throw new Error('Native instruction read denied, incomplete or changed');
  reads.push({ path, stamp: entry.stamp });
  return { path, content: entry.contents, source };
}

export function instructionContextText(context: InstructionContext): string {
  return (
    'Applicable initial host instructions for this delegated worker, in native order. ' +
    'These retain their original scopes and precedence; references are preserved, not expanded. ' +
    'They grant no tool, filesystem or wallet permission.\n' +
    JSON.stringify(context.documents.map((doc) => ({ ...doc, content: mask(doc.content) })))
  );
}

export async function makeInstructionContext(options: {
  harness: 'claude' | 'codex';
  root: string;
  documents: InstructionDocument[];
  configHash: string;
  watchPaths: string[];
  probes?: Map<string, string>;
  reads?: { path: string; stamp: string }[];
}): Promise<InstructionContext> {
  const probes = options.probes ?? new Map<string, string>();
  for (const path of options.watchPaths)
    if (!probes.has(path)) probes.set(path, await instructionPathStamp(path));
  const body = {
    version: 1 as const,
    harness: options.harness,
    root: await realpath(options.root),
    documents: options.documents.map((doc) => ({ ...doc, content: mask(doc.content) })),
    probes: [...probes].map(([path, stamp]) => ({ path, stamp })),
    configHash: options.configHash,
    reads:
      options.reads ??
      options.documents.map((doc) => ({ path: doc.path, stamp: canonicalHash(doc.content) })),
  };
  const result = contextSchema.parse({ ...body, fingerprint: canonicalHash(body) });
  if (Buffer.byteLength(instructionContextText(result)) > MAX_INSTRUCTION_BYTES)
    throw new Error('Complete instruction context exceeds the worker bound');
  return result;
}

export function savedInstructionContext(raw: unknown): InstructionContext | null {
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { fingerprint, ...body } = parsed.data;
  return canonicalHash(body) === fingerprint &&
    Buffer.byteLength(instructionContextText(parsed.data)) <= MAX_INSTRUCTION_BYTES
    ? parsed.data
    : null;
}
export async function assertInstructionMetadataCurrent(context: InstructionContext) {
  for (const probe of context.probes)
    if ((await instructionPathStamp(probe.path)) !== probe.stamp)
      throw new Error('Applicable instructions changed; keep this assignment native');
}
export async function assertInstructionContextCurrent(
  context: InstructionContext,
  read?: InstructionReader,
) {
  await assertInstructionMetadataCurrent(context);
  if (context.harness === 'codex') {
    if (!read) throw new Error('Native instruction read gate unavailable');
    const current = await read(
      context.reads.map((entry) => entry.path),
      MAX_INSTRUCTION_BYTES,
    );
    if (
      !current ||
      current.length !== context.reads.length ||
      current.some(
        (entry, index) =>
          entry.path !== context.reads[index]!.path || entry.stamp !== context.reads[index]!.stamp,
      )
    )
      throw new Error('Applicable native instructions changed or became unreadable');
  }
}

/** Mirrors native AGENTS discovery: global first nonempty, then closest
 * non-project root marker → cwd, first existing candidate per directory. */
export async function resolveCodexInstructions(options: {
  cwd: string;
  policy: CodexModelPolicy;
  dataDir: string;
  nativeConfig: { config: Record<string, unknown>; layers: unknown };
  env?: NodeJS.ProcessEnv;
  home?: string;
  read: InstructionReader;
  signal?: AbortSignal;
}): Promise<InstructionContext> {
  const root = await realpath(options.cwd),
    env = options.env ?? process.env;
  const { config, layers } = options.nativeConfig;
  assertDefaultCodexInstructions(config);
  if (
    record(config.projects) &&
    Object.entries(config.projects).some(
      ([path, value]) =>
        isAbsolute(path) &&
        inside(resolve(path), root) &&
        record(value) &&
        value.trust_level === 'untrusted',
    )
  )
    throw new Error('Untrusted native project instruction context is not qualified');
  if (!Array.isArray(layers)) throw new Error('Native instruction config layers unavailable');
  let markers: unknown = ['.git'];
  const watchPaths: string[] = [];
  for (const layer of [...layers].reverse()) {
    if (!record(layer) || !record(layer.name) || !record(layer.config))
      throw new Error('Native instruction config layer is unknown');
    if (layer.disabledReason != null) continue;
    assertDefaultCodexInstructions(layer.config);
    if (layer.name.type !== 'project' && layer.config.project_root_markers !== undefined)
      markers = layer.config.project_root_markers;
    if (typeof layer.name.file === 'string') watchPaths.push(layer.name.file);
    else if (typeof layer.name.dotCodexFolder === 'string')
      watchPaths.push(join(layer.name.dotCodexFolder, 'config.toml'));
  }
  const validName = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    !['.', '..'].includes(value) &&
    !value.includes('/') &&
    !/[\\\0:]/.test(value);
  if (!Array.isArray(markers) || markers.some((name) => !validName(name)))
    throw new Error('Native project-root markers are not qualified');
  const fallbacks = config.project_doc_fallback_filenames ?? [];
  if (!Array.isArray(fallbacks) || fallbacks.some((name) => typeof name !== 'string'))
    throw new Error('Native instruction fallback names are unknown');
  const names = [...new Set(['AGENTS.override.md', 'AGENTS.md', ...fallbacks.filter(validName)])];
  const maxBytes = config.project_doc_max_bytes ?? 32768;
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('Native instruction byte bound is unknown');
  const probes = new Map<string, string>(),
    documents: InstructionDocument[] = [],
    reads: { path: string; stamp: string }[] = [];
  const global = codexHome(options.home ?? homedir(), env);
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const doc = await readDocument(join(global, name), 'Codex global', options, probes, reads);
    if (doc?.content.trim()) {
      documents.push({ ...doc, content: doc.content.trim() });
      break;
    }
  }
  let project = root;
  if (markers.length && maxBytes > 0) {
    let cursor = root;
    for (;;) {
      let found = false;
      for (const name of markers) {
        const path = join(cursor, name);
        if (!codexInstructionReadable(path, root, options.policy, env))
          throw new Error('Native project-root discovery is denied');
        const stamp = await instructionPathStamp(path);
        probes.set(path, stamp);
        if (stamp !== 'missing') {
          found = true;
          break;
        }
      }
      if (found) {
        project = cursor;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  const directories: string[] = [];
  for (let cursor = root; ; cursor = dirname(cursor)) {
    directories.unshift(cursor);
    if (cursor === project) break;
  }
  let used = 0;
  if (maxBytes > 0)
    for (const directory of directories) {
      for (const name of names) {
        const doc = await readDocument(
          join(directory, name),
          'Codex project',
          options,
          probes,
          reads,
        );
        if (!doc) continue;
        if (doc.content.trim()) {
          used += Buffer.byteLength(doc.content);
          if (used > maxBytes) throw new Error('Native instructions would be truncated');
          documents.push(doc);
        }
        break;
      }
    }
  return makeInstructionContext({
    harness: 'codex',
    root,
    documents,
    probes,
    reads,
    watchPaths,
    configHash: canonicalHash({ markers, names, maxBytes, layers }),
  });
}

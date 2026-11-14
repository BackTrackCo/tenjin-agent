import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { withAppServer, type CodexAppRequest } from '../lib/codex-app-server';
import { codexHome } from '../lib/codex-home';
import { QUALIFIED_CODEX_MODEL_VERSIONS } from '../lib/codex-model-version';
import { isRecord } from '../lib/guards';
import { dataDir } from '../lib/paths';
import { canonicalHash } from '../lib/request-schema';
import type { CodexModelPolicy } from './codex-model-gates';

export interface CodexInstructionReadOptions {
  cwd: string;
  policy: CodexModelPolicy;
  dataDir?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  protectedPaths?: string[];
}
export interface CodexInstructionFile {
  path: string;
  contents: string;
  bytes: number;
  stamp: string;
}
export interface CodexInstructionProfile {
  name: string;
  overrides: string[];
}
const MAX_BYTES = 64_000;
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

function privatePaths(options: CodexInstructionReadOptions): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return [
    options.dataDir ?? dataDir(env),
    ...['.ssh', '.aws', '.kube', '.gnupg', '.claude', '.netrc', '.npmrc', '.git-credentials'].map(
      (name) => join(homedir(), name),
    ),
    join(codexHome(home, env), 'auth.json'),
    join(homedir(), '.claude.json'),
    ...(options.protectedPaths ?? []),
  ];
}

function privateInstructionPath(path: string, protectedPaths: string[]): boolean {
  const parts = path.split(sep),
    file = basename(path);
  return (
    protectedPaths.some((p) => inside(resolve(p), path)) ||
    parts.some((p) => ['.ssh', '.aws', '.kube', '.gnupg', '.tenjin'].includes(p)) ||
    file.startsWith('.env') ||
    /^(?:auth|wallet(?:\..+)?|credentials|passphrase-store)\.json$/i.test(file) ||
    /^(?:\.netrc|\.npmrc|\.git-credentials)$/i.test(file) ||
    /\.(?:pem|p12|key)$/i.test(file)
  );
}

/** Serialize captured native entries without deciding which ACL applies.
 * The maintained Codex resolver enforces specificity and read denials. */
export function codexInstructionProfile(
  options: CodexInstructionReadOptions,
): CodexInstructionProfile | null {
  const p = options.policy.permissionProfile;
  if (
    !isRecord(p) ||
    p.type !== 'managed' ||
    p.network !== 'restricted' ||
    Object.keys(p).some((k) => !['type', 'file_system', 'network'].includes(k)) ||
    !isRecord(p.file_system) ||
    p.file_system.type !== 'restricted' ||
    !Array.isArray(p.file_system.entries) ||
    p.file_system.entries.length > 256 ||
    Object.keys(p.file_system).some((k) => !['type', 'entries'].includes(k))
  )
    return null;
  const entries = new Map<string, string>();
  for (const entry of p.file_system.entries) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.path) ||
      !['read', 'write', 'deny', 'none'].includes(String(entry.access)) ||
      Object.keys(entry).some((k) => !['path', 'access', 'missing_path_behavior'].includes(k)) ||
      (entry.missing_path_behavior != null &&
        (entry.missing_path_behavior !== 'skip' || entry.access === 'write'))
    )
      return null;
    let path: string;
    if (
      entry.path.type === 'path' &&
      typeof entry.path.path === 'string' &&
      isAbsolute(entry.path.path) &&
      Object.keys(entry.path).length === 2
    )
      path = entry.path.path;
    else if (
      entry.path.type === 'special' &&
      isRecord(entry.path.value) &&
      Object.keys(entry.path).length === 2 &&
      Object.keys(entry.path.value).length === 1 &&
      ['root', 'minimal', 'slash_tmp', 'tmpdir'].includes(String(entry.path.value.kind))
    )
      path = `:${entry.path.value.kind}`;
    else return null;
    // Ambiguous duplicates and unrepresentable globs stay native. Optional
    // read/deny restrictions are retained even when absent, which is stricter.
    if (entries.has(path)) return null;
    entries.set(path, entry.access === 'none' ? 'deny' : String(entry.access));
  }
  for (const path of privatePaths(options)) {
    if (!isAbsolute(path)) return null;
    // Do not allow an inherited child grant to override a credential shield.
    for (const key of entries.keys()) if (inside(path, key)) entries.delete(key);
    entries.set(path, 'deny');
  }
  const filesystem = `{ ${[...entries].map(([p, a]) => `${JSON.stringify(p)} = ${JSON.stringify(a)}`).join(', ')} }`;
  if (Buffer.byteLength(filesystem) > 64_000) return null;
  const name = `tenjin-instructions-${canonicalHash(filesystem).slice(0, 16)}`;
  return {
    name,
    overrides: [
      `permissions.${name}.filesystem=${filesystem}`,
      `permissions.${name}.network.enabled=false`,
    ],
  };
}

/** Fixed host-configuration reader; never exposed as a model tool or argv API. */
export async function readCodexInstructionFilesOnServer(
  request: CodexAppRequest,
  options: CodexInstructionReadOptions,
  paths: string[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<CodexInstructionFile[] | null> {
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  signal = AbortSignal.any([signal, AbortSignal.timeout(7_000)]);
  const profile = codexInstructionProfile(options);
  if (
    !profile ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_BYTES ||
    paths.length > 64 ||
    new Set(paths).size !== paths.length
  )
    return null;
  const shields = privatePaths(options);
  try {
    const results: CodexInstructionFile[] = [];
    let remaining = maxBytes;
    for (const path of paths) {
      signal.throwIfAborted();
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        path.includes('\0') ||
        Buffer.byteLength(path) > 8192 ||
        privateInstructionPath(path, shields) ||
        (await realpath(path)) !== path
      )
        return null;
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > remaining ||
        (before.mode & 0o444) === 0
      )
        return null;
      const processId = `tenjin-instructions-${randomUUID()}`;
      const abort = () => {
        void request('command/exec/terminate', { processId });
      };
      signal.addEventListener('abort', abort, { once: true });
      let result: unknown;
      try {
        signal.throwIfAborted();
        // base64 preserves invalid UTF-8 bytes so we can reject them, rather
        // than accepting the command transport's lossy string decoding.
        result = await request(
          'command/exec',
          {
            command: ['/usr/bin/base64', '-i', path],
            cwd: options.cwd,
            processId,
            permissionProfile: profile.name,
            timeoutMs: 2_000,
            outputBytesCap: Math.ceil(remaining / 3) * 4 + 2048,
            env: { LANG: 'C', LC_ALL: 'C', NODE_OPTIONS: null, TENJIN_WALLET_PASSPHRASE: null },
          },
          2_500,
        );
      } finally {
        signal.removeEventListener('abort', abort);
        await request('command/exec/terminate', { processId }, 250);
      }
      signal.throwIfAborted();
      if (!isRecord(result) || result.exitCode !== 0 || typeof result.stdout !== 'string')
        return null;
      const encoded = result.stdout.replace(/[\r\n]/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        return null;
      const bytes = Buffer.from(encoded, 'base64');
      const after = await lstat(path);
      if (
        bytes.length > remaining ||
        bytes.toString('base64') !== encoded ||
        bytes.length !== before.size ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mode !== after.mode ||
        after.nlink !== 1 ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        (await realpath(path)) !== path
      )
        return null;
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (contents.includes('\0')) return null;
      results.push({
        path,
        contents,
        bytes: bytes.length,
        stamp: canonicalHash({ bytes: encoded, ino: after.ino, dev: after.dev, mode: after.mode }),
      });
      remaining -= bytes.length;
    }
    return results;
  } catch {
    return null;
  }
}

/** One no-generation native connection for instruction admission before Jev. */
export async function readCodexInstructionFiles(
  options: CodexInstructionReadOptions & {
    paths: string[];
    maxBytes: number;
    signal?: AbortSignal;
  },
): Promise<CodexInstructionFile[] | null> {
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  const profile = codexInstructionProfile(options);
  if (!profile) return null;
  const env = { ...(options.env ?? process.env) };
  for (const key of [
    'TENJIN_WALLET_PASSPHRASE',
    'DEEPSEEK_API_KEY',
    'TYPESAFE_KEY',
    'TYPESAFE_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ])
    delete env[key];
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(7_000)])
    : AbortSignal.timeout(7_000);
  return withAppServer(
    options.home ?? homedir(),
    env,
    3_000,
    (request) =>
      readCodexInstructionFilesOnServer(request, options, options.paths, options.maxBytes, signal),
    {
      cwd: options.cwd,
      signal,
      experimentalApi: true,
      expectedVersion: QUALIFIED_CODEX_MODEL_VERSIONS,
      configOverrides: [
        ...profile.overrides,
        'shell_environment_policy.inherit="none"',
        'shell_environment_policy.set={LANG="C",LC_ALL="C"}',
      ],
    },
  );
}

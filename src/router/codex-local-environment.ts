import { isAbsolute } from 'node:path';
import { canonicalHash } from '../lib/request-schema';

export interface NativeLocalEnvironment {
  cwd: string;
  shell: string | null;
  filesystem: string;
  network: string | null;
  fingerprint: string;
}

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 2048;
const MAX_DEPTH = 16;
const MAX_FIELDS = 256;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECTIONS = ['environments', 'environments_instructions'] as const;
const ENVIRONMENT_FIELDS = new Set([
  'environments',
  'filesystem',
  'network',
  'timezone',
  'current_date',
  'shell_version',
  'subagents',
]);
const LOCAL_FIELDS = new Set(['cwd', 'status', 'shell', 'error', 'is_primary']);

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Read data properties only, so even a non-JSON caller cannot invoke getters. */
function fields(value: unknown, max = MAX_FIELDS): [string, unknown][] {
  if (!record(value)) throw new Error('Expected a JSON object.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > max) throw new Error('Too many object fields.');
  return keys.map((key) => {
    if (typeof key !== 'string' || BAD_KEYS.has(key)) throw new Error('Invalid object key.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new Error('Expected a JSON data property.');
    return [key, descriptor.value];
  });
}

/** Copy only bounded JSON; never keep references to the rollout parser's values. */
function boundedCopy(value: unknown): Json {
  let bytes = 0;
  let nodes = 0;
  const charge = (size: number) => {
    bytes += size;
    if (bytes > MAX_BYTES) throw new Error('World state is too large.');
  };
  const copy = (input: unknown, depth: number): Json => {
    if (depth > MAX_DEPTH) throw new Error('World state is too deep.');
    if (++nodes > MAX_NODES) throw new Error('Too many world-state values.');
    charge(8);
    if (typeof input === 'string') {
      charge(Buffer.byteLength(input));
      return input;
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) {
      if (
        Object.getPrototypeOf(input) !== Array.prototype ||
        input.length > MAX_NODES ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        throw new Error('Expected a bounded JSON array.');
      const result: Json[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new Error('Expected a JSON array value.');
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: JsonObject = Object.create(null);
    for (const [key, entry] of fields(input, MAX_NODES)) {
      charge(Buffer.byteLength(key));
      result[key] = copy(entry, depth + 1);
    }
    return result;
  };
  return copy(value, 0);
}

/** RFC 7386: object members merge, null deletes, and every other value replaces. */
function merge(target: Json | undefined, patch: Json): Json {
  if (!record(patch)) return patch;
  const result: JsonObject = Object.assign(Object.create(null), record(target) ? target : {});
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key], value);
  }
  return result;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= max;
}

function nativePath(value: unknown): value is string {
  return boundedString(value, 8192) && !value.includes('\0') && isAbsolute(value);
}

function xml(value: string): string {
  const escaped: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };
  return value.replace(/[&<>"']/g, (character) => escaped[character]!);
}

/** Exact native descriptor for the restricted grammar supported by the reader.
 * Bind the witness to the captured original profile and applied workspace roots,
 * before adding worker credential shields. No XML parsing or policy inference.
 * Renderer: openai/codex filesystem_context.rs, blob 1b6b086b1d4ec0b79782893b03da93cdd991fef5.
 */
export function nativeLocalFilesystem(profile: unknown, roots: string[]): string | null {
  try {
    const input = boundedCopy({ profile, roots }) as JsonObject;
    const permission = input.profile;
    if (
      !record(permission) ||
      permission.type !== 'managed' ||
      permission.network !== 'restricted' ||
      Object.keys(permission).some((key) => !['type', 'file_system', 'network'].includes(key)) ||
      !record(permission.file_system) ||
      permission.file_system.type !== 'restricted' ||
      Object.keys(permission.file_system).some((key) => !['type', 'entries'].includes(key)) ||
      !Array.isArray(permission.file_system.entries) ||
      permission.file_system.entries.length > 256 ||
      !Array.isArray(input.roots) ||
      input.roots.length > 256 ||
      !input.roots.every(nativePath)
    )
      return null;
    const entries: string[] = [];
    const seen = new Set<string>();
    for (const entry of permission.file_system.entries) {
      if (
        !record(entry) ||
        Object.keys(entry).some(
          (key) => !['path', 'access', 'missing_path_behavior'].includes(key),
        ) ||
        !['read', 'write', 'deny'].includes(String(entry.access)) ||
        (entry.missing_path_behavior !== undefined &&
          (entry.missing_path_behavior !== 'skip' || entry.access === 'write')) ||
        !record(entry.path) ||
        Object.keys(entry.path).length !== 2
      )
        return null;
      let path: string;
      if (entry.path.type === 'path' && nativePath(entry.path.path))
        path = `<path>${xml(entry.path.path)}</path>`;
      else if (
        entry.path.type === 'special' &&
        record(entry.path.value) &&
        Object.keys(entry.path.value).length === 1 &&
        ['root', 'minimal', 'slash_tmp', 'tmpdir'].includes(String(entry.path.value.kind))
      )
        path = `<special>:${entry.path.value.kind}</special>`;
      else return null;
      const identity = canonicalHash(entry);
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(
        `<entry access="${entry.access}"${entry.access === 'deny' ? ' escalatable="false"' : ''}>${path}</entry>`,
      );
    }
    const workspaceRoots = input.roots.length
      ? `<workspace_roots>${input.roots.map((root) => `<root>${xml(root as string)}</root>`).join('')}</workspace_roots>`
      : '';
    const filesystem = entries.length
      ? `<file_system type="restricted">${entries.join('')}</file_system>`
      : '<file_system type="restricted" />';
    const result = `<filesystem>${workspaceRoots}<permission_profile type="managed">${filesystem}</permission_profile></filesystem>`;
    return Buffer.byteLength(result) <= 64 * 1024 ? result : null;
  } catch {
    return null;
  }
}

/** Replay only native 0.167 world_state payloads from a complete, owned rollout.
 * Ownership, version, and history completeness are the caller's responsibility.
 * Native schema: openai/codex environment.rs, blob ba661c1ee4e394068eff8d1797ba685ab46d3430.
 * The rendered filesystem/network strings are opaque witnesses, not policy parsers.
 */
export class CodexEnvironmentWitness {
  private state: JsonObject | null = null;

  /** False invalidates earlier evidence; only a subsequent full record can restore it. */
  apply(payload: unknown): boolean {
    try {
      const envelope = fields(payload, 2);
      if (
        envelope.length !== 2 ||
        !envelope.some(([key, value]) => key === 'full' && typeof value === 'boolean') ||
        !envelope.some(([key]) => key === 'state')
      )
        throw new Error('Invalid world-state payload.');
      const full = envelope.find(([key]) => key === 'full')![1];
      if (!full && this.state === null) throw new Error('Missing full baseline.');
      const selected: Record<string, unknown> = Object.create(null);
      // Other world-state sections can contain large instructions and tool catalogs.
      // Do not retain or traverse them: this witness has no authority over them.
      for (const [key, value] of fields(envelope.find(([key]) => key === 'state')![1]))
        if (SECTIONS.some((section) => section === key)) selected[key] = value;
      const next = boundedCopy(selected) as JsonObject;
      this.state = (full ? next : boundedCopy(merge(this.state, next))) as JsonObject;
      return true;
    } catch {
      this.state = null;
      return false;
    }
  }

  local(cwd: string): NativeLocalEnvironment | null {
    if (!this.state || this.state.environments_instructions !== false) return null;
    const section = this.state.environments;
    if (
      !record(section) ||
      Object.keys(section).some((key) => !ENVIRONMENT_FIELDS.has(key)) ||
      !record(section.environments) ||
      Object.keys(section.environments).length !== 1 ||
      !Object.hasOwn(section.environments, 'local')
    )
      return null;
    const local = section.environments.local;
    if (
      !record(local) ||
      Object.keys(local).some((key) => !LOCAL_FIELDS.has(key)) ||
      local.status !== 'available' ||
      local.cwd !== cwd ||
      !boundedString(local.cwd, 8192) ||
      !local.cwd ||
      (local.shell != null && !boundedString(local.shell, 8192)) ||
      (local.error != null && !boundedString(local.error, 256)) ||
      (local.is_primary !== undefined && typeof local.is_primary !== 'boolean') ||
      !boundedString(section.filesystem, 64 * 1024) ||
      !section.filesystem.trim() ||
      (section.network != null && !boundedString(section.network, 64 * 1024)) ||
      ['timezone', 'current_date', 'shell_version', 'subagents'].some(
        (key) => section[key] != null && !boundedString(section[key], MAX_BYTES),
      )
    )
      return null;
    const environment = {
      cwd,
      shell: (local.shell as string | null | undefined) ?? null,
      filesystem: section.filesystem,
      network: (section.network as string | null | undefined) ?? null,
    };
    return { ...environment, fingerprint: canonicalHash(environment) };
  }
}

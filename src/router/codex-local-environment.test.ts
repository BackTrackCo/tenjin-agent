import { describe, expect, it } from 'vitest';
import { CodexEnvironmentWitness, nativeLocalFilesystem } from './codex-local-environment';

const CWD = '/workspace/project';
const FILESYSTEM = '<filesystem><permission_profile type="managed" /></filesystem>';
const local = () => ({ cwd: CWD, status: 'available', shell: 'zsh' });
const state = () => ({
  environments: { environments: { local: local() }, filesystem: FILESYSTEM },
  environments_instructions: false,
});
const full = (value: unknown = state()) => ({ full: true, state: value });
const patch = (value: unknown) => ({ full: false, state: value });
function witness(): CodexEnvironmentWitness {
  const result = new CodexEnvironmentWitness();
  expect(result.apply(full())).toBe(true);
  return result;
}

describe('CodexEnvironmentWitness', () => {
  it('requires a full baseline and explicit false environment guidance', () => {
    const result = new CodexEnvironmentWitness();
    expect(result.local(CWD)).toBeNull();
    expect(result.apply(patch(state()))).toBe(false);
    expect(result.apply(full({ environments: state().environments }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
    expect(result.apply(patch({ environments_instructions: true }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
    expect(result.apply(patch({ environments_instructions: false }))).toBe(true);
    expect(result.local(CWD)).toMatchObject({ cwd: CWD, shell: 'zsh', filesystem: FILESYSTEM });
    expect(result.local(`${CWD}/other`)).toBeNull();
  });

  it('deep-merges additions and deletions without dropping retained local fields', () => {
    const result = witness();
    expect(result.apply(patch({ environments: { network: '<network enabled="true" />' } }))).toBe(
      true,
    );
    expect(result.local(CWD)?.network).toBe('<network enabled="true" />');
    expect(
      result.apply(patch({ environments: { environments: { local: { shell: null } } } })),
    ).toBe(true);
    expect(result.local(CWD)).toMatchObject({ cwd: CWD, shell: null, filesystem: FILESYSTEM });
    expect(result.apply(patch({ environments: { network: null } }))).toBe(true);
    expect(result.local(CWD)?.network).toBeNull();
    expect(result.apply(patch({ environments_instructions: null }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
  });

  it.each(['available', 'starting', 'failed'])(
    'rejects an extra %s selected environment',
    (status) => {
      const result = witness();
      expect(
        result.apply(
          patch({
            environments: { environments: { remote: { cwd: '/remote', status, shell: null } } },
          }),
        ),
      ).toBe(true);
      expect(result.local(CWD)).toBeNull();
      expect(result.apply(patch({ environments: { environments: { remote: null } } }))).toBe(true);
      expect(result.local(CWD)).not.toBeNull();
    },
  );

  it('resets retained sections on full records and replaces arrays and scalars in patches', () => {
    const result = witness();
    expect(result.apply(full({ environments_instructions: false }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
    expect(result.apply(patch({ environments: state().environments }))).toBe(true);
    expect(result.local(CWD)).not.toBeNull();
    expect(result.apply(patch({ environments: { environments: [] } }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
    expect(result.apply(patch({ environments: { environments: { local: local() } } }))).toBe(true);
    expect(result.local(CWD)).not.toBeNull();
    expect(result.apply(patch({ environments: 1 }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
    expect(result.apply(patch({ environments: { environments: { local: local() } } }))).toBe(true);
    expect(result.local(CWD)).toBeNull(); // Scalar replacement discarded the filesystem too.
    expect(result.apply(patch({ environments: { filesystem: FILESYSTEM } }))).toBe(true);
    expect(result.local(CWD)).not.toBeNull();
  });

  it.each([
    { status: 'starting' },
    { status: 'failed', error: 'Connection failed.' },
    { status: 'unknown' },
    { cwd: '/elsewhere' },
    { cwd: '' },
    { shell: 1 },
    { is_primary: 'true' },
    { unexpected: true },
  ])('keeps unsupported local environment state native', (update) => {
    const result = witness();
    expect(result.apply(patch({ environments: { environments: { local: update } } }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
  });

  it.each([
    { filesystem: '' },
    { filesystem: '   ' },
    { filesystem: null },
    { filesystem: 'x'.repeat(64 * 1024 + 1) },
    { network: false },
    { subagents: {} },
    { unexpected: true },
  ])('keeps malformed or unknown environment section fields native', (update) => {
    const result = witness();
    expect(result.apply(patch({ environments: update }))).toBe(true);
    expect(result.local(CWD)).toBeNull();
  });

  it('normalizes native omitted optional values and ignores unrelated semantic updates', () => {
    const result = witness();
    expect(
      result.apply(patch({ environments: { environments: { local: { shell: null } } } })),
    ).toBe(true);
    const before = result.local(CWD);
    expect(before).toMatchObject({ shell: null, network: null });
    expect(
      result.apply(
        patch({
          environments: {
            subagents: '<agent>New worker</agent>',
            current_date: '2026-11-13',
            timezone: 'America/Toronto',
            shell_version: '7.5',
          },
          model_instructions: { any: ['unrelated', 'content'] },
        }),
      ),
    ).toBe(true);
    expect(result.local(CWD)).toEqual(before);
  });

  it('changes the fingerprint for each admission field', () => {
    const result = witness();
    let before = result.local(CWD)!.fingerprint;
    for (const update of [
      { filesystem: `${FILESYSTEM}changed` },
      { network: '<network enabled="true" />' },
      { environments: { local: { shell: 'bash' } } },
    ]) {
      expect(result.apply(patch({ environments: update }))).toBe(true);
      const after = result.local(CWD)!.fingerprint;
      expect(after).not.toBe(before);
      before = after;
    }
    const nextCwd = `${CWD}/next`;
    expect(
      result.apply(patch({ environments: { environments: { local: { cwd: nextCwd } } } })),
    ).toBe(true);
    expect(result.local(CWD)).toBeNull();
    expect(result.local(nextCwd)!.fingerprint).not.toBe(before);
  });

  it('copies retained values and does not traverse or retain unrelated sections', () => {
    const result = new CodexEnvironmentWitness();
    const input = state();
    const unrelated = Object.create(null);
    unrelated.self = unrelated;
    expect(result.apply(full({ ...input, tools: unrelated }))).toBe(true);
    input.environments.environments.local.cwd = '/mutated';
    expect(result.local(CWD)).not.toBeNull();
    expect(result.apply(patch({ tools: 'x'.repeat(300_000) }))).toBe(true);
    expect(result.local(CWD)).not.toBeNull();
  });

  it('invalidates stale evidence on invalid, oversized, over-deep or non-JSON payloads', () => {
    let deep: unknown = true;
    for (let index = 0; index < 18; index++) deep = { nested: deep };
    const accessor = {};
    let invoked = false;
    Object.defineProperty(accessor, 'filesystem', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('Getter must not run.');
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const payload of [
      null,
      { full: 'true', state: state() },
      { full: false, state: null },
      { ...full(), extra: true },
      patch({ environments: { subagents: 'x'.repeat(300_000) } }),
      patch({ environments: deep }),
      patch({ environments: Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [i, i])) }),
      patch({ environments: { filesystem: undefined } }),
      patch({ environments: accessor }),
      patch({ environments: cyclic }),
    ]) {
      const result = witness();
      expect(result.apply(payload)).toBe(false);
      expect(result.local(CWD)).toBeNull();
      expect(result.apply(patch(state()))).toBe(false);
      expect(result.apply(full())).toBe(true);
      expect(result.local(CWD)).not.toBeNull();
    }
    expect(invoked).toBe(false);
  });

  it('bounds accumulated patches, not only each individual payload', () => {
    const result = witness();
    expect(result.apply(patch({ environments: { subagents: 'x'.repeat(140_000) } }))).toBe(true);
    expect(result.apply(patch({ environments: { timezone: 'y'.repeat(140_000) } }))).toBe(false);
    expect(result.local(CWD)).toBeNull();
  });

  it('rejects prototype mutation keys without changing any prototype', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const result = witness();
      const hostile = JSON.parse(`{"${key}":{"polluted":true}}`);
      expect(result.apply(patch({ environments: hostile }))).toBe(false);
      expect(result.local(CWD)).toBeNull();
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

function profile(entries: unknown[] = []) {
  return {
    type: 'managed',
    network: 'restricted',
    file_system: { type: 'restricted', entries },
  };
}
const pathEntry = (path = CWD, access = 'read') => ({
  path: { type: 'path', path },
  access,
});
const specialEntry = (kind: string, access = 'read') => ({
  path: { type: 'special', value: { kind } },
  access,
});

describe('nativeLocalFilesystem', () => {
  it('matches the native empty restricted descriptor and omits empty workspace roots', () => {
    expect(nativeLocalFilesystem(profile(), [])).toBe(
      '<filesystem><permission_profile type="managed"><file_system type="restricted" /></permission_profile></filesystem>',
    );
  });

  it('matches native order, exact-entry deduplication, deny metadata and XML escaping', () => {
    expect(
      nativeLocalFilesystem(
        profile([
          pathEntry('/workspace/a&<>"\'', 'write'),
          specialEntry('root'),
          specialEntry('root'),
          pathEntry('/workspace/secret', 'deny'),
          specialEntry('minimal'),
          specialEntry('slash_tmp', 'write'),
          specialEntry('tmpdir', 'write'),
          pathEntry('/workspace/secret', 'read'),
        ]),
        ['/workspace/one', '/workspace/a&<>"\''],
      ),
    ).toBe(
      '<filesystem><workspace_roots><root>/workspace/one</root><root>/workspace/a&amp;&lt;&gt;&quot;&apos;</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="write"><path>/workspace/a&amp;&lt;&gt;&quot;&apos;</path></entry><entry access="read"><special>:root</special></entry><entry access="deny" escalatable="false"><path>/workspace/secret</path></entry><entry access="read"><special>:minimal</special></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>/workspace/secret</path></entry></file_system></permission_profile></filesystem>',
    );
  });

  it('preserves skip as entry identity while rendering it without an extra attribute', () => {
    expect(
      nativeLocalFilesystem(
        profile([
          pathEntry(),
          { ...pathEntry(), missing_path_behavior: 'skip' },
          { ...pathEntry(), missing_path_behavior: 'skip' },
        ]),
        [],
      ),
    ).toBe(
      '<filesystem><permission_profile type="managed"><file_system type="restricted"><entry access="read"><path>/workspace/project</path></entry><entry access="read"><path>/workspace/project</path></entry></file_system></permission_profile></filesystem>',
    );
    expect(
      nativeLocalFilesystem(
        profile([{ ...pathEntry(CWD, 'deny'), missing_path_behavior: 'skip' }]),
        [],
      ),
    ).toContain('access="deny" escalatable="false"');
  });

  it.each([
    { type: 'disabled' },
    { ...profile(), type: 'external' },
    { ...profile(), network: 'enabled' },
    { ...profile(), unexpected: false },
    { ...profile(), file_system: { type: 'unrestricted' } },
    { ...profile(), file_system: { type: 'restricted', entries: [], glob_scan_max_depth: 6 } },
    profile([{ ...pathEntry(), unexpected: true }]),
    profile([pathEntry(CWD, 'none')]),
    profile([pathEntry('relative')]),
    profile([pathEntry('/workspace/with\0nul')]),
    profile([{ ...pathEntry(CWD, 'write'), missing_path_behavior: 'skip' }]),
    profile([{ ...pathEntry(), missing_path_behavior: 'create' }]),
    profile([{ ...pathEntry(), missing_path_behavior: null }]),
    profile([{ path: { type: 'glob_pattern', pattern: '**/.env*' }, access: 'deny' }]),
    profile([specialEntry('project_roots')]),
    profile([
      { path: { type: 'special', value: { kind: 'root', subpath: 'extra' } }, access: 'read' },
    ]),
  ])('returns no descriptor for unsupported permission grammar: %j', (permission) => {
    expect(nativeLocalFilesystem(permission, [])).toBeNull();
  });

  it('bounds roots, entry count, individual paths and final escaped XML', () => {
    expect(nativeLocalFilesystem(profile(), ['relative'])).toBeNull();
    expect(nativeLocalFilesystem(profile(), ['/bad\0root'])).toBeNull();
    expect(
      nativeLocalFilesystem(
        profile(),
        Array.from({ length: 257 }, () => CWD),
      ),
    ).toBeNull();
    expect(
      nativeLocalFilesystem(profile(Array.from({ length: 257 }, () => pathEntry())), []),
    ).toBeNull();
    expect(nativeLocalFilesystem(profile([pathEntry(`/${'a'.repeat(8192)}`)]), [])).toBeNull();
    expect(
      nativeLocalFilesystem(
        profile(Array.from({ length: 20 }, (_, i) => pathEntry(`/${i}${'&'.repeat(1000)}`))),
        [],
      ),
    ).toBeNull();
  });

  it('rejects unsafe object keys and non-JSON values without executing them', () => {
    const hostile = JSON.parse(
      '{"type":"managed","network":"restricted","file_system":{"type":"restricted","entries":[]},"__proto__":{"polluted":true}}',
    );
    expect(nativeLocalFilesystem(hostile, [])).toBeNull();
    const accessor = profile();
    let invoked = false;
    Object.defineProperty(accessor, 'network', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('Getter must not run.');
      },
    });
    expect(nativeLocalFilesystem(accessor, [])).toBeNull();
    expect(invoked).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

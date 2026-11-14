import { describe, expect, it } from 'vitest';
import { CodexToolWitness } from './codex-tool-witness';

const full = (state: unknown) => ({ full: true, state });
const patch = (state: unknown) => ({ full: false, state });
function witness(): CodexToolWitness {
  const result = new CodexToolWitness();
  expect(result.apply(full({ tools: { mcp__codex_apps__github: 'A deferred namespace.' } }))).toBe(
    true,
  );
  return result;
}

describe('CodexToolWitness', () => {
  it('requires a full baseline, including before an empty or unrelated patch', () => {
    for (const state of [
      {},
      { tools: {} },
      { tools: null },
      { tools: { mcp__router: 'Router.' } },
    ]) {
      const result = new CodexToolWitness();
      expect(result.namespaces()).toBeNull();
      expect(result.apply(patch(state))).toBe(false);
      expect(result.namespaces()).toBeNull();
    }
  });

  it('treats a missing tools section in a full snapshot as known empty', () => {
    const result = witness();
    expect(result.apply(full({ model: { unrelated: 'Snapshot.' } }))).toBe(true);
    expect(result.namespaces()).toEqual([]);
    expect(result.apply(patch({ tools: { mcp__router: 'Router.' } }))).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__router']);
    expect(result.apply(full({ tools: {} }))).toBe(true);
    expect(result.namespaces()).toEqual([]);
  });

  it('captures the direct native namespace map, including names absent from tool calls', () => {
    const result = new CodexToolWitness();
    expect(
      result.apply(
        full({
          tools: {
            mcp__router: 'A deferred router namespace.',
            mcp__codex_apps__codex_document_control: 'A deferred document namespace.',
            mcp__agentcash: 'A deferred paid API namespace.',
            functions: 'Another advertised namespace.',
          },
        }),
      ),
    ).toBe(true);
    expect(result.namespaces()).toEqual([
      'functions',
      'mcp__agentcash',
      'mcp__codex_apps__codex_document_control',
      'mcp__router',
    ]);
  });

  it('adds, replaces and deletes individual namespaces using native merge patches', () => {
    const result = witness();
    expect(
      result.apply(
        patch({
          tools: { mcp__router: 'Router.', mcp__codex_apps__github: 'Updated description.' },
        }),
      ),
    ).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__codex_apps__github', 'mcp__router']);
    expect(
      result.apply(patch({ tools: { mcp__codex_apps__github: null, mcp__absent: null } })),
    ).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__router']);
    expect(result.apply(patch({ tools: {} }))).toBe(true);
    expect(result.apply(patch({ current_date: '2026-11-14' }))).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__router']);
    expect(result.apply(patch({ tools: null }))).toBe(true);
    expect(result.namespaces()).toEqual([]);
    expect(result.apply(patch({ tools: { mcp__agentcash: '' } }))).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__agentcash']);
  });

  it('resets old names on full snapshots and never extracts names from descriptions', () => {
    const result = witness();
    expect(
      result.apply(
        full({
          tools: { mcp__router: 'mcp__not_advertised and web.run are mentioned only in prose.' },
        }),
      ),
    ).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__router']);
    expect(JSON.stringify(result.namespaces())).not.toContain('prose');
  });

  it('ignores unrelated sections without traversing them and returns a fresh names array', () => {
    const result = witness();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      result.apply(patch({ model_instructions: cyclic, tool_calls: 'x'.repeat(300_000) })),
    ).toBe(true);
    const names = result.namespaces()!;
    names.push('mcp__mutated');
    expect(result.namespaces()).toEqual(['mcp__codex_apps__github']);
  });

  it.each([
    '',
    'mcp__with space',
    'mcp__with/slash',
    'mcp__with:colon',
    '1starts_with_digit',
    'mcp__emoji_😀',
    'x'.repeat(257),
  ])('invalidates evidence for an unsupported namespace identifier', (name) => {
    const result = witness();
    expect(result.apply(patch({ tools: { [name]: 'Description.' } }))).toBe(false);
    expect(result.namespaces()).toBeNull();
  });

  it('accepts bounded identifier punctuation without interpreting names as calls', () => {
    const result = new CodexToolWitness();
    expect(result.apply(full({ tools: { 'mcp__server-name.v2': '', _internal: '' } }))).toBe(true);
    expect(result.namespaces()).toEqual(['_internal', 'mcp__server-name.v2']);
  });

  it('rejects malformed payloads and namespace values until a new valid full baseline', () => {
    let deep: unknown = 'Description.';
    for (let index = 0; index < 32; index++) deep = { child: deep };
    for (const payload of [
      null,
      [],
      { full: 'true', state: {} },
      { full: true, state: null },
      { full: true, state: {}, extra: true },
      full({ tools: null }),
      full({ tools: { mcp__router: null } }),
      patch({ tools: [] }),
      patch({ tools: 'mcp__router' }),
      patch({ tools: { mcp__router: false } }),
      patch({ tools: { mcp__router: 1 } }),
      patch({ tools: { mcp__router: undefined } }),
      patch({ tools: { mcp__router: [] } }),
      patch({ tools: { mcp__router: deep } }),
      full({ tools: { deferred_namespaces: { mcp__router: 'Wrong wrapper.' } } }),
    ]) {
      const result = witness();
      expect(result.apply(payload)).toBe(false);
      expect(result.namespaces()).toBeNull();
      expect(result.apply(patch({ tools: { mcp__router: 'Still lacks baseline.' } }))).toBe(false);
      expect(result.namespaces()).toBeNull();
      expect(result.apply(full({ tools: { mcp__router: 'New baseline.' } }))).toBe(true);
      expect(result.namespaces()).toEqual(['mcp__router']);
    }
  });

  it('bounds UTF-8 bytes, namespace counts and accumulated snapshot size', () => {
    for (const tools of [
      { mcp__oversized: '😀'.repeat(66_000) },
      Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [`namespace_${index}`, ''])),
    ]) {
      const result = witness();
      expect(result.apply(patch({ tools }))).toBe(false);
      expect(result.namespaces()).toBeNull();
    }
    const result = witness();
    expect(result.apply(patch({ tools: { mcp__one: 'a'.repeat(140_000) } }))).toBe(true);
    expect(result.apply(patch({ tools: { mcp__two: 'b'.repeat(140_000) } }))).toBe(false);
    expect(result.namespaces()).toBeNull();
  });

  it('updates byte accounting on replacement and deletion without retaining descriptions', () => {
    const result = witness();
    expect(result.apply(patch({ tools: { mcp__one: 'a'.repeat(140_000) } }))).toBe(true);
    expect(result.apply(patch({ tools: { mcp__one: '' } }))).toBe(true);
    expect(result.apply(patch({ tools: { mcp__two: 'b'.repeat(140_000) } }))).toBe(true);
    expect(result.apply(patch({ tools: { mcp__two: null } }))).toBe(true);
    expect(result.apply(patch({ tools: { mcp__three: 'c'.repeat(140_000) } }))).toBe(true);
    expect(result.namespaces()).toEqual(['mcp__codex_apps__github', 'mcp__one', 'mcp__three']);
  });

  it('bounds accumulated namespace count across individually valid patches', () => {
    const result = new CodexToolWitness();
    expect(
      result.apply(
        full({
          tools: Object.fromEntries(
            Array.from({ length: 1500 }, (_, index) => [`namespace_${index}`, '']),
          ),
        }),
      ),
    ).toBe(true);
    expect(
      result.apply(
        patch({
          tools: Object.fromEntries(
            Array.from({ length: 600 }, (_, index) => [`extra_${index}`, '']),
          ),
        }),
      ),
    ).toBe(false);
    expect(result.namespaces()).toBeNull();
  });

  it('rejects prototype keys and accessors without mutating prototypes or executing getters', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const result = witness();
      expect(result.apply(patch({ tools: JSON.parse(`{"${key}":"Description."}`) }))).toBe(false);
      expect(result.namespaces()).toBeNull();
    }
    let invoked = false;
    const tools = Object.create(null);
    Object.defineProperty(tools, 'mcp__router', {
      enumerable: true,
      get() {
        invoked = true;
        return 'Description.';
      },
    });
    const result = witness();
    expect(result.apply(patch({ tools }))).toBe(false);
    expect(invoked).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 2048;
const MAX_SECTIONS = 256;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Read plain JSON data properties without invoking accessors or toJSON. */
function fields(value: unknown, max: number): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error('Expected a plain JSON object.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > max) throw new Error('Too many JSON fields.');
  return keys.map((key) => {
    if (typeof key !== 'string' || BAD_KEYS.has(key)) throw new Error('Invalid JSON key.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new Error('Expected a JSON data property.');
    return [key, descriptor.value];
  });
}

/** Native 0.167 deferred-namespace witness from a complete, owned rollout.
 * The caller proves ownership, version, completeness and the sampling boundary.
 * Pinned tools.rs snapshot is a direct namespace -> description string map:
 * openai/codex blob 6353bd2e354b9fc4ce5c4efd7bda409019f8571f.
 * Empty maps are not persisted. Native world-state records use RFC 7386 patches.
 * Descriptions are never copied or retained; their lengths bound cumulative state.
 */
export class CodexToolWitness {
  private state: Map<string, number> | null = null;

  /** False invalidates earlier evidence until a new valid full baseline. */
  apply(payload: unknown): boolean {
    try {
      const envelope = fields(payload, 2);
      const full = envelope.find(([key]) => key === 'full')?.[1];
      const state = envelope.find(([key]) => key === 'state');
      if (envelope.length !== 2 || typeof full !== 'boolean' || !state)
        throw new Error('Invalid world-state payload.');
      if (!full && this.state === null) throw new Error('Missing full baseline.');
      const tools = fields(state[1], MAX_SECTIONS).find(([key]) => key === 'tools');
      const next = full ? new Map<string, number>() : new Map(this.state!);
      if (tools) {
        if (!full && tools[1] === null) next.clear();
        else {
          // The native schema has only three object levels. Namespace values
          // must be strings (or deletion nulls in patches), never nested data.
          const namespaces = fields(tools[1], MAX_NODES);
          if (namespaces.length + 1 > MAX_NODES) throw new Error('Too many namespace values.');
          let bytes = 8;
          for (const [name, description] of namespaces) {
            if (!IDENTIFIER.test(name)) throw new Error('Invalid namespace identifier.');
            bytes += Buffer.byteLength(name) + 8;
            if (!full && description === null) next.delete(name);
            else {
              if (typeof description !== 'string') throw new Error('Invalid namespace value.');
              const size = Buffer.byteLength(description);
              bytes += size;
              next.set(name, size);
            }
            if (bytes > MAX_BYTES) throw new Error('Namespace patch is too large.');
          }
        }
      }
      let bytes = 8;
      if (next.size + 1 > MAX_NODES) throw new Error('Too many retained namespaces.');
      for (const [name, size] of next) {
        bytes += Buffer.byteLength(name) + size + 8;
        if (bytes > MAX_BYTES) throw new Error('Namespace state is too large.');
      }
      this.state = next;
      return true;
    } catch {
      this.state = null;
      return false;
    }
  }

  /** All advertised names, including deferred-only MCP namespaces, sorted. */
  namespaces(): string[] | null {
    return this.state === null ? null : [...this.state.keys()].sort();
  }
}

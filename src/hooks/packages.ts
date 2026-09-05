/**
 * Which third-party packages a source file imports, as two pure functions
 * ported from the generated context arm (`push-scripts.ts:1029-1058`) with the
 * lists and the regexes unchanged.
 *
 * WHY THE BUILTIN LISTS ARE HERE AND NOT A DEPENDENCY: the question this feeds
 * is "has anyone written down a gotcha about this package", and `node:fs` and
 * `os` have no gotcha a shelf could hold. A stdlib name that slipped through
 * would spend a lookup on both shelves in front of every Read of a file that
 * imports it. The lists are deliberately short — the common ones, matched
 * against 14 days of real reads — and a name missing from them costs one wasted
 * question once per agent, never a wrong answer.
 */

const NODE_BUILTINS = new Set(
  (
    'fs path os url http https crypto child_process util events stream buffer assert net tls ' +
    'zlib readline process module worker_threads'
  ).split(' '),
);

const PY_STDLIB = new Set(
  (
    'os sys re json time typing pathlib subprocess collections itertools functools datetime ' +
    'logging math random unittest io abc dataclasses enum asyncio threading shutil tempfile ' +
    'argparse copy string textwrap'
  ).split(' '),
);

/** npm's own bound on a package name. */
const NAME_MAX = 214;

const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/**
 * The bare package name of an import specifier, or null for a relative, builtin
 * or malformed one. `@scope/name/sub` -> `@scope/name`.
 */
export function packageOf(spec: string): string | null {
  if (spec.length === 0 || spec.length > NAME_MAX) return null;
  if (
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('node:') ||
    spec.startsWith('#')
  ) {
    return null;
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  if (!NAME_RE.test(name)) return null;
  if (NODE_BUILTINS.has(name)) return null;
  return name.toLowerCase();
}

/**
 * The packages a source file's head imports, in first-seen order. JS/TS and
 * Python only, and never a parse: three regexes over the first 20 000 bytes,
 * because this runs in front of a tool call and a wrong answer here costs one
 * unasked question, not a broken build.
 */
export function packagesInSource(text: string): string[] {
  const found = new Set<string>();
  const head = text.slice(0, 20_000);
  for (const m of head.matchAll(/(?:from|import)\s+['"]([^'"\n]+)['"]/g)) {
    const p = packageOf(m[1] ?? '');
    if (p !== null) found.add(p);
  }
  for (const m of head.matchAll(/require\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
    const p = packageOf(m[1] ?? '');
    if (p !== null) found.add(p);
  }
  for (const m of head.matchAll(/^(?:from\s+([A-Za-z_]\w*)|import\s+([A-Za-z_]\w*))/gm)) {
    const name = (m[1] ?? m[2] ?? '').toLowerCase();
    if (name.length >= 2 && !PY_STDLIB.has(name) && !name.startsWith('_')) found.add(name);
  }
  return [...found];
}

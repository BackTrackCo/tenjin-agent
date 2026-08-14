import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative } from 'node:path';
import { PRODUCTION_HOST, PRODUCTION_ORIGIN } from './production-origin';
import { CONFIG_DEFAULTS } from './config';
import { TENJIN_USER_AGENT } from './client-meta';
import { websearchHookScript } from './hook-scripts';
import { SEARCH_HOOKS_CHOICES } from '../commands/install';

/**
 * The guard that makes the origin cutover (tenjin#402) a one-line edit: every
 * module that ships the production origin has to READ it from here, and nothing
 * else under src/ may spell the host out. Without this a flip lands in the
 * obvious places and leaves a stale default, a stale User-Agent, or a stale
 * generated hook script behind — a half-flip that no single test would catch,
 * because each of those modules is only ever compared against itself.
 */
describe('PRODUCTION_ORIGIN', () => {
  it('is a bare https origin, and the host is derived from it', () => {
    const url = new URL(PRODUCTION_ORIGIN);
    expect(url.protocol).toBe('https:');
    // A path, trailing slash, query, or port would survive every consumer here
    // and then break the ones that concatenate (`${origin}/api/cdp/session`).
    expect(PRODUCTION_ORIGIN).toBe(url.origin);
    expect(PRODUCTION_HOST).toBe(url.host);
  });

  it('is the shipped config default for baseUrl', () => {
    expect(CONFIG_DEFAULTS.baseUrl).toBe(PRODUCTION_ORIGIN);
  });

  it('is the origin in the User-Agent comment', () => {
    expect(TENJIN_USER_AGENT.endsWith(` (+${PRODUCTION_ORIGIN})`)).toBe(true);
  });

  it('is the baseUrl fallback baked into the generated WebSearch hook', () => {
    // The generated script is standalone JS with no import of this module, so
    // the origin is inlined at generation time; assert the emitted text.
    expect(websearchHookScript('/tmp/tenjin-data')).toContain(`: '${PRODUCTION_ORIGIN}';`);
  });

  it('is the host named in the install hook copy', () => {
    const auto = SEARCH_HOOKS_CHOICES.find((c) => c.value === 'auto');
    expect(auto?.hint).toContain(PRODUCTION_HOST);
  });
});

const srcDir = fileURLToPath(new URL('..', import.meta.url));
/**
 * Exempt because neither ships the origin: this module IS the constant, and
 * read-test-utils is test scaffolding whose sample URLs happen to use the host.
 */
const EXEMPT = new Set(['lib/production-origin.ts', 'lib/read-test-utils.ts']);
/** Both spellings, so a partially-applied cutover fails as loudly as a stale one. */
const HOST_LITERAL = /tenjin\.(?:blog|sh)/;
const COMMENT_LINE = /^(?:\/\/|\/\*|\*)/;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('no module hardcodes the production host', () => {
  it('names it only in comments, outside src/lib/production-origin.ts', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcDir)) {
      const rel = relative(srcDir, file);
      if (EXEMPT.has(rel)) continue;
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!HOST_LITERAL.test(line)) return;
        // Prose about the site is fine; a literal the CLI can emit is not.
        if (COMMENT_LINE.test(line.trim())) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'import PRODUCTION_ORIGIN / PRODUCTION_HOST instead').toEqual([]);
  });
});

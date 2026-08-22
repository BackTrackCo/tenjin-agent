import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative } from 'node:path';
import pkg from '../../package.json';
import {
  PRODUCTION_HOST,
  PRODUCTION_ORIGIN,
  isSameDeployment,
  knownDeploymentOrigins,
} from './production-origin';
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

  it('is the origin of the homepage npm shows on the package page', () => {
    // JSON, so it cannot import the constant; pin it here instead. A stale
    // homepage is the one copy of the origin a published release advertises to
    // people who never run the CLI.
    expect(new URL(pkg.homepage).origin).toBe(PRODUCTION_ORIGIN);
  });
});

/**
 * The alias set exists so an installed CLI survives the cutover, and it is also
 * the widest place a signed credential may now be sent. Both halves get pinned:
 * a sibling origin is the same deployment, and everything else still is not.
 */
describe('isSameDeployment', () => {
  const others = knownDeploymentOrigins().filter((o) => o !== PRODUCTION_ORIGIN);

  /**
   * Exact, not `toContain`. This set ships baked into every released CLI and
   * into every hook script written at install time, so it is live on machines
   * the operator no longer controls until each one updates, and whoever holds a
   * member origin receives wallet-signed credentials from a CLI configured on
   * the sibling. Adding a member, or failing to remove one that was sold or
   * repointed, has to be a line a human wrote on purpose in a reviewed diff.
   * The expected value is written out here rather than read from the module, for
   * the same reason. Removal runbook: docs/safety-model.md.
   */
  it('is exactly the two deployment origins, and nothing has crept in', () => {
    expect(knownDeploymentOrigins()).toEqual([PRODUCTION_ORIGIN, 'https://tenjin.sh']);
  });

  it('lists the production origin and at least one alias for the cutover', () => {
    expect(knownDeploymentOrigins()).toContain(PRODUCTION_ORIGIN);
    // Without a second member the set is a no-op and tenjin#738 stays broken.
    expect(others.length).toBeGreaterThan(0);
    for (const origin of knownDeploymentOrigins()) {
      expect(origin).toBe(new URL(origin).origin);
      expect(new URL(origin).protocol).toBe('https:');
    }
  });

  it('aliases the deployment origins to each other, in both directions', () => {
    for (const other of others) {
      expect(isSameDeployment(PRODUCTION_ORIGIN, other)).toBe(true);
      expect(isSameDeployment(other, PRODUCTION_ORIGIN)).toBe(true);
    }
  });

  it('gives an origin outside the set no aliasing in either position', () => {
    for (const other of others) {
      expect(isSameDeployment('https://evil.example', other)).toBe(false);
      expect(isSameDeployment(other, 'https://evil.example')).toBe(false);
    }
    // A self-hosted deployment is aliased to nothing but itself.
    expect(isSameDeployment('https://notes.internal', PRODUCTION_ORIGIN)).toBe(false);
    expect(isSameDeployment('https://notes.internal', 'https://notes.internal')).toBe(true);
  });

  it('does not alias across scheme or port, which are part of the origin', () => {
    const downgraded = PRODUCTION_ORIGIN.replace('https://', 'http://');
    const ported = `${PRODUCTION_ORIGIN}:8443`;
    for (const other of others) {
      expect(isSameDeployment(downgraded, other)).toBe(false);
      expect(isSameDeployment(ported, other)).toBe(false);
    }
  });

  it('is inlined into the generated hook script, which cannot import it', () => {
    const script = websearchHookScript('/tmp/tenjin-data');
    expect(script).toContain(`const KNOWN_ORIGINS = ${JSON.stringify(knownDeploymentOrigins())};`);
  });
});

const srcDir = fileURLToPath(new URL('..', import.meta.url));
/**
 * Exempt because neither ships the origin: this module IS the constant, and
 * read-test-utils is test scaffolding whose sample URLs happen to use the host.
 */
const EXEMPT = new Set(['lib/production-origin.ts', 'lib/read-test-utils.ts']);
/**
 * Both spellings and either casing, so a partially-applied cutover fails as
 * loudly as a stale one and `Tenjin.Blog` does not walk past.
 */
const HOST_LITERAL = /tenjin\.(?:blog|sh)/i;
/**
 * The obvious dodge: `'tenjin' + '.blog'`, `'tenjin.' + 'blog'`, or the same
 * split across a template. Matching per line keeps this cheap, which is also its
 * ceiling (see the ADVISORY note above): a determined split survives it.
 */
const SPLIT_HOST = /tenjin\.?['"`]\s*\+|\+\s*['"`]\.?(?:blog|sh)\b/i;
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

/**
 * ADVISORY, not a security boundary. This is a sweep over raw lines, so it
 * catches the honest mistake (a forgotten literal, a stale copy) and nothing
 * more: anyone writing the host deliberately can build it at runtime out of
 * pieces no regex here will recognize. Treat a green run as "the sweep found
 * nothing", never as "the host appears nowhere".
 */
describe('no module hardcodes the production host', () => {
  it('names it only in comments, outside src/lib/production-origin.ts', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcDir)) {
      const rel = relative(srcDir, file);
      if (EXEMPT.has(rel)) continue;
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!HOST_LITERAL.test(line) && !SPLIT_HOST.test(line)) return;
        // Prose about the site is fine; a literal the CLI can emit is not.
        if (COMMENT_LINE.test(line.trim())) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'import PRODUCTION_ORIGIN / PRODUCTION_HOST instead').toEqual([]);
  });
});

const scriptsDir = fileURLToPath(new URL('../../scripts/', import.meta.url));

/**
 * The skill-mirror automation runs outside the bundle: `sync-skill.mjs` is
 * dependency-free Node (drift CI runs it with no install) and
 * `open-skill-resync-pr.sh` is bash, so neither can import the constant. Pin
 * them from here instead, in the suite that runs on every PR.
 *
 * A grep step in `skill-drift.yml` would not do this job: that workflow is
 * path-filtered to `skills/` and these two scripts, so the cutover commit (which
 * touches neither) never runs it, and the daily resync would go on fetching the
 * dead origin with every check green while `skill-writer.ts` tells users to
 * re-fetch from the new one. This test reds on the commit that causes the drift.
 */
describe('the skill-mirror scripts track the same origin', () => {
  it('fetches the canonical skill from PRODUCTION_ORIGIN', async () => {
    const mjs = await readFile(join(scriptsDir, 'sync-skill.mjs'), 'utf8');
    const sh = await readFile(join(scriptsDir, 'open-skill-resync-pr.sh'), 'utf8');
    expect(mjs).toContain(`const SOURCE_URL = '${PRODUCTION_ORIGIN}/skills.md';`);
    expect(sh).toContain(`SOURCE_URL=${PRODUCTION_ORIGIN}/skills.md`);
  });

  it('names no other host, in code or in the copy they emit', async () => {
    const offenders: string[] = [];
    for (const name of await readdir(scriptsDir)) {
      const lines = (await readFile(join(scriptsDir, name), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        const found = line.match(new RegExp(HOST_LITERAL.source, 'gi')) ?? [];
        // Banners, commit messages, and PR bodies name the source too; a stale
        // one there points a human at the dead site, so hold them to it as well.
        if (found.every((hit) => hit.toLowerCase() === PRODUCTION_HOST)) return;
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `every host in scripts/ must be ${PRODUCTION_HOST}`).toEqual([]);
  });
});

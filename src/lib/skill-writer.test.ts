import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill } from './skill-writer';
import {
  SKILL_CONTENT_FLAG_NAMES,
  markerFlagsIn,
  materializeTransform,
  renderSkillMarkdown,
} from './skill-materialize';
import { SHIPPED_SKILL_FILES, SKILL_NAMES, resolveSkillsSource } from './skills-source';
import { HOSTED_SKILL_NAME } from './skill-wiring';

/**
 * The materialize seam on `installSkill`: the source is shaped BEFORE the compare
 * and the write, so "up-to-date" is judged against what the current config state
 * would write, and a flag flip turns the same packaged source into a real update.
 * The copy semantics themselves (symlinks, modes, ownership) stay covered by
 * install.test.ts against the real packaged skills.
 */

const MARKED = [
  '---',
  'name: demo',
  '---',
  'body',
  '<!-- tenjin:when flag -->',
  'conditional line',
  '<!-- /tenjin:when -->',
  '',
].join('\n');

let root: string;
let src: string;
let dest: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-skill-writer-'));
  src = join(root, 'source', 'demo');
  dest = join(root, 'skills', 'demo');
  await mkdir(src, { recursive: true });
  await mkdir(join(root, 'skills'), { recursive: true });
  await writeFile(join(src, 'SKILL.md'), MARKED);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('installSkill with a materialize transform', () => {
  it('writes the shaped content, never the markers', async () => {
    const result = await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: false }),
    });
    expect(result.status).toBe('installed');
    const written = await readFile(join(dest, 'SKILL.md'), 'utf8');
    expect(written).not.toContain('conditional line');
    expect(written).not.toContain('tenjin:when');
    expect(written).toContain('body');
  });

  it('judges up-to-date against the shaped content, so a flag flip is an update', async () => {
    await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: false }),
    });
    const same = await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: false }),
    });
    expect(same.status).toBe('up-to-date');
    const flipped = await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    expect(flipped.status).toBe('updated');
    expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).toContain('conditional line');
  });

  it('a dry run resolves the same shaped content as the real run', async () => {
    const dry = await installSkill(src, dest, true, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    expect(dry.status).toBe('would-install');
    await installSkill(src, dest, false, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    const again = await installSkill(src, dest, true, 'demo', {
      materialize: materializeTransform({ flag: true }),
    });
    expect(again.status).toBe('up-to-date');
  });

  it('a throwing transform aborts before anything is written', async () => {
    await writeFile(join(src, 'SKILL.md'), '<!-- tenjin:when broken -->\nno close\n');
    await expect(
      installSkill(src, dest, false, 'demo', { materialize: materializeTransform({}) }),
    ).rejects.toThrow(/Malformed skill markers/);
    await expect(readFile(join(dest, 'SKILL.md'), 'utf8')).rejects.toThrow();
  });
});

/**
 * The seam HAS consumers now, so the tripwire changes shape rather than going away.
 *
 * What #147 pinned was "no shipped skill carries a marker", because a raw byte
 * comparison is only valid while that holds. Markers now ship, and every comparer
 * materializes: `install`, the post-command self-heal, the optional-skill placer
 * and `doctor`'s staleness compare all go through `skillMaterialize`, and
 * `scripts/pack-smoke.sh` — the one comparer that cannot be taught from inside
 * vitest — asserts the rendered PROPERTIES of the packed artifact instead of raw
 * bytes.
 *
 * What replaces it is the check the parse deliberately cannot make. An unknown flag
 * resolves OFF, which for a when/else pair means silently rendering the OTHER
 * mode's guidance: a `teamMod` typo would ship team text to nobody and public text
 * to a team machine, with every runtime guard green. So the flag NAMES are pinned
 * against the closed set here, at build time, which is the only place a misspelling
 * can fail.
 */
describe('every marker in a shipped skill names a known flag', () => {
  /**
   * EVERY packaged markdown file, not every `SKILL.md`. `materializeTransform`
   * gates on `rel.toLowerCase().endsWith('.md')`, so a marker in a reference file
   * is exactly as load-bearing as one in a SKILL.md. Iterating SKILL_NAMES alone
   * covered three of the five files the package ships.
   */
  it('uses no flag outside SKILL_CONTENT_FLAG_NAMES', async () => {
    const source = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    const known = new Set<string>(SKILL_CONTENT_FLAG_NAMES);
    for (const name of SKILL_NAMES) {
      for (const rel of SHIPPED_SKILL_FILES[name]) {
        const text = await readFile(join(source, name, rel), 'utf8');
        for (const flag of markerFlagsIn(text)) {
          expect(
            known.has(flag),
            `${name}/${rel} gates on "${flag}", which is not a flag this build resolves; ` +
              `an unknown flag renders the OTHER arm, so this is a typo, not a no-op`,
          ).toBe(true);
        }
      }
    }
  });

  /**
   * The marker machinery must never reach a reader. It is instruction-shaped text
   * inside a file an agent reads whole, and a half-stripped skill would have an
   * agent reasoning about which arm applies to it.
   */
  it('renders no marker text in either mode, for every shipped markdown file', async () => {
    const source = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    for (const name of SKILL_NAMES) {
      for (const rel of SHIPPED_SKILL_FILES[name]) {
        const text = await readFile(join(source, name, rel), 'utf8');
        for (const teamMode of [true, false]) {
          const rendered = renderSkillMarkdown(text, { teamMode });
          expect(
            rendered,
            `${name}/${rel} leaks a marker in ${String(teamMode)} mode`,
          ).not.toContain('tenjin:when');
          expect(rendered).not.toContain('tenjin:else');
        }
      }
    }
  });

  /**
   * Balance, on the real files. The parse fails closed on every malformed shape, so
   * this is the case where that guard has to NOT fire: a shipped skill whose markers
   * do not balance would refuse the install outright rather than degrade.
   */
  it('parses every shipped markdown file in both modes without throwing', async () => {
    const source = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    for (const name of SKILL_NAMES) {
      for (const rel of SHIPPED_SKILL_FILES[name]) {
        const text = await readFile(join(source, name, rel), 'utf8');
        for (const teamMode of [true, false]) {
          expect(() => renderSkillMarkdown(text, { teamMode }), `${name}/${rel}`).not.toThrow();
        }
      }
    }
  });

  /**
   * The hosted `tenjin` skill is a byte-for-byte mirror of tenjin.blog/skills.md
   * (scripts/sync-skill.mjs, and skill-drift CI diffs it after re-running the sync),
   * so a marker there would be wiped by the next sync and fail that check. It is
   * also the CLI-LESS path: a reader of it has no `tenjin` binary and so no config
   * to have a mode in. It must stay unshaped.
   */
  it('the hosted mirror carries no marker at all', async () => {
    const source = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    for (const rel of SHIPPED_SKILL_FILES[HOSTED_SKILL_NAME]) {
      const text = await readFile(join(source, HOSTED_SKILL_NAME, rel), 'utf8');
      expect(markerFlagsIn(text), `${HOSTED_SKILL_NAME}/${rel} is a hand-edited mirror`).toEqual(
        [],
      );
      expect(text).not.toContain('tenjin:when');
    }
  });
});

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from './errors';

/**
 * The packaged skills `install` copies into every target harness. All three go to
 * every target: `tenjin` (the zero-install curriculum, works with no CLI),
 * `tenjin-search` and `tenjin-publish` (thin CLI adapters). Order is the install
 * order and the human-render order.
 */
export const SKILL_NAMES = ['tenjin-search', 'tenjin-publish', 'tenjin'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/**
 * Every file a packaged skill ships, per skill, as a path relative to the skill
 * directory.
 *
 * DECLARED rather than discovered, because `uninstall` needs it on a machine
 * where the packaged source may be gone or unreadable, and "remove exactly the
 * files this package wrote" is not a question it can answer by listing the
 * operator's directory — everything else in there is theirs. `install` still
 * copies the real tree; a test pins this list against it, so a new reference
 * file that nobody declares fails the build rather than becoming litter no
 * uninstall can reclaim.
 */
export const SHIPPED_SKILL_FILES: Record<SkillName, readonly string[]> = {
  'tenjin-search': ['SKILL.md', 'references/permissions.md'],
  'tenjin-publish': ['SKILL.md', 'references/maintain.md'],
  tenjin: ['SKILL.md'],
};

// A `skills/` directory is the real one iff it holds `tenjin/SKILL.md`; a bare
// `skills/` created for some other reason up the tree can't false-positive.
const SENTINEL = join('tenjin', 'SKILL.md');

/**
 * Locate the packaged `skills/` directory by walking up from `startDir`. This has
 * to work in two layouts from one resolver: a global npm install where the module
 * lives in `dist/` with `skills/` a sibling (the `files` array ships it), and a
 * repo/source run where the module is under `src/` and `skills/` sits at the repo
 * root. Walking up until a `skills/` with the sentinel appears covers both without
 * hard-coding either depth. Sync (existsSync) on purpose: this is one-shot path
 * resolution at command start, the same shape as `require.resolve`.
 */
export function resolveSkillsSource(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'skills');
    if (existsSync(join(candidate, SENTINEL))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError('INTERNAL', 'Could not locate the packaged Tenjin skills directory', {
    fix: 'Reinstall tenjin-cli; the published package must ship the skills/ directory (files array).',
    details: { startDir },
  });
}

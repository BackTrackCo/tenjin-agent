/**
 * The skills earlier releases copied into each harness's skills directory:
 * `tenjin` (the zero-install curriculum), `tenjin-search` and `tenjin-publish`
 * (thin CLI adapters for shelf commands this CLI no longer ships). None is
 * packaged any more; the names are kept so a refresh can take back what an
 * earlier install wrote.
 */
export const SKILL_NAMES = ['tenjin-search', 'tenjin-publish', 'tenjin'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export const RETIRED_SKILL_NAMES = ['tenjin-pay'] as const;

/**
 * Every file each of those skills shipped, as a path relative to the skill
 * directory.
 *
 * DECLARED rather than discovered, because the packaged source is gone, and
 * "remove exactly the files an earlier install wrote" is not a question a
 * refresh can answer by listing the operator's directory: everything else in
 * there is theirs.
 */
export const SHIPPED_SKILL_FILES: Record<
  SkillName | (typeof RETIRED_SKILL_NAMES)[number],
  readonly string[]
> = {
  'tenjin-search': ['SKILL.md', 'references/permissions.md'],
  'tenjin-publish': ['SKILL.md', 'references/maintain.md'],
  tenjin: ['SKILL.md'],
  'tenjin-pay': ['SKILL.md'],
};

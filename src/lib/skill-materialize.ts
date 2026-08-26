import { CliError } from './errors';

/**
 * Config-conditional blocks in packaged skill markdown. A skill source may wrap a
 * region in full-line HTML-comment markers:
 *
 *     <!-- tenjin:when teamMode -->
 *     ...lines an agent should only see when the flag is on...
 *     <!-- tenjin:else -->
 *     ...lines an agent should only see when it is off...
 *     <!-- /tenjin:when -->
 *
 * Materializing resolves those regions against a flag set and the marker lines
 * themselves never survive, so an installed SKILL.md carries no machinery for an
 * agent to read. The `else` arm is what makes this a REPLACEMENT seam rather than
 * an additive one, and it is the whole reason it exists: the two arms are
 * structurally exclusive, so exactly one of them can ever reach a reader. Guidance
 * that DIFFERS by machine fact is written as one when/else pair replacing one
 * region, never as a base paragraph plus a "however, on a team shelf..." rider —
 * a reader in either mode would then see both, and two rules for the same decision
 * in one file is worse than either rule alone. A bare `when` with no `else` stays
 * legal for content that is genuinely additive.
 *
 * Unknown flags are OFF because every flag this CLI defines defaults off; a marker
 * for a flag this build does not know is a newer source's block, and advertising a
 * lane this build cannot gate is the unsafe direction. That default is safe for a
 * bare `when` and merely wrong-way-round for a when/else, so a typo in a flag NAME
 * cannot be caught here: `skill-writer.test.ts` pins every marker in every shipped
 * skill against {@link SKILL_CONTENT_FLAG_NAMES} instead, which is where a
 * misspelling has to fail.
 *
 * Every writer and every comparer resolves flags through {@link skillContentFlags}
 * so there is one mapping from machine facts to marker flags. `install`, the
 * post-command self-heal, the optional-skill placer and `doctor`'s staleness
 * compare all materialize; `scripts/pack-smoke.sh` cannot run this code against
 * the packed tarball, so it asserts the rendered PROPERTIES (marker-free, and no
 * sentence from the other mode) rather than raw bytes. Those five agree only while
 * that stays true: teaching four of five is how a shaped skill and a raw
 * comparison end up disagreeing forever.
 *
 * The grammar is deliberately line-based and flat (no nesting): the parse below
 * fails closed on anything else, because a half-stripped skill silently teaching
 * the wrong verb set is worse than a refused install.
 */
const OPEN_MARKER = /^\s*<!--\s*tenjin:when\s+([a-zA-Z][a-zA-Z0-9.]*)\s*-->\s*$/;
const CLOSE_MARKER = /^\s*<!--\s*\/tenjin:when\s*-->\s*$/;
/** The arm switch. Carries no flag name: there is exactly one flag in play, the
 *  open marker's, and repeating it is a second place for it to be misspelled. */
const ELSE_MARKER = /^\s*<!--\s*tenjin:else\s*-->\s*$/;
/**
 * A line reaching for the grammar and missing it: trailing content after an open
 * marker, a flag name on a close or an else, a mistyped delimiter. Without this
 * such a line survives as ordinary content and the parse fails much later at
 * whichever marker is left unbalanced, naming a line the author did not write
 * wrong.
 */
const NEAR_MARKER = /^\s*<!--\s*\/?\s*tenjin:(?:when|else)\b/;

/** Flag values keyed by flag name; absent keys read as false. */
export type SkillContentFlags = Readonly<Record<string, boolean>>;

/**
 * Every flag name a shipped skill's markers may use. A closed set, and the reason
 * it can be one is that the runtime deliberately cannot police it: an unknown flag
 * resolves OFF, which for a when/else pair means silently rendering the OTHER
 * mode's guidance. So the check for a misspelled flag is a build-time one over the
 * packaged skills (`skill-writer.test.ts`), and this is the list it checks against.
 */
export const SKILL_CONTENT_FLAG_NAMES = ['teamMode'] as const;

/**
 * THE mapping from machine facts to marker flags. Every writer and comparer goes
 * through this rather than building a record inline, so there is one answer to
 * "what does this machine's skill text say" and no call site can drift by omitting
 * a flag (an omitted flag is a silent OFF, which is a rendered mode, not an error).
 *
 * `teamMode` is the machine's CONFIGURED mode — a team shelf of the team's own
 * plus its door key, per `settings.isTeamModeConfig` — not this invocation's. A
 * `--base-url` cannot reach it, and it should not: the file being written outlives
 * the command that wrote it and is read by every later session on this machine.
 */
export function skillContentFlags(facts: { teamMode: boolean }): SkillContentFlags {
  return { teamMode: facts.teamMode };
}

/** The transform `installSkill` takes, for a machine in the given mode. */
export function skillMaterialize(facts: {
  teamMode: boolean;
}): (rel: string, content: Buffer) => Buffer {
  return materializeTransform(skillContentFlags(facts));
}

/** One packaged skill file's text as this machine would read it. */
export function renderSkillMarkdown(text: string, facts: { teamMode: boolean }): string {
  return materializeSkillMarkdown(text, skillContentFlags(facts));
}

export function materializeSkillMarkdown(text: string, flags: SkillContentFlags): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock: string | null = null;
  /** Does the arm currently being read survive? */
  let keep = false;
  /** Has this block's `else` been seen? A second one is malformed, not a no-op. */
  let elsed = false;
  for (const [i, line] of lines.entries()) {
    const open = OPEN_MARKER.exec(line);
    if (open !== null) {
      if (inBlock !== null) {
        throw markerError(`nested tenjin:when at line ${i + 1} (already inside "${inBlock}")`);
      }
      inBlock = open[1]!;
      keep = flags[inBlock] === true;
      elsed = false;
      continue;
    }
    if (ELSE_MARKER.test(line)) {
      if (inBlock === null) throw markerError(`unopened tenjin:else at line ${i + 1}`);
      // Two elses would make the third arm's fate depend on parity, and the author
      // who typed it meant one of them to be a close.
      if (elsed) throw markerError(`second tenjin:else at line ${i + 1} in "${inBlock}"`);
      elsed = true;
      keep = !keep;
      continue;
    }
    if (CLOSE_MARKER.test(line)) {
      if (inBlock === null) throw markerError(`unopened /tenjin:when at line ${i + 1}`);
      inBlock = null;
      continue;
    }
    if (NEAR_MARKER.test(line)) {
      throw markerError(`malformed tenjin:when marker at line ${i + 1}: ${line.trim()}`);
    }
    if (inBlock === null || keep) out.push(line);
  }
  if (inBlock !== null) throw markerError(`unclosed tenjin:when "${inBlock}"`);
  return out.join('\n');
}

/**
 * Every flag name the markers in `text` reference, in source order. Used by the
 * build-time pin over the packaged skills; see {@link SKILL_CONTENT_FLAG_NAMES}
 * for why that check cannot live in the parse.
 */
export function markerFlagsIn(text: string): string[] {
  return text
    .split('\n')
    .map((line) => OPEN_MARKER.exec(line)?.[1])
    .filter((flag): flag is string => flag !== undefined);
}

/**
 * The transform `installSkill` takes for packaged source files. Only markdown is
 * text this grammar owns; any other file type a skill may ever ship passes through
 * byte-for-byte, so this can never corrupt a non-text asset.
 */
export function materializeTransform(
  flags: SkillContentFlags,
): (rel: string, content: Buffer) => Buffer {
  return (rel, content) => {
    if (!rel.toLowerCase().endsWith('.md')) return content;
    return Buffer.from(materializeSkillMarkdown(content.toString('utf8'), flags), 'utf8');
  };
}

function markerError(detail: string): CliError {
  return new CliError('INTERNAL', `Malformed skill markers: ${detail}.`, {
    fix: 'Reinstall tenjin-cli; the packaged skills must carry balanced tenjin:when markers.',
  });
}

import { CliError } from './errors';

/**
 * Config-conditional blocks in packaged skill markdown. A skill source may wrap a
 * region in full-line HTML-comment markers:
 *
 *     <!-- tenjin:when bazaarPay -->
 *     ...lines an agent should only see when the flag is on...
 *     <!-- /tenjin:when -->
 *
 * Materializing resolves those regions against a flag set: an ON flag keeps the
 * inner lines, an OFF or unknown flag drops them, and the marker lines themselves
 * never survive either way, so an installed SKILL.md carries no machinery for an
 * agent to read. Unknown flags are OFF because every flag this CLI defines
 * defaults off; a marker for a flag this build does not know is a newer source's
 * block, and advertising a lane this build cannot gate is the unsafe direction.
 *
 * NO SHIPPED SKILL CARRIES A MARKER TODAY, and `skill-writer.test.ts` pins that.
 * This is a seam waiting for its first flag, not a live transform: no writer
 * passes it, so `install`, the self-heal and `doctor` all still compare packaged
 * bytes directly, as does `scripts/pack-smoke.sh`. Those four comparers agree
 * only while that stays true, which is what the pin is for. Wiring the first real
 * flag means teaching ALL FOUR to materialize through one shared resolver in the
 * same change: three of four is how a shaped skill and a raw comparison end up
 * disagreeing forever.
 *
 * The grammar is deliberately line-based and flat (no nesting): the parse below
 * fails closed on anything else, because a half-stripped skill silently teaching
 * the wrong verb set is worse than a refused install.
 */

const OPEN_MARKER = /^\s*<!--\s*tenjin:when\s+([a-zA-Z][a-zA-Z0-9.]*)\s*-->\s*$/;
const CLOSE_MARKER = /^\s*<!--\s*\/tenjin:when\s*-->\s*$/;
/**
 * A line reaching for the grammar and missing it: trailing content after an open
 * marker, a flag name on a close, a mistyped delimiter. Without this such a line
 * survives as ordinary content and the parse fails much later at whichever marker
 * is left unbalanced, naming a line the author did not write wrong.
 */
const NEAR_MARKER = /^\s*<!--\s*\/?\s*tenjin:when\b/;

/** Flag values keyed by flag name; absent keys read as false. */
export type SkillContentFlags = Readonly<Record<string, boolean>>;

export function materializeSkillMarkdown(text: string, flags: SkillContentFlags): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlock: string | null = null;
  let keep = false;
  for (const [i, line] of lines.entries()) {
    const open = OPEN_MARKER.exec(line);
    if (open !== null) {
      if (inBlock !== null) {
        throw markerError(`nested tenjin:when at line ${i + 1} (already inside "${inBlock}")`);
      }
      inBlock = open[1]!;
      keep = flags[inBlock] === true;
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

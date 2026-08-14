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
 * agent to read. A flag is a skill-shaping config key or a machine fact the
 * writer resolves at write time (`wallet`: does a local wallet exist, so the
 * skill only teaches spending verbs somewhere they can run). Unknown flags are
 * OFF because every flag this CLI defines defaults off; a marker for a flag this
 * build does not know is a newer source's block, and advertising a lane this
 * build cannot gate would be the unsafe direction.
 *
 * The grammar is deliberately line-based and flat (no nesting): the parse below
 * fails closed on anything else, because a half-stripped skill silently teaching
 * the wrong verb set is worse than a refused install.
 */

const OPEN_MARKER = /^\s*<!--\s*tenjin:when\s+([a-zA-Z][a-zA-Z0-9.]*)\s*-->\s*$/;
const CLOSE_MARKER = /^\s*<!--\s*\/tenjin:when\s*-->\s*$/;

/** Flag values keyed by flag name; absent keys read as false. */
export type SkillContentFlags = Readonly<Record<string, boolean>>;

/**
 * The machine facts skill content is currently shaped by. One resolver so
 * `install`, the self-heal, and `doctor` judge the same flag set from the same
 * inputs: content they disagree on would oscillate between their writes.
 */
export interface SkillFlagInputs {
  /** Does a local wallet exist (lib/paths walletPath)? Gates spending-verb teaching. */
  walletPresent: boolean;
  /** The `bazaarPay` config toggle; gates the Bazaar-lane teaching. */
  bazaarPay?: boolean;
}

export function skillContentFlags(input: SkillFlagInputs): SkillContentFlags {
  return { wallet: input.walletPresent, bazaarPay: input.bazaarPay === true };
}

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
    if (inBlock === null || keep) out.push(line);
  }
  if (inBlock !== null) throw markerError(`unclosed tenjin:when "${inBlock}"`);
  return out.join('\n');
}

/**
 * The transform `installSkill` applies to packaged source files. Only markdown is
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

/** Every flag name the markers in `text` reference, deduplicated, in order. */
export function markerFlagsIn(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const open = OPEN_MARKER.exec(line);
    if (open !== null && !found.includes(open[1]!)) found.push(open[1]!);
  }
  return found;
}

/**
 * Would ANY flag assignment materialize `sourceText` into exactly `disk`? This is
 * how a maintenance pass tells "this copy is ours, shaped by some config state"
 * from "this copy is edited or came from elsewhere" without a ledger: the
 * assignment space is the file's own markers, tiny by construction. Capped so a
 * pathological source cannot turn a doctor run into 2^n materializations; past
 * the cap the honest answer is "cannot verify", which reads false here.
 */
const VARIANT_FLAG_CAP = 6;

export function matchesSomeVariant(sourceText: string, disk: Buffer): boolean {
  const names = markerFlagsIn(sourceText);
  if (names.length > VARIANT_FLAG_CAP) return false;
  for (let mask = 0; mask < 1 << names.length; mask += 1) {
    const flags: Record<string, boolean> = {};
    for (const [bit, name] of names.entries()) flags[name] = (mask & (1 << bit)) !== 0;
    let variant: string;
    try {
      variant = materializeSkillMarkdown(sourceText, flags);
    } catch {
      return false; // malformed markers can equal nothing we would have written
    }
    if (Buffer.from(variant, 'utf8').equals(disk)) return true;
  }
  return false;
}

function markerError(detail: string): CliError {
  return new CliError('INTERNAL', `Malformed skill markers: ${detail}.`, {
    fix: 'Reinstall tenjin-cli; the packaged skills must carry balanced tenjin:when markers.',
  });
}

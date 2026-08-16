import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import type { PublishMode } from './config';

/**
 * The one place the CLI WRITES a permission grant into a harness's own settings
 * file, so the invariants live here rather than at the call site:
 *
 *  - OPT-OUT, AND DISCLOSED. An interactive install asks; a non-interactive one
 *    writes the free tier by default, because an unattended agent that gets
 *    denied is the failure this whole file exists to prevent, and a machine run
 *    has no one to ask. `--no-allow-free-verbs` refuses it outright, and every
 *    run that writes says which rules landed, in which file, and how to remove
 *    them. What keeps that defensible is the next two invariants: the grant is a
 *    fixed free tier, and it can never widen.
 *  - TWO FIXED SETS, AND NOT PARAMETERIZED. The writer takes no rule argument.
 *    It takes a {@link PublishMode}, and that selects between exactly two
 *    hardcoded constants: {@link FREE_VERB_RULES}, and those plus
 *    {@link PUBLISH_MODE_RULE}. So there is no call path — no flag, no config
 *    key, no future caller — that can make it write `buy`, `session start`,
 *    `send`, `config set`, `wallet create`, `mcp`, `install`, or a broad
 *    `Bash(tenjin:*)`. A CLI that could widen its own permission grant is exactly
 *    what this shape rules out.
 *
 *    The publish rule is gated on the mode and on nothing else. INSTALLING
 *    TENJIN IS THE CONSENT for it (owner call, PR #164): every install settles
 *    `publish.mode` at `auto` unless told otherwise, and the FIRST install
 *    writes this rule alongside the free tier rather than waiting for a second
 *    run to read that default back as a choice. What keeps it defensible is
 *    disclosure rather than provenance — the install output names the mode,
 *    this rule, and the three ways out. Being on `auto` already means "a clean
 *    publish proceeds without asking", and a harness prompt in front of it asks
 *    that same question again somewhere the mode cannot answer (#161). Going
 *    back to `review` RETRACTS the rule, on the next `install` or immediately
 *    through `config set publish.mode review`, so a grant never outlives the
 *    mode that justified it; `uninstall` reclaims it outright.
 *
 *    What this does NOT loosen: the rule clears the HARNESS prompt and nothing
 *    else. The CLI's own gates are untouched — the deterministic scan blocks a
 *    hard finding in every mode and no `--yes` clears it, and `review` still
 *    asks per publish. An agent cannot reach `install` or `config set` on its
 *    own either; both are never-allowlisted.
 *  - ADDITIVE, PLUS ONE RETRACTION THAT IS STILL OURS. Every other key in the
 *    file, and every allow-rule we did not write, is copied through verbatim in
 *    its original order; missing rules are appended. The single exception is
 *    {@link LEGACY_FREE_VERB_RULES}: a rule an EARLIER version of this same
 *    writer put there and this one no longer recommends. Leaving it would mean
 *    a user who updates and re-runs `install` keeps a grant for a command that
 *    no longer exists, which is bloat we created and only we can clear. It
 *    widens nothing — the set is disjoint from what we write, a test pins that
 *    — and every removal is reported like every addition. A re-run on a current
 *    machine still changes nothing.
 *  - NEVER CLOBBERS. A settings file we cannot parse, or whose `permissions` /
 *    `permissions.allow` is not the shape we expect, is left untouched and
 *    reported as skipped. We do not "repair" someone's hand-edited config.
 *
 * The rules mirror lib/permissions.ts's ALWAYS_SAFE_ALLOWLIST (the block
 * `doctor` prints and the README quotes) and are duplicated as literals on
 * purpose: that module is a DOCUMENT whose safe tier could grow, and a widened
 * tier must not silently widen what install writes. A test pins the two lists
 * equal, so drift is a red build rather than a broader grant.
 */

/** Claude Code's user-level settings file, the only file this module writes. */
export function claudeSettingsPath(homeDir: string): string {
  return join(homeDir, '.claude', 'settings.json');
}

/**
 * The exact rules install may add. Free verbs only: none of them can spend USDC
 * or move your keys. See lib/permissions.ts for the per-verb notes and for
 * the flag caveat that qualifies every prefix rule.
 */
export const FREE_VERB_RULES: readonly string[] = [
  'Bash(tenjin search:*)',
  'Bash(tenjin fund:*)',
  'Bash(tenjin inspect:*)',
  'Bash(tenjin read:*)',
  'Bash(tenjin outcome:*)',
  'Bash(tenjin doctor:*)',
  'Bash(tenjin wallet show:*)',
  'Bash(tenjin wallet balance:*)',
  'Bash(tenjin config get:*)',
];

/**
 * The rule `publish.mode` gates, mirroring lib/permissions.ts's
 * PUBLISH_MODE_ALLOWLIST and duplicated as a literal for the same reason
 * {@link FREE_VERB_RULES} is: that module is a DOCUMENT, and an edit there must
 * not silently change what this file writes. A test pins the two together.
 *
 * Deliberately NOT a member of {@link FREE_VERB_RULES}: it can neither spend nor
 * move keys, but it publishes publicly under the operator's identity, so it is
 * not free-tier and never rides along with it.
 */
export const PUBLISH_MODE_RULE = 'Bash(tenjin publish:*)';

/**
 * Exactly what may be written for `mode`. The two return values are the only two
 * rule sets this module can produce.
 */
export function rulesForPublishMode(mode: PublishMode): readonly string[] {
  return mode === 'review' ? FREE_VERB_RULES : [...FREE_VERB_RULES, PUBLISH_MODE_RULE];
}

/**
 * What this run should sweep out: what an older version wrote, plus the publish
 * rule when the mode no longer justifies it. A retraction is always a rule this
 * CLI wrote under a setting the operator has since changed, and it is reported
 * exactly like an addition.
 */
function retiredFor(mode: PublishMode): Set<string> {
  const retired = new Set<string>(LEGACY_FREE_VERB_RULES);
  if (mode === 'review') retired.add(PUBLISH_MODE_RULE);
  return retired;
}

/**
 * Rules a PRIOR version of this writer put in `permissions.allow` and this one
 * no longer recommends. BOTH paths read it: `install` removes them on its next
 * run, `uninstall` reclaims them as its own. NEITHER path ever writes one — the
 * writable set is {@link FREE_VERB_RULES} and this list is disjoint from it, so
 * a retired rule can only ever be deleted, never re-added. A test pins that
 * disjointness, because the day the two overlap is the day install starts
 * re-adding a grant for a command that does not exist.
 *
 * Why it has to exist at all: a rule dropped from FREE_VERB_RULES is otherwise
 * invisible to every later version. The operator keeps an allow-line for a
 * command that no longer exists, `install` walks past it because it is not in
 * the set it writes, and `uninstall` walks past it because it is no longer
 * "ours". It IS ours — we wrote it — and a user who updates and re-runs
 * `install` should end up with exactly the current tier and nothing we left
 * behind. Anything retired from the free tier belongs here.
 *
 * `Bash(tenjin candidate list:*)` is the first entry: the candidate pen was
 * removed, and machines installed before that still carry its rule.
 */
export const LEGACY_FREE_VERB_RULES: readonly string[] = ['Bash(tenjin candidate list:*)'];

/**
 * Verb fragments that must never appear in {@link FREE_VERB_RULES}. Asserted by
 * a test rather than at runtime: the constant above is not reachable from any
 * input, so the only way one of these lands in it is an edit to this file, and a
 * test is what catches an edit.
 */
export const FORBIDDEN_VERB_FRAGMENTS: readonly string[] = [
  'tenjin buy',
  'tenjin publish',
  'tenjin edit',
  'tenjin session',
  'tenjin send',
  'tenjin config set',
  'tenjin wallet create',
  'tenjin mcp',
  'tenjin install',
  'Bash(tenjin:*)',
];

/**
 * Why no rules were written. Every value is a reason to leave the file alone,
 * never a partial write: the writer either appends all missing rules or none.
 */
export type PermissionsSkipReason =
  | 'harness-not-claude'
  | 'not-requested'
  | 'declined'
  | 'dry-run'
  | 'unresolvable'
  | 'unreadable'
  | 'unparsable'
  | 'unexpected-shape'
  | 'changed-since-read';

export interface PermissionsResult {
  /** The harness this outcome is about; only `claude` has a settings file we write. */
  harness: string;
  /**
   * The settings file, reported even when nothing was written so a human can go
   * look. ABSENT when the harness has no such file: naming a Claude path on a
   * Codex-only install would point the envelope's reader at a file that has
   * nothing to do with their harness.
   */
  path?: string;
  added: string[];
  alreadyPresent: string[];
  /**
   * Rules an EARLIER version of this writer wrote and this one retired, removed
   * on this run. Almost always empty; non-empty exactly once, on the first
   * install after an update that retired something.
   */
  removed: string[];
  skipped?: PermissionsSkipReason;
  /** Human-readable detail for a skip that is a problem rather than a choice. */
  warning?: string;
  /**
   * The exact command that changes this outcome, present on EVERY skipped state.
   * Same contract as a CliError's `fix`: a machine consumer reading the envelope
   * gets the remedy as a field, never as prose it has to interpret. The human
   * walkthrough renders its own wording from `skipped`, so the two never collide.
   */
  fix?: string;
}

/**
 * The command that turns a skip into a write. Kept beside the reason vocabulary
 * so a new reason cannot ship without one.
 */
function fixFor(reason: PermissionsSkipReason): string {
  switch (reason) {
    case 'harness-not-claude':
      return 'This allowlist is Claude Code only. Run `tenjin doctor` for the lines your harness needs.';
    case 'not-requested':
    case 'declined':
    case 'dry-run':
      return 'Add them with `tenjin install --allow-free-verbs`.';
    case 'changed-since-read':
      return 'Another process changed the file mid-run; re-run `tenjin install`.';
    default:
      return 'Fix the reported file, then run `tenjin install --allow-free-verbs`.';
  }
}

function skip(
  harness: string,
  path: string | undefined,
  reason: PermissionsSkipReason,
  warning?: string,
): PermissionsResult {
  return {
    harness,
    ...(path !== undefined ? { path } : {}),
    added: [],
    removed: [],
    alreadyPresent: [],
    skipped: reason,
    ...(warning !== undefined ? { warning } : {}),
    fix: fixFor(reason),
  };
}

/** A decision NOT to write, shaped like a write outcome so the caller has one type. */
export function permissionsSkipped(
  harness: string,
  homeDir: string,
  reason: PermissionsSkipReason,
): PermissionsResult {
  const path = harness === 'claude' ? claudeSettingsPath(homeDir) : undefined;
  return skip(harness, path, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add the rules `mode` calls for to `permissions.allow` in
 * ~/.claude/settings.json. Creates the file (and the `permissions.allow` path)
 * when absent, appends only the rules that are missing, and rewrites nothing
 * else. Idempotent: a second run at the same mode returns `added: []` with every
 * rule under `alreadyPresent` and does not touch the file at all.
 */
export async function wireFreeVerbAllowlist(
  homeDir: string,
  mode: PublishMode = 'review',
): Promise<PermissionsResult> {
  const found = await inspectAllowlist(homeDir, mode);
  if ('result' in found) return found.result;
  const { path, raw, settings, permissions, allow, added, alreadyPresent } = found;
  // Rules an earlier version of this writer left behind, and the publish rule
  // when the mode no longer carries it. Swept on the same pass that appends, so
  // one `tenjin install` leaves a settings.json holding exactly what this
  // machine's current mode calls for and no residue from what it used to be.
  const retired = retiredFor(mode);
  const removed = allow.filter((r): r is string => typeof r === 'string' && retired.has(r));
  if (added.length === 0 && removed.length === 0) {
    return { harness: 'claude', path, added: [], alreadyPresent, removed: [] };
  }

  // Object spreads keep the original key order and land the rebuilt `permissions`
  // in the slot it already occupied, so a diff of the file is the appended rules,
  // the retired ones dropped, and nothing else.
  const kept = allow.filter((r) => !(typeof r === 'string' && retired.has(r)));
  const next = {
    ...settings,
    permissions: { ...permissions, allow: [...kept, ...added] },
  };
  // This is a whole-file read-modify-write, so a change landing between the read
  // and the rename would be erased in full, including keys that have nothing to do
  // with permissions. Claude Code writes this file too, so the other writer is not
  // hypothetical. Compare the bytes we based the edit on and refuse rather than
  // clobber; the operator re-runs and the merge is recomputed against what is
  // actually there.
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== raw) {
    return skip(
      'claude',
      path,
      'changed-since-read',
      `${path} changed while it was being updated, so nothing was written. Re-run \`tenjin install\`.`,
    );
  }
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { harness: 'claude', path, added, alreadyPresent, removed };
}

/**
 * The probe the install walkthrough uses: what is still missing, plus the outcome
 * to report when nothing is. Returning the SNAPSHOT's own result matters. Calling
 * the writer again after a zero-pending probe re-reads the file, so a rule revoked
 * between the two reads was silently re-added with no prompt, which is the one
 * thing a consent gate must not do.
 *
 * `pending` is null when the file cannot be understood; that is "unknown", never
 * "already allowed", and the caller must still ask.
 *
 * `satisfied` is returned ONLY when there is nothing to add AND nothing retired
 * to sweep. A machine that already carries every current rule plus one an older
 * version wrote is NOT satisfied: reporting it as such would short-circuit the
 * writer and strand exactly the rule the sweep exists to clear. `pending` stays
 * empty there, so the caller can tell "nothing to grant, but work to do" from
 * "something to grant" and skip the consent prompt for a run that only removes.
 */
export async function inspectFreeVerbRules(
  homeDir: string,
  mode: PublishMode = 'review',
): Promise<{ pending: string[] | null; satisfied?: PermissionsResult }> {
  const found = await inspectAllowlist(homeDir, mode);
  if ('result' in found) return { pending: null };
  if (found.added.length > 0) return { pending: found.added };
  const retired = retiredFor(mode);
  if (found.allow.some((r) => typeof r === 'string' && retired.has(r))) return { pending: [] };
  return {
    pending: [],
    satisfied: {
      harness: 'claude',
      path: found.path,
      added: [],
      alreadyPresent: found.alreadyPresent,
      removed: [],
    },
  };
}

interface AllowlistInspection {
  path: string;
  /** The exact bytes read, so the commit can prove nothing changed underneath it. */
  raw: string | null;
  settings: Record<string, unknown>;
  permissions: Record<string, unknown>;
  allow: unknown[];
  added: string[];
  alreadyPresent: string[];
}

/**
 * Resolve and read the settings file, and work out which rules are missing.
 * Every refusal this module can reach is decided here, so the probe and the
 * write agree by construction about what is untouchable.
 */
async function inspectAllowlist(
  homeDir: string,
  mode: PublishMode,
): Promise<AllowlistInspection | { result: PermissionsResult }> {
  const declaredPath = claudeSettingsPath(homeDir);
  const refuse = (
    p: string,
    reason: PermissionsSkipReason,
    warning: string,
  ): { result: PermissionsResult } => ({ result: skip('claude', p, reason, warning) });

  // `lstat`, not `existsSync`: existsSync FOLLOWS a symlink, so a link pointing at
  // a file that is not there reads as "absent" and the create path below would
  // rename a regular file over the link. We need to know whether an ENTRY is
  // there, whatever it points at.
  const entry = await lstat(declaredPath).catch(() => null);

  // Resolve symlinks BEFORE writing. `writeFileAtomic` commits with a rename,
  // which replaces a symlink with a regular file: a settings.json linked into a
  // dotfiles repo would be severed, its target left stale, and future edits there
  // would stop reaching Claude Code. Renaming over the RESOLVED path edits the
  // file the operator actually maintains and leaves the link intact, which is
  // what this module's additive-only, never-clobber invariants promise. A link we
  // cannot resolve is left alone rather than overwritten; for a genuinely absent
  // file there is nothing to follow and we create it at the declared path.
  let path = declaredPath;
  if (entry !== null) {
    try {
      path = await realpath(declaredPath);
    } catch (err) {
      return refuse(
        declaredPath,
        'unresolvable',
        `${declaredPath} could not be resolved (${(err as Error).message}); it was left exactly as it is.`,
      );
    }
  }

  let settings: Record<string, unknown> = {};
  let raw: string | null = null;
  if (entry !== null) {
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      return refuse(
        path,
        'unreadable',
        `${path} could not be read (${(err as Error).message}); no permissions were written.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return refuse(
        path,
        'unparsable',
        `${path} is not valid JSON (${(err as Error).message}); it was left exactly as it is.`,
      );
    }
    if (!isPlainObject(parsed)) {
      return refuse(
        path,
        'unexpected-shape',
        `${path} is not a JSON object; it was left exactly as it is.`,
      );
    }
    settings = parsed;
  }

  // `permissions` and `permissions.allow` may be absent (we create them), but a
  // present one of the wrong type is someone else's structure: refuse rather
  // than replace it. Unknown entry types inside `allow` are fine and ride
  // through verbatim; they simply never match a rule.
  const permissionsValue = settings.permissions;
  if (permissionsValue !== undefined && !isPlainObject(permissionsValue)) {
    return refuse(
      path,
      'unexpected-shape',
      `${path} has a "permissions" key that is not an object; it was left exactly as it is.`,
    );
  }
  const permissions: Record<string, unknown> = permissionsValue ?? {};
  const allowValue = permissions.allow;
  if (allowValue !== undefined && !Array.isArray(allowValue)) {
    return refuse(
      path,
      'unexpected-shape',
      `${path} has a "permissions.allow" key that is not an array; it was left exactly as it is.`,
    );
  }
  const allow: unknown[] = allowValue ?? [];

  const present = new Set(allow.filter((e): e is string => typeof e === 'string'));
  const writable = rulesForPublishMode(mode);
  const added = writable.filter((rule) => !present.has(rule));
  const alreadyPresent = writable.filter((rule) => present.has(rule));
  return { path, raw, settings, permissions, allow, added, alreadyPresent: [...alreadyPresent] };
}

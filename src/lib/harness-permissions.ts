import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-json';

/**
 * The one place the CLI WRITES a permission grant into a harness's own settings
 * file, so the invariants live here rather than at the call site:
 *
 *  - CONSENT-GATED. Nothing in this module runs unless the operator said yes at
 *    the install prompt or passed `--allow-free-verbs`. It is never reached by a
 *    bare non-interactive run.
 *  - FREE-TIER ONLY, AND NOT PARAMETERIZED. The rules are the hardcoded
 *    {@link FREE_VERB_RULES} constant and the writer takes no rule argument, so
 *    there is no call path — no flag, no config key, no future caller — that can
 *    make it write `buy`, `publish`, `session start`, `send`, `config set`,
 *    `wallet create`, `mcp`, `install`, or a broad `Bash(tenjin:*)`. A CLI that
 *    could widen its own permission grant is exactly what this shape rules out.
 *  - ADDITIVE ONLY. Existing entries and every other key in the file are copied
 *    through verbatim, in their original order; missing rules are appended. A
 *    re-run adds nothing and reports what was already present.
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
 * or open the keystore. See lib/permissions.ts for the per-verb notes and for
 * the flag caveat that qualifies every prefix rule.
 */
export const FREE_VERB_RULES: readonly string[] = [
  'Bash(tenjin search:*)',
  'Bash(tenjin inspect:*)',
  'Bash(tenjin read:*)',
  'Bash(tenjin outcome:*)',
  'Bash(tenjin doctor:*)',
  'Bash(tenjin wallet show:*)',
  'Bash(tenjin wallet balance:*)',
  'Bash(tenjin config get:*)',
  'Bash(tenjin candidate list:*)',
];

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
  'tenjin candidate add',
  'tenjin candidate drop',
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
  | 'unexpected-shape';

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
  skipped?: PermissionsSkipReason;
  /** Human-readable detail for a skip that is a problem rather than a choice. */
  warning?: string;
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
    alreadyPresent: [],
    skipped: reason,
    ...(warning !== undefined ? { warning } : {}),
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
 * Add the free-verb rules to `permissions.allow` in ~/.claude/settings.json.
 * Creates the file (and the `permissions.allow` path) when absent, appends only
 * the rules that are missing, and rewrites nothing else. Idempotent: a second
 * run returns `added: []` with every rule under `alreadyPresent` and does not
 * touch the file at all.
 */
export async function wireFreeVerbAllowlist(homeDir: string): Promise<PermissionsResult> {
  const found = await inspectAllowlist(homeDir);
  if ('result' in found) return found.result;
  const { path, settings, permissions, allow, added, alreadyPresent } = found;
  if (added.length === 0) return { harness: 'claude', path, added: [], alreadyPresent };

  // Object spreads keep the original key order and land the rebuilt `permissions`
  // in the slot it already occupied, so a diff of the file is the appended rules
  // and nothing else.
  const next = {
    ...settings,
    permissions: { ...permissions, allow: [...allow, ...added] },
  };
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { harness: 'claude', path, added, alreadyPresent };
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
 */
export async function inspectFreeVerbRules(
  homeDir: string,
): Promise<{ pending: string[] | null; satisfied?: PermissionsResult }> {
  const found = await inspectAllowlist(homeDir);
  if ('result' in found) return { pending: null };
  if (found.added.length > 0) return { pending: found.added };
  return {
    pending: [],
    satisfied: {
      harness: 'claude',
      path: found.path,
      added: [],
      alreadyPresent: found.alreadyPresent,
    },
  };
}

interface AllowlistInspection {
  path: string;
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
  if (entry !== null) {
    let raw: string;
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
  const added = FREE_VERB_RULES.filter((rule) => !present.has(rule));
  const alreadyPresent = FREE_VERB_RULES.filter((rule) => present.has(rule));
  return { path, settings, permissions, allow, added, alreadyPresent: [...alreadyPresent] };
}

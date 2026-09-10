import { lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { codexRulesPath, grantedPrefixes, rulesFileBody, verifyPrefixAllowed } from './codex-rules';
export { removeCodexGrant } from './codex-rules';
import type { PublishMode } from './config';

/**
 * The one place the CLI WRITES a permission grant into a harness's own settings
 * file, so the invariants live here rather than at the call site:
 *
 *  - OPT-OUT, AND DISCLOSED. Every install writes the free tier, because an
 *    unattended agent that gets denied is the failure this whole file exists to
 *    prevent. `--no-allow-free-verbs` refuses it outright, and every run that
 *    writes says how many rules landed and in which file. What keeps that defensible is the next two invariants: the grant is a
 *    fixed free tier, and it can never widen.
 *  - TWO FIXED SETS, AND NOT PARAMETERIZED. The writer takes no rule argument.
 *    It takes a {@link PublishMode}, and that selects between exactly two
 *    hardcoded constants: {@link FREE_VERB_RULES}, and those plus
 *    {@link MODE_GATED_RULES}. So there is no call path — no flag, no config
 *    key, no future caller — that can make it write `buy`, `wallet send`,
 *    `config set`, `wallet create`, `mcp`, `install`, or a broad
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
 *    {@link LEGACY_ALLOWLIST_RULES}: a rule an EARLIER version of this same
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
 * Where each harness keeps a persistent, command-scoped grant an installer may
 * write. One entry per harness, each a claim about that HARNESS rather than
 * about this code — the thing that went wrong was reporting the absence of a
 * writer as a property of our implementation (`harness-not-claude`) while
 * rendering Claude's rules to a Codex operator anyway (tenjin-agent#342).
 *
 * `writable` is a promise this module keeps: the fixed tiers above, in that
 * harness's own grammar, and nothing else. Both shipped harnesses are
 * `writable`, so `absent` claims nothing today.
 *
 * Codex's search is recorded because four plausible candidates are wrong and
 * one is right (`codex-cli 0.154.0`, openai/codex at `rust-v0.154.0`):
 *
 *  - RIGHT: `$CODEX_HOME/rules/*.rules`, the user exec-policy layer, where
 *    Codex's own "don't ask again for commands that start with ..." persists.
 *  - `approved_command_prefixes` is a world-state field shown to the model.
 *  - `requirements.toml` does carry exec `prefix_rules`, at
 *    `/etc/codex/requirements.toml` or by MDM. It needs root, and writing it
 *    would be the same forgery as writing a `trusted_hash`.
 *  - A permission profile has no exec member, only filesystem and network.
 *  - `approval_policy = "never"` and project `trust_level` are user-writable
 *    and BLANKET: they clear every command rather than `tenjin publish`, so
 *    writing either would grant far more than the mode consents to. This CLI
 *    writes neither.
 */
/**
 * WHICH writer owns a harness's grant. Named rather than inferred, because
 * "writable" alone is not enough to route on: Codex has a real surface and
 * Claude's writer must still never touch it. Selecting on `kind` alone sent a
 * Codex-only install down the Claude writer, which would have created a
 * `~/.claude/settings.json` on a machine with no Claude on it.
 */
export type GrantWriter = 'claude-settings' | 'codex-rules';

export type GrantSurface =
  | {
      kind: 'writable';
      writer: GrantWriter;
      path(homeDir: string, env?: NodeJS.ProcessEnv): string;
    }
  | {
      kind: 'absent';
      /** One line naming what the harness does instead. */
      why: string;
      /** What a person can do about it, or the empty list when nothing helps. */
      operatorSteps: string[];
    };

export const GRANT_SURFACE: Readonly<Record<string, GrantSurface>> = {
  claude: { kind: 'writable', writer: 'claude-settings', path: claudeSettingsPath },
  codex: { kind: 'writable', writer: 'codex-rules', path: codexRulesPath },
};

/** Does `harness` keep its grant in the file `writer` owns? */
export function usesGrantWriter(harness: string, writer: GrantWriter): boolean {
  const surface = grantSurfaceFor(harness);
  return surface.kind === 'writable' && surface.writer === writer;
}

/** The grant surface for `harness`, or `absent` for one we know nothing about. */
export function grantSurfaceFor(harness: string): GrantSurface {
  return (
    GRANT_SURFACE[harness] ?? {
      kind: 'absent',
      why: `This build knows no permission surface for ${harness}.`,
      operatorSteps: [],
    }
  );
}

/**
 * What a harness's grant state IS, in the four words `doctor` reports it with.
 * Deliberately separate from {@link PermissionsSkipReason}, which is about one
 * WRITE; this is about a machine.
 */
export type PermissionState = 'granted' | 'pending' | 'unsupported' | 'skipped' | 'unknown';

export interface HarnessPermissions {
  harness: string;
  state: PermissionState;
  /** The file consulted, absent when the harness has none. */
  path?: string;
  /** Rules of ours in force there. Always empty for an `absent` surface, which
   *  is the point: a Codex machine has no `Bash(...)` rules to list. */
  rules: string[];
  /** Rules this machine's mode calls for and does not have. */
  missing: string[];
  /** One line an operator can act on. */
  detail: string;
  fix?: string;
}

/**
 * Read one harness's grant state, without writing anything.
 *
 * PER HARNESS, INDEPENDENTLY. `doctor` used to read Claude's settings file and
 * print it under a heading naming no harness, so a Codex-only machine was told
 * `Bash(tenjin publish:*)` was in effect while Codex's approval layer denied
 * every `tenjin publish` (tenjin-agent#342).
 */
export async function inspectHarnessPermissions(
  harness: string,
  homeDir: string,
  mode: PublishMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessPermissions> {
  const surface = grantSurfaceFor(harness);
  if (surface.kind === 'absent') {
    return {
      harness,
      state: 'unsupported',
      rules: [],
      missing: [],
      detail: surface.why,
      ...(surface.operatorSteps.length > 0 ? { fix: surface.operatorSteps[0] } : {}),
    };
  }
  // Codex keeps its grant in its own grammar and its own file, so it gets its
  // own reader. Reporting it through the Claude allowlist reader is exactly
  // the conflation #342 is about.
  if (harness === 'codex') return await inspectCodexGrant(homeDir, mode, env);
  const found = await inspectAllowlist(homeDir, mode);
  if ('result' in found) {
    const refused = found.result;
    return {
      harness,
      state: 'unknown',
      ...(refused.path !== undefined ? { path: refused.path } : {}),
      rules: [],
      missing: [],
      detail: refused.warning ?? `${surface.path(homeDir)} could not be read.`,
      ...(refused.fix !== undefined ? { fix: refused.fix } : {}),
    };
  }
  const missing = [...found.added];
  return {
    harness,
    state: missing.length === 0 ? 'granted' : 'pending',
    path: found.path,
    rules: [...found.alreadyPresent],
    missing,
    detail:
      missing.length === 0
        ? `${found.alreadyPresent.length} rules in ${found.path}`
        : `${missing.length} of this mode's rules are missing from ${found.path}`,
    ...(missing.length === 0 ? {} : { fix: 'tenjin install' }),
  };
}

/**
 * Codex's grant, read back and then PUT TO CODEX.
 *
 * Two questions, and the second settles it: does the file say what this mode
 * calls for, and does the binary agree it grants that. A `.rules` file that
 * fails to parse is silent until a session runs, so a reader that stopped at
 * "the file matches" would report `granted` over a file Codex is discarding.
 * With no `codex` to ask, the file's answer stands and the detail says so.
 */
async function inspectCodexGrant(
  homeDir: string,
  mode: PublishMode,
  env: NodeJS.ProcessEnv,
): Promise<HarnessPermissions> {
  const path = codexRulesPath(homeDir, env);
  const writable = rulesForPublishMode(mode);
  const want = rulesFileBody(writable);
  const rules = grantedPrefixes(writable).map((tokens) => tokens.join(' '));
  const found = await readFile(path, 'utf8').catch(() => null);
  if (found !== want) {
    return {
      harness: 'codex',
      state: 'pending',
      path,
      rules: [],
      missing: rules,
      detail:
        found === null
          ? `no grant is installed at ${path}`
          : `${path} does not match what publish.mode ${mode} calls for`,
      fix: 'tenjin install',
    };
  }
  // One representative prefix, not all eleven: they come from one generated
  // body, so they parse or fail together, and a self-test that spawns eleven
  // processes on every `doctor` is a cost with no extra answer in it. The one
  // asked about is the consequential one — the mode-gated `publish` where the
  // mode carries it.
  const probe = grantedPrefixes(writable).at(-1);
  const agreed = probe === undefined ? null : await verifyPrefixAllowed(path, probe, env);
  if (agreed === false) {
    return {
      harness: 'codex',
      state: 'pending',
      path,
      rules: [],
      missing: rules,
      detail: `${path} is installed but Codex does not read it as granting \`${probe?.join(' ')}\``,
      fix: 'tenjin install',
    };
  }
  // GRANTED ONLY WHEN CODEX SAYS SO. A file that matches what the mode calls
  // for is not the same fact as a grant in force: on a Codex too old for the
  // rules layer, or with no `codex` on PATH at all, this file is inert and
  // reporting `granted` over it would be the same overclaim as the Claude
  // rules on a Codex machine (tenjin-agent#342). `unknown` says the write
  // landed and the question could not be put.
  if (agreed === null) {
    return {
      harness: 'codex',
      state: 'unknown',
      path,
      rules,
      missing: [],
      detail: `${rules.length} prefixes written to ${path}, but codex could not be asked whether it reads them as a grant`,
      fix: 'Check `codex execpolicy check --rules <file> tenjin publish x` on the machine itself.',
    };
  }
  return {
    harness: 'codex',
    state: 'granted',
    path,
    rules,
    missing: [],
    detail: `${rules.length} prefixes in ${path}, confirmed by codex execpolicy`,
  };
}

/** What one Codex grant write did. */
export interface CodexGrantResult {
  path: string;
  /** The prefixes now granted there, as space-joined command prefixes. */
  granted: string[];
  /** True when this run changed the file. */
  wrote: boolean;
  /** Present when nothing could be written; the file was left as found. */
  error?: string;
}

/**
 * Write Codex's grant for `mode`, whole.
 *
 * TAKES A MODE, NOT RULES, exactly as {@link wireFreeVerbAllowlist} does: the
 * two fixed constants are all either writer can produce, so no caller and no
 * future flag can widen one. lib/codex-rules.ts only spells the result.
 *
 * Idempotent by construction, the body being a pure function of the mode. And
 * `review` regenerates it WITHOUT the mode-gated pair, which IS the retraction
 * — no separate remove path to forget, because narrowing and widening are one
 * operation.
 */
export async function wireCodexGrant(
  homeDir: string,
  mode: PublishMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexGrantResult> {
  const path = codexRulesPath(homeDir, env);
  const rules = rulesForPublishMode(mode);
  const body = rulesFileBody(rules);
  const granted = grantedPrefixes(rules).map((t) => t.join(' '));
  try {
    await mkdir(dirname(path), { recursive: true });
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === body) return { path, granted, wrote: false };
    // 0600 for the same reason the hooks file gets it: this is a standing
    // decision about which commands run without asking, and a file another
    // account can append to is a file that can widen it.
    await writeFileAtomic(path, body, { mode: 0o600 });
    return { path, granted, wrote: true };
  } catch (err) {
    return {
      path,
      granted: [],
      wrote: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The exact rules install may add. Free verbs only: none of them can spend
 * USDC, though `read` and `doctor` do open the keystore. See lib/permissions.ts
 * for the per-verb notes and for the flag caveat that qualifies every prefix
 * rule.
 */
export const FREE_VERB_RULES: readonly string[] = [
  'Bash(tenjin search:*)',
  'Bash(tenjin wallet fund:*)',
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
 * The other half of the mode-gated pair. `edit` runs the SAME publish.mode
 * consent gate in the CLI (lib/consent.ts's needsConfirmation), touches only
 * posts this wallet already owns, spends nothing, and creates no new public
 * content — strictly narrower than the publish rule it travels with. A mode that
 * can publish a new post unattended but cannot fix that post's price is the
 * asymmetry the mode exists to remove.
 */
export const EDIT_MODE_RULE = 'Bash(tenjin edit:*)';

/** The pair the publish modes carry, in the order they are written and reported. */
export const MODE_GATED_RULES: readonly string[] = [PUBLISH_MODE_RULE, EDIT_MODE_RULE];

/**
 * Verb fragments that must never appear in {@link MODE_GATED_RULES}: the rail
 * {@link FORBIDDEN_VERB_FRAGMENTS} gives the free tier, minus the two verbs this
 * set exists to carry.
 *
 * It needs that rail more than the free tier does. This set was mode-conditional
 * prose before and is WRITTEN BY DEFAULT on every install now, so a line added
 * here ships a grant to every machine — and without this, adding
 * `Bash(tenjin buy:*)` to the pair passes the entire suite, because every other
 * assertion on it compares against PUBLISH_MODE_ALLOWLIST, a document editable in
 * the same commit.
 */
export const MODE_GATED_FORBIDDEN_FRAGMENTS: readonly string[] = [
  'tenjin buy',
  'tenjin wallet send',
  // The mode carries publish and edit and stops there. `delete` destroys what
  // those two put up, and consent to publish is not consent to destroy.
  'tenjin delete',
  'tenjin config set',
  'tenjin wallet create',
  'tenjin mcp',
  'tenjin install',
  'tenjin update',
];

/**
 * Exactly what may be written for `mode`. The two return values are the only two
 * rule sets this module can produce.
 */
export function rulesForPublishMode(mode: PublishMode): readonly string[] {
  return mode === 'review' ? FREE_VERB_RULES : [...FREE_VERB_RULES, ...MODE_GATED_RULES];
}

/**
 * What this run should sweep out: what an older version wrote, plus the publish
 * rule when the mode no longer justifies it. A retraction is always a rule this
 * CLI wrote under a setting the operator has since changed, and it is reported
 * exactly like an addition.
 */
function retiredFor(mode: PublishMode): Set<string> {
  const retired = new Set<string>(LEGACY_ALLOWLIST_RULES);
  if (mode === 'review') for (const rule of MODE_GATED_RULES) retired.add(rule);
  return retired;
}

/**
 * Rules a PRIOR version of this writer put in `permissions.allow` and this one
 * no longer writes — FREE TIER OR MODE-GATED, which is why this is not
 * `LEGACY_FREE_VERB_RULES` any more. Nothing is stranded today, but the day a
 * mode-gated rule is renamed or dropped, every machine holding it would keep a
 * publish-capable allow-line that no `install` and no `uninstall` reclaims. That
 * is one layer above the bug this list was created to fix, so the list covers
 * both layers. BOTH paths read it: `install` removes them on its next
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
export const LEGACY_ALLOWLIST_RULES: readonly string[] = [
  'Bash(tenjin candidate list:*)',
  'Bash(tenjin fund:*)',
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
  'tenjin delete',
  'tenjin wallet send',
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
  /**
   * The harness has no supported surface for a persistent, command-scoped
   * grant, so there is nothing to write and no operator step that would make
   * one appear. NOT `harness-not-claude`, which is what this was called: that
   * name describes our implementation rather than the harness, and it let
   * every reader downstream assume a Claude-shaped grant was in force anyway
   * (tenjin-agent#342). See {@link GRANT_SURFACE}.
   */
  | 'harness-unsupported'
  /**
   * The harness DOES have a grant, in a file this writer does not own, and it
   * is reported on its own row. Distinct from `harness-unsupported` (no grant
   * anywhere): conflating them told a Codex operator their permissions were
   * "not wired" on the run that wired them (tenjin-agent#342).
   */
  | 'harness-elsewhere'
  | 'not-requested'
  | 'declined'
  | 'dry-run'
  | 'unresolvable'
  | 'unreadable'
  | 'unparsable'
  | 'unexpected-shape'
  | 'changed-since-read';

/**
 * The mode-gated half of a write, as DATA rather than as prose a caller
 * re-derives.
 *
 * Every surface that reports the grant reads this one object: the walkthrough's
 * disclosure line, the `--json` envelope on the headless path (where nobody was
 * asked and the output is the only disclosure there is), and the tests. The
 * earlier shape returned one undifferentiated `added`, so each surface split the
 * tiers itself — and two of them counted `publish` and `edit` as free verbs while
 * a third never rendered at all.
 */
export interface ModeGrant {
  /** The mode-gated rules now in effect on this machine. */
  rules: string[];
  /**
   * Written by THIS run, already there, or one of each. On a `--dry-run` plan it
   * is what a real run WOULD produce, and {@link PermissionsResult.planned} is the
   * field that says so; the `disclosure` sentence changes tense to match.
   */
  state: 'added' | 'already-present' | 'mixed';
  /** The plain sentence naming what the grant allows; the walkthrough colorizes it. */
  disclosure: string;
  /** Every command that takes it back, in the order the walkthrough prints them. */
  undo: string[];
}

/** The three undos, named wherever a mode-gated grant is reported. */
export const MODE_GRANT_UNDO: readonly string[] = [
  'tenjin install --publish-mode review',
  'tenjin config set publish.mode review',
  'tenjin uninstall',
];

/**
 * Build the grant record for `mode`, or undefined when the mode carries no rules
 * or none of them ended up on this machine.
 */
function modeGrantFor(
  mode: PublishMode,
  added: readonly string[],
  present: readonly string[],
  planned: boolean,
): ModeGrant | undefined {
  const wasAdded = MODE_GATED_RULES.filter((r) => added.includes(r));
  const wasPresent = MODE_GATED_RULES.filter((r) => present.includes(r));
  const rules = [...wasAdded, ...wasPresent];
  if (rules.length === 0) return undefined;
  const state =
    wasAdded.length === 0 ? 'already-present' : wasPresent.length === 0 ? 'added' : 'mixed';
  // A plan says "would be added". The `planned` flag alone left this sentence in
  // the past tense, and it is the one string a reader quotes back.
  const verb =
    state === 'already-present'
      ? 'already present'
      : state === 'mixed'
        ? planned
          ? 'would be in place'
          : 'in place'
        : planned
          ? 'would be added'
          : 'added';
  return {
    rules: MODE_GATED_RULES.filter((r) => rules.includes(r)),
    state,
    disclosure: `${MODE_GATED_RULES.join(' and ')} ${verb}: on publish.mode ${mode} your agent can publish to the public marketplace under your identity, update its own posts, and open your wallet keystore to sign, without a harness prompt.`,
    undo: [...MODE_GRANT_UNDO],
  };
}

export interface PermissionsResult {
  /** The harness this outcome is about; only `claude` has a settings file we write. */
  harness: string;
  /**
   * The settings file, reported even when nothing was written so a human can go
   * look. ABSENT when the harness has no such file: naming a Claude path on a
   * Codex-only install would point the envelope's reader at a file that has
   * nothing to do with their harness.
   *
   * ONE EXCEPTION, in `install`'s `withRetraction`: a `review` run retracts from
   * `~/.claude/settings.json` above the harness guard, so a non-Claude result
   * carrying a non-empty `removed` carries that path too. The reason the general
   * rule exists is inverted there, because the run did change that file and the
   * operator cannot check which one without its name.
   */
  path?: string;
  added: string[];
  alreadyPresent: string[];
  /**
   * The FREE-TIER halves of the two lists above. Every count line reads these:
   * `publish` and `edit` are not free verbs, and a line calling eleven rules
   * "free tenjin commands" contradicts both this module and the `doctor` pointer
   * printed on the next screen.
   */
  /**
   * True when this result is a PLAN rather than a record: `--dry-run` fills
   * `added`, `alreadyPresent` and `modeGrant` with what a real run would do and
   * writes nothing. Every reader that treats a non-empty `added` as "this landed"
   * has to check it, which is the point of a flag rather than a parallel shape.
   */
  planned?: boolean;
  addedFree: string[];
  alreadyPresentFree: string[];
  /** The mode-gated half, or absent when this write carried none. */
  modeGrant?: ModeGrant;
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
 *
 * `harness-unsupported` is the exception that proves it: no command turns it
 * into a write, so its `fix` says what the harness itself does instead. Naming
 * `tenjin doctor` there, as this used to, sent an operator to a page of Claude
 * rules and let them read those as their own (tenjin-agent#342).
 */
function fixFor(reason: PermissionsSkipReason, harness = 'claude'): string {
  switch (reason) {
    case 'harness-unsupported': {
      const surface = grantSurfaceFor(harness);
      return surface.kind === 'absent' && surface.operatorSteps.length > 0
        ? (surface.operatorSteps[0] as string)
        : `No permission rules were written: ${harness} has no surface for them.`;
    }
    case 'harness-elsewhere': {
      const surface = grantSurfaceFor(harness);
      const where = surface.kind === 'writable' ? ` See ${surface.path('~')}.` : '';
      return `These rules are Claude Code's; ${harness} keeps its own grant elsewhere.${where}`;
    }
    case 'not-requested':
    case 'declined':
    case 'dry-run':
      return 'Add them with `tenjin install`.';
    case 'changed-since-read':
      return 'Another process changed the file mid-run; re-run `tenjin install`.';
    default:
      return 'Fix the reported file, then run `tenjin install`.';
  }
}

/**
 * The tier split plus the grant record, derived once from the two rule lists so
 * no caller re-derives it. Spread into every non-skipped result.
 */
function tiers(
  added: readonly string[],
  alreadyPresent: readonly string[],
  mode: PublishMode,
  planned = false,
): Pick<PermissionsResult, 'addedFree' | 'alreadyPresentFree'> & { modeGrant?: ModeGrant } {
  const gated = new Set<string>(MODE_GATED_RULES);
  const grant = modeGrantFor(mode, added, alreadyPresent, planned);
  return {
    addedFree: added.filter((r) => !gated.has(r)),
    alreadyPresentFree: alreadyPresent.filter((r) => !gated.has(r)),
    ...(grant !== undefined ? { modeGrant: grant } : {}),
  };
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
    addedFree: [],
    alreadyPresentFree: [],
    skipped: reason,
    ...(warning !== undefined ? { warning } : {}),
    fix: fixFor(reason, harness),
  };
}

/** A decision NOT to write, shaped like a write outcome so the caller has one type. */
export function permissionsSkipped(
  harness: string,
  homeDir: string,
  reason: PermissionsSkipReason,
): PermissionsResult {
  // A PermissionsResult is THIS writer's receipt, so its `path` is this
  // writer's file or nothing. Naming ~/.claude/settings.json to a Codex
  // operator points them at a file that is nothing to do with their harness;
  // naming Codex's rules file here would be worse, because the sentence around
  // it is about rules that never went there (tenjin-agent#342).
  const path = usesGrantWriter(harness, 'claude-settings')
    ? claudeSettingsPath(homeDir)
    : undefined;
  return skip(harness, path, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Write settings.json KEEPING THE MODE IT HAS. Operators `chmod 600` this file —
 * it commonly holds an `env` block and `apiKeyHelper` — and handing it back
 * world-readable because we appended a permission line is a downgrade nobody
 * asked for. A file we are creating gets the platform default. Mirrors
 * lib/skill-writer.ts, which already does this for skills.
 */
async function writeSettings(path: string, next: Record<string, unknown>): Promise<void> {
  const current = await stat(path).catch(() => null);
  await writeFileAtomic(
    path,
    `${JSON.stringify(next, null, 2)}\n`,
    current === null ? {} : { mode: current.mode & 0o777 },
  );
}

/**
 * Remove {@link MODE_GATED_RULES}, and nothing else, from `permissions.allow`.
 *
 * SEPARATE FROM THE ADDITIVE WRITER, and that separation is the point. Retraction
 * used to ride the same call that appends the free tier, so it inherited that
 * call's precondition and bailed out whenever the free tier was not byte-exact —
 * silently, in the tightening direction, on two of the three commands the consent
 * decision names as its own undo. The stated rationale (a publish rule without
 * the free tier beside it was not written by our install) does not survive the
 * ordinary case: the first release that adds a tenth free verb makes every
 * existing machine's tier incomplete while the pair is genuinely ours, and an
 * unparsable file is UNKNOWN rather than not-ours.
 *
 * So `review` always retracts. This adds nothing, ever: it can only shorten the
 * allow list, which is why it needs no consent and no complete-tier precondition.
 */
export async function retractModeGatedRules(homeDir: string): Promise<PermissionsResult> {
  const found = await inspectAllowlist(homeDir, 'review');
  if ('result' in found) {
    // Unknown, not absent. The one case that cannot proceed says so, names the
    // rules and the file, and hands over the command that always works.
    const refused = found.result;
    return {
      ...refused,
      fix: `${refused.path ?? claudeSettingsPath(homeDir)} could not be read, so ${MODE_GATED_RULES.join(' and ')} may still be allowed there. Remove those lines by hand, or run \`tenjin uninstall\`.`,
    };
  }
  const { path, raw, settings, permissions, allow } = found;
  const gated = new Set<string>(MODE_GATED_RULES);
  const removed = allow.filter((r): r is string => typeof r === 'string' && gated.has(r));
  if (removed.length === 0) {
    return {
      harness: 'claude',
      path,
      added: [],
      alreadyPresent: [],
      addedFree: [],
      alreadyPresentFree: [],
      removed: [],
    };
  }
  const kept = allow.filter((r) => !(typeof r === 'string' && gated.has(r)));
  const next = { ...settings, permissions: { ...permissions, allow: kept } };
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== raw) {
    return skip(
      'claude',
      path,
      'changed-since-read',
      `${path} changed while it was being updated, so nothing was written. Re-run to retract ${MODE_GATED_RULES.join(' and ')}.`,
    );
  }
  await writeSettings(path, next);
  return {
    harness: 'claude',
    path,
    added: [],
    alreadyPresent: [],
    addedFree: [],
    alreadyPresentFree: [],
    removed,
  };
}

/**
 * Add the rules `mode` calls for to `permissions.allow` in
 * ~/.claude/settings.json. Creates the file (and the `permissions.allow` path)
 * when absent, appends only the rules that are missing, and rewrites nothing
 * else. Idempotent: a second run at the same mode returns `added: []` with every
 * rule under `alreadyPresent` and does not touch the file at all.
 */
/**
 * What {@link wireFreeVerbAllowlist} WOULD do, without doing it.
 *
 * `--dry-run` used to report the allowlist as a bare `dry-run` skip with an empty
 * `added` and no `modeGrant`, so an operator dry-running precisely to learn
 * whether `publish` and `edit` would be granted learned nothing. It reads through
 * the same `inspectAllowlist` the writer does and fills the same fields, marked
 * `planned` so nothing mistakes a plan for a record.
 */
export async function planFreeVerbAllowlist(
  homeDir: string,
  mode: PublishMode = 'review',
): Promise<PermissionsResult> {
  const found = await inspectAllowlist(homeDir, mode);
  // Unreadable, unparsable, wrong shape: a real run could not write either, and
  // the reason it gives is the honest plan.
  if ('result' in found) return { ...found.result, planned: true };
  const retired = retiredFor(mode);
  const wouldRemove = found.allow.filter(
    (r): r is string => typeof r === 'string' && retired.has(r),
  );
  return {
    harness: 'claude',
    path: found.path,
    planned: true,
    skipped: 'dry-run',
    fix: fixFor('dry-run'),
    added: [...found.added],
    alreadyPresent: [...found.alreadyPresent],
    ...tiers(found.added, found.alreadyPresent, mode, true),
    removed: wouldRemove,
  };
}

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
    return {
      harness: 'claude',
      path,
      added: [],
      alreadyPresent,
      ...tiers([], alreadyPresent, mode),
      removed: [],
    };
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
  await writeSettings(path, next);
  return {
    harness: 'claude',
    path,
    added,
    alreadyPresent,
    ...tiers(added, alreadyPresent, mode),
    removed,
  };
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
      ...tiers([], found.alreadyPresent, mode),
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

/**
 * The recommended HARNESS permission allowlist: the exact rule lines an operator
 * pastes into Claude Code (or an equivalent harness) so auto mode stops denying
 * the free Tenjin verbs, and so the one paying verb is cleared deliberately
 * rather than by accident.
 *
 * This is a HARNESS-side allowlist (which shell commands the agent may run at
 * all). It is NOT the CLI's spend policy and shares nothing with it: the shipped
 * `allowlistCreators` config key gates WHO you may pay, this file gates WHICH
 * COMMANDS the harness will run without a prompt. The two are deliberately kept
 * apart in name and in code — clearing `Bash(tenjin buy:*)` here never raises a
 * spend cap, and `maxAutoSpend`/`sessionBudget`/`confirm` still apply to every
 * purchase (see lib/policy.ts).
 *
 * These are static, shipped constants on purpose: there is NO config key for
 * them. An operator-editable "which commands may run" list stored next to the
 * spend policy would be a second, weaker copy of a control the harness already
 * owns, and a CLI that could widen its own permission grant is exactly the shape
 * this file exists to avoid.
 *
 * Scope: `tenjin mcp` exposes the same command cores over MCP, where the harness
 * gates TOOLS, not Bash lines. These rules say nothing about that surface, which
 * is why `tenjin mcp` is itself never recommended here: clearing it would route
 * around every rule below.
 */

/** One pasteable allowlist rule plus why it is safe (or what it costs). */
export interface AllowlistEntry {
  /** The exact line to add to the harness permission allowlist. */
  rule: string;
  /** The verb it clears. */
  command: string;
  /** Why it is safe to pre-clear, or what the operator is opting into. */
  note: string;
}

/** A verb deliberately kept OUT of the recommended allowlist, and why. */
export interface ExcludedVerb {
  command: string;
  reason: string;
}

/**
 * Free, read-only verbs. None of them touches the wallet, signs anything, or
 * moves money; `lookup` is anonymous, `inspect` reads the pre-purchase card
 * without paying, `outcome` posts a report. Pre-clearing these is what makes the
 * marketplace loop usable under auto mode.
 *
 * Rules are PREFIX rules: `Bash(tenjin lookup:*)` clears commands that start with
 * `tenjin lookup` and nothing else. The narrow `wallet show` / `wallet balance` /
 * `config get` / `candidate list` forms are deliberate: a `Bash(tenjin wallet:*)`
 * or `Bash(tenjin config:*)` rule would silently swallow `wallet create` and
 * `config set`, and `config set` can raise the spend caps.
 */
export const ALWAYS_SAFE_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    rule: 'Bash(tenjin lookup:*)',
    command: 'tenjin lookup',
    note: 'Free anonymous marketplace search. No wallet, no signing, no payment.',
  },
  {
    rule: 'Bash(tenjin inspect:*)',
    command: 'tenjin inspect',
    note: 'Free pre-purchase card and preview. Never signs, never pays, never saves.',
  },
  {
    rule: 'Bash(tenjin outcome:*)',
    command: 'tenjin outcome',
    note: 'Free honest outcome report on a past lookup. No wallet, no payment.',
  },
  {
    rule: 'Bash(tenjin doctor:*)',
    command: 'tenjin doctor',
    note: 'Read-only local environment and API reachability diagnostics.',
  },
  {
    rule: 'Bash(tenjin wallet show:*)',
    command: 'tenjin wallet show',
    note: 'Prints the wallet address and key source. Never prints the key.',
  },
  {
    rule: 'Bash(tenjin wallet balance:*)',
    command: 'tenjin wallet balance',
    note: 'Read-only USDC balance query on Base.',
  },
  {
    rule: 'Bash(tenjin config get:*)',
    command: 'tenjin config get',
    note: 'Reads one effective config value. `config set` is excluded on purpose.',
  },
  {
    rule: 'Bash(tenjin candidate list:*)',
    command: 'tenjin candidate list',
    note: 'Lists local parked drafts. Candidates are local files; nothing uploads.',
  },
];

/**
 * The one paying verb, offered as an EXPLICIT opt-in line rather than shipped in
 * the safe set. Clearing it removes the harness prompt only; the CLI's own spend
 * gates are untouched and still refuse by default (`maxAutoSpend` defaults to 0,
 * `confirm` defaults to `always`).
 */
export const OPT_IN_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    rule: 'Bash(tenjin buy:*)',
    command: 'tenjin buy',
    note:
      'SPENDS USDC on Base, unrefundably. Opt in only with a cap set first: ' +
      '`tenjin config set maxAutoSpend <usd>` and `tenjin config set sessionBudget <usd>`. ' +
      'This line clears the harness prompt; it never raises a spend cap, and ' +
      '`confirm always` (the default) still puts a human on every purchase.',
  },
];

/**
 * Verbs that must NEVER appear in the recommended allowlist, with the reason each
 * one is a human decision. `tenjin send` is the wallet escape hatch (tenjin-agent
 * #40) and heads this list: it moves USDC to an arbitrary address, outside the
 * spend policy that bounds `buy`. Naming it here is load-bearing even in versions
 * where the verb does not exist yet — the exclusion ships before the verb does.
 */
export const NEVER_ALLOWLISTED: readonly ExcludedVerb[] = [
  {
    command: 'tenjin send',
    reason:
      'Moves USDC out of the wallet to an arbitrary address (the escape hatch, #40). ' +
      'Irreversible and not bounded by the buy spend policy. Always a human decision.',
  },
  {
    command: 'tenjin publish',
    reason: 'Puts your content on a public marketplace under your identity.',
  },
  {
    command: 'tenjin wallet create',
    reason: 'Creates the payment credential; a stray run is a wallet you did not mean to have.',
  },
  {
    command: 'tenjin config set',
    reason:
      'Can raise maxAutoSpend / sessionBudget / confirm, i.e. widen the agent’s own spend policy.',
  },
  {
    command: 'tenjin candidate add / tenjin candidate drop',
    reason: 'Writes or discards local drafts; `candidate list` is the read-only half.',
  },
  {
    command: 'tenjin install',
    reason: 'Writes into harness config and skills directories.',
  },
  {
    command: 'tenjin mcp',
    reason:
      'Long-running server that re-exposes every command core over stdio; ' +
      'clearing it would indirectly clear everything above.',
  },
];

/** The machine shape emitted by `tenjin doctor --json` and `tenjin install --json`. */
export interface RecommendedPermissions {
  alwaysSafe: AllowlistEntry[];
  optIn: AllowlistEntry[];
  neverAllowlisted: ExcludedVerb[];
}

export function recommendedPermissions(): RecommendedPermissions {
  return {
    alwaysSafe: ALWAYS_SAFE_ALLOWLIST.map((e) => ({ ...e })),
    optIn: OPT_IN_ALLOWLIST.map((e) => ({ ...e })),
    neverAllowlisted: NEVER_ALLOWLISTED.map((e) => ({ ...e })),
  };
}

/** Every rule this module recommends adding (safe + opt-in). */
export function recommendedRules(): string[] {
  return [...ALWAYS_SAFE_ALLOWLIST, ...OPT_IN_ALLOWLIST].map((e) => e.rule);
}

/**
 * The human block both `doctor` and `install` print. Plain lines; the caller
 * decides how (or whether) to paint them.
 */
export function renderPermissionsBlock(): string[] {
  const lines: string[] = [
    'Auto-mode permission allowlist (add these once, then agents stop being denied):',
  ];
  for (const e of ALWAYS_SAFE_ALLOWLIST) lines.push(`  ${e.rule}`);
  lines.push('  These are free, read-only verbs: no wallet, no signing, no payment.');
  lines.push('');
  lines.push('Opt in separately, only if you want unattended purchases:');
  for (const e of OPT_IN_ALLOWLIST) {
    lines.push(`  ${e.rule}`);
    lines.push(`    ${e.note}`);
  }
  lines.push('');
  lines.push('Never recommended (each one is a human decision):');
  for (const e of NEVER_ALLOWLISTED) lines.push(`  ${e.command} - ${e.reason}`);
  lines.push('');
  lines.push(
    'Claude Code: add the lines to the "permissions.allow" array in .claude/settings.json.',
  );
  return lines;
}

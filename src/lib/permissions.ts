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
 * spend cap. That is a claim about this file, NOT a claim that the spend policy
 * stops an allowlisted `buy`: `--yes` is an ordinary flag on an allowlisted verb
 * and `confirmSpend` returns true on it before any TTY check
 * (src/commands/buy.ts), so under CONFIG_DEFAULTS nothing denies. See
 * OPT_IN_ALLOWLIST's note for the walk-through.
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
 * around every rule below. MCP_CAVEAT names the tools to leave gated for an
 * operator who runs the server anyway.
 *
 * LIMIT OF A PREFIX RULE, read this before adding an entry: the rule constrains
 * the VERB and nothing else. `addGlobalFlags` (src/cli.ts) puts `--json`,
 * `--timeout`, and `--base-url` on every leaf command, so every rule below also
 * clears `--base-url <url>` in trailing position. `--base-url` is validated as a
 * URL and nothing more, and it wins settings precedence, so it re-points the
 * trust boundary itself: the `search` question goes to that host, `doctor` probes
 * it, and `assertOnBaseOrigin` only checks that a resource URL shares an origin
 * with the CONFIGURED base, so an attacker-controlled pair satisfies the pin. No
 * prefix syntax expresses "this verb but not that flag", so the mitigation is
 * disclosure rather than a narrower rule: FLAG_CAVEAT prints alongside the rules
 * on every surface, and the skills tell the agent never to pass `--base-url` on
 * an allowlisted verb. Pinning the paying path to a constant origin instead is
 * the real fix and is an x402/payments-semantics change, tracked separately.
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
 * FREE verbs: they CANNOT SPEND AND CANNOT OPEN THE KEYSTORE. That is the whole
 * definition of this tier, and it is deliberately narrower than the older "no
 * wallet, no signing, no payment" — which stopped being true the moment `read`
 * gained the ability to PRESENT a cached session key. `read` signs, with a P-256
 * delegation loaded from disk; it cannot mint one (that needs the wallet, and its
 * import graph is test-pinned clear of it) and cannot produce the
 * secp256k1/EIP-712 signature a payment authorization needs (wrong curve). Money
 * and key material stay out of reach; a signature as such no longer does, so the
 * tier says what it means.
 *
 * What the tier does NOT claim, because it is not true: that the read scope
 * limits what a leaked delegation is worth. Scope is enforced only on the request
 * shape that carries both a session signature and the delegation header; the same
 * delegation replayed as a plain `SIGN-IN-WITH-X` takes a different server path
 * where no scope logic runs. So a session file is a wallet-derived credential
 * with the authority of the wallet behind it, and the mitigations that actually
 * hold are the ones in this repo: it is 0600, short-lived (≤24h, server-clamped),
 * bound to the origin it was minted for, and never presented off that origin.
 * Treat "read is allowlisted" as "read may transmit that credential to the
 * configured origin", and see FLAG_CAVEAT for why the configured origin is not
 * automatically the one you configured.
 *
 * Not all of them are read-only, and the difference is disclosed rather than
 * papered over — `search` POSTs the (generalized, anonymous) question off-machine
 * and records it locally, `outcome` POSTs a report that moves the marketplace's
 * reuse signal (both unauthenticated remote writes), and `read` writes locally,
 * saving a delivered piece to the library. Pre-clearing them is defensible
 * because they cost nothing and cannot reach the key; calling them read-only to
 * justify it would not be.
 *
 * Rules are PREFIX rules: `Bash(tenjin search:*)` clears commands that start with
 * `tenjin search` and nothing else. The narrow `wallet show` / `wallet balance` /
 * `config get` / `candidate list` forms are deliberate: a `Bash(tenjin wallet:*)`
 * or `Bash(tenjin config:*)` rule would silently swallow `wallet create` and
 * `config set`, and `config set` can raise the spend caps.
 *
 * Two known gaps, both fail-closed (denied, never wrongly allowed):
 *  - Bare `tenjin config` (runConfigList) is as read-only as `config get`, but no
 *    prefix rule reaches it without also covering `config set`, so it stays out.
 *    Use `tenjin config get <key>`, which is a different supported command rather
 *    than a reworded one.
 *  - Group-level flag forms like `tenjin wallet --json show` are not covered.
 *    Put global flags AFTER the leaf verb (`tenjin wallet show --json`); the
 *    CLI parses either, and only the trailing form matches these rules.
 */
export const ALWAYS_SAFE_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    rule: 'Bash(tenjin search:*)',
    command: 'tenjin search',
    note:
      'Free anonymous marketplace search. No wallet, no signing, no payment. ' +
      'Not read-only: it POSTs the generalized question off-machine and records ' +
      'the search locally.',
  },
  {
    rule: 'Bash(tenjin inspect:*)',
    command: 'tenjin inspect',
    note: 'Free pre-purchase card and preview. Never signs, never pays, never saves.',
  },
  {
    rule: 'Bash(tenjin read:*)',
    command: 'tenjin read',
    note:
      'Free-only delivery: free pieces, local-library re-reads, and pieces this ' +
      'wallet already owns when a read-scoped session key is cached. Cannot spend ' +
      'and cannot open the keystore — the wallet, payment, and session-MINTING ' +
      'modules are all absent from its import graph, so the key it may present is ' +
      'a P-256 delegation loaded from disk, which is the wrong curve to authorize ' +
      'a payment. TRANSMITS A CREDENTIAL: when a session key exists, a cold 402 ' +
      'sends that wallet-derived delegation to the server. It goes only to the ' +
      'origin the delegation was minted for, which is what stops a stray ' +
      '`--base-url` from redirecting it, and no scope on it limits what a holder ' +
      'could do with it. Not read-only: a freshly delivered piece is saved to the ' +
      'library.',
  },
  {
    rule: 'Bash(tenjin outcome:*)',
    command: 'tenjin outcome',
    note:
      'Free honest outcome report on a past search. No wallet, no payment. ' +
      'Not read-only: it POSTs a report that moves the marketplace reuse signal.',
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
    note:
      'Reads one effective config value. `config set` is excluded on purpose. ' +
      'Note `config get rpcUrl` returns your RPC URL, which commonly embeds a ' +
      'provider API key: no wallet secret, but a credential-adjacent read.',
  },
  {
    rule: 'Bash(tenjin candidate list:*)',
    command: 'tenjin candidate list',
    note: 'Lists local parked drafts. Candidates are local files; nothing uploads.',
  },
];

/**
 * The verbs offered as EXPLICIT opt-in lines rather than shipped in the safe set:
 * the one that spends, and the one that opens the keystore.
 *
 * Read the buy note carefully before pasting the line: on the DEFAULT config this
 * rule authorizes unattended spending up to the wallet balance. Walking
 * evaluateSpendPolicy (lib/policy.ts) against CONFIG_DEFAULTS with an agent that
 * passes `--yes` (which this repo's own skill snippet offers):
 *   - `maxPriceAtomic` is unset unless the agent chooses to pass `--max-price`;
 *   - `allowlistCreators` is empty, so the creator gate is off;
 *   - `sessionBudget` is '0', which `if (policy.sessionBudgetAtomic > 0n)` reads
 *     as DISABLED, not as a zero ceiling;
 *   - `maxAutoSpend` '0' and `confirm` 'always' both land on `confirm`, and
 *     `confirmSpend` returns true on `--yes` before any TTY check.
 * Nothing denies. Note the asymmetry that makes the pair read safer than it is:
 * `maxAutoSpend: '0'` means "auto-approve nothing" while `sessionBudget: '0'`
 * means "no ceiling at all".
 */
export const OPT_IN_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    rule: 'Bash(tenjin buy:*)',
    command: 'tenjin buy',
    note:
      'SPENDS USDC on Base, unrefundably. This authorizes UNATTENDED purchases: ' +
      '`--yes` is an ordinary flag on the same allowlisted verb and it clears the ' +
      'confirm gate, so on the default config nothing stops a spend up to your ' +
      'wallet balance. Set a real ceiling first with ' +
      '`tenjin config set maxAutoSpend <usd>` and ' +
      '`tenjin config set sessionBudget <usd>` (sessionBudget 0 means NO ceiling, ' +
      'not a zero one). This line never raises a spend cap by itself, but do not ' +
      'read that as a human being on every purchase. Fund small.',
  },
  {
    rule: 'Bash(tenjin session start:*)',
    command: 'tenjin session start',
    note:
      'OPENS THE KEYSTORE (one wallet signature), but SPENDS NOTHING and cannot: ' +
      'it mints a ≤24h P-256 session key so `tenjin read` can recover pieces you ' +
      'already own without paying. The delegated key is the wrong curve for a ' +
      'payment authorization, so no session file can ever move money. Do NOT read ' +
      'the `read` scope as a bound on the rest: the file it leaves is a ' +
      'wallet-derived credential, and what limits it is that it expires in 24h, ' +
      'lives 0600, and is refused off the origin it was minted for — not its ' +
      'scope. What you are opting into is unattended keystore access: on an ' +
      'encrypted wallet the passphrase prompt is skipped or answered from the ' +
      'environment, and the `--base-url` caveat below bites hardest here, because ' +
      'a mint against an attacker-chosen host is a wallet signature you did not ' +
      'intend to make.',
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
    command: 'tenjin edit',
    reason:
      'Write-capable despite the no-flag form reading as a pure show: it edits live posts ' +
      'and answer cards under your identity, and moves prices. A prefix rule pins the verb, ' +
      'not the flags, so no rule can clear the read half without clearing the write half.',
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

/**
 * The flag-surface caveat. A prefix rule pins the verb, never the flags, and the
 * flag that matters is `--base-url`: it is accepted on every leaf, validated only
 * as a URL, and it wins settings precedence, so it moves the destination of every
 * allowlisted verb. Printed with the rules everywhere they are printed, because
 * an operator who only reads the verb list would never learn it.
 */
export const FLAG_CAVEAT: readonly string[] = [
  'Caveat: a prefix rule pins the VERB, not the flags. Every line above also clears',
  '`--base-url <url>` on that verb, which re-points where the question, the probe, the',
  'session key `read` may present, and (for buy) the signature and payment go. Signed',
  'and credential-bearing traffic is NOT confined to the paying verb: `read` is in the',
  'safe tier and still transmits a wallet-derived delegation once one is cached, which is',
  'why that delegation is bound to the origin it was minted for and refused elsewhere.',
  'Allowlist these verbs only if you are content for the agent to choose the destination',
  'host, and set the base URL in config instead of letting it be an argument. The skills',
  'tell agents never to pass --base-url on an allowlisted verb, but that is a convention,',
  'not an enforced boundary.',
];

/**
 * The delegation summary. One line, mirroring the tenjin-search skill's
 * "Delegating Tenjin work" block, because the operator reading this block is the
 * one deciding what a subagent may be handed. `outcome` is in the safe TIER but
 * not in the delegation set: it reports on the parent's search, so a subagent
 * running it moves the marketplace signal on a decision it did not make.
 */
export const DELEGATION_SUMMARY: readonly string[] = [
  'Delegating to a read-only subagent? search, inspect, read, doctor, config get, wallet show,',
  'wallet balance and candidate list are the safe set (outcome stays with whoever ran the search);',
  'publish, edit, buy, send, candidate add/drop, session start, wallet create, config set and',
  'install stay in a mutation-capable, human-gated context.',
];

/**
 * The MCP caveat. `tenjin mcp` is never recommended as a Bash rule, but an
 * operator who registers the server anyway is on a different permission surface
 * (tools, not command strings) where three excluded verbs come back.
 */
export const MCP_CAVEAT: readonly string[] = [
  'Running the local MCP server (`tenjin mcp`) instead? That is a different permission',
  'surface: the harness gates TOOLS there, and these Bash rules do not apply. Leave',
  '`mcp__tenjin__tenjin_publish`, `mcp__tenjin__tenjin_edit`, and',
  '`mcp__tenjin__tenjin_wallet` gated, and treat `mcp__tenjin__tenjin_candidate` as gated',
  'for its add/drop actions. `tenjin_buy` is the same opt-in decision as the buy line above.',
];

/** The machine shape emitted by `tenjin doctor --json` and `tenjin install --json`. */
export interface RecommendedPermissions {
  alwaysSafe: AllowlistEntry[];
  optIn: AllowlistEntry[];
  neverAllowlisted: ExcludedVerb[];
  /** Caveats that qualify the rules above; never omit them when rendering. */
  caveats: { flags: string[]; mcp: string[] };
}

export function recommendedPermissions(): RecommendedPermissions {
  return {
    alwaysSafe: ALWAYS_SAFE_ALLOWLIST.map((e) => ({ ...e })),
    optIn: OPT_IN_ALLOWLIST.map((e) => ({ ...e })),
    neverAllowlisted: NEVER_ALLOWLISTED.map((e) => ({ ...e })),
    caveats: { flags: [...FLAG_CAVEAT], mcp: [...MCP_CAVEAT] },
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
  lines.push('  Free: cannot spend and cannot open the keystore. Not all read-only, though:');
  lines.push('  `search` and `outcome` POST to the marketplace (a question, a report),');
  lines.push('  and `read` saves a delivered piece to your local library. `read` may also');
  lines.push('  PRESENT a cached session key — a wallet-derived credential — to the origin it');
  lines.push('  was minted for. It cannot mint one and cannot sign a payment with it (wrong');
  lines.push('  curve), but treat the file itself as sensitive: its scope is not a bound.');
  lines.push('');
  lines.push(...DELEGATION_SUMMARY.map((l) => `  ${l}`));
  lines.push('');
  lines.push(...FLAG_CAVEAT.map((l) => `  ${l}`));
  lines.push('');
  lines.push('Opt in separately (unattended purchases; unattended keystore access):');
  for (const e of OPT_IN_ALLOWLIST) {
    lines.push(`  ${e.rule}`);
    lines.push(`    ${e.note}`);
  }
  lines.push('');
  lines.push('Never recommended (each one is a human decision):');
  for (const e of NEVER_ALLOWLISTED) lines.push(`  ${e.command} - ${e.reason}`);
  lines.push('');
  lines.push(...MCP_CAVEAT.map((l) => `  ${l}`));
  lines.push('');
  lines.push(
    'Claude Code: add the lines to the "permissions.allow" array in .claude/settings.json.',
  );
  return lines;
}

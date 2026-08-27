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
 * disclosure rather than a narrower rule: FLAG_CAVEAT rides the `--json` payload
 * and docs/agent-permissions.md, every human surface points at that page, and the
 * skills tell the agent never to pass `--base-url` on an allowlisted verb. Pinning
 * the paying path to a constant origin instead is the real fix and is an
 * x402/payments-semantics change, tracked separately.
 */

import type { PublishMode } from './config';

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
 * FREE verbs: they CANNOT SPEND AND CANNOT MOVE YOUR KEYS. That is the whole
 * definition of this tier, and it is deliberately narrower than the older "no
 * wallet, no signing, no payment" — which stopped being true the moment `read`
 * gained the ability to PRESENT a cached session key. `read` signs, with a P-256
 * delegation loaded from disk; it cannot mint one (that needs the wallet, and its
 * import graph is test-pinned clear of it) and cannot produce the
 * secp256k1/EIP-712 signature a payment authorization needs (wrong curve). Money
 * stays out of reach; a signature as such no longer does, so the tier says what
 * it means. `doctor` decrypts locally to check the wallet still opens.
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
 * saving a delivered piece to the library, and `doctor` decrypts the keystore
 * locally to check it opens. Pre-clearing them is defensible because they cost
 * nothing and none of it leaves the machine; calling them read-only to justify it
 * would not be.
 *
 * Rules are PREFIX rules: `Bash(tenjin search:*)` clears commands that start with
 * `tenjin search` and nothing else. The narrow `wallet show` / `wallet balance` /
 * The `config get` form is deliberate: a `Bash(tenjin wallet:*)`
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
    rule: 'Bash(tenjin wallet fund:*)',
    command: 'tenjin wallet fund',
    note:
      'Owner call (2026-08-12): free on both surfaces, because the command just opens the ' +
      'fund modal. Minting moves no money: the destination is server-pinned to the wallet ' +
      'that signed, the CLI refuses any checkout host but pay.coinbase.com, and payment ' +
      'happens behind Coinbase\u2019s own human gate. The usual --base-url caveat does not ' +
      'apply: fund is pinned to the production origin and takes no override from flag, ' +
      'env, or config.',
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
      'and cannot open the keystore: the wallet, payment, and session-MINTING ' +
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
    note:
      'Local environment and API reachability diagnostics. Decrypts the wallet ' +
      'locally to check it still opens; signs nothing and sends nothing.',
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
    rule: 'Bash(tenjin pay:*)',
    command: 'tenjin pay',
    note:
      'SPENDS USDC on Base, unrefundably, at ANY x402 endpoint the origin gate ' +
      'allows: the configured base URL always, and with `bazaarPay` on, ' +
      'registry-listed foreign sellers too. The same spend policy and `--yes` ' +
      'caveat as the buy line apply, and unlike `buy` there is no library ' +
      'dedupe: a looping agent pays on every call. Set maxAutoSpend and ' +
      'sessionBudget first, and leave `bazaarPay` off unless you mean it.',
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
      'lives 0600, and is refused off the origin it was minted for, not its ' +
      'scope. What you are opting into is unattended keystore access: on an ' +
      'encrypted wallet the passphrase prompt is skipped or answered from the ' +
      'environment, and the `--base-url` caveat below bites hardest here, because ' +
      'a mint against an attacker-chosen host is a wallet signature you did not ' +
      'intend to make.',
  },
];

/**
 * The one rule that is neither always-safe nor a standing opt-in: it exists only
 * while `publish.mode` is `auto` or `full-auto`.
 *
 * The mode IS the consent. An operator who set auto has already said a clean
 * publish should proceed without asking; leaving the harness prompt in front of
 * it asks the same question a second time, in a place the mode cannot answer,
 * and the agent that hits it does the only safe thing and stops. That was the
 * observed failure: a session ran `tenjin config get publish.mode` mid-publish to
 * discover it had permission it had already been given (#161).
 *
 * NOT part of {@link recommendedRules}, and not a tier an operator picks from.
 * There is no line to paste and no flag that adds it: `install` writes it when
 * the mode it just settled is auto or full-auto, takes it back when the mode is
 * review, and `uninstall` reclaims it like every other rule this CLI wrote.
 */
export const PUBLISH_MODE_ALLOWLIST: readonly AllowlistEntry[] = [
  {
    rule: 'Bash(tenjin publish:*)',
    command: 'tenjin publish',
    note:
      'PUBLISHES PUBLICLY under your identity, and is cleared only while publish.mode is ' +
      'auto or full-auto: the mode is the consent, and the harness prompt would ask for it ' +
      'twice. Three things it clears that the free tier never did. It OPENS THE KEYSTORE: ' +
      'publish always resolves a signer, and with no usable session it mints one at ' +
      'read+write scope, which is strictly broader than the read-only key ' +
      '`tenjin session start` exists as a deliberate opt-in for. It publishes the contents ' +
      'of ANY LOCAL FILE the agent can read, gated only by the heuristic scan. And it is a ' +
      'PREFIX rule, so it pins the verb and not the flags: `--base-url` rides it (see the ' +
      'flag caveat), and `--yes` is an ordinary flag on the same verb that clears exactly ' +
      'the WARN findings auto stopped on, so a re-run collapses auto into full-auto with ' +
      'nobody asked. What still gates a publish is the CLI: the deterministic secret scan ' +
      'blocks in every mode and no --yes clears it. The skills hold the rest of that line. ' +
      'Set publish.mode back to review and the rule is retracted.',
  },
  {
    rule: 'Bash(tenjin edit:*)',
    command: 'tenjin edit',
    note:
      'Updates posts your wallet ALREADY OWNS: reprices, refreshes an as-of date, repairs an ' +
      'answer card. Owner-scoped on both legs (GET and PUT /api/posts/<id> are signed and ' +
      'owner-only), spends nothing, moves no keys, and creates no new public content: a ' +
      'narrower blast radius than the publish rule beside it. It rides the same mode for the ' +
      'same reason: edit runs the identical publish.mode consent gate in the CLI ' +
      '(lib/consent.ts needsConfirmation), so a mode that publishes unattended and then ' +
      'cannot fix its own post\u2019s price is the asymmetry the mode exists to remove. It ' +
      'opens the keystore on the same terms as the publish rule beside it, and takes the ' +
      'same prefix-rule caveats. Removed by the same return to review.',
  },
];

/** The mode-gated rules in effect for `mode`; empty on review. */
export function modeGatedAllowlist(mode: PublishMode): AllowlistEntry[] {
  return mode === 'review' ? [] : PUBLISH_MODE_ALLOWLIST.map((e) => ({ ...e }));
}

/**
 * Verbs that must NEVER appear in the recommended allowlist, with the reason each
 * one is a human decision. `tenjin send` is the wallet escape hatch (tenjin-agent
 * #40) and heads this list: it moves USDC to an arbitrary address, outside the
 * spend policy that bounds `buy`. Naming it here is load-bearing even in versions
 * where the verb does not exist yet — the exclusion ships before the verb does.
 *
 * `tenjin publish` stays on this list under its own terms: nothing RECOMMENDS it,
 * and no line here or on the doc page adds it. {@link PUBLISH_MODE_ALLOWLIST} is
 * not a recommendation — it is what one specific operator choice already means.
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
    reason:
      'Puts your content on a public marketplace under your identity. Never pre-cleared by the ' +
      'free tier or an opt-in line: the only thing that clears it is `publish.mode` auto or ' +
      'full-auto, which is the same human decision said once instead of twice (see ' +
      'PUBLISH_MODE_ALLOWLIST). Back on review, `install` takes the rule away again.',
  },
  {
    command: 'tenjin edit',
    reason:
      'Write-capable despite the no-flag form reading as a pure show: it edits live posts ' +
      'and answer cards under your identity, and moves prices. A prefix rule pins the verb, ' +
      'not the flags, so no rule can clear the read half without clearing the write half. ' +
      'Never pre-cleared as a recommendation: like `tenjin publish`, the only thing that ' +
      'clears it is `publish.mode` auto or full-auto, whose consent gate it already shares ' +
      '(see PUBLISH_MODE_ALLOWLIST). Back on review, `install` takes the rule away again.',
  },
  {
    command: 'tenjin delete',
    reason:
      'Destroys a published piece. It is the one write verb `publish.mode` deliberately does NOT ' +
      'carry: the mode is consent to publish, and reading it as consent to destroy would let one ' +
      'decision authorize a different, irreversible one. So no mode ever clears this rule, and ' +
      'the CLI confirms on every run regardless — a prefix rule here would only remove the ' +
      'harness prompt in front of a command that asks its own question anyway. Reach for ' +
      '`tenjin edit --status draft` when the piece should come down reversibly.',
  },
  {
    command: 'tenjin wallet create',
    reason: 'Creates the payment credential; a stray run is a wallet you did not mean to have.',
  },
  {
    command: 'tenjin config set',
    reason:
      'Can raise maxAutoSpend / sessionBudget / confirm, i.e. widen the agent’s own spend policy — ' +
      'and, through shelfBypassSecret + baseUrl, put the machine in team mode, where a publish ' +
      'skips the scan’s warn tier (except the credential checks secret-assignment, ' +
      'hex32-value, high-entropy-string and env-dump-block and the injection check ' +
      'embedded-instruction) and prices at 0. It also writes ' +
      'publish.ackServerWarnings on, the most direct consent-loosening write on this verb: ' +
      'it lets one --yes cover the marketplace’s own scan findings, which no payload had ' +
      'rendered when that yes was given.',
  },
  {
    command: 'tenjin install',
    reason: 'Writes into harness config and skills directories.',
  },
  {
    command: 'tenjin push',
    reason:
      'Writes hook entries into harness settings, and arms the one hook in this CLI that can ' +
      'CANCEL a tool call the agent asked for (the abort-and-answer WebSearch/WebFetch deny) ' +
      'and inject shelf content into later turns. Narrower authority than its list-mates — it ' +
      'cannot spend, open the keystore or publish under your identity — but which hooks run in ' +
      'your harness is an operator decision, and `runPushOn` has no consent gate of its own. ' +
      'A prefix rule pins the verb, not the flags, so it would clear `off` and `status` too.',
  },
  {
    command: 'tenjin mcp',
    reason:
      'Long-running server that re-exposes every command core over stdio; ' +
      'clearing it would indirectly clear everything above.',
  },
  {
    command: 'tenjin update',
    reason:
      'Replaces the tenjin binary the agent then runs, with whatever npm serves ' +
      'next. Which build an agent executes is an operator decision, not something ' +
      'a rule pre-clears. `--check` only reports, but a prefix rule pins the verb, ' +
      'not the flags.',
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
  'This covers the two rules your publish.mode carries as well, and bites hardest there:',
  '`tenjin publish --base-url <host>` is cleared by default on auto, and it signs against',
  'the host it is given.',
];

/**
 * The MCP caveat. `tenjin mcp` is never recommended as a Bash rule, but an
 * operator who registers the server anyway is on a different permission surface
 * (tools, not command strings) where three excluded verbs come back.
 */
export const MCP_CAVEAT: readonly string[] = [
  'Note the asymmetry: publish.mode writes the Bash rules for `publish` and `edit`, and',
  'deliberately does not touch the MCP tool grants below. The mode is a CLI-side consent',
  'gate, and nothing reads it on the MCP surface, so clearing those tools would hand out',
  'the same authority with none of the same gate. Aligning the two is tracked separately.',
  'Running the local MCP server (`tenjin mcp`) instead? That is a different permission',
  'surface: the harness gates TOOLS there, and these Bash rules do not apply. Leave',
  '`mcp__tenjin__tenjin_publish`, `mcp__tenjin__tenjin_edit`,',
  '`mcp__tenjin__tenjin_delete`, and `mcp__tenjin__tenjin_wallet` gated. `tenjin_buy` is',
  'the same opt-in decision as the buy line above. `tenjin_delete` is the one whose own',
  'core still confirms even if you clear it: it never reads publish.mode.',
];

/** The machine shape emitted by `tenjin doctor --json` and `tenjin install --json`. */
export interface RecommendedPermissions {
  alwaysSafe: AllowlistEntry[];
  optIn: AllowlistEntry[];
  neverAllowlisted: ExcludedVerb[];
  /**
   * Rules the CURRENT publish.mode carries, empty on review. Separate from the
   * three tiers above because it is not a recommendation to weigh: it is what
   * this machine's mode already means, so a consumer that renders it beside the
   * others would be offering a choice that has been made.
   */
  modeGated: AllowlistEntry[];
  /** Caveats that qualify the rules above; never omit them when rendering. */
  caveats: { flags: string[]; mcp: string[] };
}

/** `mode` defaults to the shipped `review`, i.e. no mode-gated rules. */
export function recommendedPermissions(mode: PublishMode = 'review'): RecommendedPermissions {
  return {
    alwaysSafe: ALWAYS_SAFE_ALLOWLIST.map((e) => ({ ...e })),
    optIn: OPT_IN_ALLOWLIST.map((e) => ({ ...e })),
    neverAllowlisted: NEVER_ALLOWLISTED.map((e) => ({ ...e })),
    modeGated: modeGatedAllowlist(mode),
    caveats: { flags: [...FLAG_CAVEAT], mcp: [...MCP_CAVEAT] },
  };
}

/** Every rule this module recommends adding (safe + opt-in). */
export function recommendedRules(): string[] {
  return [...ALWAYS_SAFE_ALLOWLIST, ...OPT_IN_ALLOWLIST].map((e) => e.rule);
}

/**
 * The permission caveats' one home. `doctor` used to print the whole thing —
 * nine rules, both opt-in notes, every exclusion, the flag caveat and the MCP
 * caveat, ~60 lines ahead of the check list it was actually run for. No doctor
 * command in the wider ecosystem carries security prose, and an operator reading
 * a wall of it in a terminal cannot paste from it, search it, or link a colleague
 * to a section. The page can do all three, so it is where the caveats live and
 * where every human surface points; `--json` still carries them as data
 * (`recommendedPermissions`), which is what an agent reads.
 */
export const PERMISSIONS_DOC_URL =
  'https://github.com/BackTrackCo/tenjin-agent/blob/main/docs/agent-permissions.md';

/**
 * The single line that replaced the block: what is on the page, and its URL. It
 * names the counts rather than the rules so the operator knows whether the page
 * answers their question before they open it.
 *
 * Subagent delegation is named here rather than on a second line, because doctor
 * deliberately closes with ONE pointer (#81) and the operator deciding what to
 * hand a subagent is reading exactly this line. The free tier IS the
 * subagent-safe set, so the counts already answer the question; which verbs stay
 * human-gated lives on the page with every other caveat.
 */
export function permissionsPointer(): string {
  return (
    `Auto-mode permission allowlist and subagent delegation (${ALWAYS_SAFE_ALLOWLIST.length} free verbs, ` +
    `${OPT_IN_ALLOWLIST.length} opt-ins, the --base-url caveat): ${PERMISSIONS_DOC_URL}`
  );
}

/**
 * The rules the current mode is missing, or null when it needs none. This one
 * DOES name them,
 * unlike {@link permissionsPointer}: they are not a tier to weigh and paste, they
 * are lines that should already be in the operator's settings file, and an
 * operator whose agent is being prompted for work the mode said not to ask about
 * needs to see exactly which rules are missing.
 *
 * CONSULTS THE MACHINE. Rendering from the mode alone told operators to add
 * rules their settings file already had, and named a remedy that in one case
 * would not have written anything — a nag that is wrong twice over on a line
 * whose whole job is to prevent an agent stalling on a prompt (#161).
 */
export function modeGatedPointer(
  mode: PublishMode,
  /** The mode-gated rules this machine is actually MISSING. Empty renders nothing. */
  missing: readonly string[],
  /**
   * The command that would fix it. `tenjin install` for the ordinary case; a
   * mode coming from TENJIN_PUBLISH_MODE needs `config set` instead, because
   * install resolves the mode from the global file and would write nothing.
   */
  remedy = 'tenjin install',
): string | null {
  if (modeGatedAllowlist(mode).length === 0 || missing.length === 0) return null;
  return `publish.mode=${mode} also needs ${missing.join(' and ')} in your harness allowlist, or it will prompt anyway; \`${remedy}\` writes them.`;
}

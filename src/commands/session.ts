import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { establishSession, SESSION_CHAIN_ID } from '../lib/session-key';
import { isSessionUsable, loadSessionFile, type SessionScope } from '../lib/session-present';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin session start --scope read`: open the wallet ONCE and mint a ≤24h
 * P-256 session key that `tenjin read` can then present, unattended, to recover a
 * piece this wallet already owns but has not cached on this machine.
 *
 * This is the attended half of a deliberate split. `read` cannot open a keystore
 * — its import graph is test-pinned clear of the wallet — so the one wallet
 * signature a recovery needs has to come from somewhere the operator invokes on
 * purpose. That is this verb, and it is why it sits in the OPT-IN allowlist tier
 * beside `buy` rather than in the always-safe one: it spends no money and can
 * never spend any, but it does open the keystore.
 *
 * What it leaves behind is bounded twice over. The delegated key is P-256, so it
 * cannot produce the secp256k1/EIP-712 signature an EIP-3009 transfer needs — no
 * arrangement of the cached file pays for anything. And the delegation is minted
 * at scope `read`, which the server independently refuses (`insufficient_scope`)
 * on any write method, so a leaked file cannot publish or edit either.
 *
 * v1 accepts NO other scope. `--scope read+write` is refused rather than
 * forwarded: a prefix allowlist rule pins the verb and not the flags, so the only
 * way `Bash(tenjin session start:*)` can be a non-escalatable grant is for every
 * command line it matches to mint the narrow scope. The write path keeps minting
 * its own `read+write` session lazily, from `publish`/`edit`, where a human is
 * already consenting to a write.
 */

/** The only scope v1 mints. See the docblock: this is what makes the rule safe. */
const V1_SCOPE: SessionScope = 'read';

export interface SessionStartArgs {
  /** Raw `--scope`; validated at the edge, USAGE on anything but `read`. */
  scope?: string;
}

export interface SessionStartDeps {
  provider?: WalletProvider;
  env?: NodeJS.ProcessEnv;
  /** Clock seam (ms since epoch) for the reuse decision. */
  now?: () => number;
}

export async function runSessionStart(
  args: SessionStartArgs,
  ctx: CommandContext,
  deps: SessionStartDeps = {},
): Promise<CommandResult> {
  const now = deps.now ?? Date.now;
  if (args.scope !== undefined && args.scope !== V1_SCOPE) {
    throw new CliError('USAGE', `Unsupported session scope: ${JSON.stringify(args.scope)}`, {
      fix: 'This version mints read-scoped sessions only; run `tenjin session start --scope read` (or omit the flag). A write-capable session is minted by `tenjin publish` / `tenjin edit` on the run that needs it.',
    });
  }

  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  // describeWallet surfaces WALLET_MISSING with its own fix, and gives the address
  // WITHOUT unlocking the key — which is what makes the reuse path below cost no
  // wallet interaction at all (no passphrase prompt on a second run).
  const wallet = await describeWallet(provider);

  const cached = await loadSessionFile(ctx.dataDir);
  if (cached !== null && isSessionUsable(cached, wallet.address, now(), V1_SCOPE)) {
    // Idempotent: a live session wide enough for this scope is REUSED, so a second
    // run opens no wallet. A cached `read+write` (publish's, say) satisfies a read
    // need, so this also refuses to downgrade a wider session that still works.
    return receipt(cached.address, cached.scope, cached.exp, false);
  }

  const signer = await provider.getSigner();
  const file = await establishSession({
    signer,
    baseUrl: settings.baseUrl,
    chainId: SESSION_CHAIN_ID,
    dataDir: ctx.dataDir,
    scope: V1_SCOPE,
  });
  return receipt(file.address, file.scope, file.exp, true);
}

/**
 * The receipt. Address, scope and expiry ONLY — never the delegation and never
 * the private JWK: this output lands in an agent's transcript, and a session key
 * printed there outlives the 0600 file it was written to.
 */
function receipt(address: string, scope: string, exp: string, minted: boolean): CommandResult {
  return {
    data: { status: minted ? 'created' : 'reused', address, scope, exp },
    humanLines: [
      minted
        ? `Session key minted for ${address} (scope ${scope}), expires ${exp}.`
        : `Session key already active for ${address} (scope ${scope}), expires ${exp}. No wallet signature needed.`,
      '`tenjin read` can now recover pieces this wallet already owns. It still cannot pay.',
    ],
  };
}

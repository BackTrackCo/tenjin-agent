import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { establishSession, SESSION_CHAIN_ID } from '../lib/session-key';
import { isSessionUsable, loadSessionFile, type SessionScope } from '../lib/session-present';
import { originOf } from '../lib/url';
import type { SessionFile } from '../lib/session-present';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin session start --scope read`: open the wallet ONCE and mint a ≤24h
 * P-256 session key that `tenjin read` can then present, unattended, to recover a
 * piece this wallet already owns but has not cached on this machine.
 *
 * This is the attended half of a deliberate split: `read` cannot open a keystore,
 * so the one wallet signature a recovery needs comes from a verb the operator
 * invokes on purpose. It spends nothing and cannot, but it does open the
 * keystore, which is why it sits in the OPT-IN tier beside `buy`.
 *
 * What it leaves on disk is a wallet-derived credential. Treat it as one: it is
 * bound to the origin it was minted against and every presenter re-checks that,
 * and the receipt below carries no key material. `lib/permissions.ts` states the
 * exposure an operator is accepting.
 *
 * v1 accepts NO other scope. `--scope read+write` is refused rather than
 * forwarded: a prefix allowlist rule pins the verb and not the flags, so the only
 * way `Bash(tenjin session start:*)` can be a non-escalatable grant is for every
 * command line it matches to mint the narrow scope. The write path keeps minting
 * its own `read+write` session lazily, from `publish`/`edit`, where a human is
 * already consenting to a write.
 */

/** The only scope v1 mints; see the docblock for why that is load-bearing. */
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
  // describe() reports the address WITHOUT unlocking the key, which is what makes
  // the reuse path below cost no wallet interaction (no passphrase prompt).
  const wallet = await describeWallet(provider);

  // Idempotent: a live session wide enough AND minted for this origin is reused,
  // so a second run opens no wallet, and a cached `read+write` (publish's) is
  // never downgraded. A session for another deployment is not reusable.
  const origin = originOf(settings.baseUrl);
  const cached = await loadSessionFile(ctx.dataDir);
  if (cached !== null && isSessionUsable(cached, wallet.address, now(), V1_SCOPE, origin)) {
    return receipt(cached, false);
  }

  const signer = await provider.getSigner();
  const file = await establishSession({
    signer,
    baseUrl: settings.baseUrl,
    chainId: SESSION_CHAIN_ID,
    dataDir: ctx.dataDir,
    scope: V1_SCOPE,
  });
  return receipt(file, true);
}

/**
 * The receipt. Address, origin, scope and expiry ONLY — never the delegation and
 * never the private JWK: this output lands in an agent's transcript, and a
 * session key printed there outlives the 0600 file it was written to.
 */
function receipt(file: SessionFile, minted: boolean): CommandResult {
  const { address, origin, scope, exp } = file;
  const what = `${address} (scope ${scope}) for ${origin}`;
  return {
    data: { status: minted ? 'created' : 'reused', address, origin, scope, exp },
    humanLines: [
      minted
        ? `Session key minted for ${what}, expires ${exp}.`
        : `Session key already active for ${what}, expires ${exp}. No wallet signature needed.`,
      '`tenjin read` can now recover pieces this wallet already owns from that origin. It still cannot pay.',
    ],
  };
}

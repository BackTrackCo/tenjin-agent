import { evaluateSpendPolicy, type SpendPolicy } from '../lib/policy';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { readUsdcBalance } from '../lib/usdc-balance';
import { describeWallet } from '../lib/wallet';
import type { WalletProvider, WalletVerification } from '../lib/wallet/provider';
import { readWalletFacts, type WalletFacts } from '../lib/wallet-facts';
import type { SigningSource } from '../lib/wallet-unlock';
import { channelCredit } from './channel-credit';
import {
  canPayRouting,
  canSign as canSignFrom,
  signFromVerification,
  type SignVerdict,
  type Verdict,
} from './eligibility';
import {
  CHANNEL_DEPOSIT_ATOMIC,
  feeRefusal,
  MAX_CHANNEL_DEPOSIT_ATOMIC,
  refusedWhy,
  ROUTING_FEE_CEILING_ATOMIC,
  routingDepositAtomic,
} from './fee';
import { UNKNOWN_DETAIL } from './wallet-reasons';

/**
 * THE WHOLE ELIGIBILITY PICTURE FOR ONE SHELL, for `tenjin doctor`: gather the
 * facts with real I/O (the wallet files, a no-prompt verify, the spend ledger,
 * the routing channel, the chain balance), then decide with the pure rules in
 * `eligibility.ts`, so doctor's verdict is the payer's and the hooks' verdict
 * on the same facts.
 *
 * NOT hook-safe: it loads the wallet layer and the x402 channel storage. No
 * hook imports it, and nothing but doctor needs it (install checks signing
 * with `verify` alone and leaves funding as it is; S6).
 */
export interface EligibilityInput {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  policy: SpendPolicy;
  rpcUrl: string;
  /** The router's host (the creator a deposit pays). */
  host: string;
  timeoutMs: number;
  /** null when there is no wallet file and no TENJIN_WALLET_KEY. */
  provider: WalletProvider | null;
  /** S7: verify with TENJIN_WALLET_PASSPHRASE removed from the env (a provider built from that env). Called first,
   *  only when the variable is set and TENJIN_WALLET_KEY is not valid. Doctor supplies it; absent = today's single verify. */
  verifySaved?: () => Promise<WalletVerification | undefined>;
  fetchImpl?: typeof fetch;
  readBalance?: (
    address: string,
    rpcUrl: string,
    o: { timeoutMs: number; fetchImpl?: typeof fetch },
  ) => Promise<bigint | null>;
  readCredit?: (dataDir: string, address: string) => Promise<bigint>;
  readSpent?: (dataDir: string) => Promise<bigint>;
}

export interface Eligibility {
  address: string | null;
  source: SigningSource | null;
  warning?: string;
  canSign: SignVerdict;
  canPayRouting: Verdict;
  /** S7: the verdict with TENJIN_WALLET_PASSPHRASE removed (verifySaved). null when it was not run. */
  savedSign: SignVerdict | null;
  balanceAtomic: bigint | null;
  creditAtomic: bigint | null;
  /** S11: what describeWallet(provider) rejected with (a corrupt wallet.json, an invalid key). Doctor keeps today's
   *  required fail for it, so exit codes do not change. null when describe succeeded or there is no provider. */
  describeError: unknown | null;
}

/** An unknown verdict worded from UNKNOWN_DETAIL. */
function unknownSign(reason: 'check_failed' | 'not_checked'): SignVerdict {
  return { status: 'unknown', reason, detail: UNKNOWN_DETAIL[reason]! };
}

/** The spent total the deposit is evaluated against: the ledger as an
 *  authorization would see it, and nothing for an absent one. */
async function defaultReadSpent(dataDir: string): Promise<bigint> {
  const ledger = await readSpendSummary(dataDir);
  return ledger === null ? 0n : spentOf(ledger);
}

/**
 * Check what this shell's wallet can do. Never rejects: every step that can
 * fail is caught and becomes an unknown or a null, and the balance is read
 * even when signing is blocked (the address is cleartext, and "locked AND
 * empty" is two things to fix, not one).
 */
export async function checkEligibility(input: EligibilityInput): Promise<Eligibility> {
  let facts: WalletFacts | null = null;
  try {
    facts = await readWalletFacts(input.dataDir, input.env);
    return await check(input, facts);
  } catch {
    const failed = unknownSign('check_failed');
    return {
      address: facts?.address ?? null,
      source: null,
      canSign: failed,
      canPayRouting: failed,
      savedSign: null,
      balanceAtomic: null,
      creditAtomic: null,
      describeError: null,
    };
  }
}

async function check(input: EligibilityInput, facts: WalletFacts): Promise<Eligibility> {
  const { provider } = input;
  let address = facts.address;
  let describeError: unknown | null = null;
  if (provider !== null) {
    try {
      address = (await describeWallet(provider)).address;
    } catch (err) {
      // S11: kept for doctor, which fails it as required exactly as today.
      describeError = err;
    }
  }

  const { sign, savedSign } = await signing(input, facts, describeError);
  const source = sign.status === 'ready' ? (sign.source ?? null) : null;

  const [spent, creditAtomic, balanceAtomic] = await Promise.all([
    (input.readSpent ?? defaultReadSpent)(input.dataDir).catch(() => null),
    address === null
      ? Promise.resolve(null)
      : (input.readCredit ?? channelCredit)(input.dataDir, address).catch(() => null),
    address === null
      ? Promise.resolve(null)
      : (input.readBalance ?? readUsdcBalance)(address, input.rpcUrl, {
          timeoutMs: input.timeoutMs,
          ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
        }).catch(() => null),
  ]);

  // The deposit the payer would sign for this balance, from the production
  // server's hint and with no quote to go on but the ceiling, evaluated
  // against the whole policy as the payer's is.
  const deposit = evaluateSpendPolicy(input.policy, {
    mode: 'automatic',
    amountAtomic: routingDepositAtomic({
      hintAtomic: CHANNEL_DEPOSIT_ATOMIC,
      quoteAtomic: ROUTING_FEE_CEILING_ATOMIC,
      walletAtomic: balanceAtomic,
      perCallAtomic: input.policy.maxAutoSpendAtomic,
      maxAtomic: MAX_CHANNEL_DEPOSIT_ATOMIC,
    }),
    creator: input.host,
    sessionSpentAtomic: spent ?? 0n,
  });
  const routing = canPayRouting({
    // No quote to go on here: the ceiling, the most a call would pay.
    feeRefusal: feeRefusal(input.policy, input.host, ROUTING_FEE_CEILING_ATOMIC),
    sign,
    creditAtomic,
    depositRefusal: deposit.decision === 'allow' ? null : refusedWhy(deposit.reason),
    balanceAtomic,
  });

  return {
    address,
    source,
    ...(sign.status === 'ready' && sign.warning !== undefined ? { warning: sign.warning } : {}),
    canSign: sign,
    canPayRouting: routing,
    savedSign,
    balanceAtomic,
    creditAtomic,
    describeError,
  };
}

/**
 * The sign verdict, and S7's saved-passphrase verdict beside it.
 *
 * SAVED PASSPHRASE FIRST (S7, decision 19). With TENJIN_WALLET_PASSPHRASE set,
 * `verifySaved` asks whether the keychain or file opens the wallet WITHOUT the
 * variable, so a passphrase both hold is reported as that store, not as
 * `passphrase-env`, and doctor can say whether a Claude Code started without
 * the variable could sign. The full verify still runs after it, because only
 * the full env can see that the variable is wrong (ready with a warning).
 */
async function signing(
  input: EligibilityInput,
  facts: WalletFacts,
  describeError: unknown | null,
): Promise<{ sign: SignVerdict; savedSign: SignVerdict | null }> {
  const { provider } = input;
  if (facts.envKey === 'malformed') {
    return {
      sign: canSignFrom({ envKey: 'malformed', walletFile: facts.walletFile }),
      savedSign: null,
    };
  }
  if (provider === null) {
    return { sign: canSignFrom({ envKey: 'absent', walletFile: 'absent' }), savedSign: null };
  }
  if (describeError !== null) return { sign: unknownSign('check_failed'), savedSign: null };

  let savedSign: SignVerdict | null = null;
  if (facts.envPassphraseSet && facts.envKey !== 'valid' && input.verifySaved !== undefined) {
    savedSign = await input
      .verifySaved()
      .then((v) => signFromVerification(v))
      .catch(() => unknownSign('check_failed'));
  }

  let full: SignVerdict;
  if (provider.verify === undefined) {
    full = unknownSign('not_checked');
  } else {
    full = await provider
      .verify()
      .then((v) => signFromVerification(v))
      .catch(() => unknownSign('check_failed'));
  }

  let sign = full;
  if (full.status === 'ready') {
    const source: SigningSource | undefined =
      facts.envKey === 'valid'
        ? 'key-env'
        : savedSign?.status === 'ready'
          ? savedSign.source
          : full.source;
    sign = {
      status: 'ready',
      ...(source !== undefined ? { source } : {}),
      ...(full.warning !== undefined ? { warning: full.warning } : {}),
    };
  } else if (
    facts.envPassphraseSet &&
    full.status === 'blocked' &&
    full.reason === 'passphrase_missing'
  ) {
    // S13: a set variable is a passphrase source, so "none reachable" is not definite.
    sign = unknownSign('not_checked');
  }
  return { sign, savedSign };
}

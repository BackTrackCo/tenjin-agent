import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPolicy } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { BuilderCodeClientExtension } from '@x402/extensions/builder-code';
import type { ClientEvmSigner } from '@x402/evm';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { TypedDataDefinition } from 'viem';
import { getAddress } from 'viem';
import { CliError } from './errors';
import { USDC_ADDRESS } from './usdc';
import type { TenjinSigner } from './wallet/provider';

/**
 * x402 exact-scheme payment construction (spec 10 sanctioned deps: @x402/* +
 * viem). Given the server's decoded PAYMENT-REQUIRED and a structural signer, it
 * produces the `PAYMENT-SIGNATURE` header the paid re-request carries. The base
 * exact flow needs only `address` + `signTypedData` (no RPC), so this never
 * touches the network, the signature is an offline EIP-712/EIP-3009 authorization
 * the facilitator settles.
 */

export interface BuiltPayment {
  /** The `PAYMENT-SIGNATURE` header(s) to attach to the paid re-request. */
  headers: Record<string, string>;
  /** The exact amount authorized, atomic USDC (from accepts[0]). */
  amountAtomic: bigint;
}

/**
 * Build the payment header for the first advertised requirement. The read route
 * advertises exactly one `exact` requirement; if the scheme isn't the exact-EVM
 * this CLI supports, it fails PAYMENT_FAILED rather than signing something the
 * facilitator will reject.
 */
/**
 * The only asset/chain pairs this CLI will EVER sign for: canonical USDC on
 * Base, and on Base Sepolia for previews. Both are 6-decimal, so every USD
 * display and cap in the CLI stays truthful. Without this pin, a hostile or
 * misconfigured 402 (reachable via --base-url or a candidate URL) could name
 * any eip155 chain, any token, and its own payTo: the signed EIP-3009
 * authorization is a bearer instrument valid on that chain's contract directly,
 * no Tenjin facilitator required. Asset compare is checksummed via getAddress.
 */
const ALLOWED_USDC_BY_NETWORK: Record<string, string> = {
  'eip155:8453': USDC_ADDRESS,
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

/**
 * Tenjin's registered ERC-8021 builder code, claimed here as the client service
 * code (`s`). One value, not a CLI-specific second code: Base registers one code
 * per account, and Schema 2 already separates the roles structurally, so a
 * payment this CLI brokers to Tenjin carries the code in BOTH `a` (seller) and
 * `s` (client) while a payment to any other seller carries it only in `s`. It
 * names the client, never the user, and is public by construction. Attribution
 * only, never proof: the ERC-8021 suffix is emitted by the FACILITATOR at
 * settlement, so a facilitator without the extension registered puts nothing on
 * chain, and `s` is unauthenticated and seller-writable, so an occurrence of the
 * code proves nothing about who brokered the payment. Constant, not
 * configurable: a per-install override would make the code meaningless as a
 * client identity.
 */
export const TENJIN_CLI_BUILDER_CODE = 'bc_kc0altv3';

/**
 * Drop any `builder-code.info.s` the SELLER declared, leaving its `a` and schema
 * untouched. Without this a 402 that names its own `s` silently wins: the SDK
 * merges the enriched payload onto the server's extensions as the base and
 * copies a client field only where the server left it unset, so the client
 * extension's `{info: {s}}` is discarded and Tenjin's code never reaches the
 * payload, with no error. Narrowing the top-level `extensions` key set does not
 * help, the override lives inside the entry. Per ERC-8021 Schema 2 `a` is the
 * seller's to declare and `s` is the client's, so removing it here restores the
 * roles rather than suppressing seller data, and this is client-side composition
 * of what we send: nothing off-spec goes on the wire.
 */
function withoutSellerServiceCodes(
  extensions: PaymentRequired['extensions'],
  key: string,
): PaymentRequired['extensions'] {
  const entry = extensions?.[key];
  if (!isPlainObject(entry) || !isPlainObject(entry.info)) return extensions;
  const info = { ...entry.info };
  delete info.s;
  return { ...extensions, [key]: { ...entry, info } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * THE SDK OWNS SELECTION AND PAYLOAD; THIS FILE OWNS WHAT THIS WALLET HOLDS.
 *
 * `x402Client.selectPaymentRequirements` filters a 402's `accepts` to the
 * (network, scheme) pairs registered on the client, runs the registered
 * policies, and picks from what survives. Registering the exact EVM scheme for
 * the Base networks therefore IS the selection rule, and the canonical-USDC pin
 * below is a policy, which the SDK applies as a veto and never as a licence.
 *
 * It replaces a hand-rolled `accepts[0]`, which registered the scheme for
 * whatever network the FIRST entry named and then agreed that entry was
 * supported. Against CoinMarketCap, whose live 402 lists seven entries with BNB
 * chain first and Base USDC third, every quote was priced against an
 * 18-decimal BNB entry and refused before anything was signed.
 */
export function createPayerClient(getSigner: () => TenjinSigner): {
  core: x402Client;
  http: x402HTTPClient;
  builderCodeKey: string;
} {
  // LAZY, so selection can run before the wallet is opened: the price check and
  // the advertised-terms check both happen before a signer exists on purpose,
  // and neither reads an address.
  const lazy: ClientEvmSigner = {
    get address() {
      return getSigner().address;
    },
    signTypedData: (message) =>
      getSigner().signTypedData(message as unknown as TypedDataDefinition),
  };
  const core = new x402Client();
  for (const network of Object.keys(ALLOWED_USDC_BY_NETWORK)) {
    core.register(network as `${string}:${string}`, new ExactEvmScheme(lazy));
  }
  core.registerPolicy(canonicalUsdcOnly);
  // The SDK fires this hook only for sellers whose 402 advertises
  // `builder-code`, so a seller that never declared it still gets an
  // extension-free payload. That gating is why attribution stays spec-clean.
  const builderCode = new BuilderCodeClientExtension(TENJIN_CLI_BUILDER_CODE);
  core.registerExtension(builderCode);
  return { core, http: new x402HTTPClient(core), builderCodeKey: builderCode.key };
}

/**
 * A VETO, in the SDK's own vocabulary: the scheme registration already limits
 * the networks, and this drops any entry on one of them whose asset is not that
 * network's canonical USDC. Without it a seller could advertise `exact` on Base
 * in a token of its choosing, and the signed EIP-3009 authorization is valid
 * against that token's contract directly, no facilitator required.
 */
const canonicalUsdcOnly: PaymentPolicy = (_version, requirements) =>
  requirements.filter((requirement) => {
    const allowed = ALLOWED_USDC_BY_NETWORK[requirement.network];
    if (allowed === undefined) return false;
    try {
      return getAddress(requirement.asset) === getAddress(allowed);
    } catch {
      return false;
    }
  });

/**
 * The entry the SDK would pay, or undefined when it would pay none. The SDK
 * throws on an empty selection; callers here have their own named refusals, so
 * the throw becomes an absence. `want` narrows it to a caller's advertised
 * terms, which is a further veto and never a widening.
 */
export function selectPayableRequirement(
  core: x402Client,
  paymentRequired: PaymentRequired,
  want?: { network?: string; asset?: string },
): PaymentRequirements | undefined {
  const approved = supportedEntries(paymentRequired);
  if (want === undefined) return sdkSelect(core, paymentRequired) ?? approved[0];
  // A caller holding terms wants the supported entry that matches THEM, so the
  // search runs over the same policy-approved set the SDK would choose from
  // rather than over the raw list.
  return approved.find(
    (r) =>
      (want.network === undefined || r.network === want.network) &&
      (want.asset === undefined || sameAsset(r.asset, want.asset)),
  );
}

/**
 * The entries the SDK's selection would consider: the registered networks, the
 * `exact` scheme, and the canonical-USDC policy. Spelled here because the
 * SDK's own `selectPaymentRequirements` is typed private at 2.17.0, so this is
 * the set the adapter below falls back to and the set a terms-narrowed search
 * runs over; the SIGNATURE always goes through the SDK either way.
 */
function supportedEntries(paymentRequired: PaymentRequired): PaymentRequirements[] {
  return canonicalUsdcOnly(paymentRequired.x402Version, paymentRequired.accepts).filter(
    (r) => r.scheme === 'exact' && ALLOWED_USDC_BY_NETWORK[r.network] !== undefined,
  );
}

/**
 * The SDK's own selector when it is reachable. `selectPaymentRequirements` is
 * public at runtime and carries the registered schemes, the policies and the
 * configured selector, which is exactly the decision wanted here; it is only
 * typed private, so the call is adapted rather than reimplemented, and an SDK
 * that ever removes it degrades to {@link supportedEntries} rather than
 * breaking. A test pins the two agreeing on a multi-network challenge.
 */
function sdkSelect(
  core: x402Client,
  paymentRequired: PaymentRequired,
): PaymentRequirements | undefined {
  const select = (
    core as unknown as {
      selectPaymentRequirements?: (
        version: number,
        accepts: readonly PaymentRequirements[],
      ) => PaymentRequirements;
    }
  ).selectPaymentRequirements;
  if (typeof select !== 'function') return undefined;
  try {
    return select.call(core, paymentRequired.x402Version, paymentRequired.accepts);
  } catch {
    return undefined;
  }
}

function sameAsset(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** The named refusal when a 402 advertises nothing this wallet can pay. */
export function noPayableRequirement(accepts: readonly PaymentRequirements[]): CliError {
  const advertised = accepts.map((a) => `${a.scheme}/${a.network}/${a.asset}`);
  return new CliError(
    'PAYMENT_FAILED',
    accepts.length === 0
      ? 'The 402 advertised no payment requirements.'
      : 'The 402 advertises nothing this CLI can pay: it lists no exact-scheme entry in canonical USDC on Base.',
    {
      fix: 'Only USDC on Base (eip155:8453), or Base Sepolia for previews, is supported. Nothing was signed.',
      ...(accepts.length > 0 ? { details: { advertised } } : {}),
    },
  );
}

/**
 * Build the `PAYMENT-SIGNATURE` header for the entry the SDK selects, or for
 * `only` when the caller has already selected one and wants that exact deal
 * signed. Selection, payload construction and header encoding are all the
 * SDK's; what stays here is which networks and assets this wallet holds.
 */
export async function buildExactPayment(
  paymentRequired: PaymentRequired,
  signer: TenjinSigner,
  only?: PaymentRequirements,
): Promise<BuiltPayment> {
  const { core, http, builderCodeKey } = createPayerClient(() => signer);
  const requirement = only ?? selectPayableRequirement(core, paymentRequired);
  if (requirement === undefined) throw noPayableRequirement(paymentRequired.accepts);

  // A single-accept challenge, so nothing can re-select a different or costlier
  // entry between the check and the signature. Narrow `accepts` only, or the
  // builder-code hook never fires.
  const bound: PaymentRequired = {
    ...paymentRequired,
    accepts: [requirement],
    extensions: withoutSellerServiceCodes(paymentRequired.extensions, builderCodeKey),
  };

  let headers: Record<string, string>;
  try {
    const payload = await http.createPaymentPayload(bound);
    headers = http.encodePaymentSignatureHeader(payload);
  } catch (err) {
    throw new CliError('PAYMENT_FAILED', 'Could not build the x402 payment authorization.', {
      fix: 'Confirm the wallet is a supported EVM account on the advertised network.',
      cause: err,
    });
  }

  return { headers, amountAtomic: BigInt(requirement.amount) };
}

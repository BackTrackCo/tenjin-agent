import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import type { ClientEvmSigner } from '@x402/evm';
import type { PaymentRequired } from '@x402/core/types';
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

/** Adapt the wallet seam's signer to the x402 EVM client signer. Only the base
 *  flow's two members are needed; the optional RPC helpers stay unset (no gas
 *  sponsoring on this path). */
function toClientSigner(signer: TenjinSigner): ClientEvmSigner {
  return {
    address: signer.address,
    signTypedData: (message) => signer.signTypedData(message as unknown as TypedDataDefinition),
  };
}

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

export async function buildExactPayment(
  paymentRequired: PaymentRequired,
  signer: TenjinSigner,
): Promise<BuiltPayment> {
  const requirement = paymentRequired.accepts[0];
  if (requirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'The resource may be misconfigured; try another candidate.',
    });
  }
  if (requirement.scheme !== 'exact') {
    throw new CliError('PAYMENT_FAILED', `Unsupported payment scheme "${requirement.scheme}".`, {
      fix: 'This CLI pays the x402 exact scheme only.',
    });
  }
  const allowedAsset = ALLOWED_USDC_BY_NETWORK[requirement.network];
  if (allowedAsset === undefined) {
    throw new CliError(
      'PAYMENT_FAILED',
      `The 402 names a chain this CLI will not pay on: ${requirement.network}.`,
      {
        fix: 'Only USDC on Base (eip155:8453) or Base Sepolia previews (eip155:84532) is supported.',
      },
    );
  }
  let assetChecksummed: string;
  try {
    assetChecksummed = getAddress(requirement.asset);
  } catch {
    throw new CliError(
      'PAYMENT_FAILED',
      `The 402 names an invalid asset address: ${JSON.stringify(requirement.asset)}.`,
    );
  }
  if (assetChecksummed !== getAddress(allowedAsset)) {
    throw new CliError(
      'PAYMENT_FAILED',
      `The 402 names an asset this CLI will not pay: ${assetChecksummed} on ${requirement.network}.`,
      {
        fix: 'Only canonical USDC is supported; the resource or server looks misconfigured or hostile.',
      },
    );
  }

  const core = new x402Client();
  core.register(requirement.network, new ExactEvmScheme(toClientSigner(signer)));
  const http = new x402HTTPClient(core);

  // Sign EXACTLY the requirement the price check ran against: pass a single-accept
  // challenge so createPaymentPayload cannot re-select a different (e.g. costlier)
  // accepts entry between the check and the signature.
  const bound: PaymentRequired = { ...paymentRequired, accepts: [requirement] };

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

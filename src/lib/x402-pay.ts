import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import type { ClientEvmSigner } from '@x402/evm';
import type { PaymentRequired } from '@x402/core/types';
import type { TypedDataDefinition } from 'viem';
import { CliError } from './errors';
import type { TenjinSigner } from './wallet/provider';

/**
 * x402 exact-scheme payment construction (spec 10 sanctioned deps: @x402/* +
 * viem). Given the server's decoded PAYMENT-REQUIRED and a structural signer, it
 * produces the `PAYMENT-SIGNATURE` header the paid re-request carries. The base
 * exact flow needs only `address` + `signTypedData` (no RPC), so this never
 * touches the network — the signature is an offline EIP-712/EIP-3009 authorization
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

  const core = new x402Client();
  // Register the exact-EVM scheme for the advertised network; createPaymentPayload
  // then selects the matching requirement and signs it.
  core.register(requirement.network, new ExactEvmScheme(toClientSigner(signer)));
  const http = new x402HTTPClient(core);

  let headers: Record<string, string>;
  try {
    const payload = await http.createPaymentPayload(paymentRequired);
    headers = http.encodePaymentSignatureHeader(payload);
  } catch (err) {
    throw new CliError('PAYMENT_FAILED', 'Could not build the x402 payment authorization.', {
      fix: 'Confirm the wallet is a supported EVM account on the advertised network.',
      cause: err,
    });
  }

  return { headers, amountAtomic: BigInt(requirement.amount) };
}

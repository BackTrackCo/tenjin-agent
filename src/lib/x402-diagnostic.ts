import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

const REASONS = [
  'provider_payment_method_required',
  'payment_required',
  'payment_requirements_mismatch',
  'payment_verification_failed',
  'settlement_failed',
  'asset_not_deployed_contract',
  'invalid_exact_evm_scheme',
  'invalid_exact_evm_network_mismatch',
  'invalid_exact_evm_missing_eip712_domain',
  'invalid_exact_evm_recipient_mismatch',
  'invalid_exact_evm_signature',
  'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_valid_after',
  'invalid_exact_evm_authorization_value',
  'invalid_exact_evm_transaction_failed',
  'invalid_exact_evm_token_name_mismatch',
  'invalid_exact_evm_token_version_mismatch',
  'invalid_exact_evm_eip3009_not_supported',
  'invalid_exact_evm_nonce_already_used',
  'invalid_exact_evm_insufficient_balance',
  'invalid_exact_evm_transaction_simulation_failed',
] as const;

type PaymentFailureReason = (typeof REASONS)[number];
export interface X402FailureDiagnostic {
  stage: 'verification' | 'settlement';
  reason: PaymentFailureReason;
}

const reasons: ReadonlySet<string> = new Set(REASONS);
const HEADER_LIMIT = 16_384;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copy only closed-vocabulary fields across a persistent diagnostic boundary. */
export function validatedX402Failure(value: unknown): X402FailureDiagnostic | undefined {
  if (
    !record(value) ||
    (value.stage !== 'verification' && value.stage !== 'settlement') ||
    typeof value.reason !== 'string' ||
    !reasons.has(value.reason)
  )
    return undefined;
  return { stage: value.stage, reason: value.reason as PaymentFailureReason };
}

function classify(value: unknown): PaymentFailureReason | undefined {
  if (typeof value !== 'string' || value.length > HEADER_LIMIT) return undefined;
  if (reasons.has(value)) return value as PaymentFailureReason;
  switch (value) {
    case 'Payment required':
      return 'payment_required';
    case 'No matching payment requirements':
      return 'payment_requirements_mismatch';
    case 'Payment verification failed':
      return 'payment_verification_failed';
    case 'Settlement failed':
      return 'settlement_failed';
  }
  // CDP can truncate its nested error JSON. Recognize the specific settlement
  // rejection without retaining its correlation ID, URL, or arbitrary message.
  if (
    value.startsWith('Facilitator settle failed (402): {') &&
    value.includes('#payment-method-required') &&
    (value.includes('https://docs.cdp.coinbase.com/') ||
      value.includes('A valid payment method is required'))
  )
    return 'provider_payment_method_required';
  return undefined;
}

/** Provider diagnostics are claims, never proof of settlement or permission to retry. */
export function diagnoseX402Failure(
  header: (name: string) => string | undefined,
): X402FailureDiagnostic | undefined {
  const response = header('PAYMENT-RESPONSE');
  if (response !== undefined && response.length <= HEADER_LIMIT) {
    try {
      const decoded: unknown = decodePaymentResponseHeader(response);
      if (record(decoded) && decoded.success === false) {
        const reason =
          classify(decoded.errorMessage) ?? classify(decoded.errorReason) ?? 'settlement_failed';
        return { stage: 'settlement', reason };
      }
    } catch {
      // Malformed provider diagnostics must not hide the original HTTP failure.
    }
  }
  const required = header('PAYMENT-REQUIRED');
  if (required !== undefined && required.length <= HEADER_LIMIT) {
    try {
      const decoded: unknown = decodePaymentRequiredHeader(required);
      if (record(decoded)) {
        const reason = classify(decoded.error);
        if (reason !== undefined) return { stage: 'verification', reason };
      }
    } catch {
      // No raw provider text crosses this boundary.
    }
  }
  return undefined;
}

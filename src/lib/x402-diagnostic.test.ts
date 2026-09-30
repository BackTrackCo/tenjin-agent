import { describe, expect, it } from 'vitest';
import { diagnoseX402Failure, validatedX402Failure } from './x402-diagnostic';

function diagnostic(headers: Record<string, unknown>) {
  return diagnoseX402Failure((name) =>
    headers[name] === undefined
      ? undefined
      : Buffer.from(JSON.stringify(headers[name])).toString('base64'),
  );
}

const facilitatorError =
  'Facilitator settle failed (402): {"correlationId":"private-id","errorLink":"https://docs.cdp.coinbase.com/api-reference/errors#payment-method-required","errorMessage":"A valid payment method is required to complete th';

describe('bounded x402 payment diagnostics', () => {
  it('recognizes truncated CDP settlement billing failures without retaining provider text', () => {
    const result = diagnostic({
      'PAYMENT-RESPONSE': {
        success: false,
        errorReason: 'settlement_failed',
        errorMessage: facilitatorError,
      },
      'PAYMENT-REQUIRED': { error: 'Payment required' },
    });
    expect(result).toEqual({ stage: 'settlement', reason: 'provider_payment_method_required' });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(JSON.stringify(result)).not.toContain('coinbase');
  });

  it('also classifies providers which put the nested error in errorReason', () => {
    expect(
      diagnostic({ 'PAYMENT-RESPONSE': { success: false, errorReason: facilitatorError } }),
    ).toEqual({ stage: 'settlement', reason: 'provider_payment_method_required' });
  });

  it.each([
    ['invalid_exact_evm_signature', 'invalid_exact_evm_signature'],
    ['invalid_exact_evm_nonce_already_used', 'invalid_exact_evm_nonce_already_used'],
    ['Payment required', 'payment_required'],
    ['No matching payment requirements', 'payment_requirements_mismatch'],
    ['Payment verification failed', 'payment_verification_failed'],
  ])('retains the known verification reason %s', (error, reason) => {
    expect(diagnostic({ 'PAYMENT-REQUIRED': { error } })).toEqual({
      stage: 'verification',
      reason,
    });
  });

  it('does not treat a successful receipt as a settlement failure', () => {
    expect(
      diagnostic({
        'PAYMENT-RESPONSE': { success: true, errorMessage: facilitatorError },
      }),
    ).toBeUndefined();
  });

  it('reports an unknown settlement failure without guessing verification failed', () => {
    expect(
      diagnostic({
        'PAYMENT-RESPONSE': { success: false, errorMessage: 'private-source-or-signature' },
        'PAYMENT-REQUIRED': { error: 'Payment required' },
      }),
    ).toEqual({ stage: 'settlement', reason: 'settlement_failed' });
  });

  it.each([
    'private-source-or-signature',
    'A valid payment method is required',
    'Please follow #payment-method-required',
    'invalid_exact_evm_signature private-signature',
  ])('discards unknown verification text %s', (error) => {
    expect(diagnostic({ 'PAYMENT-REQUIRED': { error } })).toBeUndefined();
  });

  it('ignores malformed, oversized, and non-object headers', () => {
    expect(diagnoseX402Failure(() => 'not-json')).toBeUndefined();
    expect(diagnoseX402Failure(() => 'a'.repeat(16_385))).toBeUndefined();
    expect(diagnostic({ 'PAYMENT-RESPONSE': [facilitatorError] })).toBeUndefined();
    expect(diagnostic({ 'PAYMENT-REQUIRED': 'Payment required' })).toBeUndefined();
  });

  it('validates and reconstructs persistent diagnostics rather than copying extra fields', () => {
    expect(
      validatedX402Failure({
        stage: 'settlement',
        reason: 'provider_payment_method_required',
        header: 'private-signature',
      }),
    ).toEqual({ stage: 'settlement', reason: 'provider_payment_method_required' });
    expect(
      validatedX402Failure({ stage: 'private-source', reason: 'settlement_failed' }),
    ).toBeUndefined();
    expect(validatedX402Failure({ stage: 'settlement', reason: 'private-source' })).toBeUndefined();
    expect(validatedX402Failure(null)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { paymentShortOfFunds } from './payment-failure';
import fixtures from './fixtures/low-funds.json';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
function response(json: unknown, headers: Record<string, string> = {}, status = 402) {
  return { status, json, header: (name: string) => headers[name] };
}

const accepted = [
  'insufficient_funds',
  'invalid_exact_evm_insufficient_balance',
  'invalid_exact_evm_insufficient_funds',
  'permit2_insufficient_balance',
  'invalid_batch_settlement_evm_insufficient_balance',
  'facilitator_prefixed_insufficient_balance',
];
const rejected = [
  'invalid_exact_evm_failed_to_get_balance',
  'erc20_approval_insufficient_eth_for_gas',
  'invalid_exact_solana_payload_amount_insufficient',
  'batch_settlement_refund_amount_exceeds_balance',
  'invalid_signature: insufficient_funds',
  'The message quotes "insufficient_funds"',
  'This is not insufficient_balance',
  'invalid_signature: {"invalidMessage":"insufficient_funds"}',
  'invalid_signature: prose {"invalidReason":"insufficient_funds"}',
  'invalid_signature: {"invalidReason":"insufficient_funds"} trailing prose',
  'invalid_signature: {"invalidReason":"mentions insufficient_funds"}',
  'invalid_signature: {"invalidReason":{"reason":"insufficient_funds"}}',
  'invalid_signature: {"invalidReason":"insufficient_funds"',
  `invalid_signature: ${' '.repeat(16_384)}{"invalidReason":"insufficient_funds"}`,
  null,
  {},
];

const sources = {
  required: (error: unknown) => response({}, { 'PAYMENT-REQUIRED': encode({ error }) }),
  bodyError: (error: unknown) => response({ error }),
  bodyReason: (reason: unknown) => response({ reason }),
  settlementReason: (errorReason: unknown) =>
    response({}, { 'PAYMENT-RESPONSE': encode({ success: false, errorReason }) }),
  settlementMessage: (errorMessage: unknown) =>
    response(
      {},
      { 'PAYMENT-RESPONSE': encode({ success: false, errorReason: 'other', errorMessage }) },
    ),
  legacySettlement: (errorReason: unknown) =>
    response({}, { 'X-PAYMENT-RESPONSE': encode({ success: false, errorReason }) }),
};

describe('paymentShortOfFunds', () => {
  it.each(fixtures)('recognises live fixture: $name', (fixture) => {
    const headers: Record<string, string> = {};
    if (fixture.error !== undefined) headers['PAYMENT-REQUIRED'] = encode({ error: fixture.error });
    expect(paymentShortOfFunds(response(fixture.body, headers))).toBe(true);
  });

  for (const [name, source] of Object.entries(sources)) {
    describe(name, () => {
      it.each(accepted)('recognises the whole code %s, with optional detail', (code) => {
        expect(paymentShortOfFunds(source(code))).toBe(true);
        expect(paymentShortOfFunds(source(` ${code}: contract call failed`))).toBe(true);
        expect(
          paymentShortOfFunds(
            source(`Facilitator verify failed (400): ${JSON.stringify({ invalidReason: code })}`),
          ),
        ).toBe(true);
      });
      it.each(rejected)('does not recognise %j', (code) => {
        expect(paymentShortOfFunds(source(code))).toBe(false);
      });
    });
  }

  it.each([
    'not base64 JSON',
    encode(null),
    encode([]),
    encode('insufficient_funds'),
    'x'.repeat(16_385),
  ])('ignores malformed or oversized headers: %#', (header) => {
    expect(
      paymentShortOfFunds(
        response(null, { 'PAYMENT-REQUIRED': header, 'PAYMENT-RESPONSE': header }),
      ),
    ).toBe(false);
    expect(
      paymentShortOfFunds(
        response({ reason: 'insufficient_funds' }, { 'PAYMENT-REQUIRED': header }),
      ),
    ).toBe(true);
  });

  it('reads body and required errors only on a 402', () => {
    expect(
      paymentShortOfFunds(
        response(
          { error: 'insufficient_funds' },
          { 'PAYMENT-REQUIRED': encode({ error: 'insufficient_funds' }) },
          500,
        ),
      ),
    ).toBe(false);
  });
});

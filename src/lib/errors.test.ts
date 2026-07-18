import { describe, it, expect } from 'vitest';
import { exitCodeFor, CliError } from './errors';
import type { ExitCode } from './errors';
import { ErrorCodeSchema } from '../schemas';
import type { ErrorCode } from '../schemas';

// The whole contract, spelled out: every code maps to exactly one exit code.
const EXPECTED: Record<ErrorCode, ExitCode> = {
  NODE_UNSUPPORTED: 1,
  USAGE: 2,
  CONFIG_INVALID: 2,
  WALLET_EXISTS: 3,
  WALLET_MISSING: 1,
  WALLET_INVALID_KEY: 1,
  PROVIDER_ERROR: 1,
  RPC_ERROR: 1,
  API_UNREACHABLE: 1,
  CONTRACT_MISMATCH: 1,
  REFUSED: 3,
  NETWORK_ERROR: 1,
  INTERNAL: 1,
  NOT_IMPLEMENTED: 1,
  POLICY_REFUSED: 3,
  PAYMENT_FAILED: 4,
  RESOURCE_NOT_FOUND: 1,
  LOOKUP_NOT_FOUND: 1,
};

describe('exitCodeFor', () => {
  for (const code of ErrorCodeSchema.options) {
    it(`maps ${code} -> ${EXPECTED[code]}`, () => {
      expect(exitCodeFor(code)).toBe(EXPECTED[code]);
    });
  }

  it('the expectation table covers every ErrorCode', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ErrorCodeSchema.options].sort());
  });
});

describe('CliError', () => {
  it('resolves exitCode from the code by default', () => {
    expect(new CliError('WALLET_EXISTS', 'x').exitCode).toBe(3);
    expect(new CliError('USAGE', 'x').exitCode).toBe(2);
    expect(new CliError('RPC_ERROR', 'x').exitCode).toBe(1);
  });

  it('allows overriding the exit code (4 reserved for B2 payment failures)', () => {
    expect(new CliError('PROVIDER_ERROR', 'x', { exitCode: 4 }).exitCode).toBe(4);
  });

  it('carries fix, details, and cause', () => {
    const cause = new Error('root');
    const e = new CliError('CONFIG_INVALID', 'bad', { fix: 'f', details: { a: 1 }, cause });
    expect(e.fix).toBe('f');
    expect(e.details).toEqual({ a: 1 });
    expect(e.cause).toBe(cause);
    expect(e).toBeInstanceOf(Error);
  });
});

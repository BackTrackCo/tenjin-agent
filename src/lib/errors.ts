import type { ErrorCode } from '../schemas';

/**
 * The process exit code is API (spec 10): 0 success, 1 runtime/network, 2 usage,
 * 3 policy refusal, 4 payment failure. 4 is reserved for B2 (spend/settlement)
 * and never produced in B1, but it stays in the type so the mapping table is
 * total and B2 adds codes without widening the union.
 */
export type ExitCode = 1 | 2 | 3 | 4;

export interface CliErrorOptions {
  /** A copy-pasteable command or one-line remediation. */
  fix?: string;
  /** Structured detail for machine consumers; serialized into the envelope. */
  details?: unknown;
  /** Override the default exit code for this error's code. */
  exitCode?: ExitCode;
  /** Underlying cause, preserved on the Error but never serialized. */
  cause?: unknown;
}

/**
 * Default code -> exit-code mapping. USAGE/CONFIG_INVALID are malformed
 * invocations (2); WALLET_EXISTS/REFUSED are understood-but-refused (3);
 * everything else is a runtime/network failure (1). A CliError may override its
 * own exit code, but the table is the default every caller relies on.
 */
const EXIT_BY_CODE: Record<ErrorCode, ExitCode> = {
  NODE_UNSUPPORTED: 1,
  USAGE: 2,
  CONFIG_INVALID: 2,
  WALLET_EXISTS: 3,
  WALLET_MISSING: 1,
  WALLET_INVALID_KEY: 1,
  PROVIDER_ERROR: 1,
  RPC_ERROR: 1,
  API_UNREACHABLE: 1,
  API_ERROR: 1,
  RATE_LIMITED: 1,
  CONTRACT_MISMATCH: 1,
  REFUSED: 3,
  PAYMENT_FAILED: 4,
  NETWORK_ERROR: 1,
  INTERNAL: 1,
  NOT_IMPLEMENTED: 1,
};

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_BY_CODE[code];
}

/**
 * The one error type commands throw. It carries the machine `code`, the resolved
 * `exitCode`, and an optional `fix`/`details` that flow straight into the failure
 * envelope. Commands throw it; the CLI dispatcher catches, serializes, and exits.
 */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly fix?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts: CliErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = opts.exitCode ?? exitCodeFor(code);
    this.fix = opts.fix;
    this.details = opts.details;
  }
}

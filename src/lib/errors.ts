import type { ErrorCode } from '../schemas';

/**
 * The process exit code is API (spec 10): 0 success, 1 runtime/network, 2 usage,
 * 3 understood-but-refused (policy refusal, publish confirmation/hard-block), 4 a
 * failure AFTER an approved spend or write (a settlement that failed, a publish
 * that failed post-consent).
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
  CONTRACT_MISMATCH: 1,
  REFUSED: 3,
  NETWORK_ERROR: 1,
  INTERNAL: 1,
  NOT_IMPLEMENTED: 1,
  POLICY_REFUSED: 3,
  PAYMENT_FAILED: 4,
  RESOURCE_NOT_FOUND: 1,
  LOOKUP_NOT_FOUND: 1,
  RATE_LIMITED: 1,
  // A publish awaiting confirmation or hard-blocked is understood-but-refused (3),
  // the same posture as POLICY_REFUSED; a write that failed after approval is a
  // settlement-class failure (4), like PAYMENT_FAILED.
  NEEDS_CONFIRMATION: 3,
  PUBLISH_BLOCKED: 3,
  PUBLISH_FAILED: 4,
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

/** The one error type every layer throws; the HTTP layer maps it to a status. */
export class LedgerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, string | number> | undefined;

  constructor(
    code: string,
    message: string,
    status = 400,
    detail?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function badRequest(
  code: string,
  message: string,
  detail?: Record<string, string | number>,
): LedgerError {
  return new LedgerError(code, message, 400, detail);
}

export function notFound(code: string, message: string): LedgerError {
  return new LedgerError(code, message, 404);
}

export function conflict(code: string, message: string): LedgerError {
  return new LedgerError(code, message, 409);
}

export function isLedgerError(value: unknown): value is LedgerError {
  return value instanceof LedgerError;
}

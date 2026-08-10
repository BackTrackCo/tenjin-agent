import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hasCode } from '../errno';

const LimitsSchema = z
  .object({
    perRequest: z.number().finite().positive().optional(),
    hourly: z.number().finite().positive().optional(),
    daily: z.number().finite().positive().optional(),
    session: z.number().finite().positive().optional(),
  })
  .passthrough();

const SpendingSchema = z
  .object({
    limits: LimitsSchema.optional(),
  })
  .passthrough();

export interface ClawRouterSpendLimits {
  perRequestAtomic?: bigint;
  hourlyAtomic?: bigint;
  dailyAtomic?: bigint;
  sessionAtomic?: bigint;
}

export type ClawRouterPolicyRead =
  | { status: 'configured'; path: string; limits: ClawRouterSpendLimits }
  | { status: 'absent' | 'unconfigured'; path: string }
  | { status: 'invalid'; path: string; warning: string };

export interface ClawRouterPolicyDeps {
  path?: string;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export function defaultClawRouterSpendingPath(home = homedir()): string {
  return join(home, '.openclaw', 'blockrun', 'spending.json');
}

/**
 * Read ClawRouter's configured LIMITS only. Tenjin deliberately never imports,
 * appends to, or rewrites ClawRouter's history: the two applications retain
 * separate ledgers and neither can corrupt the other's state.
 */
export async function readClawRouterSpendPolicy(
  deps: ClawRouterPolicyDeps = {},
): Promise<ClawRouterPolicyRead> {
  const path = deps.path ?? defaultClawRouterSpendingPath();
  let raw: string;
  try {
    raw = await (deps.readFile ?? readFile)(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { status: 'absent', path };
    return {
      status: 'invalid',
      path,
      warning: `ClawRouter spending policy could not be read; Tenjin will require confirmation instead.`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      status: 'invalid',
      path,
      warning:
        'ClawRouter spending policy is not valid JSON; Tenjin will require confirmation instead.',
    };
  }
  const parsed = SpendingSchema.safeParse(json);
  if (!parsed.success) {
    return {
      status: 'invalid',
      path,
      warning: 'ClawRouter spending limits are invalid; Tenjin will require confirmation instead.',
    };
  }

  const limits = parsed.data.limits;
  if (
    limits === undefined ||
    [limits.perRequest, limits.hourly, limits.daily, limits.session].every(
      (value) => value === undefined,
    )
  ) {
    return { status: 'unconfigured', path };
  }
  try {
    const converted: ClawRouterSpendLimits = {};
    if (limits.perRequest !== undefined)
      converted.perRequestAtomic = usdNumberToAtomic(limits.perRequest);
    if (limits.hourly !== undefined) converted.hourlyAtomic = usdNumberToAtomic(limits.hourly);
    if (limits.daily !== undefined) converted.dailyAtomic = usdNumberToAtomic(limits.daily);
    if (limits.session !== undefined) converted.sessionAtomic = usdNumberToAtomic(limits.session);
    return { status: 'configured', path, limits: converted };
  } catch {
    return {
      status: 'invalid',
      path,
      warning:
        'A ClawRouter spending limit cannot be represented safely in USDC atomic units; Tenjin will require confirmation instead.',
    };
  }
}

/** ClawRouter stores USD as JS numbers; USDC has six decimals. Round down so
 * imported limits can never become looser. Sub-micro-USDC and unsafe values are
 * rejected, making the caller fall back to confirmation-only. */
function usdNumberToAtomic(value: number): bigint {
  const scaled = Math.floor(value * 1_000_000);
  if (!Number.isSafeInteger(scaled) || scaled < 1) throw new Error('unrepresentable limit');
  return BigInt(scaled);
}

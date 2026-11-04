import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { CliError } from '../lib/errors';
import { requestHeaderProblem, type HttpResponse } from '../lib/http';
import { toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { isCanonicalUsdc } from '../lib/x402-pay';
import {
  bodyPreview,
  payRequest,
  type Lane,
  type ManualRequest,
  type PayDeps,
  type PayRequestArgs,
} from '../router/pay-request';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin pay <url>`: the standard x402 client verb, for ANY paid endpoint.
 * The payment itself is the engine's (`router/pay-request.ts`), the same one
 * every router call pays through; what is here is the operator's own request
 * (`-H`, `--data`, `--data-raw`) and `--quote`.
 */

export interface PayArgs extends PayRequestArgs {
  /** A JSON request body; content-type is always application/json. */
  data?: string;
  /**
   * `--data-raw`: a body sent byte for byte, for an endpoint that does not
   * take JSON. Its content type is the operator's own `-H 'Content-Type: …'`,
   * which is required with it and refused everywhere else.
   */
  dataRaw?: string;
  /**
   * `-H 'Name: value'` lines from the operator, for a header the endpoint
   * itself asks for (a beta opt-in, an API version). Manual lane only. Any
   * name this command signs or sets is refused before the probe.
   */
  header?: string[];
  /**
   * `--quote`: decode and report the 402 (every payment option, the resource
   * line, the seller's extensions and the body) and stop there. No wallet is
   * opened and nothing is signed. A 2xx on the probe still delivers free.
   */
  quote?: boolean;
}

export async function runPay(
  args: PayArgs,
  ctx: CommandContext,
  deps: PayDeps = {},
): Promise<CommandResult> {
  return payRequest(args, ctx, deps, manualRequest(args));
}

/** The operator's request and `--quote`, for the engine to run in its flow. */
function manualRequest(args: PayArgs): ManualRequest {
  const quote: ManualRequest['quote'] = (url, lane, res, challenge, chosen) =>
    deliverQuote(url, lane, res, challenge, chosen, args.printBody === true);
  return {
    hasBody: args.data !== undefined || args.dataRaw !== undefined,
    resolve: () => {
      const headers = operatorHeaders(args.header, args.dataRaw !== undefined);
      return { headers, body: resolveBody(args, headers) };
    },
    ...(args.quote === true ? { quote } : {}),
  };
}

/**
 * The one body this request carries, or none. `--data` is JSON and sets its
 * own content type; `--data-raw` goes byte for byte under the operator's
 * Content-Type; `rawBody` is the router's, already encoded. Two at once is a
 * usage error, never a silent pick.
 */
function resolveBody(
  args: PayArgs,
  operator: Record<string, string>,
): { jsonBody?: unknown; rawBody?: string } {
  const given = [args.data, args.dataRaw, args.rawBody].filter((b) => b !== undefined);
  if (given.length > 1) {
    throw new CliError('USAGE', 'Pass one request body: --data or --data-raw, not both.', {
      fix: 'Use --data for a JSON body, or --data-raw with its own Content-Type.',
    });
  }
  if (args.data !== undefined) return { jsonBody: parseBody(args.data) };
  if (args.dataRaw !== undefined) {
    if (operator['content-type'] === undefined) {
      throw new CliError('USAGE', 'A --data-raw body needs its content type.', {
        fix: "Pass -H 'Content-Type: <type>' with --data-raw.",
      });
    }
    return { rawBody: args.dataRaw };
  }
  return args.rawBody !== undefined ? { rawBody: args.rawBody } : {};
}

/**
 * The operator's `-H` lines, or a refusal. The opposite rule from the engine's
 * `callerHeaders`: a person typing the command may name any header the
 * endpoint asks for, except what this command signs or sets itself. Values
 * are bounded and single-line, the same bar the router's two names meet.
 * `content-type` is the operator's only with `--data-raw`, whose bytes this
 * command does not encode; `--data` is always JSON.
 */
function operatorHeaders(lines: string[] | undefined, rawBody: boolean): Record<string, string> {
  if (lines === undefined) return {};
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    const name = at > 0 ? line.slice(0, at).trim() : '';
    const value = at > 0 ? line.slice(at + 1).trim() : '';
    const problem = requestHeaderProblem(name, value, rawBody);
    if (problem === 'name') {
      throw new CliError('USAGE', `Not a request header: ${JSON.stringify(line)}`, {
        fix: "Pass -H 'Name: value'.",
      });
    }
    if (problem === 'reserved') {
      throw new CliError('USAGE', `This command sets the header ${JSON.stringify(name)} itself.`, {
        fix: 'Payment, sign-in, bypass and transport headers are never taken from -H. --data is always application/json; only --data-raw takes a Content-Type from -H.',
      });
    }
    if (problem === 'value') {
      throw new CliError(
        'USAGE',
        `The value of ${JSON.stringify(name)} is too long or spans lines.`,
        {
          fix: 'Keep each -H value on one line, under 1,024 characters.',
        },
      );
    }
    const lowered = name.toLowerCase();
    if (lowered in out) {
      throw new CliError('USAGE', `The header ${JSON.stringify(name)} was given twice.`, {
        fix: 'Pass each header name once.',
      });
    }
    out[lowered] = value;
  }
  return out;
}

function parseBody(data: string | undefined): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    throw new CliError('USAGE', 'The --data value is not valid JSON.', {
      fix: 'Pass a JSON object/array/string, e.g. --data \'{"question":"..."}\'.',
    });
  }
}

/**
 * The 402 as a quote: every accepted payment option in the seller's order, the
 * resource line, the extensions the seller attached (a listing's advertised
 * request shape rides there), and the 402 body as data. Nothing was paid, and
 * the terminal line says so.
 *
 * `usd` rides only on a canonical USDC entry, the one kind whose amount is
 * 6-decimal by construction: a seller listing an 18-decimal entry first had it
 * labelled as dollars. `payable` marks the entry the paid path would sign, and
 * the headline prices that entry or says there is none.
 */
function deliverQuote(
  url: string,
  lane: Lane,
  res: HttpResponse,
  challenge: PaymentRequired,
  chosen: PaymentRequirements | undefined,
  printBody: boolean,
): CommandResult {
  const chosenAt =
    chosen === undefined ? -1 : challenge.accepts.findIndex((a) => sameDeal(a, chosen));
  const accepts = challenge.accepts.map((a, i) => ({
    scheme: a.scheme,
    network: a.network,
    asset: a.asset,
    amount: a.amount,
    ...(isCanonicalUsdc(a) ? { usd: toMoney(a.amount).usd } : {}),
    ...(i === chosenAt ? { payable: true as const } : {}),
    payTo: a.payTo,
    maxTimeoutSeconds: a.maxTimeoutSeconds,
    ...(a.extra !== undefined ? { extra: a.extra } : {}),
  }));
  const data = {
    url,
    lane,
    status: res.status,
    paid: false,
    quote: true,
    resource: challenge.resource,
    accepts,
    ...(challenge.extensions !== undefined ? { extensions: challenge.extensions } : {}),
    ...(res.json !== undefined ? { body: res.json } : {}),
    bodyText: res.text,
  };
  const host = sanitizeForTerminal(new URL(url).host);
  const payable = accepts[chosenAt];
  const headline =
    payable?.usd !== undefined
      ? `quote: ${payable.usd} USD to ${host} on ${sanitizeForTerminal(payable.network)} (nothing paid)`
      : accepts.length === 0
        ? `quote: ${host} answered 402 with no payment option (nothing paid)`
        : `quote: ${host} lists no option this wallet can pay, only USDC on Base is supported (nothing paid)`;
  const preview = bodyPreview(res.text, printBody);
  return { data, humanLines: [headline, ...(preview.length > 0 ? [preview] : [])] };
}

/** The same advertised deal, whether or not the SDK handed back the same object. */
function sameDeal(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a === b ||
    (a.scheme === b.scheme &&
      a.network === b.network &&
      a.asset.toLowerCase() === b.asset.toLowerCase() &&
      a.amount === b.amount &&
      a.payTo.toLowerCase() === b.payTo.toLowerCase())
  );
}

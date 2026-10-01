import { boundJevgrepGrant, isJevgrepOffer } from './jevgrep/grants';
import { executeJevgrep } from './jevgrep/executor';
import { runPay, type AdvertisedTerms, type PayDeps } from '../commands/pay';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { downloadsDir } from '../lib/paths';
import { mask } from '../lib/redact';
import { assertResultSchema, canonicalHash } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { requestDecision, type DecisionContract, type DecisionDiagnostics } from './decision';
import { openLookupFooter } from './progress';
import {
  appendPaidRecord,
  MAX_MEDIA_FILES,
  mediaUrlsIn,
  reconcilePayments,
  recordedSent,
  saveMedia,
  createUniqueFile,
  maskDeep,
  writeAll,
  type MediaTransport,
  type PaidRecord,
  type SignedAuthorization,
} from './paid';
import { routerSettings } from './settings';
import { beginRepositoryHandoffRequest } from './repository-handoff';

/**
 * The `request` tool: one free decision per lookup, then ONE payment, to the
 * provider.
 *
 * THE QUERY IS ALWAYS SENT, AND THE ID NAMES THE SERVICE. With an id, the
 * backend binds the query to the capability the hook's line offered and never
 * re-decides which service (tenjin#885). Without one, it asks for exactly one
 * fresh decision from the query and the turn's packet, which is the pair the
 * routing corpus is calibrated on.
 *
 * WHAT IS CHECKED LOCALLY, BEFORE ANYTHING IS SIGNED: the decision's arguments
 * against the schema it carries, its success rule against the compiler, its
 * destination against the shared preflight inside `runPay`, and the amount
 * actually signed against `maxAutoSpend` and `sessionBudget` in `gateSpend`.
 * That last one is the whole money story: a hostile backend can name any
 * origin and spend at most one `maxAutoSpend` inside the daily budget.
 *
 * `needs_approval` is a LOCAL outcome only. The server never sends it: it is
 * what a price over the cap or an exhausted budget looks like from here, and the fix is a command the user can run.
 */

export interface RequestToolArgs {
  /** Optional only beside `input`. */
  query?: string;
  /** The turn id from the hook's line. It names the service that line offered, and
   *  the server runs that one; it grants nothing locally, every cap still applies. */
  id?: string;
  /** The host's own input for a discovered service, per the schema its line
   *  gave. The server builds the request from it; every cap still applies. */
  input?: Record<string, unknown>;
}

/** The server's own cap on `input`, serialized. */
export const MAX_INPUT_BYTES = 16 * 1024;

export interface RequestToolDeps {
  signal?: AbortSignal;
  /** Best-effort, locally authored status; never part of paid execution. */
  onProgress?: (message: string) => void | Promise<void>;
  /** A deterministic hook may execute only the local capability it admitted,
   * even if its offer expires and the server makes a fresh routing decision. */
  expectedExecutor?: 'jevgrep-search-v1';
  ctx: CommandContext;
  /** The SAME provider the MCP server pre-warmed. `runPay` opens its own
   *  otherwise, and the local one re-runs scrypt per process, which is the
   *  2.3 s the background unlock exists to hide. */
  provider?: WalletProvider;
  signer?: TenjinSigner;
  authorizer: SpendAuthorizer;
  fetchImpl?: typeof fetch;
  /** Test seam forwarded to the provider leg. */
  payDeps?: PayDeps;
  /** The directory `router.*` resolves from; defaults to `process.cwd()`, which
   *  Claude Code sets to the project directory for an MCP server. */
  cwd?: string;
  /** Clock seam for a saved file's name. */
  now?: () => number;
  /** Test seam for the media download; production pins each connection to
   *  the address it validated. */
  mediaTransport?: MediaTransport;
}

export interface RequestToolResult {
  isError: boolean;
  summary: string;
  envelope: Record<string, unknown>;
}

export async function runRequestTool(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const handoff = await beginRepositoryHandoffRequest(
    deps.ctx.dataDir,
    deps.cwd ?? process.cwd(),
    args.id,
  );
  if (handoff.status === 'blocked') return fail('needs_input', handoff.reason);
  try {
    return await runRequest(
      args,
      handoff.status === 'owned'
        ? {
            ...deps,
            signal: deps.signal ? AbortSignal.any([deps.signal, handoff.signal]) : handoff.signal,
          }
        : deps,
    );
  } finally {
    if (handoff.status === 'owned') await handoff.finish();
  }
}

async function runRequest(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  // THE SAME SWITCH THE HOOKS OBEY, read first. The tool is pre-allowed, so
  // without this it would be a second path off the machine in a repository the
  // user marked private: nothing is sent and nothing is paid.
  const off = await routerOff(deps);
  if (off !== null) return fail('needs_input', off, { nextStep: ROUTER_OFF_NEXT_STEP });
  const query = (args.query ?? '').trim().slice(0, 8_000);
  const { input } = args;
  if (query.length === 0 && input === undefined) {
    return fail(
      'needs_input',
      'A request needs a query naming the task, its inputs and any constraints.',
    );
  }
  // THE HOOKS NEVER SEE THIS CALL, so the native hook's rule applies here too: a
  // query the mask would change is not sent, masked or otherwise. The server
  // stores it against the id and the provider logs it, and an injected page can
  // write it.
  if (mask(query) !== query) {
    return fail('native', 'the query carries a credential-shaped value, so nothing was sent');
  }
  // The same rule for a discovered service's input, which goes to the seller
  // as the request body or its query string.
  if (input !== undefined) {
    // The server builds the call from the service that id named, so an input
    // with no id has nothing to go to.
    if (args.id === undefined || args.id.length === 0) {
      return fail(
        'needs_input',
        'An input goes with the id from the line that named the service; send both.',
      );
    }
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
      return fail('needs_input', `The input is over ${MAX_INPUT_BYTES} bytes; send a smaller one.`);
    }
    // EVERY KEY AND STRING LEAF, masked on its own: in the serialized JSON a
    // key after an escaped `\n` reads as one word (`nsk-ant-…`), so the
    // boundaries the mask anchors on are not there.
    if (JSON.stringify(maskDeep(input)) !== serialized) {
      return fail('native', 'the input carries a credential-shaped value, so nothing was sent');
    }
  }
  // THE FOOTER, OPENED FIRST AND TRUSTED WITH NOTHING: it shows this lookup in
  // the terminal while it runs, resolved to a session through the hook's own
  // binding for `id`, and every call on it swallows its own failure.
  const footer = await openLookupFooter(deps.ctx.dataDir, {
    ...(args.id !== undefined && args.id.length > 0 ? { id: args.id } : {}),
  });
  await footer.routing();
  const settings = await resolveContextSettings(deps.ctx);
  // SETTLEMENTS EARLIER CALLS LEFT UNKNOWN, resolved a few at a time from the
  // chain, BESIDE the lookup and never in front of it: a slow or rate-limited
  // RPC costs this call nothing, and a record it could not answer for waits
  // `RECHECK_MS` before it is asked about again. Its own errors are its own.
  void reconcilePayments(deps.ctx.dataDir, {
    rpcUrl: settings.rpcUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }).catch(() => undefined);
  const local = await boundJevgrepGrant(deps.ctx, deps.cwd ?? process.cwd(), args.id, query);
  if (!local && (await isJevgrepOffer(deps.ctx.dataDir, args.id))) {
    await footer.done('needs_input');
    return fail(
      'needs_input',
      'This local retrieval offer is no longer authorized. Use native tools.',
    );
  }
  const decisionDeps = {
    jevgrep: local !== null,
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    acceptsBazaar: settings.experimentalBazaar,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  // ONE CALL, ONE DECISION. The query the model wrote goes to the backend with
  // the turn id when it has one; the backend binds the query to the service
  // that id offered, or decides from the query and the stored packet when there
  // is no id. Nothing is fetched by id and nothing is waited for: an id the
  // backend does not know is its own plain note, and the decision still runs
  // from the query.
  const fresh = await requestDecision(
    'tool',
    {
      ...(query.length > 0 ? { query } : {}),
      ...(args.id !== undefined && args.id.length > 0 ? { id: args.id } : {}),
      ...(input !== undefined ? { input } : {}),
    },
    decisionDeps,
  );
  if (fresh.status === 'failed') {
    await footer.done('failed');
    return fail('failed', fresh.reason, {
      ...(fresh.errorCode !== undefined ? { errorCode: fresh.errorCode } : {}),
    });
  }
  const { decision, note } = fresh.decision;

  // A SERVICE NOBODY CURATED, named for the host to judge. Nothing is paid on
  // this answer: the server's own line says how to call it, with the id it
  // minted and the input the host builds, and that second call pays through
  // the execute path below like any other.
  if (decision.action === 'discovered') {
    await footer.done('service found');
    const { candidate } = decision;
    return {
      isError: false,
      summary: decision.hint,
      envelope: {
        status: 'discovered',
        id: decision.id,
        service: {
          provider: candidate.provider,
          url: candidate.url,
          method: candidate.method,
          description: candidate.description,
          price: `$${toMoney(candidate.providerPriceAtomic).usd}`,
          input: candidate.input,
        },
        cost: costLines(0n),
        ...(note !== undefined ? { note } : {}),
        providerContentUntrusted: true,
      },
    };
  }

  if (decision.action !== 'execute') {
    await footer.done(decision.action === 'native' ? 'native' : 'needs_input');
    // Both non-execute arms carry diagnostics by construction now: an answer
    // without them does not parse, so there is nothing to fall back to here.
    return fail(
      decision.action === 'native' ? 'native' : 'needs_input',
      decision.reason ?? 'The router did not select a paid capability.',
      { diagnostics: decision.diagnostics, ...(note !== undefined ? { note } : {}) },
    );
  }

  if (
    (deps.expectedExecutor !== undefined || local !== null) &&
    (decision.capabilityId !== (deps.expectedExecutor ?? 'jevgrep-search-v1') ||
      !('executor' in decision.contract) ||
      decision.contract.executor !== (deps.expectedExecutor ?? 'jevgrep-search-v1'))
  ) {
    await footer.done('native');
    return fail(
      'native',
      'The router did not return the local executor this hook authorized. Use native tools.',
    );
  }

  if ('executor' in decision.contract) {
    if (!local || !args.id || decision.contract.query !== query) {
      await footer.done('needs_input');
      return fail(
        'needs_input',
        'Local retrieval requires a fresh hook offer bound to this approved repository and unchanged query.',
      );
    }
    await footer.calling({ provider: 'Jevgrep' });
    const result = await executeJevgrep(local, args.id, query, deps);
    await footer.done(result.envelope.status === 'fulfilled' ? 'fulfilled' : 'failed');
    return result;
  }
  if (!('providerPriceAtomic' in decision)) return fail('failed', 'Invalid HTTP pricing.');
  const contract = decision.contract;
  const refusal = checkContract(contract);
  if (refusal !== null) {
    await footer.done(refusal.status);
    return fail(refusal.status, refusal.reason);
  }

  // The decision's advertised price caps the live 402, refused before signing.
  // It bounds a provider or stale catalog charging over that price, and an
  // injected `request` call; it does not bound a hostile server, which can
  // still quote up to `maxAutoSpend`. `gateSpend` stays the money authority.
  // What the ledger records as sent: the host's input, or its query.
  const sent = input !== undefined ? JSON.stringify(maskDeep(input)) : query;
  const terms: AdvertisedTerms = {
    source: decision.provider,
    maxAmountAtomic: decision.providerPriceAtomic,
  };

  try {
    // The request is the server's, sent verbatim: the only thing built here is
    // the decision about whether to send it.
    const built = contract.request;
    // WHAT IS ABOUT TO BE CALLED, named while it is being called. This is the
    // executed destination, not the hint's suggestion, which is the whole point
    // of showing it.
    await footer.calling({ provider: built.url, ...paramsOf(contract) });
    const paid = await runPay(
      {
        url: built.url,
        method: built.method,
        headers: built.headers,
        ...(built.body !== undefined ? { rawBody: built.body } : {}),
        terms,
        execution: 'router',
        requestKey: `${decision.capabilityId}:${canonicalHash(contract.arguments ?? {})}`,
        ...(contract.resultSchema !== undefined ? { resultSchema: contract.resultSchema } : {}),
        printBody: true,
      },
      deps.ctx,
      {
        ...(deps.payDeps ?? {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
        authorizer: deps.payDeps?.authorizer ?? deps.authorizer,
        confirm: async () => false,
      },
    );
    const data = paid.data as {
      bodyText?: string;
      /** A binary body's bytes and type, kept whole by the provider leg. */
      bodyBytes?: Uint8Array;
      contentType?: string;
      /** From the payment-response header, when the seller sent one. */
      settlementTxHash?: string;
      authorization?: SignedAuthorization;
      amountPaid?: { atomic: string };
      /** Set when the body missed its success rule, or the rule never ran. */
      resultUnverified?: boolean;
      resultCaveat?: string;
    };
    const providerAtomic = BigInt(data.amountPaid?.atomic ?? '0');
    // A FILE IS SAVED, NOT INLINED: its bytes are no use as text in a tool
    // result, so the result names where they are.
    const binary =
      data.bodyBytes !== undefined
        ? await saveBinary(deps.ctx.dataDir, decision.capabilityId, data.bodyBytes, {
            contentType: data.contentType ?? '',
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          })
        : null;
    // AND A PAID MEDIA RESULT THAT LINKS TO ITS FILES brings them home: the
    // links can expire, and the user paid for what is behind them. Only a
    // discovered service (where generated images, audio and video come from)
    // does this: a curated page read or search links whatever the page links,
    // on hosts the page picked. The answer carries no finer media kind, so the
    // category is the line. Best effort only.
    const linked =
      providerAtomic > 0n && binary === null && decision.category === 'discovered'
        ? await saveMedia(
            deps.ctx.dataDir,
            decision.capabilityId,
            mediaUrlsIn(data.bodyText ?? '', MAX_MEDIA_FILES),
            {
              ...(deps.mediaTransport !== undefined ? { transport: deps.mediaTransport } : {}),
              ...(deps.payDeps?.destination !== undefined
                ? { destination: deps.payDeps.destination }
                : {}),
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            },
          )
        : [];
    const savedFiles = [...(binary?.savedTo !== undefined ? [binary.savedTo] : []), ...linked];
    if (providerAtomic > 0n) {
      await appendPaidRecord(
        deps.ctx.dataDir,
        paidRecord(decision, built.url, sent, providerAtomic, {
          ...(data.settlementTxHash !== undefined ? { txHash: data.settlementTxHash } : {}),
          ...(data.authorization !== undefined ? { authorization: data.authorization } : {}),
          savedFiles,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        }),
      );
    }
    const base = {
      supplier: supplierOf(built.url),
      ...(contract.arguments !== undefined ? { parameters: contract.arguments } : {}),
      cost: costLines(providerAtomic),
      ...(data.settlementTxHash !== undefined ? { settlementTxHash: data.settlementTxHash } : {}),
      ...(note !== undefined ? { note } : {}),
      result: binary ?? data.bodyText ?? '',
      ...(savedFiles.length > 0 ? { savedFiles } : {}),
      providerContentUntrusted: true,
    };
    // UNVERIFIED IS NOT FULFILLED. A body that missed its success rule, or
    // that the rule could not be run against, may be exactly the contract
    // failure the rule exists to catch, and a caveat inside a `fulfilled`
    // envelope does not reach code that branches on the status: a provider
    // could pad a broken answer past the validation limit and have it read as
    // a checked, paid result. The body still rides along whole, because the
    // money moved and withholding the product would be a second loss on top
    // of the first.
    const shown = {
      provider: built.url,
      ...paramsOf(contract),
      price: `$${toMoney(providerAtomic.toString()).usd}`,
    };
    if (data.resultUnverified === true) {
      await footer.done('unverified', shown);
      return {
        isError: true,
        summary: `Unverified result from ${base.supplier} · ${base.cost.join(' · ')}`,
        envelope: {
          status: 'unverified',
          ...base,
          ...(data.resultCaveat !== undefined ? { resultCaveat: data.resultCaveat } : {}),
        },
      };
    }
    await footer.done('fulfilled', shown);
    return {
      isError: false,
      summary: `Fulfilled by ${base.supplier} · ${base.cost.join(' · ')}`,
      envelope: { status: 'fulfilled', ...base },
    };
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
    const status = cli?.code === 'POLICY_REFUSED' ? 'needs_approval' : 'failed';
    const reason = cli !== undefined ? `${cli.message} ${cli.fix ?? ''}`.trim() : String(err);
    // A provider failure AFTER transmission carries the amount at risk on its
    // details. Reporting zero there told the model the call was free when the
    // ledger had already counted it.
    const detail = (cli?.details ?? {}) as {
      amountAtomic?: string;
      settlement?: string;
      diagnosis?: Record<string, unknown>;
      status?: number;
      providerError?: string;
      authorization?: SignedAuthorization;
    };
    await footer.done(status, {
      provider: contract.request.url,
      ...paramsOf(contract),
      price: `$${toMoney(detail.amountAtomic ?? '0').usd}`,
    });
    // An authorization that left is a paid call whatever came back: recorded
    // with its settlement unknown, for `tenjin payments reconcile` to resolve.
    if (BigInt(detail.amountAtomic ?? '0') > 0n) {
      await appendPaidRecord(
        deps.ctx.dataDir,
        paidRecord(decision, contract.request.url, sent, BigInt(detail.amountAtomic ?? '0'), {
          ...(detail.authorization !== undefined ? { authorization: detail.authorization } : {}),
          savedFiles: [],
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        }),
      );
    }
    return fail(status, reason, {
      providerAtomic: BigInt(detail.amountAtomic ?? '0'),
      ...(detail.settlement !== undefined ? { settlement: detail.settlement } : {}),
      ...(detail.diagnosis !== undefined ? { diagnosis: detail.diagnosis } : {}),
      // WHY THE PROVIDER SAID NO: its HTTP status and a bounded, redacted
      // snippet of its body, which `runPay` cut. Without them a 403 read the
      // same as a timeout to the agent and to the logs.
      ...(typeof detail.status === 'number' ? { providerStatus: detail.status } : {}),
      ...(typeof detail.providerError === 'string' ? { providerError: detail.providerError } : {}),
    });
  }
}

/** One ledger line for a paid call; the settlement is known only with a tx. */
function paidRecord(
  decision: { capabilityId: string; provider: string },
  url: string,
  sent: string,
  amountAtomic: bigint,
  opts: {
    txHash?: string;
    authorization?: SignedAuthorization;
    savedFiles: string[];
    now?: () => number;
  },
): PaidRecord {
  return {
    version: 1,
    ts: new Date((opts.now ?? Date.now)()).toISOString(),
    capabilityId: decision.capabilityId,
    provider: decision.provider,
    url,
    sent: recordedSent(sent),
    amountAtomic: amountAtomic.toString(),
    ...(opts.txHash !== undefined ? { txHash: opts.txHash } : {}),
    settlement: opts.txHash !== undefined ? 'settled' : 'unknown',
    savedFiles: opts.savedFiles,
    ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
  };
}

/** Extensions for the media types a paid lookup plausibly returns; any other
 *  type, `text/html` from a seller included, is saved as `.bin`. */
const EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/octet-stream': 'bin',
};

export function extensionFor(contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return EXTENSIONS[type] ?? 'bin';
}

/**
 * Write a binary body under the data dir as `<capability>-<timestamp>.<ext>`
 * and say where: the path, the type and the size are what the host needs to
 * use it. The name is built from characters a path segment can always hold.
 *
 * NEVER THROWS. The money has already moved when this runs, and a throw here
 * would reach the failure arm, which reports nothing paid; a file that could
 * not be written is said so beside the amount instead.
 */
async function saveBinary(
  dataDir: string,
  capabilityId: string,
  bytes: Uint8Array,
  opts: { contentType: string; now?: () => number },
): Promise<{ savedTo?: string; saveError?: string; contentType: string; bytes: number }> {
  const described = { contentType: opts.contentType, bytes: bytes.byteLength };
  try {
    const file = await createUniqueFile(
      downloadsDir(dataDir),
      `${capabilityId.slice(0, 80)}-${(opts.now ?? Date.now)()}`,
      extensionFor(opts.contentType),
    );
    try {
      await writeAll(file.handle, bytes);
    } finally {
      await file.handle.close();
    }
    return { savedTo: file.path, ...described };
  } catch (err) {
    return { saveError: err instanceof Error ? err.message : String(err), ...described };
  }
}

type FailStatus = 'failed' | 'needs_approval' | 'needs_input' | 'native';

function checkContract(contract: DecisionContract): { status: FailStatus; reason: string } | null {
  const built = contract.request;
  if (built.method !== 'GET' && built.method !== 'POST') {
    return {
      status: 'failed',
      reason: `This build executes GET and POST only, not ${built.method}.`,
    };
  }
  const header = unsafeHeader(built.headers);
  if (header !== null) {
    return {
      status: 'failed',
      reason: `The decision sets a header this build will not send: ${header}`,
    };
  }
  if (built.method === 'GET' && built.body !== undefined) {
    return { status: 'failed', reason: 'The decision puts a body on a GET.' };
  }
  // The arguments are NOT re-validated here. The server binds them against the
  // capability's own schema and builds `request` from the result; this client
  // never re-encodes them, so a second check against a schema the answer no
  // longer carries would be checking a copy of somebody else's rule.
  if (contract.resultSchema !== undefined) {
    try {
      assertResultSchema(contract.resultSchema);
    } catch (err) {
      return {
        status: 'failed',
        reason: `The decision's success rule is unusable: ${String(err)}`,
      };
    }
  }
  try {
    // Parsed above every signature: a URL the paying leg cannot read is a
    // refusal here, never a throw from inside it.
    new URL(built.url);
  } catch {
    return { status: 'failed', reason: 'The decision names a URL this build cannot parse.' };
  }
  return null;
}

/**
 * The only headers a routing decision may put on the wire. Authentication,
 * transport and payment headers are this client's to set or nobody's, so a
 * decision naming one is refused rather than quietly filtered.
 */
const SENDABLE_HEADERS = new Set(['accept', 'content-type']);

function unsafeHeader(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (!SENDABLE_HEADERS.has(name.toLowerCase())) return name;
    if (value.length > 1_024 || /[\r\n]/.test(value)) return name;
  }
  return null;
}

/** The decision's own arguments, for the footer, or nothing to show. */
function paramsOf(contract: DecisionContract): { parameters?: unknown } {
  return contract.arguments !== undefined ? { parameters: contract.arguments } : {};
}

function supplierOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown service';
  }
}

/** ONE COST LINE, because there is one payment: the provider's. */
export function costLines(providerAtomic: bigint): string[] {
  return [`provider price ${toMoney(providerAtomic.toString()).usd} USD`];
}

/**
 * ROUTINE CONTROL OUTCOMES, not failures of this tool. A routing decision was
 * delivered and it says the turn continues somewhere else: with the host's own
 * tools, with a question for the user, or with an approval the user gives. The
 * MCP error flag is for what went WRONG, and raising it on these three put a
 * red box in front of the user on the most ordinary answer the router has.
 */
const ROUTINE: ReadonlySet<FailStatus> = new Set(['native', 'needs_input', 'needs_approval']);

const ROUTER_OFF_NEXT_STEP =
  'Continue with your own tools. Nothing was sent to the router and nothing was bought.';

/**
 * Why the router is off for this directory, naming the key and the file that
 * set it, or null when it is on. A layer that cannot be read is off: a switch
 * the user set must not fail open.
 */
async function routerOff(deps: RequestToolDeps): Promise<string | null> {
  try {
    const { enabled } = await routerSettings({
      cwd: deps.cwd ?? process.cwd(),
      dataDir: deps.ctx.dataDir,
    });
    if (enabled.value) return null;
    return `router.enabled is false in ${enabled.path ?? 'the config'}, so the router is off here.`;
  } catch (err) {
    return `router.enabled could not be read (${err instanceof Error ? err.message : String(err)}), so the router is off here.`;
  }
}

/** One short line saying what the host does next, per routine outcome. */
const NEXT_STEP: Record<string, string> = {
  native: 'Continue with your own tools. Nothing was bought.',
  needs_input:
    'Ask the user for the missing detail, then call `request` again with it. Nothing was bought.',
  needs_approval:
    'Report the command above to the user; this build will not raise a spend limit on its own.',
};

/**
 * The four outcomes the target step splits into, each with the step that
 * actually follows from it. The backend's own `nextAction` wins whenever it
 * sent one; this is what a host is told when the code arrives without it.
 */
const NEXT_STEP_BY_REASON: Record<string, string> = {
  page_target: 'That URL is the lookup itself; call `request` again with the URL as the query.',
  contextual_url:
    'The URL was background, not the target; call `request` again with the question as the query.',
  unresolved_intent:
    'Ask the user for the scope choice or field named above, then call `request` again with it.',
  classifier_failure:
    'The router could not classify this one and charged nothing. Continue with your own tools, or call `request` once more.',
};

interface FailExtras {
  providerAtomic?: bigint;
  settlement?: string;
  /** Which rule failed, whether the body was JSON, its size and a bounded
   *  redacted preview: what tells a parse miss from an HTML error page. */
  diagnosis?: Record<string, unknown>;
  /** The provider's HTTP status on a non-2xx answer. */
  providerStatus?: number;
  /** The start of that answer's body, bounded and redacted. Provider content. */
  providerError?: string;
  /** The backend's own stable error code, from a typed non-2xx body. */
  errorCode?: string;
  /** What stopped a non-execute decision, in the backend's own terms. */
  diagnostics?: DecisionDiagnostics;
  /** The backend's plain sentence about the call itself, such as a dead id. */
  note?: string;
  /** Replaces the generic next step, for an outcome this build decided alone. */
  nextStep?: string;
}

/** The headline: calm for a routine outcome, explicit for a real failure. */
function summaryFor(status: FailStatus, reason: string): string {
  if (status === 'native') return `No paid lookup needed: ${reason}`;
  if (status === 'needs_input') return `More input needed: ${reason}`;
  if (status === 'needs_approval') return `Blocked by spending policy: ${reason}`;
  return `x402 request ${status}: ${reason}`;
}

/** The backend's own instruction, then the one its reasonCode implies, then the
 *  generic one for the outcome. Never empty while any of the three exists. */
function nextStepFor(status: FailStatus, diagnostics: DecisionDiagnostics | undefined): string {
  const fromServer = diagnostics?.nextAction.trim() ?? '';
  if (fromServer.length > 0) return fromServer;
  const byReason =
    diagnostics !== undefined ? NEXT_STEP_BY_REASON[diagnostics.reasonCode] : undefined;
  return byReason ?? NEXT_STEP[status] ?? '';
}

function fail(status: FailStatus, reason: string, extras: FailExtras = {}): RequestToolResult {
  const routine = ROUTINE.has(status);
  const { diagnostics } = extras;
  return {
    isError: !routine,
    summary: summaryFor(status, reason),
    envelope: {
      status,
      reason,
      ...(extras.errorCode !== undefined ? { errorCode: extras.errorCode } : {}),
      // The status is the fact; the next step is what to do about it. The
      // BACKEND'S own next action wins when it sent one: it knows which field
      // is missing.
      ...(routine || diagnostics !== undefined
        ? { nextStep: extras.nextStep ?? nextStepFor(status, diagnostics) }
        : {}),
      ...(diagnostics !== undefined
        ? {
            reasonCode: diagnostics.reasonCode,
            stage: diagnostics.stage,
            ...(diagnostics.missing.length > 0 ? { missing: diagnostics.missing } : {}),
          }
        : {}),
      // What LEFT, not what was delivered: an authorization that was
      // transmitted is money at risk whether or not a result came back.
      cost: costLines(extras.providerAtomic ?? 0n),
      ...(extras.note !== undefined ? { note: extras.note } : {}),
      ...(extras.settlement !== undefined ? { settlement: extras.settlement } : {}),
      ...(extras.diagnosis !== undefined ? { diagnosis: extras.diagnosis } : {}),
      ...(extras.providerStatus !== undefined ? { providerStatus: extras.providerStatus } : {}),
      ...(extras.providerError !== undefined ? { providerError: extras.providerError } : {}),
      providerContentUntrusted: true,
    },
  };
}

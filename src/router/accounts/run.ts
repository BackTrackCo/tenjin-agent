import { toMoney } from '../../lib/money';
import { defaultExecFor } from '../../lib/os-store';
import { validateResultBody } from '../../lib/request-schema';
import { MAX_CALL_WAIT_MS } from '../jobs';
import { maskDeep, recordAccountRow } from '../paid';
import {
  isAccountSpec,
  requestRefused,
  type AccountOfferSpec,
  type OfferSpec,
  type SpecOutcome,
} from '../decision';
import {
  hashRefusal,
  rulesNow,
  UNREADABLE,
  type ReadableWire,
  type SettingsRefusal,
} from '../settings-check';
import { personalSettingsAt } from '../settings';
import { mergedInput, specInputProblems, specText, uncheckedWarning } from '../spec-call';
import {
  claimSpecPayment,
  settleAccountRun,
  storeAccountOffer,
  storeSpecs,
  type KeptAccountSpec,
  type KeptSpec,
} from '../specs';
import { openLookupFooter, type LookupFooter } from '../progress';
import {
  costLines,
  deliverResult,
  fail,
  paidRecord,
  reportOutcome,
  runSpec,
  settingsFail,
  showSpec,
  unsavedWords,
  type DeliverCall,
  type FailExtras,
  type FailStatus,
  type ReportDeps,
  type RequestToolDeps,
  type RequestToolResult,
} from '../tool';
import { runAccountCall, type AccountRun, type AccountRunDeps, type Resume } from './call';
import type { RefusalReason } from './credential';
import { endAccountJob, keepAccountJob, readAccountJob, type AccountJob } from './jobs';
import { accountLacks } from './presence';
import { savedAccount } from './saved';
import { readVaultHeader } from './vault';

/**
 * A SERVICE ON THE USER'S CONNECTED ACCOUNT, RUN FROM ITS SPEC (plan 37). The
 * same steps a spec the balance pays takes, in the same order, with the
 * account in place of the payment:
 *
 * 1. The input against the spec, locally.
 * 2. The check before every call: the offer's settings hash is the hash of
 *    the rules saved now (`settings-check.ts`), and the account is still
 *    connected here. A map Tenjin has not checked runs only when the user
 *    named it (`request({tool})` by its id).
 * 3. One claim per offer id, before anything is sent, so a retry or a race
 *    never sends the billing call twice.
 * 4. The check again at the call boundary, then the call on the account
 *    (`call.ts`), with the credential in its headers.
 * 5. The result, checked against the spec's success rule, cut to the fields it
 *    promises with the whole saved, its files saved, a ledger row kept with
 *    the account as its source, and a receipt: "Apify · your account · 20
 *    places". The limits on the Tenjin balance are not touched: the account's
 *    own plan pays.
 *
 * WHEN THE ACCOUNT REFUSES (its sign-in expired, its plan or rate limit ran
 * out), or its job fails, the call stops with the reason and how to fix it,
 * and asks Tenjin again for the same job with that account left out
 * (`{refused: <offer id>}`, on the paid route like any answer). An offer back
 * is named with its price, as the next step the user picks; nothing is
 * charged until they pick. Only where the user opted in for that account
 * (`tenjin config fallback on --source <id>`) does it run in the account's
 * place, and the receipt says so. A call that ran and failed is never
 * switched: the account may already have billed for it.
 */

type Json = Record<string, unknown>;

/** The account's name and who to reconnect, for every sentence below. */
interface Named {
  id: string;
  label: string;
}

/** Why a call on an account stopped, as {@link refusalWords} says it: a
 *  refusal, a tool the account lacks, or the account's own error answer. */
export type StopReason = RefusalReason | 'missing' | 'declined';

/** A refusal in words: what happened, and the user's own way out of it, as a
 *  sentence (`fix`) and as the same step without its full stop (`step`).
 *  `retryIn`: the way out is only to wait that long. */
export interface RefusalWords {
  said: string;
  fix: string;
  step: string;
  retryIn?: 'minute' | 'moment';
}

const worded = (said: string, step: string, retryIn?: 'minute' | 'moment'): RefusalWords => ({
  said,
  fix: `${step}.`,
  step,
  ...(retryIn !== undefined ? { retryIn } : {}),
});

/** What a refusal says, and the user's own way out of it. */
export function refusalWords(
  reason: StopReason,
  account: Named,
  detail: string | undefined,
): RefusalWords {
  const { label, id } = account;
  const reconnect = `Reconnect with \`tenjin connect ${id}\``;
  switch (reason) {
    case 'signin_expired':
      return worded(`Your ${label} sign-in has expired.`, reconnect);
    case 'not_connected':
      return worded(
        `${label} isn't connected on this machine.`,
        `Connect it with \`tenjin connect ${id}\``,
      );
    case 'store_locked':
      return worded(
        `Tenjin couldn't read your ${label} sign-in: your keychain didn't answer.`,
        'Unlock the keychain, then try again',
      );
    case 'credit':
      return worded(
        `Your ${label} account's plan or credit has run out.`,
        `Add credit or change the plan at ${label}`,
      );
    case 'rate_limited':
      return worded(
        `Your ${label} account is over its rate limit right now.`,
        'Try again in a minute',
        'minute',
      );
    case 'busy': {
      const said = `Another Tenjin process was refreshing your ${label} sign-in and didn't finish.`;
      return detail !== undefined
        ? worded(said, `Try again; if no other Tenjin process is running, remove ${detail} first`)
        : worded(said, 'Try again in a moment', 'moment');
    }
    case 'unreachable':
      return worded(
        `Tenjin couldn't reach your ${label} account.`,
        'Try again in a moment',
        'moment',
      );
    case 'missing':
      return worded(
        `This ${label} account doesn't have what this job needs: a tool it calls was missing when it was connected.`,
        `If the account changed since, ${reconnect.toLowerCase()}`,
      );
    case 'declined':
      return worded(
        `Your ${label} account answered with an error; its answer is in providerError.`,
        'Check the input, or the account itself',
      );
  }
}

/** Refusals Tenjin's tool may stand in for automatically, for an account the
 *  user opted in for, when nothing ran: never one the account's own answer
 *  gave, which may have. */
const SWITCHABLE: ReadonlySet<string> = new Set(['signin_expired', 'credit', 'rate_limited']);

/** Answers that ran nothing: a routine stop before anything was sent or paid. */
const RAN_NOTHING: ReadonlySet<string> = new Set(['native', 'needs_input', 'needs_approval']);

/** Whether a result ran nothing: the settings check, a missing input or an
 *  approval to give stopped it before anything was sent or paid. */
export function ranNothing({ envelope }: RequestToolResult): boolean {
  return RAN_NOTHING.has(String(envelope.status));
}

/**
 * A result in this module's own words: its headline and cost line, never the
 * generic ones a paid call's failure carries. `ran: 'maybe'`: the call
 * reached the account's job with no result to show it billed (still running,
 * failed after the job started, or answered with the account's own error),
 * so its plan may have charged for it; "nothing charged" is only for a call
 * that never reached the account's job. `routed`: a re-ask went to the paid
 * route, so the cost line says what any routing answer says, and never that
 * nothing was charged.
 */
export function accountResult(
  status: FailStatus,
  summary: string,
  reason: string,
  label: string,
  extras: FailExtras & { extra?: Json; ran?: 'maybe'; routed?: boolean },
): RequestToolResult {
  const { extra, ran, routed, ...rest } = extras;
  const base = fail(status, reason, rest);
  return {
    ...base,
    summary,
    envelope: {
      ...base.envelope,
      cost:
        ran === 'maybe'
          ? [
              routed === true
                ? `your ${label} plan may have charged for this`
                : `your ${label} plan may have charged for this, not the Tenjin balance`,
            ]
          : routed === true
            ? costLines(0n)
            : ['nothing charged'],
      ...extra,
    },
  };
}

/** What a call on the account would do if the agent sent it again. */
const runsAgain = (label: string) =>
  `Don't call again for this: it would run on your ${label} account again.`;

/**
 * A RESULT THE ACCOUNT FINISHED THAT THIS MACHINE COULD NOT SAVE, in the words
 * a paid take's is ({@link unsavedWords}). With its `job` kept, nothing
 * ended: the answer is the job, running, and a pick-up sends only the free
 * reads that fetch it again. With none (a call with no follow-up, a tool the
 * user named, a job this machine could not keep), the result as it came,
 * saying so.
 */
export function unsavedAnswer(
  label: string,
  delivered: RequestToolResult,
  why: string,
  job?: { id: string; parameters: unknown },
): RequestToolResult {
  const finished = `Your ${label} account finished it`;
  if (job !== undefined) {
    const words = unsavedWords(finished, why, { job: job.id });
    return accountResult('needs_input', words.summary, words.summary, label, {
      nextStep: words.nextStep,
      parameters: job.parameters,
      ran: 'maybe',
      extra: { status: 'running', job: job.id },
    });
  }
  const words = unsavedWords(finished, why, {
    otherwise: `Tell the user why it was not saved. ${runsAgain(label)}`,
  });
  return {
    ...delivered,
    summary: `${delivered.summary}\n${words.summary}`,
    envelope: { ...delivered.envelope, note: words.said, nextStep: words.nextStep },
  };
}

/** The re-ask's offer, as a refusal names it, with its price and its spec. */
function offerWords(offer: OfferSpec): {
  said: string;
  next: string;
  spec: string;
  envelope: Json;
} {
  const price = offer.priceVaries
    ? `up to $${toMoney(offer.maxAmountAtomic).usd}`
    : `$${toMoney(offer.priceAtomic).usd}`;
  const name = offer.label ?? offer.provider;
  const id = JSON.stringify(offer.id);
  return {
    said: `Tenjin has ${name} for ${price}: request({id: ${id}, input}) to run it.`,
    next: `If the user picks Tenjin's tool, call request({id: ${id}, input: {...}}) with the inputs above.`,
    spec: specText(offer.id, offer),
    envelope: { offer: { id: offer.id, label: name, price } },
  };
}

/** The agent's input, kept to the fields the offer takes, when that is an
 *  input it takes whole: what an automatic switch may send. */
function fittedInput(input: Json, offer: OfferSpec): Json | undefined {
  const properties = offer.input.properties;
  if (properties === null || typeof properties !== 'object') return undefined;
  const kept = Object.fromEntries(
    Object.entries(input).filter(([name]) => Object.hasOwn(properties, name)),
  );
  const problems = specInputProblems(offer, mergedInput(offer, kept));
  return problems !== undefined && problems.length === 0 ? kept : undefined;
}

/** Where a run's outcome is told and its re-ask goes: the call's routing. */
export type RouteDeps = ReportDeps & { acceptsBazaar?: boolean };

/**
 * THE RE-ASK (plan 37, review round 1): the account refused offer `refused`,
 * so Tenjin is asked again for the same job with that account left out for
 * this one answer (`{refused}`, {@link requestRefused}), under the settings
 * saved now, on the paid route like any answer. An offer back is kept as the
 * one made in that offer's place ({@link runInPlaceOf}) and returned.
 * Anything else (native, a skip, a failure, another account's map) is no
 * offer: the refusal stands as the account's own error. `routed`: the re-ask
 * went out and was not skipped, so its routing fee may have been paid. Never
 * throws.
 */
async function reask(
  refused: string,
  deps: RequestToolDeps,
  routing: RouteDeps,
): Promise<{ offer: KeptSpec | null; routed: boolean }> {
  const { dataDir } = deps.ctx;
  const here = await personalSettingsAt(dataDir).catch(() => undefined);
  if (here?.wire.status !== 'ok') return { offer: null, routed: false };
  const route = deps.route?.(routing.baseUrl);
  const answer = await requestRefused(refused, {
    ctx: deps.ctx,
    baseUrl: routing.baseUrl,
    acceptsBazaar: routing.acceptsBazaar === true,
    harness: routing.harness ?? 'claude',
    settings: here.wire.settings,
    ...(routing.fetchImpl !== undefined ? { fetchImpl: routing.fetchImpl } : {}),
    ...(route !== undefined ? { route } : {}),
  }).catch(() => null);
  const routed = answer?.status !== 'skipped';
  if (answer?.status !== 'decided') return { offer: null, routed };
  const { decision, settingsHash } = answer.decision;
  if (decision.action !== 'spec' || isAccountSpec(decision.spec)) return { offer: null, routed };
  const offer: OfferSpec = { ...decision.spec, id: decision.id };
  await storeSpecs(dataDir, [offer], settingsHash, { replaces: refused });
  return { offer: { ...offer, ...(settingsHash !== undefined ? { settingsHash } : {}) }, routed };
}

/**
 * `request({id, input})` FOR AN OFFER MADE IN A REFUSED ACCOUNT OFFER'S PLACE
 * (the re-ask's). The refused offer is held while it runs and, once it may
 * have run, settled as switched to it: the account's billing call for that
 * job never goes out too (Greptile G1, adapted). A refused offer already
 * claimed (running, or run) is left as it is.
 */
export async function runInPlaceOf(
  refused: string,
  id: string,
  run: () => Promise<RequestToolResult>,
  dataDir: string,
): Promise<RequestToolResult> {
  const held = (await claimSpecPayment(dataDir, refused)) === null;
  let result: RequestToolResult;
  try {
    result = await run();
  } catch (err) {
    if (held) await settleAccountRun(dataDir, refused, false);
    throw err;
  }
  if (held) await settleAccountRun(dataDir, refused, ranNothing(result) ? false : { to: id });
  return result;
}

/** Where the account's own seams come from: the deps in tests, the platform
 *  otherwise. */
export function runDeps(deps: RequestToolDeps): AccountRunDeps {
  const now = deps.now ?? Date.now;
  const started = deps.startedAt ?? now();
  const seams = deps.accounts ?? {};
  return {
    dataDir: deps.ctx.dataDir,
    exec: seams.exec ?? defaultExecFor(),
    ...(seams.platform !== undefined ? { platform: seams.platform } : {}),
    ...(seams.openSession !== undefined ? { openSession: seams.openSession } : {}),
    ...(seams.lockTimeoutMs !== undefined ? { lockTimeoutMs: seams.lockTimeoutMs } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.onPoll !== undefined ? { onPoll: deps.onPoll } : {}),
    // A host that waits for jobs waits for the map's own bound; any other
    // gets this call's, and a resume for the rest.
    deadline: deps.waitsForJobs === true ? Number.POSITIVE_INFINITY : started + MAX_CALL_WAIT_MS,
  };
}

/** The account a spec runs on: its name, the server its sign-in is for, and
 *  what the user chose for when it refuses. */
async function accountOf(
  spec: { source: string; provider: string },
  dataDir: string,
): Promise<Named & { mcpUrl?: string; onRefusal?: 'tenjin'; saved: boolean }> {
  const id = spec.source;
  const saved = await savedAccount(dataDir, id);
  const header = await readVaultHeader(dataDir, id).catch(() => null);
  return {
    id,
    label: saved?.label ?? spec.provider,
    ...(header !== null ? { mcpUrl: header.mcpUrl } : {}),
    ...(saved?.onRefusal !== undefined ? { onRefusal: saved.onRefusal } : {}),
    saved: saved !== undefined,
  };
}

type Account = Awaited<ReturnType<typeof accountOf>>;

/** An offer on an account comes only from an answer decided under the
 *  settings, whose `sources` named it: one that echoed no hash never runs. */
const UNCONFIRMED: SettingsRefusal = {
  code: 'settings_unconfirmed',
  reason:
    "Tenjin's router did not confirm it applied your Tenjin settings to this offer on your own account, so it was not run and nothing was sent.",
  nextStep:
    'Call request again with the query (request({query})) for an offer under the current settings.',
};

/**
 * THE CHECK BEFORE AN ACCOUNT'S CALL, read now from local state alone: the
 * rules the offer was decided under are the ones saved, it was decided under
 * them at all, and the account is still connected here ({@link connection}).
 * A refusal sends nothing to the account.
 */
async function accountCheck(
  spec: { source: string; settingsHash?: string },
  account: Account,
  dataDir: string,
): Promise<{ settings: SettingsRefusal } | { reason: 'not_connected' } | null> {
  const now = await rulesNow(dataDir);
  if ('problem' in now) return { settings: UNREADABLE };
  const stale = hashRefusal(now.wire, spec.settingsHash);
  if (stale !== null) return { settings: stale };
  if (spec.settingsHash === undefined) return { settings: UNCONFIRMED };
  return connection(spec, account, now.wire);
}

/**
 * WHETHER THE ACCOUNT IS STILL CONNECTED HERE: its descriptor saved, its
 * sign-in on this machine, and named to the router in `wire`, the settings
 * saved now (a caller refuses settings that can't be read before it asks:
 * nothing is guessed). Local only.
 */
function connection(
  spec: { source: string },
  account: Account,
  wire: ReadableWire,
): { reason: 'not_connected' } | null {
  if (!account.saved || account.mcpUrl === undefined) return { reason: 'not_connected' };
  if (!wire.settings.sources.includes(spec.source)) return { reason: 'not_connected' };
  return null;
}

/** `request({id})` for an account service: its spec, with who pays. */
export async function showAccountSpec(
  id: string,
  spec: AccountOfferSpec,
  dataDir: string,
  hint?: string,
): Promise<RequestToolResult> {
  const { label } = await accountOf(spec, dataDir);
  const lines = [specText(id, spec, label)];
  if (hint !== undefined) lines.push(`Next: ${hint}`);
  return {
    isError: false,
    summary: lines.join('\n'),
    envelope: {
      status: 'spec',
      id,
      nextStep:
        hint ?? `Call request({id: ${JSON.stringify(id)}, input: {...}}) with the inputs above.`,
      cost: ['nothing charged'],
    },
  };
}

/**
 * AN ACCOUNT SERVICE A QUERY OR A TOOL ID PICKED, kept and shown, unless the
 * connect-time check found this account lacks a tool its call makes: then it
 * is left out, Tenjin is asked again with the account left out ({@link
 * reask}), and an offer back is shown in its place, from the balance like any
 * other. Nothing is sent to the account. `named`: the user asked for this
 * service by its id, the one way a map Tenjin has not checked may run.
 */
export async function offerAccountLead(
  lead: AccountOfferSpec,
  settingsHash: string | undefined,
  deps: RequestToolDeps,
  routing: RouteDeps,
  hint?: string,
  opts: { named?: true } = {},
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  if (!(await accountLacks(dataDir, lead))) {
    await storeAccountOffer(dataDir, lead, settingsHash, opts);
    return showAccountSpec(lead.id, lead, dataDir, hint);
  }
  const account = await accountOf(lead, dataDir);
  const words = refusalWords('missing', account, undefined);
  const { offer, routed } = await reask(lead.id, deps, routing);
  if (offer === null) {
    const reason = `${words.said} Nothing was sent.`;
    return accountResult('native', reason, reason, account.label, {
      nextStep: `Continue with your own tools. ${words.fix}`,
      routed,
    });
  }
  const shown = showSpec(offer.id, offer);
  const note = `${words.said} Tenjin's own tool for this task is below, paid from the Tenjin balance.`;
  return { ...shown, summary: `${note}\n${shown.summary}`, envelope: { ...shown.envelope, note } };
}

/** What one run carries to the end of it: the offer, the account, the
 *  input, and where its outcome is told and its re-ask goes. */
interface Run {
  id: string;
  spec: KeptAccountSpec;
  account: Account;
  /** The agent's input, before the pins: what an automatic switch fits. */
  input: Json;
  /** The merged input: what the account's call is filled from. */
  merged: Json;
  /** The merged input, masked: what is shown and recorded. */
  sentInput: Json;
  deps: RequestToolDeps;
  footer: LookupFooter;
  reportDeps: RouteDeps;
  startedAt: number;
  /** This call holds the offer's claim, not yet settled: a refusal settles
   *  it once it knows whether the re-ask's offer ran in the account's place. */
  claimed?: boolean;
}

const report = (at: Run, outcome: Omit<SpecOutcome, 'id' | 'ms'>) =>
  reportOutcome(
    at.reportDeps,
    at.id,
    at.deps.via !== undefined ? { ...outcome, via: at.deps.via } : outcome,
    at.startedAt,
  );

const shownOf = (at: Run) => ({
  provider: at.account.label,
  ...(at.spec.label !== undefined ? { label: at.spec.label } : {}),
  parameters: at.sentInput,
});

/** The settings check's refusal, told to the footer and the server. */
async function refusedBySettings(at: Run, refusal: SettingsRefusal): Promise<RequestToolResult> {
  report(at, { status: 'unpaid', reason: 'terms' });
  await at.footer.done('needs_input');
  return settingsFail(refusal);
}

/**
 * `request({id, input})` FROM AN ACCOUNT SERVICE'S SPEC. `kept.named` says
 * the user asked for the service by its id.
 */
export async function runAccountSpec(
  id: string,
  spec: KeptAccountSpec,
  kept: { named?: true },
  input: Json,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: RouteDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const merged = mergedInput(spec, input);
  const at: Run = {
    id,
    spec,
    account: await accountOf(spec, dataDir),
    input,
    merged,
    sentInput: maskDeep(merged) as Json,
    deps,
    footer,
    reportDeps,
    startedAt: Date.now(),
  };
  const { account, sentInput } = at;

  // 1. THE INPUT, locally: every problem and the whole spec, nothing sent.
  const problems = specInputProblems(spec, merged);
  if (problems === undefined) {
    report(at, { status: 'unpaid', reason: 'terms' });
    await footer.done('failed');
    const reason = `The spec for ${spec.provider} has an input schema this build cannot check, so nothing was sent to your ${account.label} account.`;
    return accountResult('failed', reason, reason, account.label, {
      nextStep: 'Continue with your own tools.',
      parameters: sentInput,
    });
  }
  if (problems.length > 0) {
    report(at, { status: 'unpaid', reason: 'input' });
    await footer.done('needs_input');
    const reason = `The input does not fit ${spec.provider}: ${problems.join('; ')}.`;
    return accountResult(
      'needs_input',
      `More input needed: ${reason}\n\n${specText(id, spec, account.label)}`,
      reason,
      account.label,
      {
        nextStep: `Fix the input from the spec above and call request({id: ${JSON.stringify(id)}, input: {...}}) again; nothing was sent.`,
        parameters: sentInput,
      },
    );
  }

  // 2. THE CHECK BEFORE EVERY CALL, and the account still connected here.
  const checked = await accountCheck(spec, account, dataDir);
  if (checked !== null && 'settings' in checked) return refusedBySettings(at, checked.settings);
  if (checked !== null) return refusal(at, checked.reason, false);
  // A MAP TENJIN HAS NOT CHECKED runs only when the user named it.
  if (!spec.verified && kept.named !== true) {
    report(at, { status: 'unpaid', reason: 'terms' });
    await footer.done('needs_input');
    const reason = `Tenjin hasn't checked ${spec.label ?? spec.provider} on your ${account.label} account yet, so it runs only when the user asks for it by name. Nothing was sent.`;
    return accountResult('needs_input', reason, reason, account.label, {
      nextStep: `If the user asks for it by name, call request({tool: ${JSON.stringify(spec.capabilityId)}}) for its spec and run that. Otherwise continue with your own tools.`,
    });
  }
  // THE CONNECT-TIME CHECK found this account lacks a tool its call makes:
  // refused here, with nothing sent.
  if (await accountLacks(dataDir, spec)) return refusal(at, 'missing', false);

  // 3. ONE RUN PER OFFER, claimed before anything is sent.
  const earlier = await claimSpecPayment(dataDir, id);
  if (earlier !== null) {
    await footer.done('needs_input');
    const job = await readAccountJob(dataDir, id);
    const reason =
      job !== null
        ? `This offer already went to your ${account.label} account, and its job is kept on this machine, so nothing was sent again.`
        : earlier.state === 'account'
          ? `This offer was already sent to your ${account.label} account at ${earlier.at}, so nothing was sent again. Its answer is in the earlier request result for this id.`
          : earlier.state === 'switched'
            ? `Tenjin's own tool already ran this job at ${earlier.at}, in your ${account.label} account's place, so nothing was sent to the account. Its answer is in the earlier request result for this id.`
            : earlier.state === 'unrecorded'
              ? `This machine could not record this call, so nothing was sent to your ${account.label} account.`
              : "A call for this offer already started, so nothing was sent again. Use that call's result.";
    const again = `For another call, send request({query}) for a new offer; this id (${id}) runs once.`;
    return accountResult('needs_input', reason, reason, account.label, {
      nextStep:
        job !== null
          ? `Call request({job: ${JSON.stringify(id)}}) for its result; nothing is sent to the account again.`
          : earlier.state === 'switched'
            ? `If Tenjin's tool was still running, call request({job: ${JSON.stringify(earlier.to)}}) for its result. ${again}`
            : again,
    });
  }
  at.claimed = true;

  // 4. THE CHECK AGAIN, right before the account is called: a rule saved or
  // the account disconnected while this call was being set up stops it here.
  const boundary = await accountCheck(spec, account, dataDir);
  if (boundary !== null) {
    await settleAccountRun(dataDir, id, false);
    at.claimed = false;
    if ('settings' in boundary) return refusedBySettings(at, boundary.settings);
    return refusal(at, boundary.reason, false);
  }
  await footer.calling(shownOf(at));
  const run = await runAccountCall({ id: account.id, label: account.label }, spec.mcp, merged, {
    ...runDeps(deps),
    // THE JOB IS KEPT AS SOON AS IT STARTED, with its ledger row: a process
    // that exits mid-poll leaves a job `request({job})` picks up, never a
    // paid result nobody can reach.
    onStarted: async (started) => {
      await keepJob(at, started);
      await keepAccountRow(at);
    },
  });
  // THE CLAIM STAYS for anything the account may have run, its own error
  // answer included; arguments it would not take free the id for a retry
  // after the fix. A refusal of a call that never ran is settled by
  // `refusal`, which knows whether the re-ask's offer ran in its place.
  if (run.kind !== 'refused') {
    await settleAccountRun(dataDir, id, run.kind !== 'input');
    at.claimed = false;
  }
  return finish(run, at);
}

/** How a run ended, delivered: a result, a refusal, still running, or failed. */
async function finish(run: AccountRun, at: Run): Promise<RequestToolResult> {
  const { id, spec, account, sentInput, footer } = at;
  const { dataDir } = at.deps.ctx;
  switch (run.kind) {
    case 'refused':
      return refusal(at, run.reason, run.sent, run.detail);
    case 'declined':
      await keepAccountRow(at);
      return refusal(at, run.reason ?? 'declined', true, run.detail, { answered: true });
    case 'input': {
      report(at, { status: 'unpaid', reason: 'input' });
      await footer.done('needs_input', shownOf(at));
      const reason = `Your ${account.label} account didn't take this input; its answer is in providerError.`;
      return accountResult(
        'needs_input',
        `More input needed: ${reason}\n\n${specText(id, spec, account.label)}`,
        reason,
        account.label,
        {
          providerError: run.detail,
          nextStep: `Fix the input and call request({id: ${JSON.stringify(id)}, input: {...}}) again; nothing ran.`,
          parameters: sentInput,
        },
      );
    }
    case 'running': {
      const kept = await keepJob(at, run);
      await keepAccountRow(at);
      report(at, { status: 'running' });
      await footer.done('running', { ...shownOf(at), price: 'your account' });
      // SAID AS IT HAPPENED: done but its result didn't come back, not
      // checked on, or still running once the wait ran out.
      const { label } = account;
      const stopped =
        run.reason !== undefined ? refusalWords(run.reason, account, run.detail) : undefined;
      const lead =
        run.finished === true
          ? `Your ${label} job finished, but its result didn't come back.`
          : stopped !== undefined || run.providerError !== undefined
            ? `Tenjin couldn't check on your ${label} job.`
            : `Still running on your ${label} account.`;
      // "Couldn't reach" would only repeat "couldn't check on".
      const repeats = run.finished !== true && run.reason === 'unreachable';
      const why =
        (repeats ? undefined : stopped?.said) ??
        (run.providerError !== undefined && run.reason === undefined
          ? `Your ${label} account answered with an error; it's in providerError.`
          : undefined);
      const pickUp = `request({job: ${JSON.stringify(id)}}) for its result; nothing is sent to the account again.`;
      const soon = stopped?.retryIn;
      const next = !kept
        ? `This machine could not keep the job, so it can't be picked up here. ${runsAgain(label)}`
        : soon !== undefined
          ? `In a ${soon}, call ${pickUp}`
          : stopped !== undefined
            ? `${stopped.fix} Then call ${pickUp}`
            : `Call ${pickUp}`;
      const summary = [lead, why, next].filter((s) => s !== undefined).join(' ');
      return accountResult('needs_input', summary, summary, label, {
        nextStep: next,
        parameters: sentInput,
        ran: 'maybe',
        ...(run.providerError !== undefined ? { providerError: run.providerError } : {}),
        extra: { status: 'running', ...(kept ? { job: id } : {}) },
      });
    }
    case 'failed': {
      await endAccountJob(dataDir, id);
      await keepAccountRow(at);
      report(at, { status: 'failed' });
      await footer.done('failed', { ...shownOf(at), price: 'your account' });
      // THE RE-ASK, offered for the user to pick, never run in its place:
      // the account may already have billed for this job.
      const { offer: offered, routed } = await reask(id, at.deps, at.reportDeps);
      const offer = offered !== null ? offerWords(offered) : undefined;
      const reason = `Your ${account.label} account ran this, but ${run.why}. It may have billed your ${account.label} plan.`;
      return accountResult(
        'failed',
        `${reason}${offer !== undefined ? ` ${offer.said}\n\n${offer.spec}` : ''}`,
        reason,
        account.label,
        {
          ...(run.detail !== undefined ? { providerError: run.detail } : {}),
          nextStep: `Tell the user it may have run on their ${account.label} account; don't call it again for this.${offer !== undefined ? ` ${offer.next}` : ''}`,
          parameters: sentInput,
          ran: 'maybe',
          routed,
          ...(offer !== undefined ? { extra: offer.envelope } : {}),
        },
      );
    }
    case 'done':
      return delivered(run, at);
  }
}

/** Keep the run's job for `request({job})`, from its billing call's result. */
function keepJob(at: Run, started: Resume): Promise<boolean> {
  return keepAccountJob(at.deps.ctx.dataDir, {
    version: 1,
    offerId: at.id,
    spec: stripKept(at.spec),
    input: at.merged,
    first: started.first,
    firstAt: started.firstAt,
  });
}

/** A kept job's spec carries no offer id or hash of its own: the job's are. */
function stripKept(spec: KeptAccountSpec): AccountJob['spec'] {
  const rest: Partial<Pick<KeptAccountSpec, 'id' | 'settingsHash'>> & AccountJob['spec'] = {
    ...spec,
  };
  delete rest.id;
  delete rest.settingsHash;
  return rest;
}

/** The run as delivering and the ledger see it. */
function callOf(at: Run): DeliverCall {
  const { id, spec, account, sentInput } = at;
  return {
    capabilityId: spec.capabilityId,
    provider: spec.provider,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    // In a native call's place (`swap.ts`): kept on its ledger row.
    ...(at.deps.via !== undefined ? { via: at.deps.via } : {}),
    media: spec.output === 'media',
    parameters: sentInput,
    sent: JSON.stringify(sentInput),
    ...(spec.outputSchema !== undefined ? { project: { id, schema: spec.outputSchema } } : {}),
    request: { url: account.mcpUrl ?? '' },
  };
}

/** THE OFFER'S ONE LEDGER ROW, kept once its billing call may have billed the
 *  account (still running, failed, or answered with its own error), so usage
 *  and payments show it as may have charged; a resumed job that delivers
 *  finishes that row. */
async function keepAccountRow(at: Run): Promise<void> {
  const call = callOf(at);
  await recordAccountRow(at.deps.ctx.dataDir, {
    ...paidRecord(call, call.request.url, call.sent, 0n, {
      savedFiles: [],
      account: at.account.id,
      ...(at.deps.now !== undefined ? { now: at.deps.now } : {}),
    }),
    job: at.id,
    charge: 'unknown',
  });
}

/** A result that came back: checked, cut, saved, recorded and receipted. */
async function delivered(
  run: Extract<AccountRun, { kind: 'done' }>,
  at: Run,
): Promise<RequestToolResult> {
  const { id, spec, account } = at;
  const { dataDir } = at.deps.ctx;
  // THE SUCCESS RULE runs on the whole result; a file is its own proof.
  const check =
    spec.resultSchema !== undefined && run.media.length === 0
      ? validateResultBody(spec.resultSchema, run.text)
      : { valid: true as const };
  const call = callOf(at);
  const done = await deliverResult(
    call,
    at.deps,
    at.footer,
    {
      bodyText: run.text,
      ...(run.media.length > 0 ? { files: run.media } : {}),
      ...(!check.valid
        ? {
            resultUnverified: true,
            ...(check.reason !== undefined ? { resultCaveat: check.reason } : {}),
          }
        : {}),
    },
    {
      providerAtomic: 0n,
      // One row per offer: a job kept on the ledger while it ran is finished.
      ledger: { job: id },
      account: {
        label: account.label,
        source: account.id,
        ...(spec.returns !== undefined ? { returns: spec.returns } : {}),
      },
    },
  );
  // A RESULT NOT SAVED HERE IS NOT AN ENDING, as a paid take's is not
  // (`finishTake`): the account still holds it, so its job stays kept and a
  // pick-up fetches it again with the free reads alone. Ended only once its
  // files are saved.
  if (done.unsaved !== undefined && (await readAccountJob(dataDir, id)) !== null) {
    report(at, { status: 'running' });
    await at.footer.done('running', { ...shownOf(at), price: 'your account' });
    return unsavedAnswer(account.label, done.result, done.unsaved, {
      id,
      parameters: at.sentInput,
    });
  }
  await endAccountJob(dataDir, id);
  report(at, done.outcome);
  const result =
    done.unsaved !== undefined
      ? unsavedAnswer(account.label, done.result, done.unsaved)
      : done.result;
  if (spec.verified) return result;
  // A SERVICE TENJIN HASN'T CHECKED, run because the user named it.
  const warning = uncheckedWarning(account.label);
  return {
    ...result,
    summary: `${result.summary}\n${warning}`,
    envelope: { ...result.envelope, warning },
  };
}

/**
 * THE ACCOUNT REFUSED. The call stops with the reason and the fix, and asks
 * Tenjin again for the job with this account left out ({@link reask}). An
 * offer back is named with its price and runs only when the user picks it,
 * or, for an account they opted in for, in its place now: through the
 * ordinary spec path, with the settings check, the limits and the claim, and
 * a receipt that says so. `sent`: the billing call went out. `answered`: the
 * account's own error answered it, so its job may have started; the offer
 * then never runs in its place automatically, which could bill the job twice.
 * Not for an account no longer connected here: the router answers that
 * re-ask with nothing, so it is not paid for.
 *
 * IN A NATIVE CALL'S PLACE (`deps.via`, the swap), the offer never runs in
 * its place automatically: the swap ran the account's pick under the
 * automatic-use checks, which the offer has not met. The refusal and the
 * offer are the answer.
 */
async function refusal(
  at: Run,
  reason: StopReason,
  sent: boolean,
  detail?: string,
  opts: { answered?: boolean } = {},
): Promise<RequestToolResult> {
  const { account, footer } = at;
  report(at, {
    status: 'unpaid',
    reason: reason === 'unreachable' ? 'unreachable' : reason === 'missing' ? 'terms' : 'provider',
  });
  const words = refusalWords(reason, account, detail);
  const answered = opts.answered === true;
  const { offer, routed } =
    reason === 'not_connected'
      ? { offer: null, routed: false }
      : await reask(at.id, at.deps, at.reportDeps);
  const switchable =
    !answered &&
    at.deps.via === undefined &&
    SWITCHABLE.has(reason) &&
    account.onRefusal === 'tenjin' &&
    offer !== null;
  const fitted = switchable ? fittedInput(at.input, offer) : undefined;
  if (switchable && fitted !== undefined) {
    // THE USER'S OWN CHOICE FOR THIS ACCOUNT: the offer, in its place,
    // checked, limited and claimed on its own.
    const switched = await runSpec(offer.id, offer, fitted, at.deps, footer, at.reportDeps);
    // ONE JOB, ONE CLAIM: once the offer may have run it, this offer stays
    // claimed and names the one that ran, so a replay never sends the
    // account's billing call for a job already done and paid.
    const ran = !ranNothing(switched);
    await settleRefused(at, ran ? { to: offer.id } : false);
    const note = `${words.said} Tenjin ran its own tool for this job instead, as you set for ${account.label}.`;
    return {
      ...switched,
      summary: `${note}\n${switched.summary}`,
      envelope: {
        ...switched.envelope,
        switched: { from: account.label, to: offer.label ?? offer.provider, reason },
        note,
      },
    };
  }
  // Nothing ran on either: the id is free for a retry after the fix.
  await settleRefused(at, false);
  await footer.done('needs_input', shownOf(at));
  // What the account said, and, when the call never reached it, that nothing
  // was sent: never a claim about charges, since the re-ask may have paid.
  const text = sent
    ? words.said
    : `${words.said} Nothing was sent to your ${account.label} account.`;
  const refused = { account: account.label, reason, reconnect: `tenjin connect ${account.id}` };
  if (switchable && fitted === undefined) {
    // OPTED IN, BUT THE OFFER TAKES OTHER INPUTS: the agent fills them from
    // its spec and runs it now, with no question for the user.
    const fid = JSON.stringify(offer.id);
    return accountResult(
      'needs_input',
      `${text} You set Tenjin's tool to stand in when ${account.label} refuses, and it takes other inputs:\n\n${specText(offer.id, offer)}`,
      text,
      account.label,
      {
        nextStep: `The user chose Tenjin's tool for when ${account.label} refuses: call request({id: ${fid}, input: {...}}) now with the inputs above, without asking. ${words.fix}`,
        parameters: at.sentInput,
        routed,
        extra: { refused, ...offerWords(offer).envelope, switching: true },
      },
    );
  }
  const named = offer !== null ? offerWords(offer) : undefined;
  return accountResult(
    'needs_input',
    `${text} ${words.fix}${named !== undefined ? ` ${named.said}\n\n${named.spec}` : ''}`,
    text,
    account.label,
    {
      nextStep:
        named !== undefined
          ? `Ask the user whether to fix it (${words.step}) or use Tenjin's tool instead. ${named.next}`
          : `Tell the user: ${words.fix} Otherwise continue with your own tools.`,
      parameters: at.sentInput,
      ...(answered && detail !== undefined ? { providerError: detail } : {}),
      ...(answered ? { ran: 'maybe' as const } : {}),
      routed,
      extra: { refused, ...(named?.envelope ?? {}) },
    },
  );
}

/** The claim this call still holds, settled once, by the refusal path. */
async function settleRefused(at: Run, ran: false | { to: string }): Promise<void> {
  if (at.claimed !== true) return;
  at.claimed = false;
  await settleAccountRun(at.deps.ctx.dataDir, at.id, ran);
}

/**
 * `request({job})` FOR A JOB ON THE USER'S ACCOUNT: only its follow-up runs,
 * from the billing call's kept result. Nothing that bills is sent again.
 *
 * A CALL ALREADY SENT CAN'T BE UNSENT (plan 36): the restriction applies to
 * calls that have not started. This job's billing call went out, and the
 * user's plan may already have paid for it, so a rule saved since (a changed
 * settings hash) does not stop the free reads that fetch its result:
 * refusing them would only lose what was paid for. What still stops them is
 * what makes sending the credential wrong: the account is no longer connected
 * here ({@link connection}; the job is kept for a reconnect), or the settings
 * can't be read.
 */
export async function resumeAccountJob(
  job: AccountJob,
  deps: RequestToolDeps,
  reportDeps: RouteDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const footer = await openLookupFooter(dataDir, { id: job.offerId });
  await footer.routing();
  const spec: KeptAccountSpec = { ...job.spec, id: job.offerId };
  const at: Run = {
    id: job.offerId,
    spec,
    account: await accountOf(spec, dataDir),
    input: job.input,
    merged: job.input,
    sentInput: maskDeep(job.input) as Json,
    deps,
    footer,
    reportDeps,
    startedAt: Date.now(),
  };
  const resume: Resume = { first: job.first, firstAt: job.firstAt };
  const now = await rulesNow(dataDir);
  const checked =
    'problem' in now ? { settings: UNREADABLE } : connection(spec, at.account, now.wire);
  if (checked !== null && 'settings' in checked) {
    // The job stays kept: once the settings are fixed, the same call picks it up.
    await footer.done('needs_input');
    const { label } = at.account;
    const reason = `${checked.settings.reason} Tenjin did not check the job on your ${label} account again.`;
    return accountResult('needs_input', reason, reason, label, {
      nextStep: `${checked.settings.nextStep} Once they're fixed, call request({job: ${JSON.stringify(job.offerId)}}) for its result; nothing is sent to the account again.`,
      ran: 'maybe',
    });
  }
  await footer.calling(shownOf(at));
  const run: AccountRun =
    checked !== null
      ? { kind: 'running', ...resume, reason: 'not_connected' }
      : await runAccountCall(
          { id: at.account.id, label: at.account.label },
          spec.mcp,
          job.input,
          runDeps(deps),
          resume,
        );
  return finish(run, at);
}

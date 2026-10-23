import { toMoney } from '../../lib/money';
import { defaultExecFor } from '../../lib/os-store';
import { validateResultBody } from '../../lib/request-schema';
import { MAX_CALL_WAIT_MS } from '../jobs';
import { maskDeep } from '../paid';
import { policyAtBoundary } from '../admit';
import type { AccountOfferSpec, OfferSpec, SpecOutcome } from '../decision';
import { mergedInput, specInputProblems, specText, uncheckedWarning } from '../spec-call';
import { claimSpecPayment, readSpec, settleAccountRun } from '../specs';
import { openLookupFooter, type LookupFooter } from '../progress';
import {
  accountCost,
  admitExecution,
  deliverResult,
  fail,
  refusedByPolicy,
  reportOutcome,
  routeOf,
  runSpec,
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
import { savedAccount } from './saved';
import { readVaultHeader } from './vault';

/**
 * A SERVICE ON THE USER'S CONNECTED ACCOUNT, RUN FROM ITS SPEC (#37). The same
 * steps a spec the balance pays takes, in the same order, with the account in
 * place of the payment:
 *
 * 1. The input against the spec, locally.
 * 2. The user's settings (#36's {@link admitExecution}): a block wins, and an
 *    account service runs only while its account is connected here.
 * 3. One claim per offer id, before anything is sent, so a retry or a race
 *    never sends the billing call twice.
 * 4. The rules again at the call boundary, then the call on the account
 *    (`call.ts`), with the credential in its headers.
 * 5. The result, checked against the spec's success rule, cut to the fields it
 *    promises with the whole saved, its files saved, a ledger row kept with
 *    the account as its source, and a receipt: "Apify · your account · 20
 *    places". The limits on the Tenjin balance are not touched: the account's
 *    own plan pays.
 *
 * WHEN THE ACCOUNT REFUSES (its sign-in expired, its plan or rate limit ran
 * out), the call stops with the reason, how to fix it, and Tenjin's own tool
 * for the same job with its price, as the next step the user picks (decision
 * 1A). Only where the user opted in for that account does Tenjin's tool run in
 * its place, and the receipt says so. A call that ran and failed is never
 * switched: the account may already have billed for it.
 */

type Json = Record<string, unknown>;

/** The account's name and who to reconnect, for every sentence below. */
interface Named {
  id: string;
  label: string;
}

/** What a refusal says, and the user's own way out of it. */
function refusalWords(
  reason: RefusalReason | 'missing' | 'declined',
  account: Named,
  detail: string | undefined,
): { said: string; fix: string } {
  const { label, id } = account;
  const reconnect = `Reconnect with \`tenjin connect ${id}\`.`;
  switch (reason) {
    case 'signin_expired':
      return { said: `Your ${label} sign-in has expired.`, fix: reconnect };
    case 'not_connected':
      return {
        said: `${label} isn't connected on this machine.`,
        fix: `Connect it with \`tenjin connect ${id}\`.`,
      };
    case 'store_locked':
      return {
        said: `Tenjin couldn't read your ${label} sign-in: your keychain didn't answer.`,
        fix: 'Unlock the keychain, then try again.',
      };
    case 'credit':
      return {
        said: `Your ${label} account's plan or credit has run out.`,
        fix: `Add credit or change the plan at ${label}.`,
      };
    case 'rate_limited':
      return {
        said: `Your ${label} account is over its rate limit right now.`,
        fix: 'Try again in a minute.',
      };
    case 'busy':
      return {
        said: `Another Tenjin process was refreshing your ${label} sign-in and didn't finish.`,
        fix:
          detail !== undefined
            ? `Try again; if no other Tenjin process is running, remove ${detail} first.`
            : 'Try again in a moment.',
      };
    case 'unreachable':
      return {
        said: `Tenjin couldn't reach your ${label} account.`,
        fix: 'Try again in a moment.',
      };
    case 'missing':
      return {
        said: `This ${label} account doesn't have what this job needs: its tool was missing when it was connected.`,
        fix: `If the account changed since, ${reconnect.toLowerCase()}`,
      };
    case 'declined':
      return {
        said: `Your ${label} account didn't run this; its answer is in providerError.`,
        fix: 'Check the input, or the account itself.',
      };
  }
}

/** Refusals where nothing ran and Tenjin's tool may stand in automatically,
 *  for an account the user opted in for. */
const SWITCHABLE: ReadonlySet<string> = new Set(['signin_expired', 'credit', 'rate_limited']);

/** A result in this module's own words: its headline and cost line, never the
 *  generic ones a paid call's failure carries. */
function accountResult(
  status: FailStatus,
  summary: string,
  reason: string,
  label: string,
  extras: FailExtras & { extra?: Json; ran?: boolean },
): RequestToolResult {
  const { extra, ran, ...rest } = extras;
  const base = fail(status, reason, rest);
  return {
    ...base,
    summary,
    envelope: {
      ...base.envelope,
      cost: ran === true ? accountCost(label) : ['nothing charged'],
      ...extra,
    },
  };
}

/** Tenjin's own route for the job, as a refusal offers it. */
function fallbackOffer(fallback: OfferSpec): { words: string; next: string; envelope: Json } {
  const price = fallback.priceVaries
    ? `up to $${toMoney(fallback.maxAmountAtomic).usd}`
    : `$${toMoney(fallback.priceAtomic).usd}`;
  const name = fallback.label ?? fallback.provider;
  const id = JSON.stringify(fallback.id);
  return {
    words: `Tenjin's own tool for this job (${name}) costs ${price} from the Tenjin balance.`,
    next: `If the user picks Tenjin's tool, call request({id: ${id}}) for its inputs, then request({id: ${id}, input: {...}}).`,
    envelope: { fallback: { id: fallback.id, label: name, price } },
  };
}

/** The agent's input, kept to the fields Tenjin's route takes, when that is
 *  an input it takes whole: what an automatic switch may send. */
function fittedInput(input: Json, fallback: OfferSpec): Json | undefined {
  const properties = fallback.input.properties;
  if (properties === null || typeof properties !== 'object') return undefined;
  const kept = Object.fromEntries(
    Object.entries(input).filter(([name]) => Object.hasOwn(properties, name)),
  );
  const problems = specInputProblems(fallback, mergedInput(fallback, kept));
  return problems !== undefined && problems.length === 0 ? kept : undefined;
}

/** Where the account's own seams come from: the deps in tests, the platform
 *  otherwise. */
function runDeps(deps: RequestToolDeps): AccountRunDeps {
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

/** The account a spec runs on: its name, and the server its sign-in is for. */
async function accountOf(
  spec: AccountOfferSpec,
  dataDir: string,
): Promise<Named & { mcpUrl?: string; onRefusal?: 'tenjin'; missing: string[] }> {
  const id = spec.identity.source;
  const saved = await savedAccount(dataDir, id);
  const header = await readVaultHeader(dataDir, id).catch(() => null);
  return {
    id,
    label: saved?.label ?? spec.provider,
    ...(header !== null ? { mcpUrl: header.mcpUrl } : {}),
    ...(saved?.onRefusal !== undefined ? { onRefusal: saved.onRefusal } : {}),
    missing: header?.missing ?? [],
  };
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

/** What one run carries to the end of it: the offer, the account, Tenjin's
 *  route for the job, the input, and where its outcome is told. */
interface Run {
  id: string;
  spec: AccountOfferSpec;
  account: Account;
  fallback: OfferSpec | null;
  fallbackId?: string;
  /** The agent's input, before the pins: what an automatic switch fits. */
  input: Json;
  /** The merged input: what the account's call is filled from. */
  merged: Json;
  /** The merged input, masked: what is shown and recorded. */
  sentInput: Json;
  deps: RequestToolDeps;
  footer: LookupFooter;
  reportDeps: ReportDeps;
  startedAt: number;
}

type Account = Awaited<ReturnType<typeof accountOf>>;

const report = (at: Run, outcome: Omit<SpecOutcome, 'id' | 'ms'>) =>
  reportOutcome(at.reportDeps, at.id, outcome, at.startedAt);

const shownOf = (at: Run) => ({
  provider: at.account.label,
  ...(at.spec.label !== undefined ? { label: at.spec.label } : {}),
  parameters: at.sentInput,
});

/**
 * `request({id, input})` FROM AN ACCOUNT SERVICE'S SPEC. `fallbackId` names
 * Tenjin's own route for the job, kept beside it.
 */
export async function runAccountSpec(
  id: string,
  spec: AccountOfferSpec,
  fallbackId: string | undefined,
  input: Json,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const merged = mergedInput(spec, input);
  const at: Run = {
    id,
    spec,
    account: await accountOf(spec, dataDir),
    fallback: fallbackId !== undefined ? await readSpec(dataDir, fallbackId) : null,
    ...(fallbackId !== undefined ? { fallbackId } : {}),
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

  // 2. THE USER'S SETTINGS: a block, an only rule, and the account connected.
  const admitted = await admitExecution([routeOf(spec.identity)], deps, reportDeps);
  if ('refused' in admitted) {
    await footer.done(String(admitted.refused.envelope.status));
    return admitted.refused;
  }
  // THE CONNECT-TIME CHECK found this account lacks the job's tool: refused
  // here, with nothing sent.
  if (account.missing.includes(spec.identity.service)) return refusal(at, 'missing', false);
  if (account.mcpUrl === undefined) return refusal(at, 'not_connected', false);

  // 3. ONE RUN PER OFFER, claimed before anything is sent.
  const earlier = await claimSpecPayment(dataDir, id);
  if (earlier !== null) {
    await footer.done('needs_input');
    const job = await readAccountJob(dataDir, id);
    const reason =
      job !== null
        ? `This offer is still running on your ${account.label} account, so nothing was sent again.`
        : earlier.state === 'account'
          ? `This offer already ran on your ${account.label} account at ${earlier.at}, so nothing was sent again. Its result is in the earlier request result for this id.`
          : earlier.state === 'unrecorded'
            ? `This machine could not record this call, so nothing was sent to your ${account.label} account.`
            : "A call for this offer already started, so nothing was sent again. Use that call's result.";
    return accountResult('needs_input', reason, reason, account.label, {
      nextStep:
        job !== null
          ? `Call request({job: ${JSON.stringify(id)}}) for its result; nothing is sent to the account again.`
          : `For another call, send request({query}) for a new offer; this id (${id}) runs once.`,
    });
  }

  // 4. THE RULES AGAIN, right before the account is called.
  const boundary = await policyAtBoundary(
    [routeOf(spec.identity)],
    admitted.deps.policyRun,
    dataDir,
  );
  if (boundary !== null) {
    await settleAccountRun(dataDir, id, false);
    await footer.done(boundary.status);
    return refusedByPolicy(boundary);
  }
  await footer.calling(shownOf(at));
  const run = await runAccountCall(
    { id: account.id, label: account.label, mcpUrl: account.mcpUrl },
    spec.mcp,
    merged,
    runDeps(deps),
  );
  // THE CLAIM STAYS for anything that went out to the account; a refusal of
  // a call that never ran frees the id for a retry after the fix.
  await settleAccountRun(
    dataDir,
    id,
    run.kind === 'done' || run.kind === 'failed' || run.kind === 'running',
  );
  return finish(run, at);
}

/** How a run ended, delivered: a result, a refusal, still running, or failed. */
async function finish(run: AccountRun, at: Run): Promise<RequestToolResult> {
  const { id, spec, account, fallback, sentInput, footer } = at;
  const { dataDir } = at.deps.ctx;
  switch (run.kind) {
    case 'refused':
      return refusal(at, run.reason, run.sent, run.detail);
    case 'declined':
      return refusal(at, 'declined', true, run.detail);
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
      const kept = await keepAccountJob(dataDir, {
        version: 1,
        offerId: id,
        spec: stripId(spec),
        input: at.merged,
        first: run.first,
        firstAt: run.firstAt,
        ...(at.fallbackId !== undefined ? { fallbackId: at.fallbackId } : {}),
      });
      report(at, { status: 'running' });
      await footer.done('running', { ...shownOf(at), price: 'your account' });
      const stopped =
        run.reason !== undefined ? refusalWords(run.reason, account, run.detail) : undefined;
      const next = kept
        ? `${stopped !== undefined ? `${stopped.fix} Then call` : 'Call'} request({job: ${JSON.stringify(id)}}) for its result; nothing is sent to the account again.`
        : `This machine could not keep the job, so it can't be picked up here. Don't call again for this: it would run on your ${account.label} account again.`;
      const summary = `Still running on your ${account.label} account.${stopped !== undefined ? ` ${stopped.said}` : ''} ${next}`;
      return accountResult('needs_input', summary, summary, account.label, {
        nextStep: next,
        parameters: sentInput,
        ran: true,
        extra: { status: 'running', ...(kept ? { job: id } : {}) },
      });
    }
    case 'failed': {
      await endAccountJob(dataDir, id);
      report(at, { status: 'failed' });
      await footer.done('failed', { ...shownOf(at), price: 'your account' });
      const offer = fallback !== null ? fallbackOffer(fallback) : undefined;
      const reason = `Your ${account.label} account ran this, but ${run.why}. It may have billed your ${account.label} plan; nothing was charged to your Tenjin balance.`;
      return accountResult(
        'failed',
        `${reason}${offer !== undefined ? ` ${offer.words}` : ''}`,
        reason,
        account.label,
        {
          ...(run.detail !== undefined ? { providerError: run.detail } : {}),
          nextStep: `Tell the user it may have run on their ${account.label} account; don't call it again for this.${offer !== undefined ? ` ${offer.next}` : ''}`,
          parameters: sentInput,
          ran: true,
          ...(offer !== undefined ? { extra: offer.envelope } : {}),
        },
      );
    }
    case 'done':
      return delivered(run, at);
  }
}

/** A kept job's spec carries no offer id of its own: the job's id is it. */
function stripId(spec: AccountOfferSpec): AccountJob['spec'] {
  const rest: Partial<Pick<AccountOfferSpec, 'id'>> & AccountJob['spec'] = { ...spec };
  delete rest.id;
  return rest;
}

/** A result that came back: checked, cut, saved, recorded and receipted. */
async function delivered(
  run: Extract<AccountRun, { kind: 'done' }>,
  at: Run,
): Promise<RequestToolResult> {
  const { id, spec, account, sentInput } = at;
  await endAccountJob(at.deps.ctx.dataDir, id);
  // THE SUCCESS RULE runs on the whole result; a file is its own proof.
  const check =
    spec.resultSchema !== undefined && run.media.length === 0
      ? validateResultBody(spec.resultSchema, run.text)
      : { valid: true as const };
  const call: DeliverCall = {
    capabilityId: spec.capabilityId,
    provider: spec.provider,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    identity: spec.identity,
    media: spec.output === 'media',
    parameters: sentInput,
    sent: JSON.stringify(sentInput),
    ...(spec.outputSchema !== undefined ? { project: { id, schema: spec.outputSchema } } : {}),
    request: { url: account.mcpUrl ?? '' },
  };
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
      ledger: 'append',
      account: {
        label: account.label,
        ...(spec.returns !== undefined ? { returns: spec.returns } : {}),
      },
    },
  );
  report(at, done.outcome);
  if (spec.verified) return done.result;
  // A SERVICE TENJIN HASN'T CHECKED, run because the user named it.
  const warning = uncheckedWarning(account.label);
  return {
    ...done.result,
    summary: `${done.result.summary}\n${warning}`,
    envelope: { ...done.result.envelope, warning },
  };
}

/**
 * THE ACCOUNT REFUSED, AND NOTHING RAN ON IT. The call stops with the reason
 * and the fix, and offers Tenjin's own tool for the job with its price, which
 * runs only when the user picks it, or, for an account they opted in for, in
 * its place now: through the ordinary spec path, with the user's settings,
 * limits and claim, and a receipt that says so. `sent`: the billing call went
 * out and the account refused it.
 */
async function refusal(
  at: Run,
  reason: RefusalReason | 'missing' | 'declined',
  sent: boolean,
  detail?: string,
): Promise<RequestToolResult> {
  const { account, fallback, footer } = at;
  report(at, {
    status: 'unpaid',
    reason: reason === 'unreachable' ? 'unreachable' : reason === 'missing' ? 'terms' : 'provider',
  });
  const words = refusalWords(reason, account, detail);
  const nothing = sent
    ? 'Nothing was charged to your Tenjin balance.'
    : `Nothing was sent to your ${account.label} account, and nothing was charged.`;
  const switchable = SWITCHABLE.has(reason) && account.onRefusal === 'tenjin' && fallback !== null;
  const fitted = switchable ? fittedInput(at.input, fallback) : undefined;
  if (switchable && fitted !== undefined) {
    // THE USER'S OWN CHOICE FOR THIS ACCOUNT: Tenjin's tool, in its place,
    // admitted, limited and claimed on its own.
    const deps: RequestToolDeps = { ...at.deps };
    delete deps.policyRun;
    const switched = await runSpec(fallback.id, fallback, fitted, deps, footer, at.reportDeps);
    const note = `${words.said} Tenjin ran its own tool for this job instead, as you set for ${account.label}.`;
    return {
      ...switched,
      summary: `${note}\n${switched.summary}`,
      envelope: {
        ...switched.envelope,
        switched: { from: account.label, to: fallback.label ?? fallback.provider, reason },
        note,
      },
    };
  }
  await footer.done('needs_input', shownOf(at));
  const offer = fallback !== null ? fallbackOffer(fallback) : undefined;
  const text = `${words.said} ${nothing}`;
  if (switchable) {
    // OPTED IN, BUT TENJIN'S TOOL TAKES OTHER INPUTS: the agent fills them
    // from its spec and runs it now, with no question for the user.
    const fid = JSON.stringify(fallback.id);
    return accountResult(
      'needs_input',
      `${text} You set Tenjin's tool to stand in when ${account.label} refuses, and it takes other inputs:\n\n${specText(fallback.id, fallback)}`,
      text,
      account.label,
      {
        nextStep: `The user chose Tenjin's tool for when ${account.label} refuses: call request({id: ${fid}, input: {...}}) now with the inputs above, without asking. ${words.fix}`,
        parameters: at.sentInput,
        extra: {
          refused: { account: account.label, reason, reconnect: `tenjin connect ${account.id}` },
          ...fallbackOffer(fallback).envelope,
          switching: true,
        },
      },
    );
  }
  return accountResult(
    'needs_input',
    `${text} ${words.fix}${offer !== undefined ? ` ${offer.words}` : ''}`,
    text,
    account.label,
    {
      nextStep:
        offer !== undefined
          ? `Ask the user whether to fix it (${words.fix.replace(/\.$/, '')}) or use Tenjin's tool instead. ${offer.next}`
          : `Tell the user: ${words.fix} Otherwise continue with your own tools.`,
      parameters: at.sentInput,
      ...(reason === 'declined' && detail !== undefined ? { providerError: detail } : {}),
      extra: {
        refused: { account: account.label, reason, reconnect: `tenjin connect ${account.id}` },
        ...(offer?.envelope ?? {}),
      },
    },
  );
}

/**
 * `request({job})` FOR A JOB ON THE USER'S ACCOUNT: only its follow-up runs,
 * from the billing call's kept result. Nothing that bills is sent again.
 */
export async function resumeAccountJob(
  job: AccountJob,
  deps: RequestToolDeps,
  reportDeps: ReportDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const footer = await openLookupFooter(dataDir, { id: job.offerId });
  await footer.routing();
  const spec: AccountOfferSpec = { ...job.spec, id: job.offerId };
  const at: Run = {
    id: job.offerId,
    spec,
    account: await accountOf(spec, dataDir),
    fallback: job.fallbackId !== undefined ? await readSpec(dataDir, job.fallbackId) : null,
    ...(job.fallbackId !== undefined ? { fallbackId: job.fallbackId } : {}),
    input: job.input,
    merged: job.input,
    sentInput: maskDeep(job.input) as Json,
    deps,
    footer,
    reportDeps,
    startedAt: Date.now(),
  };
  const resume: Resume = { first: job.first, firstAt: job.firstAt };
  await footer.calling(shownOf(at));
  const { mcpUrl } = at.account;
  const run: AccountRun =
    mcpUrl === undefined
      ? { kind: 'running', ...resume, reason: 'not_connected' }
      : await runAccountCall(
          { id: at.account.id, label: at.account.label, mcpUrl },
          spec.mcp,
          job.input,
          runDeps(deps),
          resume,
        );
  return finish(run, at);
}

export { readAccountJob };

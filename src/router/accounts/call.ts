import { INPUT_PLACEHOLDER, RESULT_PLACEHOLDER, type AccountCall } from '../decision';
import {
  AccountBadInput,
  AccountLimited,
  AccountRefused,
  openAccountSession,
  type AccountCallResult,
  type AccountSession,
  type AccountTool,
  type OpenAccountSession,
} from './client';
import {
  AccountRefusal,
  accountCredential,
  type AccountCredential,
  type CredentialDeps,
  type RefusalReason,
} from './credential';

/**
 * ONE MAPPED JOB, RUN ON THE USER'S OWN ACCOUNT (#37): the map's call, its
 * follow-up when the first answer does not hold the result, and nothing else.
 *
 * THE ARGUMENTS ARE THE MAP'S TEMPLATE. A value that is exactly `{field}` is
 * that input field's value, of its own JSON type, and the key or array element
 * holding it is dropped when the input leaves it out; one that is exactly
 * `{result.<path>}`, in a follow-up only, is the value at that path in the
 * first call's result, and the call stops there when it is missing. Every
 * other value is sent as written: that is how a map pins a tool's settings.
 *
 * THE CALL THAT BILLS IS SENT ONCE. Only the follow-up's status call repeats,
 * every `everyS` seconds while its result is in `running`, so a job that is
 * still processing is polled and never submitted again. A call this process
 * cannot wait out comes back `running`, with the first result the follow-up
 * needs, for `request({job})` to pick up where it stopped.
 *
 * THE CREDENTIAL RIDES IN THE HEADERS (`credential.ts`), and a 401 is retried
 * once, after a refresh. Everything before the billing call is answered, and
 * every refusal of the billing call itself, ran nothing on the account, which
 * `sent: false` says; a failure after it may have billed the user's plan.
 */

type Json = Record<string, unknown>;

/** A template filled, or the first-result path it needed and did not find. */
export type Filled = { value: Json } | { missing: string };

const DROP = Symbol('drop');
class Missing {
  constructor(readonly path: string) {}
}

/** The value at a dotted path of a result, or undefined. */
export function valueAt(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const name of path.split('.')) {
    if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined;
    if (!Object.hasOwn(at, name)) return undefined;
    at = (at as Json)[name];
  }
  return at;
}

/** Whether a result's value at `path` is one of `values`. */
export function inState(value: unknown, state: { path: string; values: readonly string[] }) {
  const at = valueAt(value, state.path);
  const text =
    typeof at === 'string'
      ? at
      : typeof at === 'number' || typeof at === 'boolean'
        ? String(at)
        : undefined;
  return text !== undefined && state.values.includes(text);
}

function fillValue(template: unknown, input: Json, first: unknown): unknown {
  if (typeof template === 'string') {
    const field = INPUT_PLACEHOLDER.exec(template)?.[1];
    if (field !== undefined) return Object.hasOwn(input, field) ? input[field] : DROP;
    const path = RESULT_PLACEHOLDER.exec(template)?.[1];
    if (path !== undefined) {
      const found = first === undefined ? undefined : valueAt(first, path);
      if (found === undefined) throw new Missing(path);
      return found;
    }
    return template;
  }
  if (Array.isArray(template))
    return template.map((item) => fillValue(item, input, first)).filter((item) => item !== DROP);
  if (template !== null && typeof template === 'object') {
    const out: Json = {};
    for (const [key, item] of Object.entries(template)) {
      const filled = fillValue(item, input, first);
      if (filled !== DROP) out[key] = filled;
    }
    return out;
  }
  return template;
}

/** The map's arguments, filled from the merged input and, in a follow-up,
 *  the first call's result. */
export function fillArgs(template: Json, input: Json, first?: unknown): Filled {
  try {
    return { value: fillValue(template, input, first) as Json };
  } catch (err) {
    if (err instanceof Missing) return { missing: err.path };
    throw err;
  }
}

/** One saved media item from a `content` answer. */
export interface AccountMedia {
  bytes: Uint8Array;
  contentType: string;
}

/** What a tool's answer holds, read as the map says. `text` is the body as
 *  it is delivered and saved: the JSON of `value`, or the joined text items. */
export type ToolRead =
  { value: unknown; text: string; media: AccountMedia[] } | { problem: string };

const textItems = (content: readonly unknown[] | undefined): string[] =>
  (content ?? []).flatMap((item) => {
    const entry = item as { type?: unknown; text?: unknown };
    return entry?.type === 'text' && typeof entry.text === 'string' ? [entry.text] : [];
  });

/** A tool's answer, read as `structured`, `json-text` or `content`. */
export function readResult(result: AccountCallResult, mode: AccountCall['result']): ToolRead {
  if (mode === 'structured') {
    const value = result.structuredContent;
    if (value === undefined) return { problem: 'its answer had no structured result' };
    return { value, text: JSON.stringify(value), media: [] };
  }
  if (mode === 'json-text') {
    const text = textItems(result.content).join('');
    try {
      const value: unknown = JSON.parse(text);
      return { value, text: JSON.stringify(value), media: [] };
    } catch {
      return { problem: 'its answer was not the JSON its map expects' };
    }
  }
  const media: AccountMedia[] = [];
  for (const item of result.content ?? []) {
    const entry = item as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (
      (entry?.type === 'image' || entry?.type === 'audio') &&
      typeof entry.data === 'string' &&
      typeof entry.mimeType === 'string'
    ) {
      media.push({ bytes: Buffer.from(entry.data, 'base64'), contentType: entry.mimeType });
    }
  }
  const text = textItems(result.content).join('\n');
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Plain text stays text.
  }
  return { value, text, media };
}

/** The text of an `isError` answer, bounded: what the account said. */
export function errorText(result: AccountCallResult): string {
  return textItems(result.content).join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** What an account's own error says about why, when it says so plainly. */
export function refusalIn(text: string): RefusalReason | undefined {
  if (
    /\b(unauthori[sz]ed|unauthenticated|invalid (api )?(key|token)|token (has )?expired|expired token|not authenticated|forbidden)\b/i.test(
      text,
    )
  )
    return 'signin_expired';
  if (/\b(rate[ -]?limit(ed)?|too many requests)\b/i.test(text)) return 'rate_limited';
  if (
    /\b(insufficient (credits?|funds|balance)|out of credits?|no credits?|credits? (are |is )?(used up|exhausted|depleted)|quota|payment required|usage limit|plan limit|monthly limit|upgrade your (plan|subscription)|exceeded (your|the) .{0,30}limit)\b/i.test(
      text,
    )
  )
    return 'credit';
  return undefined;
}

export interface AccountRunDeps extends CredentialDeps {
  openSession?: OpenAccountSession;
  sleep?: (ms: number) => Promise<void>;
  /** Told before each status call: the server sends it as progress. */
  onPoll?: () => void | Promise<void>;
  /** When this tool call stops waiting on the account's job. */
  deadline: number;
  /** Each request's own deadline. */
  callTimeoutMs?: number;
}

/** How one run on an account ended. */
export type AccountRun =
  | { kind: 'done'; value: unknown; text: string; media: AccountMedia[] }
  /** Refused before anything ran on the account: nothing to undo. `sent`:
   *  the billing call went out and the account refused it; otherwise nothing
   *  reached the account at all. */
  | { kind: 'refused'; reason: RefusalReason; detail?: string; sent: boolean }
  /** The account would not take the arguments: nothing ran. */
  | { kind: 'input'; detail: string }
  /** The account's own error, on the billing call: nothing ran. */
  | { kind: 'declined'; detail: string }
  /** It ran, or may have, and ended without a result. */
  | { kind: 'failed'; why: string; detail?: string }
  /** It ran and is still working, or this process lost sight of it (the
   *  refusal or error that stopped the follow-up): the follow-up needs `first`. */
  | {
      kind: 'running';
      first: unknown;
      firstAt: number;
      reason?: RefusalReason;
      detail?: string;
    };

/** What a resumed run starts from: the billing call's result, and when. */
export interface Resume {
  first: unknown;
  firstAt: number;
}

const CALL_TIMEOUT_MS = 120_000;

/** The account's session, opened lazily with its credential, and reopened
 *  once with a fresh one when the account answers 401. */
class Connection {
  #session: AccountSession | undefined;
  #credential: AccountCredential | undefined;
  #retried = false;

  constructor(
    private readonly account: { id: string; label: string; mcpUrl: string },
    private readonly deps: AccountRunDeps,
  ) {}

  async open(): Promise<AccountSession> {
    for (;;) {
      try {
        if (this.#session !== undefined) return this.#session;
        this.#credential ??= await accountCredential(
          this.account.id,
          this.account.label,
          this.deps,
        );
        this.#session = await (this.deps.openSession ?? openAccountSession)(
          this.account.mcpUrl,
          this.#credential.headers,
          {
            ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
            timeoutMs: this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS,
          },
        );
        return this.#session;
      } catch (err) {
        await this.#retry(err);
      }
    }
  }

  async call(tool: string, args: Json): Promise<AccountCallResult> {
    for (;;) {
      const session = await this.open();
      try {
        return await session.callTool(tool, args, {
          timeoutMs: this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS,
        });
      } catch (err) {
        await this.#retry(err);
      }
    }
  }

  async list(): Promise<AccountTool[]> {
    for (;;) {
      const session = await this.open();
      try {
        return await session.listTools();
      } catch (err) {
        await this.#retry(err);
      }
    }
  }

  /** A refused credential once more, fresh; anything else is the caller's. */
  async #retry(err: unknown): Promise<void> {
    if (err instanceof AccountRefused) {
      await this.close();
      if (this.#retried) throw new AccountRefusal('signin_expired');
      this.#retried = true;
      this.#credential = await accountCredential(this.account.id, this.account.label, this.deps, {
        ...(this.#credential !== undefined ? { refused: this.#credential.sent } : {}),
      });
      return;
    }
    if (err instanceof AccountLimited)
      throw new AccountRefusal(err.status === 429 ? 'rate_limited' : 'credit');
    throw err;
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    await session?.close().catch(() => undefined);
  }
}

/** The tools an account lists, free, or why it would not list them. */
export async function listAccountTools(
  account: { id: string; label: string; mcpUrl: string },
  deps: AccountRunDeps,
): Promise<{ tools: AccountTool[] } | Extract<AccountRun, { kind: 'refused' }>> {
  const connection = new Connection(account, deps);
  try {
    return { tools: await connection.list() };
  } catch (err) {
    return refusedBy(err, false) as Extract<AccountRun, { kind: 'refused' }>;
  } finally {
    await connection.close();
  }
}

/** What stopped the run before anything ran on the account. */
function refusedBy(err: unknown, sent: boolean): AccountRun {
  if (err instanceof AccountRefusal)
    return {
      kind: 'refused',
      reason: err.reason,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
      sent,
    };
  return { kind: 'refused', reason: 'unreachable', detail: said(err), sent };
}

/** One line of an error, bounded. */
function said(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * RUN `call` ON THE ACCOUNT: the billing call once (or, with `resume`, not at
 * all), then its follow-up. Never throws for anything the account or the
 * network does.
 */
export async function runAccountCall(
  account: { id: string; label: string; mcpUrl: string },
  call: AccountCall,
  input: Json,
  deps: AccountRunDeps,
  resume?: Resume,
  opts: { literal?: boolean } = {},
): Promise<AccountRun> {
  const now = () => deps.now?.() ?? Date.now();
  const connection = new Connection(account, deps);
  try {
    let first: unknown;
    let firstAt: number;
    if (resume !== undefined) {
      ({ first, firstAt } = resume);
    } else {
      // A TOOL THE USER NAMED takes the agent's arguments as written: no map,
      // so nothing in them is a placeholder.
      const args = opts.literal === true ? { value: call.args } : fillArgs(call.args, input);
      if ('missing' in args)
        return { kind: 'failed', why: 'its map reads a result before there is one' };
      // THE SESSION FIRST: a refused credential or a server that does not
      // answer is known before anything that bills is sent.
      try {
        await connection.open();
      } catch (err) {
        return refusedBy(err, false);
      }
      firstAt = now();
      let result: AccountCallResult;
      try {
        result = await connection.call(call.tool, args.value);
      } catch (err) {
        if (err instanceof AccountRefusal) return refusedBy(err, true);
        if (err instanceof AccountBadInput) return { kind: 'input', detail: said(err) };
        // SENT, AND NO ANSWER: it may have run.
        return { kind: 'failed', why: "Tenjin couldn't tell whether it ran", detail: said(err) };
      }
      if (result.isError === true) {
        const detail = errorText(result);
        const reason = refusalIn(detail);
        return reason !== undefined
          ? { kind: 'refused', reason, detail, sent: true }
          : { kind: 'declined', detail };
      }
      const read = readResult(result, call.result);
      if ('problem' in read) return { kind: 'failed', why: read.problem };
      const { next } = call;
      if (next === undefined || (next.when !== undefined && !inState(read.value, next.when)))
        return { kind: 'done', ...read };
      first = read.value;
    }
    return await followUp(connection, call, input, first, firstAt, deps);
  } finally {
    await connection.close();
  }
}

/** The follow-up: its status calls while the job runs, then the call that
 *  fetches the result. Free reads only, so a resume may send them again. */
async function followUp(
  connection: Connection,
  call: AccountCall,
  input: Json,
  first: unknown,
  firstAt: number,
  deps: AccountRunDeps,
): Promise<AccountRun> {
  const now = () => deps.now?.() ?? Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const next = call.next!;
  const running = (stopped?: unknown): AccountRun => ({
    kind: 'running',
    first,
    firstAt,
    ...(stopped instanceof AccountRefusal
      ? {
          reason: stopped.reason,
          ...(stopped.detail !== undefined ? { detail: stopped.detail } : {}),
        }
      : stopped !== undefined
        ? { detail: typeof stopped === 'string' ? stopped : said(stopped) }
        : {}),
  });
  const { poll } = next;
  if (poll !== undefined) {
    const end = firstAt + poll.maxWaitS * 1_000;
    for (let n = 0; ; n += 1) {
      if (n > 0) {
        const at = now() + poll.everyS * 1_000;
        if (at > end)
          return { kind: 'failed', why: `its job didn't finish within ${poll.maxWaitS} seconds` };
        if (at > deps.deadline) return running();
        await sleep(poll.everyS * 1_000);
      }
      await deps.onPoll?.();
      const args = fillArgs(poll.args, input, first);
      if ('missing' in args)
        return {
          kind: 'failed',
          why: `its answer didn't name the job to follow (${args.missing})`,
        };
      let result: AccountCallResult;
      try {
        result = await connection.call(poll.tool, args.value);
      } catch (err) {
        // The job runs on: what stopped is this process's view of it.
        return running(err);
      }
      if (result.isError === true) return running(errorText(result));
      const read = readResult(result, poll.result);
      if ('problem' in read) return { kind: 'failed', why: read.problem };
      if (poll.failed !== undefined && inState(read.value, poll.failed))
        return {
          kind: 'failed',
          why: `its job ended as ${String(valueAt(read.value, poll.failed.path))}`,
        };
      if (!inState(read.value, poll.running)) break;
    }
  }
  const args = fillArgs(next.args, input, first);
  if ('missing' in args)
    return { kind: 'failed', why: `its answer didn't name the result to fetch (${args.missing})` };
  let result: AccountCallResult;
  try {
    result = await connection.call(next.tool, args.value);
  } catch (err) {
    return running(err);
  }
  if (result.isError === true)
    return { kind: 'failed', why: "it couldn't hand back the result", detail: errorText(result) };
  const read = readResult(result, next.result);
  if ('problem' in read) return { kind: 'failed', why: read.problem };
  return { kind: 'done', ...read };
}

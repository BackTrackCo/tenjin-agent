import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, ToolCallResult } from 'claude-code';

import type { TenjinLive, TenjinPaid, TenjinRow } from '../types';

/**
 * THE ROUTER'S PAID LOOKUPS, SHOWN TO THE PERSON. Three surfaces: the request
 * tool's row, the spinner while a paid call runs, and one spend line under a
 * turn that paid. Each says the label, the state and the price, and nothing the
 * model reads: never a description, URL, input JSON, tool id or `x402`.
 *
 * READ ONLY. Everything comes from files the CLI already writes under its data
 * dir, read through `$.fs`; the mod writes nothing there. A file that is
 * missing or not ours makes a surface say less, never something it did not read.
 */

/** Our request tool, under today's install and under the plugin's own server. */
const REQUEST_TOOLS: readonly string[] = [
  'mcp__x402__request',
  'mcp__plugin_tenjin_router__request',
];

const ROWS = { plugin: 'tenjin', key: 'rows' } as const;
const LIVE = { plugin: 'tenjin', key: 'live' } as const;
const TURN = { plugin: 'tenjin', key: 'turn' } as const;
const live = atom(LIVE, []);
const turn = atom(TURN, []);

/** A decision with no label of its own, as the plan names it. */
const UNLABELLED = 'Tenjin lookup';
/** The router's own calls: a spec fetch, and a selection from a query. */
const ROUTER = 'Tenjin';
/** The server's label is up to 32 characters; a provider name is held to it too. */
const LABEL_CHARS = 32;
/** The status line's bound on what a call sends, applied per field here. */
const FIELD_CHARS = 180;
const MAX_FIELDS = 6;
/** The spend ledger's rolling day (`DEFAULT_WINDOW_MS` in the CLI). */
const SPEND_WINDOW_MS = 86_400_000;
/** The CLI's default `sessionBudget`, $5.00. */
const DEFAULT_BUDGET_ATOMIC = '5000000';
/** How far a ledger row's timestamp may sit outside the call that wrote it. */
const LEDGER_SLACK_MS = 2_000;
/** A field whose name says secret is shown masked, whatever its value. */
const SECRET_NAME = /(api[_-]?key|token|secret|passw|authorization|cookie|private[_-]?key)/i;

type Dollar = EngineInterface;
type Json = Record<string, unknown>;

/** The row each status leaves, when no payment did. */
const REFUSALS: Readonly<Record<string, string>> = {
  needs_approval: 'needs approval',
  needs_input: 'needs input',
  native: 'not sent',
  spec: 'no charge',
  discovered: 'no charge',
  fulfilled: 'no charge',
};

/**
 * OUR REQUEST CALL, ONE ROW IN STATE: what it is before it runs, how it ended
 * after. A paid call is live for the spinner while it runs, and what it paid
 * counts toward the turn's spend line.
 */
async function onRequest<E extends { tool_use_id: string }>(
  $: Dollar,
  e: E,
  next: (e: E) => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  const startedAt = await $.clock.now();
  const call = await describeCall($, e);
  const ref = { ...ROWS, id: e.tool_use_id };
  await $.state.set(ref, call.row);
  const running: TenjinLive | null =
    call.row.isPaid && call.priceAtomic !== undefined
      ? { toolUseId: e.tool_use_id, label: call.row.label, priceAtomic: call.priceAtomic }
      : null;
  if (running !== null) await update($, live, (list) => [...list, running]);
  try {
    const ran = await next(e);
    const endedAt = await $.clock.now();
    const settled = await settleCall($, call, ran, startedAt, endedAt);
    await $.state.set(ref, { ...call.row, ...settled.row });
    if (settled.paidAtomic !== undefined) {
      const paid: TenjinPaid = { amountAtomic: settled.paidAtomic };
      await update($, turn, (list) => [...list, paid]);
    }
    return ran;
  } finally {
    if (running !== null) {
      await update($, live, (list) => list.filter((one) => one.toolUseId !== running.toolUseId));
    }
  }
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'mcp__x402__request' }, ($, e, next) => onRequest($, e, next));
  on('tool.call', { tool: 'mcp__plugin_tenjin_router__request' }, ($, e, next) =>
    onRequest($, e, next),
  );

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!REQUEST_TOOLS.includes(e.props.tool)) return next(e);
    const { value: stored } = await $.state.get({ ...ROWS, id: e.props.tool_use_id });
    const row = stored ?? (await describeCall($, { ...asRecord(e.props.input) })).row;
    const outcome =
      row.outcome ??
      (e.props.isRunning
        ? undefined
        : e.props.isInterrupted
          ? 'interrupted'
          : refusalOf(statusOf(textOf(e.props.output)), e.props.isErrored));
    const { Box, Text } = $.ui.resolve(e);
    const header = outcome === undefined ? `Calling ${row.label}…` : row.label;
    const first = outcome ?? row.price;
    return (
      <Box flexDirection="column">
        <Text bold>{header}</Text>
        {first !== undefined && (
          <Box paddingLeft={2}>
            <Text dimColor>{first}</Text>
          </Box>
        )}
        {row.fields.map((field) => (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {field}
            </Text>
          </Box>
        ))}
      </Box>
    );
  });

  // The result block under our own row is the text the model read: the
  // provider's host, the envelope's JSON. The row above already says how it
  // ended, so nothing is drawn here.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!REQUEST_TOOLS.includes(e.props.tool)) return next(e);
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const newest = (await read($, live)).at(-1);
    if (newest === undefined) return next(e);
    return next({
      ...e,
      props: {
        ...e.props,
        word: `Calling ${newest.label}`,
        suffix: `… · $${usd(newest.priceAtomic)}`,
      },
    });
  });

  // A subagent's run raises no `turn.start`, so its paid calls count toward
  // the turn of the main loop that spawned it.
  on('turn.start', async ($, e, next) => {
    await $.state.set(TURN, []);
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const done = await next(e);
    if (e.agentId !== undefined) return done;
    const paid = await read($, turn);
    if (paid.length === 0) return done;
    const line = await spendLine($, paid, await $.clock.now());
    // Another plugin's line beneath the answer stays, with ours after it.
    return { ...done, text: done.text === e.answer ? line : `${done.text}\n${line}` };
  });
};

interface Call {
  row: TenjinRow;
  /** The offer's id, which names its spec and payment record. */
  id?: string;
  priceAtomic?: string;
  capabilityId?: string;
  dataDir: string | null;
}

/**
 * WHAT THE ROW SAYS BEFORE ANYTHING COMES BACK. `{id, input}` with a kept spec
 * is a paid call to that spec's service. `{id}` alone fetches the spec, and
 * `{query}` (with an id or not) asks the server to pick: both are the router's
 * own calls.
 */
async function describeCall($: Dollar, args: Json): Promise<Call> {
  const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  const input = asRecord(args.input);
  const dataDir = await tenjinDataDir($);
  const spec =
    id !== undefined && input !== undefined && dataDir !== null
      ? await readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.json`)
      : null;
  const fields =
    input !== undefined
      ? fieldLines(input)
      : typeof args.query === 'string'
        ? fieldLines({ query: args.query })
        : [];
  if (input === undefined) {
    return { row: { label: ROUTER, isPaid: false, fields }, ...(id ? { id } : {}), dataDir };
  }
  const priceAtomic = atomicOf(spec?.priceAtomic);
  const ceiling = atomicOf(spec?.maxAmountAtomic);
  const varies = spec?.priceVaries === true && ceiling !== undefined;
  const price = varies
    ? `for up to $${usd(ceiling)}`
    : priceAtomic !== undefined
      ? `for $${usd(priceAtomic)}`
      : undefined;
  return {
    row: { label: labelOf(spec), isPaid: true, ...(price ? { price } : {}), fields },
    ...(id !== undefined ? { id } : {}),
    ...(priceAtomic !== undefined ? { priceAtomic } : {}),
    ...(typeof spec?.capabilityId === 'string' ? { capabilityId: spec.capabilityId } : {}),
    dataDir,
  };
}

/**
 * HOW THE CALL ENDED, from the CLI's own records first: the spec's payment
 * record says what left for this id, and the paid ledger says whether it
 * settled. A call with neither paid nothing, and its result's status says why.
 */
async function settleCall(
  $: Dollar,
  call: Call,
  ran: { deny?: string; text?: string; isError?: true },
  startedAt: number,
  endedAt: number,
): Promise<{ row: Partial<TenjinRow>; paidAtomic?: string }> {
  if (ran.deny !== undefined) return { row: { outcome: 'not run' } };
  const status = statusOf(ran.text);
  // These refuse before anything is signed: an earlier payment for the same id
  // must not read as this call's.
  if (status !== undefined && status in REFUSALS && status !== 'fulfilled') {
    return { row: { outcome: refusalOf(status, ran.isError === true) } };
  }
  const { dataDir } = call;
  const payment =
    call.id !== undefined && dataDir !== null
      ? await readJson($, `${dataDir}/progress/specs/${await sha256Hex(call.id)}.paid.json`)
      : null;
  const paidAt = typeof payment?.at === 'string' ? Date.parse(payment.at) : NaN;
  const isThisCall = paidAt >= startedAt - LEDGER_SLACK_MS;
  const paidAtomic =
    isThisCall && payment?.state === 'paid' ? atomicOf(payment.amountAtomic) : undefined;
  const ledger =
    dataDir !== null
      ? await ledgerRow($, dataDir, {
          from: startedAt - LEDGER_SLACK_MS,
          to: endedAt + LEDGER_SLACK_MS,
          ...(call.capabilityId !== undefined ? { capabilityId: call.capabilityId } : {}),
          ...(typeof payment?.txHash === 'string' ? { txHash: payment.txHash } : {}),
        })
      : null;
  const amount = paidAtomic ?? atomicOf(ledger?.amountAtomic);
  // A selection that paid in the same call names its service in the ledger.
  const label =
    !call.row.isPaid && typeof ledger?.provider === 'string'
      ? { label: clean(ledger.provider, LABEL_CHARS) || UNLABELLED }
      : {};
  if (amount !== undefined && BigInt(amount) > 0n) {
    const settlement = ledger?.settlement;
    const outcome =
      settlement === 'not_charged'
        ? 'not charged'
        : `$${usd(amount)} · ${settlement === 'settled' ? 'settled' : 'pending'}`;
    return {
      row: { outcome, ...label },
      ...(settlement === 'not_charged' ? {} : { paidAtomic: amount }),
    };
  }
  if (isThisCall && payment?.state === 'possibly_paid') return { row: { outcome: 'pending' } };
  return { row: { outcome: refusalOf(status, ran.isError === true) } };
}

/** The one ledger row this call wrote: by its transaction when the payment
 *  record names one, else by its service and its time. */
async function ledgerRow(
  $: Dollar,
  dataDir: string,
  match: { from: number; to: number; capabilityId?: string; txHash?: string },
): Promise<Json | null> {
  let text: string;
  try {
    text = await $.fs.read(`${dataDir}/paid/ledger.jsonl`);
  } catch {
    return null;
  }
  const rows = text.split('\n').slice(-200).flatMap(parseLine);
  const byTx =
    match.txHash !== undefined ? rows.findLast((row) => row.txHash === match.txHash) : undefined;
  return (
    byTx ??
    rows.findLast((row) => {
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      const sameService =
        match.capabilityId === undefined || row.capabilityId === match.capabilityId;
      return sameService && at >= match.from && at <= match.to;
    }) ??
    null
  );
}

/**
 * `Tenjin: 2 paid lookups, $0.012 · today $0.05 of $5.00`. Today is the spend
 * ledger's rolling day, counted as the budget counts it: automatic spend
 * committed plus automatic reservations still open.
 */
async function spendLine($: Dollar, paid: readonly TenjinPaid[], now: number): Promise<string> {
  const total = paid.reduce((sum, one) => sum + BigInt(one.amountAtomic), 0n);
  const head = `Tenjin: ${paid.length} paid lookup${paid.length === 1 ? '' : 's'}, $${usd(total.toString())}`;
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return head;
  const spend = await readJson($, `${dataDir}/spend.json`);
  const config = await readJson($, `${dataDir}/config.json`);
  const today = spend !== null && spend.schemaVersion === 2 ? spentToday(spend, now) : undefined;
  if (today === undefined) return head;
  const budget = config?.sessionBudget ?? DEFAULT_BUDGET_ATOMIC;
  const limit = budget === 'none' ? '' : ` of $${usd(atomicOf(budget) ?? DEFAULT_BUDGET_ATOMIC)}`;
  return `${head} · today $${usd(today)}${limit}`;
}

function spentToday(spend: Json, now: number): string | undefined {
  const start = spend.windowStartMs;
  if (typeof start !== 'number') return undefined;
  if (now - start >= SPEND_WINDOW_MS) return '0';
  const committed = atomicOf(spend.automaticCommittedAtomic) ?? atomicOf(spend.committedAtomic);
  if (committed === undefined) return undefined;
  const reservations = Array.isArray(spend.reservations) ? spend.reservations : [];
  const held = reservations.reduce<bigint>((sum, one) => {
    const row = asRecord(one);
    const amount = atomicOf(row?.amountAtomic);
    return row?.mode === 'manual' || amount === undefined ? sum : sum + BigInt(amount);
  }, 0n);
  return (BigInt(committed) + held).toString();
}

/** `TENJIN_DATA_DIR` when set, else `~/.tenjin`, as the CLI resolves it. */
async function tenjinDataDir($: Dollar): Promise<string | null> {
  const override = await $.env.get('TENJIN_DATA_DIR');
  if (override !== undefined && override.length > 0) return override;
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home !== undefined && home.length > 0 ? `${home}/.tenjin` : null;
}

/** The server's `label`, else who is paid, else the plan's static title. */
function labelOf(spec: Json | null): string {
  for (const value of [spec?.label, spec?.provider]) {
    if (typeof value === 'string') {
      const label = clean(value, LABEL_CHARS);
      if (label.length > 0) return label;
    }
  }
  return UNLABELLED;
}

/**
 * The fields sent, one `name: value` line each. A nested object is flattened
 * to dotted names and a list joined, so no line carries JSON. Each line gets
 * the status line's treatment: control and format characters replaced, then
 * bounded. The CLI's own mask never runs in a mod (it needs Node), and it has
 * nothing to do on a call that is sent: the request tool refuses, before
 * sending, any input the mask would change.
 */
function fieldLines(input: Json): string[] {
  const lines: string[] = [];
  const walk = (name: string, value: unknown): void => {
    const nested = asRecord(value);
    if (nested !== undefined) {
      for (const [key, inner] of Object.entries(nested)) walk(name ? `${name}.${key}` : key, inner);
      return;
    }
    lines.push(
      clean(`${name}: ${SECRET_NAME.test(name) ? '[redacted]' : shown(value)}`, FIELD_CHARS),
    );
  };
  walk('', input);
  return lines.length <= MAX_FIELDS
    ? lines
    : [...lines.slice(0, MAX_FIELDS - 1), `+${lines.length - MAX_FIELDS + 1} more fields`];
}

function shown(value: unknown): string {
  if (Array.isArray(value)) {
    const isFlat = value.every((one) => asRecord(one) === undefined && !Array.isArray(one));
    return isFlat ? value.map(String).join(', ') : `${value.length} items`;
  }
  return String(value);
}

/** `sanitize` from the CLI's progress records: what reaches a terminal from
 *  outside is treated as hostile, so control and format characters go. */
function clean(value: string, limit: number): string {
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

/** The request tool's status, the first one its result text names. */
function statusOf(text: string | undefined): string | undefined {
  return text === undefined ? undefined : /"status"\s*:\s*"([a-z_]+)"/.exec(text)?.[1];
}

function refusalOf(status: string | undefined, isErrored: boolean): string {
  if (status !== undefined && status in REFUSALS) return REFUSALS[status] as string;
  return isErrored || status !== undefined ? 'failed' : 'done';
}

/** The text of a stored result, whichever shape the row hands over. */
function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  try {
    return output === undefined ? undefined : JSON.stringify(output);
  } catch {
    return undefined;
  }
}

/**
 * USDC has 6 decimals: `5000` is `$0.005`, `10000` is `$0.01`. Whole cents
 * keep two decimals and anything finer keeps what it has.
 */
function usd(atomic: string): string {
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function atomicOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : undefined;
}

async function readJson($: Dollar, path: string): Promise<Json | null> {
  try {
    return asRecord(JSON.parse(await $.fs.read(path))) ?? null;
  } catch {
    return null;
  }
}

function parseLine(line: string): Json[] {
  try {
    const row = asRecord(JSON.parse(line));
    return row !== undefined ? [row] : [];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** The CLI keys a spec's files by the SHA-256 of the offer's id. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

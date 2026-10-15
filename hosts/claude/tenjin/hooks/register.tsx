import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, ToolCallResult } from 'claude-code';

import type { TenjinLive, TenjinPaid, TenjinRow } from '../types';

/**
 * THE TENJIN MOD: what the router does, shown to the person, and the one
 * permission answer it gives. Surfaces: the request tool's row, the spinner
 * while a paid call runs, a toast and one dim line when a call is paid, one
 * spend line under a turn that paid, the first-run wallet toast, and the
 * prompt hint while the wallet is unfunded. Each says the label, the state and
 * the price, and nothing the model reads: never a description, URL, input
 * JSON, tool id or `x402`.
 *
 * READ ONLY. Everything comes from files the CLI already writes under its data
 * dir, read through `$.fs` (the contract is `src/router/mod-state.ts`); the mod
 * writes nothing there, decides nothing about routing or payment, and never
 * reads a field name, provider, host or category for meaning. A file that is
 * missing or of a version it does not know makes a surface say less, never
 * something it did not read.
 *
 * NOT HERE: prompt rewriting, a deny, a config write, a tool answered in
 * place. Pay once is the request tool's own MCP elicitation, not the mod's.
 */

/** Our request tool, under the plugin's own server. */
const REQUEST_TOOL = 'mcp__plugin_tenjin_router__request';

const ROWS = { plugin: 'tenjin', key: 'rows' } as const;
const LIVE = { plugin: 'tenjin', key: 'live' } as const;
const TURN = { plugin: 'tenjin', key: 'turn' } as const;
const WELCOMED = { plugin: 'tenjin', key: 'welcomed' } as const;
const live = atom(LIVE, []);
const turn = atom(TURN, []);
const welcomed = atom(WELCOMED, false);

/** A decision with no label of its own, as the plan names it. */
const UNLABELLED = 'Tenjin lookup';
/** The router's own calls: a spec fetch, and a selection from a query. */
const ROUTER = 'Tenjin';
/** The server's label is up to 32 characters. */
const LABEL_CHARS = 32;
/** The status line's bound on what a call sends, applied per field here. */
const FIELD_CHARS = 180;
const MAX_FIELDS = 6;
/** The spend ledger's rolling day (`DEFAULT_WINDOW_MS` in the CLI). */
const SPEND_WINDOW_MS = 86_400_000;
/** The CLI's default `sessionBudget`, $5.00. */
const DEFAULT_BUDGET_ATOMIC = '5000000';
/** How far before the call's start its payment record's clock may read. */
const RECORD_SLACK_MS = 2_000;
/** The choice that runs every option of a choice set (`ALL_CHOICES` in the CLI). */
const ALL_CHOICES = 'all';
/** How the request tool's envelope opens: `JSON.stringify` puts `status` first. */
const ENVELOPE = '{"status":"';
/** A field whose name says secret is shown masked, whatever its value. */
const SECRET_NAME = /(api[_-]?key|token|secret|passw|authorization|cookie|private[_-]?key)/i;
/** The prompt hint's tail while the wallet cannot pay (terminal only). */
const UNFUNDED_TAIL = '· Tenjin wallet unfunded, run tenjin wallet fund';
/** The `$.store` key that says the first-run toast showed for a wallet. */
const WELCOME_KEY = 'welcomed';

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
 * after. A paid call is live for the spinner while it runs; once it is paid, a
 * toast and one dim transcript line say so, and what it paid counts toward the
 * turn's spend line.
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
    const settled = await settleCall($, call, ran, startedAt);
    await $.state.set(ref, { ...call.row, ...settled.row });
    if (settled.paidAtomic !== undefined) {
      const paid: TenjinPaid = { amountAtomic: settled.paidAtomic };
      await update($, turn, (list) => [...list, paid]);
      const shown = `${call.row.label} · $${usd(settled.paidAtomic)}`;
      $.ui.toast(shown);
      $.ui.log(`Tenjin: ${shown} · ${settled.isSettled ? 'settled' : 'paid'}`);
    }
    return ran;
  } finally {
    if (running !== null) {
      await update($, live, (list) => list.filter((one) => one.toolUseId !== running.toolUseId));
    }
  }
}

export const register: Register = (on) => {
  // THE PERMISSION ANSWER, for our one tool. The verdict beneath is read
  // first: a deny is passed through unchanged, and so is an ask a settings
  // rule of the user's own made, so `allowModsToOverrideDenyRules` is never
  // needed and no rule the user wrote is overridden.
  on('tool.check', { tool: REQUEST_TOOL }, async ($, e, next) => {
    const verdict = await next(e);
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask' && verdict.rule !== undefined) return verdict;
    return { decision: 'allow', reason: UNLABELLED };
  });

  // PINNED: the request tool sits in the prompt's tool list, not behind
  // ToolSearch, so the hook lines that name it point at a tool already loaded.
  on('tool.describe', { tool: REQUEST_TOOL }, async ($, e, next) => ({
    ...(await next(e)),
    isDeferred: false,
  }));

  on('tool.call', { tool: REQUEST_TOOL }, ($, e, next) => onRequest($, e, next));

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== REQUEST_TOOL) return next(e);
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
    if (e.props.tool !== REQUEST_TOOL) return next(e);
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

  // The unfunded wallet, at the end of the prompt's hint line. The terminal
  // draws `tail`; the desktop gets the toast below instead.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const wallet = await walletState($);
    if (!wallet.isUnfunded) return next(e);
    return next({ ...e, props: { ...e.props, tail: UNFUNDED_TAIL } });
  });

  // FIRST RUN: the install made the wallet, and it is not funded yet. Once on
  // the terminal, where the hint then carries it; once per session elsewhere,
  // where no hint draws, until the wallet is funded.
  on('session.start', async ($, e, next) => {
    const done = await next(e);
    const wallet = await walletState($);
    if (wallet.created === undefined || !wallet.isUnfunded) return done;
    if (await read($, welcomed)) return done;
    const key = `${WELCOME_KEY}:${wallet.created.toLowerCase()}`;
    const seen = (await $.store.get(key)) === true;
    if (seen && e.surface === 'terminal') return done;
    $.ui.toast(
      `Tenjin wallet created · ${shortAddress(wallet.created)} · unfunded · tenjin wallet fund`,
    );
    await update($, welcomed, () => true);
    await $.store.set(key, true);
    return done;
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
  /**
   * The offer ids whose payment records are this call's: the line's id, the
   * picked option's for a `choice`, every option's for `choice: "all"`. Money
   * is read from these records alone, never from a ledger row near in time.
   */
  ids: string[];
  priceAtomic?: string;
  dataDir: string | null;
}

/**
 * WHAT THE ROW SAYS BEFORE ANYTHING COMES BACK. `{id, input}` with a kept spec
 * is a paid call to that spec's service, and with a `choice` the call runs the
 * picked option's own spec under its own id, or every option's for `all`
 * (the choice set kept beside the line's id says which). `{id}` alone fetches
 * the spec, `{query}` asks the server to pick, and `{browse}` and `{tool}` read
 * the tool list: all of them are the router's own calls, and pay nothing.
 */
async function describeCall($: Dollar, args: Json): Promise<Call> {
  const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  const input = asRecord(args.input);
  const dataDir = await tenjinDataDir($);
  const fields =
    input !== undefined
      ? fieldLines(input)
      : typeof args.query === 'string'
        ? fieldLines({ query: args.query })
        : [];
  if (input === undefined || id === undefined || dataDir === null) {
    return { row: { label: ROUTER, isPaid: false, fields }, ids: [], dataDir };
  }
  const choice =
    typeof args.choice === 'string' && args.choice.length > 0 ? args.choice : undefined;
  if (choice !== undefined) {
    const options = await choiceOptions($, dataDir, id);
    if (choice === ALL_CHOICES && options.length > 0) {
      const specs = await Promise.all(options.map((option) => readSpec($, dataDir, option.id)));
      const prices = specs.map((spec) => atomicOf(spec?.priceAtomic));
      const total = prices.every((one) => one !== undefined)
        ? prices.reduce((sum, one) => sum + BigInt(one as string), 0n).toString()
        : undefined;
      return {
        row: {
          label: `${options.length} services`,
          isPaid: true,
          ...(total !== undefined ? { price: `for $${usd(total)}` } : {}),
          fields,
        },
        ids: options.map((option) => option.id),
        ...(total !== undefined ? { priceAtomic: total } : {}),
        dataDir,
      };
    }
    // The picked option runs as its own offer: its spec, its label, its payment.
    const picked = options.find((option) => option.key === choice);
    if (picked === undefined)
      return { row: { label: ROUTER, isPaid: false, fields }, ids: [], dataDir };
    return paidCall(await readSpec($, dataDir, picked.id), picked.id, fields, dataDir);
  }
  return paidCall(await readSpec($, dataDir, id), id, fields, dataDir);
}

/** One spec's call: its label, its price, and its own payment record. */
function paidCall(spec: Json | null, id: string, fields: string[], dataDir: string): Call {
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
    ids: [id],
    ...(priceAtomic !== undefined ? { priceAtomic } : {}),
    dataDir,
  };
}

/**
 * The options of the choice set the CLI kept beside a line's id
 * (`progress/specs/<sha256(id)>.choices.json`): each one's key and its own
 * offer id. Empty when none is kept.
 */
async function choiceOptions(
  $: Dollar,
  dataDir: string,
  id: string,
): Promise<{ id: string; key: string }[]> {
  const kept = await readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.choices.json`);
  const options = asRecord(kept?.choices)?.options;
  if (!Array.isArray(options)) return [];
  const rows = options.flatMap((one) => {
    const option = asRecord(one);
    return typeof option?.id === 'string' && typeof option.key === 'string'
      ? [{ id: option.id, key: option.key }]
      : [];
  });
  return rows;
}

async function readSpec($: Dollar, dataDir: string, id: string): Promise<Json | null> {
  return readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.json`);
}

/**
 * HOW THE CALL ENDED. Money comes only from the payment records of this call's
 * own offer ids, written since it started; the paid ledger is read only for
 * the row a record names by its transaction, to say whether it settled. A
 * call with no such record paid nothing, and its result's status says why.
 */
async function settleCall(
  $: Dollar,
  call: Call,
  ran: { deny?: string; text?: string; isError?: true },
  startedAt: number,
): Promise<{ row: Partial<TenjinRow>; paidAtomic?: string; isSettled?: boolean }> {
  if (ran.deny !== undefined) return { row: { outcome: 'not run' } };
  const status = statusOf(ran.text);
  // These refuse before anything is signed: an earlier payment for the same id
  // must not read as this call's.
  if (status !== undefined && status in REFUSALS && status !== 'fulfilled') {
    return { row: { outcome: refusalOf(status, ran.isError === true) } };
  }
  const { dataDir } = call;
  if (dataDir === null || call.ids.length === 0) {
    return { row: { outcome: refusalOf(status, ran.isError === true) } };
  }
  const records = (
    await Promise.all(
      call.ids.map(async (id) =>
        readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.paid.json`),
      ),
    )
  ).flatMap((record) => {
    // A record from before this call started is an earlier call's.
    const at = typeof record?.at === 'string' ? Date.parse(record.at) : NaN;
    return record !== null && at >= startedAt - RECORD_SLACK_MS ? [record] : [];
  });
  const paid = records.filter(
    (record) => record.state === 'paid' && atomicOf(record.amountAtomic) !== undefined,
  );
  const ledger = paid.some((record) => typeof record.txHash === 'string')
    ? await readLedger($, dataDir)
    : [];
  let total = 0n;
  let settled = 0;
  let notCharged = 0;
  for (const record of paid) {
    const row =
      typeof record.txHash === 'string'
        ? ledger.findLast((one) => one.txHash === record.txHash)
        : undefined;
    if (row?.settlement === 'not_charged') {
      notCharged += 1;
      continue;
    }
    if (row?.settlement === 'settled') settled += 1;
    total += BigInt(atomicOf(record.amountAtomic) as string);
  }
  if (total > 0n) {
    const isSettled = settled === paid.length - notCharged;
    return {
      row: { outcome: `$${usd(total.toString())} · ${isSettled ? 'settled' : 'paid'}` },
      paidAtomic: total.toString(),
      isSettled,
    };
  }
  if (notCharged > 0) return { row: { outcome: 'not charged' } };
  if (records.some((record) => record.state === 'possibly_paid')) {
    return { row: { outcome: 'pending' } };
  }
  return { row: { outcome: refusalOf(status, ran.isError === true) } };
}

async function readLedger($: Dollar, dataDir: string): Promise<Json[]> {
  try {
    const text = await $.fs.read(`${dataDir}/paid/ledger.jsonl`);
    return text
      .split('\n')
      .flatMap(parseLine)
      .filter((row) => row.version === 1);
  } catch {
    return [];
  }
}

/**
 * `Tenjin: 2 paid lookups, $0.09 · today $0.31 of $5.00`. Today is the spend
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

/**
 * THE WALLET, AS FAR AS THE MOD CAN TELL. Unfunded when the remembered balance
 * for this address is zero or under the per-call cap, or, with no balance read
 * yet, when the install created it in this run. `created` is that wallet's
 * address, set only while it is still the wallet on disk.
 */
async function walletState($: Dollar): Promise<{ isUnfunded: boolean; created?: string }> {
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return { isUnfunded: false };
  const wallet = await readJson($, `${dataDir}/wallet.json`);
  const address = typeof wallet?.address === 'string' ? wallet.address : undefined;
  if (address === undefined) return { isUnfunded: false };
  const marker = await readJson($, `${dataDir}/wallet-created.json`);
  const created =
    marker?.version === 1 &&
    typeof marker.address === 'string' &&
    marker.address.toLowerCase() === address.toLowerCase()
      ? address
      : undefined;
  const balance = await readJson($, `${dataDir}/balance.json`);
  const atomic =
    balance?.version === 1 && balance.address === address.toLowerCase()
      ? atomicOf(balance.atomic)
      : undefined;
  if (atomic === undefined)
    return { isUnfunded: created !== undefined, ...(created ? { created } : {}) };
  const config = await readJson($, `${dataDir}/config.json`);
  const cap = BigInt(atomicOf(config?.maxAutoSpend) ?? '0');
  const isUnfunded = BigInt(atomic) === 0n || BigInt(atomic) < cap;
  return { isUnfunded, ...(created ? { created } : {}) };
}

/** `0x5c6e…B7ff`: enough to recognise, too short to copy as a payee. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** `TENJIN_DATA_DIR` when set, else `~/.tenjin`, as the CLI resolves it. */
async function tenjinDataDir($: Dollar): Promise<string | null> {
  const override = await $.env.get('TENJIN_DATA_DIR');
  if (override !== undefined && override.length > 0) return override;
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home !== undefined && home.length > 0 ? `${home}/.tenjin` : null;
}

/** The server's `label`, exactly as sent when it is one plain line, else the
 *  static title. Never built from the provider, the host or the category. */
function labelOf(spec: Json | null): string {
  const value = spec?.label;
  if (typeof value !== 'string') return UNLABELLED;
  const label = clean(value, LABEL_CHARS + 1);
  return label.length > 0 && Array.from(label).length <= LABEL_CHARS ? label : UNLABELLED;
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

/**
 * The request tool's status, from its envelope: the last text block, JSON
 * with `status` first. A spec's example or a provider's body ahead of it can
 * hold a `status` of its own, but no suffix starting there parses whole.
 */
function statusOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (let at = text.indexOf(ENVELOPE); at !== -1; at = text.indexOf(ENVELOPE, at + 1)) {
    try {
      const status = asRecord(JSON.parse(text.slice(at)))?.status;
      if (typeof status === 'string') return status;
    } catch {
      // Not the envelope: one that starts inside the summary or the result.
    }
  }
  return undefined;
}

function refusalOf(status: string | undefined, isErrored: boolean): string {
  if (status !== undefined && status in REFUSALS) return REFUSALS[status] as string;
  return isErrored || status !== undefined ? 'failed' : 'done';
}

/** The text of a stored result: a string, or MCP content blocks bare or in `content`. */
function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const blocks = Array.isArray(output) ? output : asRecord(output)?.content;
  if (!Array.isArray(blocks)) return undefined;
  return blocks
    .map((block) => asRecord(block)?.text)
    .filter((text) => typeof text === 'string')
    .join('');
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

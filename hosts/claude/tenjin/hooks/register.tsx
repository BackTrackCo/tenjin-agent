import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, ToolCallResult } from 'claude-code';

import type { TenjinLive, TenjinPaid, TenjinRow } from '../types';

/**
 * THE TENJIN MOD: what the router does, shown to the person, and the one
 * permission answer it gives. ONE LINE PER LOOKUP, drawn as the engine draws
 * a tool row (its status dot, bold name, input in parentheses, a dim tail):
 * the request tool's row reads `⏺ Exa search(best local LLM) · $0.007`. A
 * WebSearch or WebFetch call held for Tenjin reads `⏺ ~~WebSearch~~(best
 * local LLM)` until the request call takes it up, then becomes that call's
 * row in place, with the request's own row empty. Beside it: the spinner while a lookup is routed
 * or paid, a toast when a call is paid, one spend line under a turn that
 * paid, the first-run wallet toast, and the prompt hint while the wallet is
 * unfunded.
 *
 * WHAT A ROW SHOWS: the label, the price, the state, and the one input the
 * person would recognise (the query, the URL, else the first field, a field
 * whose name says secret masked), as the native WebSearch and WebFetch rows
 * show theirs. Never a description, a tool id, JSON or `x402`.
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
/** The native tools the CLI's pre-call hook can hold for an offer. */
const NATIVE_TOOLS = new Set(['WebSearch', 'WebFetch']);
/** The engine's status dot for a tool row (`⏺` where the terminal has it). */
const DOT = '⏺';
/** A row's state as its dot shows it: dim while running, then success or error. */
type RowState = 'running' | 'done' | 'error';
/** The `rows` key a request call is also kept under once it takes up a held
 *  call, by that held call's id, so the held row draws it from its first frame. */
const HELD_KEY = 'held:';
/** The outcomes that mean the call did not run to an answer. */
const ERRORS = new Set(['failed', 'interrupted', 'not run']);
/** The spinner's word between a held call and the request call it leads to. */
const ROUTING_WORD = 'Routing to Tenjin';

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
/** The status line's bound on what a call sends, applied to the one input shown. */
const FIELD_CHARS = 180;
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
  // The held call this one takes up stops being the spinner's newest entry,
  // and its row, which the CLI now marks routed, redraws as the switch.
  const takes = new Set([
    ...call.ids,
    ...(call.row.offerId !== undefined ? [call.row.offerId] : []),
  ]);
  await update($, live, (list) =>
    list.filter((one) => one.heldOffer === undefined || !takes.has(one.heldOffer)),
  );
  // TAKING UP A HOLD, FROM THE FIRST FRAME: a call that runs a held offer (an
  // input or a query with its id, not a spec fetch) is drawn on the held row
  // while it runs and after, and its own row draws nothing.
  const args = e as { input?: unknown; query?: unknown };
  const runsOffer = asRecord(args.input) !== undefined || typeof args.query === 'string';
  const holdOf =
    runsOffer && call.row.offerId !== undefined ? await openHold($, call.row.offerId) : undefined;
  if (holdOf !== undefined) call.row = { ...call.row, holdOf };
  const ref = { ...ROWS, id: e.tool_use_id };
  await $.state.set(ref, call.row);
  if (holdOf !== undefined) {
    await $.state.set({ ...ROWS, id: `${HELD_KEY}${holdOf}` }, call.row);
    $.ui.invalidate('ui.render');
  }
  const running: TenjinLive | null =
    call.row.isPaid && call.priceAtomic !== undefined
      ? { toolUseId: e.tool_use_id, label: call.row.label, priceAtomic: call.priceAtomic }
      : null;
  if (running !== null) await update($, live, (list) => [...list, running]);
  try {
    const ran = await next(e);
    const settled = await settleCall($, call, ran, startedAt);
    await $.state.set(ref, { ...call.row, ...settled.row });
    if (holdOf !== undefined) {
      await $.state.set({ ...ROWS, id: `${HELD_KEY}${holdOf}` }, { ...call.row, ...settled.row });
      $.ui.invalidate('ui.render');
    }
    // A toast, never a transcript line: the row already says it.
    if (settled.paidAtomic !== undefined) {
      const paid: TenjinPaid = { amountAtomic: settled.paidAtomic };
      await update($, turn, (list) => [...list, paid]);
      $.ui.toast(`${call.row.label} · $${usd(settled.paidAtomic)}`);
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

  // A NATIVE CALL THE CLI HELD FOR AN OFFER: its pre-call hook denied it and
  // wrote the held row. Until the request call takes it up, the spinner says
  // where the turn is going.
  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny !== undefined) await noteHeld($, e.tool_use_id);
    return ran;
  });
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const ran = await next(e);
    if (ran.deny !== undefined) await noteHeld($, e.tool_use_id);
    return ran;
  });

  // A RUN OF REQUEST CALLS folds into the engine's one count line, which says
  // nothing of what ran: unfolded, each draws its own row through the hook
  // below. So does a run whose other calls are native ones the CLI held, so
  // the switch reads on its line. A run with any other call in it is the
  // engine's.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls } = e.props;
    let ours = calls.length > 0;
    for (const call of calls) {
      if (!ours) break;
      if (call.tool === REQUEST_TOOL) continue;
      ours =
        NATIVE_TOOLS.has(call.tool) &&
        call.tool_use_id !== undefined &&
        (await heldRow($, call.tool_use_id)) !== null;
    }
    return next(ours ? { ...e, props: { ...e.props, isExpanded: true } } : e);
  });

  // ONE LINE PER LOOKUP. A held native call is its name struck through, and
  // once the request call took it up, that call's row in its place; the
  // request's own row is then empty. Once the same search ran natively
  // instead, it draws nothing. Any other native row, an interrupted one
  // included, is the engine's.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (NATIVE_TOOLS.has(e.props.tool) && !e.props.isInterrupted) {
      const held = await heldRow($, e.props.tool_use_id);
      if (held === null) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      // The model went back to its own tool: the engine's row for the call
      // that ran is the line, and this one takes no room.
      if (held.outcome === 'native') return <Box display="none" />;
      // ONE ARGUMENT IN EVERY STATE: what the model asked its own tool, so
      // the line keeps its width and only the name, price and dot change.
      const asked = nativeArgument(asRecord(e.props.input));
      const keep = (row: TenjinRow): TenjinRow => {
        const kept: TenjinRow = { ...row };
        delete kept.argument;
        return asked !== undefined ? { ...kept, argument: asked } : kept;
      };
      const { value: taker } = await $.state.get({
        ...ROWS,
        id: `${HELD_KEY}${e.props.tool_use_id}`,
      });
      if (taker !== undefined) return toolRow(Box, Text, callShape(keep(taker), taker.outcome));
      if (held.outcome === 'held') {
        return toolRow(Box, Text, {
          state: 'running',
          name: e.props.tool,
          isStruck: true,
          ...(asked !== undefined ? { argument: asked } : {}),
        });
      }
      // ROUTED in another session's state (a resumed transcript): the call
      // the CLI named, else the offer's own label and price. With no call
      // named, that call's own row is the line and this one takes no room.
      if (held.routedToolUseId === undefined) return <Box display="none" />;
      const { value: taken } = await $.state.get({ ...ROWS, id: held.routedToolUseId });
      const row: TenjinRow = taken ?? {
        label: held.label,
        isPaid: true,
        ...(held.priceAtomic !== undefined ? { price: `$${usd(held.priceAtomic)}` } : {}),
        outcome: 'done',
      };
      return toolRow(Box, Text, callShape(keep(row), row.outcome));
    }
    if (e.props.tool !== REQUEST_TOOL) return next(e);
    const { value: stored } = await $.state.get({ ...ROWS, id: e.props.tool_use_id });
    const row = stored ?? (await describeCall($, { ...asRecord(e.props.input) })).row;
    const { Box, Text } = $.ui.resolve(e);
    // The held call's row draws this call in its place; any other call for
    // the same offer (a later spec fetch, a second run) is its own row.
    if (
      row.holdOf !== undefined ||
      (row.offerId !== undefined && (await tookUpHold($, row.offerId, e.props.tool_use_id)))
    ) {
      return <Box display="none" />;
    }
    const outcome =
      row.outcome ??
      (e.props.isRunning
        ? undefined
        : e.props.isInterrupted
          ? 'interrupted'
          : refusalOf(statusOf(textOf(e.props.output)), e.props.isErrored));
    return toolRow(Box, Text, callShape(row, outcome));
  });

  // The result block under our own row is the text the model read: the
  // provider's host, the envelope's JSON. The row above already says how it
  // ended, so nothing is drawn here.
  // A held native call's result is the deny the model read: drawn as nothing.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const isHeld =
      NATIVE_TOOLS.has(e.props.tool) && (await heldRow($, e.props.tool_use_id)) !== null;
    if (e.props.tool !== REQUEST_TOOL && !isHeld) return next(e);
    const { Box } = $.ui.resolve(e);
    return <Box display="none" />;
  });

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const newest = (await read($, live)).at(-1);
    if (newest === undefined) return next(e);
    if (newest.heldOffer !== undefined) {
      return next({
        ...e,
        props: { ...e.props, word: ROUTING_WORD, suffix: `… · ${newest.label}` },
      });
    }
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
    // A held call whose request never came is not still routing.
    await update($, live, (list) => list.filter((one) => one.heldOffer === undefined));
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

/** A native call the CLI held: the spinner's newest entry until its request runs. */
async function noteHeld($: Dollar, toolUseId: string): Promise<void> {
  const held = await heldRow($, toolUseId);
  if (held?.outcome !== 'held') return;
  const entry: TenjinLive = {
    toolUseId,
    label: held.label,
    priceAtomic: held.priceAtomic ?? '0',
    heldOffer: held.offerId,
  };
  await update($, live, (list) => [...list.filter((one) => one.toolUseId !== toolUseId), entry]);
}

/** A held native call's row, as the CLI writes it (`src/router/held.ts`). */
interface Held {
  outcome: 'held' | 'routed' | 'native';
  label: string;
  priceAtomic?: string;
  offerId: string;
  routedToolUseId?: string;
}

/**
 * `progress/held/<sha256(tool_use_id)>.json`, version 1, or null: a row the
 * CLI did not hold, or one of a version this mod does not know, is the
 * engine's to draw.
 */
async function heldRow($: Dollar, toolUseId: string): Promise<Held | null> {
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return null;
  const row = await readJson($, `${dataDir}/progress/held/${await sha256Hex(toolUseId)}.json`);
  if (row?.version !== 1 || typeof row.offerId !== 'string') return null;
  if (row.outcome !== 'held' && row.outcome !== 'routed' && row.outcome !== 'native') return null;
  const priceAtomic = atomicOf(row.priceAtomic);
  return {
    outcome: row.outcome,
    label: typeof row.label === 'string' ? labelOf({ label: row.label }) : UNLABELLED,
    ...(priceAtomic !== undefined ? { priceAtomic } : {}),
    offerId: row.offerId,
    ...(typeof row.routedToolUseId === 'string' ? { routedToolUseId: row.routedToolUseId } : {}),
  };
}

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
  const argument =
    input !== undefined
      ? argumentOf(input)
      : (argumentOf({ query: args.query }) ?? argumentOf({ browse: args.browse }));
  const base = {
    ...(argument !== undefined ? { argument } : {}),
    ...(id !== undefined ? { offerId: id } : {}),
  };
  if (input === undefined || id === undefined || dataDir === null) {
    return { row: { label: ROUTER, isPaid: false, ...base }, ids: [], dataDir };
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
          ...(total !== undefined ? { price: `$${usd(total)}` } : {}),
          ...base,
        },
        ids: options.map((option) => option.id),
        ...(total !== undefined ? { priceAtomic: total } : {}),
        dataDir,
      };
    }
    // The picked option runs as its own offer: its spec, its label, its payment.
    const picked = options.find((option) => option.key === choice);
    if (picked === undefined)
      return { row: { label: ROUTER, isPaid: false, ...base }, ids: [], dataDir };
    return paidCall(await readSpec($, dataDir, picked.id), picked.id, base, dataDir);
  }
  return paidCall(await readSpec($, dataDir, id), id, base, dataDir);
}

/** One spec's call: its label, its price, and its own payment record. */
function paidCall(
  spec: Json | null,
  id: string,
  base: Pick<TenjinRow, 'argument' | 'offerId'>,
  dataDir: string,
): Call {
  const priceAtomic = atomicOf(spec?.priceAtomic);
  const ceiling = atomicOf(spec?.maxAmountAtomic);
  const varies = spec?.priceVaries === true && ceiling !== undefined;
  const price = varies
    ? `up to $${usd(ceiling)}`
    : priceAtomic !== undefined
      ? `$${usd(priceAtomic)}`
      : undefined;
  return {
    row: { label: labelOf(spec), isPaid: true, ...(price ? { price } : {}), ...base },
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
  const earlier = paidBefore(ran.text);
  const records = (
    await Promise.all(
      call.ids
        .filter((id) => !earlier.has(id))
        .map(async (id) =>
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
 * `2 paid lookups, $0.09 · today $0.31 of $5.00`; the engine names the plugin
 * before it. Today is the spend
 * ledger's rolling day, counted as the budget counts it: automatic spend
 * committed plus automatic reservations still open.
 */
async function spendLine($: Dollar, paid: readonly TenjinPaid[], now: number): Promise<string> {
  const total = paid.reduce((sum, one) => sum + BigInt(one.amountAtomic), 0n);
  const head = `${paid.length} paid lookup${paid.length === 1 ? '' : 's'}, $${usd(total.toString())}`;
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
 * THE ONE INPUT A ROW SHOWS, as the native rows show theirs: the query, the
 * URL, else the first field, a nested object followed to its first leaf and
 * a list joined. A field whose name says secret is masked whatever its value.
 * Control and format characters go and it is bounded to one line. The CLI's
 * own mask never runs in a mod (it needs Node), and it has nothing to do on a
 * call that is sent: the request tool refuses, before sending, any input the
 * mask would change.
 */
function argumentOf(input: Json): string | undefined {
  const key =
    ['query', 'url'].find((name) => input[name] !== undefined) ??
    Object.keys(input).find((name) => input[name] !== undefined);
  if (key === undefined) return undefined;
  const value = input[key];
  const nested = asRecord(value);
  if (nested !== undefined) return argumentOf(nested);
  const text = clean(SECRET_NAME.test(key) ? '[redacted]' : shown(value), FIELD_CHARS);
  return text.length > 0 ? text : undefined;
}

/** A native call's own input as its row shows it: the search, or the URL. */
function nativeArgument(input: Json | undefined): string | undefined {
  if (input === undefined) return undefined;
  return argumentOf({ query: input.query }) ?? argumentOf({ url: input.url });
}

/** What one tool row draws. */
interface RowShape {
  state: RowState;
  name: string;
  argument?: string;
  /** The dim text after the input: ` · $0.007`, ` · $0.42 · needs approval`. */
  tail?: string;
  isStruck?: boolean;
}

/**
 * A request call's row: `Exa search(q) · $0.007`, the same text while it runs
 * and after (only the dot shows progress, as on a native row), the amount
 * paid once it paid, and the state only when it is not a plain success.
 */
function callShape(row: TenjinRow, outcome: string | undefined): RowShape {
  const isRunning = outcome === undefined;
  const paid = outcome?.startsWith('$') === true ? outcome.split(' · ')[0] : undefined;
  const isPlain = isRunning || paid !== undefined || outcome === 'done';
  const tail = [paid ?? row.price, isPlain ? undefined : outcome].filter(
    (part): part is string => part !== undefined,
  );
  return {
    state: isRunning ? 'running' : ERRORS.has(outcome) ? 'error' : 'done',
    name: row.label,
    ...(row.argument !== undefined ? { argument: row.argument } : {}),
    ...(tail.length > 0 ? { tail: ` · ${tail.join(' · ')}` } : {}),
  };
}

/**
 * THE ENGINE'S TOOL ROW, as Claude Code 2.1.304 lays it out: one blank line
 * above, the status dot in a two-column gutter (dim while running, the
 * theme's success or error color after), the name bold, the input in
 * parentheses, and a dim tail where the engine puts its ` · on <host>`.
 */
function toolRow(Box: BoxElement, Text: TextElement, shape: RowShape) {
  const isRunning = shape.state === 'running';
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}>
        <Text
          {...(isRunning
            ? { dimColor: true }
            : { color: shape.state === 'error' ? 'error' : 'success' })}
        >
          {DOT}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold strikethrough={shape.isStruck === true} wrap="truncate-end">
          {shape.name}
        </Text>
      </Box>
      <Box flexWrap="nowrap">
        <Text wrap="truncate-end">{shape.argument !== undefined ? `(${shape.argument})` : ''}</Text>
        <Text dimColor>{shape.tail ?? ''}</Text>
      </Box>
    </Box>
  );
}

/** The elements a row draws with, from the surface's own table. */
type TextElement = ReturnType<Dollar['ui']['resolve']>['Text'];
type BoxElement = ReturnType<Dollar['ui']['resolve']>['Box'];

/**
 * This request call took up a call held for its offer: the held row names it
 * (`routedToolUseId`), so it draws there. Read from the CLI's index of the
 * calls it held for an offer id (`src/router/held.ts`).
 */
/**
 * The held call a request for this offer takes up: the first one the CLI
 * holds for it that is still `held` and that no request call took up yet.
 */
async function openHold($: Dollar, offerId: string): Promise<string | undefined> {
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return undefined;
  const index = await readJson(
    $,
    `${dataDir}/progress/held/${await sha256Hex(offerId)}.offer.json`,
  );
  const ids = index?.version === 1 && Array.isArray(index.toolUseIds) ? index.toolUseIds : [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const held = await heldRow($, id);
    if (held?.outcome !== 'held' || held.offerId !== offerId) continue;
    const { value: taken } = await $.state.get({ ...ROWS, id: `${HELD_KEY}${id}` });
    if (taken === undefined) return id;
  }
  return undefined;
}

async function tookUpHold($: Dollar, offerId: string, toolUseId: string): Promise<boolean> {
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return false;
  const index = await readJson(
    $,
    `${dataDir}/progress/held/${await sha256Hex(offerId)}.offer.json`,
  );
  const ids = index?.version === 1 && Array.isArray(index.toolUseIds) ? index.toolUseIds : [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const held = await heldRow($, id);
    if (held?.outcome === 'routed' && held.routedToolUseId === toolUseId) return true;
  }
  return false;
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
  const status = envelopeOf(text)?.status;
  return typeof status === 'string' ? status : undefined;
}

/** The request tool's envelope, the JSON block whose `status` comes first. */
function envelopeOf(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  for (let at = text.indexOf(ENVELOPE); at !== -1; at = text.indexOf(ENVELOPE, at + 1)) {
    try {
      const envelope = asRecord(JSON.parse(text.slice(at)));
      if (typeof envelope?.status === 'string') return envelope;
    } catch {
      // Not the envelope: one that starts inside the summary or the result.
    }
  }
  return undefined;
}

/**
 * The option ids a `choice: "all"` call did not pay because an earlier call
 * had: the envelope lists each option's own status, and `already_paid` ran no
 * second time, so its record is that earlier call's whatever its timestamp.
 */
function paidBefore(text: string | undefined): Set<string> {
  const results = envelopeOf(text)?.results;
  if (!Array.isArray(results)) return new Set();
  return new Set(
    results.flatMap((one) => {
      const step = asRecord(one);
      return step?.status === 'already_paid' && typeof step.id === 'string' ? [step.id] : [];
    }),
  );
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

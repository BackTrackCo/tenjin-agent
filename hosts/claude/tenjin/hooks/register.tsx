import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, ToolCallResult } from 'claude-code';

import type { TenjinPaid, TenjinRow } from '../types';

/**
 * THE TENJIN MOD: what the router does, shown to the person, and the one
 * permission answer it gives. ONE LINE PER LOOKUP, drawn as Claude Code
 * draws an MCP call: while it runs, `⏺ Calling Exa search… · $0.007` with the
 * query under it; once it ends, the dim folded line `Called Exa search ·
 * $0.007 (ctrl+o to expand)`, which the ctrl+o transcript opens into the
 * whole row, `⏺ Exa search(best local LLM) · $0.007`. A WebSearch or WebFetch
 * call held for Tenjin reads as the engine's own row struck through,
 * `⏺ ~~Web Search~~("best local LLM") · Tenjin offered Exa search`, until the
 * request call takes it up, then becomes that call's row in place, with the
 * request's own row empty. The router's own free calls draw nothing. Beside
 * it: a toast when a call is paid, one spend line under a turn that paid, the
 * first-run wallet toast, and the prompt hint while the wallet is unfunded.
 * The engine's own spinner words stand; the row carries the state.
 *
 * WHAT A ROW SHOWS: the label, the price, the state, and the one input the
 * CLI says identifies the lookup (`<sha256(id)>.shown.json`: a search's query,
 * a URL, a name; none for a service that makes media, none past 80
 * characters). Never a description, a tool id, JSON or `x402`.
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

const ROWS = { plugin: 'tenjin', key: 'rows' } as const;
const TURN = { plugin: 'tenjin', key: 'turn' } as const;
const WELCOMED = { plugin: 'tenjin', key: 'welcomed' } as const;
const turn = atom(TURN, []);
const welcomed = atom(WELCOMED, false);

/** A decision with no label of its own, as the plan names it. */
const UNLABELLED = 'Tenjin lookup';
/** The router's own calls: a spec fetch, and a selection from a query. */
const ROUTER = 'Tenjin';
/** The server's label is up to 32 characters. */
const LABEL_CHARS = 32;
/** Past this an input is a prompt, not a lookup's key (`SHOWN_INPUT_MAX_CHARS`). */
const SHOWN_MAX_CHARS = 80;
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
 * after. Once it is paid, a toast says so, and what it paid counts toward the
 * turn's spend line.
 */
async function onRequest<E extends { tool_use_id: string }>(
  $: Dollar,
  e: E,
  next: (e: E) => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  const startedAt = await $.clock.now();
  const call = await describeCall($, e);
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
  }
  // The row draws from this state, which it waits for (see the ToolUse hook).
  $.ui.invalidate('ui.render');
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
    // The label and the price; a call with no label of its own says the price.
    const hasLabel = call.row.label !== ROUTER && call.row.label !== UNLABELLED;
    $.ui.toast(`${hasLabel ? `${call.row.label} · ` : ''}$${usd(settled.paidAtomic)}`);
  }
  return ran;
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

  // A RUN OF CALLS WITH OURS IN IT. The engine folds a run into one count
  // line ("Read 2 files, called plugin:tenjin:router"), which would hide a
  // paid lookup and name the router. A run without ours is the engine's.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls, isActive, isExpanded } = e.props;
    // Unfolded (ctrl+o, --verbose), each call draws its own row through the
    // ToolUse hook below.
    if (isExpanded || !calls.some((c) => c.tool === REQUEST_TOOL)) return next(e);
    const unfold = () => next({ ...e, props: { ...e.props, isExpanded: true } });
    // A held call and the request that takes it up read as one switch row.
    for (const call of calls) {
      if (!NATIVE_TOOLS.has(call.tool) || call.tool_use_id === undefined) continue;
      if ((await heldRow($, call.tool_use_id)) !== null) return unfold();
    }
    // A desktop host that predates `tool_use_id` on a group's calls: unfold,
    // so nothing paid is hidden in the count.
    if (calls.some((c) => c.tool === REQUEST_TOOL && c.tool_use_id === undefined)) return unfold();
    // OUR CALLS NEVER HIDE IN THE COUNT, AND ARE NEVER COUNTED. The engine's
    // line counts the other calls alone; each paid lookup draws its own row
    // beneath it; a free one (a spec fetch, the router's own pick) draws
    // nothing. The ctrl+o transcript still unfolds the whole run.
    const rows = (
      await Promise.all(
        calls
          .filter((c) => c.tool === REQUEST_TOOL)
          .map((c) => requestShape($, { ...c, tool_use_id: c.tool_use_id as string })),
      )
    ).filter((shape): shape is RowShape => shape !== null);
    const { Box, Text } = $.ui.resolve(e);
    const line = countLine(
      Box,
      Text,
      calls.filter((c) => c.tool !== REQUEST_TOOL),
      isActive,
    );
    if (line === null && rows.length === 0) return <Box display="none" />;
    return (
      <Box flexDirection="column">
        {line}
        {rows.map((shape) => toolRow(Box, Text, shape, e.viewport?.columns))}
      </Box>
    );
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
      // WHILE HELD, the call taking it up draws here as it runs. One that ended
      // without taking it (refused before it ran the offer) lets it go: the
      // row is struck again and that call draws its own row.
      if (held.outcome === 'held') {
        if (taker !== undefined && taker.outcome === undefined) {
          return toolRow(Box, Text, callShape(keep(taker), undefined), e.viewport?.columns);
        }
        return toolRow(
          Box,
          Text,
          {
            state: 'running',
            name: NATIVE_NAMES[e.props.tool] ?? e.props.tool,
            isStruck: true,
            // Why it is struck, in the dim tail the engine uses for ` · on <host>`.
            ...(held.label !== UNLABELLED ? { tail: ` · ${OFFERED} ${held.label}` } : {}),
            ...(asked !== undefined ? { argument: asked } : {}),
          },
          e.viewport?.columns,
        );
      }
      // ROUTED: the call the CLI names as the one that took it up, from this
      // session's state, else (a resumed transcript) the offer's own label and
      // price. With no call named, that call's own row is the line and this
      // one takes no room.
      if (held.routedToolUseId === undefined) return <Box display="none" />;
      const { value: taken } = await $.state.get({ ...ROWS, id: held.routedToolUseId });
      const row: TenjinRow = taken ?? {
        label: held.label,
        isPaid: true,
        ...(held.priceAtomic !== undefined ? { price: `$${usd(held.priceAtomic)}` } : {}),
        outcome: 'done',
      };
      return toolRow(
        Box,
        Text,
        callShape(keep(row), row.outcome, expandedOf(e.props)),
        e.viewport?.columns,
      );
    }
    if (e.props.tool !== REQUEST_TOOL) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const shape = await requestShape($, { ...e.props, isExpanded: expandedOf(e.props) });
    if (shape === null) return <Box display="none" />;
    return toolRow(Box, Text, shape, e.viewport?.columns);
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

/** A request call as a row or a group hands it over. */
interface RequestCall {
  tool_use_id: string;
  input: unknown;
  output?: unknown;
  isInterrupted: boolean;
  isErrored: boolean;
  /** The ctrl+o transcript or --verbose: the whole row, not the folded line. */
  isExpanded?: boolean;
}

/**
 * Whether the row is drawn expanded. Claude Code 2.1.304 passes `isExpanded`
 * on a ToolUse row (verbose or the ctrl+o transcript) beyond what its types
 * declare; absent, the row is folded.
 */
function expandedOf(props: object): boolean {
  return (props as { isExpanded?: unknown }).isExpanded === true;
}

/**
 * A REQUEST CALL'S OWN ROW, or null where it draws nothing: before it has
 * started, where a held row draws it, and where it has no label of its own.
 */
async function requestShape($: Dollar, call: RequestCall): Promise<RowShape | null> {
  const { value: stored } = await $.state.get({ ...ROWS, id: call.tool_use_id });
  // NOT STARTED YET. The engine draws a call's row before it runs, while its
  // input is still streaming in and before it is in progress (`isRunning`
  // false, no output): read then, the input names no offer yet and the row
  // would say "Tenjin" for a frame. Nothing is drawn until the call's own
  // tool.call has stored its row, or a result exists (a resumed transcript).
  const hasOutput = call.output !== undefined;
  if (stored === undefined && !hasOutput) return null;
  // A CALL THAT RUNS A HELD OFFER draws on the held row, decided from its own
  // input on its first frame, before its tool.call has claimed the hold. A
  // later call for the same offer (a spec fetch, a second run) is its own row.
  const args = asRecord(call.input) ?? {};
  const offerId = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  const runsOffer = asRecord(args.input) !== undefined || typeof args.query === 'string';
  const isDone = stored === undefined || stored.outcome !== undefined;
  if (
    offerId !== undefined &&
    (isDone
      ? await heldFor($, offerId, call.tool_use_id, 'routed')
      : stored.holdOf !== undefined ||
        (runsOffer && (await heldFor($, offerId, call.tool_use_id, 'held'))))
  ) {
    return null;
  }
  const row = stored ?? (await describeCall($, args)).row;
  // A ROW WITH NO LABEL OF ITS OWN is not drawn: the router's own calls (a
  // spec fetch, a query it picks for) and a spec the server sent unlabelled
  // would read "Tenjin" or "Tenjin lookup".
  if (row.label === ROUTER || row.label === UNLABELLED) return null;
  const outcome =
    row.outcome ??
    (!hasOutput
      ? undefined
      : call.isInterrupted
        ? 'interrupted'
        : refusalOf(statusOf(textOf(call.output)), call.isErrored));
  return callShape(row, outcome, call.isExpanded === true);
}

/**
 * THE ENGINE'S COUNT LINE FOR A RUN OF CALLS, ours left out: its parts in the
 * engine's order and words (Claude Code 2.1.304's ToolGroup: "searched for N
 * patterns", "read N files", "listed N directories", "called <server> N
 * times", "ran N agents", "called N tools", "ran N shell commands"), the
 * first capitalised, the counts bold, the line dim once the run has ended,
 * and the engine's "(ctrl+o to expand)". Null when nothing is left to count.
 */
function countLine(
  Box: BoxElement,
  Text: TextElement,
  calls: readonly { tool: string }[],
  isActive: boolean,
) {
  const count = (test: (tool: string) => boolean) => calls.filter((c) => test(c.tool)).length;
  const isMcp = (tool: string) => tool.startsWith('mcp__');
  const known = new Set(['Grep', 'Glob', 'Read', 'LS', 'Task', 'Agent', 'Bash']);
  const servers = [...new Set(calls.filter((c) => isMcp(c.tool)).map((c) => mcpServer(c.tool)))];
  const parts: { verb: string; count?: number; noun: string }[] = [];
  const add = (n: number, done: string, doing: string, one: string, many: string) => {
    if (n > 0) parts.push({ verb: isActive ? doing : done, count: n, noun: n === 1 ? one : many });
  };
  add(
    count((t) => t === 'Grep' || t === 'Glob'),
    'searched for',
    'searching for',
    'pattern',
    'patterns',
  );
  add(
    count((t) => t === 'Read'),
    'read',
    'reading',
    'file',
    'files',
  );
  add(
    count((t) => t === 'LS'),
    'listed',
    'listing',
    'directory',
    'directories',
  );
  const mcp = count(isMcp);
  if (mcp > 0) {
    parts.push({
      verb: `${isActive ? 'calling' : 'called'} ${servers.join(', ') || 'MCP'}`,
      ...(mcp > 1 ? { count: mcp } : {}),
      noun: mcp > 1 ? 'times' : '',
    });
  }
  add(
    count((t) => t === 'Task' || t === 'Agent'),
    'ran',
    'running',
    'agent',
    'agents',
  );
  add(
    count((t) => !known.has(t) && !isMcp(t)),
    'called',
    'calling',
    'tool',
    'tools',
  );
  add(
    count((t) => t === 'Bash'),
    'ran',
    'running',
    'shell command',
    'shell commands',
  );
  if (parts.length === 0) return null;
  const pieces = parts.flatMap((part, at) => {
    const verb = at === 0 ? `${part.verb[0]!.toUpperCase()}${part.verb.slice(1)}` : part.verb;
    return [
      ...(at > 0 ? [<Text dimColor={!isActive}>, </Text>] : []),
      <Text dimColor={!isActive}>{part.count !== undefined ? `${verb} ` : verb}</Text>,
      ...(part.count !== undefined
        ? [
            <Text dimColor={!isActive} bold>
              {String(part.count)}
            </Text>,
            <Text dimColor={!isActive}>{` ${part.noun}`}</Text>,
          ]
        : []),
    ];
  });
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}>{isActive ? <Text dimColor>{DOT}</Text> : <Text>{''}</Text>}</Box>
      {pieces}
      <Text dimColor={!isActive}>{isActive ? '… ' : ' '}</Text>
      <Text dimColor>{EXPAND_HINT}</Text>
    </Box>
  );
}

/** An MCP tool's server as a count line names it: `mcp__<server>__<tool>`. */
function mcpServer(tool: string): string {
  const server = tool.split('__')[1] ?? '';
  return server.startsWith('plugin_') ? `plugin:${server.slice(7).replace(/_/g, ':')}` : server;
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
  const base = { ...(id !== undefined ? { offerId: id } : {}) };
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
    const shown = await shownArgument($, dataDir, picked.id, input);
    return paidCall(
      await readSpec($, dataDir, picked.id),
      picked.id,
      { ...base, ...shown },
      dataDir,
    );
  }
  const shown = await shownArgument($, dataDir, id, input);
  return paidCall(await readSpec($, dataDir, id), id, { ...base, ...shown }, dataDir);
}

/**
 * THE ONE INPUT A ROW SHOWS, as the CLI decided it for the service
 * (`progress/specs/<sha256(id)>.shown.json`, version 1): the field it names,
 * when the value is a short single key. No record, a null field (a service
 * that makes media) or a long value: the row shows no input.
 */
async function shownArgument(
  $: Dollar,
  dataDir: string,
  id: string,
  input: Json,
): Promise<{ argument?: string }> {
  const kept = await readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.shown.json`);
  const field = kept?.version === 1 && typeof kept.field === 'string' ? kept.field : undefined;
  // A field whose name says secret is never shown, whatever the CLI kept.
  if (field !== undefined && SECRET_NAME.test(field)) return {};
  const value = field !== undefined ? input[field] : undefined;
  const argument = typeof value === 'string' ? shortKey(value) : undefined;
  return argument !== undefined ? { argument } : {};
}

/** A value short enough to be the key of a lookup (the CLI's same cap), cleaned. */
function shortKey(value: string): string | undefined {
  const text = clean(value, SHOWN_MAX_CHARS + 1);
  return text.length > 0 && Array.from(text).length <= SHOWN_MAX_CHARS ? text : undefined;
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
 * A native call's own input as the engine's row shows it (Claude Code 2.1.304's
 * `renderToolUseMessage`): WebSearch quotes its query, WebFetch shows its URL.
 */
function nativeArgument(input: Json | undefined): string | undefined {
  if (input === undefined) return undefined;
  const query = typeof input.query === 'string' ? shortKey(input.query) : undefined;
  if (query !== undefined) return `"${query}"`;
  return typeof input.url === 'string' ? shortKey(input.url) : undefined;
}

/** The engine's response gutter and an MCP call's progress while it runs. */
const GUTTER = '  ⎿  ';
/** The engine's hint after a folded run's count (its default chord). */
const EXPAND_HINT = '(ctrl+o to expand)';
/** The verb the engine's folded line gives a running MCP call. */
const CALLING = 'Calling';
/** The verb on the engine's folded line once the call has ended. */
const CALLED = 'Called';
/** A held row's tail names the offer it is struck for: `· Tenjin offered Exa search`. */
const OFFERED = 'Tenjin offered';
/** The names the engine draws its native rows under (each tool's `userFacingName`). */
const NATIVE_NAMES: Readonly<Record<string, string>> = {
  WebSearch: 'Web Search',
  WebFetch: 'Fetch',
};

/** What one tool row draws. */
interface RowShape {
  state: RowState;
  name: string;
  argument?: string;
  /** The dim text after the input: ` · $0.007`, ` · $0.42 · needs approval`. */
  tail?: string;
  isStruck?: boolean;
  /** What goes under the row while it runs, as the engine puts an MCP call's query. */
  hint?: string;
  /** An ended call drawn as the engine's folded line for it. */
  isFolded?: boolean;
}

/**
 * A request call's row: `Exa search(q) · $0.007`, the same text while it runs
 * and after (only the dot shows progress, as on a native row), the amount
 * paid once it paid, and the state only when it is not a plain success.
 */
function callShape(row: TenjinRow, outcome: string | undefined, isExpanded = false): RowShape {
  const isRunning = outcome === undefined;
  const paid = outcome?.startsWith('$') === true ? outcome.split(' · ')[0] : undefined;
  const isPlain = isRunning || paid !== undefined || outcome === 'done';
  const tail = [paid ?? row.price, isPlain ? undefined : outcome].filter(
    (part): part is string => part !== undefined,
  );
  const state: RowState = isRunning ? 'running' : ERRORS.has(outcome) ? 'error' : 'done';
  const price = tail.length > 0 ? { tail: ` · ${tail.join(' · ')}` } : {};
  // While it runs, as Claude Code shows a running MCP call: its folded line
  // reads `Calling <server>…` and the call's query goes under it, quoted.
  if (isRunning) {
    return {
      state,
      name: `${CALLING} ${row.label}…`,
      ...price,
      ...(row.argument !== undefined ? { hint: row.argument } : {}),
    };
  }
  // Ended, as Claude Code folds an ended MCP call: `Called <server>`, the
  // line dim with no dot, then the price, then its "(ctrl+o to expand)". The
  // ctrl+o transcript draws the whole row instead.
  if (!isExpanded) return { state, name: `${CALLED} ${row.label}`, ...price, isFolded: true };
  return {
    state,
    name: row.label,
    ...(row.argument !== undefined ? { argument: row.argument } : {}),
    ...price,
  };
}

/**
 * THE ENGINE'S TOOL ROW, as Claude Code 2.1.304 lays it out: one blank line
 * above, the status dot in a two-column gutter (dim while running, the
 * theme's success or error color after), the name bold, the input in
 * parentheses, and a dim tail where the engine puts its ` · on <host>`.
 */
function toolRow(Box: BoxElement, Text: TextElement, shape: RowShape, columns?: number) {
  if (shape.isFolded === true) {
    // The engine's ended one-call group (2.1.304 `ng`): a blank two-column
    // gutter, the whole line dim, a suffix (its ` · <elapsed>`, our price)
    // after the words, then " " and the dim "(ctrl+o to expand)".
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box minWidth={2} />
        <Text dimColor>{shape.name}</Text>
        <Text dimColor>{shape.tail ?? ''}</Text>
        <Text dimColor>{` ${EXPAND_HINT}`}</Text>
      </Box>
    );
  }
  const isRunning = shape.state === 'running';
  const argument = shape.argument !== undefined ? fitArgument(shape, columns) : undefined;
  const line = (
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
        <Text wrap="truncate-end">{argument !== undefined ? `(${argument})` : ''}</Text>
        <Text dimColor>{shape.tail ?? ''}</Text>
      </Box>
    </Box>
  );
  if (shape.hint === undefined) return line;
  // The query under the row, quoted and dim, as the engine shows an MCP
  // call's (its ToolGroup's latestDisplayHint) while it runs.
  const hint = /^".*"$/.test(shape.hint) ? shape.hint : `"${shape.hint}"`;
  return (
    <Box flexDirection="column">
      {line}
      <Box flexDirection="row">
        <Text dimColor>{GUTTER}</Text>
        <Text dimColor wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * THE INPUT CUT TO THE ROW, as the engine cuts a tool's: the room it gives
 * the input is the width less the dot's gutter, the name and the
 * parentheses, never under 20 columns; ours also keeps the tail in view. An
 * input past it ends in `…`.
 */
function fitArgument(shape: RowShape, columns: number | undefined): string {
  const argument = shape.argument ?? '';
  if (columns === undefined) return argument;
  const used = 2 + width(shape.name) + 2 + width(shape.tail ?? '');
  const room = Math.max(columns - used, 20);
  const chars = Array.from(argument);
  return chars.length <= room ? argument : `${chars.slice(0, room - 1).join('')}…`;
}

/** Columns a plain line takes; the row's text is already free of wide controls. */
function width(text: string): number {
  return Array.from(text).length;
}

/** The elements a row draws with, from the surface's own table. */
type TextElement = ReturnType<Dollar['ui']['resolve']>['Text'];
type BoxElement = ReturnType<Dollar['ui']['resolve']>['Box'];

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
    // A claim by a call that ended without taking it up has lapsed.
    const { value: taken } = await $.state.get({ ...ROWS, id: `${HELD_KEY}${id}` });
    if (taken === undefined || taken.outcome !== undefined) return id;
  }
  return undefined;
}

/**
 * This request call draws on a held call's row. While it runs (`held`): one
 * is still held for its offer, which it is taking up. Once it ended
 * (`routed`): the CLI names it as the call that took one up
 * (`routedToolUseId`); a call refused before it ran the offer took nothing
 * and draws its own row. Read from the CLI's index of the calls it held for
 * an offer id (`src/router/held.ts`).
 */
async function heldFor(
  $: Dollar,
  offerId: string,
  toolUseId: string,
  phase: 'held' | 'routed',
): Promise<boolean> {
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
    if (held === null || held.offerId !== offerId) continue;
    if (phase === 'held' && held.outcome === 'held') return true;
    if (phase === 'routed' && held.outcome === 'routed' && held.routedToolUseId === toolUseId) {
      return true;
    }
  }
  return false;
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

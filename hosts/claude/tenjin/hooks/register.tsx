import type { EngineInterface, Register } from 'claude-code';

import type { TenjinHeld, TenjinRow } from '../types';

/**
 * THE TENJIN MOD: one line per paid lookup, drawn from documented props only.
 *
 * - A LOOKUP THAT STOOD ON ITS OWN draws as Claude Code draws one MCP call:
 *   `⏺ Calling Exa search… · $0.04` with the query under it while it runs,
 *   then the dim `Called Exa search · $0.04 (ctrl+o to expand)`. A run mixing
 *   it with other calls is unfolded (`ToolGroup.isExpanded`) for the engine to
 *   draw, our row among its rows.
 * - A LOOKUP THAT REPLACED A NATIVE CALL draws where that call stood:
 *   `⏺ ~~Web Search~~("q") · Tenjin offered Exa search` while held, then in
 *   place `⏺ Exa search("q") · $0.007`, the dot carrying the state.
 *
 * Free router calls and `needs_input` answers draw nothing; a charged failure
 * draws the error dot, the amount and the state, never a success.
 *
 * EXPANDED: where the engine itself expanded the run a lookup sits in (ctrl+o,
 * --verbose: `ToolGroup.isExpanded` as received), the row steps aside and the
 * engine draws its own expanded MCP row, input and result. Its title there is
 * the engine's: the tool's static title, without the service name or price. No
 * documented prop tells the normal view from the transcript for a standalone
 * row, so a standalone lookup shows its one line everywhere.
 *
 * READ ONLY: the spec file and the offer record (`src/router/mod-state.ts`),
 * and the request tool's own envelope. The mod writes nothing under the data
 * dir and decides nothing about routing or payment.
 */

const REQUEST_TOOL = 'mcp__plugin_tenjin_router__request';
/** The native tools a hook holds, by the names the engine draws them under. */
const NATIVE_NAMES: Readonly<Record<string, string>> = {
  WebSearch: 'Web Search',
  WebFetch: 'Fetch',
};
const ROWS = { plugin: 'tenjin', key: 'rows' } as const;
const HELD = { plugin: 'tenjin', key: 'held' } as const;
const LINKS = { plugin: 'tenjin', key: 'links' } as const;
/**
 * Calls of a run the ENGINE expanded (ctrl+o, --verbose), where our rows step
 * aside for the engine's own. The module's own memory, not `$.state`: a drawing may
 * not write state, and this is a fact about the drawing alone. A reload
 * forgets it, so a row draws one line until its run is expanded again.
 */
const expandedByEngine = new Set<string>();
const DOT = '⏺';
const GUTTER = '  ⎿  ';
const INDENT = '     ';
const EXPAND_HINT = '(ctrl+o to expand)';
const LABEL_CHARS = 32;
const SHOWN_MAX_CHARS = 80;
const ENVELOPE = '{"status":"';
const SECRET_NAME = /(api[_-]?key|token|secret|passw|authorization|cookie|private[_-]?key)/i;
/** Answers that ran nothing the person paid for: the router's own, or a retry ahead. */
const HIDDEN = new Set(['spec', 'discovered', 'native', 'browse', 'needs_input']);
/** Endings drawn with no state word. */
const PLAIN = new Set(['fulfilled', 'running']);
const ERRORS = new Set(['failed', 'interrupted', 'partial']);

type Dollar = EngineInterface;
type Json = Record<string, unknown>;
type Shape = {
  state: 'running' | 'done' | 'error';
  name: string;
  argument?: string;
  tail?: string;
};
type Elements = ReturnType<Dollar['ui']['resolve']>;

export const register: Register = (on) => {
  on('tool.call', { tool: REQUEST_TOOL }, async ($, e, next) => {
    const row = await describeCall($, e);
    const ref = { ...ROWS, id: e.tool_use_id };
    if (row !== null) {
      await $.state.set(ref, row);
      if (row.offerId !== undefined) {
        await $.state.set({ ...LINKS, id: `take:${row.offerId}` }, e.tool_use_id);
      }
      $.ui.invalidate('ui.render');
    }
    const ran = await next(e);
    const ended = endOf(envelopeOf(ran.text));
    const label = row?.label ?? ended.label;
    // A job poll is not a lookup of its own (see `rowOf`).
    if (label !== undefined && !isJobPoll(e)) {
      await $.state.set(ref, { ...row, ...ended, label });
      $.ui.invalidate('ui.render');
    }
    return ran;
  });

  // A native call the router held: its offer, from the CLI's record. One the
  // router let run, for a held call with the same search to give way to.
  on('tool.call', { tool: ['WebSearch', 'WebFetch'] }, async ($, e, next) => {
    const ran = await next(e);
    const key = nativeKey(e.tool, e);
    const held = await offerRecord($, e.tool_use_id, key);
    if (held !== null) {
      await $.state.set({ ...HELD, id: e.tool_use_id }, held);
      await $.state.set({ ...LINKS, id: `hold:${held.offerId}` }, e.tool_use_id);
    } else if (key !== undefined) {
      await $.state.set({ ...LINKS, id: `ran:${key}` }, e.tool_use_id);
    }
    $.ui.invalidate('ui.render');
    return ran;
  });

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls, isExpanded } = e.props;
    const ids = calls.flatMap((c) => (c.tool_use_id !== undefined ? [c.tool_use_id] : []));
    // EXPANDED BY THE ENGINE (ctrl+o, --verbose): our rows step aside there.
    if (isExpanded) {
      const fresh = ids.filter((id) => !expandedByEngine.has(id));
      for (const id of fresh) expandedByEngine.add(id);
      if (fresh.length > 0) $.ui.invalidate('ui.render');
      return next(e);
    }
    // Back in the normal view, and unfolded by us: one line per row, nothing beneath.
    if (ids.filter((id) => expandedByEngine.delete(id)).length > 0) $.ui.invalidate('ui.render');
    const unfold = () => next({ ...e, props: { ...e.props, isExpanded: true } });
    const ours = calls.filter((c) => c.tool === REQUEST_TOOL);
    const others = calls.filter((c) => c.tool !== REQUEST_TOOL);
    if (ours.length === 0) {
      for (const c of others) {
        if (c.tool in NATIVE_NAMES && c.tool_use_id !== undefined) {
          if ((await heldOf($, c.tool_use_id, nativeKey(c.tool, c.input))) !== null)
            return unfold();
        }
      }
      return next(e);
    }
    if (others.length > 0 || ours.some((c) => c.tool_use_id === undefined)) return unfold();
    const rows = await Promise.all(ours.map((c) => rowOf($, c.tool_use_id as string, c)));
    const ui = $.ui.resolve(e);
    const drawn = rows.filter((row): row is TenjinRow => row !== null);
    if (drawn.length === 0) return <ui.Box display="none" />;
    return (
      <ui.Box flexDirection="column">
        {drawn.map((row) => (row.status === 'fulfilled' ? folded(ui, row) : callRow(ui, row)))}
      </ui.Box>
    );
  });

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, tool_use_id, input, isInterrupted } = e.props;
    if (tool in NATIVE_NAMES && !isInterrupted) {
      const key = nativeKey(tool, input);
      const held = await heldOf($, tool_use_id, key);
      if (held === null) return next(e);
      const ui = $.ui.resolve(e);
      const asked = nativeArgument(input);
      const takerId = await link($, `take:${held.offerId}`);
      const taker = takerId === undefined ? undefined : await row($, takerId);
      if (taker !== undefined && taker.status !== 'needs_input') {
        const shape = { ...shapeOf(taker), name: taker.label };
        return line(ui, asked !== undefined ? { ...shape, argument: asked } : shape);
      }
      // An offer nobody took, and the model ran the same search natively: the
      // engine's row for that call is the line.
      const ran = await link($, `ran:${held.key}`);
      if (ran !== undefined && ran !== tool_use_id) return <ui.Box display="none" />;
      const offered = held.label !== undefined ? { tail: ` · Tenjin offered ${held.label}` } : {};
      const name = NATIVE_NAMES[tool] as string;
      const argued = asked !== undefined ? { argument: asked } : {};
      return line(ui, { state: 'running', name, ...offered, ...argued }, true);
    }
    if (tool !== REQUEST_TOOL) return next(e);
    const ui = $.ui.resolve(e);
    // In a run the engine expanded, the engine draws its own expanded row,
    // input and result, exactly as for any MCP call: a lookup that replaced a
    // held call (form A) as well, so what it bought opens there too.
    const expanded = expandedByEngine.has(tool_use_id);
    const drawn = await rowOf($, tool_use_id, e.props, expanded);
    // A charged call this mod cannot name is the engine's row, never hidden.
    if (drawn === null)
      return (await unnamedCharge($, tool_use_id, e.props.output)) ? (
        next(e)
      ) : (
        <ui.Box display="none" />
      );
    return expanded ? next(e) : callRow(ui, drawn);
  });

  // The envelope the model read, and a held call's deny: the row says both.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e);
    if (e.props.tool === REQUEST_TOOL) {
      const unnamed = await unnamedCharge($, e.props.tool_use_id, e.props.output);
      return unnamed ? next(e) : <Box display="none" />;
    }
    if (!(e.props.tool in NATIVE_NAMES)) return next(e);
    const held = await heldOf($, e.props.tool_use_id, undefined);
    return held === null ? next(e) : <Box display="none" />;
  });
};

/** A paid call before it runs: `{id, input}` with a kept spec. Null for the
 *  router's own calls and a choice, which its envelope names once it ends. */
async function describeCall($: Dollar, e: Json): Promise<TenjinRow | null> {
  const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : undefined;
  const input = asRecord(e.input);
  if (id === undefined || input === undefined || (typeof e.choice === 'string' && e.choice)) {
    return null;
  }
  const dataDir = await tenjinDataDir($);
  const spec =
    dataDir === null
      ? null
      : await readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.json`);
  // A Bazaar spec carries no label: the provider's own name stands in.
  const label = labelOf(spec?.label) ?? labelOf(spec?.provider);
  if (spec === null || label === undefined) return null;
  const takes = typeof e.count === 'number' && e.count > 1 ? BigInt(e.count) : 1n;
  const each = atomicOf(spec.priceVaries === true ? spec.maxAmountAtomic : spec.priceAtomic);
  const price =
    each === undefined
      ? undefined
      : `${spec.priceVaries === true ? 'up to ' : ''}$${usd(BigInt(each) * takes)}`;
  const field =
    typeof spec.shown === 'string' && !SECRET_NAME.test(spec.shown) ? spec.shown : undefined;
  const argument =
    field !== undefined && typeof input[field] === 'string' ? shortKey(input[field]) : undefined;
  return {
    label,
    offerId: id,
    ...(price !== undefined ? { price } : {}),
    ...(argument !== undefined ? { argument } : {}),
  };
}

/** How a call ended, from its envelope: the status, what left the wallet, and
 *  what came back. A call with no envelope ended before it ran. */
function endOf(envelope: Json | undefined): Partial<TenjinRow> {
  if (envelope === undefined) return { status: 'failed' };
  const status = String(envelope.status);
  const paid = paidOf(envelope.cost);
  const steps = Array.isArray(envelope.results) ? envelope.results.map(asRecord) : [];
  const label =
    labelOf(envelope.label) ??
    (steps.length > 0 ? `${steps.length} services` : labelOf(envelope.supplier));
  return {
    status,
    ...(label !== undefined ? { label } : {}),
    ...(paid !== undefined ? { paid } : {}),
  };
}

/** A request call's row, or null where it draws nothing: not started, one of
 *  the router's own, sent back for input, free, or drawn on a held call's row. */
async function rowOf(
  $: Dollar,
  id: string,
  call: { input: unknown; output?: unknown; isInterrupted: boolean },
  expanded = false,
): Promise<TenjinRow | null> {
  const stored = await row($, id);
  // A JOB POLL repeats the result and the cost of the call that started it.
  if (isJobPoll(asRecord(call.input))) return null;
  const envelope = envelopeOf(textOf(call.output));
  const ended =
    envelope !== undefined ? endOf(envelope) : call.isInterrupted ? { status: 'interrupted' } : {};
  const label = stored?.label ?? ended.label;
  if (label === undefined) return null;
  const drawn: TenjinRow = { ...stored, ...ended, label };
  if (drawn.status !== undefined && HIDDEN.has(drawn.status)) return null;
  if (drawn.status !== undefined && PLAIN.has(drawn.status) && drawn.paid === undefined)
    return null;
  const offer = drawn.offerId;
  if (!expanded && offer !== undefined && (await link($, `hold:${offer}`)) !== undefined) {
    if ((await link($, `take:${offer}`)) === id) return null;
  }
  return drawn;
}

function shapeOf(row: TenjinRow): Shape {
  const state = row.status === undefined ? 'running' : ERRORS.has(row.status) ? 'error' : 'done';
  const word =
    row.status !== undefined && !PLAIN.has(row.status) ? row.status.replace(/_/g, ' ') : undefined;
  const tail = [row.paid ?? row.price, word].filter((part) => part !== undefined);
  return { state, name: row.label, ...(tail.length > 0 ? { tail: ` · ${tail.join(' · ')}` } : {}) };
}

/** A request call's own row: `Calling X… · $p` with its input under it while it
 *  runs, then the folded `Called X · $p`; a refusal or a charged failure keeps
 *  its dot and its state. */
function callRow(ui: Elements, row: TenjinRow) {
  const shape = shapeOf(row);
  if (shape.state === 'running') {
    const under = row.argument !== undefined ? [`"${row.argument}"`] : [];
    return block(ui, line(ui, { ...shape, name: `Calling ${row.label}…` }), under);
  }
  // Ended and plain, as Claude Code leaves an ended MCP call wherever it is
  // drawn (its one-call run, or the standalone row that run becomes).
  if (row.status === 'fulfilled') return folded(ui, row);
  return line(ui, row.argument !== undefined ? { ...shape, argument: row.argument } : shape);
}

/** An ended lookup folded as the engine folds an ended MCP call: no dot, all dim. */
function folded({ Box, Text }: Elements, row: TenjinRow) {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2} />
      <Text dimColor>{`Called ${row.label}${shapeOf(row).tail ?? ''} ${EXPAND_HINT}`}</Text>
    </Box>
  );
}

/** The engine's tool row: the dot, the name bold, the input in parentheses
 *  (cut at the width, the tail kept), and a dim tail. */
function line({ Box, Text }: Elements, shape: Shape, struck = false) {
  const color =
    shape.state === 'running'
      ? { dimColor: true }
      : { color: shape.state === 'error' ? 'error' : 'success' };
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2}>
        <Text {...color}>{DOT}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold strikethrough={struck} wrap="truncate-end">
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

function block({ Box, Text }: Elements, head: ReturnType<typeof line>, under: string[]) {
  if (under.length === 0) return head;
  return (
    <Box flexDirection="column">
      {head}
      {under.map((text, at) => (
        <Box flexDirection="row">
          <Text dimColor>{at === 0 ? GUTTER : INDENT}</Text>
          <Text dimColor wrap="truncate-end">
            {text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/** The held native call's offer: from this session's state, else the CLI's
 *  offer record for it (`progress/<sha256(session)>/offer-<sha256(id)>.json`). */
async function heldOf($: Dollar, id: string, key: string | undefined): Promise<TenjinHeld | null> {
  const { value } = await $.state.get({ ...HELD, id });
  return value ?? offerRecord($, id, key);
}

async function offerRecord(
  $: Dollar,
  id: string,
  key: string | undefined,
): Promise<TenjinHeld | null> {
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return null;
  const session = await sha256Hex(await $.session.id());
  const record = await readJson(
    $,
    `${dataDir}/progress/${session}/offer-${await sha256Hex(id)}.json`,
  );
  if (record?.version !== 1 || typeof record.offerId !== 'string') return null;
  const label = labelOf(record.label);
  return { offerId: record.offerId, key: key ?? '', ...(label !== undefined ? { label } : {}) };
}

const row = async ($: Dollar, id: string) => (await $.state.get({ ...ROWS, id })).value;
const link = async ($: Dollar, id: string) => (await $.state.get({ ...LINKS, id })).value;

/** A `{job}` poll, as the CLI reads one: a nonempty `job` (`tool.ts`). */
function isJobPoll(args: Json | undefined): boolean {
  return typeof args?.job === 'string' && args.job.length > 0;
}

/** The native tool and what it was asked, as one key. */
function nativeKey(tool: string, input: unknown): string | undefined {
  const args = asRecord(input);
  const target = typeof args?.query === 'string' ? args.query : args?.url;
  return typeof target === 'string' ? `${tool}\n${target}` : undefined;
}

/** A native call's input as the engine's row shows it: a quoted query, or the URL. */
function nativeArgument(input: unknown): string | undefined {
  const args = asRecord(input);
  const query = typeof args?.query === 'string' ? shortKey(args.query) : undefined;
  if (query !== undefined) return `"${query}"`;
  return typeof args?.url === 'string' ? shortKey(args.url) : undefined;
}

function labelOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = clean(value, LABEL_CHARS + 1);
  return label.length > 0 && Array.from(label).length <= LABEL_CHARS ? label : undefined;
}

function shortKey(value: string): string | undefined {
  const text = clean(value, SHOWN_MAX_CHARS + 1);
  return text.length > 0 && Array.from(text).length <= SHOWN_MAX_CHARS ? text : undefined;
}

/** Outside text is hostile on a terminal: control and format characters go. */
function clean(value: string, limit: number): string {
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

/** A call whose result says money left the wallet, and that nothing names. */
async function unnamedCharge($: Dollar, id: string, output: unknown): Promise<boolean> {
  const envelope = envelopeOf(textOf(output));
  if (paidOf(envelope?.cost) === undefined || (await row($, id)) !== undefined) return false;
  return endOf(envelope).label === undefined;
}

/** What the envelope's `cost` (`provider price 0.04 USD`) says left the wallet. */
function paidOf(cost: unknown): string | undefined {
  const paid = Array.isArray(cost)
    ? /^provider price (\d+\.?\d*) USD$/.exec(String(cost[0]))
    : null;
  const atomic = paid === null ? 0n : BigInt(Math.round(Number(paid[1]) * 1e6));
  return atomic === 0n ? undefined : `$${usd(atomic)}`;
}

/** The request tool's envelope: the JSON block whose `status` comes first. */
function envelopeOf(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  for (let at = text.indexOf(ENVELOPE); at !== -1; at = text.indexOf(ENVELOPE, at + 1)) {
    const envelope = asRecord(parseJson(text.slice(at)));
    if (typeof envelope?.status === 'string') return envelope;
  }
  return undefined;
}

/** A stored result's text: a string, or MCP content blocks bare or in `content`. */
function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const blocks = Array.isArray(output) ? output : asRecord(output)?.content;
  if (!Array.isArray(blocks)) return undefined;
  return blocks
    .map((block) => asRecord(block)?.text)
    .filter((text) => typeof text === 'string')
    .join('');
}

/** USDC has 6 decimals; whole cents keep two. */
function usd(atomic: bigint): string {
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${atomic / 1_000_000n}.${fraction.padEnd(2, '0')}`;
}

function atomicOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : undefined;
}

async function tenjinDataDir($: Dollar): Promise<string | null> {
  const override = await $.env.get('TENJIN_DATA_DIR');
  if (override !== undefined && override.length > 0) return override;
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home !== undefined && home.length > 0 ? `${home}/.tenjin` : null;
}

async function readJson($: Dollar, path: string): Promise<Json | null> {
  try {
    return asRecord(parseJson(await $.fs.read(path))) ?? null;
  } catch {
    return null;
  }
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

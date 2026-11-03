import type { EngineInterface, Register, ToolCallResult } from 'claude-code';

import type { TenjinHeld, TenjinRow, TenjinTools } from '../types';

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
 * - A LOOKUP RUN IN A NATIVE CALL'S PLACE (the swap, only when the user turned
 *   on "Run Tenjin's picks automatically") draws on that call's row:
 *   `⏺ Calling Exa search… · $0.007`, then `⏺ Exa search("q") · $0.007`, with
 *   `in place of Web Search` under it, and one transcript line says so.
 *
 * An over-limit answer draws nothing, and the `approve` call that runs its
 * quote draws as the lookup's own row. Free router calls and `needs_input`
 * answers draw nothing; a charged failure
 * draws the error dot, the amount and the state, never a success.
 *
 * EXPANDED: wherever the view shows rows in full (ctrl+o, --verbose: the
 * engine's `isExpanded`, or a run it expanded), every call of ours steps aside
 * and the engine draws its own MCP row, input and result, the calls hidden
 * here included. Its title there is the tool's static one. A row of a run
 * this mod unfolded in the normal view stays compact.
 *
 * READ ONLY: the spec file, the choice set, the offer record and the
 * automatic-use switch in the config (`src/router/mod-state.ts`), and the
 * request tool's own envelope. The mod writes nothing under the data dir and
 * decides nothing about routing or payment: with the switch on it asks the
 * request tool's `decide` form, which decides, checks and runs everything,
 * and the mod only answers the native call with what came back.
 */

const REQUEST_TOOL = 'mcp__plugin_tenjin_router__request';
/** The `approve` call runs a quoted lookup, and draws as that lookup's own row. */
const APPROVE_TOOL = 'mcp__plugin_tenjin_router__approve';
const OURS = new Set([REQUEST_TOOL, APPROVE_TOOL]);
/** The native tools a hook holds, by the names the engine draws them under. */
const NATIVE_NAMES: Readonly<Record<string, string>> = {
  WebSearch: 'Web Search',
  WebFetch: 'Fetch',
};
const ROWS = { plugin: 'tenjin', key: 'rows' } as const;
const HELD = { plugin: 'tenjin', key: 'held' } as const;
const LINKS = { plugin: 'tenjin', key: 'links' } as const;
const TOOLS = { plugin: 'tenjin', key: 'tools' } as const;
const TOOLS_PANE = 'tenjin-tools';
const PAGE_SIZE = 10;
/**
 * Calls of a run the ENGINE expanded (ctrl+o, --verbose), where our rows step
 * aside for the engine's own. The module's own memory, not `$.state`: a drawing may
 * not write state, and this is a fact about the drawing alone. A reload
 * forgets it, so a row draws one line until its run is expanded again.
 */
const expandedByEngine = new Set<string>();
/** Calls of a run this mod unfolded in the normal view, whose rows the engine
 *  marks `isExpanded` though nobody asked to see them in full. */
const unfoldedByUs = new Set<string>();
const DOT = '⏺';
const GUTTER = '  ⎿  ';
const INDENT = '     ';
const EXPAND_HINT = '(ctrl+o to expand)';
const LABEL_CHARS = 32;
const SHOWN_MAX_CHARS = 80;
const ENVELOPE = '{"status":"';
const SECRET_NAME = /(api[_-]?key|token|secret|passw|authorization|cookie|private[_-]?key)/i;
/** Answers that ran nothing the person paid for: the router's own, or a retry ahead. */
const HIDDEN = new Set([
  'spec',
  'discovered',
  'native',
  'browse',
  'inspection',
  'needs_input',
  'needs_approval',
]);
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
  on('command.run', { command: 'tenjin:tools' }, async ($, e) => {
    const opened = await $.ui.open({ id: TOOLS_PANE, title: 'Tenjin tools' });
    const inspection = await inspectTools($, e.args ?? '');
    return {
      text: opened.isPlaced ? 'Tenjin tools opened. Refresh after changing settings.' : inspection,
    };
  });

  on('ui.render', { component: 'Pane', requestId: 'tenjin-tools' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input;
    const snapshot = await $.state.get(TOOLS);
    const { value } = snapshot;
    if (value === undefined || value.loading) return <Text>Loading Tenjin tools…</Text>;
    const pages = Math.max(1, Math.ceil(value.lines.length / PAGE_SIZE));
    const page = Math.min(value.page, pages - 1);
    const move = async (offset: number) => {
      await $.state.set(
        TOOLS,
        { ...value, page: Math.max(0, Math.min(pages - 1, page + offset)) },
        {
          ifVersion: snapshot.version,
        },
      );
    };
    return (
      <Box flexDirection="column">
        {Input !== undefined && (
          <Input
            key="tools-filter"
            label="Filter tools"
            value={value.filter}
            placeholder="Name, task, source or state"
            submitLabel="search"
            onSubmit={async (filter) => {
              await inspectTools($, filter);
            }}
          />
        )}
        {value.header.map((line) => (
          <Text>{line}</Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          {value.lines.length === 0 ? (
            <Text>No matching tools.</Text>
          ) : (
            value.lines
              .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
              .map((line) => <Text>{line}</Text>)
          )}
        </Box>
        <Box marginTop={1}>
          {page > 0 && <Button key="tools-previous" label="Previous" onPress={() => move(-1)} />}
          <Text>
            {' '}
            Page {page + 1} of {pages}{' '}
          </Text>
          {page + 1 < pages && <Button key="tools-next" label="Next" onPress={() => move(1)} />}
          <Button
            key="tools-refresh"
            label="Refresh"
            onPress={async () => {
              await inspectTools($, value.filter);
            }}
          />
          <Button
            key="tools-close"
            label="Close"
            role="dismiss"
            onPress={() => $.ui.close({ id: TOOLS_PANE })}
          />
        </Box>
      </Box>
    );
  });

  on('tool.call', { tool: REQUEST_TOOL }, async ($, e, next) => {
    if (e.inspect !== undefined) return next(e);
    // The swap's own `decide` call is drawn on the native call's row.
    if (e.decide !== undefined) return next(e);
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
    const envelope = envelopeOf(ran.text);
    const ended = endOf(envelope);
    const label = row?.label ?? ended.label;
    // A job poll is not a lookup of its own (see `rowOf`).
    if (label !== undefined && !isJobPoll(e)) {
      await $.state.set(ref, { ...row, ...ended, label });
      // OVER A LIMIT: the quote the `approve` call will run, for its row's name.
      const quote = asRecord(envelope?.quote)?.id;
      if (typeof quote === 'string')
        await $.state.set({ ...LINKS, id: `quote:${quote}` }, e.tool_use_id);
      $.ui.invalidate('ui.render');
    }
    return ran;
  });

  // THE APPROVE CALL IS THE LOOKUP: named as the request it quoted, priced at
  // the total the person approved, drawn as that lookup's own row.
  on('tool.call', { tool: APPROVE_TOOL }, async ($, e, next) => {
    const from = typeof e.quote === 'string' ? await link($, `quote:${e.quote}`) : undefined;
    const asked = from === undefined ? undefined : await row($, from);
    const ref = { ...ROWS, id: e.tool_use_id };
    const total = typeof e.total === 'string' && /^\$?\d/.test(e.total) ? e.total : undefined;
    const price = total === undefined ? asked?.price : total.startsWith('$') ? total : `$${total}`;
    const quoted: TenjinRow | undefined =
      asked === undefined
        ? undefined
        : {
            label: asked.label,
            ...(price !== undefined ? { price } : {}),
            ...(asked.argument !== undefined ? { argument: asked.argument } : {}),
          };
    if (quoted !== undefined) {
      await $.state.set(ref, quoted);
      $.ui.invalidate('ui.render');
    }
    const ran = await next(e);
    if (quoted !== undefined) {
      await $.state.set(ref, { ...quoted, ...endOf(envelopeOf(ran.text)), label: quoted.label });
      $.ui.invalidate('ui.render');
    }
    return ran;
  });

  // A native call the router held: its offer, from the CLI's record. One the
  // router let run, for a held call with the same search to give way to.
  // FIRST, with automatic use on, the swap: answered in place, or passed on.
  on('tool.call', { tool: ['WebSearch', 'WebFetch'] }, async ($, e, next) => {
    const swapped = await swap($, e);
    if (swapped !== null) return swapped;
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
      for (const id of ids) unfoldedByUs.delete(id);
      if (fresh.length > 0) $.ui.invalidate('ui.render');
      return next(e);
    }
    // Back in the normal view, and unfolded by us: one line per row, nothing beneath.
    if (ids.filter((id) => expandedByEngine.delete(id)).length > 0) $.ui.invalidate('ui.render');
    const unfold = () => {
      for (const id of ids) unfoldedByUs.add(id);
      return next({ ...e, props: { ...e.props, isExpanded: true } });
    };
    const ours = calls.filter((c) => OURS.has(c.tool));
    const others = calls.filter((c) => !OURS.has(c.tool));
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
    return <ui.Box flexDirection="column">{drawn.map((row) => callRow(ui, row))}</ui.Box>;
  });

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, tool_use_id, input, isInterrupted } = e.props;
    if (tool in NATIVE_NAMES && !isInterrupted) {
      const key = nativeKey(tool, input);
      const held = await heldOf($, tool_use_id, key);
      if (held === null) return next(e);
      const ui = $.ui.resolve(e);
      const asked = nativeArgument(input);
      if (held.swap === true) return swapRow(ui, tool, held, await row($, tool_use_id), asked);
      const takerId = await link($, `take:${held.offerId}`);
      const taker = takerId === undefined ? undefined : await row($, takerId);
      if (
        taker !== undefined &&
        taker.status !== 'needs_input' &&
        taker.status !== 'needs_approval'
      ) {
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
    if (!OURS.has(tool)) return next(e);
    const ui = $.ui.resolve(e);
    // SHOWN IN FULL (ctrl+o, --verbose, a run the engine expanded): every call
    // of ours is the engine's own row, input and result, the hidden ones too.
    // A row of a run this mod unfolded is marked expanded, and stays compact.
    const full =
      expandedByEngine.has(tool_use_id) ||
      (e.props.isExpanded === true && !unfoldedByUs.has(tool_use_id));
    if (full) return next(e);
    const drawn = await rowOf($, tool_use_id, e.props);
    // A charged call this mod cannot name is the engine's row, never hidden.
    if (drawn === null)
      return (await unnamedCharge($, tool_use_id, e.props.output)) ? (
        next(e)
      ) : (
        <ui.Box display="none" />
      );
    return callRow(ui, drawn);
  });

  // The envelope the model read, and a held call's deny: the row says both.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e);
    if (OURS.has(e.props.tool)) {
      if (e.props.isExpanded === true) return next(e);
      const unnamed = await unnamedCharge($, e.props.tool_use_id, e.props.output);
      return unnamed ? next(e) : <Box display="none" />;
    }
    if (!(e.props.tool in NATIVE_NAMES)) return next(e);
    const held = await heldOf($, e.props.tool_use_id, undefined);
    // A call answered in place shows its result wherever rows show in full.
    if (held?.swap === true && e.props.isExpanded === true) return next(e);
    return held === null ? next(e) : <Box display="none" />;
  });
};

async function inspectTools($: Dollar, filter: string): Promise<string> {
  const pending: TenjinTools = {
    filter: clean(filter, 1000),
    header: [],
    lines: [],
    page: 0,
    loading: true,
  };
  const saved = await $.state.set(TOOLS, pending);
  let view: TenjinTools;
  try {
    const answer = await $.tool.call({ tool: REQUEST_TOOL, inspect: pending.filter });
    const envelope = envelopeOf(answer.text);
    const result = asRecord(envelope?.view);
    const lines = (value: unknown) =>
      Array.isArray(value) && value.every((line) => typeof line === 'string');
    if (envelope?.status !== 'inspection' || !lines(result?.header) || !lines(result?.lines))
      throw new Error('No inspection was returned.');
    view = {
      ...pending,
      loading: false,
      header: (result!.header as string[]).map((line) => clean(line, 1000)),
      lines: (result!.lines as string[]).map((line) => clean(line, 1000)),
    };
  } catch {
    view = {
      ...pending,
      loading: false,
      header: [
        'Tool inspection could not be loaded. Refresh to try again, or ask your agent to run tenjin tools.',
      ],
    };
  }
  // A newer search or refresh owns the pane if this request finishes late.
  await $.state.set(TOOLS, view, { ifVersion: saved.version });
  return [...view.header, ...view.lines].join('\n');
}

/** How often a native call being answered in place is redrawn, so its row
 *  names the pick once the CLI has recorded it. */
const SWAP_REDRAW_MS = 500;

/**
 * THE SWAP, ONLY WHEN THE USER TURNED IT ON (`router.nativeReplacement:
 * when-routed` in the global config the CLI writes): the request tool's
 * `decide` form is asked about this native call before it runs. It answers
 * with the lookup it ran in the call's place (`via: "swap"`), or hands the
 * call back, and then null: the call takes the host's ordinary route. The mod
 * builds no input, reads no hint and decides nothing; it only answers the
 * native call with what came back. A fulfilled lookup is the native tool's
 * own result shape carrying the request tool's whole text; anything else
 * that ran is a refusal of the call carrying that text, so a failure is never
 * read as a page or a search that worked, and nothing runs again natively.
 */
async function swap($: Dollar, e: Json): Promise<ToolCallResult | null> {
  const tool = e.tool === 'WebSearch' || e.tool === 'WebFetch' ? e.tool : undefined;
  if (tool === undefined || e.agentId !== undefined || typeof e.tool_use_id !== 'string') {
    return null;
  }
  // A SEARCH LIMITED TO SOME DOMAINS keeps its own tool: the pick would not be.
  if (hasEntries(e.allowed_domains) || hasEntries(e.blocked_domains)) return null;
  const target = tool === 'WebSearch' ? e.query : e.url;
  if (typeof target !== 'string' || target.length === 0) return null;
  const dataDir = await tenjinDataDir($);
  if (dataDir === null) return null;
  const router = asRecord((await readJson($, `${dataDir}/config.json`))?.router);
  if (router?.nativeReplacement !== 'when-routed' || router.enabled === false) return null;
  const startedAt = await $.clock.now();
  const redraw = $.clock.every(SWAP_REDRAW_MS, () => $.ui.invalidate('ui.render'));
  let answer: ToolCallResult;
  try {
    answer = await $.tool.call({
      tool: REQUEST_TOOL,
      decide: {
        tool,
        input: tool === 'WebSearch' ? { query: target } : { url: target },
        tool_use_id: e.tool_use_id,
        session_id: await $.session.id(),
      },
    });
  } catch {
    return null;
  } finally {
    redraw.cancel();
  }
  const text = answer.text;
  const envelope = envelopeOf(text);
  if (text === undefined || envelope?.via !== 'swap') return null;
  // THE LOOKUP RAN: from here the answer is its result, whatever the drawing
  // makes of it, and the native call never runs as well.
  const ended = endOf(envelope);
  await drawSwap($, e.tool_use_id, tool, e, ended).catch(() => undefined);
  const status = String(envelope.status);
  if (status !== 'fulfilled' && status !== 'running') return { deny: text };
  const elapsed = Math.max(0, (await $.clock.now().catch(() => startedAt)) - startedAt);
  return tool === 'WebSearch'
    ? { result: { query: target, results: [text], durationSeconds: elapsed / 1000 } }
    : {
        result: {
          url: target,
          code: status === 'fulfilled' ? 200 : 202,
          codeText: status === 'fulfilled' ? 'OK' : 'Accepted',
          bytes: new TextEncoder().encode(text).length,
          result: text,
          durationMs: elapsed,
        },
      };
}

/** The row, its state and the one transcript line for a call answered in place. */
async function drawSwap(
  $: Dollar,
  id: string,
  tool: 'WebSearch' | 'WebFetch',
  e: Json,
  ended: Partial<TenjinRow>,
): Promise<void> {
  const key = nativeKey(tool, e);
  const held = await offerRecord($, id, key);
  const label = ended.label ?? held?.label ?? 'Tenjin lookup';
  const asked = nativeArgument(e);
  const price = held?.price !== undefined ? { price: held.price } : {};
  await $.state.set(
    { ...HELD, id },
    { offerId: held?.offerId ?? id, key: key ?? '', label, swap: true, ...price },
  );
  await $.state.set(
    { ...ROWS, id },
    { ...price, ...ended, label, ...(asked !== undefined ? { argument: asked } : {}) },
  );
  const cost = ended.paid ?? held?.price;
  $.ui.log(
    `Tenjin ran ${label} in place of ${NATIVE_NAMES[tool] as string}${cost !== undefined ? ` · ${cost}` : ''}`,
  );
  $.ui.invalidate('ui.render');
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** A native call answered in place: the pick's own row where the call stood,
 *  and the one line saying what did not run. */
function swapRow(
  ui: Elements,
  tool: string,
  held: TenjinHeld,
  ended: TenjinRow | undefined,
  asked: string | undefined,
) {
  const name = ended?.label ?? held.label ?? (NATIVE_NAMES[tool] as string);
  const shape: Shape =
    ended?.status !== undefined
      ? { ...shapeOf(ended), name }
      : {
          state: 'running',
          name: `Calling ${name}…`,
          ...(held.price !== undefined ? { tail: ` · ${held.price}` } : {}),
        };
  const head = line(ui, asked !== undefined ? { ...shape, argument: asked } : shape);
  return block(ui, head, [`in place of ${NATIVE_NAMES[tool] as string}`]);
}

/** A paid call before it runs: `{id, input}` with a kept spec, or `{id,
 *  choice, input}` with the choice set kept beside the line's id. Null for the
 *  router's own calls. */
async function describeCall($: Dollar, e: Json): Promise<TenjinRow | null> {
  const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : undefined;
  const input = asRecord(e.input);
  const dataDir = await tenjinDataDir($);
  if (id === undefined || input === undefined || dataDir === null) return null;
  const read = async (key: string) =>
    readJson($, `${dataDir}/progress/specs/${await sha256Hex(key)}.json`);
  const choice = typeof e.choice === 'string' && e.choice.length > 0 ? e.choice : undefined;
  if (choice !== undefined) {
    // A CHOICE runs the picked option under its own id, named as the line
    // named it ("GPT Image 2.5 Sunburst"); `all` runs every option.
    const kept = await readJson($, `${dataDir}/progress/specs/${await sha256Hex(id)}.choices.json`);
    const options = (asRecord(kept?.choices)?.options as unknown[] | undefined) ?? [];
    const picked = options.map(asRecord).filter((o) => o?.key === choice || choice === 'all');
    const specs = await Promise.all(picked.map((o) => read(String(o?.id))));
    const label = choice === 'all' ? `${picked.length} services` : labelOf(picked[0]?.label);
    if (picked.length === 0 || label === undefined) return null;
    return { label, offerId: id, ...priced(specs, 1n), ...shownOf(specs, input, choice) };
  }
  const spec = await read(id);
  // A Bazaar spec carries no label: the provider's own name stands in.
  const label = labelOf(spec?.label) ?? labelOf(spec?.provider);
  if (spec === null || label === undefined) return null;
  const takes = typeof e.count === 'number' && e.count > 1 ? BigInt(e.count) : 1n;
  return { label, offerId: id, ...priced([spec], takes), ...shownOf([spec], input) };
}

/** What the specs cost together, `takes` times each: `$0.04`, or `up to $0.05`. */
function priced(specs: (Json | null)[], takes: bigint): { price?: string } {
  let total = 0n;
  let varies = false;
  for (const spec of specs) {
    varies ||= spec?.priceVaries === true;
    const each = atomicOf(spec?.priceVaries === true ? spec.maxAmountAtomic : spec?.priceAtomic);
    if (each === undefined) return {};
    total += BigInt(each) * takes;
  }
  return { price: `${varies ? 'up to ' : ''}$${usd(total)}` };
}

/** The one input the CLI marked shown for a single spec; none for `all`. */
function shownOf(specs: (Json | null)[], input: Json, choice?: string): { argument?: string } {
  const field = specs.length === 1 && choice !== 'all' ? specs[0]?.shown : undefined;
  if (typeof field !== 'string' || SECRET_NAME.test(field)) return {};
  const argument = typeof input[field] === 'string' ? shortKey(input[field]) : undefined;
  return argument !== undefined ? { argument } : {};
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
): Promise<TenjinRow | null> {
  const stored = await row($, id);
  // A JOB POLL repeats the result and the cost of the call that started it,
  // and the swap's `decide` call is drawn on the native call's own row.
  if (isJobPoll(asRecord(call.input)) || asRecord(call.input)?.decide !== undefined) return null;
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
  if (offer !== undefined && (await link($, `hold:${offer}`)) !== undefined) {
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
  const hint = ` ${EXPAND_HINT}`;
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2} />
      <Text dimColor>{`Called ${row.label}${shapeOf(row).tail ?? ''}${hint}`}</Text>
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
  const price = atomicOf(record.priceAtomic);
  return {
    offerId: record.offerId,
    key: key ?? '',
    ...(label !== undefined ? { label } : {}),
    ...(record.swap === true ? { swap: true as const } : {}),
    ...(price !== undefined ? { price: `$${usd(BigInt(price))}` } : {}),
  };
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
  // "Reseller (Model)" names the model the person asked for: the trailing
  // group's contents. One still over the cap is cut with an ellipsis, never dropped.
  const text = clean(value, value.length + 1);
  const name = (trailingGroup(text) ?? text).trim();
  const chars = Array.from(name);
  if (chars.length === 0) return undefined;
  return chars.length <= LABEL_CHARS
    ? name
    : `${chars
        .slice(0, LABEL_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}

/** The contents of a name's last balanced " (…)" group, or undefined when it
 *  ends in none or its parentheses do not balance ("Foo (beta"). */
function trailingGroup(text: string): string | undefined {
  if (!text.endsWith(')')) return undefined;
  let depth = 0;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (text[at] === ')') depth += 1;
    else if (text[at] === '(' && --depth === 0) {
      return at > 1 && text[at - 1] === ' ' ? text.slice(at + 1, -1) : undefined;
    }
  }
  return undefined;
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

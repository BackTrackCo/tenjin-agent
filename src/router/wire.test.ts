import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildBrowseBody,
  buildHookBody,
  buildOutcomeBody,
  buildToolBody,
  buildToolSpecBody,
  buildWarmBody,
  acceptsFor,
  CLIENT_ACCEPTS,
  isWarmAnswer,
  MAX_SPEC_TIMEOUT_S,
  parseForTests,
  REQUIRES_UNMET,
  unmetRequires,
  withoutUnmet,
  type HookDecision,
  type SpecOutcome,
  type ToolDecision,
  type ToolSpec,
} from './decision';
import { buildSpecRequest, mergedInput } from './spec-call';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import { MAX_PACKET_BYTES, type Packet } from './context';
import type { Harness } from './names';
import { AFTER_CALL_TIMEOUT_SECONDS, ROUTE_HOOK_TIMEOUT_SECONDS } from './install';
import { STDIN_TIMEOUT_MS } from './hook-command';
import { BALANCE_TIMEOUT_MS, RPC_TIMEOUT_MS } from './routing-payer';
import { MAX_PAID_LEG_TIMEOUT_MS } from '../commands/pay';
import { MAX_BINARY_BODY_BYTES } from '../lib/http';

/**
 * The wire, pinned to bytes. These payloads are the canonical set: tenjin's
 * `lib/x402-router/` parses the same files with the schemas it writes
 * against, so a rename on either side fails a test in both repos instead of
 * 400ing a lookup in production.
 *
 * THEY ARE READ FROM THE DIRECTORY, never from a hand-written import list. A
 * payload the canonical set gains and a list never names is how a nested field
 * shipped unparsed three times.
 */

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
}

describe('the request bodies', () => {
  /**
   * THE ROUTE READS THESE WITH STRICT OBJECTS, so an extra field is a 400 and
   * a 400 is a turn with no hint. Which hook is asking is not a field: the
   * route reads it from `packet.pendingCall`, which the native hook sets and
   * the prompt hook does not.
   */
  it.each([
    ['wire-hook-request-prompt.json'],
    ['wire-hook-request-native.json'],
    ['wire-hook-request-native-shortfall.json'],
    ['wire-hook-request-native-no-content.json'],
  ])('builds %s byte for byte', (name) => {
    const canonical = fixture(name);
    expect(buildHookBody(canonical.packet as Packet)).toEqual(canonical);
  });

  it('tells the two hook bodies apart only by the pending call', () => {
    const prompt = fixture('wire-hook-request-prompt.json').packet as Packet;
    const native = fixture('wire-hook-request-native.json').packet as Packet;
    expect(prompt.pendingCall).toBeUndefined();
    expect(native.pendingCall).toEqual({ tool: 'WebSearch', query: 'btc eth price today' });
    for (const packet of [prompt, native]) {
      expect(Object.keys(buildHookBody(packet)).sort()).toEqual(['packet', 'schemaVersion']);
      expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
      expect(packet.historyStatus).toBe('ok');
    }
  });

  /**
   * THE SHORTFALL RIDES BESIDE ITS CALL. `nativeOutcome` is valid only with a
   * `pendingCall` and carries at least one field; the server refuses anything
   * else, and a server that predates it refuses it outright, which the hook
   * reads as silence.
   */
  it('carries a shortfall only beside the call it is about', () => {
    const packet = fixture('wire-hook-request-native-shortfall.json').packet as Packet;
    expect(packet.pendingCall).toEqual({
      tool: 'WebFetch',
      url: 'https://x.com/x402/status/1971234567890123456',
    });
    expect(packet.nativeOutcome).toEqual({ code: 402, bytes: 0 });
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });

  /**
   * A 200 THAT CAME BACK EMPTY SAYS WHY. Its code and size look like a page,
   * so the client names what it read in WebFetch's summary, and the server
   * picks the reader from the URL. A server that predates `reason` refuses the
   * packet, which the hook reads as silence: no offer, as before.
   */
  it('names why a 200 with a full body still fell short', () => {
    const packet = fixture('wire-hook-request-native-no-content.json').packet as Packet;
    expect(packet.pendingCall).toEqual({
      tool: 'WebFetch',
      url: 'https://app.uniswap.org/explore/tokens',
    });
    expect(packet.nativeOutcome).toEqual({ code: 200, bytes: 85_717, reason: 'no_main_content' });
  });

  /**
   * THE NEW CLIENT SAYS WHAT IT CAN READ. `accepts` lists `discovered` on both
   * calls, so a server answers that arm only to a build that parses it, and
   * the hook's `sessionId` lets it offer one discovered service once per
   * session. The bodies above without `accepts` stay valid on the wire: they
   * are what an older client sends, and the server answers them `native` with
   * a diagnostic saying to update. So does the body below, from a build that
   * did not yet take `choices`.
   */
  it('builds the hook request with the session and what it accepts, byte for byte', () => {
    const canonical = fixture('wire-hook-request-ask.json');
    expect(
      buildHookBody(canonical.packet as Packet, {
        sessionId: canonical.sessionId as string,
        accepts: canonical.accepts as string[],
      }),
    ).toEqual(canonical);
    const packet = canonical.packet as Packet;
    expect(packet.pendingCall).toEqual({
      tool: 'AskUserQuestion',
      question: expect.any(String) as string,
    });
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });

  /** A released build's request, which still asks for `discovered` and
   *  `choices`: the server keeps answering it in today's shapes. */
  it("builds a released build's request with choices, byte for byte", () => {
    const canonical = fixture('wire-hook-request-choices.json');
    expect(
      buildHookBody(canonical.packet as Packet, {
        sessionId: canonical.sessionId as string,
        accepts: canonical.accepts as string[],
      }),
    ).toEqual(canonical);
  });

  /** A RELEASED BUILD SENDS `catalog`: a Tenjin list service as `discovered`
   *  under its catalog id, each spec's `holds` and `output`, and `choices`.
   *  `bazaar` rides only while `experimental.bazaar` is on. */
  it("builds a released build's catalog request, byte for byte", () => {
    const canonical = fixture('wire-hook-request-catalog.json');
    expect(
      buildHookBody(canonical.packet as Packet, {
        sessionId: canonical.sessionId as string,
        accepts: canonical.accepts as string[],
      }),
    ).toEqual(canonical);
    const tool = fixture('wire-tool-request-catalog.json');
    expect(
      buildToolBody({ query: tool.query as string, accepts: tool.accepts as string[] }),
    ).toEqual(tool);
  });

  /**
   * WHAT THIS BUILD SAYS IT RUNS. Each token is one the server's README names
   * as read (`spec`, `catalog`, `label`, `fields`, `jobs`, `headers`, `note`,
   * `tolerant`, and `bazaar` behind its experiment), so the server sends each
   * field this build parses and none it does not. A token is added only with
   * the parser that takes its fields.
   */
  it("sends this build's accepts: the contract tokens it parses and runs", () => {
    expect(CLIENT_ACCEPTS).toEqual([
      'catalog',
      'spec',
      'label',
      'fields',
      'jobs',
      'headers',
      'note',
      'tolerant',
    ]);
    expect(acceptsFor(false)).toEqual([
      ...(fixture('wire-tool-request-catalog.json').accepts as string[]),
      'label',
      'fields',
      'jobs',
      'headers',
      'note',
      'tolerant',
    ]);
    expect(acceptsFor(true)).toEqual([
      'catalog',
      'spec',
      'label',
      'fields',
      'jobs',
      'headers',
      'note',
      'tolerant',
      'bazaar',
    ]);
    const read = [
      'spec',
      'catalog',
      'label',
      'fields',
      'jobs',
      'headers',
      'note',
      'tolerant',
      'discovered',
      'bazaar',
      'choices',
    ];
    for (const token of acceptsFor(true)) expect(read).toContain(token);
    // The server's bounds: up to 16 tokens, each 1 to 32 characters.
    expect(acceptsFor(true).length).toBeLessThanOrEqual(16);
    for (const token of acceptsFor(true)) expect(token.length).toBeLessThanOrEqual(32);
  });

  it('builds the browse of the tool list and a row id request, byte for byte', () => {
    const browse = fixture('wire-browse-request.json');
    expect(
      buildBrowseBody({ browse: browse.browse as string, accepts: browse.accepts as string[] }),
    ).toEqual(browse);
    const tool = fixture('wire-tool-request-by-id.json');
    expect(
      buildToolSpecBody({ tool: tool.tool as string, accepts: tool.accepts as string[] }),
    ).toEqual(tool);
    for (const body of [browse, tool]) {
      expect(Object.keys(body)).not.toContain('packet');
      expect(Object.keys(body)).not.toContain('query');
    }
  });

  it('builds the query with no id that a spec answers, byte for byte', () => {
    const canonical = fixture('wire-tool-request-spec.json');
    expect(canonical.id).toBeUndefined();
    expect(
      buildToolBody({ query: canonical.query as string, accepts: canonical.accepts as string[] }),
    ).toEqual(canonical);
  });

  /**
   * THE BACKGROUND TOP-UP'S CARRIER (tenjin#1046): the paid route's `warm`
   * call, byte for byte, and its answer, which carries no decision. A router
   * without the form answers anything else, which the top-up reads as absent.
   */
  it('sends warm byte for byte, and reads its answer and nothing else as warm', () => {
    const canonical = fixture('wire-warm-request.json');
    expect(
      buildWarmBody({
        accepts: canonical.accepts as string[],
        harness: canonical.harness as Harness,
      }),
    ).toEqual(canonical);
    expect(buildWarmBody()).toEqual({ schemaVersion: 1, warm: true });
    expect(JSON.stringify(canonical)).not.toMatch(/billing|admission|payment/i);
    const answer = fixture('wire-warm.json');
    expect(isWarmAnswer(answer)).toBe(true);
    expect(isWarmAnswer({ ...answer, surprise: 1 })).toBe(true);
    expect(isWarmAnswer({ ...answer, warm: false })).toBe(false);
    expect(isWarmAnswer(fixture('wire-hook-native.json'))).toBe(false);
    expect(isWarmAnswer({ error: { code: 'bad_request', message: 'warm' } })).toBe(false);
    // A warm answer is no decision on either call.
    expect(parseForTests('hook', answer).success).toBe(false);
    expect(parseForTests('tool', answer).success).toBe(false);
  });

  /**
   * THE TOLERANT EXCHANGE: what this build sends for a browse row's id, and
   * the answer only a `tolerant` client gets, with `honored` and the spec's
   * `requires`. The reader keeps what it knows and drops `honored`.
   */
  it('sends the tolerant by-id request byte for byte, and reads its answer with requires kept', () => {
    const canonical = fixture('wire-tool-request-by-id-tolerant.json');
    expect(
      buildToolSpecBody({
        tool: canonical.tool as string,
        accepts: acceptsFor(false),
        harness: 'claude',
      }),
    ).toEqual(canonical);
    const answer = fixture('wire-lookup-spec-tolerant.json');
    expect(answer.honored).toEqual(['schemaVersion', 'tool', 'accepts', 'harness']);
    const parsed = parseForTests('tool', answer);
    expect(parsed.success).toBe(true);
    const read = parsed.data as { honored?: unknown; decision: { spec: ToolSpec } };
    expect(read).not.toHaveProperty('honored');
    expect(read.decision.spec.requires).toEqual(['jobs']);
    expect(unmetRequires(read.decision.spec.requires)).toEqual([]);
  });

  it('reports a call run from a spec by its id and how it ended, byte for byte, with no text', () => {
    const canonical = fixture('wire-outcome-request.json');
    expect(buildOutcomeBody(canonical as unknown as SpecOutcome)).toEqual(canonical);
    expect(Object.keys(canonical).sort()).toEqual([
      'httpStatus',
      'id',
      'ms',
      'schemaVersion',
      'status',
    ]);
  });

  it('reports a call stopped before payment with its reason, byte for byte, with no text', () => {
    const canonical = fixture('wire-outcome-unpaid.json');
    expect(buildOutcomeBody(canonical as unknown as SpecOutcome)).toEqual(canonical);
    expect(JSON.stringify(buildOutcomeBody(canonical as unknown as SpecOutcome), null, 2)).toBe(
      readFileSync(join(dir, 'wire-outcome-unpaid.json'), 'utf8').trimEnd(),
    );
    expect(Object.keys(canonical)).toEqual([
      'schemaVersion',
      'id',
      'status',
      'reason',
      'httpStatus',
      'ms',
    ]);
  });

  /** A CODEX CLIENT NAMES ITS HOST, the server's own fixture copied across. */
  it('builds the Codex hook request with its harness, byte for byte', () => {
    const canonical = fixture('wire-hook-request-harness.json');
    expect(
      buildHookBody(canonical.packet as Packet, {
        accepts: canonical.accepts as string[],
        harness: 'codex',
      }),
    ).toEqual(canonical);
  });

  /**
   * THE CLAUDE REPLAY. Every request this build sends, rebuilt the way it now
   * goes out from Claude Code: the one change is `harness: "claude"`, with
   * every other field and its value as before.
   */
  it('replays every Claude request with harness as the only new field', () => {
    const hooks = readdirSync(dir).filter(
      (name) => name.startsWith('wire-hook-request-') && name !== 'wire-hook-request-harness.json',
    );
    expect(hooks.length).toBeGreaterThanOrEqual(7);
    for (const name of hooks) {
      const canonical = fixture(name);
      const body = buildHookBody(canonical.packet as Packet, {
        ...(canonical.sessionId !== undefined ? { sessionId: canonical.sessionId as string } : {}),
        ...(canonical.accepts !== undefined ? { accepts: canonical.accepts as string[] } : {}),
        harness: 'claude',
      });
      expect(body, name).toEqual({ ...canonical, harness: 'claude' });
    }
    for (const name of readdirSync(dir).filter((n) => n.startsWith('wire-tool-request-'))) {
      const canonical = fixture(name);
      const accepts = canonical.accepts as string[];
      // A browse row's id is its own form; every other tool request is a query.
      const body =
        typeof canonical.tool === 'string'
          ? buildToolSpecBody({ tool: canonical.tool, accepts, harness: 'claude' })
          : buildToolBody({ query: canonical.query as string, accepts, harness: 'claude' });
      expect(body, name).toEqual({ ...canonical, harness: 'claude' });
    }
    const browse = fixture('wire-browse-request.json');
    expect(
      buildBrowseBody({
        browse: browse.browse as string,
        accepts: browse.accepts as string[],
        harness: 'claude',
      }),
    ).toEqual({ ...browse, harness: 'claude' });
    for (const name of ['wire-outcome-request.json', 'wire-outcome-unpaid.json']) {
      const canonical = fixture(name);
      const body = buildOutcomeBody(canonical as unknown as SpecOutcome, 'claude');
      expect(body, name).toEqual({ ...canonical, harness: 'claude' });
    }
  });

  it('carries nothing about money on any form', () => {
    for (const name of [
      'wire-hook-request-prompt.json',
      'wire-hook-request-native.json',
      'wire-hook-request-native-shortfall.json',
      'wire-hook-request-native-no-content.json',
      'wire-hook-request-ask.json',
      'wire-hook-request-choices.json',
      'wire-hook-request-catalog.json',
      'wire-tool-request-spec.json',
      'wire-tool-request-catalog.json',
      'wire-browse-request.json',
      'wire-tool-request-by-id.json',
      'wire-hook-request-harness.json',
    ]) {
      expect(JSON.stringify(fixture(name))).not.toMatch(/billing|admission|payment/i);
    }
  });
});

/**
 * ONE VARIANT PER ANSWER. Optional fields made every shape legal: an `execute`
 * with no contract parsed and reached the host as a routine `needs_input`, a
 * non-execute with no diagnostics parsed with nothing to act on, and a hook
 * answer carrying a contract parsed as though the hook had quoted a price. Each
 * fixture must now match exactly one variant of exactly one parser.
 */
describe('every answer payload on disk', () => {
  const hookAnswers = readdirSync(dir).filter(
    (name) => name.startsWith('wire-hook-') && !name.startsWith('wire-hook-request-'),
  );
  const toolAnswers = readdirSync(dir).filter((name) => name.startsWith('wire-lookup-'));

  it('parses each answer with its own call, and NOT with the other', () => {
    expect(hookAnswers.length).toBeGreaterThanOrEqual(3);
    expect(toolAnswers.length).toBeGreaterThanOrEqual(5);
    for (const name of hookAnswers) {
      expect(parseForTests('hook', fixture(name)), `${name} is a hook answer`).toMatchObject({
        success: true,
      });
    }
    for (const name of toolAnswers) {
      expect(parseForTests('tool', fixture(name)), `${name} is a tool answer`).toMatchObject({
        success: true,
      });
    }
    // An execute answer belongs to one call only: the hook's carries an id and
    // no contract, the tool's a contract and no id.
    expect(parseForTests('tool', fixture('wire-hook-execute.json')).success).toBe(false);
    expect(parseForTests('hook', fixture('wire-lookup-expired-id.json')).success).toBe(false);
    // A spec answer is the tool's alone: the hook offers by line.
    expect(parseForTests('hook', fixture('wire-lookup-spec-skeleton.json')).success).toBe(false);
    // A discovered answer is ONE shape on both calls: the hook's offer and the
    // tool's fallback parse with either parser.
    for (const name of [
      'wire-hook-discovered.json',
      'wire-lookup-discovered.json',
      'wire-hook-discovered-spec.json',
      'wire-hook-discovered-choices.json',
      'wire-lookup-discovered-choices.json',
      'wire-hook-discovered-catalog.json',
      'wire-lookup-discovered-catalog.json',
    ]) {
      expect(parseForTests('hook', fixture(name)).success, name).toBe(true);
      expect(parseForTests('tool', fixture(name)).success, name).toBe(true);
    }
  });

  /**
   * A TENJIN LIST SERVICE TO A `catalog` CLIENT IS `discovered`, as it always
   * was, under its catalog id rather than a `discovered:` one, and each spec
   * says its result is `media`, so its files are saved as before.
   */
  it.each([['wire-hook-discovered-catalog.json'], ['wire-lookup-discovered-catalog.json']])(
    'parses %s as discovered, under catalog ids, with media output',
    (name) => {
      const decision = fixture(name).decision as {
        action: string;
        hint: string;
        specs: { id: string; capabilityId: string; output?: string }[];
      };
      expect(decision.action).toBe('discovered');
      expect(decision.specs.length).toBeGreaterThan(0);
      for (const spec of decision.specs) {
        expect(spec.capabilityId).not.toMatch(/^discovered:/);
        expect(spec.output).toBe('media');
        expect(decision.hint).toContain(`id: "${spec.id}"`);
      }
    },
  );

  /**
   * A QUERY WITH NO ID ONLY PICKS. The answer is the service's spec under a
   * fresh id and the skeleton the agent fills for the next call. An `input`
   * an older router still binds parses too, and the client never reads it.
   */
  it('carries only the skeleton on an id-less spec answer, and still parses one with an input', () => {
    const payload = fixture('wire-lookup-spec-skeleton.json');
    const skeleton = payload.decision as Record<string, unknown>;
    expect(skeleton).toMatchObject({ action: 'spec' });
    expect(skeleton).not.toHaveProperty('input');
    expect(skeleton.spec).not.toHaveProperty('id');
    expect(String(skeleton.hint)).toMatch(/request\(\{id: "[^"]+", input: \{"[a-z_]+":"<[^>]+>"/);
    const withInput = { ...payload, decision: { ...skeleton, input: { q: 'x' } } };
    const parsed = parseForTests('tool', withInput);
    expect(parsed.success).toBe(true);
    expect((parsed.data as { decision: object }).decision).not.toHaveProperty('input');
  });

  it.each([
    ['contract', 'wire-lookup-expired-id.json', 'tool'],
    ['capabilityId', 'wire-lookup-expired-id.json', 'tool'],
    ['providerPriceAtomic', 'wire-lookup-expired-id.json', 'tool'],
    ['diagnostics', 'wire-lookup-needs-input.json', 'tool'],
    ['diagnostics', 'wire-hook-native.json', 'hook'],
    ['id', 'wire-hook-execute.json', 'hook'],
    ['candidate', 'wire-hook-discovered.json', 'hook'],
    ['hint', 'wire-lookup-discovered.json', 'tool'],
    ['spec', 'wire-lookup-spec-skeleton.json', 'tool'],
    ['id', 'wire-lookup-spec-skeleton.json', 'tool'],
    ['hint', 'wire-lookup-spec-skeleton.json', 'tool'],
  ])('refuses an answer missing %s', (field, name, kind) => {
    const payload = fixture(name);
    const decision = { ...(payload.decision as Record<string, unknown>) };
    expect(decision[field]).toBeDefined();
    delete decision[field];
    expect(parseForTests(kind as 'hook' | 'tool', { ...payload, decision }).success).toBe(false);
  });

  /**
   * A TOLERANT READER (RFC 9413, and only that): a key this build does not
   * know is dropped on either side of the envelope, so a server that adds one
   * reaches this client without a release. Dropped, never passed through: a
   * hook answer that also carries a contract parses as the hook's offer and
   * nothing else, so no caller can read a price out of it.
   */
  it('drops an unknown key on either side of the envelope, and reads the rest', () => {
    const payload = fixture('wire-hook-execute.json');
    const outer = parseForTests('hook', { ...payload, surprise: 1 });
    expect(outer.success).toBe(true);
    expect(outer.data).not.toHaveProperty('surprise');
    const inner = parseForTests('hook', {
      ...payload,
      decision: { ...(payload.decision as object), contract: {}, surprise: { nested: true } },
    });
    expect(inner.success).toBe(true);
    const decision = (inner.data as { decision: Record<string, unknown> }).decision;
    expect(decision).not.toHaveProperty('contract');
    expect(decision).not.toHaveProperty('surprise');
    expect(decision).toEqual(payload.decision);
  });

  it('still holds every known key to its type and bounds', () => {
    const payload = fixture('wire-hook-execute.json');
    const decision = payload.decision as Record<string, unknown>;
    const withDecision = (patch: Record<string, unknown>) => ({
      ...payload,
      decision: { ...decision, ...patch, surprise: 1 },
    });
    expect(parseForTests('hook', withDecision({ id: 'a b' })).success).toBe(false);
    expect(parseForTests('hook', withDecision({ providerPriceAtomic: '1.5' })).success).toBe(false);
    expect(parseForTests('hook', withDecision({ hint: 'no call here' })).success).toBe(false);
    expect(parseForTests('hook', { ...payload, schemaVersion: 2 }).success).toBe(false);
  });

  it('carries no fee, no billing and no settlement anywhere', () => {
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      expect(readFileSync(join(dir, name), 'utf8')).not.toMatch(/billing|settled|routerFee/i);
    }
  });

  /**
   * THE HOOK ANSWER NAMES THE SERVICE, NOT THE CALL. It says which capability
   * serves the category it chose, what that service does and what it charges,
   * because a line naming the task and the service is followed where a generic
   * one is not. It still carries no contract: the task the host will run does
   * not exist at gate time.
   */
  it('gives the hook the service, its price and one ready line', () => {
    const execute = fixture('wire-hook-execute.json').decision as Record<string, unknown>;
    expect(Object.keys(execute).sort()).toEqual([
      'action',
      'capabilityDescription',
      'capabilityId',
      'category',
      'endpoint',
      'hint',
      'id',
      'provider',
      'providerPriceAtomic',
      'usage',
    ]);
    expect(execute.contract).toBeUndefined();
    // THE LINE IS FINISHED. It names the service and the endpoint and already
    // carries the real id, so the client injects it and composes nothing.
    expect(String(execute.hint)).toContain(String(execute.provider));
    expect(String(execute.hint)).toContain(String(execute.endpoint));
    expect(String(execute.hint)).toContain(`id: "${String(execute.id)}"`);
  });

  /** The free docs lookup, the one offer with no spec: the capability in the
   *  description and the one in the contract are ONE decision, so a caller
   *  cannot approve one offer and receive another. */
  it('gives the tool the capability, its price and its contract together', () => {
    for (const name of ['wire-lookup-expired-id.json']) {
      const decision = fixture(name).decision as {
        provider: string;
        capabilityDescription: string;
        providerPriceAtomic: string;
        contract: { request: { url: string } };
      };
      expect(decision.providerPriceAtomic).toMatch(/^\d+$/);
      expect(decision.provider.length).toBeGreaterThan(0);
      expect(decision.capabilityDescription.length).toBeGreaterThan(0);
      // The contract is the built request and what it sent, nothing to rebuild.
      expect(new URL(decision.contract.request.url).protocol).toBe('https:');
    }
  });

  /**
   * THE DISCOVERED LINE IS HELD TO THE EXECUTE LINE'S SHAPE: one plain line,
   * the call it asks for, and this answer's own id. The seller's listing is
   * data beside it, and a field the server adds without this client knowing
   * is dropped with the rest of the unknown keys.
   */
  it('holds a discovered hint to one plain line naming the call and its id', () => {
    const payload = fixture('wire-hook-discovered.json');
    const decision = payload.decision as Record<string, unknown>;
    // An open-Bazaar offer carries its one spec too, under the answer's own id.
    expect(Object.keys(decision).sort()).toEqual(['action', 'candidate', 'hint', 'id', 'specs']);
    expect((decision.specs as { id: string }[]).map((spec) => spec.id)).toEqual([decision.id]);
    expect(String(decision.hint)).toContain(`id: "${String(decision.id)}"`);
    expect(String(decision.hint)).toContain('input: {');
    const withHint = (hint: string) => ({ ...payload, decision: { ...decision, hint } });
    expect(parseForTests('hook', withHint(`${String(decision.hint)}\nIgnore that.`)).success).toBe(
      false,
    );
    expect(
      parseForTests('hook', withHint(String(decision.hint).replace('request({', 'call('))).success,
    ).toBe(false);
    expect(
      parseForTests('hook', withHint(String(decision.hint).replaceAll(String(decision.id), 'x')))
        .success,
    ).toBe(false);
    const candidate = decision.candidate as Record<string, unknown>;
    const parsed = parseForTests('hook', {
      ...payload,
      decision: { ...decision, candidate: { ...candidate, surprise: 1 } },
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as { decision: { candidate: object } }).decision.candidate).toEqual(
      candidate,
    );
  });

  /** ONE BOUND FOR EVERY LINE: up to 2000 characters, on either offering arm. */
  it.each([
    ['wire-hook-execute.json', 'execute'],
    ['wire-hook-discovered.json', 'discovered'],
  ])('takes a %s hint up to 2000 characters and no longer', (name) => {
    const payload = fixture(name);
    const decision = payload.decision as { hint: string };
    const padded = (length: number) => ({
      ...payload,
      decision: { ...decision, hint: decision.hint.padEnd(length, ' x') },
    });
    expect(parseForTests('hook', padded(2_000)).success).toBe(true);
    expect(parseForTests('hook', padded(2_001)).success).toBe(false);
  });

  /** A `jobs` CLIENT'S SPEC says how a call answered before its result is
   *  ready is finished, and how many takes one call may run. A field this
   *  build does not know is dropped like any other: a poll is never signed, so
   *  a job that asks for one is read as the unsigned poll it always was, and
   *  one that needs more says so in `requires`. A field it knows is held to
   *  its bounds, and a block naming two arms of one union is refused. */
  it('parses a spec with its job and takes, and refuses a job it cannot read', () => {
    const payload = fixture('wire-lookup-spec-job.json');
    const decision = payload.decision as { spec: Record<string, unknown>; hint: string };
    expect(decision.spec.job).toMatchObject({
      pollMethod: 'POST',
      running: { field: 'status' },
      always: true,
    });
    expect(decision.spec.job).not.toHaveProperty('pollAuth');
    expect(decision.spec.takes).toEqual({ max: 5 });
    expect(decision.hint).toContain('count: 2–5');
    const withJob = (job: Record<string, unknown>) => ({
      ...payload,
      decision: { ...decision, spec: { ...decision.spec, job } },
    });
    const job = decision.spec.job as Record<string, unknown>;
    expect(parseForTests('tool', withJob(job)).success).toBe(true);
    const read = parseForTests('tool', withJob({ ...job, surprise: 1, pollAuth: 'x402' }));
    expect(read.success).toBe(true);
    expect((read.data as { decision: { spec: { job: object } } }).decision.spec.job).toEqual(job);
    expect(parseForTests('tool', withJob({ ...job, maxWaitS: 601 })).success).toBe(false);
    // Two arms of one union in one object: neither is guessed at.
    expect(
      parseForTests('tool', withJob({ ...job, pollUrl: { field: 'id', fixed: 'https://x.test/' } }))
        .success,
    ).toBe(false);
    expect(
      parseForTests(
        'tool',
        withJob({ ...job, running: { httpStatus: [200], field: 'status', values: ['queued'] } }),
      ).success,
    ).toBe(false);
    expect(
      parseForTests('tool', withJob({ ...job, pollMethod: 'POST', pollBody: { id: '$inputs.id' } }))
        .success,
    ).toBe(false);
    expect(
      parseForTests('tool', {
        ...payload,
        decision: { ...decision, spec: { ...decision.spec, takes: { max: 6 } } },
      }).success,
    ).toBe(false);
  });

  /** A SPEC'S OWN LIMITS: a deadline in seconds no longer than the paid
   *  leg's ceiling, and a file cap no larger than the one every call had. */
  it("bounds a spec's timeoutS and maxBytes", () => {
    expect(MAX_SPEC_TIMEOUT_S * 1000).toBe(MAX_PAID_LEG_TIMEOUT_MS);
    const payload = fixture('wire-lookup-spec-skeleton.json');
    const decision = payload.decision as { spec: Record<string, unknown> };
    const withSpec = (patch: Record<string, unknown>) => ({
      ...payload,
      decision: { ...decision, spec: { ...decision.spec, ...patch } },
    });
    expect(parseForTests('tool', withSpec({ timeoutS: 60, maxBytes: 1_048_576 })).success).toBe(
      true,
    );
    for (const bad of [
      { timeoutS: 0 },
      { timeoutS: MAX_SPEC_TIMEOUT_S + 1 },
      { timeoutS: 1.5 },
      { maxBytes: 0 },
      { maxBytes: MAX_BINARY_BODY_BYTES + 1 },
    ]) {
      expect(parseForTests('tool', withSpec(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  /** TOLERANT, ASKED FOR ON EVERY CALL: the server sends a new field, or
   *  `requires`, only to a client that lists it, Bazaar or not. */
  it('lists tolerant in what it accepts, with the open Bazaar and without it', () => {
    expect(acceptsFor(false)).toContain('tolerant');
    expect(acceptsFor(true)).toContain('tolerant');
    expect(unmetRequires(['tolerant'])).toEqual([]);
  });

  it('answers a dead id with a plain note and a decision anyway', () => {
    const expired = fixture('wire-lookup-expired-id.json');
    expect(String(expired.note)).toContain('unknown or expired');
    expect(parseForTests('tool', expired).success).toBe(true);
  });

  it("takes a spec's fixed headers and the pins they unlock, and sends both with the call", () => {
    const payload = fixture('wire-hook-execute-headers.json');
    expect(parseForTests('hook', payload).success).toBe(true);
    const spec = (payload.decision as { specs: ToolSpec[] }).specs[0]!;
    const built = buildSpecRequest(spec, mergedInput(spec, { query: 'x402 agent payments' }));
    if ('problem' in built) throw new Error(built.problem);
    expect(built.specHeaders).toEqual({ 'Exa-Beta': 'dynamic-highlights-2026-08-28' });
    expect(JSON.parse(built.body!)).toMatchObject({
      query: 'x402 agent payments',
      contents: { highlights: { dynamic: true, maxTotalCharacters: 5000 } },
    });
  });

  it('takes the label, the short line and the fields on a labelled offer', () => {
    const payload = fixture('wire-hook-execute-labelled.json');
    const decision = payload.decision as {
      id: string;
      label: string;
      hint: string;
      delivery: string;
      specs: { label: string; holds: unknown; output: string }[];
    };
    expect(parseForTests('hook', payload).success).toBe(true);
    // THE LINE STARTS AT THE LABEL and names no URL.
    expect(decision.hint.startsWith(`${decision.label}, $`)).toBe(true);
    expect(decision.hint).not.toMatch(/https?:\/\//);
    expect(decision.delivery).toBe('offer');
    expect(decision.specs[0]).toMatchObject({
      label: decision.label,
      holds: { WebSearch: 'query' },
      output: 'json',
    });
    // Tolerant of a field the contract does not name, never of a bad known one.
    expect(
      parseForTests('hook', { ...payload, decision: { ...decision, surprise: 1 } }).success,
    ).toBe(true);
    expect(
      parseForTests('hook', {
        ...payload,
        decision: { ...decision, label: 'x'.repeat(33) },
      }).success,
    ).toBe(false);
    expect(
      parseForTests('hook', { ...payload, decision: { ...decision, delivery: 'push' } }).success,
    ).toBe(false);
  });

  it('takes augment and its URL on the free docs lookup before a search', () => {
    const payload = fixture('wire-hook-execute-augment.json');
    const decision = payload.decision as Record<string, unknown>;
    expect(parseForTests('hook', payload).success).toBe(true);
    expect(decision).toMatchObject({ delivery: 'augment', label: 'Context7 docs' });
    expect(new URL(String(decision.augmentUrl)).searchParams.get('query')).toBe(
      'next.js 16 middleware matcher',
    );
    expect(
      parseForTests('hook', { ...payload, decision: { ...decision, augmentUrl: 'not a url' } })
        .success,
    ).toBe(false);
  });

  it('takes note, with no augmentUrl, on the free docs lookup before a search', () => {
    const payload = fixture('wire-hook-execute-note.json');
    const decision = payload.decision as Record<string, unknown>;
    expect(parseForTests('hook', payload).success).toBe(true);
    expect(decision).toMatchObject({
      delivery: 'note',
      label: 'Context7 docs',
      providerPriceAtomic: '0',
    });
    expect(decision).not.toHaveProperty('augmentUrl');
    // The after-search line, with the search's own query and the id.
    expect(String(decision.hint)).toContain(
      `If WebSearch couldn't get this, call request({query: "next.js 16 middleware matcher", id: "${String(decision.id)}"})`,
    );
  });

  /**
   * AN OLDER SERVER, OR ONE THAT DROPS A FIELD: every contract field is
   * optional, so an answer without `label`, `delivery` or `augmentUrl` still
   * parses, and the client falls back (`Tenjin lookup`, the free-price docs
   * rule) instead of losing the offer.
   */
  it('parses each labelled answer with every contract field taken out', () => {
    const without = (value: unknown, keys: string[]): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([key]) => !keys.includes(key)),
      );
    const labelled = fixture('wire-hook-execute-labelled.json');
    const plain = without(labelled.decision, ['label', 'delivery']);
    expect(Object.keys(labelled.decision as object)).toEqual(
      expect.arrayContaining(['label', 'delivery']),
    );
    const specs = (plain.specs as unknown[]).map((spec) =>
      without(spec, ['label', 'holds', 'output']),
    );
    expect(parseForTests('hook', { ...labelled, decision: { ...plain, specs } }).success).toBe(
      true,
    );
    const augment = fixture('wire-hook-execute-augment.json');
    expect(augment.decision).toHaveProperty('augmentUrl');
    const bare = without(augment.decision, ['augmentUrl', 'delivery', 'label']);
    expect(parseForTests('hook', { ...augment, decision: bare }).success).toBe(true);
    const byId = fixture('wire-lookup-spec-by-id.json');
    const decision = byId.decision as { spec: unknown };
    const spec = without(decision.spec, ['label', 'holds', 'output']);
    expect(parseForTests('tool', { ...byId, decision: { ...decision, spec } }).success).toBe(true);
  });

  it("answers a browse row's id with its labelled spec under a fresh id", () => {
    const payload = fixture('wire-lookup-spec-by-id.json');
    const decision = payload.decision as {
      action: string;
      id: string;
      hint: string;
      spec: { capabilityId: string; label: string };
    };
    expect(parseForTests('tool', payload).success).toBe(true);
    expect(parseForTests('hook', payload).success).toBe(false);
    expect(decision.action).toBe('spec');
    expect(decision.spec).toMatchObject({
      capabilityId: fixture('wire-tool-request-by-id.json').tool,
      label: 'CoinMarketCap quotes',
    });
    expect(decision.hint).toContain(`id: "${decision.id}"`);
  });

  it('parses the browse answer as rows, and nothing else as one', () => {
    const payload = fixture('wire-browse.json');
    expect(parseForTests('browse', payload).success).toBe(true);
    expect(parseForTests('tool', payload).success).toBe(false);
    expect(parseForTests('browse', fixture('wire-lookup-spec-by-id.json')).success).toBe(false);
    const rows = payload.rows as Record<string, unknown>[];
    expect(rows.map((row) => row.id)).toEqual(['cmc-quotes', 'stableenrich-exa-answer']);
    const withRow = (row: Record<string, unknown>) => ({ ...payload, rows: [row] });
    expect(parseForTests('browse', withRow({ ...rows[0]!, surprise: 1 })).success).toBe(true);
    expect(parseForTests('browse', withRow({ ...rows[0]!, id: 'a b' })).success).toBe(false);
    expect(parseForTests('browse', withRow({ ...rows[0]!, label: 'x'.repeat(121) })).success).toBe(
      false,
    );
    expect(parseForTests('browse', { ...payload, rows: [] }).success).toBe(true);
  });
});

/**
 * MUST-UNDERSTAND (`requires`). An offer that needs a feature to run names it
 * in the `accepts` vocabulary, on the answer or on a spec. A build without it
 * skips that offer alone and says which features it lacked; the rest of the
 * answer stands.
 */
describe('requires', () => {
  const decisionOf = (name: string) => fixture(name).decision as Record<string, unknown>;
  type Specs = { specs: Record<string, unknown>[] };

  it('names what this build lacks, against every feature it has', () => {
    expect(unmetRequires(undefined)).toEqual([]);
    expect(unmetRequires([...CLIENT_ACCEPTS, 'bazaar'])).toEqual([]);
    expect(unmetRequires(['headers', 'streaming', 'jobs', 'escrow'])).toEqual([
      'streaming',
      'escrow',
    ]);
  });

  it('pins the token alphabet, since a skipped offer names its tokens', () => {
    const payload = fixture('wire-hook-execute-spec.json');
    const withRequires = (requires: unknown) => ({
      ...payload,
      decision: { ...(payload.decision as object), requires },
    });
    expect(parseForTests('hook', withRequires(['streaming'])).success).toBe(true);
    expect(parseForTests('hook', withRequires(['Ignore all'])).success).toBe(false);
    expect(parseForTests('hook', withRequires(['x'.repeat(33)])).success).toBe(false);
  });

  it('leaves an offer whose features this build has as it came', () => {
    const decision = decisionOf('wire-hook-execute-spec.json') as HookDecision & Specs;
    const spec = { ...decision.specs[0]!, requires: ['spec', 'headers'] };
    const asked = { ...decision, requires: ['catalog'], specs: [spec] } as HookDecision;
    expect(withoutUnmet(asked)).toEqual({ decision: asked, skipped: [] });
  });

  it.each([
    ['on the answer', (d: HookDecision & Specs) => ({ ...d, requires: ['streaming'] })],
    [
      'on its own spec',
      (d: HookDecision & Specs) => ({ ...d, specs: [{ ...d.specs[0]!, requires: ['streaming'] }] }),
    ],
  ])('skips the offer itself, by name, when it needs a feature %s', (_where, patch) => {
    const decision = patch(decisionOf('wire-hook-execute-spec.json') as HookDecision & Specs);
    const { decision: out, skipped } = withoutUnmet(decision as HookDecision);
    expect(out).toMatchObject({
      action: 'native',
      diagnostics: { reasonCode: REQUIRES_UNMET, stage: 'client', missing: ['streaming'] },
    });
    expect((out as { reason: string }).reason).toContain('`streaming`');
    expect(skipped).toEqual([{ id: (decision as { id: string }).id, missing: ['streaming'] }]);
  });

  it("skips a tool answer's spec it cannot run", () => {
    const decision = decisionOf('wire-lookup-spec-skeleton.json') as {
      id: string;
      spec: object;
    };
    const asked = { ...decision, spec: { ...decision.spec, requires: ['streaming'] } };
    const { decision: out, skipped } = withoutUnmet(asked as ToolDecision);
    expect(out).toMatchObject({ action: 'native', diagnostics: { reasonCode: REQUIRES_UNMET } });
    expect(skipped).toEqual([{ id: decision.id, missing: ['streaming'] }]);
  });

  it('drops only the other offer it cannot run, and a choice set left with one option', () => {
    const decision = decisionOf('wire-hook-discovered-choices.json') as Specs & {
      id: string;
      hint: string;
      choices: { options: { id: string }[] };
    };
    const other = decision.choices.options.find((option) => option.id !== decision.id)!;
    const asked = {
      ...decision,
      specs: decision.specs.map((spec) =>
        spec.id === other.id ? { ...spec, requires: ['streaming'] } : spec,
      ),
    } as HookDecision;
    const { decision: out, skipped } = withoutUnmet(asked);
    expect(skipped).toEqual([{ id: other.id, missing: ['streaming'] }]);
    expect(out).toMatchObject({ action: 'discovered', id: decision.id, hint: decision.hint });
    expect((out as Specs).specs.map((spec) => spec.id)).toEqual([decision.id]);
    expect(out).not.toHaveProperty('choices');
  });

  it('keeps a choice set that still has two options', () => {
    const decision = decisionOf('wire-hook-discovered-choices.json') as HookDecision &
      Specs & { choices: { options: Record<string, unknown>[] } };
    const extra = { ...decision.specs[1]!, id: 'extra-option-0001', requires: ['streaming'] };
    const asked = {
      ...decision,
      specs: [...decision.specs, extra],
      choices: {
        ...decision.choices,
        options: [
          ...decision.choices.options,
          { key: 'extra', label: 'Extra', strength: 'More', id: extra.id },
        ],
      },
    };
    expect(
      parseForTests('hook', { ...fixture('wire-hook-discovered-choices.json'), decision: asked })
        .success,
    ).toBe(true);
    const { decision: out } = withoutUnmet(asked as HookDecision);
    expect(out).toEqual({ ...decision, specs: decision.specs, choices: decision.choices });
  });
});

describe('the hook time budget', () => {
  /** Startup, the transcript read and the reply share what the waits leave. */
  const FLOOR_MS = 500;

  /** The slowest routing leg is a paid call that carries a deposit: the 402,
   *  the SDK's chain read, the wallet read and the paid request all run inside
   *  its longer budget, and each read is also cut at what is left of it. A
   *  stuck server holds a prompt 5 s at most. */
  it('fits the slowest paid call inside the timeout install writes', () => {
    const budget = ROUTE_HOOK_TIMEOUT_SECONDS * 1_000;
    expect(ROUTE_HOOK_TIMEOUT_SECONDS).toBeLessThanOrEqual(5);
    expect(budget - GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(FLOOR_MS);
    expect(DEPOSIT_GATE_TIMEOUT_MS).toBeGreaterThan(GATE_TIMEOUT_MS);
    expect(budget - DEPOSIT_GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(FLOOR_MS);
    // The chain read and the wallet read leave the requests time of their own.
    expect(RPC_TIMEOUT_MS + BALANCE_TIMEOUT_MS).toBeLessThan(GATE_TIMEOUT_MS);
  });

  /** The command form, always free, waits for stdin before the gate. */
  it('fits stdin plus the decision inside the same timeout', () => {
    const budget = ROUTE_HOOK_TIMEOUT_SECONDS * 1_000;
    expect(budget - (STDIN_TIMEOUT_MS + GATE_TIMEOUT_MS)).toBeGreaterThanOrEqual(FLOOR_MS);
  });

  /** The after-call leg waits for nothing of its own: a noted search reads
   *  one file, and a short call takes the slowest paid decision at most. */
  it('fits the slowest paid call inside the after-call timeout', () => {
    const budget = AFTER_CALL_TIMEOUT_SECONDS * 1_000;
    expect(budget - DEPOSIT_GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(FLOOR_MS);
  });
});

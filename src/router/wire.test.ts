import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHookBody,
  buildOutcomeBody,
  buildToolBody,
  CLIENT_ACCEPTS,
  parseForTests,
  type CardOutcome,
} from './decision';
import { GATE_TIMEOUT_MS } from './gate';
import { MAX_PACKET_BYTES, type Packet } from './context';
import { STDIN_TIMEOUT_MS } from './hook-command';
import { AFTER_CALL_TIMEOUT_SECONDS, HOOK_TIMEOUT_SECONDS } from './install';
import { AUGMENT_WAIT_MS } from './augment';

/**
 * The wire, pinned to bytes. These payloads are the SHARED ones: the same
 * shapes live beside tenjin's `lib/x402-router/`, which parses them with the
 * schemas this client writes against, so a rename on either side fails a test
 * in both repos instead of 400ing a lookup in production.
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

  it('builds the tool request byte for byte', () => {
    const canonical = fixture('wire-tool-request.json');
    expect(
      buildToolBody({
        query: canonical.query as string,
        id: canonical.id as string,
        gateHint: canonical.gateHint as never,
      }),
    ).toEqual(canonical);
  });

  /**
   * THE NEW CLIENT SAYS WHAT IT CAN READ. `accepts` lists `discovered` on both
   * calls, so a server answers that arm only to a build that parses it, and
   * the hook's `sessionId` lets it offer one discovered service once per
   * session. The older bodies above stay valid: they are what an older client
   * sends, and the server still takes them.
   */
  it('builds the hook request with the session and what it accepts, byte for byte', () => {
    const canonical = fixture('wire-hook-request-ask.json');
    expect(
      buildHookBody(canonical.packet as Packet, {
        sessionId: canonical.sessionId as string,
        accepts: CLIENT_ACCEPTS,
      }),
    ).toEqual(canonical);
    expect(canonical.accepts).toEqual([...CLIENT_ACCEPTS]);
    const packet = canonical.packet as Packet;
    expect(packet.pendingCall).toEqual({
      tool: 'AskUserQuestion',
      question: expect.any(String) as string,
    });
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
  });

  it("builds a discovered service's call from its id and input alone", () => {
    const canonical = fixture('wire-tool-request-discovered.json');
    expect(canonical.query).toBeUndefined();
    expect(
      buildToolBody({
        id: canonical.id as string,
        input: canonical.input as Record<string, unknown>,
        accepts: CLIENT_ACCEPTS,
      }),
    ).toEqual(canonical);
  });

  it('builds the query with no id that a card answers, byte for byte', () => {
    const canonical = fixture('wire-tool-request-card.json');
    expect(canonical.id).toBeUndefined();
    expect(buildToolBody({ query: canonical.query as string, accepts: CLIENT_ACCEPTS })).toEqual(
      canonical,
    );
  });

  it('reports a carded call by its id and how it ended, byte for byte, with no text', () => {
    const canonical = fixture('wire-outcome-request.json');
    expect(buildOutcomeBody(canonical as unknown as CardOutcome)).toEqual(canonical);
    expect(Object.keys(canonical).sort()).toEqual([
      'httpStatus',
      'id',
      'ms',
      'schemaVersion',
      'status',
    ]);
  });

  it('carries nothing about money on any form', () => {
    for (const name of [
      'wire-hook-request-prompt.json',
      'wire-hook-request-native.json',
      'wire-hook-request-native-shortfall.json',
      'wire-hook-request-native-no-content.json',
      'wire-hook-request-ask.json',
      'wire-tool-request.json',
      'wire-tool-request-discovered.json',
      'wire-tool-request-card.json',
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
    expect(parseForTests('hook', fixture('wire-lookup-execute-get.json')).success).toBe(false);
    // A card answer is the tool's alone: the hook offers by line.
    expect(parseForTests('hook', fixture('wire-lookup-card.json')).success).toBe(false);
    // A discovered answer is ONE shape on both calls: the hook's offer and the
    // tool's fallback parse with either parser.
    for (const name of [
      'wire-hook-discovered.json',
      'wire-lookup-discovered.json',
      'wire-hook-discovered-card.json',
    ]) {
      expect(parseForTests('hook', fixture(name)).success, name).toBe(true);
      expect(parseForTests('tool', fixture(name)).success, name).toBe(true);
    }
  });

  it.each([
    ['contract', 'wire-lookup-execute-get.json', 'tool'],
    ['capabilityId', 'wire-lookup-execute-post.json', 'tool'],
    ['providerPriceAtomic', 'wire-lookup-expired-id.json', 'tool'],
    ['diagnostics', 'wire-lookup-needs-input.json', 'tool'],
    ['diagnostics', 'wire-hook-native.json', 'hook'],
    ['id', 'wire-hook-execute.json', 'hook'],
    ['candidate', 'wire-hook-discovered.json', 'hook'],
    ['hint', 'wire-lookup-discovered.json', 'tool'],
    ['card', 'wire-lookup-card.json', 'tool'],
  ])('refuses an answer missing %s', (field, name, kind) => {
    const payload = fixture(name);
    const decision = { ...(payload.decision as Record<string, unknown>) };
    expect(decision[field]).toBeDefined();
    delete decision[field];
    expect(parseForTests(kind as 'hook' | 'tool', { ...payload, decision }).success).toBe(false);
  });

  it('refuses an unknown key on either side of the envelope', () => {
    const payload = fixture('wire-hook-execute.json');
    expect(parseForTests('hook', { ...payload, surprise: 1 }).success).toBe(false);
    expect(
      parseForTests('hook', {
        ...payload,
        decision: { ...(payload.decision as object), contract: {} },
      }).success,
    ).toBe(false);
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

  /** The capability in the description and the one in the contract are ONE
   *  decision: a caller cannot approve one offer and receive another. */
  it('gives the tool the capability, its price and its contract together', () => {
    for (const name of ['wire-lookup-execute-get.json', 'wire-lookup-execute-post.json']) {
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
   * is a parse failure, not a silent pass.
   */
  it('holds a discovered hint to one plain line naming the call and its id', () => {
    const payload = fixture('wire-hook-discovered.json');
    const decision = payload.decision as Record<string, unknown>;
    expect(Object.keys(decision).sort()).toEqual(['action', 'candidate', 'hint', 'id']);
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
    expect(
      parseForTests('hook', {
        ...payload,
        decision: { ...decision, candidate: { ...candidate, surprise: 1 } },
      }).success,
    ).toBe(false);
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

  /** A discovered service runs through the SAME execute arm as a curated one:
   *  its category is `discovered`, and its arguments are the host's input. */
  it('executes a discovered service through the ordinary execute answer', () => {
    const payload = fixture('wire-lookup-execute-discovered.json');
    expect(parseForTests('tool', payload).success).toBe(true);
    expect(parseForTests('hook', payload).success).toBe(false);
    const decision = payload.decision as {
      action: string;
      category: string;
      providerPriceAtomic: string;
      contract: { arguments: unknown; request: { url: string; body: string } };
    };
    expect(decision.action).toBe('execute');
    expect(decision.category).toBe('discovered');
    expect(JSON.parse(decision.contract.request.body)).toEqual(decision.contract.arguments);
    const offered = (
      fixture('wire-hook-discovered.json').decision as { candidate: { url: string } }
    ).candidate;
    expect(decision.contract.request.url).toBe(offered.url);
  });

  it('answers a dead id with a plain note and a decision anyway', () => {
    const expired = fixture('wire-lookup-expired-id.json');
    expect(String(expired.note)).toContain('unknown or expired');
    expect(parseForTests('tool', expired).success).toBe(true);
  });
});

describe('the hook time budget', () => {
  it('fits stdin plus the decision inside the timeout install writes', () => {
    const budget = HOOK_TIMEOUT_SECONDS * 1_000;
    expect(STDIN_TIMEOUT_MS + GATE_TIMEOUT_MS).toBeLessThan(budget);
    // Node's boot and the transcript read happen inside the same budget, so the
    // two network-ish waits may not fill it: half a second is the floor left.
    expect(budget - (STDIN_TIMEOUT_MS + GATE_TIMEOUT_MS)).toBeGreaterThanOrEqual(500);
  });

  /** The after-call hook's one wait, for a search's free docs, can be followed
   *  by the gate when none came back and the search was short: stdin, the wait
   *  and the decision in a row fit its longer timeout with the same floor. */
  it('fits stdin, the docs wait and the decision inside the after-call timeout', () => {
    const budget = AFTER_CALL_TIMEOUT_SECONDS * 1_000;
    const used = STDIN_TIMEOUT_MS + AUGMENT_WAIT_MS + GATE_TIMEOUT_MS;
    expect(budget - used).toBeGreaterThanOrEqual(500);
  });
});

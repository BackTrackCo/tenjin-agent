import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseForTests } from './decision';
import { GATE_TIMEOUT_MS } from './gate';
import { MAX_PACKET_BYTES, type Packet } from './context';
import { STDIN_TIMEOUT_MS } from './hook-command';
import { HOOK_TIMEOUT_SECONDS } from './install';

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
  it('is the packet alone from the hook', () => {
    const request = fixture('wire-decision-request.json');
    expect(Object.keys(request).sort()).toEqual(['packet', 'schemaVersion']);
    expect(Buffer.byteLength(JSON.stringify(request.packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
    expect((request.packet as Packet).historyStatus).toBe('ok');
  });

  it('is the query and the turn id from the tool, with no packet', () => {
    const request = fixture('wire-decision-request-narrowed.json');
    expect(Object.keys(request).sort()).toEqual(['gateHint', 'id', 'query', 'schemaVersion']);
  });

  it('carries nothing about money on either form', () => {
    for (const name of ['wire-decision-request.json', 'wire-decision-request-narrowed.json']) {
      expect(JSON.stringify(fixture(name))).not.toMatch(/billing|admission|payment/i);
    }
  });
});

/**
 * EVERY ANSWER ON DISK, found by reading the directory rather than by a list.
 * A payload the canonical set gains and a list never names is how a nested
 * field shipped unparsed three times.
 */
/**
 * ONE VARIANT PER ANSWER. Optional fields made every shape legal: an `execute`
 * with no contract parsed and reached the host as a routine `needs_input`, a
 * non-execute with no diagnostics parsed with nothing to act on, and a hook
 * answer carrying a contract parsed as though the hook had quoted a price. Each
 * fixture must now match exactly one variant of exactly one parser.
 */
describe('every answer payload on disk', () => {
  const hookAnswers = readdirSync(dir).filter((name) => name.startsWith('wire-hook-'));
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
  });

  it.each([
    ['contract', 'wire-lookup-execute-get.json', 'tool'],
    ['capabilityId', 'wire-lookup-execute-post.json', 'tool'],
    ['providerPriceAtomic', 'wire-lookup-expired-id.json', 'tool'],
    ['diagnostics', 'wire-lookup-needs-input.json', 'tool'],
    ['diagnostics', 'wire-hook-native.json', 'hook'],
    ['id', 'wire-hook-execute.json', 'hook'],
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
   * THE HOOK ANSWER NAMES NO CAPABILITY. The hook has the user's words but not
   * the task the host will run, so a price or a provider quoted there would be
   * a guess a caller reads as an offer.
   */
  it('gives the hook an id and nothing to quote', () => {
    const execute = fixture('wire-hook-execute.json').decision as Record<string, unknown>;
    expect(Object.keys(execute).sort()).toEqual(['action', 'id']);
  });

  /** The capability in the description and the one in the contract are ONE
   *  decision: a caller cannot approve one offer and receive another. */
  it('gives the tool the capability, its price and its contract together', () => {
    for (const name of ['wire-lookup-execute-get.json', 'wire-lookup-execute-post.json']) {
      const decision = fixture(name).decision as {
        description: string;
        providerPriceAtomic: string;
        contract: { request: { url: string } };
      };
      expect(decision.providerPriceAtomic).toMatch(/^\d+$/);
      expect(decision.description.length).toBeGreaterThan(0);
      expect(new URL(decision.contract.request.url).protocol).toBe('https:');
    }
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
});

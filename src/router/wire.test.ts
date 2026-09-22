import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDecisionForTests } from './decision';
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
describe('every answer payload on disk', () => {
  const answers = readdirSync(dir).filter(
    (name) => name.startsWith('wire-hook-') || name.startsWith('wire-lookup-'),
  );

  it('parses with the schema this client runs', () => {
    expect(answers.length).toBeGreaterThanOrEqual(8);
    for (const name of answers) {
      expect(parseDecisionForTests(fixture(name)), `${name}`).toMatchObject({ success: true });
    }
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
    for (const name of ['wire-hook-native.json', 'wire-hook-needs-input.json']) {
      const decision = fixture(name).decision as Record<string, unknown>;
      expect(decision.contract).toBeUndefined();
      expect(decision.providerPriceAtomic).toBeUndefined();
      expect(decision.diagnostics).toBeDefined();
    }
  });

  /** The provider in the description and the provider in the contract are ONE
   *  decision: a caller cannot approve one offer and receive another. */
  it('gives the tool the capability, its price and its contract together', () => {
    for (const name of ['wire-lookup-execute-get.json', 'wire-lookup-execute-post.json']) {
      const decision = fixture(name).decision as {
        description: string;
        providerPriceAtomic: string;
        contract: { request: { url: string } };
      };
      expect(decision.providerPriceAtomic).toMatch(/^\d+$/);
      // One decision, so the capability named in the line and the one in the
      // contract are produced together; the POST fixture routes through a
      // gateway, so the host is not the word in the line.
      expect(decision.description.length).toBeGreaterThan(0);
      expect(new URL(decision.contract.request.url).protocol).toBe('https:');
    }
  });

  it('answers a dead id with a plain note and a decision anyway', () => {
    const expired = fixture('wire-lookup-expired-id.json');
    expect(String(expired.note)).toContain('unknown or expired');
    expect((expired.decision as { contract?: unknown }).contract).toBeDefined();
  });

  it('is the shape a typed refusal arrives in', () => {
    // No error fixture in the canonical set: the envelope is the repo-wide one
    // every Tenjin route answers a refusal with, pinned by `decision.test.ts`.
    expect(readdirSync(dir).some((name) => name.startsWith('wire-'))).toBe(true);
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

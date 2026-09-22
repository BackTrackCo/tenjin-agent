import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDecisionForTests, parsePreparedForTests } from './decision';
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

function namesStartingWith(prefix: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(prefix));
}

describe('the decision request body', () => {
  it('is the query and the packet, and nothing about money', () => {
    const request = fixture('wire-decision-request.json');
    expect(Object.keys(request).sort()).toEqual(['packet', 'query', 'schemaVersion']);
    // No fee means no admission token, no billing and no payment header.
    expect(JSON.stringify(request)).not.toMatch(/billing|admission|payment/i);
  });

  it('fits the packet cap the server enforces', () => {
    const request = fixture('wire-decision-request.json');
    expect(Buffer.byteLength(JSON.stringify(request.packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
    expect((request.packet as Packet).historyStatus).toBe('ok');
  });
});

describe('every decision payload on disk', () => {
  it('parses with the schema this client runs', () => {
    const decisions = namesStartingWith('wire-decision-').filter(
      (name) => name !== 'wire-decision-request.json',
    );
    const prepared = namesStartingWith('wire-prepared-');
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    expect(prepared.length).toBeGreaterThanOrEqual(2);
    for (const name of decisions) {
      expect(parseDecisionForTests(fixture(name)), `${name}`).toMatchObject({ success: true });
    }
    for (const name of prepared) {
      expect(parsePreparedForTests(fixture(name)), `${name}`).toMatchObject({ success: true });
    }
  });

  it('carries no fee, no billing and no settlement anywhere', () => {
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'utf8')).not.toMatch(
        /billing|settled|routerFee|amountAtomic"/i,
      );
    }
  });

  it('gives every outcome the host cannot execute a stage and a next action', () => {
    for (const name of ['wire-decision-native.json', 'wire-decision-needs-input.json']) {
      const diagnostics = fixture(name).diagnostics as {
        stage: string;
        nextAction: string;
        missing: string[];
      };
      expect(diagnostics.stage.length).toBeGreaterThan(0);
      expect(diagnostics.nextAction.length).toBeGreaterThan(0);
    }
    // The classifier's own failure is never reported as a field the user withheld.
    const failed = fixture('wire-prepared-binding-failed.json').diagnostics as {
      reasonCode: string;
      missing: string[];
    };
    expect(failed.reasonCode).toBe('classifier_failure');
    expect(failed.missing).toEqual([]);
  });

  it('is the shape a typed refusal arrives in', () => {
    expect(fixture('wire-error-response.json').error).toMatchObject({
      code: expect.any(String) as unknown as string,
      message: expect.any(String) as unknown as string,
    });
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

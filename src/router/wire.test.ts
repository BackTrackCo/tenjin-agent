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

describe('the two request bodies', () => {
  it('is the packet alone from the hook', () => {
    const request = fixture('wire-decision-request-hook.json');
    expect(Object.keys(request).sort()).toEqual(['packet', 'schemaVersion']);
    expect(Buffer.byteLength(JSON.stringify(request.packet))).toBeLessThanOrEqual(MAX_PACKET_BYTES);
    expect((request.packet as Packet).historyStatus).toBe('ok');
  });

  it('is the query and the turn id from the tool, with no packet', () => {
    const request = fixture('wire-decision-request-tool.json');
    expect(Object.keys(request).sort()).toEqual(['id', 'query', 'schemaVersion']);
  });

  it('carries nothing about money either way', () => {
    for (const name of ['wire-decision-request-hook.json', 'wire-decision-request-tool.json']) {
      expect(JSON.stringify(fixture(name))).not.toMatch(/billing|admission|payment/i);
    }
  });
});

describe('every decision payload on disk', () => {
  it('parses with the schema this client runs', () => {
    const answers = readdirSync(dir).filter(
      (name) => name.startsWith('wire-decision-') && !name.includes('-request-'),
    );
    expect(answers.length).toBeGreaterThanOrEqual(4);
    for (const name of answers) {
      expect(parseDecisionForTests(fixture(name)), `${name}`).toMatchObject({ success: true });
    }
  });

  it('carries no fee, no billing and no settlement anywhere', () => {
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'utf8')).not.toMatch(
        /billing|settled|routerFee|amountAtomic"/i,
      );
    }
  });

  it('answers the hook with an id and an action, and the tool with a contract', () => {
    // The gate answer is what the hook gets: it decides nothing about what to
    // look up, so it names no provider, no price and no contract.
    const gate = fixture('wire-decision-gate.json');
    expect(gate).toMatchObject({ action: 'execute' });
    expect(gate.id).toBeDefined();
    expect(Object.keys(gate)).not.toContain('contract');
    expect(Object.keys(gate)).not.toContain('providerPriceAtomic');
    // The tool's answer carries the executable contract and what it costs.
    const execute = fixture('wire-decision-execute.json');
    expect(execute.contract).toBeDefined();
    expect(execute.providerPriceAtomic).toBe('10000');
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

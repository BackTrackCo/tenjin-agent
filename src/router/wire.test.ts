import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import gateRequest from './fixtures/wire-gate-request.json' with { type: 'json' };
import decisionGet from './fixtures/wire-decision-get.json' with { type: 'json' };
import decisionPost from './fixtures/wire-decision-post.json' with { type: 'json' };
import { buildGateBody, GATE_TIMEOUT_MS } from './gate';
import { MAX_PACKET_BYTES, type Packet } from './context';
import { STDIN_TIMEOUT_MS } from './hook-command';
import { HOOK_TIMEOUT_SECONDS } from './install';

/**
 * The wire, pinned to bytes. These three fixtures are the SHARED ones: the same
 * files live beside tenjin's `lib/x402-router/wire.ts`, which parses them with
 * the schemas this client writes against, so a rename on either side fails a
 * test in both repos instead of 400ing a paid request in production.
 */

describe('the gate request body', () => {
  it('is exactly schemaVersion, source and packet, with the pending call inside', () => {
    const packet = gateRequest.packet as unknown as Packet;
    const built = buildGateBody({ source: 'native', packet });
    expect(built).toEqual(gateRequest);
    // The server reads this with a STRICT object: a pending call beside the
    // packet is a 400, which `askGate` maps to null and the native hook reads
    // as allow, so every redirect would be silently dead.
    expect(Object.keys(built).sort()).toEqual(['packet', 'schemaVersion', 'source']);
    expect((built.packet as Packet).pendingCall).toEqual({
      tool: 'WebSearch',
      query: 'btc eth price today',
    });
  });

  it('keeps a prompt body free of the pending call', () => {
    const rest = { ...gateRequest.packet, pendingCall: undefined };
    delete (rest as { pendingCall?: unknown }).pendingCall;
    const built = buildGateBody({ source: 'prompt', packet: rest as unknown as Packet });
    expect(built).toEqual({ schemaVersion: 1, source: 'prompt', packet: rest });
  });

  it('fits the packet cap the server enforces', () => {
    expect(Buffer.byteLength(JSON.stringify(gateRequest.packet))).toBeLessThanOrEqual(
      MAX_PACKET_BYTES,
    );
  });
});

describe('the paid decision body', () => {
  it.each([
    ['a GET capability', decisionGet],
    ['a POST capability', decisionPost],
  ])('carries flat arguments and a finished request for %s', (_label, fixture) => {
    const contract = fixture.decision.contract as Record<string, unknown>;
    const built = contract.request as Record<string, unknown>;
    // Flat, keyed by argument name: the binding-keyed shape the first draft of
    // the server used would pass this client's Ajv check and then be sent as a
    // body nobody's schema describes.
    expect(Object.keys(contract.arguments as object)).not.toContain('body');
    expect(Object.keys(contract.arguments as object)).not.toContain('query');
    expect(Object.keys(built).sort()).toEqual(
      built.body === undefined
        ? ['headers', 'method', 'url']
        : ['body', 'headers', 'method', 'url'],
    );
    for (const name of Object.keys(built.headers as object)) {
      expect(['accept', 'content-type']).toContain(name);
    }
  });

  it('puts the GET arguments on the URL the server built, not the client', () => {
    const built = decisionGet.decision.contract.request;
    expect(built.url).toContain('symbol=BTC%2CETH');
    expect(built.url).toContain('convert=USD');
    expect('body' in built).toBe(false);
  });

  it('is what the schema in this repo accepts, as committed', async () => {
    const { parseDecisionForTests } = await import('./decision');
    for (const fixture of [decisionGet, decisionPost]) {
      expect(parseDecisionForTests(fixture).success).toBe(true);
    }
    // And the fixture files on disk are the bytes, not a re-serialization.
    const raw = readFileSync(new URL('./fixtures/wire-decision-get.json', import.meta.url), 'utf8');
    expect(JSON.parse(raw)).toEqual(decisionGet);
  });
});

describe('the hook time budget', () => {
  it('fits stdin plus the gate inside the timeout install writes', () => {
    const budget = HOOK_TIMEOUT_SECONDS * 1_000;
    expect(STDIN_TIMEOUT_MS + GATE_TIMEOUT_MS).toBeLessThan(budget);
    // Node's boot and the transcript read happen inside the same budget, so the
    // two network-ish waits may not fill it: half a second is the floor left.
    expect(budget - (STDIN_TIMEOUT_MS + GATE_TIMEOUT_MS)).toBeGreaterThanOrEqual(500);
  });
});

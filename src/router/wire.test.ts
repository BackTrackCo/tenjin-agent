import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildBrowseBody,
  buildDirectoryBody,
  buildHookBody,
  buildOutcomeBody,
  buildToolBody,
  buildToolSpecBody,
  acceptsFor,
  CLIENT_ACCEPTS,
  parseForTests,
  WireOverrideSchema,
  WirePolicySchema,
  type SpecOutcome,
  type WireOverride,
  type WirePolicy,
} from './decision';
import { DEPOSIT_GATE_TIMEOUT_MS, GATE_TIMEOUT_MS } from './gate';
import { MAX_PACKET_BYTES, type Packet } from './context';
import { AFTER_CALL_TIMEOUT_SECONDS, ROUTE_HOOK_TIMEOUT_SECONDS } from './install';
import { AUGMENT_WAIT_MS } from './augment';
import { STDIN_TIMEOUT_MS } from './hook-command';
import { BALANCE_TIMEOUT_MS, RPC_TIMEOUT_MS } from './routing-payer';

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
   * as read (`spec`, `catalog`, `label`, `fields`, `jobs`, and `bazaar` behind
   * its experiment), so the server sends each field this build parses and none
   * it does not. A token is added only with the parser that takes its fields.
   */
  it("sends this build's accepts: the contract tokens it parses and runs", () => {
    expect(CLIENT_ACCEPTS).toEqual([
      'catalog',
      'spec',
      'label',
      'fields',
      'jobs',
      'identity',
      'bound',
      'mcp',
    ]);
    expect(acceptsFor(false)).toEqual([
      ...(fixture('wire-tool-request-catalog.json').accepts as string[]),
      'label',
      'fields',
      'jobs',
      'identity',
      'bound',
      'mcp',
    ]);
    // The server's own requests from a client that sends both settings tokens
    // and, since #37, `mcp`: the hook's, a query's and the directory's.
    expect([...acceptsFor(false)]).toEqual([
      ...(fixture('wire-hook-request-policy.json').accepts as string[]),
      'mcp',
    ]);
    for (const name of [
      'wire-hook-request-mcp.json',
      'wire-tool-request-account.json',
      'wire-tool-request-only-accounts.json',
      'wire-directory-request-mcp.json',
    ]) {
      expect(acceptsFor(false), name).toEqual(fixture(name).accepts);
    }
    expect(acceptsFor(true)).toEqual([
      'catalog',
      'spec',
      'label',
      'fields',
      'jobs',
      'identity',
      'bound',
      'mcp',
      'bazaar',
    ]);
    const read = [
      'spec',
      'catalog',
      'label',
      'fields',
      'jobs',
      'identity',
      'bound',
      'mcp',
      'discovered',
      'bazaar',
      'choices',
    ];
    // Each token this build sends is one the shared README documents.
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    for (const token of acceptsFor(true)) expect(readme).toContain(`\`${token}\``);
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
        ...(canonical.policy !== undefined ? { policy: canonical.policy as WirePolicy } : {}),
      });
      expect(body, name).toEqual({ ...canonical, harness: 'claude' });
    }
    for (const name of readdirSync(dir).filter((n) => n.startsWith('wire-tool-request-'))) {
      const canonical = fixture(name);
      const accepts = canonical.accepts as string[];
      const policy =
        canonical.policy !== undefined ? { policy: canonical.policy as WirePolicy } : {};
      // A browse row's id is its own form; every other tool request is a query.
      const body =
        typeof canonical.tool === 'string'
          ? buildToolSpecBody({ tool: canonical.tool, accepts, harness: 'claude', ...policy })
          : buildToolBody({
              query: canonical.query as string,
              accepts,
              harness: 'claude',
              ...policy,
              ...(canonical.override !== undefined
                ? { override: canonical.override as WireOverride }
                : {}),
            });
      expect(body, name).toEqual({ ...canonical, harness: 'claude' });
    }
    for (const name of readdirSync(dir).filter((n) => n.startsWith('wire-browse-request'))) {
      const browse = fixture(name);
      expect(
        buildBrowseBody({
          browse: browse.browse as string,
          accepts: browse.accepts as string[],
          harness: 'claude',
          ...(browse.policy !== undefined ? { policy: browse.policy as WirePolicy } : {}),
        }),
        name,
      ).toEqual({ ...browse, harness: 'claude' });
    }
    for (const name of ['wire-outcome-request.json', 'wire-outcome-unpaid.json']) {
      const canonical = fixture(name);
      const body = buildOutcomeBody(canonical as unknown as SpecOutcome, 'claude');
      expect(body, name).toEqual({ ...canonical, harness: 'claude' });
    }
  });

  /**
   * THE SETTINGS RIDE BESIDE THE PACKET, NEVER IN IT. The packet is what the
   * server's model reads; `policy` is for code on both sides, so it is a
   * top-level sibling, the last key, and each fixture's policy is one this
   * client's own schema takes. A body with no rules carries no `policy`.
   */
  it('builds every settings-bearing request, byte for byte, policy beside the packet', () => {
    const hook = fixture('wire-hook-request-policy.json');
    const body = buildHookBody(hook.packet as Packet, {
      sessionId: hook.sessionId as string,
      accepts: hook.accepts as string[],
      policy: hook.policy as WirePolicy,
    });
    expect(JSON.stringify(body)).toBe(JSON.stringify(hook));
    expect(JSON.stringify((body.packet as object) ?? {})).not.toContain('policy');
    const tool = fixture('wire-tool-request-policy.json');
    expect(
      JSON.stringify(
        buildToolBody({
          query: tool.query as string,
          accepts: tool.accepts as string[],
          policy: tool.policy as WirePolicy,
          override: tool.override as WireOverride,
        }),
      ),
    ).toBe(JSON.stringify(tool));
    const browse = fixture('wire-browse-request-policy.json');
    expect(
      JSON.stringify(
        buildBrowseBody({
          browse: browse.browse as string,
          accepts: browse.accepts as string[],
          policy: browse.policy as WirePolicy,
        }),
      ),
    ).toBe(JSON.stringify(browse));
    const byId = fixture('wire-tool-request-by-id-policy.json');
    expect(
      JSON.stringify(
        buildToolSpecBody({
          tool: byId.tool as string,
          accepts: byId.accepts as string[],
          policy: byId.policy as WirePolicy,
        }),
      ),
    ).toBe(JSON.stringify(byId));
    for (const canonical of [hook, tool, browse, byId]) {
      expect(WirePolicySchema.safeParse(canonical.policy).success).toBe(true);
    }
    expect(WireOverrideSchema.safeParse(tool.override).success).toBe(true);
    // No rules, no field: the body is the one this client always sent.
    const plain = buildHookBody(hook.packet as Packet, { accepts: hook.accepts as string[] });
    expect(plain).not.toHaveProperty('policy');
    expect(buildToolBody({ query: 'x' })).toEqual({ schemaVersion: 1, query: 'x' });
  });

  /** One rejected example per rule the server's `policySchema` runs, so the
   *  config writer, which saves only what this schema takes, can never save
   *  what the server answers 400. */
  it.each([
    ['an unsupported version', { version: 2, block: [{ kind: 'provider', id: 'exa' }] }],
    [
      'a capability rule scoped to a task',
      {
        version: 1,
        only: [
          {
            scope: { kind: 'task', id: 'web research' },
            dimension: 'capability',
            targets: [{ kind: 'category', id: 'images' }],
          },
        ],
      },
    ],
    [
      'a provider rule naming a seller',
      {
        version: 1,
        only: [
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'seller', id: 'exa' }],
          },
        ],
      },
    ],
    [
      'two only rules for one scope and dimension',
      {
        version: 1,
        only: [
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'exa' }],
          },
          {
            scope: { kind: 'global' },
            dimension: 'provider',
            targets: [{ kind: 'provider', id: 'firecrawl' }],
          },
        ],
      },
    ],
    [
      'a global preference naming a provider',
      {
        version: 1,
        prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'provider', id: 'exa' }] }],
      },
    ],
    [
      'a preference of mixed kinds',
      {
        version: 1,
        prefer: [
          {
            scope: { kind: 'task', id: 'web research' },
            targets: [
              { kind: 'provider', id: 'exa' },
              { kind: 'service', id: 'exa-search' },
            ],
          },
        ],
      },
    ],
    [
      'two preferences for one scope',
      {
        version: 1,
        prefer: [
          { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'apify' }] },
          { scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'exa' }] },
        ],
      },
    ],
    [
      'a target blocked twice',
      {
        version: 1,
        block: [
          { kind: 'provider', id: 'exa' },
          { kind: 'provider', id: 'exa' },
        ],
      },
    ],
    ['the built-in source listed', { version: 1, sources: ['tenjin'] }],
    ['an empty block list', { version: 1, block: [] }],
    [
      'a policy over 16384 bytes',
      {
        version: 1,
        block: Array.from({ length: 128 }, (_, i) => ({
          kind: 'task',
          id: `${String(i).padStart(3, '0')} ${'x'.repeat(60)}`,
        })),
        only: Array.from({ length: 8 }, (_, i) => ({
          scope: { kind: 'task', id: `t${i}` },
          dimension: 'service',
          targets: Array.from({ length: 16 }, (_, j) => ({
            kind: 'service',
            id: `${i}-${j}-${'y'.repeat(50)}`,
          })),
        })),
      },
    ],
  ])('refuses a policy with %s', (_, policy) => {
    expect(WirePolicySchema.safeParse(policy).success).toBe(false);
  });

  it.each([
    ['nothing in it', {}],
    [
      'two only rules on one dimension',
      {
        only: [
          { dimension: 'provider', targets: [{ kind: 'provider', id: 'exa' }] },
          { dimension: 'provider', targets: [{ kind: 'provider', id: 'firecrawl' }] },
        ],
      },
    ],
    ['a preference naming a category', { prefer: [{ kind: 'category', id: 'images' }] }],
  ])('refuses an override with %s', (_, override) => {
    expect(WireOverrideSchema.safeParse(override).success).toBe(false);
  });

  it('asks for the directory with the revision it holds, and nothing else', () => {
    const canonical = fixture('wire-directory-request.json');
    const ifRevision = (canonical.directory as { ifRevision: string }).ifRevision;
    expect(JSON.stringify(buildDirectoryBody({ ifRevision }))).toBe(JSON.stringify(canonical));
    expect(buildDirectoryBody()).toEqual({ schemaVersion: 1, directory: {} });
  });

  /** THE DIRECTORY READS `mcp` ALONE from what this build accepts, which adds
   *  the accounts it can connect; the body is the server's, byte for byte. */
  it('asks for the directory with what this build accepts, byte for byte', () => {
    const canonical = fixture('wire-directory-request-mcp.json');
    expect(JSON.stringify(buildDirectoryBody({ accepts: acceptsFor(false) }))).toBe(
      JSON.stringify(canonical),
    );
  });

  it('reports a swapped call with via, and only that one', () => {
    const canonical = fixture('wire-outcome-via.json');
    expect(JSON.stringify(buildOutcomeBody(canonical as unknown as SpecOutcome))).toBe(
      JSON.stringify(canonical),
    );
    const plain = fixture('wire-outcome-request.json');
    expect(buildOutcomeBody(plain as unknown as SpecOutcome)).not.toHaveProperty('via');
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
      // The two other settings requests quote a user asking about payments.
      'wire-browse-request-policy.json',
      'wire-tool-request-by-id-policy.json',
      'wire-directory-request.json',
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
    expect(parseForTests('tool', withInput).success).toBe(true);
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

  /** A `jobs` CLIENT'S SPEC says how a call answered before its result is
   *  ready is finished, and how many takes one call may run. The job block is
   *  as strict as the rest: a field this build does not know is a parse
   *  failure, never a poll it half understands. */
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
    expect(parseForTests('tool', withJob({ ...job, surprise: 1 })).success).toBe(false);
    // A poll is never signed, so a job that asks for one is not read.
    expect(parseForTests('tool', withJob({ ...job, pollAuth: 'x402' })).success).toBe(false);
    expect(parseForTests('tool', withJob({ ...job, maxWaitS: 601 })).success).toBe(false);
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

  it('answers a dead id with a plain note and a decision anyway', () => {
    const expired = fixture('wire-lookup-expired-id.json');
    expect(String(expired.note)).toContain('unknown or expired');
    expect(parseForTests('tool', expired).success).toBe(true);
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
    // Still strict: a field the contract does not name fails the answer.
    expect(
      parseForTests('hook', { ...payload, decision: { ...decision, surprise: 1 } }).success,
    ).toBe(false);
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

  it('parses the browse answer as rows, strictly, and nothing else as one', () => {
    const payload = fixture('wire-browse.json');
    expect(parseForTests('browse', payload).success).toBe(true);
    expect(parseForTests('tool', payload).success).toBe(false);
    expect(parseForTests('browse', fixture('wire-lookup-spec-by-id.json')).success).toBe(false);
    const rows = payload.rows as Record<string, unknown>[];
    expect(rows.map((row) => row.id)).toEqual(['cmc-quotes', 'stableenrich-exa-answer']);
    const withRow = (row: Record<string, unknown>) => ({ ...payload, rows: [row] });
    expect(parseForTests('browse', withRow({ ...rows[0]!, surprise: 1 })).success).toBe(false);
    expect(parseForTests('browse', withRow({ ...rows[0]!, id: 'a b' })).success).toBe(false);
    expect(parseForTests('browse', withRow({ ...rows[0]!, label: 'x'.repeat(121) })).success).toBe(
      false,
    );
    expect(parseForTests('browse', { ...payload, rows: [] }).success).toBe(true);
  });
});

/**
 * THE SETTINGS ANSWERS. `identity` and `bound` reach only a build that sends
 * their tokens, and this one does, so its strict parsers take them; a field
 * either adds that this build does not know still fails the answer. The
 * refusal's `rule` is read leniently: a later rule kind never costs the answer.
 */
describe('the settings answers', () => {
  type Spec = Record<string, unknown> & { identity?: Record<string, unknown> };

  it('takes identity on the execute answer and each spec, and bound from the search', () => {
    const payload = fixture('wire-hook-execute-identity.json');
    const decision = payload.decision as Record<string, unknown> & { specs: Spec[] };
    expect(parseForTests('hook', payload).success).toBe(true);
    expect(decision.identity).toMatchObject({ service: 'exa-search', source: 'tenjin' });
    for (const spec of decision.specs) expect(spec.identity).toBeDefined();
    expect(decision.bound).toEqual({ query: 'x402 agent payments' });
    const identity = decision.identity as Record<string, unknown>;
    const withIdentity = (value: unknown) => ({
      ...payload,
      decision: { ...decision, identity: value },
    });
    expect(parseForTests('hook', withIdentity({ ...identity, surprise: 1 })).success).toBe(false);
    expect(parseForTests('hook', withIdentity({ ...identity, revision: 'abc' })).success).toBe(
      false,
    );
    const oversize = { query: 'x'.repeat(16 * 1024) };
    expect(
      parseForTests('hook', { ...payload, decision: { ...decision, bound: oversize } }).success,
    ).toBe(false);
  });

  it('takes the augment identity, the bound list offer and the row spec identity', () => {
    const augment = fixture('wire-hook-execute-augment-identity.json');
    expect(parseForTests('hook', augment).success).toBe(true);
    expect(augment.decision).not.toHaveProperty('bound');
    const bound = fixture('wire-hook-discovered-bound.json');
    expect(parseForTests('hook', bound).success).toBe(true);
    const discovered = bound.decision as { id: string; bound: unknown; specs: Spec[] };
    expect(discovered.bound).toBeDefined();
    for (const spec of discovered.specs) expect(spec.identity).toBeDefined();
    const row = fixture('wire-lookup-spec-identity.json');
    expect(parseForTests('tool', row).success).toBe(true);
    expect((row.decision as { spec: Spec }).spec.identity).toBeDefined();
  });

  it('reads policy_refused with its rule, and keeps the answer when the rule is new or odd', () => {
    for (const [name, kind] of [
      ['wire-hook-policy-refused.json', 'hook'],
      ['wire-lookup-policy-refused.json', 'tool'],
    ] as const) {
      const payload = fixture(name);
      const decision = payload.decision as { diagnostics: Record<string, unknown> };
      expect(decision.diagnostics.reasonCode).toBe('policy_refused');
      expect(parseForTests(kind, payload).success).toBe(true);
      const withRule = (rule: unknown) => ({
        ...payload,
        decision: { ...decision, diagnostics: { ...decision.diagnostics, rule } },
      });
      expect(
        parseForTests(kind, withRule({ from: 'saved', kind: 'account_only', extra: true })).success,
      ).toBe(true);
      expect(parseForTests(kind, withRule(42)).success).toBe(true);
    }
  });

  it('parses the directory and its unchanged answer, and nothing else as one', () => {
    const full = fixture('wire-directory.json');
    expect(parseForTests('directory', full).success).toBe(true);
    expect(parseForTests('directory', fixture('wire-directory-unchanged.json')).success).toBe(true);
    expect(parseForTests('browse', full).success).toBe(false);
    expect(parseForTests('directory', fixture('wire-browse.json')).success).toBe(false);
    const listing = full.directory as Record<string, unknown> & { services: Spec[] };
    expect(
      parseForTests('directory', { ...full, directory: { ...listing, surprise: [] } }).success,
    ).toBe(false);
    const [first] = listing.services;
    expect(
      parseForTests('directory', {
        ...full,
        directory: { ...listing, services: [{ ...first, identity: undefined }] },
      }).success,
    ).toBe(false);
  });
});

/**
 * CONNECTED ACCOUNTS (#37), the server's own fixtures. An account lead is
 * offered alone, carries no URL and no balance price, runs in place of a native
 * call only through `bound` as any lead does, and its fallback is Tenjin's own
 * route for the same task. Each
 * rule below is one the server's schema runs, so a shape only one side takes
 * fails here first.
 */
describe('the answers about connected accounts', () => {
  type Decision = Record<string, unknown> & {
    specs: Record<string, unknown>[];
    fallback?: Record<string, unknown>;
  };
  const execute = () => {
    const payload = fixture('wire-hook-execute-account.json');
    return { payload, decision: payload.decision as Decision };
  };
  const withDecision = (payload: Record<string, unknown>, decision: Record<string, unknown>) => ({
    ...payload,
    decision,
  });

  it('parses the account lead, its spec answer and the unchecked refusal', () => {
    const { payload, decision } = execute();
    expect(parseForTests('hook', payload).success).toBe(true);
    expect(decision).not.toHaveProperty('endpoint');
    expect(decision.providerPriceAtomic).toBe('0');
    expect(decision.specs[0]).toHaveProperty('mcp');
    expect((decision.fallback?.identity as { source: string }).source).toBe('tenjin');
    expect(parseForTests('tool', fixture('wire-lookup-spec-account.json')).success).toBe(true);
    const refused = fixture('wire-lookup-account-unverified.json');
    expect(parseForTests('tool', refused).success).toBe(true);
    expect(
      (refused.decision as { diagnostics: { rule: { kind: string } } }).diagnostics.rule.kind,
    ).toBe('unverified');
  });

  it("parses a checked account lead bound to the native fetch, with Tenjin's route beside it", () => {
    const payload = fixture('wire-hook-execute-account-bound.json');
    const parsed = parseForTests('hook', payload);
    expect(parsed.success).toBe(true);
    const decision = payload.decision as Decision & { bound: Record<string, unknown> };
    const [lead] = decision.specs as [{ verified: boolean; mcp: unknown; pinned: object }];
    expect(lead.verified).toBe(true);
    expect(lead).toHaveProperty('mcp');
    const request = fixture('wire-hook-request-account-fetch.json');
    expect(request.accepts).toEqual(expect.arrayContaining(['bound', 'mcp']));
    const pending = (request.packet as { pendingCall: { url: string } }).pendingCall;
    expect(decision.bound).toEqual({ url: pending.url });
    expect(Object.keys(decision.bound).some((field) => field in lead.pinned)).toBe(false);
    expect((decision.fallback?.identity as { source: string }).source).toBe('tenjin');
    // The same lead, unchecked, is never offered by the hook, bound or not.
    expect(
      parseForTests(
        'hook',
        withDecision(payload, { ...decision, specs: [{ ...lead, verified: false }] }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ['an endpoint', (d: Decision) => ({ ...d, endpoint: 'https://mcp.apify.com' })],
    ['a balance price', (d: Decision) => ({ ...d, providerPriceAtomic: '1000' })],
    ['an augment delivery', (d: Decision) => ({ ...d, delivery: 'augment' })],
    ['an unchecked map', (d: Decision) => ({ ...d, specs: [{ ...d.specs[0], verified: false }] })],
    [
      'a sibling spec',
      (d: Decision) => ({ ...d, specs: [...d.specs, { ...d.fallback, id: 'x'.repeat(16) }] }),
    ],
    [
      'a fallback on another account',
      (d: Decision) => ({
        ...d,
        fallback: {
          ...d.fallback,
          identity: { ...(d.fallback?.identity as object), source: 'fal' },
        },
      }),
    ],
    [
      'a fallback for another task',
      (d: Decision) => ({
        ...d,
        fallback: {
          ...d.fallback,
          identity: { ...(d.fallback?.identity as object), task: 'web research' },
        },
      }),
    ],
    [
      'a first call that reads a result',
      (d: Decision) => {
        const spec = d.specs[0] as { mcp: Record<string, unknown> };
        return {
          ...d,
          specs: [{ ...spec, mcp: { ...spec.mcp, args: { runId: '{result.runId}' } } }],
        };
      },
    ],
    [
      'a placeholder for no input field',
      (d: Decision) => {
        const spec = d.specs[0] as { mcp: Record<string, unknown> };
        return {
          ...d,
          specs: [{ ...spec, mcp: { ...spec.mcp, args: { actor: '{nowhere}' } } }],
        };
      },
    ],
    [
      'a spec on the built-in source',
      (d: Decision) => {
        const spec = d.specs[0] as { identity: Record<string, unknown> };
        return { ...d, specs: [{ ...spec, identity: { ...spec.identity, source: 'tenjin' } }] };
      },
    ],
    [
      'a poll that sends the billing call again',
      (d: Decision) => {
        const spec = d.specs[0] as {
          mcp: { tool: string; next: { poll: Record<string, unknown> } };
        };
        const { mcp } = spec;
        const next = { ...mcp.next, poll: { ...mcp.next.poll, tool: mcp.tool } };
        return { ...d, specs: [{ ...spec, mcp: { ...mcp, next } }] };
      },
    ],
    [
      'a follow-up that sends the billing call again',
      (d: Decision) => {
        const spec = d.specs[0] as { mcp: { tool: string; next: Record<string, unknown> } };
        const { mcp } = spec;
        return {
          ...d,
          specs: [{ ...spec, mcp: { ...mcp, next: { ...mcp.next, tool: mcp.tool } } }],
        };
      },
    ],
  ])('refuses an account lead with %s', (_, edit) => {
    const { payload, decision } = execute();
    expect(parseForTests('hook', withDecision(payload, edit(decision))).success).toBe(false);
  });

  it('refuses a fallback beside a paid lead, and an account spec beside one', () => {
    const { decision } = execute();
    const paid = fixture('wire-hook-execute-identity.json');
    const lead = paid.decision as Decision;
    expect(parseForTests('hook', paid).success).toBe(true);
    expect(
      parseForTests('hook', withDecision(paid, { ...lead, fallback: decision.fallback })).success,
    ).toBe(false);
    if (lead.specs !== undefined) {
      expect(
        parseForTests(
          'hook',
          withDecision(paid, {
            ...lead,
            specs: [...lead.specs, { ...decision.specs[0], id: 'y'.repeat(16) }],
          }),
        ).success,
      ).toBe(false);
    }
    const spec = fixture('wire-lookup-spec-identity.json');
    expect(
      parseForTests(
        'tool',
        withDecision(spec, {
          ...(spec.decision as object),
          fallback: decision.fallback,
        }),
      ).success,
    ).toBe(false);
  });

  it('parses the directory with the accounts it can connect, under the same rules', () => {
    const full = fixture('wire-directory-mcp.json');
    expect(parseForTests('directory', full).success).toBe(true);
    type Account = Record<string, unknown> & { services: { id: string }[] };
    const listing = full.directory as Record<string, unknown> & { connectable: Account[] };
    const [apify, ...rest] = listing.connectable;
    const edited = (account: Record<string, unknown>) => ({
      ...full,
      directory: { ...listing, connectable: [account, ...rest] },
    });
    expect(parseForTests('directory', edited(apify!)).success).toBe(true);
    for (const account of [
      { ...apify, id: 'tenjin' },
      { ...apify, id: 'Apify' },
      { ...apify, mcpUrl: 'http://mcp.apify.com' },
      { ...apify, mcpUrl: 'https://mcp.apify.com?tools=actors' },
      { ...apify, mcpUrl: 'https://user:pass@mcp.apify.com' },
      { ...apify, key: undefined },
      { ...apify, signIn: ['oauth'] },
      { ...apify, services: [{ ...apify!.services[0], id: 'fal.flux-pro-ultra' }] },
    ]) {
      expect(parseForTests('directory', edited(account)).success, JSON.stringify(account)).toBe(
        false,
      );
    }
    // Every service off the built-in source is listed by an account.
    expect(
      parseForTests('directory', { ...full, directory: { ...listing, connectable: rest } }).success,
    ).toBe(false);
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

  /** The after-call leg's one wait, for a search's free docs, can be followed
   *  by the gate when none came back and the search was short: the wait and the
   *  slowest paid call in a row fit its longer timeout with the same floor. */
  it('fits the docs wait and the slowest paid call inside the after-call timeout', () => {
    const budget = AFTER_CALL_TIMEOUT_SECONDS * 1_000;
    const used = AUGMENT_WAIT_MS + GATE_TIMEOUT_MS;
    expect(budget - used).toBeGreaterThanOrEqual(FLOOR_MS);
  });
});

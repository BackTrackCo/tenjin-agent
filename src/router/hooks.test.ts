import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_LINE,
  looksSingleIntent,
  preparedLine,
  promptSkipReason,
  runNativeHook,
  runPromptHook,
  SINGLE_INTENT_ONLY_ENV,
} from './hooks';
import { ROUTER_PATH } from './decision';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BASE = 'https://tenjin.sh';

/** A recorded decision answer; `calls` is what the hook actually sent. */
function router(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const NATIVE = { schemaVersion: 1, routerVersion: 'v', action: 'native' };
const EXECUTE = {
  schemaVersion: 1,
  routerVersion: 'v',
  id: 'k3f9',
  action: 'execute',
  description: 'read the page https://example.test/spec',
  provider: 'Firecrawl',
  providerPriceAtomic: '10000',
};
const NEEDS_INPUT = {
  schemaVersion: 1,
  routerVersion: 'v',
  action: 'needs_input',
  diagnostics: {
    reasonCode: 'missing_required_argument',
    stage: 'bind',
    missing: ['company_domain'],
    nextAction: 'Ask the user for the company domain, then call request({query}).',
  },
};

function promptEvent(prompt: string): unknown {
  return { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt };
}

function nativeEvent(query: string, tool: 'WebSearch' | 'WebFetch' = 'WebSearch'): unknown {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    tool_name: tool,
    tool_input: tool === 'WebSearch' ? { query } : { url: query },
  };
}

describe('the prompt hook', () => {
  /**
   * A PREPARED DECISION HAS TO BE EASY TO DECLINE. The line names what was
   * prepared, who would be paid and what they charge, then gives both moves.
   */
  it('injects one line naming what was prepared, its provider and its price', async () => {
    const { fetchImpl, calls } = router(EXECUTE);
    const out = await runPromptHook(promptEvent('read https://example.test/spec for me'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
    });
    const line = (out.response as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(line).toContain('read the page https://example.test/spec');
    expect(line).toContain('via Firecrawl');
    expect(line).toContain('$0.01');
    expect(line).toContain("request({query, id:'k3f9'})");
    // And how to decline it, in the same line.
    expect(line).toContain('otherwise call request({query})');
    expect(out).toMatchObject({ action: 'execute', id: 'k3f9' });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { url: string }).url).toBe(`${BASE}${ROUTER_PATH}`);
  });

  it('says nothing at all on native', async () => {
    const { fetchImpl } = router(NATIVE);
    const out = await runPromptHook(promptEvent('what is the weather'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
    });
    expect(out.response).toBeNull();
    expect(out.action).toBe('native');
  });

  it('turns needs_input into the question to ask', async () => {
    const { fetchImpl } = router(NEEDS_INPUT);
    const out = await runPromptHook(promptEvent('enrich them'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
    });
    const line = (out.response as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(line).toBe('Ask the user for the company domain, then call request({query}).');
  });

  /** THE ONE FALLBACK. A decision that did not arrive is not a dead turn. */
  it.each([
    ['a refusal', { error: { code: 'nope', message: 'no' } }, 503],
    ['a body this build cannot read', { schemaVersion: 2 }, 200],
  ])('falls back to the query line on %s', async (_label, body, status) => {
    const { fetchImpl } = router(body, status);
    const out = await runPromptHook(promptEvent('research x402'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
      warn: () => undefined,
    });
    expect(
      (out.response as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
        .additionalContext,
    ).toBe(FALLBACK_LINE);
  });

  it('never asks about a slash command or an acknowledgement', async () => {
    const { fetchImpl, calls } = router(EXECUTE);
    for (const prompt of ['/compact', 'ok', 'thanks']) {
      const out = await runPromptHook(promptEvent(prompt), {
        dataDir: dir,
        baseUrl: BASE,
        fetchImpl,
      });
      expect(out.response).toBeNull();
      expect(out.skipped).toBeDefined();
    }
    expect(calls).toHaveLength(0);
    expect(promptSkipReason('/help')).toBe('slash');
    expect(promptSkipReason('yes')).toBe('acknowledgement');
    expect(promptSkipReason('2^1000')).toBeNull();
  });
});

describe('the native hook', () => {
  /** ALLOW IS THE DEFAULT and a redirect is the exception. */
  it.each([
    ['native', NATIVE],
    ['needs_input', NEEDS_INPUT],
  ])('allows the call on %s', async (_label, body) => {
    const { fetchImpl } = router(body);
    const out = await runNativeHook(nativeEvent('btc price today'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
    });
    expect(out).toMatchObject({ decision: 'allow', response: null });
  });

  it.each([
    ['a refusal', { error: { code: 'nope', message: 'no' } }, 503],
    ['a body this build cannot read', { schemaVersion: 2 }, 200],
  ])('allows the call on %s', async (_label, body, status) => {
    const { fetchImpl } = router(body, status);
    const out = await runNativeHook(nativeEvent('btc price today'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
      warn: () => undefined,
    });
    expect(out.decision).toBe('allow');
  });

  it('redirects a clear execute and carries the id into the redirect', async () => {
    const { fetchImpl } = router(EXECUTE);
    const out = await runNativeHook(nativeEvent('https://example.test/spec', 'WebFetch'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
    });
    expect(out.decision).toBe('deny');
    expect(out.id).toBe('k3f9');
    const reason = (out.response as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("id:'k3f9'");
    // The subject rides along: a WebFetch carries no query, and a bare "call
    // request" leaves the model nothing to carry across.
    expect(reason).toContain('https://example.test/spec');
  });

  it('allows an event it cannot read rather than blocking a tool', async () => {
    const { fetchImpl, calls } = router(EXECUTE);
    const deps = { dataDir: dir, baseUrl: BASE, fetchImpl };
    expect(await runNativeHook({ hook_event_name: 'PreToolUse' }, deps)).toMatchObject({
      decision: 'allow',
    });
    expect(
      await runNativeHook({ ...(nativeEvent('x') as object), tool_input: {} }, deps),
    ).toMatchObject({ decision: 'allow' });
    expect(calls).toHaveLength(0);
  });
});

describe('the prepared line', () => {
  it('degrades one field at a time rather than inventing any', () => {
    expect(preparedLine({ schemaVersion: 1, routerVersion: 'v', action: 'execute' })).toBe(
      'Prepared: a paid lookup. If that is what you need, call request({query}); otherwise call request({query}) with your own lookup.',
    );
    expect(
      preparedLine({
        schemaVersion: 1,
        routerVersion: 'v',
        action: 'execute',
        id: 'x1',
        description: 'quotes ready',
      }),
    ).toContain("call request({query, id:'x1'})");
  });
});

/**
 * THE FLAG IS OFF, AND IT IS HERE SO THE SMOKE CAN TURN IT ON. The worry is a
 * mixed turn where the model takes the prepared id for a different part of the
 * request; the tool already declines an id whose page the query does not name,
 * and the smoke counts the mismatched ids taken anyway. This is what a non-zero
 * count switches on, with no second design round.
 */
describe('offering the id only on single-intent turns', () => {
  const MIXED = 'What do you think of the product, and find me alpha leads?';

  it('offers the id on a mixed turn by default', async () => {
    const { fetchImpl } = router(EXECUTE);
    const out = await runPromptHook(promptEvent(MIXED), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
      env: {},
    });
    expect(out.id).toBe('k3f9');
  });

  it('withholds it on a mixed turn once the flag is set, and still names the lookup', async () => {
    const { fetchImpl } = router(EXECUTE);
    const out = await runPromptHook(promptEvent(MIXED), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
      env: { [SINGLE_INTENT_ONLY_ENV]: '1' },
    });
    expect(out.id).toBeUndefined();
    const line = (out.response as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(line).toContain('read the page https://example.test/spec');
    expect(line).not.toContain('id:');
  });

  it('still offers it for one plain ask under the flag', async () => {
    const { fetchImpl } = router(EXECUTE);
    const out = await runPromptHook(promptEvent('read https://example.test/spec'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
      env: { [SINGLE_INTENT_ONLY_ENV]: '1' },
    });
    expect(out.id).toBe('k3f9');
  });

  it.each([
    ['one plain ask', 'read https://example.test/spec', true],
    ['two sentences', 'Read the spec. Then find leads.', false],
    ['a joined clause', 'read the spec and find leads', false],
  ])('reads %s', (_label, prompt, expected) => {
    expect(looksSingleIntent(prompt)).toBe(expected);
  });
});

/**
 * THE HOOK WRITES DOWN WHAT IT OFFERED. The tool runs a prepared decision only
 * for an id on that list, so an id arriving from a fetched page or somebody
 * else's message is not a shortcut into this wallet.
 */
describe('the ids a hook hands out', () => {
  it('records an execute id from the prompt hook, and nothing on native', async () => {
    const { issuedHere } = await import('./issued-ids');
    const first = router(EXECUTE);
    await runPromptHook(promptEvent('read https://example.test/spec'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl: first.fetchImpl,
    });
    const held = await issuedHere(dir, 'k3f9');
    expect(held).not.toBeNull();
    // With the page it named, so a query about another page skips the shortcut.
    expect(held?.target).toBe('https://example.test/spec');

    const second = router(NATIVE);
    await runPromptHook(promptEvent('what is the weather'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl: second.fetchImpl,
    });
    expect(await issuedHere(dir, 'nothing-was-offered')).toBeNull();
  });

  it('records the id the native redirect carries', async () => {
    const { issuedHere } = await import('./issued-ids');
    const { fetchImpl } = router(EXECUTE);
    await runNativeHook(nativeEvent('https://example.test/spec', 'WebFetch'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
    });
    expect(await issuedHere(dir, 'k3f9')).not.toBeNull();
  });

  it('records nothing when the flag withholds the id', async () => {
    const { issuedHere } = await import('./issued-ids');
    const { fetchImpl } = router(EXECUTE);
    await runPromptHook(promptEvent('read the spec and find leads'), {
      dataDir: dir,
      baseUrl: BASE,
      fetchImpl,
      env: { [SINGLE_INTENT_ONLY_ENV]: '1' },
    });
    expect(await issuedHere(dir, 'k3f9')).toBeNull();
  });
});

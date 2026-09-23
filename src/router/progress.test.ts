import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindDecision,
  EXPIRY_MS,
  newCallId,
  noteSession,
  openLookupFooter,
  pruneProgress,
  pruneSessions,
  renderProgress,
  resolveProgressSession,
  SESSION_ACTIVE_MS,
  sessionDir,
  STALE_AFTER_MS,
  writeProgress,
} from './progress';

/**
 * The footer's evidence. Two questions decide every test here: does the line a
 * person reads say what actually happened, and can one session's lookup ever
 * appear in another session's terminal.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-progress-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const PROVIDER = 'https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest';

describe('what the status line renders', () => {
  it('is ready when the session has never looked anything up', async () => {
    expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe('x402 · ready');
  });

  it('names the executed provider and its parameters while the call runs', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      { phase: 'calling', provider: PROVIDER, parameters: { query: { symbol: 'BTC,ETH' } } },
      NOW,
    );

    expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe(
      'x402 · request: calling pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest · {"query":{"symbol":"BTC,ETH"}}',
    );
  });

  it('shows the decision in flight before any provider is known', async () => {
    await writeProgress(sessionDir(dir, 'session-a'), 'call-1', { phase: 'routing' }, NOW);
    expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe('x402 · request: routing');
  });

  it('keeps a finished call on the line with its outcome and price', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      {
        phase: 'done',
        outcome: 'fulfilled',
        provider: 'https://hunter.x402.paywithlocus.com/hunter/company-enrichment',
        parameters: { body: { domain: 'stripe.com' } },
        price: '$0.01',
      },
      NOW,
    );

    expect(await renderProgress(dir, 'session-a', { now: NOW + 2_000 })).toBe(
      'x402 · request: fulfilled hunter.x402.paywithlocus.com/hunter/company-enrichment · {"body":{"domain":"stripe.com"}} · $0.01',
    );
    // ...and drops off once it is no longer news.
    expect(await renderProgress(dir, 'session-a', { now: NOW + 60_000 })).toBe('x402 · ready');
  });

  it('names the newest of two overlapping calls and counts the rest', async () => {
    const session = sessionDir(dir, 'session-a');
    await writeProgress(session, 'call-1', { phase: 'calling', provider: PROVIDER }, NOW);
    await writeProgress(
      session,
      'call-2',
      { phase: 'calling', provider: 'https://api.exa.ai/search' },
      NOW + 10,
    );

    expect(await renderProgress(dir, 'session-a', { now: NOW + 20 })).toBe(
      'x402 · request: calling api.exa.ai/search · +1 more',
    );
  });

  it('calls an abandoned call stale rather than claiming it is still running', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      { phase: 'calling', provider: PROVIDER },
      NOW,
    );

    expect(await renderProgress(dir, 'session-a', { now: NOW + STALE_AFTER_MS + 1 })).toBe(
      'x402 · request: stale, no outcome recorded',
    );
  });

  it('never emits a terminal control sequence a provider put in its URL', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      {
        phase: 'calling',
        // Built rather than typed: a literal directional override in a source
        // file is the very thing this test says must never reach a terminal.
        provider: `https://evil.test/a\u001b[2Kb${String.fromCharCode(0x202e)}c`,
        parameters: { note: 'one\nline\u0007' },
      },
      NOW,
    );

    const rendered = await renderProgress(dir, 'session-a', { now: NOW });
    expect(rendered).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(rendered).toContain('evil.test');
  });

  it('redacts a secret a decision put in its parameters', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      {
        phase: 'calling',
        provider: PROVIDER,
        parameters: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      },
      NOW,
    );

    const rendered = await renderProgress(dir, 'session-a', { now: NOW });
    expect(rendered).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(rendered).toContain('redacted');
  });

  it('bounds the line to the terminal width', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      { phase: 'calling', provider: `https://long.test/${'p'.repeat(200)}` },
      NOW,
    );

    expect((await renderProgress(dir, 'session-a', { now: NOW, columns: 60 })).length).toBe(60);
  });

  it('shows nothing from another session', async () => {
    await writeProgress(
      sessionDir(dir, 'session-a'),
      'call-1',
      { phase: 'calling', provider: PROVIDER },
      NOW,
    );

    expect(await renderProgress(dir, 'session-b', { now: NOW })).toBe('x402 · ready');
  });

  it('ignores a file that is not one of its own records', async () => {
    const session = sessionDir(dir, 'session-a');
    await writeProgress(session, 'call-1', { phase: 'routing' }, NOW);
    await writeFile(join(session, 'notes.json'), JSON.stringify({ version: 1, at: NOW }));
    await writeFile(join(session, `${'f'.repeat(64)}.json`), 'not json');

    expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe('x402 · request: routing');
  });
});

describe('which session a tool call belongs to', () => {
  it('follows the binding the hook left for that decision id', async () => {
    await noteSession(dir, 'session-a', NOW);
    await noteSession(dir, 'session-b', NOW);
    await bindDecision(dir, 'session-b', 'turn-42', NOW);

    expect(await resolveProgressSession(dir, { id: 'turn-42', now: NOW })).toBe(
      sessionDir(dir, 'session-b'),
    );
  });

  it('uses the only active session when the call carries no id', async () => {
    await noteSession(dir, 'session-a', NOW);

    expect(await resolveProgressSession(dir, { now: NOW })).toBe(sessionDir(dir, 'session-a'));
  });

  it('refuses to guess between two active sessions', async () => {
    await noteSession(dir, 'session-a', NOW);
    await noteSession(dir, 'session-b', NOW);

    expect(await resolveProgressSession(dir, { now: NOW })).toBeNull();
    expect(await resolveProgressSession(dir, { id: 'unknown-turn', now: NOW })).toBeNull();
  });

  it('writes nothing at all when it cannot tell', async () => {
    await noteSession(dir, 'session-a', NOW);
    await noteSession(dir, 'session-b', NOW);
    const footer = await openLookupFooter(dir, { now: () => NOW });
    await footer.routing();
    await footer.done('fulfilled', { provider: PROVIDER });

    expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe('x402 · ready');
    expect(await renderProgress(dir, 'session-b', { now: NOW })).toBe('x402 · ready');
  });

  it('carries one lookup from routing to its outcome in the bound session', async () => {
    await noteSession(dir, 'session-a', NOW);
    await bindDecision(dir, 'session-a', 'turn-42', NOW);
    const footer = await openLookupFooter(dir, { id: 'turn-42', now: () => NOW });

    await footer.routing();
    expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe('x402 · request: routing');

    await footer.calling({ provider: PROVIDER, parameters: { symbol: 'BTC' } });
    expect(await renderProgress(dir, 'session-a', { now: NOW })).toContain(
      'calling pro-api.coinmarketcap.com',
    );

    await footer.done('fulfilled', { provider: PROVIDER, price: '$0.01' });
    expect(await renderProgress(dir, 'session-a', { now: NOW })).toContain('fulfilled');
  });
});

describe('housekeeping', () => {
  it('drops records past the expiry and leaves the live one', async () => {
    const session = sessionDir(dir, 'session-a');
    await writeProgress(
      session,
      'old',
      { phase: 'done', outcome: 'fulfilled' },
      NOW - EXPIRY_MS - 1,
    );
    await writeProgress(session, 'new', { phase: 'routing' }, NOW);

    await pruneProgress(session, NOW);

    expect((await readdir(session)).length).toBe(1);
  });

  it('gives every call its own record', () => {
    expect(newCallId()).not.toBe(newCallId());
  });
});

describe('sessions that are over', () => {
  it('drops their directories, and keeps a live one', async () => {
    await noteSession(dir, 'live', NOW);
    await noteSession(dir, 'gone', NOW - SESSION_ACTIVE_MS - 1);
    await writeProgress(sessionDir(dir, 'gone'), 'old', { phase: 'routing' }, NOW - EXPIRY_MS - 1);

    await pruneSessions(dir, NOW);

    expect(existsSync(sessionDir(dir, 'live'))).toBe(true);
    expect(existsSync(sessionDir(dir, 'gone'))).toBe(false);
    // ...so the one that is left can still claim an id-less call.
    expect(await resolveProgressSession(dir, { now: NOW })).toBe(sessionDir(dir, 'live'));
  });

  it('keeps a quiet session that still has a call inside the display window', async () => {
    await noteSession(dir, 'quiet', NOW - SESSION_ACTIVE_MS - 1);
    await writeProgress(sessionDir(dir, 'quiet'), 'call-1', { phase: 'calling' }, NOW);

    await pruneSessions(dir, NOW);

    expect(await renderProgress(dir, 'quiet', { now: NOW })).toBe('x402 · request: calling');
  });
});

describe('when the display itself fails', () => {
  it('prints nothing, rather than a state it could not read', async () => {
    const session = sessionDir(dir, 'session-a');
    await writeProgress(session, 'call-1', { phase: 'routing' }, NOW);
    await chmod(session, 0o000);

    try {
      expect(await renderProgress(dir, 'session-a', { now: NOW })).toBe('');
    } finally {
      await chmod(session, 0o700);
    }
  });

  it('still says ready for a session that has looked nothing up', async () => {
    expect(await renderProgress(dir, 'never-used', { now: NOW })).toBe('x402 · ready');
  });
});

import { describe, it, expect } from 'vitest';
import {
  dedupeFindings,
  describeFindings,
  needsConfirmation,
  publicFinding,
  resolveWriteAuth,
  writeModeNotices,
} from './consent';
import { testSigner } from './read-test-utils';
import type { ResolvedPublishSettings } from './settings';
import type { ScanFinding } from './scan';

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    check: 'aws-access-key',
    severity: 'block',
    line: 4,
    excerpt: 'AKIA…MASKED',
    ...over,
  } as ScanFinding;
}

function settings(over: Partial<ResolvedPublishSettings> = {}): ResolvedPublishSettings {
  return {
    mode: 'review',
    modeSource: 'default',
    defaultPriceAtomic: '100000',
    priceSource: 'default',
    warnings: [],
    ...over,
  } as ResolvedPublishSettings;
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(''),
    stream: {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
  };
}

describe('needsConfirmation — the D38 gate, shared by publish and edit', () => {
  it.each([
    ['review', 0, true],
    ['review', 2, true],
    ['auto', 0, false],
    ['auto', 1, true],
    ['full-auto', 0, false],
    ['full-auto', 3, false],
  ] as const)('%s mode with %i warning(s) → %s', (mode, warns, expected) => {
    expect(needsConfirmation(mode, warns)).toBe(expected);
  });
});

describe('writeModeNotices', () => {
  it('prints the resolver warnings verbatim', () => {
    const cap = capture();
    writeModeNotices(cap.stream, settings({ warnings: ['downgraded to auto'] }), {}, 'explainer');
    expect(cap.text()).toContain('downgraded to auto');
  });

  it('names a mistyped env mode instead of discarding it silently', () => {
    const cap = capture();
    writeModeNotices(cap.stream, settings(), { TENJIN_PUBLISH_MODE: 'reveiw' }, 'explainer');
    expect(cap.text()).toContain('Ignoring invalid TENJIN_PUBLISH_MODE="reveiw"');
    expect(cap.text()).toContain('using review (default)');
  });

  it('says nothing about the env when the value is valid', () => {
    const cap = capture();
    writeModeNotices(
      cap.stream,
      settings({ modeSource: 'env' }),
      { TENJIN_PUBLISH_MODE: 'auto' },
      'x',
    );
    expect(cap.text()).toBe('');
  });

  it('explains an unconfigured mode once, in the caller’s words', () => {
    const cap = capture();
    writeModeNotices(cap.stream, settings(), {}, 'each edit asks you once');
    expect(cap.text()).toBe(
      'publish.mode: review (default) - each edit asks you once: tenjin config set publish.mode auto.\n',
    );
  });

  it('stays quiet once the mode is configured', () => {
    const cap = capture();
    writeModeNotices(cap.stream, settings({ modeSource: 'file' }), {}, 'explainer');
    expect(cap.text()).toBe('');
  });
});

describe('finding shaping', () => {
  it('publicFinding echoes only the four safe fields', () => {
    expect(publicFinding(finding())).toEqual({
      check: 'aws-access-key',
      severity: 'block',
      line: 4,
      excerpt: 'AKIA…MASKED',
    });
  });

  it('dedupeFindings collapses a repeat of the same check + excerpt, keeping the first', () => {
    const first = finding({ line: 4 });
    const second = finding({ line: 40 });
    const other = finding({ check: 'private-key', excerpt: '0x…MASKED' });
    expect(dedupeFindings([first, second, other])).toEqual([first, other]);
  });

  it('describeFindings counts the findings and lists each check once', () => {
    expect(describeFindings([finding(), finding({ line: 9 })])).toBe(
      '2 secret finding(s) (aws-access-key)',
    );
    expect(describeFindings([finding(), finding({ check: 'private-key' })])).toBe(
      '2 secret finding(s) (aws-access-key, private-key)',
    );
  });
});

describe('resolveWriteAuth', () => {
  const base = {
    signer: testSigner(),
    baseUrl: 'https://tenjin.blog',
    dataDir: '/nonexistent',
    scope: 'read+write' as const,
  };

  it('signs through the session key by default', async () => {
    const auth = resolveWriteAuth({ ...base, env: {} });
    // The session path recovers a stale per-request proof by re-signing; the plain
    // SIWX path does not know that code, which is what distinguishes the two here
    // without touching a wallet.
    expect(await auth.recover('session_expired')).toBe(true);
  });

  it('TENJIN_NO_SESSION=1 selects the plain-SIWX fallback', async () => {
    const auth = resolveWriteAuth({ ...base, env: { TENJIN_NO_SESSION: '1' } });
    expect(await auth.recover('session_expired')).toBe(false);
    expect(await auth.recover('nonce_already_used')).toBe(true);
  });

  it('an explicit useSession beats the environment', async () => {
    const auth = resolveWriteAuth({
      ...base,
      useSession: true,
      env: { TENJIN_NO_SESSION: '1' },
    });
    expect(await auth.recover('session_expired')).toBe(true);
  });
});

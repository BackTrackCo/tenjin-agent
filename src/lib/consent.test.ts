import { describe, it, expect } from 'vitest';
import {
  acksServerWarnings,
  dedupeFindings,
  describeFindings,
  needsConfirmation,
  publicFinding,
  resolveWriteAuth,
  writeModeNotices,
} from './consent';
import type { ServerAckInput } from './consent';
import type { AckServerWarnings, PublishMode } from './config';
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

describe('acksServerWarnings: a confirmation must post-date its findings', () => {
  const MODES: readonly PublishMode[] = ['review', 'auto', 'full-auto'];
  const SETTINGS: readonly AckServerWarnings[] = ['mode', 'on', 'off'];

  it.each([
    // mode, yes, setting, serverAddedUnseen, expected
    // The default reading. A yes covers what an earlier render showed; the
    // marketplace's own findings post-date it and are not covered.
    ['review', true, 'mode', true, false],
    ['review', true, 'mode', false, true],
    ['auto', true, 'mode', true, false],
    ['auto', true, 'mode', false, true],
    ['auto', false, 'mode', false, false],
    ['review', false, 'mode', true, false],
    // full-auto acks unasked: clearing soft findings unasked is its contract.
    ['full-auto', false, 'mode', true, true],
    ['full-auto', true, 'mode', true, true],
    // `off` is the switch a full-auto machine gets without changing its mode.
    ['full-auto', true, 'off', false, false],
    ['auto', true, 'off', false, false],
    // `on` is a standing yes for server findings. It never manufactures the
    // run's yes, so a run that was never told yes still holds.
    ['auto', true, 'on', true, true],
    ['review', true, 'on', true, true],
    ['auto', false, 'on', true, false],
  ] as const)('%s yes=%s setting=%s unseen=%s → %s', (mode, yes, setting, unseen, expected) => {
    expect(acksServerWarnings({ mode, yes, setting, serverAddedUnseen: unseen })).toBe(expected);
  });

  it('honours an override whatever the mode, the flag and the config say', () => {
    for (const mode of MODES) {
      for (const setting of SETTINGS) {
        for (const yes of [true, false]) {
          for (const serverAddedUnseen of [true, false]) {
            const base = { mode, yes, setting, serverAddedUnseen };
            expect(acksServerWarnings({ ...base, override: false })).toBe(false);
            expect(acksServerWarnings({ ...base, override: true })).toBe(true);
          }
        }
      }
    }
  });

  // THE INVARIANT THIS FUNCTION EXISTS TO HOLD. The rule it replaced was
  // `yes || full-auto`, which acked server findings the operator had not been
  // shown. Every reachable input must ack no MORE than that rule did: the change
  // may narrow what is auto-acked and may not widen it, config values included,
  // so `on` is a standing yes rather than a manufactured one.
  it('never acks anything the pre-gate `yes || full-auto` rule would not have', () => {
    // TOTAL over every input, `override` included: the old rule checked override
    // first too (`override ?? (yes || full-auto)`), so enumerating it here is a
    // like-for-like comparison rather than an exemption.
    for (const mode of MODES) {
      for (const setting of SETTINGS) {
        for (const yes of [true, false]) {
          for (const serverAddedUnseen of [true, false]) {
            for (const override of [true, false, undefined]) {
              const input: ServerAckInput = {
                mode,
                yes,
                setting,
                serverAddedUnseen,
                ...(override !== undefined ? { override } : {}),
              };
              const previously = override ?? (yes || mode === 'full-auto');
              if (acksServerWarnings(input)) {
                expect(previously, JSON.stringify(input)).toBe(true);
              }
            }
          }
        }
      }
    }
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

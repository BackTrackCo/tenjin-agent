import { describe, it, expect } from 'vitest';
import { emitFailure, emitNotice, emitSuccess, normalizeError } from './output';
import { sanitizeForTerminal } from './output';
import { CliError } from './errors';
import { SCHEMA_VERSION } from '../schemas';
import type { Io } from './output';

function captureIo(isTTY: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk(out), stderr: mk(err), isTTY };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('emitSuccess', () => {
  it('writes exactly one JSON success envelope with schemaVersion', () => {
    const cap = captureIo(false);
    emitSuccess(cap.io, 'wallet.show', { address: '0xabc' });
    const parsed = JSON.parse(cap.stdout());
    expect(parsed).toEqual({
      schemaVersion: SCHEMA_VERSION,
      command: 'wallet.show',
      ok: true,
      data: { address: '0xabc' },
    });
  });

  it('keeps stderr empty when not a TTY, even with human lines', () => {
    const cap = captureIo(false);
    emitSuccess(cap.io, 'doctor', { ok: true }, ['all good']);
    expect(cap.stderr()).toBe('');
  });

  it('at a TTY without --json, prints human lines to STDOUT and no envelope', () => {
    const cap = captureIo(true);
    emitSuccess(cap.io, 'doctor', { ok: true }, ['all good']);
    expect(cap.stdout()).toContain('all good');
    expect(cap.stdout()).not.toContain('schemaVersion'); // no JSON envelope
    expect(cap.stderr()).toBe('');
  });

  it('under --json even on a TTY, emits the envelope and no human lines', () => {
    const cap = captureIo(true);
    emitSuccess(cap.io, 'doctor', { ok: true }, ['all good'], { json: true });
    expect(JSON.parse(cap.stdout()).ok).toBe(true);
    expect(cap.stdout()).not.toContain('all good');
    expect(cap.stderr()).toBe('');
  });
});

describe('emitFailure', () => {
  it('writes one JSON failure envelope with code/message/fix', () => {
    const cap = captureIo(false);
    emitFailure(cap.io, 'config.set', new CliError('CONFIG_INVALID', 'bad', { fix: 'fix it' }));
    expect(JSON.parse(cap.stdout())).toEqual({
      schemaVersion: SCHEMA_VERSION,
      command: 'config.set',
      ok: false,
      error: { code: 'CONFIG_INVALID', message: 'bad', fix: 'fix it' },
    });
    expect(cap.stderr()).toBe('');
  });

  it('normalizes an unknown throw to INTERNAL and returns the CliError', () => {
    const cap = captureIo(false);
    const ret = emitFailure(cap.io, 'x', new Error('boom'));
    expect(JSON.parse(cap.stdout()).error.code).toBe('INTERNAL');
    expect(ret.code).toBe('INTERNAL');
    expect(ret.exitCode).toBe(1);
  });

  it('at a TTY without --json, prints error + fix to STDOUT and no envelope', () => {
    const cap = captureIo(true);
    const ret = emitFailure(cap.io, 'x', new CliError('USAGE', 'nope', { fix: 'do this' }));
    expect(cap.stdout()).toContain('nope');
    expect(cap.stdout()).toContain('do this');
    expect(cap.stdout()).not.toContain('schemaVersion'); // no JSON envelope
    expect(cap.stderr()).toBe('');
    expect(ret.exitCode).toBe(2); // exit code unchanged on the human path
  });

  it('under --json even on a TTY, emits the failure envelope', () => {
    const cap = captureIo(true);
    emitFailure(cap.io, 'x', new CliError('USAGE', 'nope', { fix: 'do this' }), { json: true });
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });

  it('at a TTY, renders details.findings compactly under the fix line', () => {
    const cap = captureIo(true);
    const err = new CliError('NEEDS_CONFIRMATION', 'needs confirm', {
      fix: 'review then --yes',
      details: {
        mode: 'review',
        findings: [
          { check: 'aws-access-key', severity: 'warn', line: 12, excerpt: 'AKIA…MPLE' },
          { check: 'email', severity: 'warn', line: 4, excerpt: 'a@b.com' },
        ],
      },
    });
    emitFailure(cap.io, 'publish', err);
    const out = cap.stdout();
    expect(out).toContain('aws-access-key (warn, line 12): AKIA…MPLE');
    expect(out).toContain('email (warn, line 4): a@b.com');
    expect(out).not.toContain('schemaVersion'); // still no envelope
    // the finding lines come after the fix line
    expect(out.indexOf('review then --yes')).toBeLessThan(out.indexOf('aws-access-key'));
  });

  it('at a TTY, names the source of a finding the server gate contributed', () => {
    const cap = captureIo(true);
    const err = new CliError('NEEDS_CONFIRMATION', 'held', {
      details: {
        findings: [
          {
            check: 'wallet-address',
            severity: 'warn',
            line: 2,
            excerpt: '0xab…cd',
            source: 'both',
          },
          // A detector this release predates still renders, name and all.
          {
            check: 'semantic-pii',
            severity: 'warn',
            line: 1,
            excerpt: 'reads as…',
            source: 'server',
          },
          { check: 'email', severity: 'warn', line: 4, excerpt: 'a@b.com', source: 'local' },
        ],
      },
    });
    emitFailure(cap.io, 'publish', err);
    const out = cap.stdout();
    expect(out).toContain('wallet-address [local+server] (warn, line 2): 0xab…cd');
    expect(out).toContain('semantic-pii [server] (warn, line 1): reads as…');
    expect(out).toContain('email (warn, line 4): a@b.com');
  });

  // A blocked envelope ships the block finding beside the warns the same pass
  // found. Without the tier on the line, nothing on the page says which one is
  // the refusal the operator has to act on.
  it('at a TTY, prints the tier so a mixed block/warn payload is readable', () => {
    const cap = captureIo(true);
    const err = new CliError('PUBLISH_BLOCKED', 'blocked', {
      details: {
        findings: [
          {
            check: 'aws-access-key',
            severity: 'block',
            line: 3,
            excerpt: 'AKIA…[redacted]',
            source: 'server',
          },
          { check: 'email', severity: 'warn', line: 9, excerpt: 'a@b.com', source: 'server' },
          // An open string: the server owns its own tier names, and one this
          // release predates renders rather than being dropped or normalized.
          { check: 'quantum-seed', severity: 'notice', line: 1, excerpt: 'x…', source: 'server' },
        ],
      },
    });
    emitFailure(cap.io, 'publish', err);
    const out = cap.stdout();
    expect(out).toContain('aws-access-key [server] (block, line 3): AKIA…[redacted]');
    expect(out).toContain('email [server] (warn, line 9): a@b.com');
    expect(out).toContain('quantum-seed [server] (notice, line 1): x…');
  });

  it('at a TTY, still renders a finding that carries no tier at all', () => {
    const cap = captureIo(true);
    const err = new CliError('NEEDS_CONFIRMATION', 'held', {
      details: { findings: [{ check: 'email', line: 4, excerpt: 'a@b.com', source: 'server' }] },
    });
    emitFailure(cap.io, 'publish', err);
    expect(cap.stdout()).toContain('email [server] (line 4): a@b.com');
  });

  it('leaves the machine envelope unchanged when details.findings is present', () => {
    const cap = captureIo(false);
    const details = {
      mode: 'review',
      findings: [{ check: 'jwt', severity: 'warn', line: 1, excerpt: 'eyJ…' }],
    };
    emitFailure(cap.io, 'publish', new CliError('NEEDS_CONFIRMATION', 'c', { details }));
    expect(JSON.parse(cap.stdout()).error.details).toEqual(details);
  });

  it('at a TTY, does not render non-finding detail shapes', () => {
    const cap = captureIo(true);
    const err = new CliError('USAGE', 'nope', {
      fix: 'do this',
      details: { price: { usd: '0.05' } },
    });
    emitFailure(cap.io, 'x', err);
    expect(cap.stdout()).not.toContain('0.05');
    expect(cap.stdout()).not.toContain('price');
  });
});

// How an AGENT learns a newer version exists. The nudge is one dim stderr line
// that only a human at a terminal sees; this rides the envelope the harness is
// already parsing, so it can decide to run `tenjin update` itself.
describe('updateAvailable on the envelope', () => {
  const signal = { current: '0.1.0-alpha.6', latest: '0.1.0-alpha.7' };

  it('rides a success envelope when one is known', () => {
    const cap = captureIo(false);
    emitSuccess(cap.io, 'search', { hits: [] }, [], { updateAvailable: signal });
    expect(JSON.parse(cap.stdout())).toMatchObject({ ok: true, updateAvailable: signal });
  });

  it('rides a failure envelope too, since the command failing is unrelated', () => {
    const cap = captureIo(false);
    emitFailure(cap.io, 'buy', new CliError('NETWORK_ERROR', 'nope'), {
      updateAvailable: signal,
    });
    expect(JSON.parse(cap.stdout())).toMatchObject({ ok: false, updateAvailable: signal });
  });

  // Absent, not null: an optional key nothing sets should not appear at all.
  it('is absent when nothing is known', () => {
    const cap = captureIo(false);
    emitSuccess(cap.io, 'search', { hits: [] }, [], { updateAvailable: null });
    expect(JSON.parse(cap.stdout())).not.toHaveProperty('updateAvailable');
  });

  // The human path is the dim line, not the envelope: a TTY run prints no JSON.
  it('does not disturb the human rendering', () => {
    const cap = captureIo(true);
    emitSuccess(cap.io, 'search', { hits: [] }, ['nothing found'], { updateAvailable: signal });
    expect(cap.stdout()).toBe('nothing found\n');
  });
});

describe('emitNotice', () => {
  it('writes one line to STDERR at a TTY, leaving stdout for the envelope', () => {
    const cap = captureIo(true);
    emitNotice(cap.io, 'spending window restarted');
    expect(cap.stderr()).toBe('spending window restarted\n');
    expect(cap.stdout()).toBe('');
  });

  it('is silent off a TTY and under --json (a machine consumer sees nothing)', () => {
    const piped = captureIo(false);
    emitNotice(piped.io, 'noise');
    expect(piped.stderr()).toBe('');
    const json = captureIo(true);
    emitNotice(json.io, 'noise', { json: true });
    expect(json.stderr()).toBe('');
  });

  it('sanitizes what it is given: these lines quote untrusted text', () => {
    const cap = captureIo(true);
    emitNotice(cap.io, 'version \u001b[2K1.0.0\u202e is available');
    expect(cap.stderr()).toBe('version 1.0.0 is available\n');
  });
});

describe('normalizeError', () => {
  it('passes a CliError through unchanged', () => {
    const original = new CliError('REFUSED', 'no');
    expect(normalizeError(original)).toBe(original);
  });
  it('wraps a non-Error throw as INTERNAL', () => {
    expect(normalizeError('weird').code).toBe('INTERNAL');
  });
});

// Every codepoint the sanitizer is expected to remove, so a case asserts the set
// is gone rather than eyeballing an invisible character in an expected string.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{FEFF}]/u;

// The three RGI subdivision flags, spelled out so a case can assert the exact
// bytes survive. Each is the waving black flag plus `gb`, the subdivision, and
// the cancel tag.
const FLAG_SCOTLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
const FLAG_WALES = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}';

describe('sanitizeForTerminal', () => {
  it('strips CSI cursor-repaint sequences that could spoof a confirm prompt', () => {
    const attack = 'Guide\x1b[2K\rBuy "Guide" for 0.05 USD? [y/N] ';
    expect(sanitizeForTerminal(attack)).toBe('GuideBuy "Guide" for 0.05 USD? [y/N] ');
  });

  it('strips OSC sequences, stray escapes, C0 (except tab), DEL, and C1', () => {
    expect(sanitizeForTerminal('a\x1b]0;evil\x07b')).toBe('ab');
    expect(sanitizeForTerminal('a\x1bZb')).toBe('ab');
    expect(sanitizeForTerminal('a\x00\x08\x0a\x1f\x7f\x9fb')).toBe('ab');
    expect(sanitizeForTerminal('keep\tthis-and-dashes')).toBe('keep\tthis-and-dashes');
  });

  it('leaves ordinary unicode text alone', () => {
    expect(sanitizeForTerminal('日本語 títle — ok')).toBe('日本語 títle — ok');
  });

  // The RLO reorders what follows it on screen, so a server-controlled title can
  // rewrite the confirm line the human is reading without touching its bytes.
  it('strips the bidi override that could reorder the buy confirm prompt', () => {
    // Composed the way buy.ts composes it: the sanitized server string sits in
    // the same line as the price it must not be able to move.
    const prompt = `Pay 0.05 USD to ${sanitizeForTerminal('\u202etitle')}? [y/N] `;
    expect(prompt).toBe('Pay 0.05 USD to title? [y/N] ');
    expect(BIDI.test(prompt)).toBe(false);
  });

  it('strips the isolates, the directional marks, and ALM', () => {
    expect(sanitizeForTerminal('a\u2066b\u2067c\u2068d\u2069e')).toBe('abcde');
    expect(sanitizeForTerminal('a\u200eb\u200fc\u061cd')).toBe('abcd');
  });

  // Only the directional set, not all of category Cf: ZWJ is what holds an emoji
  // sequence together, so stripping it would corrupt honest titles.
  it('keeps ZWJ so an emoji sequence in a title survives', () => {
    const title = '\u{1f469}\u200d\u{1f680} launch log';
    expect(sanitizeForTerminal(title)).toBe(title);
  });

  it('strips stray tag characters carrying no flag base', () => {
    expect(sanitizeForTerminal('re\u{E0041}\u{E0042}port')).toBe('report');
    expect(INVISIBLE.test(sanitizeForTerminal('re\u{E0041}\u{E0042}port'))).toBe(false);
  });

  // The smuggling shape: a well-formed tag sequence that is not one of the three
  // RGI flags draws as a bare black flag with the payload hidden behind it, so
  // the tags go and the base is left visible rather than the whole thing passing.
  it('degrades a non-RGI tag sequence to the bare flag base', () => {
    const smuggled = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0078}\u{E0079}\u{E007A}\u{E007F}';
    expect(sanitizeForTerminal(smuggled)).toBe('\u{1F3F4}');
    expect(INVISIBLE.test(sanitizeForTerminal(smuggled))).toBe(false);
  });

  // The carve-out. These are ordinary title content, and the whitelist is what
  // keeps the tag strip from mangling them.
  it('keeps the RGI subdivision flags byte-identical', () => {
    expect(sanitizeForTerminal(FLAG_SCOTLAND)).toBe(FLAG_SCOTLAND);
    expect(sanitizeForTerminal(`Postgres on ${FLAG_WALES} tour`)).toBe(
      `Postgres on ${FLAG_WALES} tour`,
    );
  });

  it('strips a BOM/ZWNBSP mid-string', () => {
    expect(sanitizeForTerminal('re\ufeffport')).toBe('report');
  });

  // The other half of the not-all-of-Cf line: ZWNJ is orthographically required
  // in Persian and ZWSP hints line breaks in CJK, so both stay.
  it('keeps ZWNJ in Persian and ZWSP between CJK characters', () => {
    const persian = '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645';
    expect(sanitizeForTerminal(persian)).toBe(persian);
    const cjk = '\u65e5\u672c\u8a9e\u200b\u30c6\u30ad\u30b9\u30c8';
    expect(sanitizeForTerminal(cjk)).toBe(cjk);
  });
});

import { describe, it, expect } from 'vitest';
import { emitSuccess, emitFailure, normalizeError } from './output';
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

  it('renders human lines to stderr on a TTY, stdout stays machine-only', () => {
    const cap = captureIo(true);
    emitSuccess(cap.io, 'doctor', { ok: true }, ['all good']);
    expect(cap.stderr()).toContain('all good');
    expect(() => JSON.parse(cap.stdout())).not.toThrow();
  });

  it('suppresses stderr under --json even on a TTY', () => {
    const cap = captureIo(true);
    emitSuccess(cap.io, 'doctor', { ok: true }, ['all good'], { json: true });
    expect(cap.stderr()).toBe('');
    expect(JSON.parse(cap.stdout()).ok).toBe(true);
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

  it('renders error + fix to stderr on a TTY', () => {
    const cap = captureIo(true);
    emitFailure(cap.io, 'x', new CliError('USAGE', 'nope', { fix: 'do this' }));
    expect(cap.stderr()).toContain('nope');
    expect(cap.stderr()).toContain('do this');
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
});

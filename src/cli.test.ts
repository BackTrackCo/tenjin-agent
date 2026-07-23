import { describe, it, expect } from 'vitest';
import { main } from './cli';
import type { Io } from './lib/output';

function captureIo(isTTY = false) {
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

// This file covers the DISPATCHER only — argument routing, the one-JSON-object
// contract, global-flag handling, and exit-code classes. It never invokes a
// feature command body (doctor/config/wallet, implemented separately): those do
// real I/O (network, filesystem, stdin), so every case here is driven to a
// deterministic, offline dispatcher-level outcome instead of a command result.
describe('main', () => {
  it('unknown command exits 2 with exactly one JSON error object', async () => {
    const cap = captureIo();
    const code = await main(['bogus'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('USAGE');
    // Not a TTY: no human decoration leaks to stderr.
    expect(cap.stderr()).toBe('');
  });

  it('bare invocation exits 2 with the usage contract', async () => {
    const cap = captureIo();
    const code = await main([], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });

  // The output contract at the dispatcher level, driven by a command's offline
  // validation throw (`config set <unknown-key>` fails before any I/O).
  describe('output contract (human-first at a TTY)', () => {
    const bad = ['config', 'set', 'no-such-key', 'x'];

    it('at a TTY without --json, prints the human error to stdout and no envelope', async () => {
      const cap = captureIo(true);
      const code = await main(bad, cap.io);
      expect(code).toBe(2);
      expect(cap.stdout()).toContain('error:');
      expect(cap.stdout()).not.toContain('schemaVersion'); // no JSON envelope
      expect(cap.stderr()).toBe('');
    });

    it('when stdout is piped (not a TTY), prints the JSON envelope', async () => {
      const cap = captureIo(false);
      await main(bad, cap.io);
      expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
    });

    it('--json forces the envelope even at a TTY', async () => {
      const cap = captureIo(true);
      await main(['--json', ...bad], cap.io);
      expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
    });
  });

  // Same contract, but for a commander PARSE error (unknown command) rather than a
  // command's own validation throw. Here commander writes the usage text to stderr,
  // so human mode leaves stdout empty (no envelope, no duplicate) instead of
  // painting an error line to stdout — the inverse surface from the block above.
  describe('output contract (human-first for a parse error)', () => {
    it('unknown command at a TTY: usage on stderr, stdout empty (no envelope)', async () => {
      const cap = captureIo(true);
      const code = await main(['bogus'], cap.io);
      expect(code).toBe(2);
      expect(cap.stdout()).toBe(''); // no JSON envelope, no second human line
      expect(cap.stderr()).not.toBe(''); // commander's usage text stands alone
    });

    it('unknown command when piped: JSON envelope on stdout, stderr empty', async () => {
      const cap = captureIo(false);
      const code = await main(['bogus'], cap.io);
      expect(code).toBe(2);
      expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
      expect(cap.stderr()).toBe('');
    });
  });

  it('--version prints the version and exits 0', async () => {
    const cap = captureIo();
    const code = await main(['--version'], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('an invalid --timeout is a USAGE failure (exit 2)', async () => {
    const cap = captureIo();
    const code = await main(['--timeout', 'abc', 'doctor'], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });

  it('--json suppresses stderr on a TTY for a failing command', async () => {
    const cap = captureIo(true);
    // Deterministic offline failure (unknown command → USAGE), so this exercises
    // --json-on-TTY suppression without invoking any command body.
    const code = await main(['--json', 'bogus'], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr()).toBe('');
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });
});

// Global flags (--json / --base-url / --timeout) must parse in ANY position, not
// just before the subcommand (git-style). Each case drives a real leaf command to
// a dispatcher-level USAGE failure (a bad trailing --timeout, rejected before the
// body runs), which proves the leaf ACCEPTED the trailing flags: the envelope's
// `command` is the leaf itself, not the 'tenjin' parse-error envelope an unknown
// option would produce — with no network, filesystem, or command-body behavior.
describe('global flags are position-independent', () => {
  it('trailing --base-url and --timeout are accepted on the leaf (routes to the command)', async () => {
    const cap = captureIo();
    const code = await main(
      ['doctor', '--base-url', 'https://x.example', '--timeout', 'abc'],
      cap.io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.error.code).toBe('USAGE');
    // Unknown options would bail as a parse error with command 'tenjin'; routing to
    // 'doctor' proves both trailing flags were consumed by the leaf.
    expect(parsed.command).toBe('doctor');
  });

  it('trailing globals also work on a depth-2 subcommand (wallet show)', async () => {
    const cap = captureIo();
    const code = await main(['wallet', 'show', '--timeout', 'abc'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.error.code).toBe('USAGE');
    expect(parsed.command).toBe('wallet.show');
  });

  it('trailing --json suppresses stderr on a TTY, exactly like leading --json', async () => {
    const lead = captureIo(true);
    await main(['--json', 'doctor', '--timeout', 'abc'], lead.io);
    const trail = captureIo(true);
    await main(['doctor', '--timeout', 'abc', '--json'], trail.io);
    // --json is honored in either position: no stderr decoration on a TTY, and the
    // same USAGE envelope routed to 'doctor'.
    expect(lead.stderr()).toBe('');
    expect(trail.stderr()).toBe('');
    for (const cap of [lead, trail]) {
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('doctor');
      expect(parsed.error.code).toBe('USAGE');
    }
  });
});

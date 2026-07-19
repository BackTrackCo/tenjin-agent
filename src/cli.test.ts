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

  // Each B2 leaf is driven to the same dispatcher-level USAGE failure (bad
  // trailing --timeout, rejected in buildContext before the lazy body import),
  // so the envelope's `command` field proves the argv routed to that leaf
  // without any command body, network, or filesystem running.
  it.each([
    { argv: ['lookup', 'what does base gas cost?', '--timeout', 'abc'], command: 'lookup' },
    { argv: ['inspect', 'alice/base-fees', '--timeout', 'abc'], command: 'inspect' },
    { argv: ['buy', 'alice/base-fees', '--timeout', 'abc'], command: 'buy' },
    { argv: ['outcome', '--status', 'used', '--timeout', 'abc'], command: 'outcome' },
  ])(
    '$command routes to its leaf and fails USAGE on a bad trailing --timeout',
    async ({ argv, command }) => {
      const cap = captureIo();
      const code = await main(argv, cap.io);
      expect(code).toBe(2);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('USAGE');
      expect(parsed.command).toBe(command);
    },
  );

  it('outcome without --status is a USAGE parse error (required option)', async () => {
    const cap = captureIo();
    const code = await main(['outcome', '--last'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('USAGE');
    // A missing required option fires during commander parsing, before any leaf
    // action runs, so the envelope carries the parse-error command 'tenjin'.
    expect(parsed.command).toBe('tenjin');
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

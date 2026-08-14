import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeNudgeUpdate, resolveTarget } from './update-check';
import { updateCheckPath } from './paths';
import type { Io } from './output';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-update-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

/** A registry stub that counts calls, so "did not fetch" is assertable. */
function registry(tags: Record<string, string>) {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(tags), { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}

/** Fetch that must never run: every skip case asserts through this. */
const forbiddenFetch: typeof fetch = async () => {
  throw new Error('the update check must not reach the network here');
};

/** The cache as it sits on disk, for asserting what a run recorded. */
async function readCache(): Promise<unknown> {
  return JSON.parse(await readFile(updateCheckPath(dir), 'utf8'));
}

/** Seed the per-tag map; callers pass only the tags a case cares about. */
async function seedCache(tags: Record<string, unknown>): Promise<void> {
  await writeFile(updateCheckPath(dir), JSON.stringify({ schemaVersion: 1, tags }), {
    mode: 0o600,
  });
}

const NOW = 1_700_000_000_000;

describe('maybeNudgeUpdate', () => {
  it('nudges toward the alpha tag when a prerelease build is behind', async () => {
    const cap = captureIo(true);
    const reg = registry({ latest: '0.1.0-alpha.5', alpha: '0.1.0-alpha.7' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(cap.stderr()).toContain(
      'tenjin-cli 0.1.0-alpha.7 is available (you have 0.1.0-alpha.6)',
    );
    expect(cap.stderr()).toContain('Update: run tenjin update');
    // The command's own surface is untouched: nothing on stdout, ever.
    expect(cap.stdout()).toBe('');
  });

  // Same resolution `tenjin update` uses, so the nudge can never stay quiet
  // about a version the command would install. Live on npm from 2026-08-01:
  // `alpha` froze at alpha.7 while alpha.8 through .11 shipped on `latest`.
  it('nudges toward latest when the channel tag has fallen behind it', async () => {
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.7', latest: '0.1.0-alpha.11' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.10',
    });
    expect(cap.stderr()).toContain('tenjin-cli 0.1.0-alpha.11 is available');
  });

  it('stays quiet for a version it cannot place on a release line', async () => {
    const cap = captureIo(true);
    const reg = registry({ alpha: '9.9.9', latest: '9.9.9' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '1.0.0-rc.1',
    });
    expect(cap.stderr()).toBe('');
    expect(reg.calls()).toBe(0);
  });

  it('nudges toward the plain package on the stable channel', async () => {
    const cap = captureIo(true);
    const reg = registry({ latest: '1.1.0', alpha: '2.0.0-alpha.1' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '1.0.0',
    });
    expect(cap.stderr()).toContain('tenjin-cli 1.1.0 is available (you have 1.0.0)');
    expect(cap.stderr()).toContain('Update: run tenjin update\n');
    expect(cap.stderr()).not.toContain('@alpha');
  });

  it('says nothing when the registry version is the same or older', async () => {
    // A day apart per case, so each one is a real fetch rather than the previous
    // case's cached answer.
    let at = NOW;
    for (const latest of ['0.1.0-alpha.6', '0.1.0-alpha.5', '0.0.9']) {
      at += 86_400_001;
      const cap = captureIo(true);
      await maybeNudgeUpdate({
        dir,
        io: cap.io,
        json: false,
        env: {},
        now: () => at,
        fetchImpl: registry({ alpha: latest }).fetchImpl,
        currentVersion: '0.1.0-alpha.6',
      });
      expect(cap.stderr()).toBe('');
    }
  });

  // A release outranks its own prereleases, so 0.1.0 is news to an alpha.6 user
  // and 0.1.0-alpha.9 is not news to someone already on 0.1.0.
  it('orders a release above its prereleases in both directions', async () => {
    const up = captureIo(true);
    await maybeNudgeUpdate({
      dir,
      io: up.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: registry({ alpha: '0.1.0' }).fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(up.stderr()).toContain('tenjin-cli 0.1.0 is available');

    const down = captureIo(true);
    await maybeNudgeUpdate({
      dir,
      io: down.io,
      json: false,
      env: {},
      now: () => NOW + 1,
      fetchImpl: registry({ latest: '0.1.0-alpha.9' }).fetchImpl,
      currentVersion: '0.1.0',
    });
    expect(down.stderr()).toBe('');
  });

  // The registry is untrusted input. A version this package could never have
  // published is not compared, not sanitized into something printable, not shown.
  it('refuses a version string it cannot parse, including one carrying escapes', async () => {
    let at = NOW;
    for (const latest of ['not-a-version', '9.9.9-beta.1', '\u001b[2K9.9.9']) {
      at += 86_400_001; // a day apart, so each case fetches rather than reads
      const cap = captureIo(true);
      await maybeNudgeUpdate({
        dir,
        io: cap.io,
        json: false,
        env: {},
        now: () => at,
        fetchImpl: registry({ alpha: latest }).fetchImpl,
        currentVersion: '0.1.0-alpha.6',
      });
      expect(cap.stderr()).toBe('');
    }
  });

  it('caches the answer 0600 and asks nobody again for 24h', async () => {
    const first = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.7' });
    const deps = {
      dir,
      json: false,
      env: {},
      currentVersion: '0.1.0-alpha.6',
    };
    await maybeNudgeUpdate({ ...deps, io: first.io, now: () => NOW, fetchImpl: reg.fetchImpl });
    expect(reg.calls()).toBe(1);
    expect(first.stderr()).toContain('0.1.0-alpha.7 is available');

    // The nudge it just printed is recorded, not only the fetch it just made.
    expect(await readCache()).toEqual({
      schemaVersion: 1,
      tags: { alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7', notifiedAtMs: NOW } },
    });
    if (process.platform !== 'win32') {
      expect((await stat(updateCheckPath(dir))).mode & 0o777).toBe(0o600);
    }

    // Once a day is once a day: the next command inside the window neither asks
    // npm again nor repeats the line the human has already read.
    const second = captureIo(true);
    await maybeNudgeUpdate({
      ...deps,
      io: second.io,
      now: () => NOW + 86_399_000,
      fetchImpl: forbiddenFetch,
    });
    expect(second.stderr()).toBe('');
  });

  // A cache fresh enough to skip the fetch is not a reason to skip the nudge:
  // this is the first time this entry has been shown to anyone.
  it('nudges from a never-notified cache without fetching, and records it', async () => {
    await seedCache({ alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7' } });
    const cap = captureIo(true);
    const at = NOW + 60_000;
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => at,
      fetchImpl: forbiddenFetch,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(cap.stderr()).toContain('0.1.0-alpha.7 is available');
    // checkedAtMs untouched — nothing was asked — but the nudge is now on record.
    expect(await readCache()).toEqual({
      schemaVersion: 1,
      tags: { alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7', notifiedAtMs: at } },
    });
  });

  it('nudges again once a day has passed since the last one', async () => {
    await seedCache({
      alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7', notifiedAtMs: NOW },
    });
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.7' });
    const at = NOW + 86_400_001;
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => at,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(cap.stderr()).toContain('0.1.0-alpha.7 is available');
    expect(await readCache()).toMatchObject({
      tags: { alpha: { checkedAtMs: at, notifiedAtMs: at } },
    });
  });

  // The nudge clock and the fetch clock are separate: asking npm again does not
  // buy the right to interrupt the human again.
  it('does not repeat the nudge just because the cache went stale', async () => {
    await seedCache({
      alpha: {
        checkedAtMs: NOW - 86_400_001, // due for a re-fetch
        latest: '0.1.0-alpha.7',
        notifiedAtMs: NOW - 1000, // but nudged a second ago
      },
    });
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.8' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(reg.calls()).toBe(1); // it still refreshed what it knows
    expect(cap.stderr()).toBe('');
    // and carried the nudge clock forward rather than restarting it
    expect(await readCache()).toMatchObject({
      tags: { alpha: { checkedAtMs: NOW, notifiedAtMs: NOW - 1000 } },
    });
  });

  // One machine, two binaries, one data dir: the alpha build's answer must not
  // be handed to the stable build, whose install command cannot reach it.
  it('ignores the other channel entry, and leaves it intact for its own binary', async () => {
    await seedCache({
      alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7', notifiedAtMs: NOW },
    });
    const reg = registry({ latest: '1.1.0', alpha: '0.1.0-alpha.7' });
    const shared = { dir, json: false, env: {}, fetchImpl: reg.fetchImpl };

    // The stable binary cannot use the alpha entry: an `@alpha` version is not
    // something its install command can reach.
    const stable = captureIo(true);
    await maybeNudgeUpdate({
      ...shared,
      io: stable.io,
      now: () => NOW + 1000,
      currentVersion: '1.0.0',
    });
    expect(reg.calls()).toBe(1);
    expect(stable.stderr()).toContain('tenjin-cli 1.1.0 is available');
    expect(stable.stderr()).not.toContain('@alpha');

    // Both records now coexist: writing the stable one did not evict the alpha
    // one, which is what used to make the round trip re-notify.
    expect(await readCache()).toEqual({
      schemaVersion: 1,
      tags: {
        alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7', notifiedAtMs: NOW },
        latest: { checkedAtMs: NOW + 1000, latest: '1.1.0', notifiedAtMs: NOW + 1000 },
      },
    });

    // So the alpha binary coming back a second later is still inside its own
    // window: nothing to ask npm, nothing to say. A WORKING registry stub here,
    // not a forbidden one — a swallowed throw would look identical to silence.
    const alphaAgain = captureIo(true);
    const reg2 = registry({ latest: '1.1.0', alpha: '0.1.0-alpha.7' });
    await maybeNudgeUpdate({
      ...shared,
      io: alphaAgain.io,
      now: () => NOW + 2000,
      fetchImpl: reg2.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(reg2.calls()).toBe(0);
    expect(alphaAgain.stderr()).toBe('');
  });

  it('re-fetches once the cache is older than 24h', async () => {
    await seedCache({ alpha: { checkedAtMs: NOW, latest: '0.1.0-alpha.7' } });
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.8' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW + 86_400_001,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(reg.calls()).toBe(1);
    expect(cap.stderr()).toContain('0.1.0-alpha.8 is available');
  });

  it('treats an unreadable cache as no cache (it is only a cache)', async () => {
    await writeFile(updateCheckPath(dir), 'not json {{{', { mode: 0o600 });
    const cap = captureIo(true);
    const reg = registry({ alpha: '0.1.0-alpha.7' });
    await maybeNudgeUpdate({
      dir,
      io: cap.io,
      json: false,
      env: {},
      now: () => NOW,
      fetchImpl: reg.fetchImpl,
      currentVersion: '0.1.0-alpha.6',
    });
    expect(reg.calls()).toBe(1);
    expect(cap.stderr()).toContain('0.1.0-alpha.7 is available');
  });

  // Every failure mode of the check is the same failure mode: nothing happens,
  // nothing is cached, and the command that just ran is unaffected.
  it('swallows a rejected fetch, a non-200, and a body that is not dist-tags', async () => {
    const failures: (typeof fetch)[] = [
      async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
      async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
      },
      async () => new Response('', { status: 503 }),
      async () => new Response('<html>', { status: 200 }),
      async () => new Response(JSON.stringify({ alpha: 7 }), { status: 200 }),
      // Answered, but with nothing on either tag this build follows.
      async () => new Response(JSON.stringify({ next: 'nonsense' }), { status: 200 }),
    ];
    for (const fetchImpl of failures) {
      const cap = captureIo(true);
      await expect(
        maybeNudgeUpdate({
          dir,
          io: cap.io,
          json: false,
          env: {},
          now: () => NOW,
          fetchImpl,
          currentVersion: '0.1.0-alpha.6',
        }),
      ).resolves.toBeUndefined();
      expect(cap.stderr()).toBe('');
      expect(cap.stdout()).toBe('');
      await expect(readFile(updateCheckPath(dir), 'utf8')).rejects.toThrow();
    }
  });

  it('is skipped entirely off a TTY, under --json, and in CI', async () => {
    const cases: { isTTY: boolean; json: boolean; env: NodeJS.ProcessEnv }[] = [
      { isTTY: false, json: false, env: {} },
      { isTTY: true, json: true, env: {} },
      { isTTY: true, json: false, env: { CI: 'true' } },
    ];
    for (const c of cases) {
      const cap = captureIo(c.isTTY);
      await maybeNudgeUpdate({
        dir,
        io: cap.io,
        json: c.json,
        env: c.env,
        now: () => NOW,
        fetchImpl: forbiddenFetch,
        currentVersion: '0.1.0-alpha.6',
      });
      expect(cap.stderr()).toBe('');
      expect(cap.stdout()).toBe('');
    }
  });
});

describe('resolveTarget', () => {
  it('takes the newest across the channel tag and latest', () => {
    expect(
      resolveTarget('0.1.0-alpha.10', { alpha: '0.1.0-alpha.7', latest: '0.1.0-alpha.11' }),
    ).toBe('0.1.0-alpha.11');
  });

  it('reads only latest for a release build', () => {
    expect(resolveTarget('1.0.0', { alpha: '2.0.0-alpha.1', latest: '1.1.0' })).toBe('1.1.0');
  });

  // Load-bearing, and nothing else catches it. Iteration order is
  // [channel, 'latest'], so a channel tag holding a value VERSION_RE cannot
  // parse would seed `best` with that junk, and every later isNewer comparison
  // loses against an unparseable side. The caller's isNewer(target, current)
  // then returns false and the user is told "up to date" indefinitely: round
  // one's failure mode through a different door, reachable the first time this
  // project publishes something the regex does not admit.
  it('skips an unparseable candidate instead of letting it win', () => {
    expect(
      resolveTarget('0.1.0-alpha.11', { alpha: 'not-a-version', latest: '0.1.0-alpha.12' }),
    ).toBe('0.1.0-alpha.12');
  });

  it('is null when neither tag carries anything parseable', () => {
    expect(resolveTarget('0.1.0-alpha.11', { alpha: 'nope', latest: '0.2.0-beta.1' })).toBeNull();
  });

  it('is null for a version with no channel', () => {
    expect(resolveTarget('1.0.0-rc.1', { latest: '2.0.0' })).toBeNull();
  });
});

import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  envDeniedRoots,
  envPieces,
  MAX_ENV_FILE_BYTES,
  parseEnvFile,
  secretLike,
  WorkerEnvSecrets,
} from './worker-env-secrets';

// The folders a walk lists, so a test can hold one listing and tell one walk from two.
const walks = vi.hoisted(() => ({
  listed: [] as string[],
  /** The folders whose listing has been handed back. */
  done: [] as string[],
  hold: undefined as Promise<void> | undefined,
  /** With `hold`, only a listing of this folder waits. */
  holdOnly: undefined as string | undefined,
  /** The paths a stat or lstat asked for; one of them waits on `statHold`. */
  stated: [] as string[],
  statHold: undefined as { path: string; until: Promise<void> } | undefined,
  /** What a stat or lstat of a path says instead, as a file system that keeps fewer times would. */
  seen: new Map<string, (real: import('node:fs').Stats) => import('node:fs').Stats | Error>(),
}));
// The mount table the module reads to learn each folder's file system (macOS).
const mounts = vi.hoisted(() => ({ table: undefined as string | undefined }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: ((file: string, args: string[], done: (error: Error | null, out: string) => void) => {
      if (file === '/sbin/mount' && mounts.table !== undefined) return done(null, mounts.table);
      return actual.execFile(file, args, done as never);
    }) as unknown as typeof actual.execFile,
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (path: string, ...rest: unknown[]) => {
      walks.listed.push(String(path));
      if (!walks.holdOnly || walks.holdOnly === String(path)) await walks.hold;
      const entries = await (actual.readdir as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      walks.done.push(String(path));
      return entries;
    }) as typeof actual.readdir,
    ...Object.fromEntries(
      (['stat', 'lstat'] as const).map((name) => [
        name,
        async (path: string, ...rest: unknown[]) => {
          walks.stated.push(String(path));
          if (walks.statHold?.path === String(path)) await walks.statHold.until;
          const real = await (
            actual[name] as (...args: unknown[]) => Promise<import('node:fs').Stats>
          )(path, ...rest);
          const seen = walks.seen.get(String(path))?.(real) ?? real;
          if (seen instanceof Error) throw seen;
          return seen;
        },
      ]),
    ),
  };
});

// The watchers the module makes, so a test can hold back their events or send one of its own.
const watches = vi.hoisted(() => ({
  made: [] as { watcher: import('node:fs').FSWatcher; send: (name: string | null) => void }[],
  mute: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: ((
      path: string,
      options: object,
      listener: (event: string, name: string | null) => void,
    ) => {
      const watcher = actual.watch(path, options, (event, name) => {
        if (!watches.mute) listener(event, name as string | null);
      });
      watches.made.push({ watcher, send: (name) => listener('rename', name) });
      return watcher;
    }) as unknown as typeof actual.watch,
  };
});

let dir: string | undefined;
afterEach(async () => {
  // A test that failed while holding a listing must not hold the next one's.
  walks.hold = undefined;
  walks.holdOnly = undefined;
  walks.statHold = undefined;
  walks.seen.clear();
  mounts.table = undefined;
  vi.useRealTimers();
  WorkerEnvSecrets.forgetScans();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});
async function workspace(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'worker-env-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

it('parses env files by dotenv rules, including old commented-out values', () => {
  expect(
    parseEnvFile(
      [
        '# local settings',
        'export API_KEY=sk_live_51Hx9QaZ # rotated monthly',
        "SINGLE='a b # not a comment'",
        'DOUBLE="line one\\nline two"',
        'PEM="-----BEGIN KEY-----',
        'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
        '-----END KEY-----"',
        'COLON: value-with-colon',
        '# OLD_PASSWORD=Retired-P4ssw0rd!',
        'EMPTY=',
      ].join('\r\n'),
    ),
  ).toEqual([
    { key: 'API_KEY', value: 'sk_live_51Hx9QaZ', written: 'sk_live_51Hx9QaZ' },
    { key: 'SINGLE', value: 'a b # not a comment', written: 'a b # not a comment' },
    { key: 'DOUBLE', value: 'line one\nline two', written: 'line one\\nline two' },
    {
      key: 'PEM',
      value:
        '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END KEY-----',
      written:
        '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END KEY-----',
    },
    { key: 'COLON', value: 'value-with-colon', written: 'value-with-colon' },
    { key: 'OLD_PASSWORD', value: 'Retired-P4ssw0rd!', written: 'Retired-P4ssw0rd!' },
    { key: 'EMPTY', value: '', written: '' },
  ]);
});

it('recognizes malformed or unsupported dotenv syntax', () => {
  expect(parseEnvFile('use flake\nsecret-without-a-key-0x9f\n')).toBeUndefined();
  expect(parseEnvFile('KEY="never closed\nmore')).toBeUndefined();
  expect(parseEnvFile('KEY=a\0b')).toBeUndefined();
});

it('leaves short and common values alone, and treats URLs with credentials as secrets whole', () => {
  for (const plain of [
    'true',
    '3000',
    'development',
    'localhost',
    'production-eu',
    '127.0.0.1',
    'http://localhost:3000',
    'https://api.example.com/v1?page=2',
  ])
    expect(secretLike(plain), plain).toBe(plain === '127.0.0.1');
  for (const secret of [
    'hunter2!x',
    'correcthorsebatterystaple',
    'postgres://app:pw@db/app',
    'https://hooks.example.com/services/T0/B0/aB3dE6gH9jK2mN5pQ8sT1vW4',
  ])
    expect(secretLike(secret), secret).toBe(true);
});

it('replaces each value by its name, in the forms a command prints it, longest first', async () => {
  const password = 'p@ss:W0rd/with spaces';
  const url = `postgres://app:${encodeURIComponent(password)}@db.internal:5432/app`;
  const root = await workspace({
    '.env.local': [
      `DATABASE_URL="${url}"`,
      `DB_PASSWORD="${password}"`,
      'TOKEN=tok_9aZ3kQ7mV2xW',
      'PEM="-----BEGIN KEY-----\\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLI\\nnFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\\n-----END KEY-----"',
      'NODE_ENV=development',
    ].join('\n'),
    'apps/web/.env': 'NESTED_SECRET=nested-0x5f3759df',
    'node_modules/pkg/.env': 'VENDOR_SECRET=vendor-0x1badb002',
  });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  expect(env.scanned).toBe(true);
  const said = env.redact(
    [
      `url ${url}`,
      `pw ${password} again ${encodeURIComponent(password)}`,
      `b64 ${Buffer.from('tok_9aZ3kQ7mV2xW').toString('base64')}`,
      // Part of a multi-line value, as `head -2` prints the file.
      'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLI',
      `json ${JSON.stringify('-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLI')}`,
      'nested-0x5f3759df vendor-0x1badb002 in development',
    ].join('\n'),
  );
  expect(said).toBe(
    [
      'url [env:DATABASE_URL]',
      'pw [env:DB_PASSWORD] again [env:DB_PASSWORD]',
      'b64 [env:TOKEN]',
      '[env:PEM]',
      'json "-----BEGIN KEY-----\\n[env:PEM]"',
      // node_modules is not scanned: packages ship public examples.
      '[env:NESTED_SECRET] vendor-0x1badb002 in development',
    ].join('\n'),
  );
  expect(env.redact('nothing here')).toBe('nothing here');
});

it('withholds shell-form env files at startup while covering valid neighboring files', async () => {
  const root = await workspace({
    '.envrc': 'export WORKER_TEST_VALUE=fixture-value-0x10\nexport PATH\n',
    '.env.local': 'OTHER=other-value-0x11',
  });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  expect(env.scanned).toBe(true);
  expect(env.withheld).toEqual([join(root, '.envrc')]);
  expect(env.uncovered.size).toBe(0);
  expect(env.redact('other-value-0x11')).toBe('[env:OTHER]');
});

it('rejects a warmed worker when an env file needs a new deny and marks it uncovered during a run', async () => {
  const root = await workspace({ '.envrc': 'export OLD=previous-value-0x12' });
  const path = join(root, '.envrc');
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  await writeFile(path, 'export NEXT=next-value-0x13\nexport PATH\n');

  expect(await env.refreshBeforeAssignment()).toBe(false);
  await env.refresh();
  expect([...env.uncovered]).toEqual([path]);
  expect(env.redact('previous-value-0x12')).toBe('[env:OLD]');

  await writeFile(path, 'export NEXT=next-value-0x13');
  await env.refresh();
  expect(env.uncovered.size).toBe(0);
  expect(env.redact('previous-value-0x12 next-value-0x13')).toBe('[env:OLD] [env:NEXT]');
});

// Where the OS watches a tree (macOS, Windows): elsewhere a later worker always scans first.
const WATCHES = process.platform === 'darwin' || process.platform === 'win32';
// Where a check stats every folder and trusts no file event (`relist`).
const MACOS = process.platform === 'darwin';

// Measured 2026-11-18: every worker waited 4.4 to 4.5 s for its own walk of 85 worktrees
// before its Claude Code could start.
it.runIf(WATCHES)(
  'starts a later worker from the kept scan of the same roots at once, and its own scan adds what changed since',
  async () => {
    const root = await workspace({ '.env': 'FIRST=first-value-0x21' });
    const first = await WorkerEnvSecrets.start([root], { keep: true, watch: false });
    first.close();
    // Changed after the first scan: the kept scan does not know it.
    await writeFile(join(root, '.env.local'), 'LATER=later-value-0x22');
    const temp = join(root, '..', 'job-temp-unused');
    const resumed = WorkerEnvSecrets.resume([root], [temp])!;
    try {
      // At once, with no walk: what the kept scan found, and the same denies.
      expect(resumed.env.scanned).toBe(true);
      expect(resumed.env.redact('first-value-0x21')).toBe('[env:FIRST]');
      expect(resumed.env.withheld).toEqual([]);
      // Its own full scan is what releases it, and it brings the newer value.
      expect(await resumed.verified).toBe(true);
      expect(resumed.env.redact('first-value-0x21 later-value-0x22')).toBe(
        '[env:FIRST] [env:LATER]',
      );
      // What this job learned never reaches the kept scan's first copy.
      expect(first.redact('later-value-0x22')).toBe('later-value-0x22');
    } finally {
      resumed.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it.runIf(WATCHES)(
  'refuses to release a worker started from a kept scan when a file now needs a deny it did not start with',
  async () => {
    const root = await workspace({ '.env': 'FIRST=first-value-0x21' });
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    await writeFile(join(root, '.envrc'), 'export PATH\n');
    const resumed = WorkerEnvSecrets.resume([root])!;
    try {
      expect(resumed.env.withheld).toEqual([]);
      expect(await resumed.verified).toBe(false);
      // The newer scan is the kept one now: the next start has the deny from its first moment.
      const next = WorkerEnvSecrets.resume([root])!;
      expect(next.env.withheld).toEqual([join(root, '.envrc')]);
      expect(await next.verified).toBe(true);
      next.env.close();
    } finally {
      resumed.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it('keeps no scan that stopped short, was not asked for, or is of other roots', async () => {
  const root = await workspace({ '.env': 'FIRST=first-value-0x21', 'a/b/.env': 'B=bbbbbbbb-0x23' });
  try {
    (await WorkerEnvSecrets.start([root], { watch: false })).close();
    expect(WorkerEnvSecrets.resume([root])).toBeUndefined();
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false, maxDirectories: 1 })).close();
    expect(WorkerEnvSecrets.resume([root])).toBeUndefined();
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    expect(WorkerEnvSecrets.resume([join(root, 'a')])).toBeUndefined();
    const held = WorkerEnvSecrets.resume([root]);
    // Without a watcher a file made between the two scans would be missed: always a full scan.
    expect(held === undefined).toBe(!WATCHES);
    held?.env.close();
    await held?.verified;
  } finally {
    WorkerEnvSecrets.forgetScans();
  }
});

it('keeps env files denied when the scan stops short, and outside the working directories', async () => {
  const root = await workspace({ 'a/.env': 'A_SECRET=never-reached-0x1' });
  const env = await WorkerEnvSecrets.start([root], { maxDirectories: 1, watch: false });
  expect(env.scanned).toBe(false);
  expect(envDeniedRoots(['/w', '/w/x', '/read'], ['/w'], false)).toEqual(['/w', '/w/x', '/read']);
  expect(envDeniedRoots(['/w', '/w/x', '/read', '/wide'], ['/w'], true)).toEqual([
    '/read',
    '/wide',
  ]);
});

it('picks up a changed or new env file before the next check, and keeps old values replaced', async () => {
  const root = await workspace({ 'apps/api/.env': 'FIRST=first-value-0x01' });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  await writeFile(join(root, 'apps/api/.env'), 'SECOND=second-value-0x02');
  await writeFile(join(root, '.env.local'), 'PULLED=pulled-value-0x03');
  await env.refresh();
  expect(env.redact('first-value-0x01 second-value-0x02 pulled-value-0x03')).toBe(
    '[env:FIRST] [env:SECOND] [env:PULLED]',
  );
  // A file read by name is loaded first, wherever it sits in a working directory.
  await mkdir(join(root, 'deep/new'), { recursive: true });
  await writeFile(join(root, 'deep/new/.env.test'), 'DEEP=deep-value-0x04');
  await env.add(join(root, 'deep/new/.env.test'));
  await env.add('/etc/.env.outside');
  expect(env.redact('deep-value-0x04')).toBe('[env:DEEP]');
});

it.runIf(MACOS)(
  'runs one check for a model request that follows a tool result at once, and it sees the files made before the request',
  async () => {
    // Operator item of 2026-11-18. A worker's tool result starts a check, and its next
    // model request, a few milliseconds later, queued a second one behind it: two passes
    // over the folders in a row before every request that followed a tool.
    const root = await trialRoot('join');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    const checks = vi.spyOn(env as unknown as { check: () => Promise<void> }, 'check');
    let release!: () => void;
    try {
      // The check's pass has stat'ed the root and waits on one folder.
      walks.statHold = {
        path: join(root, 'pkg', 'lib'),
        until: new Promise<void>((done) => (release = done)),
      };
      const afterToolResult = env.refresh();
      await vi.waitFor(() => expect(walks.stated).toContain(join(root, 'pkg', 'lib')), {
        timeout: 10_000,
      });
      // Written by the tool that just ran, in a folder the pass did not see.
      mkdirSync(join(root, 'made/now'), { recursive: true });
      writeFileSync(join(root, 'made/now/.env.local'), 'LATE=late-value-0x02');
      const request = env.refresh();
      release();
      await request;
      expect(env.redact('late-value-0x02')).toBe('[env:LATE]');
      await afterToolResult;
      expect(checks).toHaveBeenCalledTimes(1);
      // A call made once a check has begun to read still gets a check of its own.
      await env.refresh();
      expect(checks).toHaveBeenCalledTimes(2);
    } finally {
      release?.();
      env.close();
    }
  },
);

// WHAT NO FILE EVENT CAN PROMISE ON macOS, with real files. libuv rebuilds the one FSEvents
// stream of an event loop whenever any watcher on that loop starts or closes, and drops what it
// had not delivered (measured 2026-11-19: 19 to 29 of 40 such events lost); and a stream drops
// events after a burst of changes, which libuv skips unreported (the event of an env file written
// right after 14,000 new folders: 8 of 8 lost, on a thread of its own). So a macOS check stats
// every folder and lists each changed one. The triggers come at once after the write, as they
// do when a worker starts or ends beside a running one; nothing checked waits on a clock.
const TRIALS = 16;

async function trialRoot(name: string): Promise<string> {
  const root = join(dir ?? (await workspace({})), name);
  await mkdir(join(root, 'plain'), { recursive: true });
  await mkdir(join(root, 'pkg', 'lib'), { recursive: true });
  await writeFile(join(root, '.env'), 'TOP=top-value-0x51');
  return root;
}

/** Writes `path` behind other changes in its root, as a checkout or an install does. */
function writeBehindOthers(root: string, path: string, text: string): void {
  for (let at = 0; at < 20; at++) writeFileSync(join(root, `noise-${at}.txt`), String(at));
  writeFileSync(path, text);
}

const realNow = () => performance.timeOrigin + performance.now();
/**
 * Every folder made so far looks a minute old to a check, so no listing is repeated for being
 * recent and each test proves its own rule (afterEach restores the clock).
 */
function aged(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: realNow() + 60_000 });
}

/** Starts a watcher on this process's own event loop at once, as other code may, and closes it. */
async function otherWatcher(elsewhere: string): Promise<void> {
  const watcher = watch(elsewhere, { recursive: true, persistent: false }, () => undefined);
  await new Promise((done) => setTimeout(done, 5));
  watcher.close();
}

it.runIf(MACOS)(
  'gives two workers that start together a file made in a folder the first had listed, while another watcher of the process starts and closes',
  async () => {
    aged();
    for (let trial = 0; trial < TRIALS; trial++) {
      const root = await trialRoot(`f1-${trial}`);
      const elsewhere = await trialRoot(`f1-elsewhere-${trial}`);
      const value = `late-value-${trial}-0x5a5a5a`;
      (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
      const first = WorkerEnvSecrets.resume([root])!;
      const second = { current: undefined as ReturnType<typeof WorkerEnvSecrets.resume> };
      try {
        // The first worker's walk has listed `plain`, which held no env file.
        expect(await first.verified).toBe(true);
        writeBehindOthers(root, join(root, 'plain', '.env.local'), `LATE=${value}`);
        // At once: the second worker starts, and a watcher elsewhere in the process starts and closes.
        second.current = WorkerEnvSecrets.resume([root])!;
        await otherWatcher(elsewhere);
        expect(await second.current.verified).toBe(true);
        expect(second.current.env.redact(value)).toBe('[env:LATE]');
        await first.env.refresh();
        expect(first.env.redact(value), `trial ${trial}`).toBe('[env:LATE]');
      } finally {
        first.env.close();
        second.current?.env.close();
        WorkerEnvSecrets.forgetScans();
      }
    }
  },
  60_000,
);

it.runIf(MACOS)(
  'gives a running worker a new env file in a folder that held none, while another worker starts and ends beside it, or a watcher elsewhere in the process starts and closes',
  async () => {
    aged();
    for (let trial = 0; trial < TRIALS; trial++) {
      const root = await trialRoot(`f4-${trial}`);
      const other = await trialRoot(`f4-other-${trial}`);
      const env = await WorkerEnvSecrets.start([root]);
      try {
        await env.refresh();
        const [starts, closes, elsewhere] = [0, 1, 2].map((at) => `late-${at}-${trial}-0x6b6b6b`);
        // A worker over other roots starts.
        writeBehindOthers(root, join(root, 'plain', '.env.local'), `A=${starts}`);
        const beside = WorkerEnvSecrets.start([other]);
        await beside;
        await env.refresh();
        // It ends.
        mkdirSync(join(root, 'pkg', 'lib', 'deep'));
        writeBehindOthers(root, join(root, 'pkg', 'lib', 'deep', '.env.test'), `B=${closes}`);
        (await beside).close();
        await env.refresh();
        // Other code of the process starts and closes a watcher of its own.
        writeBehindOthers(root, join(root, 'plain', '.env.other'), `C=${elsewhere}`);
        await otherWatcher(other);
        await env.refresh();
        expect(env.redact(`${starts} ${closes} ${elsewhere}`), `trial ${trial}`).toBe(
          '[env:A] [env:B] [env:C]',
        );
      } finally {
        env.close();
      }
    }
  },
  60_000,
);

it.runIf(MACOS)(
  'gives a running worker an env file written at once after thousands of new folders in its root',
  async () => {
    aged();
    for (let trial = 0; trial < 3; trial++) {
      const root = await trialRoot(`flood-${trial}`);
      const env = await WorkerEnvSecrets.start([root]);
      try {
        await env.refresh();
        // An install or a checkout, then a setup step that writes the env file.
        for (let a = 0; a < 50; a++)
          for (let b = 0; b < 50; b++)
            for (const c of ['c', 'd'])
              mkdirSync(join(root, 'vendor', `a${a}`, `b${b}`, c), { recursive: true });
        mkdirSync(join(root, 'pkg', 'lib', 'setup'));
        writeFileSync(join(root, 'pkg', 'lib', 'setup', '.env.local'), 'SET=set-value-0x9f9f9f');
        await env.refresh();
        expect(env.redact('set-value-0x9f9f9f'), `trial ${trial}`).toBe('[env:SET]');
      } finally {
        env.close();
      }
    }
  },
  60_000,
);

it.runIf(WATCHES)(
  'gives a worker the env files of a folder moved into a listed folder, before its release and during its job',
  async () => {
    const root = await trialRoot('moved');
    const elsewhere = await trialRoot('moved-from');
    if (MACOS) aged();
    const move = async (name: string, value: string) => {
      await mkdir(join(elsewhere, name, 'inner'), { recursive: true });
      await writeFile(
        join(elsewhere, name, 'inner', '.env.local'),
        `${name.toUpperCase()}=${value}`,
      );
      // One event, for the folder, and one change of `pkg`: nothing names the file inside.
      await rename(join(elsewhere, name), join(root, 'pkg', name));
    };
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    // Its walk lists `pkg`, and holds on `plain` while the folder moves in.
    walks.done.length = 0;
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    walks.holdOnly = join(root, 'plain');
    const resumed = WorkerEnvSecrets.resume([root])!;
    try {
      await vi.waitFor(() => expect(walks.done).toContain(join(root, 'pkg')), { timeout: 10_000 });
      await move('conf', 'moved-before-0x7c7c7c');
      release();
      expect(await resumed.verified).toBe(true);
      // Released, and its first check comes before its first send.
      await resumed.env.refresh();
      expect(resumed.env.redact('moved-before-0x7c7c7c')).toBe('[env:CONF]');
      await move('later', 'moved-during-0x7d7d7d');
      await resumed.env.refresh();
      expect(resumed.env.redact('moved-during-0x7d7d7d')).toBe('[env:LATER]');
    } finally {
      resumed.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

// WHERE A WATCHER IS TRUSTED (Windows): it says when it lost changes, and it can fail. Run here
// on macOS's own watcher with its real events held back, since macOS drops some, and each
// event the test needs sent by hand.
it.runIf(WATCHES)(
  'lists a folder a watcher names, walks every root when it lost changes, and re-lists once it fails',
  async () => {
    const root = await trialRoot('events');
    const elsewhere = await trialRoot('events-from');
    const env = await WorkerEnvSecrets.start([root], { learning: 'events' });
    const watcher = watches.made.at(-1)!;
    watches.mute = true;
    try {
      await env.refresh();
      expect(env.watching).toBe(true);
      // A folder moved in: only its own name is reported.
      await mkdir(join(elsewhere, 'conf'));
      await writeFile(join(elsewhere, 'conf', '.env.local'), 'MOVED=moved-value-0x8a8a8a');
      await rename(join(elsewhere, 'conf'), join(root, 'pkg', 'conf'));
      watcher.send(join('pkg', 'conf'));
      await env.refresh();
      expect(env.redact('moved-value-0x8a8a8a')).toBe('[env:MOVED]');
      // The system lost count: no event names this file, and the next check walks every root.
      mkdirSync(join(root, 'pkg', 'lib', 'lost'));
      writeFileSync(join(root, 'pkg', 'lib', 'lost', '.env.local'), 'LOST=lost-value-0x8b8b8b');
      watcher.send(null);
      await env.refresh();
      expect(env.redact('lost-value-0x8b8b8b')).toBe('[env:LOST]');
      // It fails: it no longer counts as watching, so the accept walks again, and each check
      // re-lists every folder.
      watcher.watcher.emit('error', new Error('EPERM'));
      expect(env.watching).toBe(false);
      mkdirSync(join(root, 'plain', 'after'));
      writeFileSync(join(root, 'plain', 'after', '.env.local'), 'AFTER=after-value-0x8e8e8e');
      await env.refresh();
      expect(env.redact('after-value-0x8e8e8e')).toBe('[env:AFTER]');
    } finally {
      watches.mute = false;
      env.close();
    }
  },
);

it.runIf(MACOS)(
  'releases a worker only once its own walk listed every root, and lets a send go only once each changed folder is listed again',
  async () => {
    const root = await trialRoot('release');
    aged();
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    walks.holdOnly = join(root, 'plain');
    const resumed = WorkerEnvSecrets.resume([root])!;
    try {
      let verified: boolean | undefined;
      void resumed.verified.then((value) => (verified = value));
      await vi.waitFor(() => expect(walks.listed).toContain(join(root, 'plain')), {
        timeout: 10_000,
      });
      // Held for longer than any walk of this root takes: still not released.
      await new Promise((done) => setTimeout(done, 300));
      expect(verified).toBeUndefined();
      release();
      expect(await resumed.verified).toBe(true);
      // During the job a file appears in `plain`, which held none: its check lists `plain`
      // again, and does not end before that listing.
      walks.hold = new Promise<void>((done) => (release = done));
      writeFileSync(join(root, 'plain', '.env.local'), 'HELD=held-value-0x9a9a9a');
      walks.listed.length = 0;
      let checked = false;
      const check = resumed.env.refresh().then(() => (checked = true));
      await vi.waitFor(() => expect(walks.listed).toContain(join(root, 'plain')), {
        timeout: 10_000,
      });
      await new Promise((done) => setTimeout(done, 300));
      expect(checked).toBe(false);
      release();
      await check;
      expect(resumed.env.redact('held-value-0x9a9a9a')).toBe('[env:HELD]');
    } finally {
      release();
      resumed.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it.runIf(MACOS)(
  'lists again a folder whose own change time moved, and one that changed just before its last listing',
  async () => {
    const root = await trialRoot('racy');
    // Listed a minute after its last change: only a new change makes a check list it again.
    vi.useFakeTimers({ toFake: ['Date'], now: realNow() + 60_000 });
    const env = await WorkerEnvSecrets.start([root]);
    try {
      walks.listed.length = 0;
      await env.refresh();
      expect(walks.listed).not.toContain(join(root, 'plain'));
      writeFileSync(join(root, 'plain', '.env.local'), 'NEW=new-value-0x7e7e7e');
      await env.refresh();
      expect(walks.listed).toContain(join(root, 'plain'));
      expect(env.redact('new-value-0x7e7e7e')).toBe('[env:NEW]');
      // Listed within moments of a change: a later change may carry the same time on a coarse
      // clock, so the next check lists it again, changed or not.
      vi.setSystemTime(realNow());
      writeFileSync(join(root, 'pkg', 'note.txt'), 'x');
      await env.refresh();
      walks.listed.length = 0;
      await env.refresh();
      expect(walks.listed).toContain(join(root, 'pkg'));
    } finally {
      vi.useRealTimers();
      env.close();
    }
  },
);
it('reads again a known env file rewritten in place with its old size and modification time', async () => {
  const root = await workspace({ '.env': 'KEY=first-value-0xaaaaaa' });
  aged();
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  // As `cp -p` from a file of the same size and time leaves it: only the change time moves.
  execFileSync('touch', ['-r', join(root, '.env'), join(root, 'times')]);
  writeFileSync(join(root, '.env'), 'KEY=other-value-0xbbbbbb');
  execFileSync('touch', ['-r', join(root, 'times'), join(root, '.env')]);
  await env.refresh();
  expect(env.redact('other-value-0xbbbbbb')).toBe('[env:KEY]');
});

it('reads again a known env file that changed within 2 s of its last read, where a coarse clock keeps its times', async () => {
  const root = await workspace({ '.env': 'KEY=first-value-0xaaaaaa' });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  const before = statSync(join(root, '.env'));
  writeFileSync(join(root, '.env'), 'KEY=other-value-0xbbbbbb');
  // HFS+ keeps whole seconds: a rewrite of the same size within the second keeps every time.
  walks.seen.set(join(root, '.env'), () => before);
  await env.refresh();
  expect(env.redact('other-value-0xbbbbbb')).toBe('[env:KEY]');
});

it.runIf(MACOS)(
  "lists every folder before each send on a file system where a command can set a folder's times",
  async () => {
    const root = await trialRoot('exfat');
    mounts.table = `/dev/disk9s1 on ${realpathSync(root)} (exfat, local, nodev, nosuid)\n`;
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    try {
      const plain = join(root, 'plain');
      const before = statSync(plain);
      writeFileSync(join(plain, '.env.local'), 'EX=exfat-value-0x5e5e5e');
      // exFAT and FAT: `touch -r` gives the folder back every time it had.
      walks.seen.set(plain, () => before);
      await env.refresh();
      expect(env.redact('exfat-value-0x5e5e5e')).toBe('[env:EX]');
    } finally {
      env.close();
    }
  },
);

it.runIf(MACOS)(
  'walks a folder that is gone for a moment while the folders are checked',
  async () => {
    const root = await trialRoot('gone');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    try {
      const lib = join(root, 'pkg', 'lib');
      writeFileSync(join(lib, '.env.local'), 'GONE=gone-value-0x4d4d4d');
      // Moved away and back by a background job just as the check stats it.
      let away = true;
      walks.seen.set(lib, (real) => {
        if (!away) return real;
        away = false;
        return Object.assign(new Error('gone'), { code: 'ENOENT' });
      });
      await env.refresh();
      expect(env.redact('gone-value-0x4d4d4d')).toBe('[env:GONE]');
    } finally {
      env.close();
    }
  },
);

it.runIf(MACOS)(
  "finds a folder moved, while the folders are checked, into one the check had already stat'ed",
  async () => {
    const root = await trialRoot('moving');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    let release!: () => void;
    try {
      const lib = join(root, 'pkg', 'lib');
      writeFileSync(join(lib, '.env.local'), 'MOVING=moving-value-0x4e4e4e');
      walks.stated.length = 0;
      walks.statHold = { path: lib, until: new Promise<void>((done) => (release = done)) };
      const check = env.refresh();
      await vi.waitFor(
        () => expect(walks.stated).toEqual(expect.arrayContaining([lib, join(root, 'plain')])),
        { timeout: 10_000 },
      );
      // A rebuild moves it while its own stat waits, into `plain`, which the pass has stat'ed.
      await rename(lib, join(root, 'plain', 'lib'));
      release();
      await check;
      expect(env.redact('moving-value-0x4e4e4e')).toBe('[env:MOVING]');
    } finally {
      release?.();
      env.close();
    }
  },
);

it.runIf(MACOS)(
  'learns the env files in node_modules and .git, at start and when written during the job',
  async () => {
    const root = await trialRoot('skipped');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', '.env'), 'SHIPPED=shipped-value-0x3c3c3c');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    try {
      expect(env.redact('shipped-value-0x3c3c3c')).toBe('[env:SHIPPED]');
      mkdirSync(join(root, 'node_modules', 'other'));
      writeFileSync(
        join(root, 'node_modules', 'other', '.env.local'),
        'IN=installed-value-0x3d3d3d',
      );
      writeFileSync(join(root, '.git', 'hooks', '.env'), 'HOOK=hook-value-0x3e3e3e');
      await env.refresh();
      expect(env.redact('installed-value-0x3d3d3d hook-value-0x3e3e3e')).toBe(
        '[env:IN] [env:HOOK]',
      );
    } finally {
      env.close();
    }
  },
);

it.runIf(MACOS)(
  "lists a folder whose new entry's times a command set back, by its change time",
  async () => {
    const root = await trialRoot('ctime');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    try {
      const plain = join(root, 'plain');
      execFileSync('touch', ['-r', plain, join(root, 'times')]);
      writeFileSync(join(plain, '.env.local'), 'BACK=set-back-value-0x2b2b2b');
      execFileSync('touch', ['-r', join(root, 'times'), plain]);
      await env.refresh();
      expect(env.redact('set-back-value-0x2b2b2b')).toBe('[env:BACK]');
    } finally {
      env.close();
    }
  },
);

it.runIf(MACOS)(
  'lists a folder replaced by another that kept its times, by its inode',
  async () => {
    const root = await trialRoot('inode');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    try {
      const plain = join(root, 'plain');
      const before = statSync(plain);
      rmSync(plain, { recursive: true });
      mkdirSync(plain);
      writeFileSync(join(plain, '.env.local'), 'SWAP=swapped-value-0x1c1c1c');
      // A file system on which the folder made again matches every time: only its inode differs.
      walks.seen.set(plain, (real) =>
        Object.assign(Object.create(Object.getPrototypeOf(real) as object) as Stats, real, {
          ctimeMs: before.ctimeMs,
          mtimeMs: before.mtimeMs,
        }),
      );
      await env.refresh();
      expect(env.redact('swapped-value-0x1c1c1c')).toBe('[env:SWAP]');
    } finally {
      env.close();
    }
  },
);

it.runIf(MACOS)(
  "records a folder's times before it lists it, so a file made in between is found",
  async () => {
    const root = await trialRoot('order');
    aged();
    let release!: () => void;
    walks.statHold = {
      path: join(root, 'plain'),
      until: new Promise<void>((done) => (release = done)),
    };
    const starting = WorkerEnvSecrets.start([root]);
    await vi.waitFor(() => expect(walks.stated).toContain(join(root, 'plain')), {
      timeout: 10_000,
    });
    writeFileSync(join(root, 'plain', '.env.local'), 'ORDER=order-value-0x6a6a6a');
    release();
    const env = await starting;
    try {
      await env.refresh();
      expect(env.redact('order-value-0x6a6a6a')).toBe('[env:ORDER]');
    } finally {
      env.close();
    }
  },
);

it.runIf(MACOS)('holds every send when a walk during the job stops short', async () => {
  const root = await trialRoot('short');
  aged();
  const env = await WorkerEnvSecrets.start([root], { maxDirectories: 40 });
  try {
    for (let at = 0; at < 50; at++)
      mkdirSync(join(root, 'pkg', 'many', `f${at}`), { recursive: true });
    await env.refresh();
    expect(env.uncovered.size).toBeGreaterThan(0);
  } finally {
    env.close();
  }
});

it.runIf(MACOS && process.getuid?.() !== 0)(
  'holds every send when a changed folder cannot be listed',
  async () => {
    const root = await trialRoot('locked');
    aged();
    const env = await WorkerEnvSecrets.start([root]);
    const plain = join(root, 'plain');
    try {
      writeFileSync(join(plain, '.env.local'), 'LOCKED=locked-value-0x7b7b7b');
      chmodSync(plain, 0o000);
      await env.refresh();
      expect([...env.uncovered]).toContain(plain);
    } finally {
      chmodSync(plain, 0o755);
      env.close();
    }
  },
);

it('replaces every value of an env file that grows past 1 MiB during the job, at its end and on its own', async () => {
  const root = await workspace({ '.env.local': 'SMALL=small-value-0x01\n' });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  const filler = Array.from({ length: 40_000 }, (_, i) => `FILL_${i}=filler-value-${i}-xxxxxxxx`);
  const key = [
    '"-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '-----END KEY-----"',
  ];
  const grown = [...filler, `PEM=${key.join('\n')}`, 'TAIL_SECRET=tail-secret-value-0x99'];
  await writeFile(join(root, '.env.local'), grown.join('\n'));
  expect(Buffer.byteLength(grown.join('\n'))).toBeGreaterThan(1024 * 1024);
  await env.refresh();
  expect(env.withheld).toEqual([]);
  expect([...env.uncovered]).toEqual([]);
  // Past the old 1 MiB cut, whole and alone; and the head's values alone, not only its lines.
  expect(env.redact('tail-secret-value-0x99 small-value-0x01')).toBe(
    '[env:TAIL_SECRET] [env:SMALL]',
  );
  expect(env.redact('TAIL_SECRET=tail-secret-value-0x99')).toBe('TAIL_SECRET=[env:TAIL_SECRET]');
  expect(env.redact('got filler-value-1-xxxxxxxx')).toBe('got [env:FILL_1]');
  expect(env.redact('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC')).toBe('[env:PEM]');
});

it('denies an env file over the hard limit at start, and counts one that appears later as uncovered', async () => {
  const over = Buffer.alloc(MAX_ENV_FILE_BYTES + 1, 'a');
  const root = await workspace({ '.env': 'KEPT=kept-value-0x05' });
  await writeFile(join(root, '.env.dump'), over);
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  expect(env.withheld).toEqual([join(root, '.env.dump')]);
  expect([...env.uncovered]).toEqual([]);
  // After start the denies are fixed: a new file that cannot be covered stops forwarding.
  await writeFile(join(root, '.env.later'), over);
  await env.refresh();
  expect([...env.uncovered]).toEqual([join(root, '.env.later')]);
  // It is read again at each check, and covered once it can be.
  await writeFile(join(root, '.env.later'), 'LATER=later-value-0x06');
  await env.refresh();
  expect([...env.uncovered]).toEqual([]);
  expect(env.redact('later-value-0x06 kept-value-0x05')).toBe('[env:LATER] [env:KEPT]');
});

// Root lists any folder, so there is nothing to refuse.
it.skipIf(process.getuid?.() === 0)(
  'names a folder it may enter but not list, so its env files are denied and the rest stay readable',
  async () => {
    const root = await workspace({
      '.env': 'OPEN=open-value-0x07',
      'locked/.env.local': 'HIDDEN=hidden-value-0x08',
      'locked/deep/.env': 'DEEPER=deeper-value-0x09',
    });
    const locked = join(root, 'locked');
    await chmod(locked, 0o111);
    try {
      const env = await WorkerEnvSecrets.start([root], { watch: false });
      // A command can still open `locked/.env.local` by name, and its value was never learned.
      expect(env.redact('hidden-value-0x08 open-value-0x07')).toBe('hidden-value-0x08 [env:OPEN]');
      expect(env.unlisted).toEqual([locked]);
      // One folder is denied, not every env file of the job.
      expect(env.scanned).toBe(true);
    } finally {
      await chmod(locked, 0o755);
    }
  },
);

// Root lists any folder, so there is nothing to refuse.
it.skipIf(process.getuid?.() === 0)(
  'stops forwarding once a folder that held an env file can no longer be listed, until it can again',
  async () => {
    // The failure: the listing error was swallowed, so an env file a command then opened
    // there by name went out with its values never learned.
    const root = await workspace({ 'apps/api/.env': 'FIRST=first-value-0x01' });
    const folder = join(root, 'apps/api');
    const env = await WorkerEnvSecrets.start([root], { watch: false });
    await chmod(folder, 0o111);
    try {
      await env.refresh();
      expect([...env.uncovered]).toEqual([folder]);
    } finally {
      await chmod(folder, 0o755);
    }
    await env.refresh();
    expect([...env.uncovered]).toEqual([]);
  },
);

it("replaces the env values of a repository's .claude/settings.json at any depth, and denies one it cannot parse", async () => {
  // The failure: these files were closed to the worker, which a native subagent reads.
  const root = await workspace({
    '.claude/settings.json': JSON.stringify({ env: { OWN_TOKEN: 'own-value-0x0a', RETRIES: 3 } }),
    'apps/web/.claude/settings.json': JSON.stringify({ env: { NESTED_KEY: 'nested-value-0x0b' } }),
    'apps/old/.claude/settings.json': '{ "env": { "BROKEN_KEY": "broken-value-0x0c" ',
    // Not a Claude settings file: read only by name, never scanned.
    'config/settings.json': JSON.stringify({ env: { OTHER: 'other-value-0x0d' } }),
  });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  expect(env.scanned).toBe(true);
  expect(env.redact('own-value-0x0a nested-value-0x0b other-value-0x0d')).toBe(
    '[env:OWN_TOKEN] [env:NESTED_KEY] other-value-0x0d',
  );
  // The whole file is denied by its path.
  expect(env.withheld).toEqual([join(root, 'apps/old/.claude/settings.json')]);
  // One that stops parsing during the job stops forwarding, as an unreadable env file does.
  await writeFile(join(root, 'apps/web/.claude/settings.json'), '{ "env": ');
  await env.refresh();
  expect([...env.uncovered]).toEqual([join(root, 'apps/web/.claude/settings.json')]);
  // One that appears during the job and is read by name is learned first.
  await mkdir(join(root, 'apps/new/.claude'), { recursive: true });
  await writeFile(
    join(root, 'apps/new/.claude/settings.json'),
    JSON.stringify({ env: { LATER_KEY: 'later-value-0x0e' } }),
  );
  await env.add(join(root, 'apps/new/.claude/settings.json'));
  expect(env.redact('later-value-0x0e')).toBe('[env:LATER_KEY]');
});

it('lists the forms of a value it replaces, never a plain one', () => {
  expect(envPieces({ key: 'PORT', value: '3000', written: '3000' })).toEqual([]);
  expect(envPieces({ key: 'K', value: 'abc', written: 'abc#Zx9Qw2Lp7' })).toEqual(
    expect.arrayContaining(['abc#Zx9Qw2Lp7']),
  );
  expect(envPieces({ key: 'K', value: 'abc', written: 'abc#Zx9Qw2Lp7' })).not.toContain('abc');
});

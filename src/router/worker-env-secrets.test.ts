import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  envDeniedRoots,
  envPieces,
  MAX_ENV_FILE_BYTES,
  parseEnvFile,
  secretLike,
  WorkerEnvSecrets,
} from './worker-env-secrets';

// Counts the walks that list a root, so a test can tell one shared walk from two.
const walks = vi.hoisted(() => ({
  listed: [] as string[],
  /** The folders whose listing has been handed back. */
  done: [] as string[],
  hold: undefined as Promise<void> | undefined,
  /** With `hold`, only a listing of this folder waits. */
  holdOnly: undefined as string | undefined,
}));
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
  };
});

let dir: string | undefined;
afterEach(async () => {
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
  'walks the roots once for workers that start together, and still catches a file changed after that walk',
  async () => {
    const root = await workspace({ '.env': 'FIRST=first-value-0x21' });
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    walks.listed.length = 0;
    walks.done.length = 0;
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    const first = WorkerEnvSecrets.resume([root])!;
    // Made while the shared walk is held at its first listing, before the second worker starts.
    await writeFile(join(root, '.env.local'), 'DURING=during-value-0x31');
    const dirty = (first.env as unknown as { dirty: Set<string> }).dirty;
    await vi.waitFor(() => expect(dirty.has(join(root, '.env.local'))).toBe(true));
    const second = WorkerEnvSecrets.resume([root])!;
    walks.hold = undefined;
    release();
    try {
      expect(await first.verified).toBe(true);
      expect(await second.verified).toBe(true);
      // Both workers know the file made during the walk.
      expect(second.env.redact('during-value-0x31')).toBe('[env:DURING]');
      // One walk of the root served both.
      expect(walks.listed.filter((path) => path === root)).toHaveLength(1);
      // A file changed after the shared walk is caught by the second worker's first check.
      await writeFile(join(root, '.env.late'), 'LATE=late-value-0x32');
      await second.env.refresh();
      expect(second.env.redact('late-value-0x32')).toBe('[env:LATE]');
      expect(second.env.uncovered.size).toBe(0);
    } finally {
      first.env.close();
      second.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

// Review finding on the shared walk: its first worker is cancelled while the walk still runs, a
// checkout makes an env file in a folder the walk already passed, and a worker that starts
// then must still know its value before anything leaves.
it.runIf(WATCHES)(
  'replaces the value of an env file made in an already-walked folder after the first worker of a shared walk was cancelled',
  async () => {
    const root = await workspace({
      '.env': 'FIRST=first-value-0x21',
      'apps/service/index.js': 'x',
    });
    await mkdir(join(root, 'zz'));
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    // The walk lists every folder but `zz`, which is held.
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    walks.done.length = 0;
    const heldFolder = join(root, 'zz');
    walks.holdOnly = heldFolder;
    const first = WorkerEnvSecrets.resume([root])!;
    await vi.waitFor(() => expect(walks.done).toContain(join(root, 'apps', 'service')));
    first.env.close();
    await writeFile(join(root, 'apps', 'service', '.env.local'), 'LATE=late-value-0x41');
    const second = WorkerEnvSecrets.resume([root])!;
    walks.hold = undefined;
    walks.holdOnly = undefined;
    release();
    try {
      await first.verified;
      expect(await second.verified).toBe(true);
      expect(second.env.redact('late-value-0x41')).toBe('[env:LATE]');
    } finally {
      second.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it.runIf(WATCHES)(
  'releases no worker on a shared walk whose watcher failed, and lets the next one walk for itself',
  async () => {
    const root = await workspace({ '.env': 'FIRST=first-value-0x21' });
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    walks.listed.length = 0;
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    const first = WorkerEnvSecrets.resume([root])!;
    const second = WorkerEnvSecrets.resume([root])!;
    // The OS stops reporting events: nothing records what the walk may have missed.
    (
      first.env as unknown as { watchers: { emit: (e: string, x: Error) => void }[] }
    ).watchers[0]!.emit('error', new Error('events dropped'));
    const third = WorkerEnvSecrets.resume([root])!;
    walks.hold = undefined;
    release();
    try {
      expect(await first.verified).toBe(false);
      expect(await second.verified).toBe(false);
      expect(await third.verified).toBe(true);
      expect(walks.listed.filter((path) => path === root)).toHaveLength(2);
    } finally {
      for (const worker of [first, second, third]) worker.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it.runIf(WATCHES)(
  'lets a worker whose roots lie inside a running walk take it, and a file made there during the walk is known',
  async () => {
    const root = await workspace({ 'a/.env': 'A=a-value-0x51', '.env': 'TOP=top-value-0x52' });
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    (await WorkerEnvSecrets.start([join(root, 'a')], { keep: true, watch: false })).close();
    walks.listed.length = 0;
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    const first = WorkerEnvSecrets.resume([root])!;
    const inner = WorkerEnvSecrets.resume([join(root, 'a')])!;
    await writeFile(join(root, 'a', '.env.new'), 'NEW=new-value-0x53');
    const dirty = (first.env as unknown as { dirty: Set<string> }).dirty;
    await vi.waitFor(() => expect(dirty.has(join(root, 'a', '.env.new'))).toBe(true));
    walks.hold = undefined;
    release();
    try {
      expect(await first.verified).toBe(true);
      expect(await inner.verified).toBe(true);
      expect(inner.env.redact('new-value-0x53')).toBe('[env:NEW]');
      expect(walks.listed.filter((path) => path === root)).toHaveLength(1);
    } finally {
      first.env.close();
      inner.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it.runIf(WATCHES)(
  'does not join a walk whose first worker was cancelled: its watcher no longer feeds the walk',
  async () => {
    const root = await workspace({ '.env': 'FIRST=first-value-0x21' });
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    walks.listed.length = 0;
    walks.done.length = 0;
    let release!: () => void;
    walks.hold = new Promise<void>((done) => (release = done));
    const first = WorkerEnvSecrets.resume([root])!;
    first.env.close();
    const second = WorkerEnvSecrets.resume([root])!;
    walks.hold = undefined;
    release();
    try {
      await first.verified;
      expect(await second.verified).toBe(true);
      // A walk of its own: nothing but a live watcher's events may stand in for one.
      expect(walks.listed.filter((path) => path === root)).toHaveLength(2);
    } finally {
      second.env.close();
      WorkerEnvSecrets.forgetScans();
    }
  },
);

it.runIf(WATCHES)(
  'does not release a joined worker when the shared walk finds a file that needs a deny',
  async () => {
    const root = await workspace({ '.env': 'FIRST=first-value-0x21' });
    (await WorkerEnvSecrets.start([root], { keep: true, watch: false })).close();
    await writeFile(join(root, '.env.sh'), 'export PATH\n');
    const first = WorkerEnvSecrets.resume([root])!;
    const second = WorkerEnvSecrets.resume([root])!;
    try {
      expect(await first.verified).toBe(false);
      expect(await second.verified).toBe(false);
    } finally {
      first.env.close();
      second.env.close();
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

it.runIf(WATCHES)(
  'runs one check for a model request that follows a tool result at once, after a full wait for file events from that request',
  async () => {
    // Operator item of 2026-11-18. A worker's tool result starts a check, and its next
    // model request, a few milliseconds later, queued a second one behind it: two waits
    // of 120 ms and two listings in a row before every request that followed a tool.
    const root = await workspace({ '.env': 'FIRST=first-value-0x01' });
    const env = await WorkerEnvSecrets.start([root]);
    const checks = vi.spyOn(env as unknown as { check: () => Promise<void> }, 'check');
    try {
      const afterToolResult = env.refresh();
      await new Promise((done) => setTimeout(done, 60));
      // Written by the tool that just ran, in a folder nothing has listed: only the
      // watcher's event tells of it.
      await mkdir(join(root, 'made/now'), { recursive: true });
      await writeFile(join(root, 'made/now/.env.local'), 'LATE=late-value-0x02');
      const asked = Date.now();
      await env.refresh();
      // The wait for file events ran in full from the request, and one check read after it.
      expect(Date.now() - asked).toBeGreaterThanOrEqual(115);
      expect(env.redact('late-value-0x02')).toBe('[env:LATE]');
      await afterToolResult;
      expect(checks).toHaveBeenCalledTimes(1);
      // A call made once a check has begun to read still gets a check of its own.
      await env.refresh();
      expect(checks).toHaveBeenCalledTimes(2);
    } finally {
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

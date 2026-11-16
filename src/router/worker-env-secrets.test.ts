import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  envDeniedRoots,
  envPieces,
  parseEnvFile,
  secretLike,
  WorkerEnvSecrets,
} from './worker-env-secrets';

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
  ).toEqual({
    ok: true,
    assignments: [
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
    ],
  });
});

it('treats a file it cannot parse as lines to withhold, never as raw text to forward', () => {
  expect(parseEnvFile('use flake\nsecret-without-a-key-0x9f\n')).toEqual({
    ok: false,
    lines: ['use flake', 'secret-without-a-key-0x9f'],
  });
  expect(parseEnvFile('KEY="never closed\nmore')).toMatchObject({ ok: false });
  expect(parseEnvFile('KEY=a\0b')).toMatchObject({ ok: false });
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

it('withholds every line of a file it cannot parse, keeping lines too short to matter', async () => {
  const root = await workspace({ '.envrc': 'use nix\nlayout-secret-a9f3e1\n' });
  const env = await WorkerEnvSecrets.start([root], { watch: false });
  expect(env.redact('use nix; layout-secret-a9f3e1')).toBe('use nix; [env:withheld line]');
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

it('lists the forms of a value it replaces, never a plain one', () => {
  expect(envPieces({ key: 'PORT', value: '3000', written: '3000' })).toEqual([]);
  expect(envPieces({ key: 'K', value: 'abc', written: 'abc#Zx9Qw2Lp7' })).toEqual(
    expect.arrayContaining(['abc#Zx9Qw2Lp7']),
  );
  expect(envPieces({ key: 'K', value: 'abc', written: 'abc#Zx9Qw2Lp7' })).not.toContain('abc');
});

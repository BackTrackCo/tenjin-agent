import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context';
import {
  configureJevgrep,
  readJevgrepGrant,
  bindJevgrepOffer,
  boundJevgrepGrant,
  disableJevgrep,
  eligibleJevgrep,
  forbidsDisclosure,
  type JevgrepGrant,
} from './grants';
let dir: string;
let root: string;
let ctx: CommandContext;
let grant: JevgrepGrant;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'jevgrep-grants-')));
  root = join(dir, 'repo');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(dir, 'jevgrep'), { mode: 0o700 });
  await writeFile(join(dir, 'runtime.tgz'), 'test artifact');
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '1000', sessionBudget: '50000' }),
  );
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  ctx = {
    dataDir: dir,
    flags: { json: true, timeout: 5000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
  grant = {
    version: 1,
    id: randomUUID(),
    enabled: true,
    root,
    source: 'committed-tracked',
    supplier: 'jev-x402',
    shareSource: true,
    maxRunAtomic: '50000',
    runtime: { kind: 'local-artifact', path: join(dir, 'runtime.tgz'), sha256: 'a'.repeat(64) },
  };
  await save();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function save() {
  await writeFile(join(dir, 'jevgrep', 'grant.json'), JSON.stringify(grant), { mode: 0o600 });
}
describe('local disclosure authority', () => {
  it('requires a private grant and an unexpired hook offer for the exact root', async () => {
    expect(await eligibleJevgrep(ctx, root, 'Explain the credential lifecycle')).toEqual(grant);
    expect(await boundJevgrepGrant(ctx, root, undefined, 'Explain lifecycle')).toBeNull();
    await bindJevgrepOffer(dir, 'bound-id-123', 'session-one', grant);
    expect(await boundJevgrepGrant(ctx, root, 'bound-id-123', 'Explain lifecycle')).toEqual(grant);
    expect(await boundJevgrepGrant(ctx, dir, 'bound-id-123', 'Explain lifecycle')).toBeNull();
    expect(await boundJevgrepGrant(ctx, root, '../../wrong', 'Explain lifecycle')).toBeNull();
    await mkdir(join(root, 'src'));
    expect(
      await boundJevgrepGrant(ctx, join(root, 'src'), 'bound-id-123', 'Explain lifecycle'),
    ).toBeNull();
    await writeFile(
      join(dir, 'jevgrep', 'bindings', 'bound-id-123.json'),
      JSON.stringify({
        version: 1,
        id: 'bound-id-123',
        root,
        grantId: grant.id,
        sessionId: 'session-one',
        expiresAt: 0,
      }),
      { mode: 0o600 },
    );
    expect(await boundJevgrepGrant(ctx, root, 'bound-id-123', 'Explain lifecycle')).toBeNull();
  });
  it('revocation, grant replacement and zero budget withdraw existing offers', async () => {
    await bindJevgrepOffer(dir, 'bound-id-123', 'session-one', grant);
    grant.id = randomUUID();
    await save();
    expect(await boundJevgrepGrant(ctx, root, 'bound-id-123', 'Explain lifecycle')).toBeNull();
    await disableJevgrep(ctx);
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
    await save();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ sessionBudget: '0' }));
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
  });
  it('fails closed on corrupt, public or symlinked authority records', async () => {
    await chmod(join(dir, 'jevgrep', 'grant.json'), 0o644);
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
    await chmod(join(dir, 'jevgrep', 'grant.json'), 0o600);
    await writeFile(join(dir, 'jevgrep', 'grant.json'), '{');
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
    await rm(join(dir, 'jevgrep', 'grant.json'));
    await writeFile(join(dir, 'elsewhere.json'), JSON.stringify(grant), { mode: 0o600 });
    await symlink(join(dir, 'elsewhere.json'), join(dir, 'jevgrep', 'grant.json'));
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
  });
  it.each([
    'Do not upload source',
    'No paid calls please',
    'Use native-only tools',
    'Explain this offline-only',
    'Never send this repository to a remote provider',
    'I have zero budget',
  ])('respects disclosure/spending constraints: %s', async (text) => {
    expect(forbidsDisclosure(text)).toBe(true);
    expect(await eligibleJevgrep(ctx, root, text)).toBeNull();
  });
  it('does not turn a source grant into an arbitrary runtime command', async () => {
    await writeFile(
      join(dir, 'jevgrep', 'grant.json'),
      JSON.stringify({ ...grant, runtime: { ...grant.runtime, argv: ['sh', '-c', 'anything'] } }),
      { mode: 0o600 },
    );
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
  });
});

it('uses the same supplier identity as runPay for wallet allowlists', async () => {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '1000',
      sessionBudget: '50000',
      allowlistCreators: ['jev-x402.vercel.app'],
    }),
  );
  expect(await eligibleJevgrep(ctx, root)).toEqual(grant);
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '1000',
      sessionBudget: '50000',
      allowlistCreators: ['another.example'],
    }),
  );
  expect(await eligibleJevgrep(ctx, root)).toBeNull();
});

it('accepts an explicit extended grant but never grants more than one dollar', async () => {
  grant.maxRunAtomic = '1000000';
  await save();
  expect(await eligibleJevgrep(ctx, root)).toEqual(grant);
  grant.maxRunAtomic = '1000001';
  await save();
  expect(await eligibleJevgrep(ctx, root)).toBeNull();
});

it('configures only the qualified exact npm pin without fetching or changing wallet policy', async () => {
  execFileSync('/usr/bin/git', ['init', '-q', root]);
  const args = { root, release: '0.7.0', maxRun: '1', shareSource: true, experimental: true };
  await configureJevgrep(ctx, args);
  expect(await readJevgrepGrant(dir)).toMatchObject({
    runtime: { kind: 'release', version: '0.7.0' },
    maxRunAtomic: '1000000',
  });
  expect(await eligibleJevgrep(ctx, root)).not.toBeNull();
  for (const release of ['latest', '^0.7.0', '0.7.1', '0.4.4'])
    await expect(configureJevgrep(ctx, { ...args, release })).rejects.toThrow(
      'qualified exact release',
    );
  await expect(configureJevgrep(ctx, { ...args, artifact: '/other.tgz' })).rejects.toThrow(
    'cannot be combined',
  );
  await expect(configureJevgrep(ctx, { ...args, release: undefined })).rejects.toThrow(
    'Provide --release',
  );
});
it('does not accept an unqualified or arbitrary package in a saved release grant', async () => {
  for (const runtime of [
    { kind: 'release', version: 'latest' },
    { kind: 'release', version: '0.7.1' },
    { kind: 'release', version: '0.7.0', package: 'untrusted' },
  ]) {
    await writeFile(join(dir, 'jevgrep', 'grant.json'), JSON.stringify({ ...grant, runtime }), {
      mode: 0o600,
    });
    expect(await eligibleJevgrep(ctx, root)).toBeNull();
  }
});

import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { JEVGREP_SUPPLIER } from './supplier';
import { routerSettings } from '../settings';
import type { CommandContext, CommandResult } from '../../context';
import { writeFileAtomic, writeFileAtomicExclusive } from '../../lib/atomic-json';
import { CliError } from '../../lib/errors';
import { parseUsdToAtomic } from '../../lib/money';
import { evaluateSpendPolicy } from '../../lib/policy';
import { resolveContextSettings } from '../../lib/settings';
import { onPath } from '../../lib/skill-wiring';
import { readLedger, readSpendSummary, spentOf } from '../../lib/spend-ledger';
import { spendLedgerPath } from '../../lib/paths';

const exec = promisify(execFile);
export const JEVGREP_EXECUTOR = 'jevgrep-search-v1';
const GrantSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  enabled: z.boolean(),
  root: z.string().min(1).refine(isAbsolute),
  source: z.literal('committed-tracked'),
  supplier: z.literal('jev-x402'),
  shareSource: z.literal(true),
  maxRunAtomic: z
    .string()
    .regex(/^\d+$/)
    .refine((v) => BigInt(v) > 0n && BigInt(v) <= 50_000n),
  runtime: z.strictObject({
    kind: z.literal('local-artifact'),
    path: z.string().min(1).refine(isAbsolute),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
export type JevgrepGrant = z.infer<typeof GrantSchema>;
const BindingSchema = z.strictObject({
  version: z.literal(1),
  id: z.string(),
  root: z.string(),
  grantId: z.string().uuid(),
  sessionId: z.string().min(1),
  expiresAt: z.number().int(),
});
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const grantPath = (dataDir: string) => join(dataDir, 'jevgrep', 'grant.json');
const bindingPath = (dataDir: string, id: string) =>
  join(dataDir, 'jevgrep', 'bindings', `${id}.json`);

async function readPrivate(path: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 16_384 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('invalid private record');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CliError(
      'REFUSED',
      'The local retrieval grant or binding is unreadable. Re-enable it explicitly.',
    );
  } finally {
    await handle?.close();
  }
}

export async function readJevgrepGrant(dataDir: string): Promise<JevgrepGrant | null> {
  const value = await readPrivate(grantPath(dataDir));
  if (value === null) return null;
  const parsed = GrantSchema.safeParse(value);
  if (!parsed.success) throw new CliError('REFUSED', 'The local retrieval grant is invalid.');
  return parsed.data;
}

/** An explicit personal grant is authority; cwd only binds it to this host session. */
export async function eligibleJevgrep(
  ctx: CommandContext,
  cwd: string | undefined,
  text = '',
): Promise<JevgrepGrant | null> {
  try {
    if (
      !cwd ||
      process.platform === 'win32' ||
      Number(process.versions.node.split('.')[0]) < 24 ||
      !onPath('npx', process.env) ||
      !onPath('git', process.env) ||
      forbidsDisclosure(text)
    )
      return null;
    if (!(await routerSettings({ cwd, dataDir: ctx.dataDir })).enabled.value) return null;
    const grant = await readJevgrepGrant(ctx.dataDir);
    if (
      !grant?.enabled ||
      (await realpath(cwd)) !== grant.root ||
      (await realpath(grant.root)) !== grant.root
    )
      return null;
    const runtime = await lstat(grant.runtime.path);
    if (
      !runtime.isFile() ||
      runtime.isSymbolicLink() ||
      !grant.runtime.path.endsWith('.tgz') ||
      BigInt(grant.maxRunAtomic) < BigInt(JEVGREP_SUPPLIER.maxAmountAtomic)
    )
      return null;
    const { policy } = await resolveContextSettings(ctx);
    const { corrupt } = await readLedger(spendLedgerPath(ctx.dataDir));
    if (corrupt) return null;
    const ledger = await readSpendSummary(ctx.dataDir);
    if (
      evaluateSpendPolicy(policy, {
        amountAtomic: BigInt(JEVGREP_SUPPLIER.maxAmountAtomic),
        creator: new URL(JEVGREP_SUPPLIER.url).host,
        sessionSpentAtomic: ledger ? spentOf(ledger) : 0n,
      }).decision !== 'allow'
    )
      return null;
    return grant;
  } catch {
    return null;
  }
}

export function forbidsDisclosure(text: string): boolean {
  return /\b(no|never|without|don['’]?t|do not|must not|avoid)\b[^.!?\n]{0,50}\b(upload|share|send|remote|external|network|paid|pay|spend|payments?)\b|\b(native|offline|local)[ -]only\b|\b(zero|no)\s+budget\b/i.test(
    text,
  );
}

export async function bindJevgrepOffer(
  dataDir: string,
  id: string,
  sessionId: string,
  grant: JevgrepGrant,
): Promise<void> {
  if (!ID.test(id) || !sessionId)
    throw new CliError('REFUSED', 'Local retrieval needs a valid hook session.');
  const binding = {
    version: 1,
    id,
    root: grant.root,
    grantId: grant.id,
    sessionId,
    expiresAt: Date.now() + 15 * 60_000,
  };
  await writeFileAtomicExclusive(bindingPath(dataDir, id), JSON.stringify(binding), {
    mode: 0o600,
    dirMode: 0o700,
  });
}

export async function boundJevgrepGrant(
  ctx: CommandContext,
  cwd: string | undefined,
  id: string | undefined,
  text: string,
): Promise<JevgrepGrant | null> {
  if (!id || !ID.test(id)) return null;
  const grant = await eligibleJevgrep(ctx, cwd, text);
  if (!grant) return null;
  try {
    const result = BindingSchema.safeParse(await readPrivate(bindingPath(ctx.dataDir, id)));
    if (
      !result.success ||
      result.data.id !== id ||
      result.data.grantId !== grant.id ||
      result.data.root !== grant.root ||
      result.data.expiresAt <= Date.now()
    )
      return null;
    return grant;
  } catch {
    return null;
  }
}

export async function configureJevgrep(
  ctx: CommandContext,
  args: {
    root: string;
    artifact: string;
    sha256: string;
    maxRun: string;
    shareSource: boolean;
    experimental: boolean;
  },
): Promise<CommandResult> {
  if (!args.shareSource || !args.experimental)
    throw new CliError('USAGE', 'Enabling the pilot requires --share-source and --experimental.');
  const root = await realpath(args.root);
  const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  if ((await realpath(stdout.trim())) !== root)
    throw new CliError(
      'USAGE',
      '--root must name the repository root, not a parent or subdirectory.',
    );
  const artifact = await realpath(args.artifact);
  const info = await stat(artifact);
  if (!artifact.endsWith('.tgz') || !info.isFile() || info.size > 32 * 1024 * 1024)
    throw new CliError('USAGE', 'Provide the reviewed Jevgrep npm tarball (at most 32 MiB).');
  const file = await open(artifact, 'r');
  let digest: string;
  try {
    digest = createHash('sha256')
      .update(await file.readFile())
      .digest('hex');
  } finally {
    await file.close();
  }
  if (digest !== args.sha256) throw new CliError('USAGE', 'The artifact does not match --sha256.');
  const parsed = GrantSchema.safeParse({
    version: 1,
    id: randomUUID(),
    enabled: true,
    root,
    source: 'committed-tracked',
    supplier: 'jev-x402',
    shareSource: true,
    maxRunAtomic: parseUsdToAtomic(args.maxRun).toString(),
    runtime: { kind: 'local-artifact', path: artifact, sha256: digest },
  });
  if (!parsed.success)
    throw new CliError('USAGE', 'The run budget must be positive and at most $0.05.');
  await writeFileAtomic(grantPath(ctx.dataDir), JSON.stringify(parsed.data), {
    mode: 0o600,
    dirMode: 0o700,
  });
  return {
    data: parsed.data,
    humanLines: [
      `Enabled experimental repository retrieval for ${root}. Committed tracked source may be sent to https://jev-x402.vercel.app/jev, up to $${args.maxRun} per search within your wallet policy. Native tools remain available.`,
    ],
  };
}

export async function disableJevgrep(ctx: CommandContext): Promise<CommandResult> {
  const grant = await readJevgrepGrant(ctx.dataDir);
  if (grant)
    await writeFileAtomic(grantPath(ctx.dataDir), JSON.stringify({ ...grant, enabled: false }), {
      mode: 0o600,
      dirMode: 0o700,
    });
  return {
    data: { enabled: false },
    humanLines: ['Local repository retrieval disabled. Payment records are retained.'],
  };
}

import { QUALIFIED_JEVGREP_RELEASES, isQualifiedJevgrepRelease } from './runtime';
import { jevgrepProfile } from './profile';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { jevgrepSupplier } from './supplier';
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
const SupplierSchema = z.enum(['jev-x402', 'maple-jev']);
const GrantSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  enabled: z.boolean(),
  root: z.string().min(1).refine(isAbsolute),
  source: z.literal('committed-tracked'),
  supplier: SupplierSchema,
  shareSource: z.literal(true),
  maxRunAtomic: z
    .string()
    .regex(/^\d+$/)
    .refine((v) => BigInt(v) > 0n && BigInt(v) <= jevgrepProfile('extended-v1').maxRunAtomic),
  runtime: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('local-artifact'),
      path: z.string().min(1).refine(isAbsolute),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    z.strictObject({ kind: z.literal('release'), version: z.enum(QUALIFIED_JEVGREP_RELEASES) }),
  ]),
});
export type JevgrepGrant = z.infer<typeof GrantSchema>;
const BindingSchema = z
  .strictObject({
    version: z.literal(1),
    id: z.string(),
    root: z.string(),
    grantId: z.string().uuid(),
    sessionId: z.string().min(1),
    expiresAt: z.number().int(),
    repositoryTurn: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    snapshotCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .refine((value) => (value.repositoryTurn === undefined) === (value.snapshotCommit === undefined));
export type JevgrepBinding = z.infer<typeof BindingSchema>;
export interface RepositoryOfferScope {
  repositoryTurn: string;
  snapshotCommit: string;
}
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const grantPath = (dataDir: string) => join(dataDir, 'jevgrep', 'grant.json');
const bindingPath = (dataDir: string, id: string) =>
  join(dataDir, 'jevgrep', 'bindings', `${id}.json`);

async function readPrivate(path: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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

/** Local handoff state may inspect scope, but this record alone grants no spend. */
export async function readJevgrepBinding(
  dataDir: string,
  id: string | undefined,
): Promise<JevgrepBinding | null> {
  if (!id || !ID.test(id)) return null;
  const value = await readPrivate(bindingPath(dataDir, id));
  if (value === null) return null;
  const parsed = BindingSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id)
    throw new CliError('REFUSED', 'The local retrieval binding is invalid.');
  return parsed.data;
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
    const supplier = jevgrepSupplier(grant.supplier);
    if (BigInt(grant.maxRunAtomic) < BigInt(supplier.maxAmountAtomic)) return null;
    if (grant.runtime.kind === 'local-artifact') {
      const runtime = await lstat(grant.runtime.path);
      if (!runtime.isFile() || runtime.isSymbolicLink() || !grant.runtime.path.endsWith('.tgz'))
        return null;
    }
    const { policy } = await resolveContextSettings(ctx);
    const { corrupt } = await readLedger(spendLedgerPath(ctx.dataDir));
    if (corrupt) return null;
    const ledger = await readSpendSummary(ctx.dataDir);
    if (
      evaluateSpendPolicy(policy, {
        amountAtomic: BigInt(supplier.maxAmountAtomic),
        creator: new URL(supplier.url).host,
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
  scope?: RepositoryOfferScope,
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
    ...scope,
  };
  BindingSchema.parse(binding);
  await writeFileAtomicExclusive(bindingPath(dataDir, id), JSON.stringify(binding), {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** A redirect does not spend. Claim its shared turn only when the agent's
 * actual query reaches the local executor, before constructing a payer. */
export async function claimRepositoryRetrieval(
  dataDir: string,
  id: string,
  grant: JevgrepGrant,
  query: string,
): Promise<{ snapshotCommit?: string } | null> {
  if (!ID.test(id)) return null;
  try {
    const binding = BindingSchema.parse(await readPrivate(bindingPath(dataDir, id)));
    if (
      binding.id !== id ||
      binding.grantId !== grant.id ||
      binding.root !== grant.root ||
      binding.expiresAt <= Date.now()
    )
      return null;
    // Existing prompt offers retain their normal request semantics.
    if (!binding.repositoryTurn || !binding.snapshotCommit) return {};
    const { stdout } = await exec('git', ['-C', grant.root, 'rev-parse', '--verify', 'HEAD'], {
      timeout: 5_000,
      maxBuffer: 1024,
    });
    if (stdout.trim() !== binding.snapshotCommit) return null;
    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const directory = join(dataDir, 'jevgrep', 'repository-hooks', hash(binding.sessionId));
    const options = { mode: 0o600, dirMode: 0o700 };
    await writeFileAtomicExclusive(
      join(directory, `paid-${binding.repositoryTurn}.json`),
      '{"version":1}',
      options,
    );
    await writeFileAtomicExclusive(
      join(
        directory,
        `snapshot-${hash({ root: grant.root, commit: binding.snapshotCommit, query })}.json`,
      ),
      '{"version":1}',
      options,
    );
    return { snapshotCommit: binding.snapshotCommit };
  } catch {
    return null;
  }
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

/** A stale or damaged local offer must not be reinterpreted as an HTTP offer. */
export async function isJevgrepOffer(dataDir: string, id: string | undefined): Promise<boolean> {
  if (!id || !ID.test(id)) return false;
  try {
    return (await readPrivate(bindingPath(dataDir, id))) !== null;
  } catch {
    return true;
  }
}

export async function configureJevgrep(
  ctx: CommandContext,
  args: {
    root: string;
    artifact?: string;
    sha256?: string;
    release?: string;
    supplier?: string;
    maxRun: string;
    shareSource: boolean;
    experimental: boolean;
  },
): Promise<CommandResult> {
  if (!args.shareSource || !args.experimental)
    throw new CliError('USAGE', 'Enabling the pilot requires --share-source and --experimental.');
  const supplierId = SupplierSchema.safeParse(args.supplier ?? 'jev-x402');
  if (!supplierId.success)
    throw new CliError('USAGE', 'Choose --supplier jev-x402 or --supplier maple-jev.');
  const supplier = jevgrepSupplier(supplierId.data);
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
  let runtime: JevgrepGrant['runtime'];
  if (args.release !== undefined) {
    if (args.artifact !== undefined || args.sha256 !== undefined)
      throw new CliError('USAGE', '--release cannot be combined with --artifact or --sha256.');
    if (!isQualifiedJevgrepRelease(args.release))
      throw new CliError('USAGE', 'Provide a qualified exact release: 0.7.0.');
    runtime = { kind: 'release', version: args.release };
  } else {
    if (!args.artifact || !args.sha256)
      throw new CliError('USAGE', 'Provide --release 0.7.0 or both --artifact and --sha256.');
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
    if (digest !== args.sha256)
      throw new CliError('USAGE', 'The artifact does not match --sha256.');
    runtime = { kind: 'local-artifact', path: artifact, sha256: digest };
  }
  const parsed = GrantSchema.safeParse({
    version: 1,
    id: randomUUID(),
    enabled: true,
    root,
    source: 'committed-tracked',
    supplier: supplier.id,
    shareSource: true,
    maxRunAtomic: parseUsdToAtomic(args.maxRun).toString(),
    runtime,
  });
  if (!parsed.success)
    throw new CliError('USAGE', 'The run budget must be positive and at most $1.');
  await writeFileAtomic(grantPath(ctx.dataDir), JSON.stringify(parsed.data), {
    mode: 0o600,
    dirMode: 0o700,
  });
  return {
    data: parsed.data,
    humanLines: [
      `Enabled experimental repository retrieval for ${root}. Committed tracked source may be sent to ${supplier.url}, up to $${args.maxRun} per search within your wallet policy. Native tools remain available.`,
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

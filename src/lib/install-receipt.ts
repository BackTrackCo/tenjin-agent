import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import pkg from '../../package.json';
import { writeFileAtomic } from './atomic-json';
import { hasCode } from './errno';
import { CliError } from './errors';
import { installReceiptPath } from './paths';

const CustodyFactsSchema = z.object({
  privateKeyAccess: z.literal('read-into-process-memory-at-connect-and-sign'),
  privateKeyCopiedToTenjinStorage: z.literal(false),
  privateKeyPersistedByTenjin: z.literal(false),
  privateKeyLogged: z.literal(false),
  privateKeyReturned: z.literal(false),
  privateKeyTransmitted: z.literal(false),
  mnemonicAccessed: z.literal(false),
  rawTransactionSigning: z.literal(false),
  pinnedAddressDriftRefusal: z.literal(true),
  humanAcknowledgement: z.literal('not-proven'),
  sameUserUnrestrictedAgentContained: z.literal(false),
  enforcementBoundary: z.literal('outside-tenjin-process'),
});

const PolicyValueSchema = z.object({ value: z.string(), source: z.string() });

export const InstallReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  cliVersion: z.string().min(1),
  harnesses: z.array(z.string()),
  execution: z.object({
    surface: z.enum(['interactive', 'machine']),
    harnessApprovalMode: z.literal('unknown'),
    humanPresenceProven: z.literal(false),
    sameUserUnrestrictedAgentContained: z.literal(false),
  }),
  wallet: z
    .object({
      status: z.enum(['existing', 'created', 'connected', 'declined', 'skipped']),
      address: z.string().optional(),
      provider: z.string().optional(),
      credentialSource: z.string().optional(),
      signerPath: z.string().optional(),
      custody: CustodyFactsSchema.optional(),
    })
    .optional(),
  policy: z.object({
    publishMode: PolicyValueSchema,
  }),
  changedPaths: z.array(z.string()),
  warnings: z.array(z.string()),
  undoCommands: z.array(z.string()),
  notice: z.object({
    status: z.enum(['unacknowledged', 'acknowledged']),
    acknowledgedAt: z.iso.datetime().optional(),
    acknowledgementProven: z.literal(false),
  }),
});

export type InstallReceipt = z.infer<typeof InstallReceiptSchema>;
export type InstallReceiptInput = Omit<
  InstallReceipt,
  'schemaVersion' | 'id' | 'createdAt' | 'cliVersion' | 'notice'
>;

export interface StoredInstallReceipt {
  path: string;
  receipt: InstallReceipt;
}

/** Atomically replace the latest receipt. It contains no credential material. */
export async function writeInstallReceipt(
  dir: string,
  input: InstallReceiptInput,
  now: () => Date = () => new Date(),
): Promise<StoredInstallReceipt> {
  const safeInput = redactReceiptSecrets(input) as InstallReceiptInput;
  const receipt = InstallReceiptSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: now().toISOString(),
    cliVersion: pkg.version,
    ...safeInput,
    notice: {
      status: 'unacknowledged',
      acknowledgementProven: false,
    },
  });
  const path = installReceiptPath(dir);
  await writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  return { path, receipt };
}

function redactReceiptSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/0x[0-9a-fA-F]{64}\b/g, '[REDACTED_PRIVATE_KEY]')
      .replace(
        /\b(BLOCKRUN_WALLET_KEY|TENJIN_WALLET_KEY|TENJIN_WALLET_PASSPHRASE)=([^\s]+)/gi,
        '$1=[REDACTED]',
      );
  }
  if (Array.isArray(value)) return value.map(redactReceiptSecrets);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactReceiptSecrets(nested)]),
    );
  }
  return value;
}

export async function readInstallReceipt(dir: string): Promise<StoredInstallReceipt | null> {
  const path = installReceiptPath(dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return null;
    throw new CliError('CONFIG_INVALID', `Could not read the install receipt at ${path}.`, {
      fix: `Check that ${path} is a readable regular file.`,
      cause: err,
    });
  }
  try {
    return { path, receipt: InstallReceiptSchema.parse(JSON.parse(raw)) };
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `The install receipt at ${path} is invalid.`, {
      fix: `Move ${path} aside, then re-run \`tenjin install\` to create a fresh receipt.`,
      cause: err,
    });
  }
}

export async function acknowledgeInstallReceipt(
  dir: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<StoredInstallReceipt> {
  const current = await readInstallReceipt(dir);
  if (current === null) {
    throw new CliError('USAGE', 'There is no install notice to acknowledge.', {
      fix: 'Run `tenjin doctor` to inspect the current installation.',
    });
  }
  if (current.receipt.id !== id) {
    throw new CliError(
      'USAGE',
      `Install receipt ${JSON.stringify(id)} is not the current notice.`,
      {
        fix: `Use \`tenjin notice acknowledge ${current.receipt.id}\`.`,
      },
    );
  }
  const receipt = InstallReceiptSchema.parse({
    ...current.receipt,
    notice: {
      status: 'acknowledged',
      acknowledgedAt: now().toISOString(),
      acknowledgementProven: false,
    },
  });
  await writeFileAtomic(current.path, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  return { path: current.path, receipt };
}

export function pendingInstallNoticeData(stored: StoredInstallReceipt): Record<string, unknown> {
  return {
    id: stored.receipt.id,
    createdAt: stored.receipt.createdAt,
    path: stored.path,
    status: stored.receipt.notice.status,
    humanPresenceProven: false,
    acknowledgementProven: false,
    acknowledgeCommand: `tenjin notice acknowledge ${stored.receipt.id}`,
  };
}

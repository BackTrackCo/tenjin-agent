import { fileURLToPath } from 'node:url';
import { createAccount, isPlan } from './accounts.ts';
import { describeConfig } from './config.ts';
import { accountSummary, formatSummary } from './commands/summary.ts';
import { sweepSettled, sweepWindowDays } from './commands/sweep.ts';
import { isLedgerError } from './errors.ts';
import { balanceFor, postEntry } from './ledger.ts';

const USAGE = [
  'ledger <command> [args]',
  '',
  'commands:',
  '  create <name> <plan>            create an account',
  '  post <accountId> <cents> <kind> post an entry',
  '  balance <accountId>             print the balance',
  '  summary <accountId>             print the account summary',
  '  sweep [olderThanDays]           settle what is old enough',
  '  config                          print the effective config',
].join('\n');

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** Run one CLI invocation. Returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo = consoleIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    io.out(USAGE);
    return command ? 0 : 1;
  }

  try {
    switch (command) {
      case 'create': {
        const [name, plan] = rest;
        if (!name || !plan || !isPlan(plan)) {
          io.err('usage: ledger create <name> <starter|standard|scale>');
          return 2;
        }
        const account = createAccount({ name, plan });
        io.out(`${account.id}\t${account.name}\t${account.plan}`);
        return 0;
      }

      case 'post': {
        const [accountId, cents, kind] = rest;
        if (!accountId || !cents || (kind !== 'debit' && kind !== 'credit')) {
          io.err('usage: ledger post <accountId> <cents> <debit|credit>');
          return 2;
        }
        const entry = postEntry({
          accountId,
          amountCents: Number.parseInt(cents, 10),
          kind,
          memo: 'cli',
        });
        io.out(`${entry.id}\t${entry.amountCents}\t${entry.kind}\tfee ${entry.feeCents}`);
        return 0;
      }

      case 'balance': {
        const [accountId] = rest;
        if (!accountId) {
          io.err('usage: ledger balance <accountId>');
          return 2;
        }
        const balance = balanceFor(accountId);
        io.out(`${balance.balanceCents} ${balance.currency} over ${balance.entryCount} entries`);
        return 0;
      }

      case 'summary': {
        const [accountId] = rest;
        if (!accountId) {
          io.err('usage: ledger summary <accountId>');
          return 2;
        }
        for (const line of formatSummary(accountSummary(accountId))) {
          io.out(line);
        }
        return 0;
      }

      case 'sweep': {
        const [days] = rest;
        const olderThanDays = days ? Number.parseInt(days, 10) : 0;
        io.out(`retention window ${sweepWindowDays()} days`);
        const summary = await sweepSettled({ olderThanDays });
        io.out(`scanned ${summary.scanned}, settled ${summary.settled}, failed ${summary.failed}`);
        return summary.failed > 0 ? 1 : 0;
      }

      case 'config': {
        for (const [key, value] of Object.entries(describeConfig())) {
          io.out(`${key}=${String(value)}`);
        }
        return 0;
      }

      default: {
        io.err(`unknown command: ${command}`);
        io.err(USAGE);
        return 2;
      }
    }
  } catch (error) {
    if (isLedgerError(error)) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { modelLock } from './model-job';
import { channelKey } from './neon-seller';
import { neonTermsSchema, type NeonTerms } from './neon-terms';
import { CliError } from '../lib/errors';
import { writePrivate } from './store-files';

/**
 * WHERE EACH NEON CHANNEL STANDS, kept with the seller terms its jobs were paid under. A job's
 * end asks the seller for the channel's remainder through the cooperative refund. A refund that
 * fails stays here, with the saved terms, so `tenjin refund` asks again, and falls back to the
 * channel's timed on-chain withdrawal, without a new provider lookup: a changed catalog row, a
 * failed lookup or a restart never moves a refund away from the channel the money is in.
 */
const entrySchema = z.object({
  /** The channel's key: the seller's origin and payee. The payer is the wallet. */
  key: z.string(),
  /**
   * The channel's salt, which is part of its identity. Absent is the SDK's own (zero) salt. A
   * channel RETIRED because a voucher left it unsettled is never deposited into again: the next
   * channel of the same payer and seller has a salt of its own, so that voucher has no funds to
   * reach there. The retired entry stays, for a late settlement, the refund and the withdrawal.
   */
  salt: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
  retired: z.boolean().optional(),
  terms: neonTermsSchema,
  jobIds: z.array(z.string()).max(200),
  /**
   * How many times a job has opened this channel to pay on it. A refund in flight writes its result
   * only if no job opened the channel meanwhile: a newer deposit it never saw stays open.
   */
  epoch: z.number().int().default(0),
  /** Jobs whose run has ended since they last sent a call: they no longer use the channel. */
  ended: z.array(z.string()).max(200).default([]),
  state: z.enum(['open', 'refunded', 'empty', 'failed', 'withdrawal_started', 'withdrawn']),
  at: z.number(),
  /** The funded channel's own config, kept from the first call that funded it. */
  channel: z
    .object({
      payer: z.string(),
      receiverAuthorizer: z.string(),
      withdrawDelay: z.number().int().min(1),
      salt: z.string().optional(),
    })
    .optional(),
  /** The last refusal or failure, in words, for the person. */
  note: z.string().max(500).optional(),
  refundedAtomic: z.string().regex(/^\d+$/).optional(),
  transaction: z.string().optional(),
  /** The timed withdrawal: when it was started on chain, in chain seconds, and the amount. */
  withdrawal: z
    .object({
      initiatedAt: z.number(),
      delayS: z.number(),
      amountAtomic: z.string().regex(/^\d+$/),
      transaction: z.string().optional(),
    })
    .optional(),
});
export type ChannelEntry = z.infer<typeof entrySchema>;
const fileSchema = z.object({ version: z.literal(1), channels: z.array(entrySchema) });

const journalPath = (dataDir: string) => join(dataDir, 'neon-channels.json');

/** What the journal may grow to before it is refused rather than read. */
const JOURNAL_MAX_BYTES = 8_000_000;

/**
 * THE JOURNAL, READ STRICTLY. A journal that is absent is empty; one that exists and cannot be
 * read (too big, damaged, or not what this build writes) is NEVER empty: reading it as empty and
 * then writing would erase the salts and saved configs `tenjin refund` needs to recover deposits.
 * It is refused with a message, and the file is left as it is.
 */
async function readJournal(dataDir: string): Promise<ChannelEntry[]> {
  const path = journalPath(dataDir);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      return undefined;
    },
  );
  if (file === null) return [];
  const unreadable = (why: string) =>
    new CliError(
      'CONFIG_INVALID',
      `The record of Neon channels (${path}) exists but cannot be read (${why}). Nothing was changed and no call was made: it holds what \`tenjin refund\` needs to recover deposits, so it is kept as it is. Move it aside only after copying it.`,
    );
  if (file === undefined) throw unreadable('it cannot be opened');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw unreadable('it is not a regular file');
    if (stat.size > JOURNAL_MAX_BYTES)
      throw unreadable(`it is ${stat.size} bytes, over ${JOURNAL_MAX_BYTES}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse((await file.readFile('utf8')) || 'null');
    } catch {
      throw unreadable('it is not valid JSON');
    }
    const checked = fileSchema.safeParse(parsed);
    if (!checked.success) throw unreadable('it does not match what this build writes');
    return checked.data.channels;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** What the cooperative refund came to. */
export type RefundResult =
  | { state: 'refunded'; amountAtomic?: string; transaction?: string }
  | { state: 'empty' }
  | { state: 'failed'; note: string };

/** Words the SDK uses when there is nothing to take back. */
const NOTHING = /no remaining balance|requires an existing channel record/i;

/** How long one cooperative refund may take at most, whatever else bounds it. */
export const REFUND_TIMEOUT_MS = 60_000;

/**
 * One cooperative refund, read as a result. It never throws. `signal` bounds it from outside (the
 * job's end gives it a few seconds): it reaches the seller's request, and where a payer ignores it
 * the wait still ends, with a refund that failed and stays on record for `tenjin refund`.
 */
export async function cooperativeRefund(
  payer: { refund(signal: AbortSignal): Promise<unknown> },
  signal?: AbortSignal,
): Promise<RefundResult> {
  const bound = AbortSignal.any([
    AbortSignal.timeout(REFUND_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  const ended = new Promise<never>((_, reject) => {
    const stop = () =>
      reject(new Error('The refund took too long and was left for `tenjin refund`'));
    if (bound.aborted) stop();
    else bound.addEventListener('abort', stop, { once: true });
  });
  ended.catch(() => undefined);
  try {
    const settled = (await Promise.race([payer.refund(bound), ended])) as {
      success?: boolean;
      transaction?: string;
      amount?: string;
      errorReason?: string;
    };
    if (settled.success === false)
      return { state: 'failed', note: settled.errorReason ?? 'The seller did not refund' };
    return {
      state: 'refunded',
      ...(typeof settled.amount === 'string' && /^\d+$/.test(settled.amount)
        ? { amountAtomic: settled.amount }
        : {}),
      ...(typeof settled.transaction === 'string' && settled.transaction.length > 0
        ? { transaction: settled.transaction }
        : {}),
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    return NOTHING.test(note) ? { state: 'empty' } : { state: 'failed', note: note.slice(0, 400) };
  }
}

/** The channel config a funded channel was kept with. */
export type SavedChannel = NonNullable<ChannelEntry['channel']>;

/** The chain a timed withdrawal needs: reads and one transaction, injected so tests need no chain. */
export interface WithdrawChain {
  /** The channel's balance and what the seller has claimed of it. */
  channel(
    terms: NeonTerms,
    saved?: SavedChannel,
  ): Promise<{
    id: string;
    balanceAtomic: bigint;
    claimedAtomic: bigint;
    pendingAtomic: bigint;
    initiatedAt: number;
    delayS: number;
    nowS: number;
  }>;
  /** Starts the withdrawal of `amountAtomic`, and returns the transaction. */
  initiate(terms: NeonTerms, amountAtomic: bigint, saved?: SavedChannel): Promise<string>;
  /** Finishes a withdrawal whose delay has passed, and returns the transaction. */
  finalize(terms: NeonTerms, saved?: SavedChannel): Promise<string>;
}

export type NeonRefundsOptions = {
  dataDir: string;
  /** The payer of one seller's saved terms. It deposits nothing. */
  payer: (terms: NeonTerms, salt?: string) => { refund(signal: AbortSignal): Promise<unknown> };
  /**
   * Whether a job's runner is alive (the job store's runner lock). A job with no live runner
   * never holds a channel back, so a crashed job cannot block a refund for ever. Where this
   * throws, the job counts as live: the refund waits, and `tenjin refund` still returns it.
   */
  live?: (jobId: string) => Promise<boolean>;
  now?: () => number;
};

export class NeonRefunds {
  constructor(private options: NeonRefundsOptions) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }

  async entries(): Promise<ChannelEntry[]> {
    return readJournal(this.options.dataDir);
  }
  private async change(
    update: (channels: ChannelEntry[]) => ChannelEntry[] | Promise<ChannelEntry[]>,
  ) {
    const path = journalPath(this.options.dataDir);
    await modelLock(`${path}.lock`, async () => {
      const channels = await update(await this.entries());
      await writePrivate(path, JSON.stringify({ version: 1, channels }));
    });
  }

  /**
   * A job paid on this channel: it is on record before any money moves, under the job's terms.
   * It names the channel's salt: none for the first channel of a payer and seller, and a salt of
   * its own for one that follows a retired channel.
   */
  async open(jobId: string, terms: NeonTerms): Promise<{ salt?: string }> {
    const key = channelKey(terms);
    let salt: string | undefined;
    await this.change((channels) => {
      const known = channels.find((entry) => entry.key === key);
      if (!known) {
        const followsRetired = channels.some(
          (entry) => entry.retired && entry.key.startsWith(`${key}.`),
        );
        salt = followsRetired ? `0x${randomBytes(32).toString('hex')}` : undefined;
        return [
          ...channels,
          {
            key,
            terms,
            jobIds: [jobId],
            ended: [],
            epoch: 1,
            state: 'open' as const,
            at: this.now(),
            ...(salt ? { salt } : {}),
          },
        ];
      }
      salt = known.salt;
      return channels.map((entry) =>
        entry.key !== key
          ? entry
          : {
              ...entry,
              // The terms the money went under stay the ones a refund uses.
              jobIds: [...new Set([...entry.jobIds, jobId])].slice(-200),
              // It sends again, so it uses the channel again.
              ended: entry.ended.filter((id) => id !== jobId),
              epoch: entry.epoch + 1,
              state: entry.state === 'withdrawal_started' ? entry.state : ('open' as const),
              // The channel is used again: what the last refund returned is no longer its state.
              ...(entry.state === 'withdrawal_started'
                ? {}
                : { refundedAtomic: undefined, transaction: undefined }),
              at: this.now(),
            },
      );
    });
    return salt === undefined ? {} : { salt };
  }

  /**
   * RETIRES THE CHANNEL A VOUCHER LEFT UNSETTLED. A voucher is a claim on the channel with no
   * expiry and no nonce: any signed voucher whose amount is above what was claimed and within
   * the channel's balance can be claimed, the highest first, and a later voucher with a lower
   * amount does not void it. A deposit into the same channel would put funds in its reach, so
   * the channel is never deposited into again: its entry is renamed and kept (its jobs, its
   * saved config and salt, its state), and the next call opens a channel with a salt of its own.
   * The refund and the timed withdrawal still reach the retired channel.
   */
  async retire(terms: NeonTerms): Promise<void> {
    const key = channelKey(terms);
    await this.change((channels) =>
      channels.map((entry) =>
        entry.key !== key
          ? entry
          : { ...entry, key: `${key}.${this.now().toString(36)}`, retired: true, at: this.now() },
      ),
    );
  }

  /**
   * Keeps the config of the channel a job funded. The first one saved stays: a later call whose
   * seller names another receiver authorizer or delay is not the channel the money is in.
   */
  async saveChannel(terms: NeonTerms, channel: SavedChannel): Promise<void> {
    const key = channelKey(terms);
    await this.change((channels) =>
      channels.map((entry) =>
        entry.key === key && entry.channel === undefined
          ? { ...entry, channel: entry.salt ? { ...channel, salt: entry.salt } : channel }
          : entry,
      ),
    );
  }

  private async record(key: string, result: RefundResult, epoch: number) {
    await this.change((channels) =>
      channels.map((entry) =>
        // A job that opened the channel since this refund began has put money in it that this
        // result knows nothing of: the channel stays open.
        entry.key !== key || entry.epoch !== epoch
          ? entry
          : {
              ...entry,
              state: result.state,
              at: this.now(),
              ...(result.state === 'failed' ? { note: result.note } : { note: undefined }),
              // What an earlier refund returned is not this result's: only a refund that happened now
              // names an amount and a transaction.
              refundedAtomic:
                result.state === 'refunded' && result.amountAtomic
                  ? result.amountAtomic
                  : undefined,
              transaction:
                result.state === 'refunded' && result.transaction ? result.transaction : undefined,
            },
      ),
    );
  }

  /**
   * THE END OF A RUN: the jobs that ended are marked, and each channel they paid on is asked for
   * its remainder ONLY IF no other job of it still runs. The last job to end does the refund: one
   * that ends while another job uses the channel leaves the remainder to that one. The marks and
   * the count are read and written under the journal's lock, so two jobs ending together cannot
   * both see the other alive. A job with no live runner does not count. Never throws: a refund
   * that fails stays on record as `failed`, for `tenjin refund`.
   */
  async settle(jobIds: readonly string[], signal: AbortSignal): Promise<ChannelEntry[]> {
    const ids = new Set(jobIds);
    const due: ChannelEntry[] = [];
    await this.change(async (channels) => {
      const next: ChannelEntry[] = [];
      for (const entry of channels) {
        if (!entry.jobIds.some((id) => ids.has(id))) {
          next.push(entry);
          continue;
        }
        const ended = [...new Set([...entry.ended, ...entry.jobIds.filter((id) => ids.has(id))])];
        let blocked = false;
        for (const id of entry.jobIds) {
          if (ended.includes(id)) continue;
          try {
            if (await (this.options.live?.(id) ?? Promise.resolve(false))) blocked = true;
          } catch {
            blocked = true;
          }
        }
        const updated = { ...entry, ended: ended.slice(-200) };
        next.push(updated);
        if (!blocked && (entry.state === 'open' || entry.state === 'failed')) due.push(updated);
      }
      return next;
    });
    for (const entry of due)
      await this.record(
        entry.key,
        await cooperativeRefund(this.options.payer(entry.terms, entry.salt), signal),
        entry.epoch,
      );
    return this.entries();
  }

  /** Whether a job that has not ended still pays from this channel: its runner is alive. */
  private async inUse(entry: ChannelEntry): Promise<boolean> {
    for (const id of entry.jobIds) {
      if (entry.ended.includes(id)) continue;
      try {
        if (await (this.options.live?.(id) ?? Promise.resolve(false))) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * `tenjin refund`: every channel that still holds a remainder is asked again from its saved
   * terms. Where the seller does not answer and a chain is given, the channel's timed withdrawal
   * starts, or finishes once its delay has passed. Nothing here reads the catalog.
   */
  async retry(chain?: WithdrawChain): Promise<ChannelEntry[]> {
    for (const entry of await this.entries()) {
      if (entry.state === 'refunded' || entry.state === 'empty' || entry.state === 'withdrawn')
        continue;
      // The same rule as a job's end: a channel a live job in another session pays from is left
      // alone, whether for a refund or for a withdrawal that would pull its money out from under it.
      if (await this.inUse(entry)) {
        await this.change((channels) =>
          channels.map((c) =>
            c.key === entry.key
              ? {
                  ...c,
                  note: 'A Neon job still pays from this channel. Run `tenjin refund` again when it ends.',
                }
              : c,
          ),
        );
        continue;
      }
      if (entry.state !== 'withdrawal_started') {
        const result = await cooperativeRefund(this.options.payer(entry.terms, entry.salt));
        await this.record(entry.key, result, entry.epoch);
        if (result.state !== 'failed' || !chain) continue;
      }
      if (chain) await this.withdraw(entry, chain);
    }
    await this.prune(chain).catch(() => 0);
    return this.entries();
  }

  /**
   * FORGETS WHAT IS PROVABLY FINISHED, so retired channels do not pile up. A retired channel is
   * never deposited into again, so it has nothing left to recover when the chain shows that its
   * balance equals what was claimed and that no withdrawal is pending: nothing unclaimed is in it
   * and nothing is on its way out. That proof is a chain read (`channels` and
   * `pendingWithdrawals`), made here. A retired channel with no saved config never had a payment
   * created for it, so it never held anything. A channel the read cannot prove stays.
   */
  async prune(chain?: WithdrawChain): Promise<number> {
    const finished = new Set<string>();
    for (const entry of await this.entries()) {
      if (!entry.retired) continue;
      if (!entry.channel) {
        finished.add(entry.key);
        continue;
      }
      if (!chain) continue;
      try {
        const seen = await chain.channel(entry.terms, entry.channel);
        if (seen.balanceAtomic === seen.claimedAtomic && seen.pendingAtomic === 0n)
          finished.add(entry.key);
      } catch {
        // Unproven stays.
      }
    }
    if (finished.size === 0) return 0;
    await this.change((channels) => channels.filter((entry) => !finished.has(entry.key)));
    return finished.size;
  }

  private async withdraw(entry: ChannelEntry, chain: WithdrawChain) {
    const set = (patch: Partial<ChannelEntry>) =>
      this.change((channels) =>
        channels.map((c) => (c.key === entry.key ? { ...c, ...patch, at: this.now() } : c)),
      );
    try {
      const seen = await chain.channel(entry.terms, entry.channel);
      if (seen.pendingAtomic > 0n && seen.initiatedAt > 0) {
        if (seen.nowS < seen.initiatedAt + seen.delayS) {
          await set({
            state: 'withdrawal_started',
            withdrawal: {
              initiatedAt: seen.initiatedAt,
              delayS: seen.delayS,
              amountAtomic: seen.pendingAtomic.toString(),
              ...(entry.withdrawal?.transaction
                ? { transaction: entry.withdrawal.transaction }
                : {}),
            },
          });
          return;
        }
        const transaction = await chain.finalize(entry.terms, entry.channel);
        await set({
          state: 'withdrawn',
          transaction,
          refundedAtomic: seen.pendingAtomic.toString(),
        });
        return;
      }
      const left = seen.balanceAtomic - seen.claimedAtomic;
      if (left <= 0n) {
        await set({ state: 'empty' });
        return;
      }
      const transaction = await chain.initiate(entry.terms, left, entry.channel);
      await set({
        state: 'withdrawal_started',
        withdrawal: {
          initiatedAt: seen.nowS,
          delayS: seen.delayS,
          amountAtomic: left.toString(),
          transaction,
        },
      });
    } catch (error) {
      await set({
        state: 'failed',
        note: `The channel withdrawal failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          400,
        ),
      });
    }
  }
}

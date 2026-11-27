import { join } from 'node:path';
import { z } from 'zod';
import { modelLock } from './model-job';
import { channelKey } from './neon-seller';
import { neonTermsSchema, type NeonTerms } from './neon-terms';
import { readJsonFile, writePrivate } from './store-files';

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
  payer: (terms: NeonTerms) => { refund(signal: AbortSignal): Promise<unknown> };
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
    const parsed = fileSchema.safeParse(
      await readJsonFile(journalPath(this.options.dataDir), 1_000_000),
    );
    return parsed.success ? parsed.data.channels : [];
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

  /** A job paid on this channel: it is on record before any money moves, under the job's terms. */
  async open(jobId: string, terms: NeonTerms): Promise<void> {
    const key = channelKey(terms);
    await this.change((channels) => {
      const known = channels.find((entry) => entry.key === key);
      if (!known)
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
          },
        ];
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
              at: this.now(),
            },
      );
    });
  }

  /**
   * Keeps the config of the channel a job funded. The first one saved stays: a later call whose
   * seller names another receiver authorizer or delay is not the channel the money is in.
   */
  async saveChannel(terms: NeonTerms, channel: SavedChannel): Promise<void> {
    const key = channelKey(terms);
    await this.change((channels) =>
      channels.map((entry) =>
        entry.key === key && entry.channel === undefined ? { ...entry, channel } : entry,
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
              ...(result.state === 'refunded'
                ? {
                    ...(result.amountAtomic ? { refundedAtomic: result.amountAtomic } : {}),
                    ...(result.transaction ? { transaction: result.transaction } : {}),
                  }
                : {}),
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
        await cooperativeRefund(this.options.payer(entry.terms), signal),
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
        const result = await cooperativeRefund(this.options.payer(entry.terms));
        await this.record(entry.key, result, entry.epoch);
        if (result.state !== 'failed' || !chain) continue;
      }
      if (chain) await this.withdraw(entry, chain);
    }
    return this.entries();
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

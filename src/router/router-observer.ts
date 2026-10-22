import { readWalletFacts, unlockStamp } from '../lib/wallet-facts';
import type { UnlockReason } from '../lib/wallet-unlock';
import {
  pruneDeadObservations,
  readUnlockRecord,
  removeObservationSync,
  writeObservation,
  writeUnlockRecord,
  type RouterObservation,
  type UnlockRecord,
} from './router-observation';
import type { WalletNews } from './hooks';
import type { PayerObservation } from './routing-payer';
import { stillLockedSentence, WALLET_UNLOCKED } from './wallet-reasons';

/**
 * WHAT THIS `tenjin mcp` SAW, written down for the processes that cannot ask
 * it (doctor, install), and the one-time wallet lines it owes the session it
 * serves. One per router process, built in `runRouterMcpServer`.
 *
 * - THE OBSERVATION (`router/live/<pid>.json`): the payer's sign and routing
 *   verdicts as they change ({@link RouterObserver.observe}), the env's shape
 *   (whether a variable is set, never its value) and whether this router has
 *   served a session. Removed when the process exits.
 * - THE WALLET NEWS ({@link RouterObserver.takeNews}): "Tenjin wallet
 *   unlocked." after a repair or an earlier block, a still-locked line when a
 *   repair did not take, and the payer provider's wrong-variable warning.
 *
 * A HEALTH-CHECK ROUTER IS NOT A SESSION (B2). `claude mcp get` and `claude mcp
 * list` start a `tenjin mcp` that answers `tools/list` and exits. It prewarms
 * like any other, and its observation says what the prewarm saw, but it stays
 * `servedSession: false` and NEVER reads or writes unlock-state: otherwise a
 * doctor run would consume the `awaiting_confirmation` a repair left for the
 * real session, and "Tenjin wallet unlocked." would never be said. Only the
 * first hook leg carrying a session id (`takeNews`) makes this router the
 * running Claude session.
 *
 * Nothing here ever holds a passphrase, a key, an env value or a store's
 * output: the verdicts carry reasons and wording only.
 */
export interface RouterObserver {
  /** The payer's `observe`: merge a verdict change and rewrite the observation. */
  observe: (u: PayerObservation) => void;
  /** The payer's memo stamp: wallet.json and sidecar mtimes. */
  unlockStamp: () => Promise<string>;
  /** Deduped one-time lines (ENV_PASSPHRASE_WRONG from the payer provider's onWarning). */
  queueNews: (line: string) => void;
  /** HookDeps.walletNews. */
  takeNews: (sessionId: string) => Promise<WalletNews>;
  /** Remove the exit handler and the observation (tests; the process exit does it otherwise). */
  dispose: () => void;
}

export function createRouterObserver(o: {
  dataDir: string;
  pid: number;
  startedAt: number;
  cliVersion: string;
  harness: 'claude' | 'codex';
  launchedByPlugin: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}): RouterObserver {
  const now = o.now ?? Date.now;
  let observation: RouterObservation = {
    version: 1,
    pid: o.pid,
    startedAt: o.startedAt,
    at: now(),
    cliVersion: o.cliVersion,
    harness: o.harness,
    launchedByPlugin: o.launchedByPlugin,
    cwd: o.cwd,
    address: null,
    servedSession: false,
    env: {
      passphraseSet: (o.env.TENJIN_WALLET_PASSPHRASE ?? '').length > 0,
      keySet: (o.env.TENJIN_WALLET_KEY?.trim() ?? '').length > 0,
    },
    sign: { status: 'pending' },
  };
  /** One-time lines not yet delivered, in order, each once. */
  const queue: string[] = [];
  /** Whether a leg's ack has settled this process's confirmation (step 4). */
  let settled = false;
  /**
   * What a leg still in flight has claimed: its queued lines, and whether it
   * holds the confirmation. Legs overlap (parallel WebSearch calls each run a
   * hook), and a claimed line or confirmation is no other leg's until the leg
   * holding it acks or releases it, so each is said once.
   */
  const claimed = new Set<string>();
  let confirming = false;
  let disposed = false;

  // Writes go one after another, so the file always ends at the latest state.
  let writes: Promise<void> = pruneDeadObservations(o.dataDir).catch(() => undefined);
  const write = (): void => {
    const snapshot = observation;
    writes = writes.then(() => (disposed ? undefined : writeObservation(o.dataDir, snapshot)));
  };
  write();

  const onExit = (): void => removeObservationSync(o.dataDir, o.pid);
  process.once('exit', onExit);

  /** The unlock-state record for the current verdict, with the file facts it saw. */
  async function verdictRecord(): Promise<{ address: string; record: UnlockRecord } | null> {
    const sign = observation.sign;
    if (sign.status === 'pending') return null;
    const facts = await readWalletFacts(o.dataDir, o.env);
    const address = observation.address ?? facts.address;
    if (address === null) return null;
    return {
      address,
      record: {
        version: 1,
        address,
        status: sign.status,
        ...(sign.reason !== undefined ? { reason: sign.reason } : {}),
        at: now(),
        inputs: {
          envPassphraseSet: facts.envPassphraseSet,
          envKeySet: facts.envKey !== 'absent',
          walletMtimeMs: facts.walletMtimeMs,
          sidecarMtimeMs: facts.sidecarMtimeMs,
          cliVersion: o.cliVersion,
        },
      },
    };
  }

  return {
    observe(u) {
      const signChanged = u.sign !== undefined;
      observation = {
        ...observation,
        ...(u.sign !== undefined ? { sign: u.sign } : {}),
        ...(u.routing !== undefined ? { routing: u.routing } : {}),
        ...(u.address !== undefined ? { address: u.address } : {}),
        at: now(),
      };
      write();
      // Step 5: once this served router has settled the confirmation, every
      // later sign change is the machine's latest unlock verdict.
      if (settled && observation.servedSession && signChanged) {
        void verdictRecord()
          .then((v) => (v === null ? undefined : writeUnlockRecord(o.dataDir, v.record)))
          .catch(() => undefined);
      }
    },

    unlockStamp: async () => unlockStamp(await readWalletFacts(o.dataDir, o.env)),

    queueNews(line) {
      if (!queue.includes(line)) queue.push(line);
    },

    async takeNews(_sessionId) {
      // Step 1: from here on this router is the running Claude session.
      if (!observation.servedSession) {
        observation = { ...observation, servedSession: true, at: now() };
        write();
      }
      const queued = queue.filter((line) => !claimed.has(line));
      for (const line of queued) claimed.add(line);
      const lines = [...queued];
      const sign = observation.sign;
      // Step 2: no verdict yet (the prewarm is still unlocking): only the
      // queued lines, and unlock-state is not read.
      let confirmation: { address: string; record: UnlockRecord } | null = null;
      const hasVerdict =
        sign.status !== 'pending' && !(sign.status === 'unknown' && sign.reason === 'not_checked');
      const confirms = !settled && !confirming && hasVerdict;
      if (confirms) {
        // Claimed before the first await, so an overlapping leg skips it.
        confirming = true;
        // Step 3: compare the verdict with what the machine recorded last.
        confirmation = await verdictRecord().catch(() => null);
        if (confirmation !== null) {
          const prev = await readUnlockRecord(o.dataDir, confirmation.address);
          if (
            sign.status === 'ready' &&
            (prev?.status === 'blocked' || prev?.status === 'awaiting_confirmation')
          ) {
            lines.push(WALLET_UNLOCKED);
          }
          if (sign.status === 'blocked' && prev?.status === 'awaiting_confirmation') {
            lines.push(stillLockedSentence((sign.reason ?? 'wallet_locked') as UnlockReason));
          }
        }
      }
      // Step 4: nothing is marked delivered until the leg carrying these
      // lines has built its response; a leg that fails releases them.
      let done = false;
      const unclaim = (): void => {
        for (const line of queued) claimed.delete(line);
        if (confirms) confirming = false;
      };
      return {
        lines,
        ack: async () => {
          if (done) return;
          done = true;
          for (const line of queued) {
            const at = queue.indexOf(line);
            if (at !== -1) queue.splice(at, 1);
          }
          unclaim();
          if (confirmation !== null && !settled) {
            settled = true;
            await writeUnlockRecord(o.dataDir, confirmation.record);
          }
        },
        release: () => {
          if (done) return;
          done = true;
          unclaim();
        },
      };
    },

    dispose() {
      disposed = true;
      process.removeListener('exit', onExit);
      removeObservationSync(o.dataDir, o.pid);
      // A write already under way when this ran lands after it: remove again.
      void writes.then(() => removeObservationSync(o.dataDir, o.pid));
    },
  };
}

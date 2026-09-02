import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import {
  openStore,
  projectId,
  repoSlug,
  shortHash,
  storeSession,
  teamCoarseKey,
  GIT_WALK_MAX,
  STATE_PAIRING_FIX_PREFIX,
  STORE_SQL,
  type Store,
} from '../lib/state-store';
import { attestFix, isSelfAttest, upsertFix, type FixKeyInput } from '../lib/fixes-api';
import { scan, survivesTeamDrop, type ScanFinding } from '../lib/scan';
import { resolveWriteAuth } from '../lib/consent';
import {
  describeWallet,
  resolveWalletProvider,
  type TenjinSigner,
  type WalletProvider,
} from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin sync` (docs/command-reference.md, "Team shelf"): hand this checkout's
 * closed, code-scoped failure→fix pairings to the team shelf's FIX STORE, so a
 * fix a teammate's machine already made travels to the next machine that hits
 * the same failure beside its error — without anyone writing a note. The Stop
 * hook spawns it detached after a session that closed such a pairing (see
 * spawnSyncIfNeeded in lib/hook-scripts.ts); it is also runnable by hand, which
 * is the fallback the Stop ask prints when a spawned run could not sign.
 *
 * A FIX IS NOT A POST (the fixes contract, v1). It has no title, no body, no
 * card and no price: the record is the keys, the files that changed, the head
 * that passed and the versions it was true at. Nothing it writes reaches
 * `posts` or the search gate, and the titles this command used to synthesize
 * ("Fix: pnpm — TS2304") are gone with them.
 *
 * TEAM MODE ONLY. `POST /api/fixes` and `POST /api/fixes/resolve` are gated on
 * the same `KNOWLEDGE_KEYS` flag as the team shelf's by-key lookup; a
 * public-mode machine has no private shelf to hold a fix and no route to read
 * it back, so this hard-refuses rather than pushing a team's build failures at
 * the public marketplace.
 */
export interface SyncDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  /** Force the plain-SIWX write path (default: cached session key). */
  useSession?: boolean;
  /** Environment seam; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * The checkout whose pairings sync; defaults to `process.cwd()`. `tenjin sync
   * --cwd <path>` sets it, and the Stop hook passes the hook payload's own cwd
   * string there when it spawns the child.
   *
   * THE STRING, NOT THE RESOLVED PATH (tenjin-agent#249). `pairings.project` is
   * `projectId(cwd)` over the cwd the payload carried, and `process.cwd()` is
   * that path with every symlink resolved, so a session running under a symlinked
   * checkout hashes one way in the hook and another way here — the hook counted
   * unsynced rows the sync it spawned then could not see, and the run reported
   * "Nothing to sync." forever.
   */
  cwd?: string;
}

/** One pairing as `tenjin sync` reads it back out of the store (raw columns). */
interface PairingRow {
  id: number;
  /** The lane: `'test'` (a file+suite+test identity) or `'sig_v2'` (a
   *  message+errno+frame signature, the default). It decides the fix record's
   *  `primary.kind` and whether a coarse key travels at all. */
  kind: string;
  key: string;
  coarseKey: string | null;
  cmdHead: string | null;
  cmd: string | null;
  errorLine: string | null;
  errorFiles: string[];
  fixCmd: string | null;
  fixFiles: string[];
  pkgVersions: Record<string, string>;
  status: string;
  syncedAt: number | null;
}

/** A signing failure (an expired session with a locked keychain) is coded and
 *  ends the whole run: the Stop hook writes an `events` row for it and retries
 *  next turn, and the fallback line tells the operator to run this by hand. */
class SyncSigningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SyncSigningError';
  }
}

/** At most this many fix files travel with one record; the contract caps it at
 *  16 and each entry at 200 characters. */
const FIX_FILES_MAX = 16;
/** At most this many keys per fix record (contract: ≤ 8). */
const FIX_KEYS_MAX = 8;

export async function runSync(ctx: CommandContext, deps: SyncDeps = {}): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const runtime = await resolveContextSettings(ctx);

  // HARD REFUSE outside team mode. Not a silent no-op: a machine that meant to be
  // in team mode but is not (the secret set without the shelf baseUrl, the
  // half-done setup docs/command-reference.md warns about) should hear why nothing synced.
  if (!runtime.teamMode) {
    throw new CliError(
      'REFUSED',
      'tenjin sync only runs in team mode: it records fixed failures in your team shelf’s fix store, reachable only through that shelf’s by-key lookup.',
      {
        fix: 'Set a team shelf (config set baseUrl <your shelf>, config set shelfBypassSecret <secret>); see docs/command-reference.md, "Team shelf".',
      },
    );
  }

  const store = await openStore(ctx.dataDir);
  if (store === null) {
    // Fail open, same as every other store consumer: an unreadable store is not a
    // reason to exit nonzero, there is simply nothing to sync.
    return {
      data: { synced: 0, attested: 0, skipped: 0, local: 0, pending: 0 },
      humanLines: ['Nothing to sync.'],
    };
  }
  try {
    const project = projectId(cwd);
    const rows = store
      .all(STORE_SQL.unsyncedPairings, [project])
      .map(readPairing)
      .filter((r): r is PairingRow => r !== null);
    if (rows.length === 0) {
      return {
        data: { synced: 0, attested: 0, skipped: 0, local: 0, pending: 0 },
        humanLines: ['Nothing to sync.'],
      };
    }

    // The repo the origin salt is read from — a file read of .git/config, never a
    // git spawn (mirrors isTrackedPath's "no git invocation" rule). Read once for
    // the whole run: every row of this checkout salts against the same repo.
    const repo = readRepoSlug(cwd) ?? '';
    // NO REMOTE, NO SHELF (#256, owner decision). '' is what stands in for a
    // repo scope this checkout does not have — a clone from a local path, a
    // scratch directory, a mirror under another remote name — and it is not a
    // salt. Recording under it would put every origin-less checkout on the
    // team's shelf into ONE coarse bucket, and a coarse hit is rank 1 with no
    // relevance check to run, so a scratch directory's fix would come back
    // beside an unrelated one as a strong teammate match. The failure arm's
    // resolve leg stops asking under the same condition, for the same reason.
    //
    // NOTHING IS STAMPED: `synced_at` stays NULL on every row, because these
    // pairings are not synced, they are local. If the checkout later gains an
    // origin, the next run records them. The Stop hook does not spawn a sync
    // here at all (it reads the same slug first), so this path is a hand run.
    if (repo === '') {
      return {
        data: { synced: 0, attested: 0, skipped: 0, local: rows.length, pending: 0 },
        humanLines: [
          `Nothing to sync: this checkout has no git origin, so its ${rows.length} fixed ${
            rows.length === 1 ? 'pairing stays' : 'pairings stay'
          } local.`,
        ],
      };
    }
    // The shelf a link row names: the team shelf, which is the only place a
    // fix record ever goes.
    const origin = new URL(runtime.baseUrl).origin;

    // The wallet, lazily. describe() gives the address WITHOUT unlocking the
    // keystore, so a cached-session sync never touches the keychain; the unlock
    // happens only inside a sign, which happens only when the session must be
    // (re)established — that is where a locked keychain surfaces its coded error.
    const provider = resolveWalletProvider(
      ctx,
      deps.provider !== undefined ? { provider: deps.provider } : {},
    );
    const description = await describeWallet(provider); // surfaces WALLET_MISSING
    const signer = lazySigner(provider, description.address);
    const auth = resolveWriteAuth({
      signer,
      baseUrl: runtime.baseUrl,
      dataDir: ctx.dataDir,
      scope: 'read+write',
      ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
      env,
    });
    const client = {
      baseUrl: runtime.baseUrl,
      timeoutMs: ctx.flags.timeout,
      ...(runtime.bypass !== undefined ? { bypass: runtime.bypass } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    };

    let synced = 0;
    let attested = 0;
    let skipped = 0;
    const now = () => Date.now();
    try {
      for (const row of rows) {
        // The link row (`pairing_fix:<id>`, written by the failure arm's team
        // leg when it opened this pairing beside a teammate's fix, or by a
        // previous run of this command when it upserted the row) decides which
        // of the two writes this row earns:
        //  - NO LINK, or OUR OWN fix: upsert. The server's holder rule
        //    (creator, kind, key, repo) is the dedup, so a repeat is a 200
        //    `created: false` rather than a duplicate.
        //  - A TEAMMATE's fix that this machine has now closed locally: that is
        //    the second, independent confirmation, and the shelf has no close
        //    endpoint. Their record is theirs — every write route is
        //    owner-scoped — so this machine ATTESTS to it with its own fix
        //    files instead of publishing a near-duplicate under its own name.
        const link = getLink(store, row.id);
        const own = link === null || link.own === true;

        // THE SAME SCAN EVERY PUBLISH RUNS, minus the warn tier a team shelf
        // drops (survivesTeamDrop, as commands/publish.ts filters it). The
        // fields are scrubbed on the way into the row, so this is the second
        // look: a credential that survived the scrub in a command line or a
        // filename stays on this machine. Nobody can --yes an automatic run,
        // and the payload is the same next run, so a finding marks the row
        // synced (never retried) rather than blocking every row behind it.
        if (scanFindings(row).length > 0) {
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          skipped += 1;
          continue;
        }

        const files = fixFilesFor(row);
        // NO FILES, NO RECORD. A fix record's whole payload is "these files
        // changed"; one with an empty list asserts nothing a teammate could
        // act on. The close rule already requires at least one tracked edit,
        // so this is the backstop for a row written by an older build.
        if (files.length === 0) {
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          skipped += 1;
          continue;
        }

        try {
          if (!own && link !== null) {
            await attestFix(link.fixId, files, auth, client);
            store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
            attested += 1;
            continue;
          }
          const result = await upsertFix(
            {
              primary: primaryFor(row),
              keys: keysFor(row, repo),
              repo,
              cmdHead: row.cmdHead ?? '',
              fixFiles: files,
              ...(passedOnHead(row) !== null ? { passedOnHead: passedOnHead(row) as string } : {}),
              pkgVersions: row.pkgVersions,
            },
            auth,
            client,
          );
          // Link first, then stamp: a crash between the two leaves a row that is
          // still unsynced and re-upserts (the holder rule dedups it on the
          // shelf side), never a synced row whose fix id is lost.
          //
          // AND THE SAME IS TRUE OF A FAILED WRITE, which is not a crash and
          // used to fall through to the stamp anyway. `store.run` swallows a
          // SQLite error and returns false, so the row would have been marked
          // synced with no link: nothing to attest against later, and no
          // unsynced row for a future run to pick up.
          if (
            !setLink(store, row.id, {
              fixId: result.fixId,
              origin,
              at: now(),
              own: true,
            })
          ) {
            continue;
          }
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          // `created: false` is the server saying this machine ALREADY HOLDS
          // this fix — the holder rule matched and nothing changed. The row is
          // stamped either way (there is nothing left to do with it); the
          // counter says what actually happened on the shelf.
          if (result.created) synced += 1;
          else skipped += 1;
        } catch (err) {
          if (err instanceof SyncSigningError) throw err; // aborts the whole run, below
          if (isSelfAttest(err)) {
            // The link says a teammate holds this fix and the server says it is
            // ours. The link is stale (a fix we upserted before the link was
            // rewritten); stamp and move on rather than retrying forever.
            store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
            skipped += 1;
            continue;
          }
          if (err instanceof CliError && err.code === 'RESOURCE_NOT_FOUND') {
            // The fix we meant to attest to is gone from the shelf (deleted, or
            // the link is stale): attesting will 404 on every future run too.
            // Stamp and move on so one dead link cannot block the queue.
            store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
            skipped += 1;
            continue;
          }
          // Anything else (network, 5xx, rate limit) may well succeed next run:
          // leave synced_at NULL and stop the whole run here rather than
          // reordering past this row and hiding a live outage as partial
          // progress on the rows behind it.
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof SyncSigningError) {
        // Coded, and the ONE outcome the automatic sync cannot recover on its own:
        // record it so the Stop hook can print the by-hand fallback, leave every
        // remaining row's synced_at NULL, and exit with the code. The next Stop
        // retries.
        recordSyncEvent(store, project, { code: err.code, synced, attested, skipped });
        throw new CliError(
          'PUBLISH_FAILED',
          `tenjin sync could not sign (${err.code}); ${synced + attested + skipped} of ${rows.length} pairings synced before it stopped.`,
          {
            fix: 'Run tenjin sync in a terminal where the wallet can unlock (the OS keychain or TENJIN_WALLET_PASSPHRASE), or start a session first.',
          },
        );
      }
      // Any other abort (network, 5xx, rate limit, a refused bypass) is
      // recorded too — as `error`, never `code`, because `code` is the signing
      // failure the Stop hook's fallback line is reserved for and "run it by
      // hand" is no answer to an outage. The next Stop retries.
      recordSyncEvent(store, project, {
        error: err instanceof CliError ? err.code : 'UNKNOWN',
        synced,
        attested,
        skipped,
      });
      throw err;
    }

    // A run that finished writes its own `hook: 'sync'` row WITHOUT a code, so
    // the Stop hook's fallback line (which reads the LAST sync row) goes quiet
    // the moment a later run succeeds, rather than outliving the failure.
    recordSyncEvent(store, project, { synced, attested, skipped });
    return {
      data: {
        synced,
        attested,
        skipped,
        local: 0,
        pending: rows.length - synced - attested - skipped,
      },
      humanLines: [
        `Recorded ${synced} new ${synced === 1 ? 'fix' : 'fixes'}, attested to ${attested}, skipped ${skipped}.`,
      ],
    };
  } finally {
    store.close();
  }
}

/** A signer that unlocks the keystore only when a signature is actually needed,
 *  tagging a keystore/passphrase failure as a coded SyncSigningError so the run
 *  can record it and stop. `address` comes from describe(), which never unlocks. */
function lazySigner(provider: WalletProvider, address: TenjinSigner['address']): TenjinSigner {
  const sign =
    <T>(fn: (s: TenjinSigner) => Promise<T>) =>
    async (): Promise<T> => {
      let s: TenjinSigner;
      try {
        s = await provider.getSigner();
      } catch (err) {
        throw new SyncSigningError(err instanceof CliError ? err.code : 'WALLET_MISSING');
      }
      return fn(s);
    };
  return {
    address,
    signMessage: (args) => sign((s) => s.signMessage(args))(),
    signTypedData: (args) => sign((s) => s.signTypedData(args))(),
    signTransaction: (tx) => sign((s) => s.signTransaction(tx))(),
  };
}

/**
 * The fix record's PRIMARY key: the lane the pairing was opened in, and its
 * fine hash. `'test'` rows carry a file+suite+test identity; everything else is
 * the `sig_v2` error signature. The two are exclusive — the failure arm picks
 * one from the command — so there is never a choice to make here.
 */
function primaryFor(row: PairingRow): { kind: 'test' | 'error'; key: string } {
  return { kind: row.kind === 'test' ? 'test' : 'error', key: row.key };
}

/**
 * Every key this fix answers.
 *
 * THE PRIMARY AT TIER `fine`, ALWAYS — the contract requires it. The coarse
 * key is sent ONLY for the error lane, salted with the repo slug so an
 * `ERR_PNPM_OUTDATED_LOCKFILE`-class message does not match a fix from every
 * repo the team has.
 *
 * ⚠ THE TEST LANE'S COARSE KEY IS NEVER SENT. It is file+suite, which every
 * failing test in a busy file shares: as a lookup key on a shared shelf it
 * would answer "somebody fixed something in this file" to every failure in it.
 * It stays a local replay hint, and the failure arm's resolve leg does not ask
 * for it either, so the two sides agree.
 *
 * The command head rides along as `command_head` metadata. It is never a lookup
 * key on its own — the server rejects a resolve request that asks for one — and
 * exists so a later ranking can use it.
 *
 * `repo` is never '' here: a checkout with no remote returns before this is
 * reached, recording nothing at all (#249).
 */
function keysFor(row: PairingRow, repo: string): FixKeyInput[] {
  const kind = row.kind === 'test' ? 'test' : 'error';
  const keys: FixKeyInput[] = [{ kind, key: row.key, tier: 'fine' }];
  if (kind === 'error' && row.coarseKey !== null && row.coarseKey.length > 0) {
    // Salt the coarse HASH, not the raw message+errno: the CLI has only the
    // stored hashes (message/errno exist only transiently inside the failure
    // arm's sigV2() call, never as columns), so `teamCoarseKey` — shared with
    // the resolve leg via lib/state-store.ts — salts what both sides actually
    // have (06, "Team-shelf coarse keys").
    keys.push({ kind: 'error', key: teamCoarseKey(row.coarseKey, repo), tier: 'coarse' });
  }
  if (row.cmdHead !== null && row.cmdHead.length > 0) {
    keys.push({ kind: 'command_head', key: row.cmdHead, tier: 'coarse' });
  }
  return keys.slice(0, FIX_KEYS_MAX);
}

/** The payload's file list: repo-relative paths as the close rule recorded
 *  them, bounded by the contract's own limits. */
function fixFilesFor(row: PairingRow): string[] {
  return row.fixFiles
    .filter((f) => typeof f === 'string' && f.length > 0 && f.length <= 200)
    .slice(0, FIX_FILES_MAX);
}

/** The head of the command that passed, or null. `fixCmd` carries the WHOLE
 *  scrubbed successful command (a scrubbed-to-`/` `cd /` prefix and pipeline
 *  tails included), so the head is derived rather than published raw. */
function passedOnHead(row: PairingRow): string | null {
  return row.fixCmd !== null && row.fixCmd.length > 0 ? fixCmdHead(row.fixCmd) : null;
}

/**
 * The publish scan over what would go on the wire — the file list, the command
 * head, the package versions — with the warn tier filtered exactly as
 * `tenjin publish` filters it on a team shelf (this command only runs in team
 * mode).
 *
 * THE PAYLOAD, NOT A RENDERED BODY. There is no title and no prose any more, so
 * what is scanned is the joined fields themselves: that is the whole of what
 * leaves the machine.
 */
function scanFindings(row: PairingRow): ScanFinding[] {
  const parts = [
    row.cmdHead ?? '',
    passedOnHead(row) ?? '',
    fixFilesFor(row).join('\n'),
    Object.entries(row.pkgVersions)
      .map(([name, version]) => `${name}@${version}`)
      .join('\n'),
  ];
  return scan(parts.join('\n')).filter(survivesTeamDrop);
}

/** Shell scaffolding (`cd`, `echo`, `printf`) and pipe-tail text filters
 *  (`grep`, `head`, ...) that never mark what actually FIXED a failure — only
 *  what shaped or scaffolded a prior command's output. Kept separate from
 *  push-scripts.ts's `FAILURE_HEADS`: that allowlist is generated hook-script
 *  SOURCE (a string this module cannot import, not a real binding) and is
 *  scoped to failure signatures, not to "what command passed". A denylist
 *  answers the looser "Passed on:" question well enough without a schema
 *  change to store a computed head at fix time. */
const FIX_CMD_NOISE_HEADS = new Set([
  'cd',
  'echo',
  'printf',
  'true',
  'false',
  'grep',
  'head',
  'tail',
  'sed',
  'awk',
  'sort',
  'uniq',
  'wc',
  'cut',
  'tr',
  'xargs',
]);

/** A head coming out of `fixCmdHead` must look like a command/basename, not an
 *  arbitrary token: `$(...)`, a backtick, a redirect, or a runaway-length
 *  string are all rejected rather than published (PR 277 round-2 review, nit 2
 *  under sync.ts:532). */
const CMD_HEAD_SHAPE_RE = /^[\w.@+-]{1,40}$/;

/** True when `word` — one candidate env-assignment word (`NAME=value...`) —
 *  carries an odd number of `"` or `'` characters. A whitespace-split word
 *  like that is not a whole assignment: the quoted value continues into the
 *  next word(s), which the splitter has no way to reassemble, so the "next
 *  word" `fixCmdHead` would otherwise treat as the command head is actually a
 *  fragment of the quoted value (PR 277 round-2 review, new-in-delta finding
 *  on sync.ts:526-529: `MYSQL_PWD="correct horse battery staple" pnpm test`
 *  published `Passed on: horse`). */
function hasUnbalancedQuote(word: string): boolean {
  const dq = (word.match(/"/g) ?? []).length;
  const sq = (word.match(/'/g) ?? []).length;
  return dq % 2 !== 0 || sq % 2 !== 0;
}

/** The first non-noise command basename in `command`, for the `Passed on:`
 *  line — the same "publish the head, not the whole line" treatment `cmdHead`
 *  already gets for `Failed:`. `fixCmd` carries the WHOLE scrubbed successful
 *  command (a scrubbed-to-`/` `cd /` prefix and pipeline tails included),
 *  unlike `cmdHead`, which push-scripts.ts computes once at pairing-open time
 *  and stores (tenjin-agent#252, PR 277 review). Returns null when nothing but
 *  noise words remain, so the caller drops the line the same way it already
 *  drops `Failed:` for a null `cmdHead` — and also returns null outright (the
 *  whole line dropped, not just this segment) the moment a skipped assignment
 *  word carries an unbalanced quote, since the words after it are unreliable
 *  fragments of that quoted value rather than a real command. */
function fixCmdHead(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i] ?? '')) {
      if (hasUnbalancedQuote(words[i] ?? '')) return null;
      i++;
    }
    if (i >= words.length) continue;
    const word = words[i] ?? '';
    const head = word.split('/').pop() || word;
    if (FIX_CMD_NOISE_HEADS.has(head)) continue;
    if (!CMD_HEAD_SHAPE_RE.test(head)) continue;
    return head;
  }
  return null;
}

// ---- the link from a local pairing to its fix record ------------------------
// `pairings` has no fix-id column; the link is the `session_state` row
// `pairing_fix:<row id>` under the machine bucket, SHARED with the failure
// arm's team leg (push core, STATE_PAIRING_FIX_PREFIX, mirrored as the TS
// export imported here), which writes `{ fixId, origin, at }` when it opens a
// pairing beside a teammate's fix and stamps `closedAt`/`status`/`fixFiles`
// when this machine closes it. This command adds `own: true` on a fix it
// upserted.

const MACHINE_SESSION = '';

interface PairingLink {
  fixId: string;
  origin: string;
  at: number;
  /** This machine holds the fix record (a previous `tenjin sync` upserted it).
   *  A link WITHOUT it names a teammate's fix, which this machine attests to
   *  rather than duplicating. */
  own?: boolean;
  /** Stamped by the failure arm when this machine's pass closed the pairing. */
  closedAt?: number;
  status?: string;
  fixFiles?: string[];
}

function getLink(store: Store, pairingId: number): PairingLink | null {
  const row = store.get(STORE_SQL.getState, [
    MACHINE_SESSION,
    STATE_PAIRING_FIX_PREFIX + pairingId,
  ]);
  if (row === null || typeof row.value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const link = parsed as Record<string, unknown>;
    if (typeof link.fixId !== 'string' || link.fixId.length === 0) return null;
    return {
      fixId: link.fixId,
      origin: typeof link.origin === 'string' ? link.origin : '',
      at: typeof link.at === 'number' ? link.at : 0,
      ...(link.own === true ? { own: true } : {}),
      ...(typeof link.closedAt === 'number' ? { closedAt: link.closedAt } : {}),
      ...(typeof link.status === 'string' ? { status: link.status } : {}),
      ...(Array.isArray(link.fixFiles)
        ? { fixFiles: link.fixFiles.filter((f): f is string => typeof f === 'string') }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Write the pairing → fix link. RETURNS WHETHER IT LANDED, and every caller
 * checks: the link is the only record that this pairing has a fix record, and
 * `synced_at` is the flag that says never write this row again. Stamping the
 * second without the first strands the pairing forever — no id to attest
 * against, no unsynced row to re-upsert — so a failed write has to leave the
 * row alone and let the next run try again. The shelf's holder rule dedups the
 * repeat.
 */
function setLink(store: Store, pairingId: number, link: PairingLink): boolean {
  return store.run(STORE_SQL.setState, [
    MACHINE_SESSION,
    STATE_PAIRING_FIX_PREFIX + pairingId,
    JSON.stringify(link),
    Date.now(),
  ]);
}

/** One `events` row, `hook: 'sync'`, per run: the counts, plus `code` when the
 *  run stopped on a signing failure. The Stop hook reads the last one. */
function recordSyncEvent(
  store: Store,
  project: string | null,
  data: Record<string, unknown>,
): void {
  store.run(STORE_SQL.insertEvent, [
    eventUid(),
    Date.now(),
    storeSession(null),
    // `tenjin sync` is a command a person runs, never a hook firing inside a
    // subagent, so there is no agent to name.
    null,
    project,
    shortHash(hostId()),
    'sync',
    null,
    null,
    null,
    JSON.stringify(data),
  ]);
}

// ---- raw row → PairingRow ----------------------------------------------------

function readPairing(row: Record<string, unknown>): PairingRow | null {
  const id = typeof row.id === 'number' ? row.id : null;
  const key = typeof row.key === 'string' ? row.key : null;
  if (id === null || key === null) return null;
  return {
    id,
    kind: typeof row.kind === 'string' && row.kind.length > 0 ? row.kind : 'sig_v2',
    key,
    coarseKey: typeof row.coarse_key === 'string' ? row.coarse_key : null,
    cmdHead: typeof row.cmd_head === 'string' ? row.cmd_head : null,
    cmd: typeof row.cmd === 'string' ? row.cmd : null,
    errorLine: typeof row.error_line === 'string' ? row.error_line : null,
    errorFiles: parseJsonArray(row.error_files),
    fixCmd: typeof row.fix_cmd === 'string' ? row.fix_cmd : null,
    fixFiles: parseJsonArray(row.fix_files),
    pkgVersions: parseJsonRecord(row.pkg_versions),
    status: typeof row.status === 'string' ? row.status : 'open',
    syncedAt: typeof row.synced_at === 'number' ? row.synced_at : null,
  };
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// ---- repo origin (a file read, never a git spawn) ----------------------------

/**
 * The coarse key's repo salt for the checkout at `start`: `repoSlug` of the
 * origin remote URL read from `.git/config`, or null. NO GIT INVOCATION — a hook
 * (and a sync it spawns) must not run a process in front of its work; a `.git`
 * file (a worktree or submodule) is followed to its real gitdir.
 *
 * ⚠ THE SAME RULE AS THE RESOLVE LEG (`originSlug`, generated from
 * `repoSlugSource()` in lib/state-store.ts): the URL is normalised to
 * `host/full/path` so the two transports of one repo salt alike. A null (no
 * origin, or a remote that is a bare local path) reads as '' at the call site,
 * which is NOT a salt: it means no remote, and this checkout syncs nothing.
 */
function readRepoSlug(cwd: string): string | null {
  const gitDir = findGitDir(cwd);
  if (gitDir === null) return null;
  let text: string;
  try {
    text = readFileSync(join(gitDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  // The url of [remote "origin"]. A tiny hand parse rather than a git-config
  // dependency: find the origin section, then its first url = line before the
  // next section header.
  const lines = text.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = /^\s*\[(.+?)\]\s*$/.exec(line);
    if (section !== null) {
      inOrigin = /^remote\s+"origin"$/.test((section[1] ?? '').trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url !== null && url[1] !== undefined) return repoSlug(url[1].slice(0, 500));
  }
  return null;
}

/** Walk up from `start` for a `.git` directory (or a `.git` file pointing at
 *  one), returning the resolved git directory or null.
 *
 *  ⚠ {@link GIT_WALK_MAX} IS SHARED WITH THE GENERATED `originSlug` (round-3
 *  review of #256), which is the walk the Stop hook and the failure arm gate on.
 *  Two bounds meant a checkout below the shorter one read "no remote" there and
 *  an origin here — nothing synced, silently, from a repo that had one. */
function findGitDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < GIT_WALK_MAX; i += 1) {
    const dotGit = join(dir, '.git');
    let stat;
    try {
      stat = statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        try {
          const pointer = readFileSync(dotGit, 'utf8');
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
          if (m !== null && m[1] !== undefined) {
            const resolved = m[1].startsWith('/') ? m[1] : join(dir, m[1]);
            // A worktree's gitdir is …/.git/worktrees/<name>; the config lives at
            // the common dir, which `commondir` names.
            return resolveCommonDir(resolved);
          }
        } catch {
          return null;
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function resolveCommonDir(gitDir: string): string {
  try {
    const commondir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (commondir.length > 0) {
      return commondir.startsWith('/') ? commondir : join(gitDir, commondir);
    }
  } catch {
    // No commondir file: this IS the common git dir.
  }
  return gitDir;
}

// ---- small local helpers duplicated from the hook core (CLI side has no access
// to the JS template's private functions) --------------------------------------

function eventUid(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '';
  let ms = Date.now();
  for (let i = 0; i < 10; i += 1) {
    time = alphabet[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  let rand = '';
  for (const byte of randomBytes(16)) rand += alphabet[byte % 32];
  return time + rand;
}

function hostId(): string {
  let host: string;
  let user: string;
  try {
    host = hostname();
  } catch {
    host = '';
  }
  try {
    user = userInfo().username || '';
  } catch {
    user = '';
  }
  return host + ' ' + user;
}

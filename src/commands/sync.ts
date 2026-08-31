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
  STATE_PAIRING_POST_PREFIX,
  STORE_SQL,
  type Store,
} from '../lib/state-store';
import { publishPost, updatePost, type PostKeyInput } from '../lib/posts-api';
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
 * closed, code-scoped error→fix pairings to the team shelf, so a fix a teammate's
 * machine already made travels to the next machine that hits the same failure
 * beside its error — without anyone writing a note. The Stop hook spawns it
 * detached after a session that closed such a pairing (see spawnSyncIfNeeded in
 * lib/hook-scripts.ts); it is also runnable by hand, which is the fallback the
 * Stop ask prints when a spawned run could not sign.
 *
 * TEAM MODE ONLY. A synced pairing is a keyed, card-less, price-0 post, and the
 * `POST /api/keys/resolve` route it is reachable through is a team-shelf feature;
 * a public-mode machine has no private shelf to hold it and no route to read it
 * back, so this hard-refuses rather than posting a team's build failures to the
 * public marketplace.
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

const TITLE_MAX = 120;
const BODY_MAX = 300;

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
      'tenjin sync only runs in team mode: it publishes fixed failures to your team shelf, reachable only through the team shelf’s by-key lookup.',
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
      data: { synced: 0, verified: 0, held: 0, skipped: 0, local: 0, pending: 0 },
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
        data: { synced: 0, verified: 0, held: 0, skipped: 0, local: 0, pending: 0 },
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
    // salt. Publishing under it would put every origin-less checkout on the
    // team's shelf into ONE coarse bucket, and a coarse hit is rank 1 with no
    // relevance check to run, so a scratch directory's fix would come back
    // beside an unrelated one as a strong teammate match. The failure arm's
    // resolve leg stops asking under the same condition, for the same reason.
    //
    // NOTHING IS STAMPED: `synced_at` stays NULL on every row, because these
    // pairings are not synced, they are local. If the checkout later gains an
    // origin, the next run publishes them. The Stop hook does not spawn a sync
    // here at all (it reads the same slug first), so this path is a hand run.
    if (repo === '') {
      return {
        data: {
          synced: 0,
          verified: 0,
          held: 0,
          skipped: 0,
          local: rows.length,
          pending: 0,
        },
        humanLines: [
          `Nothing to sync: this checkout has no git origin, so its ${rows.length} fixed ${
            rows.length === 1 ? 'pairing stays' : 'pairings stay'
          } local.`,
        ],
      };
    }
    // The shelf a link row names: the team shelf, which is the only place a
    // synced pairing ever goes.
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
    let verified = 0;
    let held = 0;
    let skipped = 0;
    const now = () => Date.now();
    try {
      for (const row of rows) {
        // The link row (`pairing_post:<id>`, written by the failure arm's team
        // leg when it opened this pairing beside a teammate's post, or by a
        // previous run of this command when it POSTed the row) says which shelf
        // post this pairing is tied to. Three cases:
        //  - a HELD row (a 400 named the holder): re-stamp so it is not
        //    reconsidered until it changes again, and touch nothing on the shelf;
        //  - OUR post, and the row was promoted to `verified` by a close that
        //    landed after the last sync: PUT verified:true on it;
        //  - a TEAMMATE's post that this machine has now closed locally: that is
        //    the second, independent close 04 asks for, and the shelf has no
        //    close endpoint. Their post cannot be PUT from this wallet (every
        //    post route is owner-scoped: a foreign id is a 404), so this
        //    machine POSTs its OWN record of the fix with the keys `verified`
        //    — two machines closed it independently, which is exactly what
        //    verified means. If the teammate's post already holds the key
        //    verified, the shelf's holder 400 says so and the row is held.
        const link = getLink(store, row.id);
        if (link !== null && link.held) {
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          continue;
        }
        if (link === null && row.syncedAt !== null) {
          // Synced, promoted, but the link is gone (a store that lost the
          // mapping): nothing of ours to update. Re-stamp and move on.
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          continue;
        }
        const own = link !== null && link.own === true;
        // A row synced under our own post with nothing to promote: re-stamp.
        if (own && row.status !== 'verified') {
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          continue;
        }
        // Two independent closes — a teammate's (their post) and ours — read
        // as verified on the wire whatever the local status says.
        const verifiedOnWire = row.status === 'verified' || (link !== null && !own);

        // THE SAME SCAN EVERY PUBLISH RUNS, minus the warn tier a team shelf
        // drops (survivesTeamDrop, as commands/publish.ts filters it). The
        // fields are scrubbed on the way into the row, so this is the second
        // look: a credential that survived the scrub in a command line or a
        // filename stays on this machine. Nobody can --yes an automatic run,
        // and the body is the same next run, so a finding marks the row synced
        // (never retried) rather than blocking every row behind it.
        if (scanFindings(row).length > 0) {
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          skipped += 1;
          continue;
        }

        try {
          if (own && link !== null) {
            await updatePost(
              link.postId,
              { keys: keysFor(row, repo, verifiedOnWire) },
              auth,
              client,
            );
            store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
            verified += 1;
            continue;
          }
          const result = await publishPost(
            {
              title: titleFor(row),
              bodyMd: bodyFor(row),
              priceAtomic: '0',
              status: 'published',
              keys: keysFor(row, repo, verifiedOnWire),
            },
            auth,
            client,
          );
          // Link first, then stamp: a crash between the two leaves a row that is
          // still unsynced and re-publishes (dedup on the shelf side), never a
          // synced row whose post id is lost and can never be promoted.
          //
          // AND THE SAME IS TRUE OF A FAILED WRITE, which is not a crash and
          // used to fall through to the stamp anyway. `store.run` swallows a
          // SQLite error and returns false, so the row would have been marked
          // synced with no link: nothing to PUT the verified keys on later, and
          // no unsynced row for a future run to pick up. Leaving it unstamped
          // costs one duplicate POST at worst.
          if (
            !setLink(store, row.id, {
              postId: result.resourceId,
              origin,
              at: now(),
              own: true,
              url: result.url,
              title: result.title,
              price: result.priceAtomic,
            })
          ) {
            continue;
          }
          store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
          synced += 1;
        } catch (err) {
          if (err instanceof SyncSigningError) throw err; // aborts the whole run, below
          const holder = verifiedHolderId(err);
          if (holder !== null) {
            // A teammate's post already holds this fingerprint verified. The row is
            // theirs on the shelf now; stamp synced_at so it is never retried and
            // record who holds it (`held`, so no later run PUTs on their post).
            // Unstamped if the link did not land, for the reason the publish
            // path gives: a synced row with no `held` link would be retried by
            // no run and PUT by none either.
            if (!setLink(store, row.id, { postId: holder, origin, at: now(), held: true })) {
              continue;
            }
            store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
            held += 1;
            continue;
          }
          if (err instanceof CliError && err.code === 'RESOURCE_NOT_FOUND') {
            // Our post is gone from the shelf (deleted, or the link is stale):
            // nothing to promote, and a PUT on it will 404 on every future run
            // too. Stamp and move on so one dead link cannot block the queue.
            store.run(STORE_SQL.markPairingSynced, [now(), row.id]);
            skipped += 1;
            continue;
          }
          if (
            err instanceof CliError &&
            (err.code === 'PUBLISH_BLOCKED' || err.code === 'NEEDS_CONFIRMATION')
          ) {
            // The server's own ingest gate refused THIS row's content. Sync has
            // nobody to hand a --yes to, and a scrubbed command/filename body
            // will refuse identically on every future run — so, like a holder
            // collision, this is marked synced (never retried) rather than
            // permanently blocking every pairing behind it in `ORDER BY at`. No
            // events row: that field is reserved for a SIGNING failure, which is
            // the one case the Stop hook's fallback line looks for.
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
        recordSyncEvent(store, project, { code: err.code, synced, verified, held, skipped });
        throw new CliError(
          'PUBLISH_FAILED',
          `tenjin sync could not sign (${err.code}); ${synced + verified + held + skipped} of ${rows.length} pairings synced before it stopped.`,
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
        verified,
        held,
        skipped,
      });
      throw err;
    }

    // A run that finished writes its own `hook: 'sync'` row WITHOUT a code, so
    // the Stop hook's fallback line (which reads the LAST sync row) goes quiet
    // the moment a later run succeeds, rather than outliving the failure.
    recordSyncEvent(store, project, { synced, verified, held, skipped });
    return {
      data: {
        synced,
        verified,
        held,
        skipped,
        local: 0,
        pending: rows.length - synced - verified - held - skipped,
      },
      humanLines: [
        `Synced ${synced} new, updated ${verified} verified, ${held} already held by a teammate, ${skipped} skipped.`,
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

/** The wire keys for one pairing: the fine fingerprint verbatim, the coarse
 *  fingerprint SALTED with the repo slug (so an ERR_PNPM_OUTDATED_LOCKFILE-class
 *  error does not match across every repo the team has), and the command head for
 *  a future ranking to use — never queried, only stored. `verified` mirrors the
 *  local close status; a hand publish never claims verified, but sync IS the
 *  close rule's own report and may. `repo` is never '' here: a checkout with no
 *  remote returns before this is reached, publishing nothing at all (#249). */
function keysFor(row: PairingRow, repo: string, verified: boolean): PostKeyInput[] {
  const keys: PostKeyInput[] = [{ kind: 'fingerprint', key: 'sig_v1:' + row.key, verified }];
  if (row.coarseKey !== null && row.coarseKey.length > 0) {
    // Salt the coarse HASH, not the raw message+errno: the CLI has only the
    // stored hashes (message/errno exist only transiently inside the failure
    // arm's sigV1() call, never as columns), so `teamCoarseKey` — shared with
    // the resolve leg via lib/push-scripts.ts — salts what both sides actually
    // have (06, "Team-shelf coarse keys").
    //
    // NO `repo.length > 0` GUARD, and none is needed (tenjin-agent#249). The
    // guard that used to live here dropped the coarse key while the resolve leg
    // went on asking for `sig_v1c:teamCoarseKey(coarse, '')`, so a no-origin
    // checkout could only ever match on the fine key and the miss looked like
    // "no teammate has hit this". The asymmetry is closed at the other end now:
    // a checkout with no remote publishes NOTHING and the resolve leg asks for
    // nothing, so the two sides agree and '' never reaches this line.
    keys.push({
      kind: 'fingerprint',
      key: 'sig_v1c:' + teamCoarseKey(row.coarseKey, repo),
      verified,
    });
  }
  if (row.cmdHead !== null && row.cmdHead.length > 0) {
    keys.push({ kind: 'command_head', key: row.cmdHead });
  }
  return keys;
}

/** The publish scan over what would go on the wire — title and body — with
 *  the warn tier filtered exactly as `tenjin publish` filters it on a team
 *  shelf (this command only runs in team mode). No project markers: the row
 *  holds basenames and a command line, and the shelf is the team's own. */
function scanFindings(row: PairingRow): ScanFinding[] {
  return scan(titleFor(row) + '\n' + bodyFor(row)).filter(survivesTeamDrop);
}

/** `Fix: <cmd_head> — <errno|frame>`. The signature's errno and frame are not
 *  stored (the row keeps only the hashes), so the discriminant is re-derived from
 *  the scrubbed error line and the named files — the same two sources sig_v1 read. */
function titleFor(row: PairingRow): string {
  const head = row.cmdHead !== null && row.cmdHead.length > 0 ? row.cmdHead : 'command';
  const disc = discriminant(row);
  const title = disc.length > 0 ? `Fix: ${head} — ${disc}` : `Fix: ${head}`;
  return title.slice(0, TITLE_MAX);
}

const ERRNO_TOKEN_RE = /\b(ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*|TS\d{3,5}|E\d{3,4}|E[A-Z]{3,})\b/;
function discriminant(row: PairingRow): string {
  if (row.errorLine !== null) {
    const m = ERRNO_TOKEN_RE.exec(row.errorLine);
    if (m !== null && m[1] !== undefined) return m[1];
  }
  return row.errorFiles.length > 0 ? (row.errorFiles[0] ?? '') : '';
}

/** ≤300 chars: the failing head, the fix command and files, the verify command,
 *  and a `pkg:` line (which a later staleness read parses back). Every field
 *  already passed the local scrub on the way into the row; the whole thing is
 *  re-bounded here. */
function bodyFor(row: PairingRow): string {
  const lines: string[] = [];
  // The HEAD, not `row.cmd`: the row keeps the whole scrubbed command line for
  // `sig_v1` (the fingerprint hashes it), but a synced pairing's body is public
  // team-shelf prose, and the full line routinely carries a pipeline tail
  // (`| grep ...`) or a scrubbed-to-`/` cwd that reads as a bogus `cd /`
  // (tenjin-agent#252). `cmdHead` is the same value the title and the
  // `command_head` key already use.
  if (row.cmdHead !== null && row.cmdHead.length > 0) lines.push(`Failed: ${row.cmdHead}`);
  if (row.fixFiles.length > 0) lines.push(`Changed: ${row.fixFiles.slice(0, 4).join(', ')}`);
  if (row.fixCmd !== null && row.fixCmd.length > 0) lines.push(`Passed on: ${row.fixCmd}`);
  const pkgs = Object.entries(row.pkgVersions)
    .slice(0, 3)
    .map(([name, ver]) => `${name}@${ver}`);
  if (pkgs.length > 0) lines.push(`pkg: ${pkgs.join(', ')}`);
  return lines.join('\n').slice(0, BODY_MAX);
}

/** The verified-holder 400 the keys route draws when another PUBLISHED piece
 *  already holds this fingerprint verified: the server names the holder's post
 *  id. Read off the CliError posts-api mapped (details.server), so a held row is
 *  recorded and skipped rather than crashing the run. A keys_disabled 400, or any
 *  other error, is not a holder and propagates. */
function verifiedHolderId(err: unknown): string | null {
  if (!(err instanceof CliError) || !/already verified/i.test(err.message)) return null;
  const server = readServerBody(err);
  const fromBody = holderFromServer(server);
  if (fromBody !== null) return fromBody;
  const m = /on (?:post )?`?([A-Za-z0-9_-]+)`?/.exec(err.message);
  return m !== null && m[1] !== undefined ? m[1] : 'another-piece';
}

function readServerBody(err: CliError): unknown {
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  return (details as { server?: unknown }).server ?? null;
}

function holderFromServer(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const error = (json as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null) return null;
  const keys = (fieldErrors as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  for (const message of keys) {
    if (typeof message !== 'string') continue;
    const m = /on post ([A-Za-z0-9_-]+)/.exec(message);
    if (m !== null && m[1] !== undefined) return m[1];
  }
  return null;
}

// ---- the link from a local pairing to its shelf post -------------------------
// `pairings` has no post-id column; the link is the `session_state` row
// `pairing_post:<row id>` under the machine bucket, SHARED with the failure
// arm's team leg (push core, STATE_PAIRING_POST_PREFIX, mirrored as the TS
// export imported here), which writes `{ postId, origin, at }` when it opens a
// pairing beside a teammate's post and stamps `closedAt`/`status`/`fixFiles`
// when this machine closes it. This command adds `own: true` on a post it
// published and `held: true` on a holder it lost to.

const MACHINE_SESSION = '';

interface PairingLink {
  postId: string;
  origin: string;
  at: number;
  /** This machine published the post (a previous `tenjin sync`). */
  own?: boolean;
  /** A teammate's PUBLISHED piece held the key verified; the shelf refused ours. */
  held?: boolean;
  /** Stamped by the failure arm when this machine's pass closed the pairing. */
  closedAt?: number;
  status?: string;
  fixFiles?: string[];
  /**
   * The read URL, title and atomic price `publishPost` echoed back on an OWN
   * publish (tenjin-agent#252): the read route is keyed by handle/slug, so an
   * id alone cannot rebuild it later, and this is the one moment the CLI is
   * ever handed the slug for a post it just created. Stored here so
   * `findPairingCandidate` (state-store.ts) can answer `inspect`/`read` for an
   * id `tenjin sync` published without ever having been searched for. Absent
   * on a `held` link — this machine never fetched the holder's own slug.
   */
  url?: string;
  title?: string;
  price?: string;
}

function getLink(store: Store, pairingId: number): PairingLink | null {
  const row = store.get(STORE_SQL.getState, [
    MACHINE_SESSION,
    STATE_PAIRING_POST_PREFIX + pairingId,
  ]);
  if (row === null || typeof row.value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const link = parsed as Record<string, unknown>;
    if (typeof link.postId !== 'string' || link.postId.length === 0) return null;
    return {
      postId: link.postId,
      origin: typeof link.origin === 'string' ? link.origin : '',
      at: typeof link.at === 'number' ? link.at : 0,
      ...(link.own === true ? { own: true } : {}),
      ...(link.held === true ? { held: true } : {}),
      ...(typeof link.closedAt === 'number' ? { closedAt: link.closedAt } : {}),
      ...(typeof link.status === 'string' ? { status: link.status } : {}),
      ...(Array.isArray(link.fixFiles)
        ? { fixFiles: link.fixFiles.filter((f): f is string => typeof f === 'string') }
        : {}),
      ...(typeof link.url === 'string' && link.url.length > 0 ? { url: link.url } : {}),
      ...(typeof link.title === 'string' ? { title: link.title } : {}),
      ...(typeof link.price === 'string' ? { price: link.price } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Write the pairing → post link. RETURNS WHETHER IT LANDED, and every caller
 * checks: the link is the only record that this pairing has a post, and
 * `synced_at` is the flag that says never publish this row again. Stamping the
 * second without the first strands the pairing forever — no id to PUT on, no
 * unsynced row to re-publish — so a failed write has to leave the row alone and
 * let the next run try again. The shelf dedups the repeat.
 */
function setLink(store: Store, pairingId: number, link: PairingLink): boolean {
  return store.run(STORE_SQL.setState, [
    MACHINE_SESSION,
    STATE_PAIRING_POST_PREFIX + pairingId,
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

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import pkg from '../../package.json';
import { writeFileAtomic } from './atomic-json';
import { loadConfig } from './config';
import type { UpdateMode } from './config';
import { wouldRefuse } from './install-location';
import { withFileLock } from './lock';
import { emitNotice, emitWriteNotice } from './output';
import type { Io } from './output';
import { autoUpdateLockPath, autoUpdatePath, autoUpdateResultPath, updateCheckPath } from './paths';

/**
 * "A newer tenjin-cli exists" — one dim stderr line, at most once a day, for a
 * human at a terminal.
 *
 * Everything about it is subordinate to the command that ran: it happens AFTER
 * the envelope is written, it never touches stdout, it never changes an exit
 * code, and every failure it can have (offline, slow registry, junk JSON, a tag
 * that does not exist) is swallowed. An agent surface sees nothing at all — no
 * TTY, `--json`, or CI is each on its own enough to skip the whole thing.
 *
 * There is deliberately NO opt-out flag or env var yet. One nudge a day at a
 * human terminal is small enough that the switch would be more surface than the
 * feature; if that stops being true, the switch is the next thing added.
 */

const CHECK_INTERVAL_MS = 86_400_000; // 24h
const FETCH_TIMEOUT_MS = 1500;
/**
 * How long a version must have been VISIBLE before `auto` will install it.
 *
 * The brake on blast radius. Default-on auto-update means a bad publish could
 * otherwise reach every agent machine within a day; requiring that we have
 * already seen this exact version on a previous check gives a bad release a
 * window to be pulled first. It costs the fleet one extra day of staleness and
 * needs no extra registry call, since first sighting is recorded in the cache
 * this check already keeps.
 */
const SOAK_MS = 86_400_000; // 24h
/** How long to wait for a detached child before calling its outcome lost. */
const RESULT_GRACE_MS = 900_000; // 15min, comfortably past the install timeout
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/tenjin-cli/dist-tags';

/** What is known about ONE dist-tag: when it was asked, and what it said. */
const TagEntrySchema = z.object({
  checkedAtMs: z.number(),
  latest: z.string(),
  /** When the nudge was last PRINTED for this tag. Absent until one has been. */
  notifiedAtMs: z.number().optional(),
  /**
   * When THIS version was first seen on this tag; reset whenever the version
   * changes. What the soak delay measures. Absent in caches written before auto
   * mode existed, which restarts the soak once rather than installing blind.
   */
  firstSeenMs: z.number().optional(),
});

/**
 * The cache is a pure optimization, so a bad one is re-fetched, never repaired.
 *
 * One entry PER TAG rather than one entry total, because a machine can run an
 * alpha and a stable build out of the same data dir. A single record would make
 * every channel switch evict the other channel's answer, and the returning binary
 * would re-fetch and re-print a notice it had already shown seconds earlier.
 */
const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  tags: z.record(z.string(), TagEntrySchema),
});
type Cache = z.infer<typeof CacheSchema>;

/** `{"latest":"1.2.3","alpha":"1.3.0-alpha.1"}` — tag names are not fixed. */
const DistTagsSchema = z.record(z.string(), z.string());

export interface UpdateCheckDeps {
  dir: string;
  io: Io;
  /** The global --json flag; ANDed with io.isTTY exactly as the emit path does. */
  json: boolean;
  env?: NodeJS.ProcessEnv;
  /** Clock seam (ms since epoch) for deterministic TTL tests. */
  now?: () => number;
  /** Override global fetch (tests inject a stub returning canned Responses). */
  fetchImpl?: typeof fetch;
  /** The running version; defaults to this build's. Injectable for tests. */
  currentVersion?: string;
  /** Resolved update.mode; defaults to reading the config file. */
  mode?: UpdateMode;
  /** Where this build lives, for the "could an install even work here" test. */
  moduleDir?: string;
  /** Launch the background install. Injected by tests; never spawns for real. */
  spawnImpl?: (dir: string) => void;
}

/**
 * Print the update nudge if one is due. NEVER rejects — the caller awaits it
 * between a command's output and its exit, so a throw here would replace a
 * finished command's result with an internal error.
 */
export async function maybeUpdate(deps: UpdateCheckDeps): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    // Never in CI, in either mode: a build log cannot act on a nudge, and a
    // build machine must not silently acquire a different binary mid-pipeline.
    if (env.CI !== undefined && env.CI.length > 0) return;

    // Announced whatever the mode is NOW, and BEFORE the `off` return: if a
    // background install finished, the binary on this machine was replaced and
    // the operator is told once. `off` means stop asking npm, and this asks
    // nothing — it reads a file an install we already started left behind.
    await reportCompletedUpdate(deps);

    const mode = deps.mode ?? (await loadConfig(deps.dir)).update.mode;
    if (mode === 'off') return;

    // The nudge is a courtesy to a human at a terminal. `auto` is what makes the
    // check mean anything on the agent machines that have no human to nudge, so
    // only the nudge-only mode may stop here.
    const human = deps.io.isTTY && !deps.json;
    if (mode === 'nudge' && !human) return;

    const nowMs = (deps.now ?? Date.now)();
    const current = deps.currentVersion ?? pkg.version;
    const path = updateCheckPath(deps.dir);
    const tag = channelTag(current);
    if (tag === null) return; // a version this build cannot parse follows no channel

    // Only this tag's entry answers this binary's question; the other channel's
    // is neither used nor disturbed.
    const cached = await readCache(path);
    const entry = cached?.tags[tag];
    const fresh = entry !== undefined && nowMs - entry.checkedAtMs < CHECK_INTERVAL_MS;

    // Resolved through the same function `tenjin update` uses, so the nudge can
    // never advertise a version the command would decline to install, nor stay
    // quiet about one it would.
    const latest = fresh ? entry.latest : await resolveLatest(current, deps);
    if (latest === null) return; // asked and learned nothing: cache nothing either

    const upgradeable = isNewer(latest, current);

    // Once a day means once a day, not once per FETCH: a fresh cache would
    // otherwise repeat the same line on every command for 24h. The two clocks are
    // separate because they answer separate questions — when we last asked npm,
    // and when we last interrupted the human.
    const notifiedAtMs = entry?.notifiedAtMs;
    const due =
      upgradeable && (notifiedAtMs === undefined || nowMs - notifiedAtMs >= CHECK_INTERVAL_MS);

    // Carried forward when nothing is printed: the day since the last nudge does
    // not restart just because the registry was asked again.
    const nudgedAtMs = due ? nowMs : notifiedAtMs;

    // The soak clock, and the reason it is keyed to the VERSION rather than to
    // the tag: a new version is a new thing to have been burned by, so seeing a
    // different string restarts the wait.
    const seenBefore = entry?.latest === latest ? entry?.firstSeenMs : undefined;
    const firstSeenMs = seenBefore ?? nowMs;

    // Nothing learned and nothing said means nothing to write. Deliberately NOT
    // locked: two concurrent CLI processes can both nudge, and one duplicated
    // line is cheaper than a lock on the exit path of every command. (The
    // background INSTALL is locked; that one is not idempotent.)
    if (!fresh || due || seenBefore === undefined) {
      await writeCache(path, {
        schemaVersion: 1,
        // Read-modify-write: the tag this run did not ask about keeps whatever it
        // knew, including its own nudge clock.
        tags: {
          ...cached?.tags,
          [tag]: {
            checkedAtMs: fresh ? entry.checkedAtMs : nowMs,
            latest,
            firstSeenMs,
            ...(nudgedAtMs !== undefined ? { notifiedAtMs: nudgedAtMs } : {}),
          },
        },
      });
    }
    if (!upgradeable) return;

    // Install it ourselves, if this install is one an install could replace and
    // the version has sat on the registry long enough to have been pulled.
    if (mode === 'auto' && nowMs - firstSeenMs >= SOAK_MS) {
      const moduleDir = deps.moduleDir ?? fileURLToPath(new URL('.', import.meta.url));
      if (!wouldRefuse(moduleDir) && (await claimAutoUpdate(deps, nowMs, current, latest))) {
        (deps.spawnImpl ?? spawnDetachedUpdate)(deps.dir);
        return; // the install is running; a nudge to do it by hand would be noise
      }
    }
    if (!due || !human) return;

    // Named as the command, not the npm invocation it wraps: `update` prints the
    // right instructions itself for an install it cannot perform (a source
    // checkout, a yarn global), so this line is correct everywhere.
    emitNotice(
      deps.io,
      `tenjin-cli ${latest} is available (you have ${current}). Update: run tenjin update`,
      { json: deps.json },
    );
  } catch {
    // Unreachable by construction (every step below is already guarded); here so
    // that staying invisible does not depend on that remaining true.
  }
}

/**
 * What the background updater last started, and whether it has been reported.
 */
const AutoUpdateStateSchema = z.object({
  schemaVersion: z.literal(1),
  startedAtMs: z.number(),
  from: z.string(),
  to: z.string(),
  reported: z.boolean(),
});
type AutoUpdateState = z.infer<typeof AutoUpdateStateSchema>;

/**
 * Take the right to start ONE background install, or decline.
 *
 * The lock is what stops two concurrent commands both spawning an installer at
 * the same newer version, which would have two package managers writing one
 * global directory. Its timeout is deliberately tiny: this runs on the exit path
 * of every command, so a lock someone else holds means someone else is already
 * deciding, and the answer is to do nothing rather than to wait.
 */
async function claimAutoUpdate(
  deps: UpdateCheckDeps,
  nowMs: number,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    return await withFileLock(
      autoUpdateLockPath(deps.dir),
      async () => {
        const prior = await readAutoUpdateState(deps.dir);
        // An install already running for this same version, or one whose result
        // nobody has read yet, owns the slot.
        if (prior !== null && !prior.reported && nowMs - prior.startedAtMs < RESULT_GRACE_MS) {
          return false;
        }
        await writeFileAtomic(
          autoUpdatePath(deps.dir),
          `${JSON.stringify({ schemaVersion: 1, startedAtMs: nowMs, from, to, reported: false }, null, 2)}\n`,
          { mode: 0o600, dirMode: 0o700 },
        );
        return true;
      },
      { timeoutMs: 250 },
    );
  } catch {
    return false; // contended or unwritable: not our turn
  }
}

/**
 * Launch `tenjin update --json` and let go of it.
 *
 * Detached with no parent pipes, because the whole point is that the command the
 * user actually ran has already printed its envelope and must not wait on an
 * install. stdout goes straight to a file: `--json` emits exactly one envelope,
 * so the child's own output IS the outcome record, with nothing to invent.
 */
function spawnDetachedUpdate(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(autoUpdateResultPath(dir), 'w');
    const child = spawn(process.execPath, [process.argv[1] ?? '', 'update', '--json'], {
      detached: true,
      // stderr discarded on purpose: the write notice and npm's chatter belong to
      // a terminal nobody is watching here, and the envelope carries the outcome.
      stdio: ['ignore', fd, 'ignore'],
    });
    child.unref();
  } catch {
    // Could not launch: the state file says an attempt started, the result file
    // never appears, and the grace window frees the slot for the next run.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Announce a finished background install exactly once.
 *
 * Uses the write notice rather than the nudge, and so reaches a piped or --json
 * run too: replacing the binary on this machine is a write to the operator's
 * system, and the surface they happen to be on does not make it less true. A
 * FAILED install says nothing and simply frees the slot, which drops the run
 * back to the ordinary nudge on the next pass.
 */
async function reportCompletedUpdate(deps: UpdateCheckDeps): Promise<void> {
  const state = await readAutoUpdateState(deps.dir);
  if (state === null || state.reported) return;
  const nowMs = (deps.now ?? Date.now)();

  const envelope = await readJson(autoUpdateResultPath(deps.dir));
  const done = envelope !== null;
  // Still running, and still within its grace: leave it alone.
  if (!done && nowMs - state.startedAtMs < RESULT_GRACE_MS) return;

  const updated =
    done &&
    typeof envelope === 'object' &&
    envelope !== null &&
    (envelope as { ok?: unknown }).ok === true &&
    (envelope as { data?: { updated?: unknown } }).data?.updated === true;

  await writeFileAtomic(
    autoUpdatePath(deps.dir),
    `${JSON.stringify({ ...state, reported: true }, null, 2)}\n`,
    { mode: 0o600, dirMode: 0o700 },
  );
  if (updated) {
    emitWriteNotice(deps.io, `tenjin-cli updated itself to ${state.to} in the background`);
  }
}

async function readAutoUpdateState(dir: string): Promise<AutoUpdateState | null> {
  const parsed = AutoUpdateStateSchema.safeParse(await readJson(autoUpdatePath(dir)));
  return parsed.success ? parsed.data : null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Which dist-tag this build follows, or null for a version string this package
 * has no channel for. Null rather than a default, because every caller's right
 * answer differs: the nudge goes quiet, and `tenjin update` refuses instead of
 * silently reporting a foreign build "up to date" against a tag it never
 * belonged to.
 */
export function channelTag(version: string): 'alpha' | 'latest' | null {
  const parsed = parseVersion(version);
  if (parsed === null) return null;
  // A prerelease build follows the prerelease tag: it is the one that carries
  // prereleases at all when the release line has moved on past them.
  return parsed.alpha !== null ? 'alpha' : 'latest';
}

/**
 * The newest version this build can move to, across BOTH the tag its channel
 * names and `latest`.
 *
 * Deliberately not the channel tag alone. Which tag a publish lands on is a
 * property of the release pipeline, not of this package's version numbers, and
 * the two have already disagreed: `alpha` sat on 0.1.0-alpha.7 while
 * 0.1.0-alpha.8 through .11 shipped on `latest`, so a channel-only lookup told
 * every alpha user they were current while four newer builds sat on npm. Taking
 * the newest of the two survives either layout without this command depending
 * on the pipeline being fixed. `latest` never drags a stable build backwards:
 * isNewer is the only comparison, and for a release build the two candidates
 * are the same tag anyway.
 *
 * Null when the registry offers nothing parseable on either tag, which is a
 * different fact from "the registry could not be reached" and is reported as one.
 */
export function resolveTarget(current: string, tags: Record<string, string>): string | null {
  const channel = channelTag(current);
  if (channel === null) return null;
  let best: string | null = null;
  for (const name of new Set([channel, 'latest'])) {
    const candidate = tags[name];
    if (candidate === undefined || parseVersion(candidate) === null) continue;
    if (best === null || isNewer(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Ask the registry for tenjin-cli's whole dist-tag map. Returns null for every
 * failure there is, INCLUDING a response that arrives too late — the AbortSignal
 * is what bounds the delay a finished command can suffer. Nothing is written
 * here: a failed check caches nothing, so the next command retries rather than
 * going quiet for 24h over one dropped packet. The nudge passes its own short
 * budget; `tenjin update` passes the run's request timeout, because there the
 * fetch IS the command rather than a stowaway on someone else's exit path.
 *
 * The whole map rather than one tag, so a caller can tell an unreachable
 * registry (null) from one that answered without the tag it asked for (a map
 * that lacks the key) — two failures with two different fixes.
 */
export async function fetchDistTags(opts: {
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<Record<string, string> | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  let json: unknown;
  try {
    const res = await doFetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(opts.timeoutMs) });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }
  const parsed = DistTagsSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** The nudge's one-shot: fetch, then resolve. Null for either failure. */
async function resolveLatest(current: string, deps: UpdateCheckDeps): Promise<string | null> {
  const tags = await fetchDistTags({ fetchImpl: deps.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS });
  return tags === null ? null : resolveTarget(current, tags);
}

async function writeCache(path: string, cache: Cache): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(cache, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

async function readCache(path: string): Promise<Cache | null> {
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Version comparison: this package's shape only, no semver dependency.
// ---------------------------------------------------------------------------

/** `major.minor.patch` with an optional `-alpha.N` — every version tenjin-cli
 *  has ever published. Anything else is unparseable ON PURPOSE (see isNewer). */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;

interface Version {
  major: number;
  minor: number;
  patch: number;
  /** null = a release; a number = that prerelease counter. */
  alpha: number | null;
}

function parseVersion(raw: string): Version | null {
  const m = VERSION_RE.exec(raw);
  if (m === null) return null;
  const [, major, minor, patch, alpha] = m;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    alpha: alpha !== undefined ? Number(alpha) : null,
  };
}

/**
 * Is `candidate` newer than `current`? An unparseable version on EITHER side is
 * "not newer": the registry is untrusted input, and the failure mode of guessing
 * is nagging every single command with a line the user cannot act on. A true
 * return therefore also certifies that BOTH sides parse, which is what lets
 * `tenjin update` splice the candidate into an npm argv without re-validating.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // Same release triple: semver says a prerelease precedes its own release, so
  // 0.1.0 beats 0.1.0-alpha.9 and never the other way around.
  if (a.alpha === null) return b.alpha !== null;
  if (b.alpha === null) return false;
  return a.alpha > b.alpha;
}

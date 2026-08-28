import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import pkg from '../../package.json';
import { writeFileAtomic } from './atomic-json';
import { loadConfig } from './config';
import type { UpdateMode } from './config';
import { emitNotice } from './output';
import type { Io } from './output';
import type { UpdateAvailable } from '../schemas';
import { updateCheckPath } from './paths';

/**
 * "A newer tenjin-cli exists", asked of npm at most once a day and reported
 * three ways: one dim stderr line for a human at a terminal, `updateAvailable`
 * on the JSON envelope, and a line on the generated hook scripts' output.
 *
 * It REPORTS and never installs. A CLI that starts a fresh process per
 * invocation has no deferred-activation window to hide a binary swap in — "next
 * start" is "mid-session" for whatever is driving it — so the decision to run
 * `tenjin update` belongs to the agent or the human, not to this check.
 *
 * Everything here is subordinate to the command that ran: the fetch happens
 * AFTER the envelope is written, it never touches stdout, it never changes an
 * exit code, and every failure it can have (offline, slow registry, junk JSON, a
 * tag that does not exist) is swallowed. CI skips the whole thing: a build log
 * can act on none of it. `update.mode off` is the opt-out and silences all three
 * surfaces, including the request to npm.
 */

/**
 * Silences this check for one process, cache write and registry request
 * included. Set by `update` on the `install --refresh` children it spawns: their
 * data dirs come out of a settings file this CLI does not own, and this check is
 * the one thing in a refresh that would CREATE such a directory — `writeCache`
 * mkdirs the tree — where the refresh itself only converges what exists.
 *
 * A separate switch rather than `CI`, which would also stand the skills heal
 * down (lib/skill-heal) and so gut the refresh it was set for.
 */
export const NUDGE_OPT_OUT = 'TENJIN_NO_UPDATE_CHECK';

const CHECK_INTERVAL_MS = 86_400_000; // 24h
const FETCH_TIMEOUT_MS = 1500;
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/tenjin-cli/dist-tags';

/** What is known about ONE dist-tag: when it was asked, and what it said. */
const TagEntrySchema = z.object({
  checkedAtMs: z.number(),
  /** The version the tag named. Absent when the answer was unusable. */
  latest: z.string().optional(),
  /** When the nudge was last PRINTED for this tag. Absent until one has been. */
  notifiedAtMs: z.number().optional(),
});

/**
 * The cache is a pure optimization, so a bad one is re-fetched, never repaired.
 * Keyed by dist-tag: an entry this build did not ask about is carried forward
 * untouched rather than evicted.
 */
const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  tags: z.record(z.string(), TagEntrySchema),
  /**
   * The resolved "you could upgrade" fact, written whenever it changes and
   * cleared when it stops being true.
   *
   * Denormalized from `tags` on purpose: the generated hook scripts are
   * standalone .mjs that cannot import this module and do not know which
   * version is running, so a per-tag entry would leave them unable to tell an
   * upgrade from a match. Storing the comparison's ANSWER is what lets a hook
   * report it without reimplementing any of it.
   */
  signal: z.object({ current: z.string(), latest: z.string() }).optional(),
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
    if (env[NUDGE_OPT_OUT] === '1') return;

    const mode = deps.mode ?? (await loadConfig(deps.dir)).update.mode;
    if (mode === 'off') return;

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
    //
    // Only a registry that could not be ASKED returns without caching; an answer
    // this build cannot use has still been answered, and moves the clock below.
    let latest: string | null;
    if (fresh) {
      latest = entry.latest ?? null;
    } else {
      const answer = await resolveLatest(current, deps);
      if (answer === null) return;
      latest = answer.latest;
    }

    const upgradeable = latest !== null && isNewer(latest, current);

    // Once a day means once a day, not once per FETCH: a fresh cache would
    // otherwise repeat the same line on every command for 24h. The two clocks are
    // separate because they answer separate questions — when we last asked npm,
    // and when we last interrupted the human.
    //
    // `human` is part of `due` for the second of those: this code now runs on
    // every surface, to feed the envelope signal, so without it an agent run
    // would stamp the nudge clock having printed nothing and leave a shared
    // machine's terminal quiet for 24h.
    const human = deps.io.isTTY && !deps.json;
    const notifiedAtMs = entry?.notifiedAtMs;
    const due =
      human &&
      upgradeable &&
      (notifiedAtMs === undefined || nowMs - notifiedAtMs >= CHECK_INTERVAL_MS);

    // Carried forward when nothing is printed: the day since the last nudge does
    // not restart just because the registry was asked again.
    const nudgedAtMs = due ? nowMs : notifiedAtMs;

    // Carries the agent-visible half of the answer, so a hook or an envelope can
    // report it without knowing which version is running.
    const signal = upgradeable && latest !== null ? { current, latest } : undefined;
    const signalChanged =
      cached?.signal?.current !== signal?.current || cached?.signal?.latest !== signal?.latest;

    // Nothing learned and nothing said means nothing to write. Deliberately NOT
    // locked: two concurrent CLI processes can both nudge, and one duplicated
    // line is cheaper than a lock on the exit path of every command.
    if (!fresh || due || signalChanged) {
      await writeCache(path, {
        schemaVersion: 1,
        ...(signal !== undefined ? { signal } : {}),
        // Read-modify-write: the tag this run did not ask about keeps whatever it
        // knew, including its own nudge clock.
        tags: {
          ...cached?.tags,
          [tag]: {
            checkedAtMs: fresh ? entry.checkedAtMs : nowMs,
            ...(latest !== null ? { latest } : {}),
            ...(nudgedAtMs !== undefined ? { notifiedAtMs: nudgedAtMs } : {}),
          },
        },
      });
    }

    // Named as the command, not the npm invocation it wraps: `update` prints the
    // right instructions itself for an install it cannot perform (a source
    // checkout, a yarn global), so this line is correct everywhere.
    if (due && latest !== null) {
      emitNotice(
        deps.io,
        `tenjin-cli ${latest} is available (you have ${current}). Update: run tenjin update`,
        { json: deps.json },
      );
    }
  } catch {
    // Unreachable by construction (every step below is already guarded); here so
    // that staying invisible does not depend on that remaining true.
  }
}

/**
 * What the last check learned, for the envelope. Cache only: this runs before
 * every command's output, so it may not fetch, may not block, and may not throw.
 * Null when nothing newer is known, when the cache is absent or stale-shaped, or
 * when `update.mode` is `off` — off silences BOTH surfaces, not just the line a
 * human sees.
 *
 * Reporting rather than installing is the whole design. A CLI that starts a
 * fresh process per invocation has no deferred-activation moment to hide a
 * binary swap in, so the agent is told and decides for itself.
 */
export async function readUpdateSignal(
  dir: string,
  currentVersion?: string,
): Promise<UpdateAvailable | null> {
  try {
    const current = currentVersion ?? pkg.version;
    const tag = channelTag(current);
    if (tag === null) return null;
    if ((await loadConfig(dir)).update.mode === 'off') return null;
    const cached = await readCache(updateCheckPath(dir));
    const latest = cached?.tags[tag]?.latest;
    if (latest === undefined || !isNewer(latest, current)) return null;
    return { current, latest };
  } catch {
    return null; // never the command's business
  }
}

/**
 * Which dist-tag this build follows, or null for a version string this package
 * has no channel for. Null rather than a default, because every caller's right
 * answer differs: the nudge goes quiet, and `tenjin update` refuses instead of
 * silently reporting a foreign build "up to date" against a tag it never
 * belonged to.
 *
 * Every build follows `latest`; see RELEASING.md, which changes with this.
 */
export function channelTag(version: string): 'latest' | null {
  return parseVersion(version) === null ? null : 'latest';
}

/**
 * The version this build can move to: whatever sits on the tag it follows.
 * Consulting a second tag added no reachable version and one way to be wrong: a
 * tag sitting ahead of `latest` could redirect the self-update to a build the
 * release line never promoted. Null both when that tag is absent and when it
 * names a version VERSION_RE rejects; `runUpdate` separates those, and neither
 * means the registry was unreachable.
 */
export function resolveTarget(current: string, tags: Record<string, string>): string | null {
  const channel = channelTag(current);
  if (channel === null) return null;
  const candidate = tags[channel];
  // Unparseable counts as absent: isNewer loses every comparison against junk,
  // so admitting one would read as "up to date" forever.
  if (candidate === undefined || parseVersion(candidate) === null) return null;
  return candidate;
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

/**
 * The nudge's one-shot: fetch, then resolve. Null when the registry could not be
 * asked; `{ latest: null }` when it answered with nothing usable.
 */
async function resolveLatest(
  current: string,
  deps: UpdateCheckDeps,
): Promise<{ latest: string | null } | null> {
  const tags = await fetchDistTags({ fetchImpl: deps.fetchImpl, timeoutMs: FETCH_TIMEOUT_MS });
  return tags === null ? null : { latest: resolveTarget(current, tags) };
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

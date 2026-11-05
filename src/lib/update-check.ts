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
import { isNewer, parseVersion } from './version-order';

/**
 * "A newer tenjin-cli exists", asked of npm at most once a day and reported as a
 * dim stderr line for a human at a terminal and as `updateAvailable` on the
 * JSON envelope.
 *
 * It reports and never installs: `update.mode auto` installs from
 * lib/auto-update, which the session hooks start, because Tenjin's runtime lets
 * a running session keep its own version.
 *
 * It never affects the command that ran: the fetch happens after the envelope
 * is written, never touches stdout or the exit code, and swallows every
 * failure. CI skips it, and `update.mode off` silences it, npm request included.
 */

/**
 * Silences this check for one process, cache write and registry request
 * included. `update` sets it on its `install --refresh` children: their data
 * dirs come from a settings file this CLI does not own, and `writeCache` would
 * create such a directory where the refresh only converges what exists.
 */
export const NUDGE_OPT_OUT = 'TENJIN_NO_UPDATE_CHECK';

const CHECK_INTERVAL_MS = 86_400_000; // 24h
const FETCH_TIMEOUT_MS = 1500;
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/tenjin-cli/dist-tags';
const PACKUMENT_URL = 'https://registry.npmjs.org/tenjin-cli';

/** What is known about one dist-tag: when it was asked, and what it said. */
const TagEntrySchema = z.object({
  checkedAtMs: z.number(),
  /** The version the tag named. Absent when the answer was unusable. */
  latest: z.string().optional(),
  /** When the nudge was last printed for this tag. */
  notifiedAtMs: z.number().optional(),
});

/**
 * A pure cache, so a bad one is re-fetched, never repaired. Keyed by dist-tag;
 * an entry this build did not ask about is carried forward untouched.
 */
const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  tags: z.record(z.string(), TagEntrySchema),
  /**
   * The resolved "you could upgrade" fact, written whenever it changes and
   * cleared when it stops being true, so a reader that does not know the
   * running version can still report it.
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
 * Print the update nudge if one is due. Never rejects: the caller awaits it
 * after a command's output, so a throw would replace a finished result.
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

    // The same resolver `tenjin update` uses, so the nudge never names a version
    // the command would not install. Only an unreachable registry skips the
    // cache; an unusable answer still moves the clock.
    let latest: string | null;
    if (fresh) {
      latest = entry.latest ?? null;
    } else {
      const answer = await resolveLatest(current, deps);
      if (answer === null) return;
      latest = answer.latest;
    }

    const upgradeable = latest !== null && isNewer(latest, current);

    // Two clocks: when we last asked npm, and when we last interrupted the
    // human, so a fresh cache does not repeat the line on every command.
    // `human` gates `due` so an agent run, which prints nothing, never stamps
    // the nudge clock and silences a shared machine's terminal for 24h.
    const human = deps.io.isTTY && !deps.json;
    const notifiedAtMs = entry?.notifiedAtMs;
    const due =
      human &&
      upgradeable &&
      (notifiedAtMs === undefined || nowMs - notifiedAtMs >= CHECK_INTERVAL_MS);

    // Carried forward when nothing is printed, so asking npm again does not
    // restart the day since the last nudge.
    const nudgedAtMs = due ? nowMs : notifiedAtMs;

    const signal = upgradeable && latest !== null ? { current, latest } : undefined;
    const signalChanged =
      cached?.signal?.current !== signal?.current || cached?.signal?.latest !== signal?.latest;

    // Nothing learned and nothing said means nothing to write. Not locked: one
    // duplicated line is cheaper than a lock on every command's exit path.
    if (!fresh || due || signalChanged) {
      await writeCache(path, {
        schemaVersion: 1,
        ...(signal !== undefined ? { signal } : {}),
        // The tag this run did not ask about keeps what it knew.
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

    // Names the command, not npm: `update` prints its own instructions for an
    // install it cannot perform (a source checkout, a yarn global).
    if (due && latest !== null) {
      emitNotice(
        deps.io,
        `tenjin-cli ${latest} is available (you have ${current}). Update: run tenjin update`,
        { json: deps.json },
      );
    }
  } catch {
    // Every step is already guarded; this keeps the check invisible regardless.
  }
}

/**
 * What the last check learned, for the envelope. Cache only: this runs before
 * every command's output, so it may not fetch, block or throw. Null when
 * nothing newer is known, the cache is absent or bad, or `update.mode` is `off`.
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
 * Which dist-tag this build follows, or null for a version this package has no
 * channel for, so the nudge goes quiet and `tenjin update` refuses rather than
 * call a foreign build "up to date". Every build follows `latest`; see
 * RELEASING.md, which changes with this.
 */
export function channelTag(version: string): 'latest' | null {
  return parseVersion(version) === null ? null : 'latest';
}

/**
 * The version this build can move to: whatever sits on the tag it follows, and
 * only that tag, so a tag ahead of `latest` cannot redirect the self-update to
 * an unpromoted build. Null when the tag is absent or names an unparseable
 * version; neither means the registry was unreachable.
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
 * Ask the registry for tenjin-cli's whole dist-tag map, or null on any failure,
 * a late response included: the timeout bounds the delay a finished command can
 * suffer. The whole map, so a caller can tell an unreachable registry (null)
 * from one that answered without its tag.
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
 * When the registry says `version` was published (ms since epoch), from the
 * packument's `time` map, since the per-version document has none. Null when
 * the registry could not be asked; `{ publishedAt: null }` when it has no
 * usable time. The registry sets these at publish and a publisher cannot
 * backdate them, which is why `tenjin update --background` can wait on one.
 */
export async function fetchPublishTime(
  version: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs: number },
): Promise<{ publishedAt: number | null } | null> {
  let json: { time?: Record<string, unknown> } | null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(PACKUMENT_URL, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }
  const raw = json?.time?.[version];
  const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return { publishedAt: Number.isNaN(at) ? null : at };
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

// Re-exported from ./version-order for existing importers.
export { isNewer };

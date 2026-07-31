import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import pkg from '../../package.json';
import { writeFileAtomic } from './atomic-json';
import { emitNotice } from './output';
import type { Io } from './output';
import { updateCheckPath } from './paths';

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
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/tenjin-cli/dist-tags';

/** What is known about ONE dist-tag: when it was asked, and what it said. */
const TagEntrySchema = z.object({
  checkedAtMs: z.number(),
  latest: z.string(),
  /** When the nudge was last PRINTED for this tag. Absent until one has been. */
  notifiedAtMs: z.number().optional(),
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
}

/**
 * Print the update nudge if one is due. NEVER rejects — the caller awaits it
 * between a command's output and its exit, so a throw here would replace a
 * finished command's result with an internal error.
 */
export async function maybeNudgeUpdate(deps: UpdateCheckDeps): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    // Human terminal only, and never in CI: a build log cannot act on this.
    if (!deps.io.isTTY || deps.json) return;
    if (env.CI !== undefined && env.CI.length > 0) return;

    const nowMs = (deps.now ?? Date.now)();
    const current = deps.currentVersion ?? pkg.version;
    const path = updateCheckPath(deps.dir);
    // A prerelease build follows the prerelease tag: telling an alpha user about a
    // stable release they cannot get from `@alpha` would be noise, not news.
    const tag = parseVersion(current)?.alpha !== null ? 'alpha' : 'latest';

    // Only this tag's entry answers this binary's question; the other channel's
    // is neither used nor disturbed.
    const cached = await readCache(path);
    const entry = cached?.tags[tag];
    const fresh = entry !== undefined && nowMs - entry.checkedAtMs < CHECK_INTERVAL_MS;

    const latest = fresh ? entry.latest : await fetchLatest(deps, tag);
    if (latest === null) return; // asked and learned nothing: cache nothing either

    // Once a day means once a day, not once per FETCH: a fresh cache would
    // otherwise repeat the same line on every command for 24h. The two clocks are
    // separate because they answer separate questions — when we last asked npm,
    // and when we last interrupted the human.
    const notifiedAtMs = entry?.notifiedAtMs;
    const due =
      isNewer(latest, current) &&
      (notifiedAtMs === undefined || nowMs - notifiedAtMs >= CHECK_INTERVAL_MS);

    // Carried forward when nothing is printed: the day since the last nudge does
    // not restart just because the registry was asked again.
    const nudgedAtMs = due ? nowMs : notifiedAtMs;

    // Nothing learned and nothing said means nothing to write. Deliberately NOT
    // locked: two concurrent CLI processes can both nudge, and one duplicated
    // line is cheaper than a lock on the exit path of every command.
    if (!fresh || due) {
      await writeCache(path, {
        schemaVersion: 1,
        // Read-modify-write: the tag this run did not ask about keeps whatever it
        // knew, including its own nudge clock.
        tags: {
          ...cached?.tags,
          [tag]: {
            checkedAtMs: fresh ? entry.checkedAtMs : nowMs,
            latest,
            ...(nudgedAtMs !== undefined ? { notifiedAtMs: nudgedAtMs } : {}),
          },
        },
      });
    }
    if (!due) return;

    // `@alpha` only when the newer version IS a prerelease: on the stable channel
    // a bare install is what gets you the version just named. isNewer already
    // proved this parses.
    const target = parseVersion(latest)?.alpha === null ? 'tenjin-cli' : 'tenjin-cli@alpha';
    emitNotice(
      deps.io,
      `tenjin-cli ${latest} is available (you have ${current}). Update: npm i -g ${target}`,
      { json: deps.json },
    );
  } catch {
    // Unreachable by construction (every step below is already guarded); here so
    // that staying invisible does not depend on that remaining true.
  }
}

/**
 * Ask the registry which version `tag` is on. Returns null for every failure
 * there is, INCLUDING a response that arrives too late — the AbortSignal is what
 * bounds the delay a finished command can suffer. Nothing is written here: a
 * failed check caches nothing, so the next command retries rather than going
 * quiet for 24h over one dropped packet.
 */
async function fetchLatest(deps: UpdateCheckDeps, tag: string): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  let json: unknown;
  try {
    const res = await doFetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }
  const parsed = DistTagsSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data[tag] ?? null;
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
 * is nagging every single command with a line the user cannot act on.
 */
function isNewer(candidate: string, current: string): boolean {
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

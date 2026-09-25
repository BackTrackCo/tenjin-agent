import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { composeUserAgent } from '../lib/client-meta';
import { isSameDeployment } from '../lib/production-origin';
import { augmentOf, claimQuery, markAugment } from './progress';

/**
 * FREE DOCS ON TOP OF A SEARCH, NEVER IN PLACE OF ONE. When the gate answers a
 * WebSearch with a free offer (the library docs lookup), denying the search for
 * it sent the agent on a detour and, when the docs missed, round a loop, and
 * the `request` call it was sent to rewrote the query. So the search runs as
 * the agent wrote it, and the docs ride above its results:
 *
 * - BEFORE THE CALL, the pre-call hook marks the call (by `tool_use_id`) and
 *   starts the fetch in a detached `node`, so the lookup's few seconds overlap
 *   the search's own instead of following them. The hook does not wait for it.
 * - AFTER THE CALL, the after-call hook waits, bounded, for what the fetch
 *   wrote. A 200 with text becomes one string item prepended to the search's
 *   `results`; anything else (404 no match, 503, 429, a timeout, a crash) is no
 *   output at all, and the agent reads its search as it came back.
 *
 * Nothing here pays, so neither the spend policy nor the wallet is asked, and
 * nothing is denied, so the one-block rule is not either.
 */

/** Longest query the docs endpoint accepts, in its own units (UTF-16). */
export const DOCS_QUERY_MAX = 500;
/** The prefetch's own deadline. The endpoint's upstream answers in 3 to 5 s. */
const PREFETCH_TIMEOUT_MS = 12_000;
/**
 * How long the after-call hook waits for the prefetch, from its own start. The
 * search has already taken about 5 s of the lookup's time by then. It fits,
 * with stdin, inside the after-call hook's timeout (`wire.test.ts` pins it).
 */
export const AUGMENT_WAIT_MS = 10_000;
/** A bound on the docs text, far above what the endpoint sends. */
const MAX_DOCS_CHARS = 100_000;
/** A body file larger than this is not one the prefetch wrote. */
const MAX_BODY_BYTES = 1_000_000;
const POLL_MS = 100;

/** One prefetch: the GET, where its answer goes, and the identity it sends. */
export interface PrefetchJob {
  url: string;
  out: string;
  userAgent: string;
}

export interface AugmentDeps {
  dataDir: string;
  now?: () => number;
  /** Starts the fetch; tests replace the detached process. */
  prefetch?: (job: PrefetchJob) => void;
  /** The after-call wait; tests shorten it. */
  augmentWaitMs?: number;
}

/**
 * THE PREFETCH, AS THE DETACHED PROCESS RUNS IT: one GET, then one file, then
 * exit. Plain JavaScript in a string because it runs as `node -e` with no module
 * graph behind it, so it costs a bare node boot and cannot pull anything else
 * in. It always writes `{status, text}`, status 0 for a failure that has none,
 * through a dot-named temp file and a rename, so the after-call hook reads a
 * whole answer or nothing, and then exits: it is gone by its deadline whatever
 * the lookup is doing. Redirects are refused: the one origin checked is the one
 * fetched. argv: url, out, user agent, timeout ms, max chars.
 */
export const PREFETCH_SCRIPT = [
  "const { renameSync, rmSync, writeFileSync } = require('node:fs');",
  "const { basename, dirname, join } = require('node:path');",
  'const [url, out, agent, timeout, max] = process.argv.slice(1);',
  "const tmp = join(dirname(out), '.' + basename(out) + '.' + process.pid + '.tmp');",
  // The deadline is a plain timer that answers and exits, not an
  // `AbortSignal.timeout`: that one's timer does not hold the process open, so
  // a stalled lookup let it exit without writing anything.
  "const timer = setTimeout(() => done(0, ''), Number(timeout));",
  'const done = (status, text) => {',
  '  clearTimeout(timer);',
  '  try {',
  "    writeFileSync(tmp, JSON.stringify({ status, text }), { mode: 0o600, flag: 'wx' });",
  '    renameSync(tmp, out);',
  '  } catch {',
  '    try { rmSync(tmp, { force: true }); } catch {}',
  '  }',
  '  process.exit(0);',
  '};',
  'fetch(url, {',
  "  headers: { accept: 'text/plain', 'user-agent': agent },",
  "  redirect: 'error',",
  '})',
  "  .then(async (res) => done(res.status, res.ok ? (await res.text()).slice(0, Number(max)) : ''))",
  "  .catch(() => done(0, ''));",
].join('\n');

/**
 * Detached and unreferenced, with no stdio of the hook's: the harness waits for
 * the hook's own exit and pipes, and neither is held. `-e` is CommonJS, so the
 * script's `require` resolves builtins only.
 */
function spawnPrefetch(job: PrefetchJob): void {
  const child = spawn(
    process.execPath,
    [
      '-e',
      PREFETCH_SCRIPT,
      job.url,
      job.out,
      job.userAgent,
      String(PREFETCH_TIMEOUT_MS),
      String(MAX_DOCS_CHARS),
    ],
    {
      detached: true,
      stdio: 'ignore',
      // Never the session's project: a live child would pin its worktree.
      cwd: dirname(job.out),
      windowsHide: true,
    },
  );
  // A spawn that fails reports it here, and an unhandled one would crash the hook.
  child.on('error', () => undefined);
  child.unref();
}

/**
 * The GET the prefetch makes, or null when this build will not make it: the
 * endpoint has to be the deployment the gate itself answered from. The hook
 * puts what comes back in front of the model, so a URL the answer names
 * anywhere else is not fetched.
 */
export function docsUrl(endpoint: string, query: string, baseUrl: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(endpoint);
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (!isSameDeployment(url.origin, base.origin)) return null;
  url.searchParams.set('query', query.slice(0, DOCS_QUERY_MAX));
  return url.toString();
}

/**
 * THE PRE-CALL HALF. Only a WebSearch the harness gave an id can be matched to
 * its after-call event, so only that one is augmented; and one agent's identical
 * search within a few minutes (`AUGMENT_REPEAT_MS`) is not fetched again,
 * whatever the first fetch got. True when the fetch was started.
 */
export async function startAugment(
  call: {
    sessionId: string;
    agentId?: string;
    toolUseId?: string;
    query: string;
  },
  offer: { endpoint: string; provider: string },
  baseUrl: string,
  deps: AugmentDeps,
): Promise<boolean> {
  if (call.toolUseId === undefined) return false;
  const url = docsUrl(offer.endpoint, call.query, baseUrl);
  if (url === null) return false;
  const now = deps.now?.() ?? Date.now();
  if (!(await claimQuery(deps.dataDir, call.sessionId, call.agentId, call.query, now))) {
    return false;
  }
  const out = await markAugment(deps.dataDir, call.sessionId, call.toolUseId, offer.provider, now);
  if (out === null) return false;
  try {
    (deps.prefetch ?? spawnPrefetch)({ url, out, userAgent: composeUserAgent() });
    return true;
  } catch {
    return false;
  }
}

/** A WebSearch response as the harness reported it, and its `results`. */
export interface SearchResponse {
  raw: Record<string, unknown>;
  results: unknown[];
}

/**
 * THE AFTER-CALL HALF. Null when this call was not augmented, so the caller
 * goes on as it always has. Otherwise the search's own response with the docs
 * as its first item, or `updatedToolOutput: null` for "say nothing": the
 * lookup found nothing, failed or ran out of time, or the call itself failed.
 */
export async function finishAugment(
  call: { sessionId: string; toolUseId?: string; search: SearchResponse | null },
  deps: AugmentDeps,
): Promise<{ updatedToolOutput: Record<string, unknown> | null } | null> {
  if (call.toolUseId === undefined) return null;
  const now = deps.now?.() ?? Date.now();
  const marker = await augmentOf(deps.dataDir, call.sessionId, call.toolUseId, now);
  if (marker === null) return null;
  if (call.search === null) return { updatedToolOutput: null };
  // Past the prefetch's own deadline there is nothing left to wait for: it has
  // written, or it never will.
  const budget = Math.min(
    deps.augmentWaitMs ?? AUGMENT_WAIT_MS,
    PREFETCH_TIMEOUT_MS + 1_000 - (now - marker.at),
  );
  const answer = await awaitBody(marker.body, Date.now() + Math.max(0, budget));
  await rm(marker.body, { force: true }).catch(() => undefined);
  const text = answer?.status === 200 ? answer.text.trim() : '';
  if (text.length === 0) return { updatedToolOutput: null };
  return {
    updatedToolOutput: {
      ...call.search.raw,
      results: [docsLine(marker.provider || 'library', text), ...call.search.results],
    },
  };
}

/** The one string prepended to the search's results. */
function docsLine(provider: string, text: string): string {
  return `Tenjin router added ${provider} docs for this search (free). If they don't cover it, use the web results below.\n\n${text}`;
}

async function awaitBody(
  path: string,
  deadline: number,
): Promise<{ status: number; text: string } | null> {
  for (;;) {
    const body = await readBody(path);
    if (body !== null) return body;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)));
  }
}

/** What the prefetch wrote, or null while there is nothing (or nothing whole)
 *  to read. `O_NOFOLLOW`, as every read under the progress directory. */
async function readBody(path: string): Promise<{ status: number; text: string } | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    if ((await file.stat()).size > MAX_BODY_BYTES) return { status: 0, text: '' };
    const parsed: unknown = JSON.parse(await file.readFile('utf8'));
    const { status, text } = (parsed ?? {}) as { status?: unknown; text?: unknown };
    if (typeof status !== 'number' || typeof text !== 'string') return { status: 0, text: '' };
    return { status, text: text.slice(0, MAX_DOCS_CHARS) };
  } catch {
    return { status: 0, text: '' };
  } finally {
    await file.close().catch(() => undefined);
  }
}

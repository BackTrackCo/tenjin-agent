import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadRawConfig } from '../lib/config';
import { httpRequest } from '../lib/http';
import {
  acceptsFor,
  checkLocalLine,
  FileNameSchema,
  OUTCOME_TIMEOUT_MS,
  PlatformSchema,
  ROUTER_PATH,
} from './decision';
import { requestToolAccess, type AgentLookup } from './agent-tools';
import { filesPresent, npxOnPath, platformPair } from './local-tools';
import type { Harness } from './names';
import { clearRouterMemo, readRouterMemo, writeRouterMemo } from './router-memo';
import { routerSettings } from './settings';
import { readJsonFile, writePrivate } from './store-files';

/**
 * THE RULES THE AFTER-CALL LEGS MATCH, AND WHAT THEY REMEMBER. The server
 * compiles the rule list from its catalog and serves it on the free route
 * (`{localRules: {}}`, no gate and no fee). `tenjin mcp` keeps one copy in
 * the data dir, fetches a new one in the background once a day, and keeps
 * the old copy through any failed fetch: an older router answers that form
 * 400, and a 400 must never cost a cached copy. A copy older than a week is
 * not used, so the legs go quiet. With the router off, nothing is fetched.
 *
 * Nothing a leg reads leaves the machine. The only writes are the count of
 * each rule's lines shown and its tool run, which ride the next fetch, and
 * the outcome report a prompt offer's run sends.
 */

export const LOCAL_RULES_FILE = 'local-rules.json';
export const LOCAL_COUNTS_FILE = 'local-counts';
export const MAX_LOCAL_RULES_BYTES = 64 * 1024;
export const LOCAL_RULES_REFRESH_MS = 24 * 60 * 60 * 1000;
export const LOCAL_RULES_RETRY_MS = 60 * 60 * 1000;
export const LOCAL_RULES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COUNTS_BYTES = 256 * 1024;
const MAX_COUNTED_RULES = 64;

const Item = z.string().min(1).max(128);
const RuleId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

const MatchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('words'),
    words: z.array(Item).min(1).max(8),
    bare: z.boolean().optional(),
    flags: z.array(Item).max(8).optional(),
  }),
  z.object({ kind: z.literal('multiline') }),
  z.object({ kind: z.literal('path'), paths: z.array(Item).min(1).max(8) }),
  z.object({ kind: z.literal('edits'), edits: z.number().int().min(2).max(64) }),
  z.object({
    kind: z.literal('output'),
    output: z.array(Item).min(1).max(8),
    words: z.array(Item).min(1).max(8).optional(),
  }),
]);
export type LocalMatch = z.infer<typeof MatchSchema>;

/** Who a rule's tool is, for the settings rules that allow or block a seller. */
const IdentitySchema = z.object({
  service: RuleId,
  source: Item,
  providers: z.array(Item).max(8),
  seller: Item.optional(),
  task: Item,
  categories: z.array(Item).max(8),
});

const RuleSchema = z
  .object({
    rule: RuleId,
    service: RuleId,
    tool: z.string().min(1).max(64),
    identity: IdentitySchema,
    requires: z.array(FileNameSchema).max(8).optional(),
    platforms: z.array(PlatformSchema).min(1).max(16),
    match: MatchSchema,
    line: z.string().min(1).max(2_000),
  })
  .refine((rule) => checkLocalLine(rule.line, rule.tool));
export type LocalRule = z.infer<typeof RuleSchema>;

/** The list as served. A rule this build cannot read (a newer match form, a
 *  tool it does not ship) is dropped alone; the list's own shape is not. */
const RulesSchema = z.object({
  version: z.string().min(1).max(64),
  rules: z
    .array(z.unknown())
    .max(64)
    .transform((rules) =>
      rules.flatMap((rule) => {
        const parsed = RuleSchema.safeParse(rule);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});
export type LocalRules = z.infer<typeof RulesSchema>;

const AnswerSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  localRules: RulesSchema,
});

const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  fetchedAt: z.number().int().nonnegative(),
  localRules: RulesSchema,
});
export type LocalRulesCache = z.infer<typeof CacheSchema>;

function memoDir(dataDir: string): string {
  return join(dataDir, 'router-memo');
}

/** The cached copy, schema-checked and bounded, or null. Never throws. */
export async function readLocalRules(dataDir: string): Promise<LocalRulesCache | null> {
  const raw = await readJsonFile(join(memoDir(dataDir), LOCAL_RULES_FILE), MAX_LOCAL_RULES_BYTES);
  const parsed = CacheSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Writes the copy atomically at 0600; false when it is over the bound or did not land. */
export async function writeLocalRules(
  dataDir: string,
  localRules: LocalRules,
  now: number,
): Promise<boolean> {
  const body = JSON.stringify({ schemaVersion: 1, fetchedAt: now, localRules });
  if (Buffer.byteLength(body) > MAX_LOCAL_RULES_BYTES) return false;
  try {
    await writePrivate(join(memoDir(dataDir), LOCAL_RULES_FILE), `${body}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface LocalCount {
  rule: string;
  shown: number;
  ran: number;
}

/** The free form that asks for the rule list, with the counts since the last one. */
export function buildLocalRulesBody(request: {
  accepts: readonly string[];
  harness?: Harness;
  counts?: readonly LocalCount[];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    localRules: {},
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.counts !== undefined && request.counts.length > 0
      ? { counts: request.counts.map((c) => ({ rule: c.rule, shown: c.shown, ran: c.ran })) }
      : {}),
  };
}

/** One line shown, or one run after it, for the next fetch to send. Never throws. */
export async function appendLocalCount(
  dataDir: string,
  rule: string,
  field: 'shown' | 'ran',
): Promise<void> {
  try {
    await mkdir(memoDir(dataDir), { recursive: true, mode: 0o700 });
    await appendFile(
      join(memoDir(dataDir), LOCAL_COUNTS_FILE),
      `${JSON.stringify({ rule, [field]: 1 })}\n`,
      {
        mode: 0o600,
      },
    );
  } catch {
    // A lost count is one count.
  }
}

/**
 * TAKES THE COUNTS FILE BY RENAMING IT, so two processes fetching at once
 * cannot send one count twice: only one rename finds the file. Returns the
 * totals and the taken file, or null when there were none.
 */
async function takeCounts(dataDir: string): Promise<{ counts: LocalCount[]; path: string } | null> {
  const from = join(memoDir(dataDir), LOCAL_COUNTS_FILE);
  const path = `${from}.${process.pid}.${randomBytes(4).toString('hex')}.sending`;
  try {
    await rename(from, path);
  } catch {
    return null;
  }
  const totals = new Map<string, LocalCount>();
  try {
    if ((await stat(path)).size <= MAX_COUNTS_BYTES) {
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry === null || typeof entry !== 'object') continue;
        const { rule, shown, ran } = entry as Record<string, unknown>;
        if (!RuleId.safeParse(rule).success) continue;
        const total = totals.get(rule as string) ?? { rule: rule as string, shown: 0, ran: 0 };
        if (!totals.has(total.rule) && totals.size >= MAX_COUNTED_RULES) continue;
        total.shown += whole(shown);
        total.ran += whole(ran);
        totals.set(total.rule, total);
      }
    }
  } catch {
    // An unreadable file sends no counts.
  }
  return { counts: [...totals.values()], path };
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Puts counts that were not sent back for the next fetch. */
async function restoreCounts(dataDir: string, counts: readonly LocalCount[]): Promise<void> {
  if (counts.length === 0) return;
  try {
    await appendFile(
      join(memoDir(dataDir), LOCAL_COUNTS_FILE),
      counts.map((c) => `${JSON.stringify(c)}\n`).join(''),
      { mode: 0o600 },
    );
  } catch {
    // Lost counts are counts.
  }
}

export interface FetchRulesDeps {
  dataDir: string;
  baseUrl: string;
  accepts: readonly string[];
  harness?: Harness;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * ONE FETCH OF THE RULE LIST, with the counts. A 2xx answer that reads is
 * written and the counts are deleted; anything else keeps the cached copy and
 * the counts, and no process asks again for an hour.
 */
export async function fetchLocalRules(
  deps: FetchRulesDeps,
): Promise<'fetched' | 'failed' | 'waiting'> {
  const now = deps.now ?? Date.now;
  if ((await readRouterMemo(deps.dataDir, 'local-rules', deps.baseUrl, now())) !== null) {
    return 'waiting';
  }
  const taken = await takeCounts(deps.dataDir);
  const counts = taken?.counts ?? [];
  let fetched = false;
  try {
    const response = await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: OUTCOME_TIMEOUT_MS,
      blockRedirects: true,
      jsonBody: buildLocalRulesBody({
        accepts: deps.accepts,
        ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
        counts,
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (response.ok && response.status >= 200 && response.status < 300) {
      const answer = AnswerSchema.safeParse(response.json);
      fetched =
        answer.success && (await writeLocalRules(deps.dataDir, answer.data.localRules, now()));
    }
  } catch {
    fetched = false;
  }
  if (fetched) {
    if (taken !== null) await rm(taken.path, { force: true }).catch(() => undefined);
    await clearRouterMemo(deps.dataDir, 'local-rules', deps.baseUrl);
    return 'fetched';
  }
  await restoreCounts(deps.dataDir, counts);
  if (taken !== null) await rm(taken.path, { force: true }).catch(() => undefined);
  await writeRouterMemo(deps.dataDir, 'local-rules', deps.baseUrl, {
    now: now(),
    ttlMs: LOCAL_RULES_RETRY_MS,
  });
  return 'failed';
}

/** At most this many keys in each of the legs' maps. */
const MAX_KEYS = 1_000;
/** The distinct files one agent's edits are counted over in one turn. */
const MAX_EDITED_PATHS = 64;

function put<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_KEYS) map.delete(map.keys().next().value!);
}

/** A local offer this process showed, by its id: its tool and its filled line. */
export interface LocalOffer {
  tool: string;
  line: string;
  reported?: true;
}

/**
 * WHAT THE LOCAL LEGS REMEMBER, IN `tenjin mcp`, for its session: the rules,
 * one line per tool per agent over every leg and none for a tool the agent
 * already ran, the files each agent edited this turn, and each local offer
 * by its id. A reload empties it, which allows one more line at most.
 */
export class LocalMemory {
  private cache: LocalRulesCache | null = null;
  private readonly told = new Map<string, 'shown' | 'ran'>();
  private readonly noted = new Map<string, string>();
  private readonly edits = new Map<string, Set<string>>();
  private readonly offers = new Map<string, LocalOffer>();
  private npx: Promise<boolean> | undefined;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** The scope one agent's lines are counted in: the session and the agent. */
  static scope(sessionId: string, agentId?: string): string {
    return `${sessionId}\n${agentId ?? ''}`;
  }

  use(cache: LocalRulesCache | null): void {
    this.cache = cache;
  }

  fetchedAt(): number | undefined {
    return this.cache?.fetchedAt;
  }

  /** The rules in force at `now`: none from a copy over a week old. */
  rules(now: number): LocalRule[] {
    const cache = this.cache;
    if (cache === null || now - cache.fetchedAt > LOCAL_RULES_MAX_AGE_MS) return [];
    return cache.localRules.rules;
  }

  /** Whether this agent was already shown a line for the tool, or ran it. */
  blocked(scope: string, tool: string): boolean {
    return this.told.has(`${scope}\n${tool}`);
  }

  shown(scope: string, tool: string, rule?: string): void {
    const key = `${scope}\n${tool}`;
    if (!this.told.has(key)) put(this.told, key, 'shown');
    if (rule !== undefined) put(this.noted, key, rule);
  }

  ran(scope: string, tool: string): void {
    put(this.told, `${scope}\n${tool}`, 'ran');
  }

  /** The rule whose line this agent was shown for the tool, once. */
  takeNoted(scope: string, tool: string): string | undefined {
    const key = `${scope}\n${tool}`;
    const rule = this.noted.get(key);
    this.noted.delete(key);
    return rule;
  }

  /** How many distinct files the agent edited this turn, and whether this one is new. */
  edited(scope: string, path: string): { count: number; added: boolean } {
    const set = this.edits.get(scope) ?? new Set<string>();
    if (!this.edits.has(scope)) put(this.edits, scope, set);
    if (set.has(path) || set.size >= MAX_EDITED_PATHS) return { count: set.size, added: false };
    set.add(path);
    return { count: set.size, added: true };
  }

  /** A new prompt is a new turn: every agent's edit count in the session restarts. */
  newTurn(sessionId: string): void {
    for (const key of [...this.edits.keys()]) {
      if (key.startsWith(`${sessionId}\n`)) this.edits.delete(key);
    }
  }

  remember(id: string, offer: LocalOffer): void {
    put(this.offers, id, offer);
  }

  offer(id: string): LocalOffer | undefined {
    return this.offers.get(id);
  }

  /** The ids of shown offers of `tool` not yet reported, now marked reported. */
  takeUnreported(tool: string): string[] {
    const ids: string[] = [];
    for (const [id, offer] of this.offers) {
      if (offer.tool !== tool || offer.reported === true) continue;
      offer.reported = true;
      ids.push(id);
    }
    return ids;
  }

  /** Whether `npx` resolves on this process's PATH, asked once. */
  npxReady(): Promise<boolean> {
    this.npx ??= npxOnPath(this.env);
    return this.npx;
  }
}

/**
 * WHETHER THIS MACHINE CAN RUN A LOCAL TOOL NOW: its platform pair is one the
 * tool is qualified on, `npx` resolves on PATH, the project holds the files
 * it needs from `cwd` up to the git root, and a subagent that would run it
 * has Bash. The settings rules on a rule's `identity` join these checks.
 */
export async function localReady(
  memory: LocalMemory | undefined,
  want: {
    platforms: readonly string[];
    files?: readonly string[] | undefined;
    cwd: string;
    bash?: { agentType: string; lookup: AgentLookup };
  },
): Promise<boolean> {
  if (!want.platforms.includes(platformPair())) return false;
  if (!(await (memory?.npxReady() ?? npxOnPath()))) return false;
  if (!(await filesPresent(want.files ?? [], want.cwd))) return false;
  if (want.bash === undefined) return true;
  return (await requestToolAccess(want.bash.agentType, want.bash.lookup, 'Bash')) === 'allowed';
}

export interface LocalRulesSchedule {
  dataDir: string;
  baseUrl: () => Promise<string>;
  acceptsBazaar?: () => Promise<boolean>;
  harness?: Harness;
  cwd?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Reads the cached copy, and fetches a new one when it is a day old and the
 * router is on here. Run at start and on an hourly timer, never on a hook leg.
 */
export async function refreshLocalRules(
  memory: LocalMemory,
  deps: LocalRulesSchedule,
): Promise<void> {
  const now = deps.now ?? Date.now;
  memory.use(await readLocalRules(deps.dataDir));
  const at = memory.fetchedAt();
  if (at !== undefined && at <= now() && now() - at < LOCAL_RULES_REFRESH_MS) return;
  try {
    const config = await loadRawConfig(deps.dataDir);
    const router = await routerSettings({
      cwd: deps.cwd ?? process.cwd(),
      dataDir: deps.dataDir,
      config,
    });
    if (!router.enabled.value) return;
  } catch {
    return;
  }
  const outcome = await fetchLocalRules({
    dataDir: deps.dataDir,
    baseUrl: await deps.baseUrl(),
    accepts: acceptsFor((await deps.acceptsBazaar?.()) === true),
    ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    now,
  });
  if (outcome === 'fetched') memory.use(await readLocalRules(deps.dataDir));
}

/** Starts the refresh now and every hour; the returned function stops it. */
export function scheduleLocalRules(memory: LocalMemory, deps: LocalRulesSchedule): () => void {
  const run = () => void refreshLocalRules(memory, deps).catch(() => undefined);
  run();
  const timer = setInterval(run, LOCAL_RULES_RETRY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

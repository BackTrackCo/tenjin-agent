import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import shipped from './agent-rules.json';

/**
 * THE AGENT DECIDER'S TUNABLE RULES: the job kinds and how often each is
 * resumed, Jev's criteria and the destination each label maps to, how a
 * decision is settled and from what context, the three cost settings, the
 * keyless table, extra floors, what a definition pin keeps, and the allow and
 * exclude lists. The shipped file is `agent-rules.json`; `agent-rules.json` in
 * the data dir (`~/.tenjin`) overrides it, one level deep per top-level key.
 *
 * VALIDATED ON READ, AND A BAD FILE DECIDES NOTHING. An override that does not
 * parse, fails the schema or carries a pattern that does not compile returns
 * null with one stderr line, and the decider keeps every spawn as requested.
 *
 * THE CODE FLOORS ARE NOT HERE. Reviews, security reviews and design work on
 * money, auth, signing or migrations, and migration changes, are floored in
 * `agent-route.ts`, so no file can loosen them; `extraFloors` can only add
 * patterns.
 */

/** The kinds of work Jev chooses among. No label names a model or a vendor:
 *  `destinations` maps each to one. */
export const WORK_LABELS = [
  'keep',
  'bounded-lookup',
  'routine-analysis',
  'hard-judgment',
  'repo-question',
] as const;
export const EFFORT_LABELS = ['keep', 'low', 'medium', 'high', 'xhigh'] as const;
export const COST_SETTINGS = ['saver', 'balanced', 'quality'] as const;
export type WorkLabel = (typeof WORK_LABELS)[number];
export type CostSetting = (typeof COST_SETTINGS)[number];

const MAX_OVERRIDE_BYTES = 64 * 1024;

const pattern = z
  .string()
  .min(1)
  .max(2_000)
  .refine((source) => compiles(source), 'not a regular expression');

const share = z.number().min(0).max(1);
const criterion = z.string().min(1).max(1_000);
/** A Claude tier, or an outside model by its catalogue id. */
const destination = z
  .string()
  .regex(/^(?:claude\/(?:haiku|sonnet|opus)|outside\/[\w.:/-]{1,200})$/);
const glob = z.string().min(1).max(200);

/** One cost setting: the label thresholds and the ratings policy's numbers. */
const Thresholds = z.strictObject({
  minProbability: share,
  minMarginOverKeep: share,
  outsideMinProbability: share,
  outsideMaxChangesState: share,
  outsideMaxResumed: share,
  outsideMaxFollowUp: share,
  userNamedKeeps: share,
  maxEffortStepsDown: z.number().int().min(0).max(4),
  /** The ratings policy: at or above these, the model stays as asked. */
  costlyKeeps: share,
  biggerHelpsKeeps: share,
  /** Under `lightMaxHard` and at least `lightMinCheckable`: the light tier. */
  lightMaxHard: share,
  lightMinCheckable: share,
  /** Under this, the middle tier. */
  middleMaxHard: share,
  /** At or above this, the effort stays as asked. */
  effortHelpsKeeps: share,
  lowEffortMaxHard: share,
  mediumEffortMaxHard: share,
});
export type Thresholds = z.infer<typeof Thresholds>;

const RulesSchema = z.strictObject({
  version: z.literal(1),
  kinds: z
    .array(z.strictObject({ id: z.string().min(1).max(40), pattern, resumed: share.optional() }))
    .max(30),
  /** One criterion per label, and exactly these labels. */
  criteria: z.strictObject({
    work: z.strictObject({
      keep: criterion,
      'bounded-lookup': criterion,
      'routine-analysis': criterion,
      'hard-judgment': criterion,
      'repo-question': criterion,
    }),
    effort: z.strictObject({
      keep: criterion,
      low: criterion,
      medium: criterion,
      high: criterion,
      xhigh: criterion,
    }),
  }),
  destinations: z.strictObject({
    'bounded-lookup': destination,
    'routine-analysis': destination,
    'hard-judgment': destination,
    'repo-question': destination,
  }),
  /** `label`: Jev's direct label; `ratings`: its ratings through the policy. */
  settleBy: z.enum(['label', 'ratings']),
  /** What Jev sees: the brief and a bounded slice of the parent's conversation
   *  (the default), or the brief alone, to send less. */
  context: z.enum(['brief', 'brief+parent']),
  /** The parent slice's bounds: characters in all, and messages, newest kept. */
  parentChars: z.number().int().min(0).max(16_000),
  parentMessages: z.number().int().min(0).max(12),
  cost: z.enum(COST_SETTINGS),
  costs: z.strictObject({ saver: Thresholds, balanced: Thresholds, quality: Thresholds }),
  /**
   * THE KEYLESS TABLE. The shipped reading targets (exploring, a web page read,
   * research) are Sonnet at high: graded blind on ten reading questions, Opus
   * high and medium and Sonnet high could not be told from Opus xhigh, while
   * Opus low and Sonnet medium scored about 0.12 lower on a 0 to 1 scale. So
   * no shipped rule names `low` and `router.effortFloor` is `medium`; an
   * operator turns `low` on with that floor and a rule that names it.
   *
   * READING ON HAIKU is an operator's rule, never shipped, and only at high:
   * a rule naming `haiku` must name effort `high` (the schema refuses any
   * other), and it moves only a spawn asked for high or above whose agent type
   * or tools cannot change state (`readsOnly`, `agent-tools.ts`); any other
   * spawn reads it as Sonnet at most and keeps the caller's one tier. A
   * `maxTiersDown` of 2 likewise acts only for such a spawn. Graded on the same
   * ten reading questions: Haiku 5.5 at high 0.766 (0.679 counting its two
   * format failures as misses), medium 0.689, low 0.611, against Sonnet high
   * 0.832 and Opus xhigh 0.873; about 42% of Sonnet's usage at the same level,
   * slower (49 s against 33 s), and 2 of 30 runs ended without the answer
   * format against 0 of 80 for Sonnet and Opus. So the mod runs a Haiku spawn
   * that returns no usable answer once more as asked (`agents.tsx`).
   */
  keyless: z.strictObject({
    /** Apply mode may act on the keyless table only when the offline run
     *  shows it within two points of Jev; until then it keeps. */
    apply: z.boolean(),
    /** The most tiers a rule may lower a read-only spawn; unset, the caller's (one, in the agent leg). */
    maxTiersDown: z.number().int().min(1).max(2).optional(),
    rules: z
      .array(
        z
          .strictObject({
            id: z.string().min(1).max(60),
            types: z.array(z.string().min(1).max(200)).max(30).optional(),
            kinds: z.array(z.string().min(1).max(40)).max(30).optional(),
            model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
            effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
            /** This rule's own tier cap, for a read-only spawn. */
            maxTiersDown: z.number().int().min(1).max(2).optional(),
          })
          .refine((rule) => rule.model !== 'haiku' || rule.effort === 'high', {
            message: 'a rule naming haiku targets effort high, and only high',
          }),
      )
      .max(50),
  }),
  extraFloors: z.array(z.strictObject({ id: z.string().min(1).max(60), pattern })).max(50),
  /** What an agent definition's pinned model or effort keeps as asked: `both`
   *  is a hard floor; `model` or `effort` keeps that one and lets Jev move the
   *  other; `none` lets Jev move both. */
  definitionPin: z.strictObject({ protects: z.enum(['both', 'model', 'effort', 'none']) }),
  /** Destinations a decision may pick, `*` matching anything; empty allows all. */
  allow: z.array(glob).max(100),
  /** Destinations it never picks; one excluded keeps the spawn as asked. */
  exclude: z.array(glob).max(100),
});

export type AgentRules = z.infer<typeof RulesSchema> & {
  /** Names this exact rule set in a record. */
  hash: string;
};

export interface RulesOptions {
  /** The data dir whose `agent-rules.json` overrides the shipped rules. */
  dataDir?: string;
  /** An explicit override file, in place of the data dir's. */
  path?: string;
  warn?: (line: string) => void;
}

/** The shipped rules with any override applied, or null when the result is not valid. */
export async function loadAgentRules(opts: RulesOptions = {}): Promise<AgentRules | null> {
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const path =
    opts.path ?? (opts.dataDir !== undefined ? join(opts.dataDir, 'agent-rules.json') : undefined);
  let override: unknown = {};
  if (path !== undefined) {
    try {
      const text = await readFile(path, 'utf8');
      if (Buffer.byteLength(text) > MAX_OVERRIDE_BYTES) throw new Error('too large');
      override = JSON.parse(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn('tenjin: agent-rules.json is not valid JSON, so every delegated task runs as asked');
        return null;
      }
    }
  }
  const parsed = RulesSchema.safeParse(merged(shipped, override));
  if (!parsed.success) {
    warn(
      'tenjin: agent-rules.json does not match its schema, so every delegated task runs as asked',
    );
    return null;
  }
  const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex').slice(0, 16);
  return { ...parsed.data, hash };
}

/** The thresholds of a cost setting, the rules' own by default. */
export function thresholdsOf(rules: AgentRules, cost: CostSetting = rules.cost): Thresholds {
  return rules.costs[cost];
}

/** The override over the shipped rules, one level deep per top-level key. */
function merged(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compiles(source: string): boolean {
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

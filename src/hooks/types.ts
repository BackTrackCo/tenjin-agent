import type { Config } from '../lib/config';
import type { Emit, Event, HarnessAdapter, HookInput, ToolKind } from '../adapters/types';
import type { LoopDb } from './store';

/**
 * The kernel's types (02-redesign.md §3, §5). Arms are DATA over one lifecycle:
 * `before` for local writes, `plan` for the one question this fire may ask,
 * `deliver` for what to do with an answer, `after` for local emits.
 */

/** The unit of accounting. `agent` is '' for the lead in every table. */
export interface Actor {
  session: string;
  agent: string;
}

/** Who is blocked on this fire; picks `human_wait_ms` or `tool_wait_ms`. */
export type Wait = 'human' | 'tool';

export type Shelf = 'team' | 'public' | 'keys';

/**
 * The wire `trigger`: which arm asked, so the server can tell a prompt lookup
 * from a research one in its own telemetry (`agent-api.ts`).
 */
export type Trigger = 'prompt' | 'research' | 'read' | 'churn';

/**
 * `legs.status`: the split tenjin-agent#286 asks for, so a timeout, a 5xx, a
 * refused team bypass, bad JSON and a bad shape are distinguishable in the
 * ledger. A leg sets it from the response; the kernel sets `timeout`,
 * `aborted` and `error` for what never returned.
 */
export type LegStatus =
  'ok' | 'timeout' | 'aborted' | 'refused' | 'bad_json' | 'bad_shape' | 'error' | `http_${number}`;

export type Strength = 'strong' | 'weak';

/** One shelf's answer to the question, as the leg's `verdict` judged it. */
export interface Answer {
  shelf: Shelf;
  strength: Strength;
  resourceId: string;
  title?: string;
  url?: string;
  form?: string;
  /** The inline free body when the server sent one (PR F), else undefined. */
  text?: string;
  searchId?: string;
}

export interface LegResult {
  status: LegStatus;
  searchId?: string;
  title?: string;
  url?: string;
  form?: string;
  /**
   * How the shelf produced this answer (`hybrid-v1`, `key-v1`, `lexical-v1`).
   * `lexical-v1` means the meaning step never ran, which is why a spent
   * embedding budget has to be distinguishable from an empty shelf.
   */
  calibration?: string;
  /** What the leg's `verdict` decides over; opaque to the kernel. */
  payload?: unknown;
}

export interface Question {
  text: string;
  /** The once-per-question key the claim gate is keyed on; computed by the arm. */
  questionKey: string;
  /** Identifiers lifted out of the text; the prompt arm fills them, no one else. */
  identifiers?: string[];
}

/**
 * Why an arm looked at the text and asked nothing. It carries the text so the
 * ledger keeps what was skipped: the importance score reads those rows.
 */
export type SkipReason = 'short' | 'long' | 'slash' | 'words';
export interface Skip {
  reason: SkipReason;
  text: string;
}

export interface Leg {
  shelf: Shelf;
  /** `budgetMs` is what the leg forwards as the server's `budget_ms`. */
  request(q: Question, budgetMs: number, signal: AbortSignal): Promise<LegResult>;
  /** null = miss. Search legs judge strength; keys legs judge exact key match. */
  verdict(r: LegResult): Answer | null;
}

/** A stage is parallel legs; the next stage runs only if no stage yielded strong. */
export interface Plan {
  question: Question;
  stages: Leg[][];
}

export interface Delivery {
  mode: 'inject' | 'log';
  text?: string;
  resourceId?: string;
}

/**
 * `fires.reason`, closed. `hit` is the one non-skip: something was delivered.
 * The four {@link SkipReason}s are an arm refusing text it did have (the row
 * still carries the text); `no-question` is having none at all. A phantom
 * SubagentStop and an invalid `agent_id` are the only silent exits, both by
 * `actorOf`, before any row.
 */
export type Reason =
  | 'hit'
  | 'no-question'
  | SkipReason
  | 'rate-server'
  | 'asked'
  | 'cached'
  | 'seen'
  | 'no-hit'
  | 'no-answer'
  | 'deadline'
  | 'error';

export interface Outcome {
  reason: Reason;
  answer?: Answer;
  delivery?: Delivery;
  /** The error class, for `error` rows. */
  detail?: string;
}

/** What one leg contributed, as `legs` records it. */
export interface LegRow {
  stage: number;
  shelf: Shelf;
  status: LegStatus;
  outcome: 'hit' | 'miss' | 'shadowed' | 'no-answer';
  elapsed_ms: number;
  search_id?: string;
  title?: string;
  url?: string;
  form?: string;
  calibration?: string;
}

/** The fire's clock and abort, shared by every leg. */
export interface FireClock {
  id: string;
  startedAt: number;
  deadlineMs: number;
  remaining(): number;
  signal: AbortSignal;
  legs: LegRow[];
}

export interface FireContext {
  actor: Actor;
  input: HookInput;
  arm: Arm;
  fire: FireClock;
  deps: Deps;
}

export interface Arm {
  id: string;
  wait: Wait;
  /** The only event-to-arm map. First matching arm wins. */
  on: Array<{ event: Event; kind?: ToolKind }>;
  before?(ctx: FireContext): void;
  /** A `Skip` is "there was text and I refused it"; null is "there was nothing". */
  plan?(ctx: FireContext): Plan | Skip | null;
  deliver?(answer: Answer, ctx: FireContext): Delivery | null;
  after?(ctx: FireContext, result: Outcome): Emit | null;
}

export type KernelConfig = Pick<Config, 'loop' | 'team' | 'hooks'>;

export interface Deps {
  db: LoopDb;
  /** Read per fire: the daemon reloads on a config.json mtime change. */
  config(): KernelConfig;
  clock(): number;
  log(line: string): void;
  arms: Arm[];
  adapters: Partial<Record<HarnessAdapter['id'], HarnessAdapter>>;
}

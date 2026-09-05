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

/**
 * One shelf's answer to the question, as the leg's `verdict` judged it.
 *
 * THERE IS ONLY ONE STRENGTH, so the type that used to carry it is gone. The
 * shelf vouches per candidate (`strong`) and this machine has no quality rule
 * of its own to grade with: a leg either has a candidate the server vouched
 * for, which is this, or it has a miss.
 */
export interface Answer {
  shelf: Shelf;
  resourceId: string;
  title?: string;
  url?: string;
  form?: string;
  /** The inline free body when the server sent one (PR F), else undefined. */
  text?: string;
  searchId?: string;
  /** What `deliver.ts` renders and nothing else reads: the piece's atomic price
   *  (the free/paid line), its author's handle, and the public excerpt the
   *  pointer form carries when there is no body. Copied off the winning
   *  candidate by the leg's `verdict`, because the kernel never sees one. */
  price?: string;
  handle?: string;
  excerpt?: string;
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
  /** null = miss. Search legs take the shelf's `strong`; keys legs take an
   *  exact key match. Neither grades a candidate the shelf vouched nothing for. */
  verdict(r: LegResult): Answer | null;
}

/** A stage is parallel legs; the next stage runs only if no stage answered. */
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
  /**
   * The last word, and the only place an arm writes what the fire cost it.
   * `question` is the one this fire actually built — null when it never got
   * that far — because an arm that spends a mark must spend it on what was
   * ASKED: re-deriving the question here would race a second fire by the same
   * actor and mark the wrong thing.
   */
  after?(ctx: FireContext, result: Outcome, question: Question | null): Emit | null;
}

/**
 * What a fire reads off `config.json`. The three shelf fields are here because
 * the search leg resolves its own origin and bypass per shelf: `baseUrl` (with
 * the secret) is the team shelf, `publicShelfUrl` is the public one.
 */
export type KernelConfig = Pick<
  Config,
  'loop' | 'team' | 'hooks' | 'baseUrl' | 'publicShelfUrl' | 'shelfBypassSecret'
>;

export interface Deps {
  db: LoopDb;
  /** Read per fire: the daemon reloads on a config.json mtime change. */
  config(): KernelConfig;
  clock(): number;
  log(line: string): void;
  arms: Arm[];
  adapters: Partial<Record<HarnessAdapter['id'], HarnessAdapter>>;
}

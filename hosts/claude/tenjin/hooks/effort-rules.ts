/**
 * MAIN-AGENT EFFORT, THE RULES: fixed rules over one main-session turn, no
 * model call, no server call. Pure: no `$`, so the CLI's tests import it too.
 *
 * - CLASSES. `notification`: the turn was started by a background task or a
 *   subagent reporting back (the engine's `task-notification` origin, never a
 *   guess from text). `ack`: a typed message of at most 60 characters and 8
 *   words with no question mark. `correction`: a typed message that negates the
 *   last answer, asks again, says to retry, or asks for more thought. Anything
 *   else is `keep`.
 * - ONE STEP, OR THE CLASS'S OWN. A lowering class runs `router.effortSteps`
 *   steps below the session's effort (one each by default), never under
 *   `router.effortFloor` (`medium` by default, `low` when an operator turns it
 *   on), the user's own level being its ceiling; `correction` runs one step
 *   above it, up to the cap. Nothing else ever raises.
 * - FLOORS, in code, before any change: the session's first turn, effort set by
 *   hand since the last turn, an ack answering a question about money,
 *   credentials, security, a migration, a push, a merge or a deletion, a level
 *   that is not on the ladder, the ends of the ladder, a session already at or
 *   under the effort floor, and a raise to `max` on a model not known to take
 *   it. Any doubt is `keep`.
 * - HOLDOUT. 20% of eligible turns, by a hash of the session and turn ids,
 *   run as asked and are recorded as held out.
 */

export const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Level = (typeof LADDER)[number];

export const EFFORT_MODES = ['off', 'shadow', 'apply'] as const;
export type EffortMode = (typeof EFFORT_MODES)[number];

export const EFFORT_CLASSES = ['notification', 'ack', 'correction'] as const;
export type EffortClass = (typeof EFFORT_CLASSES)[number];
export type TurnClass = EffortClass | 'keep';

/** The classes on when the config names none: the two that lower. */
export const DEFAULT_CLASSES: readonly EffortClass[] = ['notification', 'ack'];
/** The highest level a correction may raise a turn to, unless the config says lower. */
export const DEFAULT_CAP: Level = 'xhigh';
/** The classes that lower, and how far each goes unless the config says. */
export const LOWERING_CLASSES = ['notification', 'ack'] as const;
export type LoweringClass = (typeof LOWERING_CLASSES)[number];
export type EffortSteps = Readonly<Record<LoweringClass, number>>;
export const DEFAULT_STEPS: EffortSteps = { notification: 1, ack: 1 };
const MAX_STEPS = 4;
/** The floors a lowering may stop at; `low` is the operator's to turn on. */
export const EFFORT_FLOORS = ['low', 'medium'] as const;
export type EffortFloor = (typeof EFFORT_FLOORS)[number];
export const DEFAULT_FLOOR: EffortFloor = 'medium';
export const HOLDOUT_PERCENT = 20;

export type Floor =
  | 'first-turn'
  | 'effort-by-hand'
  | 'approval'
  | 'no-effort'
  | 'lowest'
  | 'effort-floor'
  | 'cap'
  | 'max-unverified';

/**
 * The models `max` is sent to when a correction raises a turn to it: the
 * families Claude Code was seen to send `max` for through `turn.step`
 * (claude-sonnet-5-5 and claude-opus-5-5, 2026-11-11). Any other model keeps
 * its level rather than be sent a level it may refuse. Lowering from `max` is
 * never held back.
 */
const MAX_MODELS = /^claude-(opus|sonnet)-/;

export type EffortSettings = {
  mode: EffortMode;
  classes: readonly EffortClass[];
  cap: Level;
  steps: EffortSteps;
  floor: EffortFloor;
};
export const EFFORT_OFF: EffortSettings = {
  mode: 'off',
  classes: [],
  cap: DEFAULT_CAP,
  steps: DEFAULT_STEPS,
  floor: DEFAULT_FLOOR,
};

/** The prompt origins a person typed: at the terminal, through Remote Control, or an SDK host's own turn. */
const TYPED_ORIGINS = new Set(['composer', 'bridge', 'sdk']);
const ACK_CHARS = 60;
const ACK_WORDS = 8;
/** How much of the previous answer is read for an approval question: its end. */
const APPROVAL_TAIL = 600;
const REPEAT_OVERLAP = 0.6;
const REPEAT_MIN_WORDS = 3;

const MORE_THOUGHT =
  /\b(ultrathink|megathink|think(ing)? (hard|harder|deeply|carefully|more|longer|again|it through|step by step)|be (more )?(thorough|careful|rigorous)|thoroughly|carefully|rigorously|in[- ]depth|take your time|double[- ]check|harder|deeper)\b/i;
const NEGATION =
  /^\s*(no|nope|nah|wrong|incorrect|not (quite|right|that|what))\b|\b(that'?s (wrong|not (it|right|what))|not what i (asked|meant|wanted)|(does|did)n'?t work|still (broken|wrong|failing|fails|not)|you (missed|forgot|ignored)|try again|redo|retry|one more time|again|start over|(is|are|you'?re) wrong|undo)\b/i;
const ASKS =
  /\?|\b(should i|shall i|want me to|do you want|ok to|okay to|go ahead|approve|confirm|proceed|say (the word|yes|go)|ready to|let me know)\b/i;
const SENSITIVE =
  /\$\d|\b(money|pay|payments?|paid|charges?|fees?|funds?|funding|wallet|usdc|x402|spend|refund|billing|credentials?|passwords?|secrets?|api keys?|tokens?|private keys?|auth|oauth|security|permissions?|migrations?|migrate|push(ed|es)?|force-push|merge|deploy|release|publish|delete|deletion|remove|drop|truncate|rm -rf|wipe|reset|destroy)\b/i;

export type TurnStart = {
  /** `origin.kind` of the submission that started the turn; absent when none matched. */
  origin: string | undefined;
  /** The turn's text, read here and never kept. */
  text: string;
  /** A slash command, or a submission carrying images or files. */
  isCommand: boolean;
  /** The previous typed message, from memory, for the repeat rule. */
  previousTyped?: string;
};

export type Classified = {
  class: TurnClass;
  /** Why a correction is one: no text, a fixed code. */
  reason?: 'more-thought' | 'negation' | 'repeat';
  /** The message used a keyword asking for more thought. */
  moreThought: boolean;
};

export function classify(turn: TurnStart): Classified {
  if (turn.origin === 'task-notification') return { class: 'notification', moreThought: false };
  const typed = turn.origin !== undefined && TYPED_ORIGINS.has(turn.origin) && !turn.isCommand;
  const text = turn.text.trim();
  if (!typed || text.length === 0) return { class: 'keep', moreThought: false };
  const moreThought = MORE_THOUGHT.test(text);
  if (moreThought) return { class: 'correction', reason: 'more-thought', moreThought };
  if (NEGATION.test(text)) return { class: 'correction', reason: 'negation', moreThought };
  if (turn.previousTyped !== undefined && isRepeat(text, turn.previousTyped)) {
    return { class: 'correction', reason: 'repeat', moreThought };
  }
  const words = text.split(/\s+/).length;
  if (Array.from(text).length <= ACK_CHARS && words <= ACK_WORDS && !text.includes('?')) {
    return { class: 'ack', moreThought };
  }
  return { class: 'keep', moreThought };
}

/** The same ask again: most of its words are the last typed message's. */
function isRepeat(text: string, previous: string): boolean {
  const a = wordSet(text);
  const b = wordSet(previous);
  if (a.size < REPEAT_MIN_WORDS || b.size < REPEAT_MIN_WORDS) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / new Set([...a, ...b]).size >= REPEAT_OVERLAP;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
}

/** The previous answer ended by asking the person to approve something sensitive. */
export function asksApproval(answer: string): boolean {
  const tail = answer.slice(-APPROVAL_TAIL);
  return ASKS.test(tail) && SENSITIVE.test(tail);
}

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LADDER as readonly string[]).includes(value);
}

export type TurnFacts = {
  classified: Classified;
  settings: EffortSettings;
  /** No main turn of this session has completed since the mod loaded. */
  isFirstTurn: boolean;
  /** The person changed effort by hand since the last turn: a command, or a new session level. */
  isEffortByHand: boolean;
  /** The previous answer asked for approval of something sensitive. */
  isApprovalPending: boolean;
  /** The level the engine would send: the session's setting or the model's default. */
  sessionEffort: unknown;
  /** The model the request names, as the engine resolved it. */
  model?: string;
  /** The turn's hash bucket, 0 to 99. */
  bucket: number;
};

export type Decision = {
  class: EffortClass;
  floor?: Floor;
  /** The session's level, when it is on the ladder. */
  sessionEffort?: Level;
  /** The level the rules pick; the session's when a floor holds. */
  target?: Level;
  isHoldout: boolean;
  /** The level the turn runs at: the target, unless held out, shadowed or floored. */
  used?: Level;
};

/** Null for a turn the rules do not touch (`keep`, or a class switched off). */
export function decide(facts: TurnFacts): Decision | null {
  const kind = facts.classified.class;
  if (facts.settings.mode === 'off' || kind === 'keep' || !facts.settings.classes.includes(kind)) {
    return null;
  }
  const session = isLevel(facts.sessionEffort) ? facts.sessionEffort : undefined;
  const kept = (floor: Floor): Decision => ({
    class: kind,
    floor,
    ...(session !== undefined ? { sessionEffort: session, target: session, used: session } : {}),
    isHoldout: false,
  });
  if (facts.isFirstTurn) return kept('first-turn');
  if (facts.isEffortByHand) return kept('effort-by-hand');
  if (kind === 'ack' && facts.isApprovalPending) return kept('approval');
  if (session === undefined) return kept('no-effort');
  const at = LADDER.indexOf(session);
  let target: Level;
  if (kind === 'correction') {
    if (at >= LADDER.indexOf(facts.settings.cap)) return kept('cap');
    target = LADDER[at + 1] as Level;
    if (target === 'max' && !MAX_MODELS.test(facts.model ?? '')) return kept('max-unverified');
  } else {
    if (at === 0) return kept('lowest');
    const floor = LADDER.indexOf(facts.settings.floor);
    if (at <= floor) return kept('effort-floor');
    target = LADDER[Math.max(floor, at - facts.settings.steps[kind as LoweringClass])] as Level;
  }
  const isHoldout = facts.bucket < HOLDOUT_PERCENT;
  const used = isHoldout || facts.settings.mode !== 'apply' ? session : target;
  return { class: kind, sessionEffort: session, target, isHoldout, used };
}

/** A hash's bucket, 0 to 99, from its first 32 bits. */
export function bucketOf(hex: string): number {
  return Number.parseInt(hex.slice(0, 8), 16) % 100;
}

// SETTINGS -------------------------------------------------------------------

/**
 * `router.effort` (`off`, `shadow`, `apply`), `router.effortClasses` and
 * `router.effortCap`, `router.effortSteps` and `router.effortFloor`, resolved
 * as the CLI's `routerSettings` resolves them: the global `config.json` sets
 * them, and every project layer can only make them more careful (a mode toward
 * `off`, classes by intersection, the cap toward `low`, fewer steps, the floor
 * toward `medium`).
 * `router.enabled false` in any layer is `off`. A value of the wrong type is
 * `off`: doubt never turns anything on.
 */
export function resolveEffortSettings(global: unknown, layers: readonly unknown[]): EffortSettings {
  const top = routerBlock(global);
  if (top === null || top.enabled === false) return EFFORT_OFF;
  const mode = top.effort === undefined ? 'off' : top.effort;
  if (!isMode(mode) || mode === 'off') return EFFORT_OFF;
  let settings: EffortSettings = {
    mode,
    classes: DEFAULT_CLASSES,
    cap: DEFAULT_CAP,
    steps: DEFAULT_STEPS,
    floor: DEFAULT_FLOOR,
  };
  const classes = classesOf(top.effortClasses);
  const cap = top.effortCap;
  const steps = stepsOf(top.effortSteps);
  const floor = top.effortFloor;
  if (classes === null || (cap !== undefined && !isLevel(cap))) return EFFORT_OFF;
  if (steps === null || (floor !== undefined && !isFloor(floor))) return EFFORT_OFF;
  if (classes !== undefined) settings = { ...settings, classes };
  if (isLevel(cap)) settings = { ...settings, cap };
  if (steps !== undefined) settings = { ...settings, steps: { ...DEFAULT_STEPS, ...steps } };
  if (isFloor(floor)) settings = { ...settings, floor };
  for (const layer of layers) {
    const block = routerBlock(layer);
    if (block === null || block.enabled === false) return EFFORT_OFF;
    const lower = block.effort;
    if (lower !== undefined) {
      if (!isMode(lower)) return EFFORT_OFF;
      if (EFFORT_MODES.indexOf(lower) < EFFORT_MODES.indexOf(settings.mode)) {
        settings = { ...settings, mode: lower };
      }
    }
    const only = classesOf(block.effortClasses);
    if (only === null) return EFFORT_OFF;
    if (only !== undefined) {
      settings = { ...settings, classes: settings.classes.filter((c) => only.includes(c)) };
    }
    const lid = block.effortCap;
    if (lid !== undefined) {
      if (!isLevel(lid)) return EFFORT_OFF;
      if (LADDER.indexOf(lid) < LADDER.indexOf(settings.cap)) settings = { ...settings, cap: lid };
    }
    const fewer = stepsOf(block.effortSteps);
    if (fewer === null) return EFFORT_OFF;
    if (fewer !== undefined) {
      const at = settings.steps;
      settings = {
        ...settings,
        steps: {
          notification: Math.min(at.notification, fewer.notification ?? MAX_STEPS),
          ack: Math.min(at.ack, fewer.ack ?? MAX_STEPS),
        },
      };
    }
    // The floor is careful upward: a layer only raises it.
    const raised = block.effortFloor;
    if (raised !== undefined) {
      if (!isFloor(raised)) return EFFORT_OFF;
      if (LADDER.indexOf(raised) > LADDER.indexOf(settings.floor)) {
        settings = { ...settings, floor: raised };
      }
    }
  }
  return settings.mode === 'off' ? EFFORT_OFF : settings;
}

function isFloor(value: unknown): value is EffortFloor {
  return typeof value === 'string' && (EFFORT_FLOORS as readonly string[]).includes(value);
}

/** Undefined when absent, null when not an object of lowering classes at 1 to 4 steps. */
function stepsOf(value: unknown): Partial<Record<LoweringClass, number>> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Partial<Record<LoweringClass, number>> = {};
  for (const [name, steps] of Object.entries(value)) {
    const known = LOWERING_CLASSES.find((c) => c === name);
    if (known === undefined || !Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
      return null;
    }
    out[known] = steps as number;
  }
  return out;
}

function isMode(value: unknown): value is EffortMode {
  return typeof value === 'string' && (EFFORT_MODES as readonly string[]).includes(value);
}

/** Undefined when absent, null when not a list of known classes. */
function classesOf(value: unknown): readonly EffortClass[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const known = value.filter((c): c is EffortClass =>
    (EFFORT_CLASSES as readonly string[]).includes(c as string),
  );
  return known.length === value.length ? known : null;
}

/** A file's `router` block: `{}` when it has none, null when the file is not an object. */
function routerBlock(json: unknown): Record<string, unknown> | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const block = (json as { router?: unknown }).router;
  if (block === undefined) return {};
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;
  return block as Record<string, unknown>;
}

/** What the settings walk reads through: `$.fs` in the mod, `node:fs` in a test. */
export type SettingsFiles = {
  /** The file's text, or undefined when it is not there. Rejects on any other failure. */
  read(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
};

const PROJECT_FILES = ['.tenjin/config.json', '.tenjin/config.local.json'];

/**
 * The CLI's layers, read the way `routerSettings` reads them: the global
 * `<dataDir>/config.json`, then the main checkout's pair when `cwd` is in a
 * linked git worktree, then every `.tenjin/config.json` and
 * `config.local.json` from the git root down to `cwd`, never in $HOME. With
 * the global file off, no project file is read. A file that cannot be read or
 * parsed is `off`.
 */
export async function readEffortSettings(
  files: SettingsFiles,
  where: { dataDir: string; cwd: string; home: string | undefined },
): Promise<EffortSettings> {
  try {
    const global = await readJsonFile(files, `${where.dataDir}/config.json`);
    if (global === null) return EFFORT_OFF;
    const top = resolveEffortSettings(global ?? {}, []);
    if (top.mode === 'off') return EFFORT_OFF;
    const layers: unknown[] = [];
    for (const path of await projectFiles(files, where)) {
      const layer = await readJsonFile(files, path);
      if (layer === null) return EFFORT_OFF;
      if (layer !== undefined) layers.push(layer);
    }
    return resolveEffortSettings(global ?? {}, layers);
  } catch {
    return EFFORT_OFF;
  }
}

/** Undefined when absent, null when not JSON. */
async function readJsonFile(files: SettingsFiles, path: string): Promise<unknown> {
  const text = await files.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The project files that exist, outermost first, each directory's committed file first. */
async function projectFiles(
  files: SettingsFiles,
  where: { dataDir: string; cwd: string; home: string | undefined },
): Promise<string[]> {
  const levels: string[] = [];
  let gitRoot: string | null = null;
  let dir = trimSlash(where.cwd);
  for (;;) {
    if (dir === where.home) break;
    levels.push(dir);
    if (await files.exists(`${dir}/.git`)) {
      gitRoot = dir;
      break;
    }
    const parent = parentOf(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const main = gitRoot === null ? null : await mainCheckout(files, gitRoot, where.home);
  const dirs = [...(main !== null ? [main] : []), ...levels.reverse()];
  const found: string[] = [];
  for (const at of dirs) {
    // A data dir kept inside a project is the global file, already read.
    if (`${at}/.tenjin` === trimSlash(where.dataDir)) continue;
    for (const name of PROJECT_FILES) {
      const path = `${at}/${name}`;
      if (await files.exists(path)) found.push(path);
    }
  }
  return found;
}

/** The main working tree behind a linked worktree, as `mainWorktreeOf` finds it; else null. */
async function mainCheckout(
  files: SettingsFiles,
  gitRoot: string,
  home: string | undefined,
): Promise<string | null> {
  const dotGit = await files.read(`${gitRoot}/.git`).catch(() => undefined);
  const line = dotGit === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(dotGit);
  if (line === null || line[1] === undefined) return null;
  const gitdir = resolvePath(gitRoot, line[1]);
  const common = await files.read(`${gitdir}/commondir`).catch(() => undefined);
  if (common === undefined) return null;
  const commonDir = resolvePath(gitdir, common.trim());
  if (!commonDir.endsWith('/.git')) return null;
  const main = parentOf(commonDir);
  if (main === gitRoot || home === undefined || !main.startsWith(`${home}/`)) return null;
  return main;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function resolvePath(base: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${base}/${path}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

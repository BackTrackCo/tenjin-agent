import type { DefinitionFacts } from './agent-tools';
import type { AgentRules } from './agent-rules';

/**
 * WHAT A DELEGATED TASK ASKS FOR, read in code for the agent decider's floors.
 *
 * THE TASK PART. Briefs carry standing rule text (hard rules, working rules,
 * "never push", "no commits"), and in this repository that text names wallets,
 * credentials and payments in nearly every brief. A floor reads only what is
 * left once {@link taskPart} drops each line that forbids or constrains, and
 * each section headed as rules.
 *
 * THE JOB. A floor holds for the jobs where a weaker model's miss is costly and
 * hard to see: a review, a security review or threat model, design or
 * planning, and creating or changing a migration ({@link protectedJobsOf}).
 * Mechanical work in the same areas (implementing a specified change, applying
 * listed review feedback, running checks, searching, reading, research) is left
 * to Jev, whose safe answer is `keep`.
 */

export type ProtectedJob = 'review' | 'security' | 'design' | 'migration';

export const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ModelTier = (typeof TIERS)[number];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** One message of the parent's conversation before the spawn: the user's own
 *  words or the parent's own text, never a tool result or a file. */
export interface ParentMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** One spawn as the agent leg sees it, before it runs. */
export interface SpawnInput {
  /** `subagent_type`; absent means the harness's general-purpose agent. */
  agentType?: string;
  description?: string;
  /** The task prompt, whole: the decider strips, masks and bounds it. */
  brief: string;
  /** What the parent wrote on the call. */
  named: { model?: string; effort?: string };
  /** What the spawn runs on if kept: the call's, else the definition's, else the parent's. */
  runsOn: { model?: string; effort?: string };
  parentEffort?: string;
  background: boolean;
  /** Spawned with a `name`, so it can be messaged and resumed. */
  addressable: boolean;
  isolation?: string;
  /** Spawned into a team. */
  teammate: boolean;
  definition?: DefinitionFacts | null;
  latestUserInstruction?: string;
  /** The parent's last messages before this spawn, oldest first. */
  parent?: ParentMessage[];
  /** The same job was spawned again soon after a routed run that went here
   *  (`claude/sonnet`, `outside/...`): the decision escalates or keeps. */
  respawn?: { routedTo: string };
}

export function tierOf(model: string | undefined): ModelTier | undefined {
  const lower = model?.toLowerCase();
  return lower === undefined ? undefined : TIERS.find((tier) => lower.includes(tier));
}

export function effortOf(value: string | undefined): Effort | undefined {
  const lower = value?.toLowerCase();
  return EFFORTS.find((effort) => effort === lower);
}

/** Harness blocks and tool output: never task text and never sent. An opening
 *  tag with no close drops everything after it. */
const HARNESS_BLOCK =
  /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|bash-input|command-output|function_results|tool_result|tool-result|task-notification)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/** The text without harness blocks or tool output. */
export function withoutHarness(text: string): string {
  return text.replace(HARNESS_BLOCK, '');
}

/** The description and brief with harness blocks and rule text dropped: what floors read. */
export function taskOf(spawn: SpawnInput): string {
  return taskPart(withoutHarness(`${spawn.description ?? ''}\n${spawn.brief}`));
}

const KIND_HEAD_CHARS = 1_500;

/** The first job kind whose pattern matches the brief's start. */
export function kindOf(brief: string, rules: AgentRules): AgentRules['kinds'][number] | undefined {
  const head = withoutHarness(brief).slice(0, KIND_HEAD_CHARS);
  return rules.kinds.find((kind) => new RegExp(kind.pattern, 'i').test(head));
}

/** A line that forbids or constrains: it starts with a prohibition, or a short
 *  subject and one ("Agents never merge", "You must not push"). */
const PROHIBITION =
  /^\s*(?:[-*+>]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*(?:(?:you|we|agents?|subagents?|it|they|workers?|the agent)\s+)?(?:never|do not|don't|must not|must never|may not|should not|shouldn't|cannot|can't|no|not|nothing)\b/i;

/** A rules title: "Hard rules", "Rules", "Working rules", "Safety",
 *  "Constraints", "What you may and may not run", and the like. */
const RULES_TITLE =
  /^\s*(?:the\s+)?(?:(?:hard|working|ground|safety|house|general|standing|operating)\s+)?(?:rules?|constraints|guardrails|restrictions|prohibitions|safety|limits)\b|\bmay (?:and may )?not\b/i;

/** A line that opens with a rules title and a colon, rule text after it. */
const INLINE_RULES =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*(?:(?:hard|working|ground|safety|house)\s+)?rules?(?:\s+unchanged)?(?:\*\*|__)?\s*:/i;

type Heading = { title: string; kind: 'marked' | 'colon' };

/** A Markdown heading, a whole-line bold title, or a short line ending in a colon. */
function headingOf(line: string): Heading | undefined {
  const marked =
    /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) ??
    /^\s*(?:\*\*|__)([^*_]+?):?(?:\*\*|__):?\s*$/.exec(line);
  if (marked) return { title: marked[1]!, kind: 'marked' };
  const colon = /^\s*([A-Z][^.!?:]{0,60}):\s*$/.exec(line);
  return colon ? { title: colon[1]!, kind: 'colon' } : undefined;
}

/**
 * The text with rule lines and rules sections dropped. A section opened by a
 * Markdown or bold heading runs to the next heading; one opened by a plain
 * `Rules:` line runs to the next heading or the first blank line after it.
 */
export function taskPart(text: string): string {
  const kept: string[] = [];
  let section: Heading['kind'] | null = null;
  let body = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading !== undefined) {
      section = RULES_TITLE.test(heading.title) ? heading.kind : null;
      body = false;
      if (section === null) kept.push(line);
      continue;
    }
    if (section === 'colon' && body && line.trim().length === 0) section = null;
    if (section !== null) {
      body ||= line.trim().length > 0;
      continue;
    }
    if (INLINE_RULES.test(line) || PROHIBITION.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** "Address the review feedback" is implementing, not reviewing. */
const APPLYING_REVIEW =
  /\b(?:address|addressing|apply|applying|fix|fixing|resolve|resolving|answer|answering|handle|handling|reply to|respond to)\b[^.\n]{0,40}\breview\b[^.\n]{0,20}\b(?:feedback|findings?|comments?|threads?|notes|requests?)\b/gi;

const JOBS: readonly { job: ProtectedJob; type?: RegExp; task: RegExp }[] = [
  {
    job: 'review',
    type: /review/i,
    task: /\breview-tenjin\b|\bcode[- ]review\b|\bre-?review\b|\breview(?:ing)? (?:the |this |that |a |my |our )?(?:pr|pull request|diff|patch|branch|changes?|commits?)\b|\breview (?:pr )?#\d+|\breview https?:\/\/\S+\/pull\/\d+|\/review\b|\b(?:as|you are) (?:a|the) reviewer\b/i,
  },
  {
    job: 'security',
    type: /security|\bcso\b/i,
    task: /\bsecurity[- ]review\b|\bthreat[- ]?model\w*|\/cso\b|\bsecurity (?:audit|assessment|analysis)\b|\baudit\b[^.\n]{0,30}\b(?:security|vulnerabilit\w*)|\bpen-?test\w*/i,
  },
  {
    job: 'design',
    type: /^Plan$/,
    task: /\bplan-tenjin\b|\bplan-(?:eng|ceo|design|devex)-review\b|\bautoplan\b|\bwrite (?:a|an|the) (?:\w+ )?plan\b|\bdesign (?:a|an|the)\b|\b(?:write|draft) (?:a|an|the) spec\b/i,
  },
  {
    job: 'migration',
    task: /\b(?:write|add|create|generate|change|edit|modify|update|alter|drop|rename|backfill|squash|amend|revert|fix)\b[^.\n]{0,60}\bmigrations?\b|\balter table\b|\bdrizzle-kit (?:generate|push|migrate)\b/i,
  },
];

/** The protected jobs this task does, read from its agent type and its task part. */
export function protectedJobsOf(agentType: string | undefined, task: string): ProtectedJob[] {
  const asked = task.replace(APPLYING_REVIEW, ' ');
  return JOBS.filter(
    ({ type, task: re }) => (type !== undefined && type.test(agentType ?? '')) || re.test(asked),
  ).map(({ job }) => job);
}

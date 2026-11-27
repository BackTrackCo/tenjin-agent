import type { EngineInterface } from 'claude-code';
type Dollar = EngineInterface;
type Json = Record<string, unknown>;

export function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const blocks = Array.isArray(output) ? output : asRecord(output)?.content;
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .map((block) => asRecord(block))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block!.text as string)
    .join('');
  return text || undefined;
}

export async function tenjinDataDir($: Dollar): Promise<string | null> {
  const override = await $.env.get('TENJIN_DATA_DIR');
  if (override !== undefined && override.length > 0) return override;
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home !== undefined && home.length > 0 ? `${home}/.tenjin` : null;
}

export async function readJson($: Dollar, path: string): Promise<Json | null> {
  try {
    return asRecord(parseJson(await $.fs.read(path))) ?? null;
  } catch {
    return null;
  }
}

export function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * WHETHER THIS SESSION HAS A WORKER JOB: the CLI's job record for `jobId` names this session.
 * No setting is read: a job's progress view depends on the job alone, so a worker started by
 * hand shows as one an offer started does, and a session with no job shows nothing. The record
 * is read, never written, and never inside a worker's own process.
 */
export async function sessionHasJob($: Dollar, jobId: string): Promise<boolean> {
  if (!JOB_ID.test(jobId) || (await $.env.get('TENJIN_MODEL_WORKER')) === '1') return false;
  const dir = await tenjinDataDir($);
  if (dir === null) return false;
  const job = await readJson($, `${dir}/model-jobs/${jobId}.json`);
  return job !== null && job.sessionId === (await $.session.id());
}

/**
 * HOW A HELD AGENT CALL IS ANSWERED: as a refusal whose text carries the offer. Claude
 * Code's own summary of two or more Agent calls reads each call's state, which no hook
 * redraws; answered as completed, a call that was only held read `finished` and `Done`.
 * Refused, it reads as not run. The first line is for a person, and it is how this plugin
 * knows its own held calls again (`model-viewer.tsx`).
 */
export const HELD_WITH_OFFER = 'Tenjin offered DeepSeek for this call and held it';
export const HELD_NOT_STARTED = 'Tenjin held this call and started nothing';

/**
 * THE ROUTER'S HINT FOR A DELEGATED TASK REACHES THE SUBAGENT AS CONTEXT, NOT IN ITS PROMPT.
 * The CLI's hook leg for an Agent call appends its hint to the call's prompt
 * (`updatedInput`, `src/router/hooks.ts`). In auto mode Claude Code then refuses the call
 * once ("a hook changed this call's input after auto mode reviewed it"), and a second
 * call of the same response with it: one more response, and a `Not run` row. So the hint
 * is taken off the call by this plugin's own `classic.PreToolUse` hook, which sits above
 * that leg, and handed to the subagent the call starts as `SubagentStart` context, which changes no input.
 *
 * Only the router's own line is taken: an input that differs from the call's in anything
 * but that line appended to the prompt is another hook's rewrite and passes on whole. A
 * call that starts a teammate or a remote agent raises no `SubagentStart` here, so it
 * keeps the hint in its prompt. A hint is matched to the started agent by the call's
 * agent type and description, which is all the start event and the agent list carry.
 */
const HINT_SOURCE = 'Tenjin router (installed by the user)';
/** How long a hint waits for its subagent to start: a refused or failed call starts none. */
const HINT_MS = 120_000;
const pendingHints: { type: string; description: string; text: string; at: number }[] = [];
function delegatedHint(given: unknown, updated: unknown): string | undefined {
  const [before, after] = [asRecord(given), asRecord(updated)];
  if (!before || !after || typeof before.prompt !== 'string' || typeof after.prompt !== 'string')
    return undefined;
  if (before.name || before.team_name || before.isolation === 'remote') return undefined;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys)
    if (key !== 'prompt' && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      return undefined;
  if (!after.prompt.startsWith(before.prompt + '\n\n')) return undefined;
  const hint = after.prompt.slice(before.prompt.length + 2);
  return hint.startsWith(HINT_SOURCE) ? hint : undefined;
}

/** A `classic.PreToolUse` result with the router's hint taken off an Agent call and kept for its subagent. */
export async function keepDelegatedHint<R extends { updatedInput?: Json }>(
  $: Dollar,
  tool: string,
  call: Json,
  result: R,
): Promise<R> {
  if ((tool !== 'Agent' && tool !== 'Task') || !result.updatedInput) return result;
  const text = delegatedHint(call, result.updatedInput);
  if (text === undefined) return result;
  const now = await $.clock.now().catch(() => 0);
  while (pendingHints.length >= 32 || (pendingHints[0] && now - pendingHints[0].at > HINT_MS))
    pendingHints.shift();
  pendingHints.push({
    type: typeof call.subagent_type === 'string' ? call.subagent_type : 'general-purpose',
    description: typeof call.description === 'string' ? call.description : '',
    text,
    at: now,
  });
  const rest = { ...result };
  delete rest.updatedInput;
  return rest;
}

/** A `classic.SubagentStart` result with the hint kept for the agent that starts, if one was. */
export async function withDelegatedHint<R extends { additionalContext?: string[] }>(
  $: Dollar,
  e: { agent_id: string; agent_type: string },
  result: R,
): Promise<R> {
  if (pendingHints.length === 0) return result;
  const now = await $.clock.now().catch(() => 0);
  const live = (hint: (typeof pendingHints)[number]) => now - hint.at <= HINT_MS;
  let at = -1;
  let listed = false;
  try {
    const started = (await $.agent.list()).find((agent) => agent.id === e.agent_id);
    listed = started !== undefined;
    if (started)
      at = pendingHints.findIndex(
        (hint) =>
          live(hint) && hint.type === started.type && hint.description === started.description,
      );
  } catch {
    /* Matched by its type below, where that names one call. */
  }
  // An agent the list does not show yet is matched by its type, where one call waits for it.
  if (at < 0 && !listed) {
    const same = pendingHints.filter((hint) => live(hint) && hint.type === e.agent_type);
    if (same.length === 1) at = pendingHints.indexOf(same[0]!);
  }
  if (at < 0) return result;
  const [hint] = pendingHints.splice(at, 1);
  return { ...result, additionalContext: [...(result.additionalContext ?? []), hint!.text] };
}

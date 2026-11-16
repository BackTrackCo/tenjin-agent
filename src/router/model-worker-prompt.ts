/** What the worker's permission ask tells a person, from the native ask's own fields. */
export type WorkerPermissionAsk = { title?: string; description?: string; reason?: string };
/** A person's answer: allow this call once, allow it for the rest of this job, or deny. */
export type WorkerPermissionAnswer = boolean | 'job';

const MAX_SUMMARY_CHARS = 2000;

function summary(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern'])
    if (typeof input[key] === 'string') return input[key] as string;
  return JSON.stringify(input);
}

/** The MCP form shown for one worker ask: the tool and its command or path, never raw JSON
 * when a plain field says it, with "Allow once", "Allow for this job" and "Deny". */
export function workerPermissionForm(
  tool: string,
  input: Record<string, unknown>,
  ask: WorkerPermissionAsk = {},
  { jobChoice = true }: { jobChoice?: boolean } = {},
) {
  const what = summary(input);
  const choices = jobChoice
    ? { enum: ['once', 'job', 'deny'], enumNames: ['Allow once', 'Allow for this job', 'Deny'] }
    : { enum: ['once', 'deny'], enumNames: ['Allow once', 'Deny'] };
  const lines = [
    ask.title?.trim() || `DeepSeek worker wants to use ${tool}`,
    what.length > MAX_SUMMARY_CHARS ? what.slice(0, MAX_SUMMARY_CHARS) + '…' : what,
    ...(ask.description?.trim() ? [ask.description.trim()] : []),
    ...(ask.reason?.trim() ? [`Why it asks: ${ask.reason.trim()}`] : []),
  ];
  return {
    mode: 'form' as const,
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object' as const,
      properties: {
        decision: {
          type: 'string' as const,
          title: 'DeepSeek worker request',
          ...choices,
          default: 'deny',
        },
      },
      required: ['decision'],
    },
  };
}

export function workerPermissionAnswer(response: {
  action: string;
  content?: Record<string, unknown>;
}): WorkerPermissionAnswer {
  if (response.action !== 'accept') return false;
  const decision = response.content?.decision;
  return decision === 'job' ? 'job' : decision === 'once';
}

/** Rules a job-wide allow may keep: only rule additions, scoped to the worker's own
 * session. A suggestion that adds directories or changes the mode is dropped, so an
 * allow never widens the consented workspace or the accepted mode. */
export function jobScopedRules<T extends { type: string }>(
  suggestions: readonly T[] | undefined,
): (T & { destination: 'session' })[] {
  return (suggestions ?? [])
    .filter((suggestion) => suggestion.type === 'addRules')
    .map((suggestion) => ({ ...suggestion, destination: 'session' as const }));
}

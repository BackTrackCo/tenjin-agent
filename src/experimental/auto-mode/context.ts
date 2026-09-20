import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { mask } from '../../lib/redact';

export const HookEventSchema = z.object({
  hook_event_name: z.literal('PreToolUse'),
  session_id: z.string().min(1).max(200),
  tool_use_id: z.string().min(1).max(200),
  transcript_path: z.string().min(1),
  tool_name: z.enum(['WebSearch', 'WebFetch']),
  tool_input: z.record(z.string(), z.unknown()),
});
export type HookEvent = z.infer<typeof HookEventSchema>;
export interface TaskContext {
  messages: { role: 'user' | 'assistant'; text: string }[];
  fingerprint: string;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read only the transcript supplied by the current harness event. Fail closed on
 * partial/oversized history; do not search another session to fill the gap. */
export async function readTaskContext(path: string, sessionId: string): Promise<TaskContext> {
  const file = await open(path, 'r');
  let raw: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4_000_000)
      throw new Error('Transcript missing or oversized.');
    const buffer = Buffer.alloc(4_000_001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4_000_000) throw new Error('Transcript grew beyond the context limit.');
    raw = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const messages: TaskContext['messages'] = [];
  for (const line of raw.split('\n').filter((line) => line.trim())) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (typeof row.sessionId === 'string' && row.sessionId !== sessionId) {
      throw new Error('Transcript belongs to a different session.');
    }
    if (row.isSidechain === true) throw new Error('Subagent transcripts are not supported.');
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      throw new Error('Compacted history needs an explicit task restatement for this MVP.');
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    if (row.sessionId !== sessionId) {
      throw new Error('Transcript conversation record lacks the current session identity.');
    }
    const message = row.message as { content?: unknown; role?: string } | undefined;
    if (!message) continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((part: unknown) => {
                if (
                  part &&
                  typeof part === 'object' &&
                  'type' in part &&
                  part.type === 'text' &&
                  'text' in part &&
                  typeof part.text === 'string'
                )
                  return [part.text];
                return [];
              })
              .join('\n')
          : '';
    if (text) messages.push({ role: row.type, text: mask(text) });
  }
  if (!messages.some((message) => message.role === 'user'))
    throw new Error('No user task in transcript.');
  if (JSON.stringify(messages).length > 48_000)
    throw new Error('Task history exceeds the context limit.');
  return { messages, fingerprint: fingerprint(messages) };
}

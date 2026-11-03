import type { PacketMessage } from './context';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** CLI 0.154.0's completed conversation items, not synthetic response_item
 * prompts or tool output. Unknown ownership/compaction means unavailable. */
export function parseCodexHistory(raw: string, session: string): PacketMessage[] | null {
  const messages: PacketMessage[] = [];
  const seen = new Set<string>();
  let owned = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return null;
    }
    if (!record(row) || !record(row.payload)) continue;
    const p = row.payload;
    if (row.type === 'session_meta') {
      if (
        owned ||
        p.id !== session ||
        p.session_id !== session ||
        p.thread_source !== 'user' ||
        p.parent_thread_id != null
      )
        return null;
      owned = true;
      continue;
    }
    if (!owned) return null;
    // Compaction has not been qualified. Never resurrect pre-compaction
    // restrictions or assume that an unrecognized summary is user text.
    if (
      row.type === 'compacted' ||
      p.type === 'context_compacted' ||
      p.type === 'compaction' ||
      p.type === 'compaction_completed'
    )
      return null;
    if (row.type !== 'event_msg' || p.type !== 'item_completed') continue;
    if (p.thread_id !== session || !record(p.item)) return null;
    const item = p.item;
    if (item.type === 'ContextCompaction' || item.type === 'Compaction') return null;
    const user = item.type === 'UserMessage';
    if (!user && !(item.type === 'AgentMessage' && item.phase === 'final_answer')) continue;
    if (typeof item.id !== 'string' || !Array.isArray(item.content)) return null;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const text = item.content
      .filter(record)
      .filter((b) => b.type === (user ? 'text' : 'Text') && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    if (text.trim()) messages.push({ role: user ? 'user' : 'assistant', text });
  }
  return owned && messages.some((m) => m.role === 'user') ? messages : null;
}

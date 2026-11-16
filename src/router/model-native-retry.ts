import { z } from 'zod';
import type { ModelNativeTool } from './model-continuation';

type NativeRetryReference =
  | { owned: false }
  | { owned: true; error: string; id?: never }
  | { owned: true; id: string; error?: never };

/** Only a whole reserved prompt is control input; ordinary mentions remain assignments. */
export function nativeRetryReference(
  native: Record<string, unknown>,
  tool: ModelNativeTool,
): NativeRetryReference {
  const ownedPrompt =
    typeof native.prompt === 'string' && /^\s*tenjin-native\s*:/i.test(native.prompt);
  const ownedResume = typeof native.resume === 'string' && /^\s*tenjin-offer-/i.test(native.resume);
  const ownedType =
    typeof native.subagent_type === 'string' && /^\s*tenjin-native-/i.test(native.subagent_type);
  if (!ownedPrompt && !ownedResume && !ownedType) return { owned: false as const };
  const id = typeof native.prompt === 'string' ? native.prompt.slice('tenjin-native:'.length) : '';
  if (
    !['Agent', 'Task'].includes(tool) ||
    native.prompt !== `tenjin-native:${id}` ||
    id !== id.toLowerCase() ||
    !z.uuid().safeParse(id).success ||
    native.subagent_type !== `tenjin-native-${id}` ||
    Object.keys(native).some((key) => !['prompt', 'description', 'subagent_type'].includes(key)) ||
    (native.description !== undefined && typeof native.description !== 'string')
  )
    return { owned: true as const, error: 'Invalid native retry reference' };
  return { owned: true as const, id };
}

export const nativeRetryRefusal = (reason: string) => ({
  action: 'refused' as const,
  started: false,
  reason,
  instruction:
    'No native retry started. Use the complete original native call if appropriate. Do not execute a tenjin-native marker as an assignment.',
});

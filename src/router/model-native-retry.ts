import { nativeRetryReference as sharedNativeRetryReference } from '../../hosts/claude/tenjin/hooks/native-retry-reference';
import type { ModelNativeTool } from './model-continuation';

type NativeRetryReference =
  | { owned: false }
  | { owned: true; error: string; id?: never }
  | { owned: true; id: string; error?: never };

/** Shared with the shipped host: malformed legacy markers stay reserved on every tool. */
export function nativeRetryReference(
  native: Record<string, unknown>,
  tool: ModelNativeTool,
): NativeRetryReference {
  const parsed = sharedNativeRetryReference(native, tool);
  if (!parsed.owned) return parsed;
  return parsed.id
    ? { owned: true, id: parsed.id }
    : { owned: true, error: 'Invalid native retry reference' };
}

export const nativeRetryRefusal = (reason: string) => ({
  action: 'refused' as const,
  started: false,
  reason,
  instruction:
    'No native retry started. Use the complete original native call if appropriate. Do not execute a tenjin-native marker as an assignment.',
});

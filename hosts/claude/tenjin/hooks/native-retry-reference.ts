type RetryReference = { owned: false } | { owned: true; id?: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RETRY = new RegExp(`^tenjin-native:(${UUID})$`);
const RESERVED = /^\s*tenjin-native\s*:/i;
const RESERVED_RESUME = /^\s*tenjin-offer-/i;
const RESERVED_TYPE = /^\s*tenjin-native-/i;

/** A reserved control prompt is never a literal native assignment. */
export function nativeRetryReference(input: Record<string, unknown>, tool: string): RetryReference {
  if (!(
    (typeof input.prompt === 'string' && RESERVED.test(input.prompt)) ||
    (typeof input.resume === 'string' && RESERVED_RESUME.test(input.resume)) ||
    (typeof input.subagent_type === 'string' && RESERVED_TYPE.test(input.subagent_type))
  ))
    return { owned: false };
  const match = typeof input.prompt === 'string' ? RETRY.exec(input.prompt) : null;
  if (
    tool !== 'Agent' ||
    !match ||
    Object.keys(input).some((key) => !['prompt', 'description', 'subagent_type'].includes(key)) ||
    input.subagent_type !== `tenjin-native-${match?.[1]}` ||
    (input.description !== undefined && typeof input.description !== 'string')
  )
    return { owned: true };
  return { owned: true, id: match[1] };
}

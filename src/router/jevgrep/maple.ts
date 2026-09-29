import { CliError } from '../../lib/errors';
import { jevgrepProfile, type JevgrepProfileId } from './profile';
import {
  JEV_MODEL,
  validateNativeRequest,
  validateNativeResponse,
  type NativeEvaluationRequest,
  type NativeEvaluationResponse,
} from './protocol';

/** Maple's native SystemOne endpoint accepts only a string state and its
 * public alias. Keep the canonical request unchanged for replay identities.
 */
export function encodeMapleRequest(
  input: NativeEvaluationRequest,
  profile?: JevgrepProfileId,
): string {
  const request = validateNativeRequest(input, profile);
  const encoded = JSON.stringify({
    ...request,
    model: 'jev-latest',
    state: typeof request.state === 'string' ? request.state : JSON.stringify(request.state),
  });
  // Serializing structured state adds escaping. Bound the actual transmitted
  // body too, before any HTTP request or payment authorization.
  if (Buffer.byteLength(encoded) > jevgrepProfile(profile).limits.requestBytes)
    throw new CliError('REFUSED', 'The adapted evaluation request exceeds its byte limit.');
  return encoded;
}

export function validateMapleResponse(
  value: unknown,
  request: NativeEvaluationRequest,
): NativeEvaluationResponse {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'model') ||
    (value as Record<string, unknown>).model !== JEV_MODEL
  )
    throw new CliError('REFUSED', 'The provider did not return the approved evaluation model.');
  // A returned alias is not evidence that the approved pinned model executed.
  return validateNativeResponse(value, request);
}

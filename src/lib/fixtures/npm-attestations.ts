import alpha32 from './npm-attestations-0.1.0-alpha.32.json';

/**
 * npm's attestations for tenjin-cli 0.1.0-alpha.32, the first runtime build,
 * exactly as `registry.npmjs.org/-/npm/v1/attestations/tenjin-cli@0.1.0-alpha.32`
 * serves them: the publish attestation, then the SLSA provenance whose
 * statement names that version's sha512 and Tenjin's release workflow.
 */
export const ALPHA32_ATTESTATIONS = alpha32;

/**
 * The same answer for another release: alpha.32's, with its SLSA statement's
 * subject moved to `version` at `sha512Hex`, and `workflow` laid over the one
 * it names. Everything else keeps npm's real shape, so tests hold the
 * provenance check to what npm sends, not to a statement written beside it.
 */
export function attestationsFor(
  version: string,
  sha512Hex: string,
  workflow: Record<string, string> = {},
): typeof alpha32 {
  const answer = structuredClone(alpha32);
  const envelope = answer.attestations.find(
    (a) => a.predicateType === 'https://slsa.dev/provenance/v1',
  )!.bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  statement.subject = [{ name: `pkg:npm/tenjin-cli@${version}`, digest: { sha512: sha512Hex } }];
  Object.assign(statement.predicate.buildDefinition.externalParameters.workflow, workflow);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  return answer;
}

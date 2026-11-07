import { CliError } from './errors';

const REGISTRY = 'https://registry.npmjs.org/tenjin-cli';
const REGISTRY_FIX = 'Check access to registry.npmjs.org and run `tenjin update` again.';

/**
 * Was this release built by Tenjin's release workflow? `dist.integrity` alone
 * cannot say: the publisher writes it, so whoever holds npm credentials (a
 * phished maintainer, a leftover token) names both the tarball and its hash,
 * and every self-updating runtime would run their release within a day. So a
 * release must also carry npm's SLSA provenance, whose signed statement names
 * `pkg:npm/tenjin-cli@<version>` with that same sha512, built by exactly
 * {@link RELEASE_WORKFLOW}.
 *
 * This trusts npm, which verifies the Sigstore bundle and the workflow's
 * GitHub Actions OIDC identity at publish, so npm credentials alone cannot
 * forge the statement. Full client-side Sigstore verification needs
 * dependencies this package does not carry.
 *
 * It does not stop a compromised release workflow (a malicious commit on
 * `main`, a hijacked run). The background update's day of waiting
 * (`BACKGROUND_COOLDOWN_MS` in commands/update) is the window to move `latest`
 * back before any runtime takes it.
 *
 * Nothing skips this, no env var and no flag, because a bypass is exactly what
 * an attacker would set.
 */
const RELEASE_WORKFLOW = {
  repository: 'https://github.com/BackTrackCo/tenjin-agent',
  path: '.github/workflows/release.yml',
  ref: 'refs/heads/main',
} as const;
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const ATTESTATIONS = 'https://registry.npmjs.org/-/npm/v1/attestations';

/** Is `workflow` exactly {@link RELEASE_WORKFLOW}, no key more or less? */
function isReleaseWorkflow(workflow: unknown): boolean {
  if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) return false;
  const named = workflow as Record<string, unknown>;
  const want = Object.entries(RELEASE_WORKFLOW);
  return (
    Object.keys(named).length === want.length && want.every(([key, value]) => named[key] === value)
  );
}

/**
 * Why the registry's attestations for `tenjin-cli@<version>` do not show that
 * `version`, with the sha512 `sha512Hex`, was built by Tenjin's release
 * workflow, or null when they do. Null `attestations` is the registry's 404:
 * the version carries none. See {@link RELEASE_WORKFLOW}.
 */
export function provenanceProblem(
  attestations: unknown,
  version: string,
  sha512Hex: string,
): string | null {
  const list = (attestations as { attestations?: unknown } | null)?.attestations;
  if (!Array.isArray(list)) return 'npm holds no attestations for it';
  const provenance = (list as { predicateType?: unknown; bundle?: unknown }[]).find(
    (a) => a?.predicateType === SLSA_PROVENANCE,
  );
  if (provenance === undefined) return 'npm holds no build provenance for it';
  const payload = (provenance.bundle as { dsseEnvelope?: { payload?: unknown } } | undefined)
    ?.dsseEnvelope?.payload;
  if (typeof payload !== 'string') return 'its provenance carries no statement';
  let statement: {
    predicateType?: unknown;
    subject?: unknown;
    predicate?: { buildDefinition?: { externalParameters?: { workflow?: unknown } } };
  } | null;
  try {
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as typeof statement;
  } catch {
    return 'its provenance statement is not JSON';
  }
  if (statement?.predicateType !== SLSA_PROVENANCE) return 'its statement is not SLSA provenance';
  const name = `pkg:npm/tenjin-cli@${version}`;
  const subject = Array.isArray(statement.subject)
    ? (statement.subject as { name?: unknown; digest?: { sha512?: unknown } }[]).find(
        (s) => s?.name === name,
      )
    : undefined;
  if (subject === undefined) return `its provenance does not name ${name}`;
  const digest = subject.digest?.sha512;
  if (typeof digest !== 'string' || digest.toLowerCase() !== sha512Hex) {
    return 'its provenance names another sha512 than the registry does';
  }
  if (!isReleaseWorkflow(statement.predicate?.buildDefinition?.externalParameters?.workflow)) {
    return "it was built by something other than Tenjin's release workflow on main";
  }
  return null;
}

/**
 * The registry's attestations for `tenjin-cli@<version>`, or null when it has
 * none (a 404), from the registry the tarball comes from, with the same fetch,
 * timeout and proxy. Anything else that fails is the network's.
 */
async function attestationsOf(
  version: string,
  o: { timeoutMs: number; fetchImpl: typeof fetch },
): Promise<unknown> {
  try {
    const res = await o.fetchImpl(`${ATTESTATIONS}/tenjin-cli@${version}`, {
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } catch (err) {
    throw new CliError(
      'NETWORK_ERROR',
      `could not read the build provenance of tenjin-cli ${version} from the npm registry: ${err instanceof Error ? err.message : String(err)}`,
      { fix: REGISTRY_FIX, cause: err },
    );
  }
}

/** A release {@link checkReleaseProvenance} let through: where it is and what it must hash to. */
export interface AttestedRelease {
  /** The tarball's URL, on the registry itself. */
  tarball: string;
  /** `dist.integrity`'s sha512 entry, `sha512-<base64>`. */
  integrity: string;
  /** The same sha512 in hex, as the provenance statement names it. */
  sha512Hex: string;
}

/**
 * The gate every registry release passes before anything is downloaded or
 * installed: the metadata must name a tarball on the registry itself and its
 * sha512, and npm's provenance must show Tenjin's release workflow built that
 * sha512 (see {@link RELEASE_WORKFLOW}), or this throws UPDATE_FAILED and the
 * running version keeps running. Callers: `stageTarball` (`runtime-place.ts`),
 * which then checks the downloaded bytes against the result, and the npm
 * branch of `tenjin update`, which installs that exact version.
 */
export async function checkReleaseProvenance(
  version: string,
  o: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<AttestedRelease> {
  const fetchImpl = o.fetchImpl ?? fetch;
  let meta: { dist?: { tarball?: unknown; integrity?: unknown } };
  try {
    const res = await fetchImpl(`${REGISTRY}/${version}`, {
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = (await res.json()) as typeof meta;
  } catch (err) {
    throw new CliError(
      'NETWORK_ERROR',
      `could not read tenjin-cli ${version} from the npm registry: ${err instanceof Error ? err.message : String(err)}`,
      { fix: REGISTRY_FIX, cause: err },
    );
  }
  const tarball = meta.dist?.tarball;
  const integrity =
    typeof meta.dist?.integrity === 'string'
      ? meta.dist.integrity.split(/\s+/).find((h) => h.startsWith('sha512-'))
      : undefined;
  if (typeof tarball !== 'string' || !tarball.startsWith(`${REGISTRY}/-/`)) {
    throw new CliError(
      'UPDATE_FAILED',
      `tenjin-cli ${version} names a tarball outside the npm registry`,
    );
  }
  if (integrity === undefined) {
    throw new CliError('UPDATE_FAILED', `tenjin-cli ${version} carries no sha512 integrity`);
  }
  const sha512Hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  const problem = provenanceProblem(
    await attestationsOf(version, { timeoutMs: o.timeoutMs, fetchImpl }),
    version,
    sha512Hex,
  );
  if (problem !== null) {
    throw new CliError(
      'UPDATE_FAILED',
      `tenjin-cli ${version} has no valid build provenance from Tenjin's release workflow (${problem}), so it was not installed`,
      {
        fix: 'Nothing to do: the version you have keeps running. Tenjin installs only releases npm shows were built by its own release workflow.',
      },
    );
  }
  return { tarball, integrity, sha512Hex };
}

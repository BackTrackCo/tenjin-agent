import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { prepareNpmRuntime, type NpmRuntime } from '../local/npm-runtime';
import { runBoundedCommand, type BoundedCommand, type CommandResult } from '../local/process';
import { JEV_MODEL } from './protocol.js';
import { jevgrepProfile, type JevgrepProfileId } from './profile';
import { startJevgrepProxy } from './proxy.js';
import type { JevgrepEvaluate } from './proxy.js';
import { createJevgrepSnapshot, SnapshotPolicyUnavailable } from './snapshot.js';
import type { SnapshotSummary } from './snapshot.js';
import { createJevgrepAnswerCache } from './answer-cache.js';
import type { JevgrepSupplier } from './supplier';

import { isQualifiedJevgrepRelease } from './runtime';
export { QUALIFIED_JEVGREP_RELEASES } from './runtime';
export type JevgrepRuntime = NpmRuntime;
export type JevgrepRunResult = {
  status: 'complete' | 'partial' | 'failed' | 'cancelled' | 'unavailable';
  output: string;
  reason?: string;
  requests: number;
  cacheHits?: number;
  snapshot?: SnapshotSummary;
};
export function isJevgrepRuntimeAvailable(runtime: JevgrepRuntime | undefined): boolean {
  if (!runtime || !['darwin', 'linux'].includes(process.platform)) return false;
  return runtime.kind === 'release'
    ? isQualifiedJevgrepRelease(runtime.version)
    : isAbsolute(runtime.path) &&
        runtime.path.endsWith('.tgz') &&
        /^[a-f0-9]{64}$/.test(runtime.sha256);
}

function redactedOutput(raw: string, token: string) {
  const cleaned = raw.replaceAll(token, '[redacted]');
  if (cleaned.replace(/\s/g, '').includes(token.slice(0, 12))) return '[output redacted]';
  return cleaned;
}

function boundedUtf8(value: string, bytes: number): string {
  const clipped = Buffer.from(value).subarray(0, bytes).toString('utf8');
  return Buffer.byteLength(clipped) <= bytes ? clipped : clipped.slice(0, -1);
}

export async function runJevgrep(
  options: {
    root: string;
    dataDir: string;
    query: string;
    runtime?: JevgrepRuntime;
    /** A repository hook binds its offer before the agent authors the query. */
    expectedCommit?: string;
    profile?: JevgrepProfileId;
    supplier?: JevgrepSupplier;
    evaluate: JevgrepEvaluate;
    signal?: AbortSignal;
    onProgress?: (message: string) => void | Promise<void>;
  },
  dependencies: {
    runCommand?: (command: BoundedCommand) => Promise<CommandResult>;
    setupTimeoutMs?: number;
    searchTimeoutMs?: number;
  } = {},
): Promise<JevgrepRunResult> {
  const policy = jevgrepProfile(options.profile);
  const limits = policy.limits;
  if (!isJevgrepRuntimeAvailable(options.runtime)) {
    return {
      status: 'unavailable',
      output: '',
      reason: 'No qualified Jevgrep runtime configured',
      requests: 0,
    };
  }
  if (
    !isAbsolute(options.root) ||
    !options.query.trim() ||
    options.query.length > 8000 ||
    options.query.includes('\0') ||
    ['auth', 'doctor', 'skill', 'cache'].includes(options.query)
  ) {
    return { status: 'failed', output: '', reason: 'Invalid local retrieval request', requests: 0 };
  }
  const cancelled = new AbortController();
  const outerSignal = options.signal
    ? AbortSignal.any([options.signal, cancelled.signal])
    : cancelled.signal;
  const setupSignal = AbortSignal.any([
    outerSignal,
    AbortSignal.timeout(dependencies.setupTimeoutMs ?? 60_000),
  ]);
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const report = (message: string) => {
    try {
      // A disconnected or slow UI must not change search/payment execution.
      void Promise.resolve(options.onProgress?.(message)).catch(() => undefined);
    } catch {
      // A synchronous sink failure is equally non-authoritative.
    }
  };
  let completedEvaluations = 0;
  let directory: string | undefined;
  let runtime: Awaited<ReturnType<typeof prepareNpmRuntime>> | undefined;
  let proxy: Awaited<ReturnType<typeof startJevgrepProxy>> | undefined;
  let snapshot: SnapshotSummary | undefined;
  let phase: 'setup' | 'search' = 'setup';
  let phaseSignal: AbortSignal = setupSignal;
  const abortProxy = () => {
    void proxy?.close();
  };
  try {
    setupSignal.throwIfAborted();
    const root = await realpath(options.root);
    report('Jevgrep: preparing isolated runtime');
    runtime = await prepareNpmRuntime({
      dataDir: options.dataDir,
      packageName: '@dzhng/jevgrep',
      runtime: options.runtime!,
      signal: setupSignal,
    });
    directory = runtime.directory;
    const relation = relative(root, await realpath(directory));
    if (
      relation === '' ||
      (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
    ) {
      throw new Error('Temporary state must be outside the approved source root');
    }
    const { packageSpec, env } = runtime;
    const source = join(directory, 'source');
    report('Jevgrep: preparing committed source snapshot');
    snapshot = await createJevgrepSnapshot({
      root,
      destination: source,
      signal: setupSignal,
      profile: policy.id,
    });
    if (options.expectedCommit !== undefined && snapshot.commit !== options.expectedCommit)
      return {
        status: 'failed',
        output: '',
        reason: 'Repository snapshot changed after the offer',
        requests: 0,
        snapshot,
      };
    const cache = createJevgrepAnswerCache({
      dataDir: options.dataDir,
      root,
      commit: snapshot.commit,
      query: options.query,
      runtime: options.runtime!,
      profile: policy.id,
      supplier: options.supplier,
    });
    proxy = await startJevgrepProxy({
      evaluate: async (request, signal) => {
        const result = await options.evaluate(request, signal);
        // Cache hits bypass this callback; this counts real provider responses.
        report(`Jevgrep: completed provider evaluations: ${++completedEvaluations}`);
        return result;
      },
      cache,
      signal: outerSignal,
      profile: policy.id,
      supplier: options.supplier,
    });
    phaseSignal.addEventListener('abort', abortProxy, { once: true });
    if (phaseSignal.aborted) {
      abortProxy();
      phaseSignal.throwIfAborted();
    }
    const prefix = ['--yes', '--package', packageSpec, 'jg'];
    report('Jevgrep: configuring local provider connection');
    const auth = await runCommand({
      argv: [
        ...prefix,
        'auth',
        '--provider',
        'custom',
        // Reviewed local builds support this explicit pacing profile; published
        // 0.7.0 custom auth does not expose that fork-specific option.
        ...(policy.id === 'extended-v1' && options.runtime!.kind === 'local-artifact'
          ? ['--transport-profile', 'tenjin-x402']
          : []),
        '--base-url',
        proxy.baseURL,
        '--model',
        JEV_MODEL,
        '--stdin',
      ],
      outputBytes: limits.outputBytes,
      cwd: directory,
      env,
      input: `${proxy.token}\n`,
      signal: setupSignal,
    });
    setupSignal.throwIfAborted();
    if (auth.code !== 0 || auth.reason) {
      return {
        status: 'failed',
        output: '',
        reason: auth.reason ?? 'Custom provider setup failed',
        requests: 0,
        snapshot,
      };
    }
    phase = 'search';
    const searchSignal = AbortSignal.any([
      outerSignal,
      AbortSignal.timeout(dependencies.searchTimeoutMs ?? policy.searchTimeoutMs),
    ]);
    phaseSignal.removeEventListener('abort', abortProxy);
    phaseSignal = searchSignal;
    phaseSignal.addEventListener('abort', abortProxy, { once: true });
    if (phaseSignal.aborted) {
      abortProxy();
      phaseSignal.throwIfAborted();
    }
    report('Jevgrep: searching committed source');
    const search = await runCommand({
      argv: [
        ...prefix,
        '--concurrency',
        String(limits.concurrency),
        '--max-source-bytes',
        String(policy.sourceBytes),
        // Tenjin owns persistent answer reuse before paid admission. The CLI's
        // cache is temporary and includes the short-lived proxy port in its key.
        '--no-cache',
        '--',
        options.query,
        source,
      ],
      outputBytes: limits.outputBytes,
      cwd: directory,
      env,
      signal: searchSignal,
    });
    const summary = proxy.summary();
    const mapped = redactedOutput(search.stdout, proxy.token).replaceAll(source, root);
    const heading = `Committed HEAD snapshot ${snapshot.commit}; uncommitted and untracked changes omitted.\n`;
    const output = mapped
      ? heading + boundedUtf8(mapped, limits.outputBytes - Buffer.byteLength(heading))
      : '';
    const reason = options.signal?.aborted
      ? 'cancelled'
      : searchSignal.aborted
        ? 'search-timeout'
        : (summary.stopReason ?? search.reason);
    const status = options.signal?.aborted
      ? 'cancelled'
      : reason
        ? output
          ? 'partial'
          : 'failed'
        : search.code === 0
          ? 'complete'
          : search.code === 2
            ? 'partial'
            : search.code === 130
              ? 'cancelled'
              : 'failed';
    report(`Jevgrep: retrieval ${status}`);
    return {
      status,
      output,
      requests: summary.requests,
      cacheHits: summary.cacheHits,
      snapshot,
      ...(reason
        ? { reason }
        : status !== 'complete'
          ? { reason: 'Jevgrep did not complete retrieval' }
          : {}),
    };
  } catch (error) {
    report('Jevgrep: retrieval stopped');
    return {
      status: options.signal?.aborted
        ? 'cancelled'
        : error instanceof SnapshotPolicyUnavailable
          ? 'unavailable'
          : 'failed',
      output: '',
      requests: proxy?.summary().requests ?? 0,
      cacheHits: proxy?.summary().cacheHits ?? 0,
      ...(snapshot ? { snapshot } : {}),
      reason:
        error instanceof SnapshotPolicyUnavailable
          ? 'snapshot-policy-unavailable'
          : options.signal?.aborted
            ? 'cancelled'
            : setupSignal.aborted && phase === 'setup'
              ? 'setup-timeout'
              : 'Local retrieval setup or execution failed',
    };
  } finally {
    phaseSignal.removeEventListener('abort', abortProxy);
    cancelled.abort();
    await proxy?.close();
    await runtime?.close();
  }
}

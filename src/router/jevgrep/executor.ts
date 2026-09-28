import { canonicalHash } from '../../lib/request-schema';
import { toMoney } from '../../lib/money';
import { resolveContextSettings } from '../../lib/settings';
import type { RequestToolDeps, RequestToolResult } from '../tool';
import { boundJevgrepGrant, type JevgrepGrant } from './grants';
import { createJevgrepPayer, JEVGREP_SUPPLIER } from './payments';
import { runJevgrep } from './runner';

export async function executeJevgrep(
  grant: JevgrepGrant,
  id: string,
  query: string,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  // Refresh local authority at dispatch, including revocation and wallet policy.
  const current = await boundJevgrepGrant(deps.ctx, deps.cwd ?? process.cwd(), id, query);
  if (!current || current.id !== grant.id)
    return {
      isError: false,
      summary: 'Local retrieval is no longer authorized.',
      envelope: { status: 'needs_input' },
    };
  const runId = canonicalHash({ grantId: grant.id, id, query });
  let payer: ReturnType<typeof createJevgrepPayer> | undefined;
  try {
    deps.signal?.throwIfAborted();
    const { policy } = await resolveContextSettings(deps.ctx);
    const approved = BigInt(grant.maxRunAtomic);
    const maxRunAtomic =
      approved < policy.maxAutoSpendAtomic ? approved : policy.maxAutoSpendAtomic;
    payer = createJevgrepPayer({
      ctx: deps.ctx,
      authorizer: deps.authorizer,
      runId,
      maxRunAtomic,
      supplier: JEVGREP_SUPPLIER,
      ...(deps.provider ? { provider: deps.provider } : {}),
      ...(deps.signer ? { signer: deps.signer } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const result = await runJevgrep({
      root: grant.root,
      dataDir: deps.ctx.dataDir,
      query,
      runtime: grant.runtime,
      evaluate: (request, signal) => payer!.evaluate(request, signal),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const cost = await payer.summary();
    const fulfilled = result.status === 'complete';
    return {
      isError: !fulfilled,
      summary: fulfilled
        ? `Repository retrieval completed from committed tracked source; $${toMoney(cost.exposureAtomic).usd} authorized exposure, $${toMoney(cost.unknownAtomic).usd} unresolved.`
        : `Repository retrieval ${result.status}: ${result.reason ?? 'search incomplete'}; $${toMoney(cost.exposureAtomic).usd} authorized exposure.`,
      envelope: {
        status: fulfilled ? 'fulfilled' : result.status,
        executor: 'jevgrep-search-v1',
        runId,
        source: 'committed-tracked',
        excludes: 'Uncommitted and untracked files are not included.',
        result: result.output,
        stopReason: result.reason,
        snapshot: result.snapshot,
        cost,
        providerContentUntrusted: true,
      },
    };
  } catch {
    const cost = await payer?.summary().catch(() => undefined);
    return {
      isError: true,
      summary: 'Repository retrieval stopped. Use native tools; do not assume no matches.',
      envelope: {
        status: deps.signal?.aborted ? 'cancelled' : 'failed',
        runId,
        ...(cost ? { cost } : {}),
        providerContentUntrusted: true,
      },
    };
  }
}

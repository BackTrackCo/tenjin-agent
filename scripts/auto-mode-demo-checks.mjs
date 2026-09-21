import { URL } from 'node:url';
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const auditFilename = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const auditHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const promptAuditNote =
  'Prompt-gate audit only; these decisions do not establish tool invocation, provider execution, payment, or task fulfillment.';

/** Snapshot before launch so a resumed or repeated prompt cannot reuse old audit evidence. */
export async function snapshotPromptDecisions(stateDir) {
  const files = [];
  try {
    const directory = await opendir(join(stateDir, 'prompt-decisions'));
    let entries = 0;
    for await (const entry of directory) {
      if (++entries > 2048) return { available: false, files: [] };
      if (auditFilename.test(entry.name)) files.push(entry.name);
    }
    return { available: true, files };
  } catch (error) {
    return { available: error.code === 'ENOENT', files: [] };
  }
}

/** Bounded, metadata-only audit collection. It never participates in pass/fail checks. */
export async function collectPromptDecisions(stateDir, { snapshot, sessionId, prompt }) {
  const report = { status: 'unavailable', decisions: [], note: promptAuditNote };
  if (!snapshot.available) return report;
  const current = await snapshotPromptDecisions(stateDir);
  if (!current.available) return report;
  const previous = new Set(snapshot.files);
  const fresh = current.files.filter((name) => !previous.has(name)).sort();
  report.status = fresh.length > 64 ? 'partial' : 'complete';
  for (const name of fresh.slice(0, 64)) {
    try {
      const file = await open(
        join(stateDir, 'prompt-decisions', name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let record;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid audit size.');
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) throw new Error('Audit grew beyond the limit.');
        record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await file.close();
      }
      if (record.sessionHash !== auditHash(sessionId) || record.promptHash !== auditHash(prompt))
        continue;
      if (
        record.version !== 1 ||
        `${record.invocationId}.json` !== name ||
        typeof record.at !== 'string' ||
        record.at.length > 40 ||
        !Number.isFinite(Date.parse(record.at)) ||
        !['selected', 'native_fallback', 'needs_input', 'unsupported', 'error'].includes(
          record.status,
        ) ||
        typeof record.injected !== 'boolean' ||
        (record.injected && record.status !== 'selected') ||
        (record.stage !== undefined && !['context', 'routing'].includes(record.stage))
      )
        throw new Error('Invalid audit metadata.');
      let selectedRoute;
      if (record.selectedRoute !== undefined) {
        const selected = record.selectedRoute;
        if (
          record.status !== 'selected' ||
          typeof selected?.url !== 'string' ||
          selected.url.length > 2048 ||
          /\s|\[redacted/i.test(selected.url) ||
          !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(selected.method) ||
          !/^[0-9a-f]{64}$/.test(selected.contractHash)
        )
          throw new Error('Invalid audit selection.');
        const url = new URL(selected.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
          throw new Error('Unsafe audit endpoint.');
        selectedRoute = {
          url: url.href,
          method: selected.method,
          contractHash: selected.contractHash,
        };
      } else if (record.status === 'selected') throw new Error('Missing audit selection.');
      report.decisions.push({
        at: record.at,
        invocationId: record.invocationId,
        status: record.status,
        injected: record.injected,
        ...(record.stage === undefined ? {} : { stage: record.stage }),
        ...(selectedRoute ? { selectedRoute } : {}),
      });
    } catch {
      report.status = 'partial';
    }
  }
  report.decisions.sort(
    (a, b) => a.at.localeCompare(b.at) || a.invocationId.localeCompare(b.invocationId),
  );
  return report;
}

/** Inline Markdown labels are not destinations, even when the label is a URL. */
function markdownDestinations(text) {
  return text.replace(/\[[^\]\r\n]*\]\(((?:[^()\r\n]|\([^()\r\n]*\))*)\)/g, (_link, target) => {
    const parsed = target.trim().match(/^(?:<([^>]+)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'))?$/);
    const destination = parsed?.[1] ?? parsed?.[2];
    return destination && /^https?:\/\//i.test(destination) ? ` ${destination} ` : ' ';
  });
}

/** Generic provenance membership, not a claim that an arbitrary linked page is relevant. */
export function httpUrls(value) {
  const urls = new Set();
  const pending = [value];
  let visited = 0;
  while (pending.length && visited++ < 10_000) {
    const next = pending.pop();
    if (typeof next === 'string') {
      const text = markdownDestinations(next);
      for (const match of text.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
        let candidate = match[0].replace(/[.,;:!?]+$/, '');
        while (
          candidate.endsWith(')') &&
          (candidate.match(/\)/g)?.length ?? 0) > (candidate.match(/\(/g)?.length ?? 0)
        )
          candidate = candidate.slice(0, -1);
        candidate = candidate.replace(/\]+$/, '');
        // Only remove a paired Markdown wrapper immediately surrounding this
        // URL. Literal stars/backticks in an ordinary URL remain in its path.
        const prefix = text.slice(0, match.index);
        const wrapper = prefix.match(/(\*{1,3}|_{1,3}|`+)$/)?.[0];
        if (wrapper?.startsWith('`')) {
          const escapes = prefix.slice(0, -wrapper.length).match(/\\+$/)?.[0].length ?? 0;
          // Code-span delimiters must have exactly equal run lengths. Keep
          // internal backticks, unmatched runs, and escaped opening delimiters.
          if (escapes % 2 === 0 && candidate.match(/`+$/)?.[0] === wrapper)
            candidate = candidate.slice(0, -wrapper.length);
        } else if (wrapper && candidate.endsWith(wrapper))
          candidate = candidate.slice(0, -wrapper.length);
        try {
          const url = new URL(candidate);
          if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) continue;
          // A citation can point into a section of the returned document.
          url.hash = '';
          urls.add(url.href);
        } catch {
          /* A URL-like substring is not evidence of a valid citation. */
        }
      }
    } else if (next && typeof next === 'object') {
      pending.push(...Object.values(next));
    }
  }
  return [...urls];
}

export function checkDemo({
  events,
  outcome,
  outcomesByToolUseId,
  execution,
  model,
  tool,
  sessionId,
}) {
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = events.findLast((event) => event.type === 'result');
  const calls = events.flatMap((event) =>
    event.type === 'assistant'
      ? (event.message?.content ?? []).filter((block) => block.type === 'tool_use')
      : [],
  );
  const results = events.flatMap((event) =>
    event.type === 'user'
      ? (event.message?.content ?? []).filter((block) => block.type === 'tool_result')
      : [],
  );
  const observedTool = calls.length === 1 ? calls[0].name : undefined;
  const observedTools = [...new Set(calls.map((call) => call.name))];
  const uniqueCalls = new Map();
  for (const call of calls) {
    if (typeof call.id === 'string' && call.id && !uniqueCalls.has(call.id))
      uniqueCalls.set(call.id, call);
  }
  const perCallOutcomes = [...uniqueCalls].map(([toolUseId, call]) => {
    // A supplied map is authoritative: never fill a missing call with an
    // unrelated single-call result or with another run's cached outcome.
    const saved =
      outcomesByToolUseId instanceof Map
        ? outcomesByToolUseId.get(toolUseId)
        : outcomesByToolUseId !== undefined
          ? Object.hasOwn(outcomesByToolUseId, toolUseId)
            ? outcomesByToolUseId[toolUseId]
            : undefined
          : calls.length === 1
            ? outcome
            : undefined;
    return {
      toolUseId,
      tool: call.name,
      outcomePresent: saved !== null && typeof saved === 'object',
      provider: saved?.selected?.url,
      args: saved?.selected?.args,
      executorStatus: saved?.status,
      executorReason: saved?.reason,
      providerStatus: saved?.execution?.response?.status,
      amountAtomic: saved?.execution?.amountAtomic,
      settlement: saved?.execution?.settlement,
      cached: saved?.execution?.cached ?? false,
      saved,
    };
  });
  const returnedUrls = new Set();
  for (const call of perCallOutcomes) {
    if (call.executorStatus !== 'fulfilled' || call.providerStatus !== 200) continue;
    let body = call.saved.execution?.response?.body ?? '';
    try {
      body = JSON.parse(body);
    } catch {
      /* Text and Markdown responses are also supported. */
    }
    // Numeric APIs can cite the selected endpoint supplied in hook metadata.
    for (const url of httpUrls([body, call.provider])) returnedUrls.add(url);
  }
  const citedReturnedUrls = httpUrls(result?.result ?? '').filter((url) => returnedUrls.has(url));
  const amountsValid =
    perCallOutcomes.length > 0 &&
    perCallOutcomes.every(
      (call) => typeof call.amountAtomic === 'string' && /^\d{1,80}$/.test(call.amountAtomic),
    );
  const totalAmountAtomic = amountsValid
    ? perCallOutcomes.reduce((total, call) => total + BigInt(call.amountAtomic), 0n).toString()
    : undefined;
  const toolNamesAllowed = calls.every((call) => ['WebSearch', 'WebFetch'].includes(call.name));
  const checks = {
    completed:
      result?.subtype === 'success' &&
      !result?.is_error &&
      execution.code === 0 &&
      !execution.timedOut,
    sessionMatched: init?.session_id === sessionId && result?.session_id === sessionId,
    requestedModel:
      typeof init?.model === 'string' &&
      (init.model === model || init.model.startsWith(`claude-${model}-`)),
    ...(tool === 'auto'
      ? { boundedToolCalls: calls.length >= 1 && calls.length <= 8 && toolNamesAllowed }
      : { oneToolCall: calls.length === 1 && toolNamesAllowed && observedTool === tool }),
    uniqueToolCalls: calls.length > 0 && uniqueCalls.size === calls.length,
    nativeSuppressed:
      calls.length > 0 &&
      results.length === calls.length &&
      results.every((result) => uniqueCalls.has(result.tool_use_id) && result.is_error === true) &&
      [...uniqueCalls.keys()].every(
        (id) => results.filter((result) => result.tool_use_id === id).length === 1,
      ),
    outcomesMatched:
      perCallOutcomes.length > 0 && perCallOutcomes.every((call) => call.outcomePresent),
    executorFulfilled:
      perCallOutcomes.length > 0 &&
      perCallOutcomes.every((call) => call.executorStatus === 'fulfilled'),
    providerReturned:
      perCallOutcomes.length > 0 && perCallOutcomes.every((call) => call.providerStatus === 200),
    amountsValid,
    citesSource: citedReturnedUrls.length > 0,
  };
  return {
    checks,
    citedReturnedUrls,
    observedTool,
    observedTools,
    perCallOutcomes: perCallOutcomes.map((call) => {
      const summary = { ...call };
      delete summary.saved;
      return summary;
    }),
    totalAmountAtomic,
  };
}

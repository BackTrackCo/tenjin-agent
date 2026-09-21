import { URL } from 'node:url';

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

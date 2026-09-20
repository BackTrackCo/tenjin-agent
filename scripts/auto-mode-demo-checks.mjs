import { URL } from 'node:url';

/** Generic provenance membership, not a claim that an arbitrary linked page is relevant. */
export function httpUrls(value) {
  const urls = new Set();
  const pending = [value];
  let visited = 0;
  while (pending.length && visited++ < 10_000) {
    const next = pending.pop();
    if (typeof next === 'string') {
      for (const match of next.matchAll(/https?:\/\/[^\s<>"'\\]+/gi)) {
        let candidate = match[0].replace(/[.,;:!?]+$/, '');
        while (
          candidate.endsWith(')') &&
          (candidate.match(/\)/g)?.length ?? 0) > (candidate.match(/\(/g)?.length ?? 0)
        )
          candidate = candidate.slice(0, -1);
        candidate = candidate.replace(/\]+$/, '');
        // Only remove a paired Markdown wrapper immediately surrounding this
        // URL. A trailing star in an ordinary URL remains part of its path.
        const emphasis = next.slice(0, match.index).match(/(\*{1,3}|_{1,3})$/)?.[0];
        if (emphasis && candidate.endsWith(emphasis))
          candidate = candidate.slice(0, -emphasis.length);
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

export function checkDemo({ events, outcome, execution, model, tool, sessionId }) {
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
  let body = outcome.execution?.response?.body ?? '';
  try {
    body = JSON.parse(body);
  } catch {
    /* Text and Markdown responses are also supported. */
  }
  // Structured data APIs often return numbers without a source URL field. The
  // actual selected endpoint, supplied in hook metadata, is also valid provenance.
  const returnedUrls = new Set(httpUrls([body, outcome.selected?.url]));
  const citedReturnedUrls = httpUrls(result?.result ?? '').filter((url) => returnedUrls.has(url));
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
    oneToolCall: calls.length === 1 && calls[0].name === tool,
    nativeSuppressed:
      results.length === 1 &&
      results[0].is_error === true &&
      results[0].tool_use_id === calls[0]?.id,
    executorFulfilled: outcome.status === 'fulfilled',
    providerReturned: outcome.execution?.response?.status === 200,
    citesSource: citedReturnedUrls.length > 0,
  };
  return { checks, citedReturnedUrls };
}

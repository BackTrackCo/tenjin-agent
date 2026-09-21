import { isDeepStrictEqual } from 'node:util';
import { URL } from 'node:url';
import { previewResult } from '../src/experimental/auto-mode/result-preview.ts';
import { httpUrls } from './auto-mode-demo-checks.mjs';

const BRIDGE_TOOLS = new Map([
  ['mcp__x402__request', 'Request'],
  ['mcp__x402__search', 'WebSearch'],
  ['mcp__x402__fetch', 'WebFetch'],
]);

function contentBlocks(event, role, type) {
  return event?.type === role && Array.isArray(event.message?.content)
    ? event.message.content.filter((block) => block?.type === type)
    : [];
}

function resultTexts(result) {
  if (typeof result?.content === 'string') return [result.content];
  if (!Array.isArray(result?.content)) return [];
  return result.content.flatMap((block) =>
    block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  );
}

function envelopeFrom(texts) {
  const envelopes = [];
  for (const text of texts) {
    // Claude normally preserves the two MCP text blocks. A combined string
    // containing the receipt line followed by one complete JSON object is
    // equivalent; do not search arbitrary provider prose for JSON fragments.
    const candidates = [text];
    if (/^(?:SYNTHETIC FIXTURE; no payment · )?Fulfilled by /.test(text) && text.includes('\n'))
      candidates.push(text.slice(text.indexOf('\n') + 1));
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate);
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.hasOwn(value, 'status') &&
          Object.hasOwn(value, 'provider')
        )
          envelopes.push(value);
      } catch {
        // Human-readable receipt text is not a provider envelope.
      }
    }
  }
  return envelopes.length === 1 ? envelopes[0] : undefined;
}

function receiptMatches(text, provider, amountAtomic, parameters, fixture) {
  if (typeof text !== 'string' || typeof provider !== 'string') return false;
  if (typeof amountAtomic !== 'string' || !/^\d{1,80}$/.test(amountAtomic)) return false;
  try {
    const url = new URL(provider);
    const atomic = BigInt(amountAtomic);
    const decimals = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    const leading = `${fixture ? 'SYNTHETIC FIXTURE; no payment · ' : ''}Fulfilled by ${url.hostname} · `;
    const trailing = ` · $${atomic / 1_000_000n}${decimals ? `.${decimals}` : ''} USDC`;
    const characters = Array.from(JSON.stringify(parameters));
    const budget = Math.max(1, 220 - Array.from(leading + trailing).length);
    const label =
      characters.length <= budget
        ? characters.join('')
        : `${characters.slice(0, budget - 1).join('')}…`;
    return text.split('\n')[0] === leading + label + trailing;
  } catch {
    return false;
  }
}

function expectedPreview(outcome) {
  try {
    const parameters = previewResult(JSON.stringify(outcome.selected.args), 1000);
    const body = previewResult(outcome.execution.response.body, 6000);
    return {
      parameters: JSON.parse(parameters.result),
      parametersTruncated: parameters.truncated,
      body,
    };
  } catch {
    return undefined;
  }
}

function validProvider(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Supply only this invocation's stream and saved per-event outcomes, including
 * when resuming a session. Missing calls never inherit a prior turn's outcome;
 * extra/historical outcomes fail matching instead of contributing citations. */
export function checkBridgeDemo({ events = [], outcomes = [], model, execution, sessionId }) {
  const init = events.find((event) => event?.type === 'system' && event.subtype === 'init');
  const result = events.findLast((event) => event?.type === 'result');
  const calls = events.flatMap((event) => contentBlocks(event, 'assistant', 'tool_use'));
  const results = events.flatMap((event) => contentBlocks(event, 'user', 'tool_result'));
  const ids = calls.map((call) => call.id);
  const uniqueCalls = new Set(ids.filter((id) => typeof id === 'string' && id));
  const tokens = new Set();
  for (const call of calls) {
    if (typeof call.input?._receipt === 'string' && call.input._receipt)
      tokens.add(call.input._receipt);
  }
  for (const saved of outcomes) {
    if (typeof saved?.event?.tool_input?._receipt === 'string' && saved.event.tool_input._receipt)
      tokens.add(saved.event.tool_input._receipt);
  }
  const perCall = calls.map((call) => {
    const matching = outcomes.filter((saved) => saved?.event?.tool_use_id === call.id);
    const delivered = results.filter((item) => item.tool_use_id === call.id);
    const saved = matching.length === 1 ? matching[0] : undefined;
    const outcome = saved?.outcome;
    const texts = delivered.length === 1 ? resultTexts(delivered[0]) : [];
    const envelope = envelopeFrom(texts);
    const body = outcome?.execution?.response?.body;
    return {
      id: call.id,
      tool: call.name,
      recordMatched:
        matching.length === 1 &&
        saved?.event?.session_id === sessionId &&
        (!saved?.event?.tool_name || saved.event.tool_name === BRIDGE_TOOLS.get(call.name)) &&
        outcome !== null &&
        typeof outcome === 'object',
      delivered,
      texts,
      envelope,
      expected: expectedPreview(outcome),
      outcome,
      provider: outcome?.selected?.url,
      args: outcome?.selected?.args,
      amountAtomic: outcome?.execution?.amountAtomic,
      body,
      fulfilled: outcome?.status === 'fulfilled' && outcome?.execution?.status === 'fulfilled',
      bodyPresent: typeof body === 'string' && body.trim().length > 0,
    };
  });
  const everyCall = (predicate) => perCall.length > 0 && perCall.every(predicate);
  const returnedUrls = new Set();
  for (const call of perCall) {
    if (!call.recordMatched || !call.fulfilled || call.outcome.execution.response?.status !== 200)
      continue;
    let body = call.body;
    try {
      body = JSON.parse(body);
    } catch {
      /* Plain text is supported. */
    }
    for (const url of httpUrls([body, call.provider])) returnedUrls.add(url);
  }
  const answer = typeof result?.result === 'string' ? result.result : '';
  const answerUrls = httpUrls(answer);
  const citedReturnedUrls = answerUrls.filter((url) => returnedUrls.has(url));
  const unsupportedCitedUrls = answerUrls.filter((url) => !returnedUrls.has(url));
  const amountsValid = everyCall(
    (call) => typeof call.amountAtomic === 'string' && /^\d{1,80}$/.test(call.amountAtomic),
  );
  const assistantText = events
    .flatMap((event) => contentBlocks(event, 'assistant', 'text'))
    .map((block) => block.text ?? '');
  const outputText = [answer, ...assistantText, ...results.flatMap(resultTexts)].join('\n');
  const checks = {
    processExited: execution?.code === 0 && execution?.timedOut === false,
    completed: result?.subtype === 'success' && result?.is_error !== true,
    sessionMatched:
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      init?.session_id === sessionId &&
      result?.session_id === sessionId &&
      everyCall((call) => call.recordMatched),
    requestedModel:
      typeof model === 'string' &&
      model.length > 0 &&
      typeof init?.model === 'string' &&
      (init.model === model || init.model.startsWith(`claude-${model}-`)),
    autoPermissionMode: init?.permissionMode === 'auto',
    boundedBridgeCalls:
      calls.length >= 1 && calls.length <= 8 && calls.every((call) => BRIDGE_TOOLS.has(call.name)),
    uniqueToolCalls: calls.length > 0 && uniqueCalls.size === calls.length,
    noNativeTools: calls.every((call) => !['WebSearch', 'WebFetch'].includes(call.name)),
    toolResultsSucceeded:
      calls.length > 0 &&
      results.length === calls.length &&
      results.every((item) => uniqueCalls.has(item.tool_use_id) && item.is_error !== true) &&
      everyCall((call) => call.delivered.length === 1 && call.texts.length > 0),
    outcomesMatched: outcomes.length === calls.length && everyCall((call) => call.recordMatched),
    executorFulfilled: everyCall((call) => call.recordMatched && call.fulfilled),
    providerReturned: everyCall(
      (call) =>
        call.recordMatched && call.outcome?.execution?.response?.status === 200 && call.bodyPresent,
    ),
    selectedRequestPresent: everyCall(
      (call) =>
        validProvider(call.provider) &&
        call.args !== null &&
        typeof call.args === 'object' &&
        !Array.isArray(call.args),
    ),
    amountsValid,
    receiptsRendered: everyCall(
      (call) =>
        call.expected &&
        receiptMatches(
          call.texts[0],
          call.provider,
          call.amountAtomic,
          call.expected.parameters,
          call.outcome?.fixture === true,
        ),
    ),
    deliveredEnvelopeMatched: everyCall(
      (call) =>
        call.envelope?.status === 'fulfilled' &&
        call.envelope.provider === call.provider &&
        call.expected !== undefined &&
        isDeepStrictEqual(call.envelope.parameters, call.expected.parameters) &&
        call.envelope.parametersTruncated === call.expected.parametersTruncated &&
        call.envelope.amountAtomic === call.amountAtomic &&
        (call.envelope.cached ?? false) === (call.outcome?.execution?.cached ?? false) &&
        call.envelope.httpStatus === call.outcome?.execution?.response?.status &&
        Boolean(call.envelope.fixture) === Boolean(call.outcome?.fixture) &&
        isDeepStrictEqual(call.envelope.settlement, call.outcome?.execution?.settlement) &&
        call.envelope.providerContentUntrusted === true &&
        call.envelope.result === call.expected.body.result &&
        call.envelope.resultFormat === call.expected.body.format &&
        call.envelope.truncated === call.expected.body.truncated &&
        call.envelope.previewNote === call.expected.body.note,
    ),
    noReceiptTokenLeak:
      [...tokens].every((token) => !outputText.includes(token)) &&
      perCall.every((call) => !call.envelope || !Object.hasOwn(call.envelope, '_receipt')),
    finalAnswerPresent: answer.trim().length > 0,
    citesSource: citedReturnedUrls.length > 0,
    citationDestinationsValid: answerUrls.length > 0 && unsupportedCitedUrls.length === 0,
  };
  const coreChecks = Object.entries(checks).filter(
    ([name]) => !['citesSource', 'citationDestinationsValid'].includes(name),
  );
  return {
    passed: Object.values(checks).every(Boolean),
    corePassed: coreChecks.every(([, passed]) => passed),
    checks,
    observedTools: [...new Set(calls.map((call) => call.name))],
    citedReturnedUrls,
    unsupportedCitedUrls,
    totalAmountAtomic:
      amountsValid && checks.uniqueToolCalls && checks.outcomesMatched
        ? perCall.reduce((sum, call) => sum + BigInt(call.amountAtomic), 0n).toString()
        : undefined,
    perCallOutcomes: perCall.map((call) => ({
      toolUseId: call.id,
      tool: call.tool,
      outcomePresent: call.recordMatched,
      provider: call.provider,
      args: call.args,
      executorStatus: call.outcome?.status,
      providerStatus: call.outcome?.execution?.response?.status,
      amountAtomic: call.amountAtomic,
      settlement: call.outcome?.execution?.settlement,
      cached: call.outcome?.execution?.cached ?? false,
    })),
  };
}

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

function envelopeFrom(texts, allowPrepared = false, allowNative = false) {
  const envelopes = [];
  for (const text of texts) {
    // Claude normally preserves the two MCP text blocks. A combined string
    // containing the receipt line followed by one complete JSON object is
    // equivalent; do not search arbitrary provider prose for JSON fragments.
    const candidates = [text];
    if (
      (/^(?:SYNTHETIC FIXTURE; no payment · )?Fulfilled by /.test(text) ||
        (allowPrepared && text.startsWith('Local x402 result: prepared\n')) ||
        (allowNative &&
          text.startsWith('Jev selected normal tools or host reasoning; no x402 execution.\n'))) &&
      text.includes('\n')
    )
      candidates.push(text.slice(text.indexOf('\n') + 1));
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate);
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.hasOwn(value, 'status') &&
          (Object.hasOwn(value, 'provider') ||
            (allowNative &&
              value.status === 'native_fallback' &&
              Object.hasOwn(value, 'nativeTool')))
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

function jsonPointer(value, pointer) {
  if (pointer === '') return value;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** Explicit test predicates, never instructions for the router or Claude. */
export function parseBridgeExpectation(value) {
  const allowed = (object, keys) =>
    object !== null &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    Object.keys(object).every((key) => keys.includes(key));
  const scalar = (item) =>
    item === null ||
    typeof item === 'boolean' ||
    (typeof item === 'string' && item.length > 0 && item.length <= 2000) ||
    (typeof item === 'number' && Number.isFinite(item));
  if (allowed(value, ['scope', 'tools']) && value.scope === 'native') {
    if (
      !Array.isArray(value.tools) ||
      value.tools.length < 1 ||
      value.tools.length > 2 ||
      new Set(value.tools).size !== value.tools.length ||
      value.tools.some((tool) => !['WebSearch', 'WebFetch'].includes(tool))
    )
      throw new Error(
        'Native expectations require one or both distinct native tools: WebSearch, WebFetch.',
      );
    return value;
  }
  if (
    !allowed(value, ['scope', 'providers']) ||
    !['routing', 'response'].includes(value.scope) ||
    !Array.isArray(value.providers) ||
    value.providers.length < 1 ||
    value.providers.length > 8
  )
    throw new Error('Expectation requires scope routing or response and 1–8 providers.');
  const seen = new Set();
  for (const provider of value.providers) {
    if (
      !allowed(provider, ['url', 'httpStatuses', 'assertions']) ||
      !validProvider(provider.url) ||
      seen.has(provider.url) ||
      !Array.isArray(provider.assertions) ||
      provider.assertions.length < 1 ||
      provider.assertions.length > 20 ||
      (value.scope === 'routing'
        ? Object.hasOwn(provider, 'httpStatuses')
        : !Array.isArray(provider.httpStatuses) ||
          provider.httpStatuses.length < 1 ||
          provider.httpStatuses.length > 10 ||
          provider.httpStatuses.some(
            (status) => !Number.isInteger(status) || status < 200 || status > 299,
          ))
    )
      throw new Error(
        'Each expected provider needs a unique HTTPS URL, bounded assertions, and explicit 2xx statuses for response checks.',
      );
    seen.add(provider.url);
    for (const assertion of provider.assertions) {
      const equal = Object.hasOwn(assertion ?? {}, 'equals');
      if (
        !allowed(assertion, ['pointer', 'equals', 'type', 'inAnswer']) ||
        typeof assertion.pointer !== 'string' ||
        assertion.pointer.length > 500 ||
        !/^(?:\/(?:[^~]|~[01])*)?$/.test(assertion.pointer) ||
        (equal
          ? !scalar(assertion.equals) || Object.hasOwn(assertion, 'type')
          : !['string', 'number', 'boolean'].includes(assertion.type)) ||
        (Object.hasOwn(assertion, 'inAnswer') && typeof assertion.inAnswer !== 'boolean') ||
        (value.scope === 'routing' && Object.hasOwn(assertion, 'inAnswer'))
      )
        throw new Error(
          'Assertions require a JSON pointer and a scalar equals or type; inAnswer is only available for response checks.',
        );
    }
    if (value.scope !== 'routing' && !provider.assertions.some((assertion) => assertion.inAnswer))
      throw new Error(
        'Response expectations require at least one returned scalar in the final answer per provider.',
      );
  }
  return value;
}

function assertionMatches(assertion, value, answer) {
  const actual = jsonPointer(value, assertion.pointer);
  const matches = Object.hasOwn(assertion, 'equals')
    ? isDeepStrictEqual(actual, assertion.equals)
    : typeof actual === assertion.type &&
      (typeof actual !== 'string' || actual.trim().length > 0) &&
      (typeof actual !== 'number' || Number.isFinite(actual));
  if (!matches || !assertion.inAnswer) return matches;
  // Require the exact returned scalar as a token; 42 cannot be satisfied by 142.
  const escaped = String(actual).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (typeof actual === 'number')
    return new RegExp(`(?<![\\p{L}\\p{N}_.,+\\-])${escaped}(?![\\p{L}\\p{N}_]|[.,]\\d)`, 'u').test(
      answer,
    );
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(answer);
}

function matchesExpectation(calls, expectation, answer) {
  const matched = new Set();
  const all =
    calls.length > 0 &&
    calls.every((call) => {
      const provider = expectation.providers.find((item) => item.url === call.provider);
      if (!provider) return false;
      let value = call.args;
      if (expectation.scope !== 'routing') {
        if (!provider.httpStatuses.includes(call.outcome?.execution?.response?.status))
          return false;
        value = call.body;
        try {
          value = JSON.parse(value);
        } catch {
          // The empty pointer can assert a plain text scalar response.
        }
      }
      if (!provider.assertions.every((assertion) => assertionMatches(assertion, value, answer)))
        return false;
      matched.add(provider.url);
      return true;
    });
  return all && matched.size === expectation.providers.length;
}

/** Supply only this invocation's stream and saved per-event outcomes, including
 * when resuming a session. Missing calls never inherit a prior turn's outcome;
 * extra/historical outcomes fail matching instead of contributing citations. */
export function checkBridgeDemo({
  events = [],
  outcomes = [],
  model,
  execution,
  sessionId,
  expectation,
}) {
  if (expectation !== undefined) {
    expectation = parseBridgeExpectation(expectation);
    if (expectation.scope !== 'response')
      throw new Error('Use the separate routing or native validator for that expectation scope.');
  }
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
    if (
      !call.recordMatched ||
      !call.fulfilled ||
      !(
        expectation?.providers.find((item) => item.url === call.provider)?.httpStatuses ?? [200]
      ).includes(call.outcome.execution.response?.status)
    )
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
        call.recordMatched &&
        (
          expectation?.providers.find((item) => item.url === call.provider)?.httpStatuses ?? [200]
        ).includes(call.outcome?.execution?.response?.status) &&
        call.bodyPresent,
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
    ...(expectation
      ? { responseExpectationMatched: matchesExpectation(perCall, expectation, answer) }
      : { citesSource: citedReturnedUrls.length > 0 }),
    citationDestinationsValid:
      (expectation !== undefined || answerUrls.length > 0) && unsupportedCitedUrls.length === 0,
  };
  const coreChecks = Object.entries(checks).filter(
    ([name]) => !['citesSource', 'citationDestinationsValid'].includes(name),
  );
  return {
    passed: Object.values(checks).every(Boolean),
    corePassed: coreChecks.every(([, passed]) => passed),
    validationScope: expectation?.scope ?? 'research',
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

/** A route trial verifies prepared calls only. It never claims task fulfillment,
 * a successful provider response, payment, or a correct final answer. */
export function checkBridgeRoutingDemo({
  events = [],
  outcomes = [],
  model,
  execution,
  sessionId,
  expectation,
}) {
  expectation = parseBridgeExpectation(expectation);
  if (expectation.scope !== 'routing') throw new Error('Routing trial requires scope routing.');
  const init = events.find((event) => event?.type === 'system' && event.subtype === 'init');
  const result = events.findLast((event) => event?.type === 'result');
  const calls = events.flatMap((event) => contentBlocks(event, 'assistant', 'tool_use'));
  const results = events.flatMap((event) => contentBlocks(event, 'user', 'tool_result'));
  const uniqueCalls = new Set(
    calls.map((call) => call.id).filter((id) => typeof id === 'string' && id),
  );
  const perCall = calls.map((call) => {
    const matching = outcomes.filter((saved) => saved?.event?.tool_use_id === call.id);
    const saved = matching.length === 1 ? matching[0] : undefined;
    const delivered = results.filter((item) => item.tool_use_id === call.id);
    const envelope =
      delivered.length === 1 ? envelopeFrom(resultTexts(delivered[0]), true) : undefined;
    const args = saved?.outcome?.selected?.args;
    const preview = args !== undefined ? previewResult(JSON.stringify(args), 1000) : undefined;
    return {
      id: call.id,
      tool: call.name,
      recordMatched:
        matching.length === 1 &&
        saved?.event?.session_id === sessionId &&
        (!saved.event.tool_name || saved.event.tool_name === BRIDGE_TOOLS.get(call.name)),
      outcome: saved?.outcome,
      provider: saved?.outcome?.selected?.url,
      args,
      delivered,
      envelope,
      preview,
    };
  });
  const everyCall = (predicate) => perCall.length > 0 && perCall.every(predicate);
  const outputText = [
    result?.result ?? '',
    ...events
      .flatMap((event) => contentBlocks(event, 'assistant', 'text'))
      .map((block) => block.text ?? ''),
    ...results.flatMap(resultTexts),
  ].join('\n');
  const tokens = [
    ...calls.map((call) => call.input?._receipt),
    ...outcomes.map((saved) => saved?.event?.tool_input?._receipt),
  ].filter((token) => typeof token === 'string' && token);
  const checks = {
    processExited: execution?.code === 0 && execution?.timedOut === false,
    sessionMatched:
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      init?.session_id === sessionId &&
      result?.session_id === sessionId,
    requestedModel:
      typeof model === 'string' &&
      model.length > 0 &&
      typeof init?.model === 'string' &&
      (init.model === model || init.model.startsWith(`claude-${model}-`)),
    autoPermissionMode: init?.permissionMode === 'auto',
    boundedBridgeCalls:
      calls.length >= 1 && calls.length <= 8 && calls.every((call) => BRIDGE_TOOLS.has(call.name)),
    uniqueToolCalls: calls.length > 0 && uniqueCalls.size === calls.length,
    outcomesMatched: outcomes.length === calls.length && everyCall((call) => call.recordMatched),
    routesPrepared: everyCall((call) => call.outcome?.status === 'prepared'),
    noProviderExecution: everyCall(
      (call) => call.outcome?.execution === undefined && call.outcome?.fixture !== true,
    ),
    selectedRequestPresent: everyCall(
      (call) =>
        validProvider(call.provider) &&
        call.args !== null &&
        typeof call.args === 'object' &&
        !Array.isArray(call.args),
    ),
    preparedResultsDelivered:
      results.length === calls.length &&
      results.every((item) => uniqueCalls.has(item.tool_use_id) && item.is_error === true) &&
      everyCall(
        (call) =>
          call.delivered.length === 1 &&
          call.envelope?.status === 'prepared' &&
          call.envelope.provider === call.provider &&
          call.preview !== undefined &&
          isDeepStrictEqual(call.envelope.parameters, JSON.parse(call.preview.result)) &&
          call.envelope.parametersTruncated === call.preview.truncated &&
          call.envelope.httpStatus === undefined &&
          call.envelope.amountAtomic === undefined &&
          call.envelope.result === undefined &&
          call.envelope.fixture !== true &&
          call.envelope.providerContentUntrusted === true,
      ),
    noReceiptTokenLeak:
      tokens.every((token) => !outputText.includes(token)) &&
      perCall.every((call) => !call.envelope || !Object.hasOwn(call.envelope, '_receipt')),
    routingExpectationMatched: matchesExpectation(perCall, expectation, ''),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    validationScope: 'routing',
    validationNote:
      'Verifies selected providers and arguments only; no provider execution, payment, or task completion is claimed.',
    observedTools: [...new Set(calls.map((call) => call.name))],
    perCallOutcomes: perCall.map((call) => ({
      toolUseId: call.id,
      tool: call.tool,
      outcomePresent: call.recordMatched,
      provider: call.provider,
      args: call.args,
      executorStatus: call.outcome?.status,
    })),
  };
}

/** Every successful native call requires its own saved PreToolUse value decision.
 * Optional MCP preflight receipts are also checked; they cannot replace the gate. */
export function checkBridgeNativeDemo({
  events = [],
  outcomes = [],
  model,
  execution,
  sessionId,
  expectation,
}) {
  expectation = parseBridgeExpectation(expectation);
  if (expectation.scope !== 'native') throw new Error('Native validation requires scope native.');
  const init = events.find((event) => event?.type === 'system' && event.subtype === 'init');
  const result = events.findLast((event) => event?.type === 'result');
  const calls = events.flatMap((event, eventIndex) =>
    contentBlocks(event, 'assistant', 'tool_use').map((call) => ({ ...call, eventIndex })),
  );
  const results = events.flatMap((event, eventIndex) =>
    contentBlocks(event, 'user', 'tool_result').map((item) => ({ ...item, eventIndex })),
  );
  const uniqueCalls = new Set(
    calls.map((call) => call.id).filter((id) => typeof id === 'string' && id),
  );
  const bridgeCalls = calls.filter((call) => call.name === 'mcp__x402__request');
  const nativeCalls = calls.filter((call) => ['WebSearch', 'WebFetch'].includes(call.name));
  const nativeGates = nativeCalls.map((call) => {
    const matching = outcomes.filter((saved) => saved?.event?.tool_use_id === call.id);
    const saved = matching.length === 1 ? matching[0] : undefined;
    return {
      call,
      saved,
      recordMatched:
        matching.length === 1 &&
        saved?.event?.session_id === sessionId &&
        (!saved.event.tool_name || saved.event.tool_name === call.name),
    };
  });
  const handoffs = bridgeCalls.map((call) => {
    const matching = outcomes.filter((saved) => saved?.event?.tool_use_id === call.id);
    const saved = matching.length === 1 ? matching[0] : undefined;
    const delivered = results.filter((item) => item.tool_use_id === call.id);
    const envelope =
      delivered.length === 1 ? envelopeFrom(resultTexts(delivered[0]), false, true) : undefined;
    return {
      call,
      saved,
      delivered,
      envelope,
      recordMatched:
        matching.length === 1 &&
        saved?.event?.session_id === sessionId &&
        (!saved.event.tool_name || saved.event.tool_name === 'Request'),
    };
  });
  const everyHandoff = (predicate) => handoffs.every(predicate);
  const noExecution = (item) =>
    item.saved?.outcome?.status === 'native_fallback' &&
    item.saved.outcome.execution === undefined &&
    item.saved.outcome.selected === undefined &&
    !item.saved.outcome.fixture;
  const consumed = new Set();
  const nativeAfterJevDecision =
    nativeGates.length > 0 &&
    nativeGates.every(
      (item) =>
        item.recordMatched &&
        noExecution(item) &&
        (item.call.name === 'WebFetch'
          ? validProvider(item.saved.outcome.targetUrl) &&
            item.call.input?.url === item.saved.outcome.targetUrl
          : item.saved.outcome.targetUrl === undefined),
    );
  const everyHandoffExecuted = everyHandoff((item) => {
    const native = nativeCalls.find(
      (call) =>
        !consumed.has(call.id) &&
        item.recordMatched &&
        item.delivered.length === 1 &&
        item.delivered[0].eventIndex < call.eventIndex &&
        item.envelope?.status === 'native_fallback' &&
        (item.envelope.nativeToolRequired
          ? call.name === 'WebFetch' && call.input?.url === item.envelope.targetUrl
          : true),
    );
    if (!native) return false;
    consumed.add(native.id);
    return true;
  });
  const texts = [
    result?.result ?? '',
    ...events
      .flatMap((event) => contentBlocks(event, 'assistant', 'text'))
      .map((block) => block.text ?? ''),
    ...results.flatMap(resultTexts),
    JSON.stringify(nativeCalls.map((call) => call.input)),
  ].join('\n');
  const tokens = [
    ...bridgeCalls.map((call) => call.input?._receipt),
    ...outcomes.map((saved) => saved?.event?.tool_input?._receipt),
  ].filter((token) => typeof token === 'string' && token);
  const observedNativeTools = [...new Set(nativeCalls.map((call) => call.name))];
  const checks = {
    processExited: execution?.code === 0 && execution?.timedOut === false,
    completed: result?.subtype === 'success' && result?.is_error !== true,
    sessionMatched:
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      init?.session_id === sessionId &&
      result?.session_id === sessionId,
    requestedModel:
      typeof model === 'string' &&
      model.length > 0 &&
      typeof init?.model === 'string' &&
      (init.model === model || init.model.startsWith(`claude-${model}-`)),
    autoPermissionMode: init?.permissionMode === 'auto',
    boundedMixedCalls:
      calls.length >= 1 &&
      calls.length <= 8 &&
      calls.every((call) => ['mcp__x402__request', 'WebSearch', 'WebFetch'].includes(call.name)),
    nativeToolsAvailable:
      Array.isArray(init?.tools) &&
      ['mcp__x402__request', ...expectation.tools].every((tool) => init.tools.includes(tool)),
    expectedNativeTools:
      observedNativeTools.length === expectation.tools.length &&
      expectation.tools.every((tool) => observedNativeTools.includes(tool)),
    uniqueToolCalls: calls.length > 0 && uniqueCalls.size === calls.length,
    outcomesMatched:
      outcomes.length === calls.length &&
      everyHandoff((item) => item.recordMatched) &&
      nativeGates.length > 0 &&
      nativeGates.every((item) => item.recordMatched),
    noProviderExecution:
      everyHandoff(noExecution) && nativeGates.length > 0 && nativeGates.every(noExecution),
    handoffReceiptsMatched: everyHandoff((item) => {
      const outcome = item.saved?.outcome;
      const nativeTool = outcome?.targetUrl === undefined ? 'WebSearch' : 'WebFetch';
      return (
        resultTexts(item.delivered[0])[0]?.split('\n')[0] ===
          'Jev selected normal tools or host reasoning; no x402 execution.' &&
        item.envelope?.status === 'native_fallback' &&
        item.envelope.nativeTool === nativeTool &&
        item.envelope.nativeToolRequired === (outcome?.targetUrl !== undefined) &&
        item.envelope.targetUrl === outcome?.targetUrl &&
        (nativeTool !== 'WebFetch' || validProvider(outcome?.targetUrl)) &&
        item.envelope.x402Executed === false &&
        typeof item.envelope.reason === 'string' &&
        [
          'provider',
          'result',
          'amountAtomic',
          'httpStatus',
          'settlement',
          'execution',
          'fixture',
          '_receipt',
        ].every((key) => !Object.hasOwn(item.envelope, key))
      );
    }),
    toolResultsSucceeded:
      calls.length > 0 &&
      results.length === calls.length &&
      results.every(
        (item) =>
          uniqueCalls.has(item.tool_use_id) &&
          item.is_error !== true &&
          resultTexts(item).some((text) => text.trim()),
      ) &&
      calls.every((call) => results.filter((item) => item.tool_use_id === call.id).length === 1),
    nativeAfterJevDecision,
    everyHandoffExecuted,
    noReceiptTokenLeak: tokens.every((token) => !texts.includes(token)),
    finalAnswerPresent: typeof result?.result === 'string' && result.result.trim().length > 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    validationScope: 'native',
    validationNote:
      'Checks a saved native PreToolUse Jev decision for every successful native tool and validates any MCP handoffs. No x402 execution is recorded; final-answer correctness and native tool reliability require separate checks.',
    observedTools: [...new Set(calls.map((call) => call.name))],
    observedNativeTools,
    totalAmountAtomic: checks.outcomesMatched && checks.noProviderExecution ? '0' : undefined,
    perCallOutcomes: handoffs.map((item) => ({
      toolUseId: item.call.id,
      tool: item.call.name,
      outcomePresent: item.recordMatched,
      executorStatus: item.saved?.outcome?.status,
      nativeTool: item.envelope?.nativeTool,
      targetUrl: item.envelope?.targetUrl,
    })),
    nativeToolCalls: nativeCalls.map((call) => ({
      toolUseId: call.id,
      tool: call.name,
      input: call.input,
      gateStatus: nativeGates.find((item) => item.call.id === call.id)?.saved?.outcome?.status,
    })),
  };
}

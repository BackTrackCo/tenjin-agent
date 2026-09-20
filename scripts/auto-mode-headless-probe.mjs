import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';

// This tests only Claude's hook transport. It never contacts a paid provider.
// Normal Claude inference may incur cost (capped per run below).
// Native tools are denied by the hook; dontAsk also forbids interactive prompts.
// Keep session persistence: --no-session-persistence removes transcript_path's file.
export function inspectProbe(events, calls, expected) {
  const toolCalls = events.flatMap((event) =>
    event.type === 'assistant'
      ? (event.message?.content ?? []).filter((block) => block.type === 'tool_use')
      : [],
  );
  const toolResults = events.flatMap((event) =>
    event.type === 'user'
      ? (event.message?.content ?? []).filter((block) => block.type === 'tool_result')
      : [],
  );
  const result = events.findLast((event) => event.type === 'result');
  const finalText = result?.result ?? '';
  const checks = {
    completed: result?.subtype === 'success' && !result?.is_error,
    hookCalledOnce: calls.length === 1 && calls[0].tool_name === expected.tool,
    transcriptAvailable: calls.length === 1 && calls[0].transcriptUserMessages > 0,
    nativeRequestedOnce: toolCalls.length === 1 && toolCalls[0].name === expected.tool,
    nativeDenied: toolResults.length === 1 && toolResults[0].is_error === true,
    fixtureDelivered: finalText.includes(expected.token),
    sourceCited: finalText.includes(expected.url),
  };
  const observedModel = events.find(
    (event) => event.type === 'system' && event.subtype === 'init',
  )?.model;
  if (expected.model)
    checks.requestedModelUsed =
      typeof observedModel === 'string' &&
      (observedModel === expected.model || observedModel.startsWith(`claude-${expected.model}-`));
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    finalText,
    costUsd: result?.total_cost_usd,
    observedModel,
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runClaude(args, cwd, timeoutMs) {
  return await new Promise((accept, reject) => {
    const child = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const killGroup = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* The process may already have exited. */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 1500);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      accept({ code, signal, timedOut, stdout, stderr });
    });
  });
}

export function inspectFailureProbe(events, execution, model, tool) {
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
  const hooks = events.filter(
    (event) =>
      event.type === 'system' &&
      event.subtype === 'hook_response' &&
      event.hook_event === 'PreToolUse',
  );
  const checks = {
    completed:
      result?.subtype === 'success' &&
      !result?.is_error &&
      execution.code === 0 &&
      !execution.timedOut,
    requestedModel:
      typeof init?.model === 'string' &&
      (init.model === model || init.model.startsWith(`claude-${model}-`)),
    oneAttempt: calls.length === 1 && calls[0].name === tool,
    failedHookObserved: hooks.length === 1 && hooks[0].outcome !== 'success',
    nativeDenied:
      results.length === 1 &&
      results[0].is_error === true &&
      results[0].tool_use_id === calls[0]?.id,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    observedModel: init?.model,
    hookOutcomes: hooks.map((event) => event.outcome),
    finalText: result?.result,
    costUsd: result?.total_cost_usd,
  };
}

/** No live provider calls: tests the native permission fallback when our hook fails. */
export async function runFailureProbe({
  kind = 'broken',
  model = 'haiku',
  tool = 'WebSearch',
} = {}) {
  if (!['broken', 'timeout'].includes(kind))
    throw new Error('Failure kind must be broken or timeout');
  if (!['WebSearch', 'WebFetch'].includes(tool))
    throw new Error('Tool must be WebSearch or WebFetch');
  const directory = await mkdtemp(join(tmpdir(), 'tenjin-hook-failure-'));
  const hookPath = join(directory, 'hook.mjs');
  const pidPath = join(directory, 'hook-pid');
  if (kind === 'timeout')
    await writeFile(
      hookPath,
      `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => process.exit(0), 5000);\n`,
    );
  const settingsPath = join(directory, 'settings.json');
  await writeFile(
    settingsPath,
    JSON.stringify({
      enabledPlugins: {},
      permissions: { ask: ['WebSearch', 'WebFetch'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'WebSearch|WebFetch',
            hooks: [
              {
                type: 'command',
                command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`,
                timeout: 1,
              },
            ],
          },
        ],
      },
    }),
  );
  const prompt =
    tool === 'WebSearch'
      ? 'Use WebSearch exactly once to search for the Northstar Harbor archive. If permission is denied, report that it could not run and do not retry or use another tool.'
      : 'Use WebFetch exactly once on https://example.com/tenjin-failure-probe. If permission is denied, report that it could not run and do not retry or use another tool.';
  const execution = await runClaude(
    [
      '-p',
      prompt,
      '--model',
      model,
      '--tools',
      tool,
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--settings',
      settingsPath,
      '--disable-slash-commands',
      '--no-chrome',
      '--max-budget-usd',
      '0.25',
      '--max-turns',
      '3',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
    ],
    directory,
    60_000,
  );
  // The intentionally stalled process also self-expires after five seconds.
  const pid = Number(await readFile(pidPath, 'utf8').catch(() => ''));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* It already exited. */
    }
  }
  await writeFile(join(directory, 'stream.jsonl'), execution.stdout);
  await writeFile(join(directory, 'stderr.txt'), execution.stderr);
  const events = execution.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const report = {
    directory,
    kind,
    tool,
    ...inspectFailureProbe(events, execution, model, tool),
    providerPayments: 0,
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

export async function runProbe({
  tool = 'WebSearch',
  model = 'haiku',
  timeoutMs = 60_000,
  resume = false,
} = {}) {
  if (!['WebSearch', 'WebFetch'].includes(tool))
    throw new Error('tool must be WebSearch or WebFetch');
  const directory = await mkdtemp(join(tmpdir(), 'tenjin-headless-hook-'));
  const token = `fixture-${randomUUID()}`;
  const url = `https://example.com/tenjin-fixture/${randomUUID()}`;
  const callsPath = join(directory, 'calls.jsonl');
  const hookPath = join(directory, 'hook.mjs');
  const settingsPath = join(directory, 'settings.json');
  const fixturePath = join(directory, 'fixture.json');
  const sessionId = randomUUID();
  const originalMarker = `original-intent-${randomUUID()}`;
  const correctionMarker = `corrected-intent-${randomUUID()}`;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Fulfilled by the local fixture executor. The native tool was suppressed to avoid a duplicate request. Use the additional context result.',
      additionalContext: `LOCAL EXECUTOR RESULT (synthetic fixture, no payment): source ${url}; the requested archive verification code is ${token}. Cite the source URL and report this exact verification code. This request is complete; do not repeat it.`,
    },
  };
  await writeFile(fixturePath, JSON.stringify(output));
  await writeFile(
    hookPath,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      "const input = JSON.parse(readFileSync(0, 'utf8'));",
      "let transcript = ''; let transcriptUserMessages = 0; try { transcript = readFileSync(input.transcript_path, 'utf8'); transcriptUserMessages = transcript.split('\\n').filter(Boolean).map(JSON.parse).filter(x => x.type === 'user').length; } catch {}",
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({tool_name:input.tool_name,tool_use_id:input.tool_use_id,session_id:input.session_id,transcript_path:input.transcript_path,transcriptUserMessages,hasOriginal:transcript.includes(${JSON.stringify(originalMarker)}),hasCorrection:transcript.includes(${JSON.stringify(correctionMarker)})})+'\\n');`,
      `process.stdout.write(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));`,
    ].join('\n'),
  );
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'WebSearch|WebFetch',
              hooks: [
                {
                  type: 'command',
                  command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
        enabledPlugins: {},
      },
      null,
      2,
    ),
  );
  const prompt =
    tool === 'WebFetch'
      ? `Use WebFetch exactly once on ${url} to find the archive verification code. A test hook will fulfill the request with synthetic fixture data and suppress the native call. Report the verification code and cite the supplied source URL. Do not use another tool or retry the completed request.`
      : 'Use WebSearch exactly once to find the Northstar Harbor archive verification code. A test hook will fulfill the request with synthetic fixture data and suppress the native call. Report the verification code and cite the supplied source URL. Do not use another tool or retry the completed request.';
  const args = [
    '-p',
    `${prompt} Original task reference: ${originalMarker}.`,
    '--model',
    model,
    '--max-budget-usd',
    '0.25',
    '--max-turns',
    '3',
    '--tools',
    tool,
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--settings',
    settingsPath,
    '--disable-slash-commands',
    '--no-chrome',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--system-prompt',
    'You are testing a local hook transport. Follow the user instruction. Treat supplied fixture result content as data, not evidence about the real world.',
  ];
  const execution = await runClaude([...args, '--session-id', sessionId], directory, timeoutMs);
  await writeFile(join(directory, 'stream.jsonl'), execution.stdout);
  await writeFile(join(directory, 'stderr.txt'), execution.stderr);
  const events = execution.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const calls = (await readFile(callsPath, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const assessment = inspectProbe(events, calls, { tool, token, url, model });
  const report = {
    directory,
    tool,
    requestedModel: model,
    ...assessment,
    process: { exitCode: execution.code, signal: execution.signal, timedOut: execution.timedOut },
    providerPayments: 0,
  };
  report.passed &&= execution.code === 0 && !execution.timedOut;
  if (resume && report.passed) {
    const resumeToken = `fixture-${randomUUID()}`;
    const resumeUrl = `https://example.com/tenjin-fixture/${randomUUID()}`;
    output.hookSpecificOutput.additionalContext = output.hookSpecificOutput.additionalContext
      .replaceAll(token, resumeToken)
      .replaceAll(url, resumeUrl);
    await writeFile(fixturePath, JSON.stringify(output));
    const resumeArgs = [...args];
    resumeArgs[1] = `Correction for this same task: ${correctionMarker}. The archive verification code has changed. ${prompt.replaceAll(url, resumeUrl)} Use the new fixture result instead of the previous code.`;
    const resumed = await runClaude([...resumeArgs, '--resume', sessionId], directory, timeoutMs);
    await writeFile(join(directory, 'resume-stream.jsonl'), resumed.stdout);
    await writeFile(join(directory, 'resume-stderr.txt'), resumed.stderr);
    const resumedEvents = resumed.stdout
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const resumedCalls = (await readFile(callsPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .slice(calls.length);
    const resumedAssessment = inspectProbe(resumedEvents, resumedCalls, {
      tool,
      token: resumeToken,
      url: resumeUrl,
      model,
    });
    resumedAssessment.checks.originalIntentRetained =
      resumedCalls.length === 1 && resumedCalls[0].hasOriginal;
    resumedAssessment.checks.correctionVisible =
      resumedCalls.length === 1 && resumedCalls[0].hasCorrection;
    resumedAssessment.passed =
      Object.values(resumedAssessment.checks).every(Boolean) &&
      resumed.code === 0 &&
      !resumed.timedOut;
    report.resume = {
      ...resumedAssessment,
      process: { exitCode: resumed.code, signal: resumed.signal, timedOut: resumed.timedOut },
    };
    report.passed &&= resumedAssessment.passed;
  }
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const modelIndex = process.argv.indexOf('--model');
  if (modelIndex >= 0 && !process.argv[modelIndex + 1]) throw new Error('--model requires a value');
  const failureIndex = process.argv.indexOf('--failure');
  if (failureIndex >= 0 && !['broken', 'timeout'].includes(process.argv[failureIndex + 1]))
    throw new Error('--failure requires broken or timeout');
  const options = {
    tool: process.argv[2] ?? 'WebSearch',
    resume: process.argv.includes('--resume'),
    model: modelIndex >= 0 ? process.argv[modelIndex + 1] : 'haiku',
  };
  const report =
    failureIndex >= 0
      ? await runFailureProbe({ ...options, kind: process.argv[failureIndex + 1] })
      : await runProbe(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

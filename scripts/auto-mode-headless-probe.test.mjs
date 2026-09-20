import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { inspectProbe, inspectFailureProbe } from './auto-mode-headless-probe.mjs';

const expected = {
  tool: 'WebSearch',
  token: 'opaque-random-code',
  url: 'https://example.com/source',
};
const calls = [{ tool_name: 'WebSearch', transcriptUserMessages: 1 }];
const assistant = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'WebSearch' }] },
};
const denied = {
  type: 'user',
  message: { content: [{ type: 'tool_result', is_error: true, content: 'blocked' }] },
};
const result = {
  type: 'result',
  subtype: 'success',
  result: `${expected.token} [Source](${expected.url})`,
  total_cost_usd: 0.01,
};

test('transport evidence requires a denied native call and a final source citation', () => {
  assert.equal(inspectProbe([assistant, denied, result], calls, expected).passed, true);
  assert.equal(
    inspectProbe(
      [
        assistant,
        { ...denied, message: { content: [{ type: 'tool_result', is_error: false }] } },
        result,
      ],
      calls,
      expected,
    ).passed,
    false,
  );
  assert.equal(
    inspectProbe([assistant, denied, { ...result, result: expected.token }], calls, expected)
      .passed,
    false,
  );
});

test('a duplicate tool attempt or missing hook invocation fails the transport gate', () => {
  assert.equal(inspectProbe([assistant, assistant, denied, result], calls, expected).passed, false);
  assert.equal(inspectProbe([assistant, denied, result], [], expected).passed, false);
  assert.equal(
    inspectProbe(
      [assistant, denied, result],
      [{ tool_name: 'WebSearch', transcriptUserMessages: 0 }],
      expected,
    ).passed,
    false,
  );
});

test('the observed model must match the explicitly requested model', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
    assistant,
    denied,
    result,
  ];
  expectModel(events, 'sonnet', true);
  expectModel(events, 'haiku', false);
  function expectModel(stream, model, passed) {
    assert.equal(inspectProbe(stream, calls, { ...expected, model }).passed, passed);
  }
});

test('failed-hook protection requires a real hook failure and denies native success', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-haiku-4-5' },
    { type: 'system', subtype: 'hook_response', hook_event: 'PreToolUse', outcome: 'error' },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'WebSearch', id: 'call-1' }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] },
    },
    { type: 'result', subtype: 'success', result: 'The tool could not run.' },
  ];
  const execution = { code: 0, timedOut: false };
  assert.equal(inspectFailureProbe(events, execution, 'haiku', 'WebSearch').passed, true);
  events[3].message.content[0].is_error = false;
  assert.equal(inspectFailureProbe(events, execution, 'haiku', 'WebSearch').passed, false);
  events[3].message.content[0].is_error = true;
  events[1].outcome = 'success';
  assert.equal(inspectFailureProbe(events, execution, 'haiku', 'WebSearch').passed, false);
});

async function eventually(read, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function kill(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Run the harness in its own process so a real parent signal cannot terminate
// node:test or change its exit status. PATH resolves only our local fake Claude.
async function lifecycle(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-probe-lifecycle-'));
  let child;
  let pids;
  let completion;
  try {
    const moduleUrl = new URL('./auto-mode-headless-probe.mjs', import.meta.url).href;
    const wrapper = join(directory, 'wrapper.mjs');
    await writeFile(
      wrapper,
      `import { runClaude } from ${JSON.stringify(moduleUrl)};
const baseline = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
let execution, error;
try { execution = await runClaude([${JSON.stringify(mode)}], process.env.AUTO_PROBE_TEST_DIR, 15000); }
catch (caught) { error = caught.code; }
console.log(JSON.stringify({execution, error, baseline, remaining: ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s))}));
`,
    );
    if (mode !== 'missing')
      await writeFile(
        join(directory, 'claude'),
        `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.AUTO_PROBE_TEST_DIR;
writeFileSync(join(directory, 'fake-pid'), String(process.pid));
if (process.argv[2] === 'success') { console.log('local fake result'); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  writeFileSync(join(directory, 'forwarded'), signal);
  if (process.argv[2] === 'graceful') process.exit(0);
});
const descendant = spawn(process.execPath, ['-e', "for (const s of ['SIGINT','SIGTERM']) process.on(s, () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", join(directory, 'descendant')], {stdio:'ignore'});
const ready = setInterval(() => {
  try {
    if (Number(readFileSync(join(directory, 'descendant'), 'utf8')) === descendant.pid) {
      writeFileSync(join(directory, 'ready'), JSON.stringify({parent: process.pid, descendant: descendant.pid}));
      clearInterval(ready);
    }
  } catch {}
}, 10);
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
    child = spawn(process.execPath, [wrapper], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: mode === 'missing' ? directory : `${directory}${delimiter}${process.env.PATH}`,
        AUTO_PROBE_TEST_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    if (!['success', 'missing'].includes(mode))
      pids = await eventually(
        () =>
          readFile(join(directory, 'ready'), 'utf8')
            .then(JSON.parse)
            .catch(() => undefined),
        'The local fake Claude and descendant did not become ready.',
      );
    await run({ child, directory, pids, completion });
  } finally {
    // Even assertion failures cannot leave either the wrapper or its detached
    // subprocess group running on the shared development machine.
    if (!pids)
      pids = await readFile(join(directory, 'ready'), 'utf8')
        .then(JSON.parse)
        .catch(() => undefined);
    if (child?.exitCode === null && child?.signalCode === null) kill(child.pid);
    if (pids) {
      kill(-pids.parent);
      kill(pids.descendant);
    } else {
      const parent = Number(await readFile(join(directory, 'fake-pid'), 'utf8').catch(() => ''));
      const descendant = Number(
        await readFile(join(directory, 'descendant'), 'utf8').catch(() => ''),
      );
      if (parent > 0) kill(-parent);
      if (descendant > 0) kill(descendant);
    }
    if (completion) await completion;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [signal, mode, code] of [
  ['SIGINT', 'graceful', 130],
  ['SIGTERM', 'stubborn', 143],
])
  test(
    `parent ${signal} cancels the detached group and retains a nonzero result`,
    { skip: process.platform === 'win32', timeout: 10000 },
    async () => {
      await lifecycle(mode, async ({ child, directory, pids, completion }) => {
        child.kill(signal);
        const finished = await completion;
        assert.equal(finished.code, code, finished.stderr);
        assert.equal(finished.signal, null);
        const report = JSON.parse(finished.stdout);
        assert.equal(report.execution.code, code);
        assert.equal(report.execution.interrupted, signal);
        assert.equal(report.execution.timedOut, false);
        assert.deepEqual(report.remaining, report.baseline);
        assert.equal(await readFile(join(directory, 'forwarded'), 'utf8'), signal);
        await eventually(
          () => !running(pids.parent) && !running(pids.descendant),
          'A cancelled Claude descendant survived cleanup.',
        );
      });
    },
  );

test(
  'normal subprocess completion removes parent signal listeners',
  { skip: process.platform === 'win32', timeout: 10000 },
  async () => {
    await lifecycle('success', async ({ completion }) => {
      const finished = await completion;
      assert.equal(finished.code, 0, finished.stderr);
      const report = JSON.parse(finished.stdout);
      assert.equal(report.execution.code, 0);
      assert.equal(report.execution.stdout.trim(), 'local fake result');
      assert.deepEqual(report.remaining, report.baseline);
    });
  },
);

test(
  'a spawn error removes parent signal listeners',
  { skip: process.platform === 'win32', timeout: 10000 },
  async () => {
    await lifecycle('missing', async ({ completion }) => {
      const finished = await completion;
      assert.equal(finished.code, 0, finished.stderr);
      const report = JSON.parse(finished.stdout);
      assert.equal(report.error, 'ENOENT');
      assert.deepEqual(report.remaining, report.baseline);
    });
  },
);

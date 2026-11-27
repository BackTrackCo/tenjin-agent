import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

assert.equal(process.platform, 'win32');
const [launcherPath, claudePath, workspace, dataDir, configDir] = await Promise.all(
  process.argv.slice(2, 7).map((path) => realpath(path)),
);
const workerSid = process.argv[7];
assert.match(workerSid, /^S-1-5-21-/);
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: configDir,
  Path: [dirname(claudePath), process.env.Path ?? process.env.PATH].join(delimiter),
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
const origin = 'http://localhost:3939';
const consent = {
  version: 2,
  reads: 'claude-home',
  instructions: 'applicable',
  recipients: ['Tenjin', 'DeepSeek', 'Exa'],
  repositories: [workspace],
  maxJobAtomic: '1000000',
  routerOrigin: origin,
};
const grant = {
  version: 1,
  workerSid,
  launcherPath,
  claudePath,
  configDir,
  routerOrigin: origin,
  shellAccess: 'native-windows',
};
const save = (file, value) => writeFile(file, JSON.stringify(value));
const configure = (windowsWorker) =>
  save(join(dataDir, 'config.json'), {
    router: { enabled: true, subagents: true, windowsWorker, subagentConsent: consent },
  });
await configure(grant);
await save(join(configDir, '.claude.json'), {
  hasCompletedOnboarding: true,
  projects: {
    [workspace]: { hasTrustDialogAccepted: true },
    [workspace.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true },
  },
});
assert.equal(childProcess.spawnSync('git', ['init', '-q', workspace]).status, 0);
const sessionId = randomUUID();
const transcript = join(dataDir, 'parent.jsonl');
await save(transcript, {
  type: 'user',
  sessionId,
  message: { role: 'user', content: 'Run the synthetic qualification.' },
});
const fixture = join(workspace, 'read-fixture.txt');
const content = 'TENJIN_WINDOWS_PRODUCTION_WORKSPACE_OK';
await writeFile(fixture, content);

const children = [];
const launches = [];
const versionProbes = [];
const execFile = childProcess.execFile;
childProcess.execFile = function (file, ...args) {
  if (args[0]?.[0] === '--version') versionProbes.push(file);
  return Reflect.apply(execFile, this, [file, ...args]);
};
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  const child = Reflect.apply(spawn, this, [file, args, options]);
  if (args?.[0] === '--worker-sid') {
    const session = args.some((arg) => arg === '--session-id' || arg.startsWith('--session-id='));
    const evidence = { closed: false, ready: false };
    launches.push(evidence);
    if (session) children.push(evidence);
    console.log(`Tenjin spawned ${session ? 'worker' : 'prompt probe'}`);
    child.once('close', (code) => {
      evidence.closed = true;
      console.log(`Tenjin launch closed (${code})`);
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (/^tenjin Windows (qualification|worker): [\w ()-]{1,130}$/.test(line)) console.log(line);
    });
    let partial = '';
    child.stdout.on('data', (chunk) => {
      const lines = (partial + String(chunk)).split('\n');
      partial = lines.pop() ?? '';
      if (
        lines.some(
          (line) => line.includes('"type":"control_response"') && line.includes('"apiProvider"'),
        )
      )
        evidence.ready = true;
    });
  }
  return child;
};
syncBuiltinESMExports();

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup/package.json'))('esbuild');
// Put the bundle beside this script so Node resolves the installed production dependencies.
const bundle = join(import.meta.dirname, `.offer-${process.pid}.mjs`);
const offer = JSON.parse(
  await readFile(new URL('../../src/router/fixtures/model-offer.json', import.meta.url), 'utf8'),
);
let routes = 0;
let requests = 0;
let accepted = false;
let responseFailure;
const transport = {
  origin,
  route: async ({ jobId }) => {
    routes++;
    return { ...offer, jobId };
  },
  messages: async (_job, body) => {
    try {
      assert(accepted, 'Inference before acceptance');
      requests++;
      const read = {
        type: 'tool_use',
        id: 'toolu_fixture_read',
        name: 'Read',
        input: { file_path: fixture },
      };
      if (requests === 1) {
        assert(body.tools.some(({ name }) => name === 'Read'));
      } else {
        assert.equal(requests, 2, 'Unexpected inference requests');
        assert(
          JSON.stringify(body.messages).includes(content),
          'Native Read did not return the fixture',
        );
      }
      return {
        id: `msg_fixture_${requests}`,
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: requests === 1 ? [read] : [{ type: 'text', text: 'FIXTURE_COMPLETE' }],
        stop_reason: requests === 1 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8 },
      };
    } catch (error) {
      responseFailure ??= error;
      throw error;
    }
  },
  summary: async () => ({ actualAtomic: '0', reservedAtomic: '0', uncertain: [] }),
  reconcile: async () => undefined,
};
const server = new McpServer({ name: 'offline-qualification', version: '1' });
const client = new Client(
  { name: 'qualification-parent', version: '1' },
  { capabilities: { elicitation: { form: {} } } },
);
const session = {
  sessionId,
  turnId: 'first-turn',
  cwd: workspace,
  transcript,
  harness: 'claude',
  claudePermissionMode: 'default',
};
const signal = AbortSignal.timeout(150_000);
const call = async (args) => {
  const result = await client.callTool({ name: 'subagent', arguments: args }, undefined, {
    signal,
    timeout: 100_000,
  });
  return JSON.parse(result.content[0].text);
};
const capture = (id, step) =>
  call({
    capture: {
      session_id: sessionId,
      tool_use_id: id,
      tool: 'Agent',
      input: { prompt: 'Read the synthetic fixture and report its contents.' },
      step,
    },
  });
async function waitForChild(index) {
  const deadline = AbortSignal.timeout(70_000);
  while (!children[index]?.ready) {
    assert(!children[index]?.closed, 'The warmed worker closed before initialization');
    await delay(100, undefined, { signal: AbortSignal.any([signal, deadline]) });
  }
  await delay(200, undefined, { signal });
}
let model;
try {
  await build({
    stdin: {
      contents: `
        export { qualifiedModelWorker } from '../../src/router/model-worker';
        export { registerModelTool } from '../../src/router/model-mcp';
        export { ModelJobStore } from '../../src/router/model-job';
      `,
      resolveDir: import.meta.dirname,
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  const { qualifiedModelWorker, registerModelTool, ModelJobStore } = await import(
    pathToFileURL(bundle).href
  );
  const originalPath = process.env.Path;
  const fixtureExe = join(workspace, 'claude.exe');
  await writeFile(fixtureExe, 'Inert qualification data.');
  try {
    process.env.Path = [workspace, originalPath].join(delimiter);
    assert.equal(
      await qualifiedModelWorker(workspace, 'general-purpose', dataDir, signal, 'default'),
      null,
    );
    assert.equal(
      versionProbes.length,
      0,
      'Qualification executed a version probe from worker-writable PATH',
    );
  } finally {
    process.env.Path = originalPath;
    await rm(fixtureExe);
  }
  assert(await qualifiedModelWorker(workspace, 'general-purpose', dataDir, signal, 'default'));
  const [host, caller] = InMemoryTransport.createLinkedPair();
  model = registerModelTool(server, {
    dataDir,
    harness: 'claude',
    session: () => session,
    transport: async () => transport,
  });
  await server.connect(host);
  await client.connect(caller);
  const first = await capture('accepted', 'step-1');
  // A call that stayed native names why in the job store's no-offer record: shown with the failure.
  assert.equal(
    first.action,
    'offer',
    JSON.stringify({ first, noOffers: await new ModelJobStore(dataDir).noOffers() }),
  );
  console.log('Tenjin recorded the first offer');
  try {
    await waitForChild(0);
  } catch (error) {
    console.log(`Warm startup phase: ${JSON.stringify(launches)}`);
    accepted = true;
    const diagnostic = await call({ offer_id: first.offer_id });
    console.log(`Accept after incomplete warm startup: ${JSON.stringify(diagnostic)}`);
    throw error;
  }
  assert.equal(requests, 0);
  accepted = true;
  const result = await call({ offer_id: first.offer_id });
  if (responseFailure) throw responseFailure;
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.result, 'FIXTURE_COMPLETE');
  assert.equal(requests, 2);
  assert(children[0].closed);
  accepted = false;
  const second = await capture('vetoed', 'step-2');
  assert.equal(second.action, 'offer', JSON.stringify(second));
  await waitForChild(1);
  const veto = await capture('repeat', 'step-3');
  assert.equal(veto.action, 'native');
  assert.equal(veto.settled, second.offer_id);
  assert(children[1].closed);
  const third = await capture('revoked', 'step-4');
  assert.equal(third.action, 'offer', JSON.stringify(third));
  await waitForChild(2);
  await configure();
  const revoked = await call({ offer_id: third.offer_id });
  assert.notEqual(revoked.status, 'completed');
  assert.equal(requests, 2);
  assert.equal(routes, 3);
  await model.shutdown();
  assert.equal(children.length, 3);
  assert(children.every(({ closed }) => closed));
  console.log(
    JSON.stringify({
      routes,
      requests,
      beforeAccept: 0,
      nativeRead: true,
      vetoDrained: true,
      revokedDrained: true,
    }),
  );
} finally {
  await model?.shutdown();
  await client.close();
  await server.close();
  await rm(bundle, { force: true });
}

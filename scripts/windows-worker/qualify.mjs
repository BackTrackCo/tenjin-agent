import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { query } from '@anthropic-ai/claude-agent-sdk/core';

const CANARY = 'SYNTHETIC_TENJIN_PRIVATE_FIXTURE';
const WORKSPACE_MARKER = 'TENJIN_QUALIFICATION_WORKSPACE_OK';
const ACCESS_DENIED = 'TENJIN_QUALIFICATION_PRIVATE_PATH_DENIED';
const HOOK_DENIED = 'TENJIN_QUALIFICATION_HOOK_DENIED';
const COMPLETE = 'TENJIN_QUALIFICATION_COMPLETE';
const MODEL = 'deepseek-flash';

function shellCommands(tool, fixture, canary) {
  if (tool === 'PowerShell') {
    const literal = (path) => `'${path.replaceAll("'", "''")}'`;
    return {
      denied: `Write-Output '${HOOK_DENIED}'`,
      allowed: [
        `$ErrorActionPreference = 'Stop'`,
        `Get-Content -LiteralPath ${literal(fixture)}`,
        `try { Get-Content -LiteralPath ${literal(canary)} | Out-Null } catch { Write-Output '${ACCESS_DENIED}' }`,
      ].join('; '),
    };
  }
  const literal = (path) => `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  return {
    denied: `printf '%s\\n' '${HOOK_DENIED}'`,
    allowed: `cat ${literal(fixture)} && if ! cat ${literal(canary)} >/dev/null 2>&1; then printf '%s\\n' '${ACCESS_DENIED}'; fi`,
  };
}

function response(res, turn, content, stopReason) {
  const events = [];
  const event = (type, fields) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  };
  const usage = { input_tokens: 12, output_tokens: 8 };
  event('message_start', {
    message: {
      id: `msg_fixture_${turn}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  if (content.type === 'tool_use') {
    event('content_block_start', { index: 0, content_block: { ...content, input: {} } });
    event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) },
    });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: content.text } });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage });
  event('message_stop', {});
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.join(''));
}

async function readMessages(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Fixture request is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function latestResult(messages, id) {
  return messages
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .findLast((item) => item.type === 'tool_result' && item.tool_use_id === id);
}

async function qualify({ launcher, binary, sid, workspace, canary, tool }) {
  const directory = await mkdtemp(join(workspace, 'tenjin-windows-fixture-'));
  const control = await mkdtemp(join(tmpdir(), 'tenjin-windows-probe-'));
  const cancelFile = join(control, 'stop');
  const fixture = join(directory, 'inside.txt');
  const commands = shellCommands(tool, fixture, canary);
  const abortController = new globalThis.AbortController();
  const deadline = setTimeout(() => abortController.abort(), 35_000);
  let released = false;
  let requests = 0;
  let failure;
  let worker;
  let child;
  let closed;
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.url?.split('?')[0], '/v1/messages');
      assert(released, 'The worker hit the inference bridge before acceptance');
      const body = await readMessages(req);
      const turn = ++requests;
      assert(turn <= 3, 'The worker made unexpected model requests');
      assert(!JSON.stringify(body).includes(CANARY), 'The private canary reached the bridge');
      if (turn === 1)
        assert(
          body.tools.some(({ name }) => name === tool),
          `${tool} is unavailable`,
        );
      if (turn === 2) {
        const denied = latestResult(body.messages, 'toolu_fixture_1');
        assert(denied?.is_error && JSON.stringify(denied).includes(HOOK_DENIED));
      }
      if (turn === 3) {
        const allowed = latestResult(body.messages, 'toolu_fixture_2');
        assert(allowed && !allowed.is_error);
        const result = JSON.stringify(allowed);
        assert(result.includes(WORKSPACE_MARKER), 'The shell could not read its workspace fixture');
        assert(result.includes(ACCESS_DENIED), 'The shell could read the private canary');
        response(res, turn, { type: 'text', text: COMPLETE }, 'end_turn');
        return;
      }
      response(
        res,
        turn,
        {
          type: 'tool_use',
          id: `toolu_fixture_${turn}`,
          name: tool,
          input: {
            command: turn === 1 ? commands.denied : commands.allowed,
            description: 'Read an inert qualification fixture',
          },
        },
        'tool_use',
      );
    })().catch((error) => {
      failure ??= error;
      res.writeHead(400).end();
      abortController.abort();
    });
  });
  try {
    await writeFile(fixture, `${WORKSPACE_MARKER}\n`);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const env = {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: 'sk-ant-tenjin-local-fixture',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(tool === 'PowerShell' ? { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } : {}),
    };
    let release;
    const accepted = new Promise((resolve) => {
      release = resolve;
    });
    async function* prompt() {
      if (await accepted)
        yield {
          type: 'user',
          session_id: '',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'Run the fixed synthetic shell qualification.' },
        };
    }
    worker = query({
      prompt: prompt(),
      options: {
        abortController,
        pathToClaudeCodeExecutable: binary,
        cwd: directory,
        env,
        model: MODEL,
        permissionMode: 'default',
        allowedTools: [tool],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        settings: { autoMemoryEnabled: false },
        hooks: {
          PreToolUse: [
            {
              matcher: `^${tool}$`,
              hooks: [
                async (event) =>
                  event.tool_input?.command === commands.denied
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: HOOK_DENIED,
                        },
                      }
                    : {},
              ],
            },
          ],
        },
        spawnClaudeCodeProcess: ({ command, args, cwd, signal }) => {
          child = spawn(
            launcher,
            [
              '--worker-sid',
              sid,
              '--parent-pid',
              String(process.pid),
              '--cwd',
              cwd,
              '--cancel-file',
              cancelFile,
              '--',
              command,
              ...args,
            ],
            {
              env: { ...env, SystemRoot: process.env.SystemRoot },
              stdio: 'pipe',
              windowsHide: true,
              detached: true,
            },
          );
          child.kill = () => {
            writeFileSync(cancelFile, '');
            return true;
          };
          signal.addEventListener('abort', child.kill, { once: true });
          if (signal.aborted) child.kill();
          child.once('close', () => signal.removeEventListener('abort', child.kill));
          closed = new Promise((resolve) => child.once('close', resolve));
          const diagnostics = createInterface({ input: child.stderr });
          diagnostics.on('line', (line) => {
            if (/^tenjin Windows (qualification|worker): [\w ()-]{1,100}$/.test(line))
              console.log(line);
          });
          return child;
        },
      },
    });
    const account = await worker.accountInfo();
    assert.equal(account.apiProvider, 'firstParty');
    assert.equal(account.apiKeySource, 'ANTHROPIC_API_KEY');
    assert.equal(requests, 0);
    released = true;
    release(true);
    let result;
    for await (const event of worker) {
      if (event.type === 'result') result = event;
    }
    assert.equal(result?.subtype, 'success');
    assert.equal(result.result, COMPLETE);
    assert.equal(requests, 3);
    console.log(
      JSON.stringify({
        tool,
        requests,
        beforeAccept: 0,
        hookBlocked: true,
        workspaceReadable: true,
        privateFixtureDenied: true,
      }),
    );
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(deadline);
    worker?.close();
    abortController.abort();
    if (child && !child.killed && child.exitCode === null) child.kill();
    await closed;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(control, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') throw new Error('This qualification requires native Windows');
const [launcherPath, binaryPath, sid, workspacePath, canaryPath, tool] = process.argv.slice(2);
if (
  !launcherPath ||
  !binaryPath ||
  !sid ||
  !workspacePath ||
  !canaryPath ||
  !['Bash', 'PowerShell'].includes(tool)
)
  throw new Error(
    'Usage: node qualify.mjs <launcher.exe> <claude.exe> <worker SID> <shared workspace> <private canary> <Bash|PowerShell>',
  );
const [launcher, binary, workspace, canary] = await Promise.all(
  [launcherPath, binaryPath, workspacePath, canaryPath].map((path) => realpath(path)),
);
assert([launcher, binary].every((path) => extname(path).toLowerCase() === '.exe'));
const distance = relative(workspace, canary);
assert(
  distance.startsWith('..\\') || isAbsolute(distance),
  'The canary must be outside the shared workspace',
);
assert(
  (await stat(canary)).size === Buffer.byteLength(CANARY),
  'Use only the qualification canary',
);
assert((await readFile(canary, 'utf8')) === CANARY, 'Use only the qualification canary');
await qualify({ launcher, binary, sid, workspace, canary, tool });

import { completedMessageSse, workerMessages } from './model-messages';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { findDefinition } from './agent-tools';
import { join } from 'node:path';
import {
  query,
  resolveSettings as resolveWorkerSettings,
  createSdkMcpServer,
  BUILTIN_TOOL_NAMES,
} from '@anthropic-ai/claude-agent-sdk/core';
import { z } from 'zod';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { assertResultSchema, validateResultBody } from '../lib/request-schema';
import {
  withCodexModelGates,
  type CodexModelGates,
  type CodexModelPolicy,
} from './codex-model-gates';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { modelSettings } from './model-settings';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import {
  assertInstructionContextCurrent,
  instructionContextText,
  resolveCodexInstructions,
  savedInstructionContext,
  type InstructionContext,
} from './model-instructions';

type QualifiedWorker = NonNullable<Awaited<ReturnType<typeof readClaudeCode>>['binary']> & {
  instructionContext?: InstructionContext;
};

/** Qualify host policy, not model capability; unsupported paths stay native. */
export async function qualifiedModelWorker(
  cwd: string,
  agentType = 'general-purpose',
  codexPolicy?: CodexModelPolicy,
  dataDir?: string,
  signal?: AbortSignal,
): Promise<QualifiedWorker | null> {
  const state = await readClaudeCode(process.env, cwd);
  if (!state.binary || !state.version || !meetsFloor(state.version, '2.1.325')) return null;
  if (!dataDir) return null;
  if (codexPolicy) {
    return withCodexModelGates(
      {
        cwd,
        policy: codexPolicy,
        dataDir,
        signal: signal ?? new AbortController().signal,
        ask: async () => false,
      },
      async (gates) => {
        if (!gates.instructionConfig || !gates.readInstructions) return null;
        for (const native of gates.tools) assertResultSchema(native.inputSchema);
        const instructionContext = await resolveCodexInstructions({
          cwd,
          policy: codexPolicy,
          dataDir,
          nativeConfig: gates.instructionConfig,
          read: gates.readInstructions,
          signal,
        });
        return { ...state.binary!, instructionContext };
      },
    );
  }
  if (await findDefinition(agentType, { cwd, homeDir: homedir() })) return null;
  const { effective } = await resolveWorkerSettings({
    cwd,
    settingSources: ['user', 'project', 'local'],
  });
  if (effective.sandbox?.filesystem?.disabled || effective.sandbox?.excludedCommands?.length)
    return null;
  const root = await realpath(cwd);
  const extra = [
    ...(effective.permissions?.additionalDirectories ?? []),
    ...(effective.sandbox?.filesystem?.allowRead ?? []),
  ];
  for (const path of extra) {
    const real = await realpath(resolve(cwd, path)).catch(() => null);
    if (!real || (real !== root && !real.startsWith(`${root}${sep}`))) return null;
  }
  return state.binary;
}

/** Candidate maintained runner. Parent process/provider/Remote Control are untouched. */
export async function runModelWorker(
  job: ModelJob,
  options: {
    dataDir: string;
    transport: ModelTransport;
    signal: AbortSignal;
    codexPolicy?: CodexModelPolicy;
    permission: (
      tool: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<boolean>;
  },
) {
  options.signal.throwIfAborted();
  const instructions = savedInstructionContext(job.decision.instructionContext);
  if (
    options.codexPolicy &&
    (!instructions || instructions.root !== job.root || instructions.harness !== 'codex')
  )
    throw new Error('Complete frozen instruction context is unavailable; keep native');
  if (options.codexPolicy) {
    const state = await readClaudeCode(process.env, job.root);
    options.signal.throwIfAborted();
    if (!state.binary || !state.version || !meetsFloor(state.version, '2.1.325'))
      throw new Error('Maintained worker binary is unavailable; keep native');
    let workerFailure: { error: unknown } | undefined;
    const result = await withCodexModelGates(
      {
        cwd: job.root,
        policy: options.codexPolicy,
        signal: options.signal,
        ask: options.permission,
        dataDir: options.dataDir,
      },
      async (gates) => {
        try {
          if (!gates.instructionConfig || !gates.readInstructions)
            throw new Error('Native instruction gate unavailable');
          const current = await resolveCodexInstructions({
            cwd: job.root,
            policy: options.codexPolicy!,
            dataDir: options.dataDir,
            nativeConfig: gates.instructionConfig,
            read: gates.readInstructions,
            signal: options.signal,
          });
          if (current.fingerprint !== instructions!.fingerprint)
            throw new Error('Applicable instructions changed before worker selection');
          return await runQualifiedWorker(job, options, state.binary!, instructions!, gates);
        } catch (error) {
          // The generic app-server helper deliberately returns null on errors.
          // Once the worker started, preserve its failure instead of reporting
          // that native policy qualification failed.
          workerFailure = { error };
          throw error;
        }
      },
    );
    if (workerFailure) throw workerFailure.error;
    if (result === null) throw new Error('Codex tool policy is not qualified; keep native');
    return result;
  }
  const binary = await qualifiedModelWorker(
    job.root,
    String(job.native.subagent_type ?? 'general-purpose'),
    undefined,
    options.dataDir,
    options.signal,
  );
  options.signal.throwIfAborted();
  if (!binary) throw new Error('Claude Code worker is unavailable; keep native');
  return runQualifiedWorker(job, options, binary);
}

async function runQualifiedWorker(
  job: ModelJob,
  options: Parameters<typeof runModelWorker>[1],
  binary: { path: string },
  instructions?: InstructionContext,
  gates?: CodexModelGates,
) {
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const codexTools = gates
    ? nativeGateTools(gates, job.root, controller.signal, async () => {
        if (!(await modelSettings(options.dataDir, job.root)) || controller.signal.aborted)
          throw new Error('Model consent revoked or worker cancelled');
      })
    : undefined;
  const codexServer = codexTools ? nativeGateServer(codexTools) : undefined;
  const token = randomBytes(32).toString('hex');
  const pending = new Set<Promise<void>>();
  let worker: ReturnType<typeof query> | undefined;
  let proxyFailure: { error: unknown } | undefined;
  let checkedInitialInstructions = false;
  const bridge = createServer((req, res) => {
    const handle = async () => {
      try {
        if (
          req.method !== 'POST' ||
          req.url?.split('?')[0] !== '/v1/messages' ||
          (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token)
        ) {
          res.writeHead(403).end();
          return;
        }
        const settings = await modelSettings(options.dataDir, job.root);
        if (!settings || controller.signal.aborted)
          throw new Error('Model consent revoked or job cancelled');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256_000) throw new Error('Worker request too large');
          chunks.push(chunk);
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (!checkedInitialInstructions && gates) {
          await assertInstructionContextCurrent(instructions!, gates.readInstructions);
        }
        checkedInitialInstructions = true;
        const messages = workerMessages(raw);
        const message = await options.transport.messages(job, messages, controller.signal);
        if (raw.stream === true)
          res
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(completedMessageSse(message));
        else
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      } catch (error) {
        proxyFailure ??= { error };
        const stop = () => {
          // Transport has already drained any signed accounting before it
          // throws. Stop the model loop rather than retrying a failed turn.
          controller.abort(error);
          worker?.close();
        };
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.destroyed)
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: 'Tenjin worker request stopped; inspect receipts before retrying',
              },
            }),
            stop,
          );
        else stop();
      }
    };
    const done = handle();
    pending.add(done);
    void done.then(
      () => pending.delete(done),
      () => pending.delete(done),
    );
  });
  await new Promise<void>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(0, '127.0.0.1', resolve);
  });
  const address = bridge.address();
  if (!address || typeof address === 'string') throw new Error('Worker bridge failed');
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    ANTHROPIC_CUSTOM_HEADERS: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDECODE: undefined,
    TENJIN_WALLET_PASSPHRASE: undefined,
    TENJIN_MODEL_WORKER: '1',
    ANTHROPIC_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // This proxy consumes client tool schemas; expose the complete native MCP
    // catalog instead of provider-specific deferred/tool-reference blocks.
    ENABLE_TOOL_SEARCH: 'false',
  };
  let result: string | undefined;
  try {
    options.signal.throwIfAborted();
    worker = query({
      prompt: job.task,
      options: {
        pathToClaudeCodeExecutable: binary.path,
        cwd: job.root,
        env,
        systemPrompt: gates
          ? 'Complete the assigned coding task in the existing repository. Use the supplied native command and MCP tools. Their permission gates are authoritative. Do not delegate again. Preserve unrelated work. Return the outcome and relevant verification.\n\n' +
            instructionContextText(instructions!)
          : { type: 'preset', preset: 'claude_code' },
        model: 'deepseek-flash',
        ...(!gates && job.native.subagent_type === 'Explore' ? { agent: 'Explore' } : {}),
        effort: 'high',
        abortController: controller,
        permissionMode: 'default',
        settingSources: gates ? [] : ['user', 'project', 'local'],
        ...(codexTools
          ? {
              tools: [],
              strictMcpConfig: true,
              mcpServers: { tenjin_native: codexServer! },
            }
          : {}),
        // Native worktree and sandbox, fail closed when unavailable. No bypass mode.
        // Preserve the parent's workspace, including uncommitted changes.
        // The SDK sandbox isolates execution; native worktree-only calls stay native.
        settings: {
          permissions: {
            blockReadsOutsideWorkingDirectories: true,
            blockWritesOutsideWorkingDirectories: true,
            workingDirectoriesAsGiven: [job.root],
          },
        },
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: {
            denyRead: [
              options.dataDir,
              join(homedir(), '.aws'),
              join(job.root, '.env'),
              join(job.root, '.env.local'),
              `${job.root}/**/.env*`,
              join(homedir(), '.ssh'),
              join(homedir(), '.codex', 'auth.json'),
            ],
          },
        },
        persistSession: false,
        maxTurns: 40,
        disallowedTools: gates
          ? [...BUILTIN_TOOL_NAMES]
          : ['Agent', 'Task', 'mcp__plugin_tenjin_router__subagent'],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => {
                  const settings = await modelSettings(options.dataDir, job.root);
                  return settings && !controller.signal.aborted
                    ? {}
                    : {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: 'Model access revoked or job cancelled',
                        },
                      };
                },
              ],
            },
          ],
        },
        canUseTool: async (tool, input, context) => {
          if (codexTools) {
            // The only executable tools are our in-process native broker. It owns
            // Codex's deny/ask decisions; Claude settings grant no Codex authority.
            const allowed = codexTools.some((t) => tool === `mcp__tenjin_native__${t.name}`);
            return allowed
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'Tool is outside the qualified Codex broker' };
          }
          const allowed = await options.permission(tool, input, context.signal);
          return allowed
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message: 'User or inherited permission policy declined this action',
              };
        },
      },
    });
    for await (const message of worker) {
      if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error('DeepSeek worker did not finish');
        result = message.result;
      }
    }
    if (proxyFailure) throw proxyFailure.error;
    if (!result) throw new Error('DeepSeek worker returned no completed result');
    if (Buffer.byteLength(result, 'utf8') > 256_000)
      throw new Error('Worker handback exceeds size limit; inspect receipts before retrying');
    return result;
  } catch (error) {
    if (proxyFailure) throw proxyFailure.error;
    throw error;
  } finally {
    controller.abort();
    worker?.close();
    bridge.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    options.signal.removeEventListener('abort', cancel);
  }
}

/** Keep execution in Codex; the maintained worker only supplies the model loop. */
export function nativeGateTools(
  gates: CodexModelGates,
  root: string,
  signal: AbortSignal,
  authorize: () => Promise<void> = async () => undefined,
) {
  const text = (value: unknown) => {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 256_000)
      throw new Error('Native tool result exceeds worker context limit');
    return { content: [{ type: 'text' as const, text: encoded }] };
  };
  const commandSchema = z.object({
    argv: z.array(z.string()).min(1).max(100),
    cwd: z.string().optional(),
  });
  const definitions: {
    name: string;
    description: string;
    inputSchema: { type: 'object' } & Record<string, unknown>;
    handler: (input: Record<string, unknown>) => Promise<ReturnType<typeof text>>;
  }[] = gates.commands
    ? [
        {
          name: 'command',
          description:
            'Run an argv command in the repository through the inherited Codex sandbox and command policy. Use this for local files and CLIs. Shell syntax requires an explicit shell argv and is checked by the same policy.',
          inputSchema: z.toJSONSchema(commandSchema) as { type: 'object' } & Record<
            string,
            unknown
          >,
          handler: async (input) => {
            const { argv, cwd } = commandSchema.parse(input);
            await authorize();
            return text(await gates.command(argv, cwd ?? root, signal));
          },
        },
      ]
    : [];
  for (const [index, native] of gates.tools.entries()) {
    // Keep the exact JSON Schema. Converting to a Zod shape can discard
    // additionalProperties or insert JSON Schema's annotation-only defaults.
    if (native.inputSchema.type !== 'object')
      throw new Error('Unsupported native MCP input schema');
    assertResultSchema(native.inputSchema);
    definitions.push({
      name: `native_${index}`,
      description: `${native.server}/${native.name}: ${native.description ?? 'Native MCP tool'}`,
      inputSchema: native.inputSchema as { type: 'object' } & Record<string, unknown>,
      handler: async (args) => {
        if (!validateResultBody(native.inputSchema, JSON.stringify(args)).valid)
          throw new Error('Native MCP arguments violate their declared schema');
        await authorize();
        return text(await gates.callMcp(native.server, native.name, args, signal));
      },
    });
  }
  return definitions;
}

/** Raw MCP handlers preserve the native JSON schema without input coercion. */
export function nativeGateServer(definitions: ReturnType<typeof nativeGateTools>) {
  const server = createSdkMcpServer({ name: 'tenjin_native', tools: [] });
  server.instance.server.registerCapabilities({ tools: { listChanged: false } });
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));
  server.instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const definition = definitions.find((item) => item.name === params.name);
    if (!definition) throw new Error('Tool is outside the qualified native broker');
    return definition.handler(params.arguments ?? {});
  });
  return server;
}

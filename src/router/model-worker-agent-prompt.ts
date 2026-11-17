import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import type { WorkerAgent } from './agent-tools';
import {
  claudeDeepSeekWorkerApiKeyHelper,
  claudeDeepSeekWorkerEnv,
  claudeDeepSeekWorkerSettingsEnv,
  CLAUDE_DEEPSEEK_WORKER_MODEL,
} from './claude-model-policy';
import { claudeWorkerProcess } from './claude-worker-process';
import { completedMessageSse } from './model-messages';
import { isRecord } from '../lib/guards';

/** What Claude Code gives a native subagent of one type, as it builds that subagent's first request. */
export type NativeAgentPrompt = {
  /** The subagent's system prompt: the agent's own prompt and the notes every subagent gets. */
  prompt: string[];
  /** First-message context the subagent gets and a main thread with its own prompt does not (its git status). */
  context: string[];
  /** Built-in tools a main thread has and that subagent does not. */
  withheldTools: string[];
};

/** Why the prompt could not be read. The worker then starts with Claude Code's main prompt. */
export class NativeAgentPromptUnavailable extends Error {
  constructor(readonly reason: 'not_captured' | 'start_failed' | 'timeout' | 'no_agent_prompt') {
    super(`Native agent prompt unavailable: ${reason}`);
  }
}

// Claude Code's own first system block, which it adds to every request itself.
const BILLING_BLOCK = 'x-anthropic-billing-header:';
const MAX_BODY = 8 * 1024 * 1024;

type Request = { system: string[]; firstMessage: string[]; tools: string[] };

const texts = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap((block) =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string'
            ? [block.text]
            : [],
        )
      : [];

function read(body: Record<string, unknown>): Request {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages.find((m) => isRecord(m) && m.role === 'user');
  return {
    system: texts(body.system),
    firstMessage: isRecord(first) ? texts(first.content) : [],
    tools: Array.isArray(body.tools)
      ? body.tools.flatMap((tool) =>
          isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
        )
      : [],
  };
}

/**
 * Reads the prompt Claude Code gives a native subagent of `agentType`, from the Claude Code
 * the worker runs: a short start of that Claude Code, whose model calls are answered here
 * and never leave this machine, launches the subagent with its own Agent tool, and the
 * subagent's first request is read. Hooks and MCP servers do not run in it.
 */
export async function readNativeAgentPrompt(input: {
  binary: string;
  cwd: string;
  agentType: string;
  customAgent?: WorkerAgent;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<NativeAgentPrompt> {
  input.signal.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  // The subagent's whole task, so its first request is told apart from the main thread's.
  const task = `Tenjin agent prompt read ${randomBytes(8).toString('hex')}`;
  let main: Request | undefined;
  let captured!: (request: Request) => void;
  const subagent = new Promise<Request>((resolve) => {
    captured = resolve;
  });
  const reply = (body: Record<string, unknown>, content: Record<string, unknown>[]) => ({
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: typeof body.model === 'string' ? body.model : 'deepseek-flash',
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const server = createServer((req, res) => {
    void (async () => {
      const path = req.url?.split('?')[0];
      if (
        req.method !== 'POST' ||
        (path !== '/v1/messages' && path !== '/v1/messages/count_tokens') ||
        (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token)
      ) {
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error('Request too large');
        chunks.push(chunk);
      }
      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":0}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const request = read(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      let message;
      // The subagent's first message ends with its task; the main thread's is `Start.`.
      if (request.firstMessage.at(-1) === task) {
        captured(request);
        message = reply(body, [{ type: 'text', text: 'Done.' }]);
      } else if (
        !main &&
        request.tools.includes('Agent') &&
        !JSON.stringify(messages).includes('"tool_result"')
      ) {
        main = request;
        message = reply(body, [
          {
            type: 'tool_use',
            id: `toolu_${randomBytes(12).toString('hex')}`,
            name: 'Agent',
            input: { subagent_type: input.agentType, description: 'Read prompt', prompt: task },
          },
        ]);
      } else message = reply(body, [{ type: 'text', text: 'Done.' }]);
      if (body.stream === true)
        res
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(completedMessageSse(message));
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      if (!res.destroyed) res.end();
    });
  });
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener('abort', abort, { once: true });
  const nativeProcess = claudeWorkerProcess();
  let worker: ReturnType<typeof query> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new NativeAgentPromptUnavailable('start_failed');
    const url = `http://127.0.0.1:${address.port}`;
    // Every tool is listed in both requests, so the tools only the main thread has are known.
    const listAll = { ENABLE_TOOL_SEARCH: 'false' };
    worker = query({
      prompt: 'Start.',
      options: {
        pathToClaudeCodeExecutable: input.binary,
        spawnClaudeCodeProcess: nativeProcess.spawn,
        cwd: input.cwd,
        env: { ...claudeDeepSeekWorkerEnv(process.env, url, token), ...listAll },
        // An empty prompt of its own: the main thread's blocks are then only those Claude
        // Code adds to every request, and are told apart from the subagent's prompt.
        systemPrompt: '',
        model: CLAUDE_DEEPSEEK_WORKER_MODEL,
        ...(input.customAgent ? { agents: { [input.agentType]: input.customAgent } } : {}),
        abortController: controller,
        persistSession: false,
        maxTurns: 2,
        settingSources: ['user', 'project', 'local'],
        strictMcpConfig: true,
        settings: {
          disableAllHooks: true,
          autoMemoryEnabled: false,
          apiKeyHelper: claudeDeepSeekWorkerApiKeyHelper(),
          env: { ...claudeDeepSeekWorkerSettingsEnv(url, token), ...listAll },
        },
        permissionMode: 'default',
        canUseTool: async (tool, toolInput) =>
          tool === 'Agent'
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: 'Not used here' },
      },
    });
    const started = worker;
    const ended = (async () => {
      try {
        // Drives the start; nothing it says is used.
        let next = await started.next();
        while (!next.done) next = await started.next();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new NativeAgentPromptUnavailable('start_failed');
      }
      throw new NativeAgentPromptUnavailable('not_captured');
    })();
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new NativeAgentPromptUnavailable('timeout')),
        input.timeoutMs ?? 60_000,
      );
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    for (const pending of [ended, expired, cancelled]) pending.catch(() => undefined);
    const sub = await Promise.race([subagent, ended, expired, cancelled]);
    input.signal.throwIfAborted();
    const ownBlocks = new Set(main?.system ?? []);
    const prompt = sub.system.filter(
      (text) => !ownBlocks.has(text) && !text.startsWith(BILLING_BLOCK),
    );
    if (!main || !prompt.length) throw new NativeAgentPromptUnavailable('no_agent_prompt');
    const mainContext = new Set(main.firstMessage);
    return {
      prompt,
      context: sub.firstMessage.filter((text) => text !== task && !mainContext.has(text)),
      withheldTools: main.tools.filter((tool) => !sub.tools.includes(tool)),
    };
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
    controller.abort();
    worker?.close();
    await nativeProcess.drain().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

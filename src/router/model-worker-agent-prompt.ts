import { randomBytes } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk/core';
import type { WorkerAgent } from './agent-tools';
import {
  claudeDeepSeekWorkerApiKeyHelper,
  claudeDeepSeekWorkerEnv,
  claudeDeepSeekWorkerSettingsEnv,
  CLAUDE_DEEPSEEK_WORKER_MODEL,
} from './claude-model-policy';
import { claudeConfigDir } from './claude-cli';
import { claudeWorkerProcess, type WindowsWorkerProcess } from './claude-worker-process';
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
  /**
   * The CLAUDE.md and rules files a main thread starts with and that subagent does not
   * (every one of them for `Explore`), by the path Claude Code names each with. One in a
   * folder below the working directory still reaches either of them when they read a file
   * there.
   */
  withheldInstructions: string[];
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

// How Claude Code heads each CLAUDE.md or rules file it puts in a request, with its path.
const INSTRUCTION_FILE = /^Contents of (.+) \([^()\n]*\):$/gm;
const instructionFiles = (blocks: string[]): Set<string> =>
  new Set(blocks.flatMap((text) => [...text.matchAll(INSTRUCTION_FILE)].map((match) => match[1]!)));

/**
 * `claudeMdExcludes` patterns that match exactly these paths. Claude Code reads each as a
 * picomatch glob and turns every backslash into a slash, so a glob character cannot be
 * escaped with one: it is put in a class of its own instead.
 */
export function instructionExcludes(paths: readonly string[]): string[] {
  return paths.map((path) => path.replace(/[*?[\]{}()!+@|]/g, (char) => `[${char}]`));
}

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
  /** The worker's other working directories, so the instruction files it starts with are read here too. */
  additionalDirectories?: readonly string[];
  agentType: string;
  customAgent?: WorkerAgent;
  windows?: WindowsWorkerProcess;
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
  const nativeProcess = claudeWorkerProcess({ secrets: () => [token], windows: input.windows });
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
        ...(input.additionalDirectories?.length
          ? { additionalDirectories: [...input.additionalDirectories] }
          : {}),
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
        // In a private file, as the worker's: they hold this read's token.
        settings: nativeProcess.settingsFile({
          disableAllHooks: true,
          autoMemoryEnabled: false,
          ...(!input.windows ? { apiKeyHelper: claudeDeepSeekWorkerApiKeyHelper() } : {}),
          env: { ...claudeDeepSeekWorkerSettingsEnv(url, token), ...listAll },
        }),
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
    const subInstructions = instructionFiles(sub.firstMessage);
    return {
      prompt,
      context: sub.firstMessage.filter((text) => text !== task && !mainContext.has(text)),
      withheldTools: main.tools.filter((tool) => !sub.tools.includes(tool)),
      withheldInstructions: [...instructionFiles(main.firstMessage)].filter(
        (path) => !subInstructions.has(path),
      ),
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

/** Prompts read, by everything the read depends on (see {@link readNativeAgentPromptCached}). */
const prompts = new Map<string, { at: number; native: NativeAgentPrompt }>();
/** Reads under way, by the same key: undefined for one that was not kept. */
const reading = new Map<string, Promise<NativeAgentPrompt | undefined>>();
/** Bounds how old the git status a cached read carries can be, and covers a wrapper script. */
const PROMPT_TTL_MS = 10 * 60_000;

// Where Claude Code reads managed settings and instructions, per platform.
const MANAGED_DIR =
  process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\ClaudeCode'
      : '/etc/claude-code';

/** Path, size and mtime of each file, `-` for one that is not there. */
async function stamps(paths: Iterable<string>): Promise<string[]> {
  return Promise.all(
    [...new Set(paths)].map((path) =>
      stat(path).then(
        (file) => `${path}\0${file.isDirectory() ? 'dir' : file.size}\0${file.mtimeMs}`,
        () => `${path}\0-`,
      ),
    ),
  );
}

/** Every file under a folder (agents, rules, managed settings), so an added, removed or edited one changes the stamp. */
async function treeFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return [
    dir,
    ...names
      .sort()
      .slice(0, 500)
      .map((name) => join(dir, name)),
  ];
}

/**
 * The files a native subagent's prompt, tools and instruction list depend on: the person's,
 * the project's and the managed settings (plugins enabled, output style, CLAUDE.md
 * excludes), the installed plugins, the agent definitions, and every CLAUDE.md and rules
 * file Claude Code may load for the root, the folders above it and the other working
 * directories.
 */
async function dependencies(
  root: string,
  directories: readonly string[],
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string[]> {
  const config = claudeConfigDir(env, home);
  const above: string[] = [];
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    above.push(dir);
    if (dirname(dir) === dir) break;
  }
  const project = (dir: string) => [
    join(dir, 'CLAUDE.md'),
    join(dir, 'CLAUDE.local.md'),
    join(dir, '.mcp.json'),
    join(dir, '.claude', 'CLAUDE.md'),
    join(dir, '.claude', 'settings.json'),
    join(dir, '.claude', 'settings.local.json'),
  ];
  const trees = await Promise.all(
    [
      ...[...above, ...directories].map((dir) => join(dir, '.claude', 'rules')),
      join(resolve(root), '.claude', 'agents'),
      join(config, 'rules'),
      join(config, 'agents'),
      join(home, '.claude', 'agents'),
      join(MANAGED_DIR, 'managed-settings.d'),
    ].map(treeFiles),
  );
  return stamps([
    ...[...above, ...directories.map((dir) => resolve(dir))].flatMap(project),
    join(config, 'settings.json'),
    join(config, 'CLAUDE.md'),
    join(config, 'plugins', 'installed_plugins.json'),
    join(MANAGED_DIR, 'managed-settings.json'),
    join(MANAGED_DIR, 'CLAUDE.md'),
    ...trees.flat(),
  ]);
}

/**
 * {@link readNativeAgentPrompt}, read once per Claude Code binary (its resolved path, size and
 * mtime, as the version cache keys it), agent type, custom definition, root and working
 * directories, and kept while none of the files it depends on changes and for at most
 * {@link PROMPT_TTL_MS}. The key holds each of them whole, so a read is never handed to
 * another agent type or root. `ephemeralDirectories` (the job's own temp folder) are left
 * out of the key; a read that names one is not kept.
 */
export async function readNativeAgentPromptCached(
  input: Parameters<typeof readNativeAgentPrompt>[0] & {
    ephemeralDirectories?: readonly string[];
  },
  deps: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    now?: () => number;
    read?: typeof readNativeAgentPrompt;
  } = {},
): Promise<NativeAgentPrompt> {
  const { ephemeralDirectories = [], ...request } = input;
  const read = deps.read ?? readNativeAgentPrompt;
  const now = deps.now ?? Date.now;
  const ephemeral = new Set(ephemeralDirectories);
  const directories = (input.additionalDirectories ?? []).filter((dir) => !ephemeral.has(dir));
  const key = await nativeAgentStartKey({ ...request, additionalDirectories: directories }, deps);
  if (!key) return read(request);
  const held = prompts.get(key);
  if (held && now() - held.at < PROMPT_TTL_MS) return structuredClone(held.native);
  // ONE READ FOR WORKERS THAT START TOGETHER: two offers of one response each started a
  // Claude Code to read the same prompt, side by side. The second waits for the first's
  // read and takes it when it was kept; a read that failed, was cut by its own job's end
  // or names that job's temp folder is the first's alone, and the second reads for itself.
  const going = reading.get(key);
  if (going) {
    const shared = await going.catch(() => undefined);
    input.signal.throwIfAborted();
    if (shared) return structuredClone(shared);
  }
  const mine = (async () => {
    const native = await read(request);
    const text = JSON.stringify(native);
    if ([...ephemeral].some((dir) => text.includes(dir))) return { native, kept: false };
    prompts.delete(key);
    prompts.set(key, { at: now(), native: structuredClone(native) });
    if (prompts.size > 16) prompts.delete(prompts.keys().next().value!);
    return { native, kept: true };
  })();
  const offered = mine.then(({ native, kept }) => (kept ? native : undefined));
  // Unhandled only where no other worker waits for it.
  offered.catch(() => undefined);
  if (!reading.has(key)) {
    reading.set(key, offered);
    void offered
      .finally(() => {
        if (reading.get(key) === offered) reading.delete(key);
      })
      .catch(() => undefined);
  }
  return (await mine).native;
}

/** The inputs Claude used to initialize, checked again before a warm child gets an assignment. */
export async function nativeAgentStartKey(
  input: Omit<Parameters<typeof readNativeAgentPrompt>[0], 'signal'>,
  deps: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<string | null> {
  const path = await realpath(input.binary).catch(() => null);
  if (!path) return null;
  const directories = input.additionalDirectories ?? [];
  return JSON.stringify([
    await stamps([path]),
    input.agentType,
    resolve(input.cwd),
    directories,
    input.customAgent ?? null,
    input.windows
      ? [input.windows.workerSid, input.windows.launcherPath, input.windows.configDir]
      : null,
    await dependencies(input.cwd, directories, deps.env ?? process.env, deps.home ?? homedir()),
  ]);
}

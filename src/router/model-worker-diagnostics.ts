import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../lib/atomic-json';

const run = promisify(execFile);
const MAX_NAMES = 256;
const MAX_REPEATS = 32;

/**
 * A BOUNDED RECORD OF HOW ONE WORKER RUN WENT, for looking into a stop or a drift later:
 * its tools and MCP servers, its root and commit, the output and context settings its
 * requests carried, whether its earlier reasoning went back on each turn, its repeat
 * reminders and how it ended. Names, numbers and codes only: no assignment, no tool
 * input or result, no model text. Written next to the job's record, readable by its
 * user alone, swept with it after 7 days, and sent nowhere.
 */
export type WorkerDiagnostics = {
  version: 1;
  root: string;
  commit?: string;
  model?: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  settings: {
    /** The largest output cap a request asked for: the effective one. */
    maxOutputTokens?: number;
    compactWindow: number;
    thinking: string[];
    /** None: the job's wall time and money ceiling bound a run. */
    maxTurns: null;
  };
  /** The latest request's history: assistant turns, and how many carried their reasoning back. */
  reasoning: { turns: number; withThinking: number; textTurns: number; textWithThinking: number };
  repeats: { tool: string; count: number }[];
  stop?: { subtype: string; turns?: number; stopReason?: string };
};

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 200))
    : [];
const blocks = (message: unknown): Record<string, unknown>[] => {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
    : [];
};

export class WorkerDiagnosticsRecord {
  private value: WorkerDiagnostics;

  constructor(root: string, compactWindow: number) {
    this.value = {
      version: 1,
      root,
      tools: [],
      mcpServers: [],
      settings: { compactWindow, thinking: [], maxTurns: null },
      reasoning: { turns: 0, withThinking: 0, textTurns: 0, textWithThinking: 0 },
      repeats: [],
    };
  }

  /** The SDK's `init` message: the model, tools and MCP servers the run has. */
  init(message: { model?: unknown; tools?: unknown; mcp_servers?: unknown }): void {
    if (typeof message.model === 'string') this.value.model = message.model.slice(0, 200);
    this.value.tools = names(message.tools).slice(0, MAX_NAMES);
    this.value.mcpServers = (Array.isArray(message.mcp_servers) ? message.mcp_servers : [])
      .slice(0, MAX_NAMES)
      .flatMap((s: { name?: unknown; status?: unknown }) =>
        typeof s?.name === 'string'
          ? [{ name: s.name.slice(0, 200), status: String(s.status ?? '').slice(0, 40) }]
          : [],
      );
  }

  /** One request the bridge received from the worker's Claude Code. */
  request(raw: Record<string, unknown>): void {
    const cap = raw.max_tokens;
    if (typeof cap === 'number' && Number.isSafeInteger(cap))
      this.value.settings.maxOutputTokens = Math.max(this.value.settings.maxOutputTokens ?? 0, cap);
    const thinking = (raw.thinking as { type?: unknown } | undefined)?.type;
    if (typeof thinking === 'string' && !this.value.settings.thinking.includes(thinking))
      this.value.settings.thinking = [...this.value.settings.thinking, thinking.slice(0, 40)];
    const turns = (Array.isArray(raw.messages) ? raw.messages : []).filter(
      (m: { role?: unknown }) => m?.role === 'assistant',
    );
    const reasoning = { turns: turns.length, withThinking: 0, textTurns: 0, textWithThinking: 0 };
    for (const turn of turns) {
      const kinds = blocks(turn).map((b) => b.type);
      const thought = kinds.includes('thinking') || kinds.includes('redacted_thinking');
      if (thought) reasoning.withThinking++;
      if (!kinds.includes('tool_use')) {
        reasoning.textTurns++;
        if (thought) reasoning.textWithThinking++;
      }
    }
    this.value.reasoning = reasoning;
  }

  /** A repeat reminder that fired: which tool, at which count. */
  repeat(tool: string, reminder: string | undefined): void {
    const count = /repeated (\d+) times/.exec(reminder ?? '')?.[1];
    if (!count || this.value.repeats.length >= MAX_REPEATS) return;
    this.value.repeats.push({ tool: tool.slice(0, 200), count: Number(count) });
  }

  /** The SDK's result message: its subtype, turn count and stop reason. */
  stop(result: { subtype?: unknown; num_turns?: unknown; stop_reason?: unknown }): void {
    if (typeof result.subtype !== 'string') return;
    this.value.stop = {
      subtype: result.subtype.slice(0, 80),
      ...(Number.isSafeInteger(result.num_turns) ? { turns: Number(result.num_turns) } : {}),
      ...(typeof result.stop_reason === 'string'
        ? { stopReason: result.stop_reason.slice(0, 80) }
        : {}),
    };
  }

  snapshot(): WorkerDiagnostics {
    return structuredClone(this.value);
  }

  /** Writes the record beside the job's own. Never throws: diagnostics change nothing. */
  async write(dataDir: string, jobId: string): Promise<void> {
    try {
      const head = await run('git', ['-C', this.value.root, 'rev-parse', 'HEAD'], {
        timeout: 2000,
      }).catch(() => undefined);
      const commit = head?.stdout.trim();
      if (commit && /^[0-9a-f]{40,64}$/.test(commit)) this.value.commit = commit;
      await writeFileAtomic(
        join(dataDir, 'model-jobs', `${jobId}.diagnostics.json`),
        JSON.stringify(this.value),
        { mode: 0o600, dirMode: 0o700 },
      );
    } catch {
      // A record that cannot be written leaves the job as it is.
    }
  }
}

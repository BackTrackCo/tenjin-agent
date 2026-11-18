import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../lib/atomic-json';
import { isRecord } from '../lib/guards';
import { mask } from '../lib/redact';
import { readJsonFile } from './store-files';

const run = promisify(execFile);
const MAX_NAMES = 256;
const MAX_REPEATS = 32;

/**
 * A BOUNDED RECORD OF HOW ONE WORKER RUN WENT, for looking into a stop or a drift later:
 * its tools and MCP servers, its root and commit, the output and context settings its
 * requests carried, whether its earlier reasoning went back on each turn, its repeat
 * reminders and how it ended. Names, numbers and codes only: no assignment, no tool
 * input or result, no model text. A run that failed also keeps its error (`failure`).
 * Written next to the job's record, readable by its user alone, swept with it after 7
 * days, and sent nowhere.
 */
export type WorkerDiagnostics = {
  version: 1;
  root: string;
  commit?: string;
  model?: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  settings: {
    /** The output cap the worker was given, and the largest one a request asked for. */
    outputCap: number;
    maxOutputTokens?: number;
    compactWindow: number;
    thinking: string[];
    /** None: the job's wall time and money ceiling bound a run. */
    maxTurns: null;
  };
  /** The latest request's history: assistant turns, and how many carried their reasoning back. */
  reasoning: { turns: number; withThinking: number; textTurns: number; textWithThinking: number };
  repeats: { tool: string; count: number }[];
  /**
   * Milliseconds from the accept call reaching `tenjin mcp` to each start phase, the first
   * time it happens: `cliProcess` (negative: when that process started), `checked` (consent
   * and offer checks), `qualified` (worker qualification and the Claude Code version
   * read), `promptRead` (the native agent prompt), `childSpawned`, `earlyReady` (SDK initialization
   * before releasing a warm worker), `childReady` (the SDK's
   * init), `firstRequest` (the bridge's first model request, before its quote round trip),
   * `firstAnswer` (that call answered), `firstActivity` (the first worker reply observed,
   * which the viewer's first row draws from).
   */
  phases: Record<string, number>;
  /** Model calls tried again after a failure the router confirmed cost nothing. */
  retries: { attempt: number; cause: string; status?: number }[];
  stop?: { subtype: string; turns?: number; stopReason?: string };
  failure?: WorkerFailure;
};

/**
 * WHY A RUN THAT DID NOT COMPLETE FAILED: the job's end code, and the error with its
 * causes, outermost first. Each has its class name, its code when it has one (a system
 * code such as `ETIMEDOUT`, the router's status or fixed error code) and the start of its
 * message with secret-shaped values masked. A job once ended `unknown` after 3 s with
 * nothing anywhere to say what had failed.
 */
export type WorkerFailure = {
  endedBy: string;
  errors: { name: string; code?: string; status?: number; message: string }[];
};
const MAX_CAUSES = 5;
const MAX_MESSAGE = 300;

export function workerFailure(endedBy: string, error: unknown): WorkerFailure {
  const errors: WorkerFailure['errors'] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSES && current !== undefined && current !== null; depth++) {
    const value = isRecord(current) ? current : {};
    // A model call's own fixed codes, and a worker stop's.
    const detail = [value.detail, value.stop].find(isRecord) ?? {};
    const code = [value.code, detail.code, detail.reason, detail.cause].find(
      (v): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v),
    );
    const status = [value.status, detail.status].find(
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
    );
    errors.push({
      name: (typeof value.name === 'string' ? value.name : typeof current).slice(0, 80),
      ...(code ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      message: mask(typeof value.message === 'string' ? value.message : String(current)).slice(
        0,
        MAX_MESSAGE,
      ),
    });
    current = value.cause;
  }
  return { endedBy: endedBy.slice(0, 80), errors };
}

/**
 * Adds a failed run's error to the job's record, or starts the record for a run that
 * ended before its worker wrote one. Never throws: diagnostics change nothing.
 */
export async function writeWorkerFailure(
  dataDir: string,
  jobId: string,
  failure: WorkerFailure,
): Promise<void> {
  try {
    const path = join(dataDir, 'model-jobs', `${jobId}.diagnostics.json`);
    const kept = await readJsonFile(path, 1_000_000).catch(() => null);
    await writeFileAtomic(
      path,
      JSON.stringify({
        ...(isRecord(kept) && kept.version === 1 ? kept : { version: 1 }),
        failure,
      }),
      { mode: 0o600, dirMode: 0o700 },
    );
  } catch {
    // A record that cannot be written leaves the job as it is.
  }
}

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
  private acceptedAt: number;

  constructor(root: string, compactWindow: number, outputCap: number) {
    this.value = {
      version: 1,
      root,
      tools: [],
      mcpServers: [],
      settings: { outputCap, compactWindow, thinking: [], maxTurns: null },
      reasoning: { turns: 0, withThinking: 0, textTurns: 0, textWithThinking: 0 },
      repeats: [],
      retries: [],
      phases: {},
    };
    this.acceptedAt = Date.now();
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

  /** Times from the accept on: the accept's own time and the marks made before the run. */
  accepted(at: number, marks: Record<string, number> = {}): void {
    // A worker started at offer time marked its start before the accept: those phases
    // are moved to count from the accept too, so they read negative.
    for (const name of Object.keys(this.value.phases))
      this.value.phases[name] = this.value.phases[name]! + Math.round(this.acceptedAt - at);
    this.acceptedAt = at;
    for (const [name, when] of Object.entries(marks).slice(0, 16)) this.mark(name, when);
  }

  /** A start phase reached, once: milliseconds since the accept. */
  mark(name: string, at = Date.now()): void {
    if (name in this.value.phases || Object.keys(this.value.phases).length >= 32) return;
    this.value.phases[name.slice(0, 40)] = Math.round(at - this.acceptedAt);
  }

  /** A model call tried again: which try failed, and why (fixed codes). */
  retry(attempt: number, failure: { cause: string; status?: number }): void {
    if (this.value.retries.length >= MAX_REPEATS) return;
    this.value.retries.push({
      attempt,
      cause: failure.cause.slice(0, 40),
      ...(failure.status !== undefined ? { status: failure.status } : {}),
    });
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

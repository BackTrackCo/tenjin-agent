import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { parseCodexHistory } from './codex-history';
import { codexRouterEvent, codexResponse } from './codex-event';
import { at, CODEX_PLUGIN, codexHookRows } from './codex-host';
import {
  elicitationCanShow,
  runCodexDoctor,
  runCodexInstall,
  runCodexUninstall,
  type CodexRun,
  type CodexSetupDeps,
} from './codex-install';
import { runHookCommand } from './hook-command';
import { CODEX_ALLOW_HOOK_COMMAND } from './plugin-files';
import { runNativeHook, runPromptHook, runShortfallHook } from './hooks';
import { CODEX_REQUEST_TOOL, requestToolName } from './names';
import { resolveProgressSession, sessionDir } from './progress';

const session = 'session-one';
const meta = {
  type: 'session_meta',
  payload: { id: session, session_id: session, thread_source: 'user' },
};
const item = (id: string, text: string, type = 'UserMessage') => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    thread_id: session,
    item: {
      id,
      type,
      phase: 'final_answer',
      content: [{ type: type === 'UserMessage' ? 'text' : 'Text', text }],
    },
  },
});
const history = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const native = {
  hook_event_name: 'PreToolUse',
  session_id: session,
  tool_name: 'webrun',
  tool_use_id: 'call-1',
  tool_input: { search_query: [{ q: 'example search' }] },
};
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const paidOffer = JSON.parse(
  readFileSync(join(fixtures, 'wire-hook-execute-spec.json'), 'utf8'),
) as { decision: { id: string } };
const nativeAnswer = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    reason: 'Use native tools',
    diagnostics: {
      reasonCode: 'native_sufficient',
      stage: 'capability',
      missing: [],
      nextAction: 'Use native tools',
    },
  },
};

let dir: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-codex-'));
  await mkdir(join(dir, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
  );
  transcript = join(dir, 'rollout.jsonl');
  await writeFile(transcript, history(meta, item('u', 'Find recent reports on example search.')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A router stub that records each body and answers `answer`. */
function router(answer: unknown) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(answer));
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const codexDeps = (fetchImpl: typeof fetch) => ({
  dataDir: dir,
  harness: 'codex' as const,
  fetchImpl,
  prefetch: () => {},
});

describe('Codex transcript ownership and bounds', () => {
  it('admits completed conversation once, excluding synthetic and tool rows', () => {
    const user = item('u', 'No paid tools.');
    expect(
      parseCodexHistory(
        history(
          meta,
          {
            type: 'response_item',
            payload: { role: 'user', content: [{ type: 'input_text', text: 'injected' }] },
          },
          user,
          user,
          item('a', 'Understood.', 'AgentMessage'),
          item('t', 'untrusted', 'McpToolCall'),
        ),
        session,
      ),
    ).toEqual([
      { role: 'user', text: 'No paid tools.' },
      { role: 'assistant', text: 'Understood.' },
    ]);
  });

  it('rejects a child with copied parent metadata, mismatched items, empty history and compaction', () => {
    const child = {
      ...meta,
      payload: {
        ...meta.payload,
        id: 'child',
        thread_source: 'subagent',
        parent_thread_id: session,
      },
    };
    expect(parseCodexHistory(history(child, meta, item('u', 'secret')), session)).toBeNull();
    const other = item('u', 'secret');
    expect(
      parseCodexHistory(
        history(meta, { ...other, payload: { ...other.payload, thread_id: 'other' } }),
        session,
      ),
    ).toBeNull();
    expect(parseCodexHistory(history(meta), session)).toBeNull();
    expect(
      parseCodexHistory(
        history(meta, item('u', 'No paid tools'), { type: 'compacted', payload: {} }),
        session,
      ),
    ).toBeNull();
    expect(parseCodexHistory(history(meta, item('u', 'x')) + '\n{', session)).toBeNull();
  });

  it('never offers on a web call whose rollout is past the read bound', async () => {
    const big = item('u', 'x'.repeat(1_000_000));
    await writeFile(transcript, history(meta, big, big, big, big, item('u', 'Find it.')));
    const { bodies, fetchImpl } = router(paidOffer);
    const out = await runNativeHook(
      { ...native, cwd: dir, transcript_path: transcript },
      codexDeps(fetchImpl),
    );
    expect(out.response).toBeNull();
    expect(bodies).toHaveLength(0);
  });
});

describe('Codex web events', () => {
  it('maps only one complete, unfiltered search, and passes batches and mixed calls through', () => {
    expect(codexRouterEvent(native)).toMatchObject({
      kind: 'native',
      pending: { tool: 'WebSearch', query: 'example search' },
    });
    for (const tool_input of [
      { search_query: [{ q: 'a' }, { q: 'b' }] },
      { search_query: [{ q: 'a', domains: ['example.com'] }] },
      { search_query: [{ q: 'a' }], open: [{ ref_id: 'https://example.com' }] },
      { search_query: [{ q: 'a' }], find: [] },
    ])
      expect(codexRouterEvent({ ...native, tool_input })).toBeNull();
  });

  it('gives a child agent no routing: it has no request tool to call', () => {
    expect(codexRouterEvent({ ...native, agent_id: 'child' })).toBeNull();
    expect(
      codexRouterEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        agent_id: 'child',
        prompt: 'x',
      }),
    ).toBeNull();
  });

  it('reads a failed search from PostToolUse, and an unknown result as no shortfall', () => {
    const post = { ...native, hook_event_name: 'PostToolUse' };
    expect(
      codexRouterEvent({ ...post, tool_response: [{ type: 'input_text', text: 'native answer' }] }),
    ).toMatchObject({ kind: 'shortfall', nativeOutcome: null });
    expect(codexRouterEvent({ ...post, tool_response: '' })).toMatchObject({
      nativeOutcome: { error: 'Web search returned no results' },
    });
    expect(codexRouterEvent({ ...post, tool_response: { changed: 'schema' } })).toMatchObject({
      nativeOutcome: null,
      search: null,
    });
  });

  it('puts free docs beside the result, since Codex cannot replace it', () => {
    expect(
      codexResponse({ hookSpecificOutput: { updatedToolOutput: { results: ['free docs'] } } }),
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'free docs' },
    });
    expect(
      codexResponse({ hookSpecificOutput: { hookEventName: 'PreToolUse' }, systemMessage: 'x' }),
    ).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  });
});

describe('Codex routing through the router', () => {
  it('denies a routed search with the Codex tool name and sends harness codex', async () => {
    const { bodies, fetchImpl } = router(paidOffer);
    const out = await runNativeHook(
      { ...native, cwd: dir, transcript_path: transcript },
      codexDeps(fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    const reason = String(at(out.response, 'hookSpecificOutput', 'permissionDecisionReason'));
    expect(reason).toContain(`${CODEX_REQUEST_TOOL}({`);
    expect(reason).not.toContain('mcp__x402');
    expect(bodies[0]).toMatchObject({ harness: 'codex' });
    expect(at(bodies[0], 'packet', 'current', 'text')).toBe(
      'Find recent reports on example search.',
    );
    expect(at(bodies[0], 'packet', 'pendingCall')).toEqual({
      tool: 'WebSearch',
      query: 'example search',
    });
  });

  it('redirects one of two parallel copies of a search, and keeps Codex state apart from Claude', async () => {
    const { fetchImpl } = router(paidOffer);
    const event = { ...native, cwd: dir, transcript_path: transcript };
    const outs = await Promise.all([
      runNativeHook(event, codexDeps(fetchImpl)),
      runNativeHook({ ...event, tool_use_id: 'call-2' }, codexDeps(fetchImpl)),
    ]);
    expect(outs.filter((o) => o.response !== null)).toHaveLength(1);
    expect(await resolveProgressSession(dir, { id: paidOffer.decision.id })).toBe(
      sessionDir(dir, `codex:${session}`),
    );
  });

  it('delivers a prompt offer through the Codex envelope', async () => {
    const { bodies, fetchImpl } = router(paidOffer);
    const out = await runPromptHook(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt: 'Research a topic',
        cwd: dir,
        transcript_path: transcript,
      },
      codexDeps(fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'hookEventName')).toBe('UserPromptSubmit');
    expect(String(at(out.response, 'hookSpecificOutput', 'additionalContext'))).toContain(
      `${CODEX_REQUEST_TOOL}({`,
    );
    expect(bodies[0]).toMatchObject({ harness: 'codex' });
  });

  it('says nothing when the router answers native', async () => {
    const { fetchImpl } = router(nativeAnswer);
    const out = await runNativeHook(
      { ...native, cwd: dir, transcript_path: transcript },
      codexDeps(fetchImpl),
    );
    expect(out.response).toBeNull();
  });

  it('offers on an empty search after it ran', async () => {
    const { fetchImpl } = router(paidOffer);
    const out = await runShortfallHook(
      {
        ...native,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'call-9',
        tool_response: '',
        cwd: dir,
        transcript_path: transcript,
      },
      codexDeps(fetchImpl),
    );
    expect(at(out.response, 'hookSpecificOutput', 'hookEventName')).toBe('PostToolUse');
    expect(String(at(out.response, 'hookSpecificOutput', 'additionalContext'))).toContain(
      CODEX_REQUEST_TOOL,
    );
  });

  /** One hook command run, its stdout captured. */
  async function hookRun(kind: 'prompt' | 'native', event: unknown, extra: object = {}) {
    const writes: string[] = [];
    const io = {
      stdout: { write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WritableStream,
      stderr: process.stderr,
      isTTY: false,
    };
    const { fetchImpl } = router(paidOffer);
    await runHookCommand(kind, io, {
      dataDir: dir,
      harness: 'codex',
      readEvent: async () => JSON.stringify(event),
      fetchImpl,
      ...extra,
    });
    return writes.length === 0 ? null : (JSON.parse(writes[0]!) as unknown);
  }
  // Built per test: `dir` and `transcript` are set in beforeEach.
  const promptEvent = () => ({
    hook_event_name: 'UserPromptSubmit',
    session_id: session,
    prompt: 'Research a topic',
    cwd: dir,
  });
  const webEvent = () => ({ ...native, cwd: dir, transcript_path: transcript });

  it('denies a search only once the prompt leg recorded that Codex allows the request tool', async () => {
    // No record yet: the search runs, with the offer beside it.
    const before = await hookRun('native', webEvent());
    expect(at(before, 'hookSpecificOutput', 'permissionDecision')).toBeUndefined();
    expect(String(at(before, 'hookSpecificOutput', 'additionalContext'))).toContain(
      CODEX_REQUEST_TOOL,
    );

    const lists: string[] = [];
    const codexHooks = async (cwd: string) => (lists.push(cwd), listed(...allRows()));
    expect(await hookRun('prompt', promptEvent(), { codexHooks })).not.toBeNull();
    expect(lists).toEqual([dir]);
    const after = await hookRun('native', {
      ...webEvent(),
      tool_use_id: 'call-7',
      tool_input: { search_query: [{ q: 'another search' }] },
    });
    expect(at(after, 'hookSpecificOutput', 'permissionDecision')).toBe('deny');
    // The answer stands for the session: the next prompt does not ask again.
    await hookRun('prompt', promptEvent(), { codexHooks });
    expect(lists).toHaveLength(1);
  });

  it('lets the search run with the offer as context when the allow hook is off', async () => {
    const off = async () => listed(row('a'), row('b'), row('c'), allowRow({ enabled: false }));
    await hookRun('prompt', promptEvent(), { codexHooks: off });
    const out = await hookRun('native', webEvent());
    expect(at(out, 'hookSpecificOutput', 'permissionDecision')).toBeUndefined();
    expect(at(out, 'hookSpecificOutput', 'hookEventName')).toBe('PreToolUse');
    expect(String(at(out, 'hookSpecificOutput', 'additionalContext'))).toContain(
      `${CODEX_REQUEST_TOOL}({`,
    );
  });

  it('records nothing when the hook list cannot be read', async () => {
    await hookRun('prompt', promptEvent(), { codexHooks: async () => null });
    const out = await hookRun('native', webEvent());
    expect(at(out, 'hookSpecificOutput', 'permissionDecision')).toBeUndefined();
  });

  it('names the request tool by host', () => {
    expect(requestToolName('codex')).toBe('mcp__router__request');
  });
});

const ctx = (): CommandContext => ({
  dataDir: dir,
  flags: { json: true, timeout: 1000 },
  io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
});

/** A Codex stand-in: records every command in order. */
function host(config: unknown = {}) {
  const steps: string[] = [];
  const deps: CodexSetupDeps = {
    run: async (args: string[]): Promise<CodexRun> => {
      steps.push(`codex ${args.filter((a) => a !== '--json').join(' ')}`);
      return { code: 0, stdout: '{}', stderr: '' };
    },
    config: async () => config,
    hooks: async () => ({ data: [] }),
    version: async () => '0.157.1',
    hostsDir: '/package/dist/hosts/codex',
    walletExists: async () => false,
    createWallet: async () => {
      steps.push('wallet');
      return '0x1111111111111111111111111111111111111111';
    },
  };
  return { steps, deps };
}

/** One `hooks/list` row of the Tenjin plugin, as Codex's HookMetadata carries it. */
const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  pluginId: CODEX_PLUGIN,
  enabled: true,
  trustStatus: 'trusted',
  ...over,
});
const allowRow = (over: Record<string, unknown> = {}) =>
  row('/c/tenjin/hooks/hooks.json:permission_request:0:0', {
    command: CODEX_ALLOW_HOOK_COMMAND,
    ...over,
  });
const listed = (...rows: unknown[]) => ({
  data: [{ hooks: [{ key: 'theirs', pluginId: 'other@x', trustStatus: 'untrusted' }, ...rows] }],
});
const allRows = () => [row('a'), row('b'), row('c'), allowRow()];

describe('Codex install, uninstall and doctor', () => {
  it('writes the wallet, the spend limits and the plugin, and no Codex config', async () => {
    const { steps, deps } = host();
    const out = await runCodexInstall({ yes: true }, ctx(), deps);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as object;
    expect(config).toMatchObject({ maxAutoSpend: '250000' });
    expect(steps).toEqual([
      'wallet',
      'codex plugin marketplace add /package/dist/hosts/codex',
      'codex plugin add tenjin@tenjin',
    ]);
    expect(out.data).not.toHaveProperty('grant');
    expect(out.data).not.toHaveProperty('approval');
    expect(out.humanLines?.join('\n')).toContain('four Tenjin hooks');
  });

  it('asks for the spend limits where nobody consented', async () => {
    const { deps } = host();
    const out = await runCodexInstall({}, ctx(), deps);
    expect(out.data).toHaveProperty('approval');
  });

  it('refuses project scope before any write', async () => {
    const { steps, deps } = host();
    await expect(runCodexInstall({ project: true }, ctx(), deps)).rejects.toThrow('user only');
    expect(steps).toEqual([]);
  });

  it('removes the plugin and its marketplace, reading no config first', async () => {
    const { steps, deps } = host(null);
    const out = await runCodexUninstall({}, ctx(), deps);
    expect(steps).toEqual([
      'codex plugin remove tenjin@tenjin',
      'codex plugin marketplace remove tenjin',
    ]);
    expect(out.data).toEqual({ removed: CODEX_PLUGIN, marketplace: 'tenjin' });
  });

  it('reads the plugin from hooks/list rows: installed and trusted, absent, untrusted', () => {
    expect(codexHookRows(listed(...allRows()))).toEqual({ state: 'trusted', allowOff: false });
    expect(codexHookRows(listed())).toEqual({ state: 'absent', allowOff: false });
    expect(codexHookRows(listed(row('a'), row('b', { trustStatus: 'untrusted' })))).toMatchObject({
      state: 'review',
    });
    expect(
      codexHookRows(listed(row('a'), row('b'), row('c', { enabled: false }), allowRow())),
    ).toMatchObject({ state: 'review' });
    expect(codexHookRows(listed(row('a'), row('b'), row('c')))).toMatchObject({ state: 'review' });
    expect(codexHookRows(null)).toEqual({ state: 'unknown', allowOff: false });
    // The allow hook off is the documented opt-out, so the plugin still counts as ready.
    expect(
      codexHookRows(
        listed(
          row('a'),
          row('b'),
          row('c'),
          allowRow({ enabled: false, trustStatus: 'untrusted' }),
        ),
      ),
    ).toEqual({ state: 'trusted', allowOff: true });
  });

  it('reads one hooks/list, runs no codex command, and never calls the build a gate', async () => {
    const { steps, deps } = host({ approval_policy: 'never' });
    const ready = await runCodexDoctor({}, ctx(), {
      ...deps,
      hooks: async () => listed(...allRows()),
    });
    expect(steps).toEqual([]);
    expect(ready.data).toMatchObject({
      hooks: 'trusted',
      ok: true,
      elicitation: false,
      version: '0.157.1',
    });
    expect(ready.humanLines?.join('\n')).toContain('information only');
    expect(elicitationCanShow({ approval_policy: 'on-request' })).toBe(true);
  });

  it('fails with the install step when absent and the /hooks step when untrusted', async () => {
    const { deps } = host();
    await expect(runCodexDoctor({}, ctx(), deps)).rejects.toMatchObject({
      code: 'REFUSED',
      details: { hooks: 'absent', ok: false },
      fix: expect.stringContaining('tenjin install --harness codex'),
    });
    await expect(
      runCodexDoctor({}, ctx(), {
        ...deps,
        hooks: async () => listed(...allRows().map((r) => ({ ...r, trustStatus: 'untrusted' }))),
      }),
    ).rejects.toMatchObject({
      details: { hooks: 'review' },
      fix: expect.stringContaining('/hooks'),
    });
  });

  it('fails when the allow hook is off under approval_policy never, which refuses the tool', async () => {
    const off = () => listed(row('a'), row('b'), row('c'), allowRow({ enabled: false }));
    const prompt = await runCodexDoctor({}, ctx(), { ...host().deps, hooks: async () => off() });
    expect(prompt.humanLines?.join('\n')).toContain('asks before each call');
    await expect(
      runCodexDoctor({}, ctx(), {
        ...host({ approval_policy: 'never' }).deps,
        hooks: async () => off(),
      }),
    ).rejects.toMatchObject({ details: { allowOff: true, ok: false } });
  });
});

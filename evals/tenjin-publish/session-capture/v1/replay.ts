import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PUSH_CONTEXT_HOOK_FILE,
  PUSH_FAILURE_HOOK_FILE,
  PUSH_PROMPT_HOOK_FILE,
  PUSH_SUBAGENT_HOOK_FILE,
} from '../../../../src/lib/push-scripts';
import { STOP_HOOK_FILE, WEBSEARCH_HOOK_FILE } from '../../../../src/lib/hook-scripts';
import { wireSearchHooks } from '../../../../src/lib/harness-hooks';
import { STATE_DB_FILE } from '../../../../src/lib/state-store';
import { loadRawConfig, resolveSettings } from '../../../../src/lib/config';
import { resolvePublishSettings } from '../../../../src/lib/settings';
import { defaultDataDir } from '../../../../src/lib/paths';

type RunKind = 'baseline' | 'treatment' | 'parity';
const ACTIVITY_PREFIX = 'capture:activity:';
const TEAM_CAPTURE_MARKER = 'anything a teammate on this project would reuse';
type EventKind =
  | 'user_turn'
  | 'inspection'
  | 'mutation'
  | 'shell'
  | 'shell_failure'
  | 'research'
  | 'stop'
  | 'resume'
  | 'background_start'
  | 'background_finish'
  | 'tenjin_publish'
  | 'tenjin_edit';

interface ManifestEvent {
  offsetMs: number;
  kind: EventKind;
  count?: number;
}

interface ManifestCase {
  caseId: string;
  evalId: number;
  stratum: string;
  startedAt: string;
  root: true;
  events: ManifestEvent[];
}

interface Manifest {
  schemaVersion: 1;
  benchmark: 'session-capture/v1';
  casesSha256: string;
  cases: ManifestCase[];
}

interface Label {
  caseId: string;
  expectedDisposition: 'publish' | 'no_finding' | 'withhold_sensitive';
  reusableConceptIds: string[];
}

interface Labels {
  evaluatorVersion: string;
  labels: Label[];
}

interface HookResult {
  code: number | null;
  stdout: string;
  stderrPresent: boolean;
  elapsedMs: number;
}

interface Args {
  kind: RunKind;
  expectedRef: string;
  out: string;
  activityPrefix: string;
  installedDataDir: string;
  installedHome: string;
}

interface InstalledSetup {
  dataDir: string;
  cliPath: string | null;
  safeConfig: {
    publishMode: 'auto';
    ackServerWarnings: 'mode' | 'on' | 'off';
    webSearch: 'auto' | 'remind' | 'off';
    agentDispatch: 'auto' | 'remind' | 'off';
    stopNag: 'on' | 'deliberate-only' | 'off';
    sessionPrimer: 'on' | 'off';
    push: 'on';
    capture: 'block';
  };
  metadata: Record<string, unknown>;
}

// `run-replay.mjs` bundles this entry into a disposable directory before it is
// executed, so import.meta.url points at that directory. The command contract
// is intentionally repo-root-relative instead.
const repoRoot = process.cwd();
const here = join(repoRoot, 'evals', 'tenjin-publish', 'session-capture', 'v1');
const readJson = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(join(here, name), 'utf8')) as T;

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const split = arg.indexOf('=');
    if (split !== -1) {
      values.set(arg.slice(2, split), arg.slice(split + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(arg.slice(2), next);
      i += 1;
    }
  }
  const kind = values.get('kind');
  const expectedRef = values.get('expected-ref');
  const out = values.get('out');
  if (
    (kind !== 'baseline' && kind !== 'treatment' && kind !== 'parity') ||
    expectedRef === undefined ||
    out === undefined
  ) {
    throw new Error(
      'usage: replay.ts --kind <baseline|treatment|parity> --expected-ref <commit> --out <local-json> [--installed-data-dir <dir>] [--installed-home <dir>]',
    );
  }
  const requestedPrefix = values.get('activity-prefix');
  if (requestedPrefix !== undefined && requestedPrefix !== ACTIVITY_PREFIX) {
    throw new Error(`activity prefix is fixed at ${ACTIVITY_PREFIX}`);
  }
  return {
    kind,
    expectedRef,
    out,
    activityPrefix: ACTIVITY_PREFIX,
    installedDataDir: values.get('installed-data-dir') ?? defaultDataDir(),
    installedHome: values.get('installed-home') ?? homedir(),
  };
}

async function command(command: string, args: string[], cwd = repoRoot): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function assertPinnedCleanCheckout(
  expectedRef: string,
): Promise<{ commit: string; commitDate: string }> {
  const head = await command('git', ['rev-parse', 'HEAD']);
  const expected = await command('git', ['rev-parse', expectedRef]);
  if (head !== expected) throw new Error(`HEAD ${head} does not match expected ref ${expected}`);
  const dirty = await command('git', ['status', '--porcelain']);
  if (dirty !== '') throw new Error('replay refuses a dirty checkout');
  const commitDate = await command('git', ['show', '-s', '--format=%cI', head]);
  return { commit: head, commitDate };
}

async function artifactHashes(): Promise<Record<string, string>> {
  const names = ['manifest.json', 'labels.json', 'questions.json', 'evaluator.json'];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name.replace('.json', 'Sha256'),
        createHash('sha256')
          .update(await readFile(join(here, name)))
          .digest('hex'),
      ]),
    ),
  );
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error('installed shelf configuration contains an invalid URL');
  }
}

function installedPushHookCount(settings: unknown, installedDataDir: string): number {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return 0;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 0;
  const expected: Array<[string, string | null, string]> = [
    ['UserPromptSubmit', null, PUSH_PROMPT_HOOK_FILE],
    ['PostToolUse', 'Bash', PUSH_FAILURE_HOOK_FILE],
    ['PostToolUseFailure', 'Bash', PUSH_FAILURE_HOOK_FILE],
    ['SubagentStart', null, PUSH_SUBAGENT_HOOK_FILE],
    ['SubagentStop', null, PUSH_SUBAGENT_HOOK_FILE],
    ['PostToolUse', 'Read', PUSH_CONTEXT_HOOK_FILE],
    ['PreToolUse', 'Edit|Write|MultiEdit', PUSH_CONTEXT_HOOK_FILE],
  ];
  const pushFiles = new Set(expected.map((entry) => entry[2]));
  const found: Array<[string, string | null, string]> = [];
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const handlers = record.hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        if (typeof handler !== 'object' || handler === null || Array.isArray(handler)) continue;
        const handlerRecord = handler as Record<string, unknown>;
        const command = handlerRecord.command;
        if (typeof command !== 'string') continue;
        const file = [...pushFiles].find(
          (candidate) =>
            command.includes(candidate) && command.includes(join(installedDataDir, 'hooks')),
        );
        if (file === undefined) continue;
        const expectedEntryKeys = record.matcher === undefined ? ['hooks'] : ['hooks', 'matcher'];
        if (
          JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedEntryKeys.sort()) ||
          JSON.stringify(Object.keys(handlerRecord).sort()) !==
            JSON.stringify(['command', 'timeout', 'type']) ||
          handlerRecord.type !== 'command' ||
          handlerRecord.timeout !== 8
        ) {
          return 0;
        }
        found.push([event, typeof record.matcher === 'string' ? record.matcher : null, file]);
      }
    }
  }
  const ordered = (rows: Array<[string, string | null, string]>) =>
    rows.map((row) => JSON.stringify(row)).sort();
  return JSON.stringify(ordered(found)) === JSON.stringify(ordered(expected)) ? found.length : 0;
}

async function preflightInstalledSetup(dataDir: string, home: string): Promise<InstalledSetup> {
  const raw = await loadRawConfig(dataDir);
  const settings = resolveSettings({ config: raw, flags: {}, env: process.env });
  const publish = await resolvePublishSettings({ dataDir, cwd: repoRoot, env: process.env });
  const teamConfigured =
    settings.shelfBypassSecret.value.length > 0 &&
    originOf(settings.baseUrl.value) !== originOf(settings.publicShelfUrl.value);
  if (!teamConfigured)
    throw new Error('installed setup is not configured for a distinct team shelf');
  if (settings.hooksPush.value !== 'on') throw new Error('installed hooks.push must be on');
  if (settings.hooksCapture.value !== 'block') {
    throw new Error('installed hooks.capture must be block');
  }
  if (publish.mode !== 'auto') {
    throw new Error(`installed effective publish mode must be auto, got ${publish.mode}`);
  }
  if (settings.hooksWebSearch.value !== 'auto') {
    throw new Error('installed hooks.webSearch must be auto for frozen research cases');
  }

  const settingsPath = join(home, '.claude', 'settings.json');
  const harnessSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown;
  const pushHookEntries = installedPushHookCount(harnessSettings, dataDir);
  if (pushHookEntries !== 7) {
    throw new Error(`installed Claude status has ${pushHookEntries} push hook entries; expected 7`);
  }

  const installedStop = await readFile(join(dataDir, 'hooks', STOP_HOOK_FILE), 'utf8');
  const cliLiteral = /^const CLI_PATH = (.*);$/m.exec(installedStop)?.[1];
  if (cliLiteral === undefined) throw new Error('installed Stop hook has no CLI_PATH stamp');
  const cliPath = JSON.parse(cliLiteral) as unknown;
  if (cliPath !== null && typeof cliPath !== 'string') {
    throw new Error('installed Stop hook has an invalid CLI_PATH stamp');
  }

  return {
    dataDir,
    cliPath,
    safeConfig: {
      publishMode: publish.mode,
      ackServerWarnings: settings.publishAckServerWarnings.value,
      webSearch: settings.hooksWebSearch.value,
      agentDispatch: settings.hooksAgentDispatch.value,
      stopNag: settings.hooksStopNag.value,
      sessionPrimer: settings.hooksSessionPrimer.value,
      push: settings.hooksPush.value,
      capture: settings.hooksCapture.value,
    },
    metadata: {
      teamShelfConfigured: true,
      publishMode: { value: publish.mode, source: publish.modeSource },
      hooks: {
        push: { value: settings.hooksPush.value, source: settings.hooksPush.source },
        capture: { value: settings.hooksCapture.value, source: settings.hooksCapture.source },
        webSearch: {
          value: settings.hooksWebSearch.value,
          source: settings.hooksWebSearch.source,
        },
      },
      claudePushHookEntries: { present: pushHookEntries, identitiesExact: true },
    },
  };
}

async function startMissServer(): Promise<{ server: Server; origin: string; hits: () => number }> {
  let count = 0;
  const server = createServer((request, response) => {
    count += 1;
    request.resume();
    request.on('end', () => {
      const isSearch = request.url?.startsWith('/api/search') === true;
      response.writeHead(isSearch ? 200 : 404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          isSearch
            ? {
                schemaVersion: 3,
                searchId: '11111111-1111-4111-8111-111111111111',
                items: [],
              }
            : {},
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null)
    throw new Error('loopback server has no port');
  return { server, origin: `http://127.0.0.1:${address.port}`, hits: () => count };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  // Allowlist instead of inheriting: the generated fixture hook has no reason
  // to see a wallet, cloud credential, or arbitrary caller environment.
  return { HOME: home, PATH: process.env.PATH ?? '' };
}

async function runHook(
  path: string,
  input: Record<string, unknown>,
  home: string,
): Promise<HookResult> {
  const started = performance.now();
  return await new Promise<HookResult>((resolve, reject) => {
    const child = spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment(home),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderrPresent: stderr.trim().length > 0,
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function normalizedBundle(source: string, dataDir: string): string {
  const literal = `const DATA_DIR = ${JSON.stringify(dataDir)};`;
  if (!source.includes(literal))
    throw new Error('generated hook does not embed its requested data dir');
  return source.replace(literal, 'const DATA_DIR = "<DISPOSABLE_DATA_DIR>";');
}

async function generateBundle(
  root: string,
  name: string,
  cliPath: string | null,
): Promise<{ home: string; data: string; hooks: string }> {
  const home = join(root, `${name}-home`);
  const data = join(root, `${name}-data`);
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  // stopHookScript bakes process.argv[1] as CLI_PATH. Use the installed
  // generator input so normalized parity really differs only at DATA_DIR; the
  // value is never reported, and fixture projects carry no git remote, so the
  // replayed Stop cannot take its detached-sync branch.
  const originalArgv1 = process.argv[1];
  process.argv[1] = cliPath ?? 'replay-without-installed-cli';
  let wired: Awaited<ReturnType<typeof wireSearchHooks>>;
  try {
    wired = await wireSearchHooks({ homeDir: home, dataDir: data, mode: 'auto', push: true });
  } finally {
    if (originalArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = originalArgv1;
  }
  if (wired.skipped !== undefined)
    throw new Error(`production hook generator skipped: ${wired.skipped}`);
  return { home, data, hooks: wired.scriptsDir };
}

async function bundleFingerprint(
  bundle: { data: string; hooks: string },
  expectedFiles?: string[],
): Promise<{ hash: string; files: string[] }> {
  const files =
    expectedFiles === undefined
      ? (await readdir(bundle.hooks)).filter((name) => name.endsWith('.mjs')).sort()
      : [...expectedFiles].sort();
  const normalized: string[] = [];
  for (const file of files) {
    normalized.push(
      `${file}\n${normalizedBundle(await readFile(join(bundle.hooks, file), 'utf8'), bundle.data)}`,
    );
  }
  return {
    hash: createHash('sha256').update(normalized.join('\n')).digest('hex'),
    files,
  };
}

async function assertGeneratorParity(
  root: string,
  cliPath: string | null,
): Promise<{ bundleHash: string; files: string[] }> {
  const first = await generateBundle(root, 'parity-a', cliPath);
  const second = await generateBundle(root, 'parity-b', cliPath);
  const a = await bundleFingerprint(first);
  const b = await bundleFingerprint(second);
  if (a.hash !== b.hash || JSON.stringify(a.files) !== JSON.stringify(b.files)) {
    throw new Error('production bundles differ by more than embedded DATA_DIR');
  }
  return { bundleHash: a.hash, files: a.files };
}

async function assertInstalledBundleParity(
  installedDataDir: string,
  generated: { bundleHash: string; files: string[] },
): Promise<{ verified: true; normalizedBundleSha256: string; scriptCount: number }> {
  const installed = await bundleFingerprint(
    {
      data: installedDataDir,
      hooks: join(installedDataDir, 'hooks'),
    },
    generated.files,
  );
  if (
    installed.hash !== generated.bundleHash ||
    JSON.stringify(installed.files) !== JSON.stringify(generated.files)
  ) {
    throw new Error(
      'installed hook bundle does not match this pinned production generator after DATA_DIR normalization',
    );
  }
  return {
    verified: true,
    normalizedBundleSha256: installed.hash,
    scriptCount: installed.files.length,
  };
}

function appendTranscript(
  rows: string[],
  kind: 'background_start' | 'background_finish',
  toolId: string,
): void {
  const timestamp = new Date().toISOString();
  if (kind === 'background_start') {
    rows.push(
      JSON.stringify({
        timestamp,
        message: { content: [{ type: 'tool_use', id: toolId, name: 'Agent' }] },
      }),
      JSON.stringify({
        timestamp,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: 'Async agent launched successfully.',
            },
          ],
        },
      }),
    );
    return;
  }
  rows.push(
    JSON.stringify({
      timestamp,
      message: {
        content: `<task-notification><status>completed</status><tool-use-id>${toolId}</tool-use-id></task-notification>`,
      },
    }),
  );
}

function inputFor(
  kind: EventKind,
  sessionId: string,
  cwd: string,
  transcriptPath: string,
): { script: string | null; envelope: Record<string, unknown> | null } {
  const base = { session_id: sessionId, cwd };
  if (kind === 'inspection') {
    return {
      script: PUSH_CONTEXT_HOOK_FILE,
      envelope: {
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
        tool_response: { content: 'synthetic fixture' },
      },
    };
  }
  if (kind === 'mutation') {
    return {
      script: PUSH_CONTEXT_HOOK_FILE,
      envelope: {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: 'README.md',
          old_string: 'fixture-before',
          new_string: 'fixture-after',
        },
      },
    };
  }
  if (kind === 'shell' || kind === 'shell_failure') {
    return {
      script: PUSH_FAILURE_HOOK_FILE,
      envelope: {
        ...base,
        hook_event_name: kind === 'shell_failure' ? 'PostToolUseFailure' : 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: kind === 'shell_failure' ? 'false' : 'pwd' },
        ...(kind === 'shell_failure'
          ? { error: 'fixture command exited without a reusable diagnosis' }
          : { tool_response: { stdout: 'fixture-ok', stderr: '', exit_code: 0 } }),
      },
    };
  }
  if (kind === 'research') {
    return {
      script: WEBSEARCH_HOOK_FILE,
      envelope: {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'WebSearch',
        tool_input: { query: 'How does the synthetic fixture repository boundary behave?' },
      },
    };
  }
  if (kind === 'tenjin_publish' || kind === 'tenjin_edit') {
    const verb = kind === 'tenjin_publish' ? 'publish fixture.md' : 'edit fixture-id fixture.md';
    return {
      script: PUSH_FAILURE_HOOK_FILE,
      envelope: {
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: `tenjin ${verb}` },
        tool_response: { stdout: 'fixture receipt', stderr: '', exit_code: 0 },
      },
    };
  }
  if (kind === 'stop') {
    return {
      script: STOP_HOOK_FILE,
      envelope: { ...base, hook_event_name: 'Stop', transcript_path: transcriptPath },
    };
  }
  return { script: null, envelope: null };
}

function captureAsk(stdout: string): boolean {
  if (stdout.trim() === '') return false;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (
      parsed.decision === 'block' &&
      typeof parsed.reason === 'string' &&
      parsed.reason.includes(TEAM_CAPTURE_MARKER)
    ) {
      return true;
    }
    const hook = parsed.hookSpecificOutput;
    return (
      typeof hook === 'object' &&
      hook !== null &&
      typeof (hook as Record<string, unknown>).additionalContext === 'string' &&
      ((hook as Record<string, unknown>).additionalContext as string).includes(TEAM_CAPTURE_MARKER)
    );
  } catch {
    return false;
  }
}

async function stateSummary(
  dataDir: string,
  sessionId: string,
  activityPrefix: string,
): Promise<{
  activityRows: number;
  captureAskedRows: number;
  activityStateExact: boolean;
  sessionStatePrivacySafe: boolean;
  unexpectedSessionStateRows: number;
}> {
  const path = join(dataDir, STATE_DB_FILE);
  if (!existsSync(path)) {
    return {
      activityRows: 0,
      captureAskedRows: 0,
      activityStateExact: true,
      sessionStatePrivacySafe: true,
      unexpectedSessionStateRows: 0,
    };
  }
  // Dynamic on purpose: tsup's node-platform rewrite drops the `node:` prefix
  // from static imports it recognizes, and `sqlite` has no prefix-free builtin.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT key, value FROM session_state WHERE session = ? ORDER BY key')
      .all(sessionId) as unknown as Array<{ key: string; value: string }>;
    const activity = rows.filter((row) => row.key.startsWith(activityPrefix));
    const activityKeys = new Set(
      ['inspection', 'mutation', 'shell'].map((suffix) => `${ACTIVITY_PREFIX}${suffix}`),
    );
    const activityExact =
      activity.length <= 3 &&
      new Set(activity.map((row) => row.key)).size === activity.length &&
      activity.every((row) => {
        if (!activityKeys.has(row.key)) return false;
        try {
          return JSON.parse(row.value) === true;
        } catch {
          return false;
        }
      });
    const stateShapeSafe = rows.every((row) => {
      if (activityKeys.has(row.key)) {
        try {
          return JSON.parse(row.value) === true;
        } catch {
          return false;
        }
      }
      if (row.key === 'capture_asked') {
        try {
          const value = JSON.parse(row.value) as unknown;
          return (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            Object.keys(value as Record<string, unknown>).length === 1 &&
            typeof (value as Record<string, unknown>).at === 'string' &&
            Number.isFinite(Date.parse((value as Record<string, unknown>).at as string))
          );
        } catch {
          return false;
        }
      }
      // The production context arm already keeps an edit marker for its own
      // failure-pairing judge. The replay supplies this one fixed synthetic key;
      // no arbitrary cwd/path is accepted as privacy-safe benchmark state.
      if (row.key === 'edited::README.md') {
        try {
          return JSON.parse(row.value) === true;
        } catch {
          return false;
        }
      }
      return false;
    });
    const expectedKeys = new Set([...activityKeys, 'capture_asked', 'edited::README.md']);
    return {
      activityRows: activity.length,
      captureAskedRows: rows.filter((row) => row.key === 'capture_asked').length,
      activityStateExact: activityExact,
      sessionStatePrivacySafe: activityExact && stateShapeSafe,
      unexpectedSessionStateRows: rows.filter((row) => !expectedKeys.has(row.key)).length,
    };
  } finally {
    db.close();
  }
}

async function replayCase(
  root: string,
  entry: ManifestCase,
  label: Label,
  activityPrefix: string,
  teamOrigin: string,
  publicOrigin: string,
  installed: InstalledSetup,
): Promise<Record<string, unknown>> {
  const bundle = await generateBundle(root, entry.caseId, installed.cliPath);
  const cwd = join(root, `${entry.caseId}-project`);
  const transcriptPath = join(root, `${entry.caseId}-transcript.jsonl`);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'README.md'), 'synthetic replay fixture\n');
  await writeFile(transcriptPath, '');
  await writeFile(
    join(bundle.data, 'config.json'),
    `${JSON.stringify(
      {
        baseUrl: teamOrigin,
        publicShelfUrl: publicOrigin,
        shelfBypassSecret: 'synthetic-loopback-only',
        publish: {
          mode: installed.safeConfig.publishMode,
          ackServerWarnings: installed.safeConfig.ackServerWarnings,
        },
        hooks: {
          push: installed.safeConfig.push,
          capture: installed.safeConfig.capture,
          webSearch: installed.safeConfig.webSearch,
          agentDispatch: installed.safeConfig.agentDispatch,
          stopNag: installed.safeConfig.stopNag,
          sessionPrimer: installed.safeConfig.sessionPrimer,
        },
      },
      null,
      2,
    )}\n`,
  );

  const transcript: string[] = [];
  const hookRuns: HookResult[] = [];
  let askCount = 0;
  let stopCount = 0;
  let firstBackgroundStopAsked = false;
  let backgroundRunning = false;
  const toolId = `tool_${entry.caseId}`;

  for (const event of entry.events) {
    if (event.kind === 'background_start' || event.kind === 'background_finish') {
      appendTranscript(transcript, event.kind, toolId);
      backgroundRunning = event.kind === 'background_start';
      await writeFile(transcriptPath, `${transcript.join('\n')}\n`);
      continue;
    }
    if (event.kind === 'user_turn' || event.kind === 'resume') continue;
    const count = event.count ?? 1;
    for (let index = 0; index < count; index += 1) {
      const mapped = inputFor(event.kind, entry.caseId, cwd, transcriptPath);
      if (mapped.script === null || mapped.envelope === null) continue;
      const result = await runHook(join(bundle.hooks, mapped.script), mapped.envelope, bundle.home);
      hookRuns.push(result);
      if (event.kind === 'stop') {
        stopCount += 1;
        const asked = captureAsk(result.stdout);
        if (backgroundRunning && asked) firstBackgroundStopAsked = true;
        if (asked) askCount += 1;
      }
    }
  }

  const state = await stateSummary(bundle.data, entry.caseId, activityPrefix);
  const elapsed = hookRuns.map((run) => run.elapsedMs);
  return {
    caseId: entry.caseId,
    stratum: entry.stratum,
    expectedDisposition: label.expectedDisposition,
    reusableConceptCount: label.reusableConceptIds.length,
    asked: askCount > 0,
    askCount,
    stopCount,
    activityDetected: state.activityRows > 0,
    activityRows: state.activityRows,
    activityStateExact: state.activityStateExact,
    sessionStatePrivacySafe: state.sessionStatePrivacySafe,
    unexpectedSessionStateRows: state.unexpectedSessionStateRows,
    firstBackgroundStopAsked,
    hookRunCount: hookRuns.length,
    hookErrorCount: hookRuns.filter((run) => run.code !== 0 || run.stderrPresent).length,
    hookWallMs: {
      total: Math.round(elapsed.reduce((sum, value) => sum + value, 0) * 1000) / 1000,
      max: elapsed.length === 0 ? 0 : Math.max(...elapsed),
    },
    captureMarkerPresent: state.captureAskedRows === 1,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source = await assertPinnedCleanCheckout(args.expectedRef);
  const installed = await preflightInstalledSetup(args.installedDataDir, args.installedHome);
  const tempRoot = await mkdtemp(join(tmpdir(), 'tenjin-session-capture-replay-'));
  try {
    const parity = await assertGeneratorParity(tempRoot, installed.cliPath);
    const installedParity = await assertInstalledBundleParity(installed.dataDir, parity);
    if (args.kind === 'parity') {
      const report = {
        schemaVersion: 1,
        lane: 'installed_bundle_parity',
        kind: 'parity',
        status: 'complete',
        sourceCommit: source.commit,
        sourceCommitDate: source.commitDate,
        disposableGeneratorParity: {
          verified: true,
          normalizedBundleSha256: parity.bundleHash,
          scriptCount: parity.files.length,
        },
        installedBundleParity: installedParity,
        installedSetup: installed.metadata,
        installedHooksExecuted: false,
      };
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`wrote installed parity metadata to ${args.out}\n`);
      return;
    }

    const manifest = await readJson<Manifest>('manifest.json');
    const labels = await readJson<Labels>('labels.json');
    const labelByCase = new Map(labels.labels.map((label) => [label.caseId, label]));
    const frozenInputs = await artifactHashes();
    const team = await startMissServer();
    const publicShelf = await startMissServer();
    try {
      const cases: Array<Record<string, unknown>> = [];
      for (const entry of manifest.cases) {
        const label = labelByCase.get(entry.caseId);
        if (label === undefined) throw new Error(`missing label for ${entry.caseId}`);
        cases.push(
          await replayCase(
            tempRoot,
            entry,
            label,
            args.activityPrefix,
            team.origin,
            publicShelf.origin,
            installed,
          ),
        );
      }
      const report = {
        schemaVersion: 1,
        benchmark: manifest.benchmark,
        fixtureRole: 'synthetic_smoke_only',
        evaluatorVersion: labels.evaluatorVersion,
        lane: 'deterministic_replay',
        kind: args.kind,
        status: 'smoke_complete',
        sourceCommit: source.commit,
        sourceCommitDate: source.commitDate,
        manifestCasesSha256: manifest.casesSha256,
        frozenInputs,
        disposableGeneratorParity: {
          verified: true,
          normalizedBundleSha256: parity.bundleHash,
          scriptCount: parity.files.length,
        },
        installedBundleParity: installedParity,
        installedSetup: installed.metadata,
        isolation: {
          embeddedDisposableDataDir: true,
          runtimeDataDirOverrideUsed: false,
          liveHookExecuted: false,
          offMachineRequests: 0,
          loopbackRequests: team.hits() + publicShelf.hits(),
        },
        relativeTimingReplayed: false,
        notMeasuredInDeterministicReplay: [
          'long/resumed relative offsets',
          'elapsed-time windows',
          'generation re-arm behavior',
        ],
        activityStatePrefix: args.activityPrefix,
        cases,
      };
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`wrote ${args.kind} replay for ${cases.length} cases to ${args.out}\n`);
    } finally {
      await stopServer(team.server);
      await stopServer(publicShelf.server);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`session-capture replay: ${message}\n`);
  process.exitCode = 1;
});

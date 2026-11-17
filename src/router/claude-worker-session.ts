import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { codexHome } from '../lib/codex-home';
import {
  CLAUDE_WORKER_READABLE,
  CLAUDE_WORKER_SETTINGS,
  claudePrivatePaths,
  secretHomePaths,
  settingsFileEnv,
} from './model-worker-privacy';

/** Only the owned conversation controller supplies native session identities. */
export type ClaudeWorkerSession = {
  sessionId?: string;
  resume?: string;
  onSession: (id: string) => Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Match native config discovery, including a defined, empty override. */
export function claudeWorkerConfigDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(cwd, (env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC'));
}

export async function prepareClaudeWorkerSession(
  owned: ClaudeWorkerSession | undefined,
  cwd: string,
) {
  if (!owned) return undefined;
  if (owned.sessionId !== undefined && owned.resume !== undefined)
    throw new Error('A Claude worker cannot create and resume a session together');
  const id = owned.resume ?? owned.sessionId ?? randomUUID();
  if (!UUID.test(id)) throw new Error('Invalid owned Claude worker session identity');
  if (typeof owned.onSession !== 'function')
    throw new Error('Owned Claude worker session observer is unavailable');
  const sessionId = id.toLowerCase();
  if (owned.resume !== undefined) {
    // The SDK metadata API resolves config relative to this process; the native
    // child resolves it relative to cwd. Never read a different session store.
    if (claudeWorkerConfigDir(cwd) !== claudeWorkerConfigDir(process.cwd()))
      throw new Error('Relative Claude config does not resolve to the owned session store');
    const info = await getSessionInfo(sessionId, { dir: cwd });
    if (
      !info ||
      info.sessionId.toLowerCase() !== sessionId ||
      typeof info.cwd !== 'string' ||
      (await realpath(info.cwd)) !== (await realpath(cwd))
    )
      throw new Error('Owned Claude worker history is missing or belongs to another workspace');
  }
  return {
    id: sessionId,
    query: owned.resume === undefined ? { sessionId } : { resume: sessionId },
    bind: async (observed: string) => {
      if (observed !== sessionId) throw new Error('Native Claude changed the owned worker session');
      await owned.onSession(sessionId);
    },
    assert: (observed: string) => {
      if (observed !== sessionId) throw new Error('Native Claude changed the owned worker session');
    },
  };
}

/**
 * A job's own temp folder, private to the user and removed by close. Named as the
 * worker's `CLAUDE_CODE_TMPDIR`, it holds Claude Code's temp root for this job, which is
 * the `$TMPDIR` of its commands and the scratchpad it is told of. `shared` is the temp
 * root every other Claude Code session of this user shares.
 */
export async function prepareClaudeWorkerTemp(env: NodeJS.ProcessEnv = process.env) {
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === 'win32') return undefined;
  // Under /tmp, not the macOS per-user temp folder: Claude Code makes sockets under it,
  // and falls back to the shared root when the path is too long for one.
  const directory = await realpath(await mkdtemp('/tmp/tenjin-job-'));
  // Claude Code names its temp root so (2.1.326) and checks that it is private.
  const scratchpad = join(directory, `claude-${uid}`);
  const close = () => rm(directory, { recursive: true, force: true });
  await mkdir(scratchpad, { mode: 0o700 }).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  const shared = await Promise.all(
    [...new Set(['/tmp', env.CLAUDE_CODE_TMPDIR || '/tmp'])].flatMap((base) => [
      join(base, `claude-${uid}`),
      realpath(base).then(
        (real) => join(real, `claude-${uid}`),
        () => join(base, `claude-${uid}`),
      ),
    ]),
  );
  return {
    directory,
    scratchpad,
    shared: [...new Set(shared)],
    close,
  };
}

/** Tool restrictions do not change native SDK transcript/config access. */
export async function claudeWorkerPrivatePaths(
  dataDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  settingsEnv: Record<string, string> = {},
  native: {
    workingDirectories?: readonly string[];
    sources?: readonly { source: string; path?: string }[];
  } = {},
) {
  const home = homedir();
  const sources = (native.sources ?? [])
    .filter((source) => typeof source.path === 'string' && source.path.length > 0)
    .map((source) => ({ source: source.source, path: resolve(cwd, source.path!) }));
  const roots = new Set([
    resolve(cwd),
    ...(native.workingDirectories ?? []).map((root) => resolve(cwd, root)),
    ...sources
      .filter(
        (source) =>
          ['project', 'local'].includes(source.source) &&
          basename(dirname(source.path)) === '.claude',
      )
      .map((source) => dirname(dirname(source.path))),
  ]);
  const paths = [
    resolve(dataDir),
    ...sources.map((source) => source.path),
    ...[...roots].flatMap((root) => [
      join(root, '.claude', 'settings.json'),
      join(root, '.claude', 'settings.local.json'),
      join(root, '.mcp.json'),
    ]),
    ...secretHomePaths(home),
    join(home, '.codex', 'auth.json'),
    ...[env, { ...env, ...settingsEnv }].flatMap((source) => {
      const config = claudeWorkerConfigDir(cwd, source);
      const secure = source.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      return [
        resolve(cwd, codexHome(home, source), 'auth.json'),
        ...claudePrivatePaths(config),
        resolve(
          cwd,
          (secure === undefined ? config : secure || join(home, '.claude')).normalize('NFC'),
          '.credentials.json',
        ),
      ];
    }),
  ];
  // Session transcripts, memory, prompt history and the user's settings files stay
  // readable, as for a native subagent. A settings file opens only when its env block
  // could be read, so its values are known and replaced before anything leaves.
  const configs = [
    ...new Set(
      [env, { ...env, ...settingsEnv }].map((source) => claudeWorkerConfigDir(cwd, source)),
    ),
  ];
  const settings = await Promise.all(
    configs
      .flatMap((config) => CLAUDE_WORKER_SETTINGS.map((name) => join(config, name)))
      .map(async (path) => ({ path, env: await settingsFileEnv(path) })),
  );
  const known = settings.filter((file) => file.env !== undefined);
  const opened = [
    ...configs.flatMap((config) => CLAUDE_WORKER_READABLE.map((name) => join(config, name))),
    ...known.map((file) => file.path),
  ];
  // PROTECTION WINS OVER OPENNESS. The opened names are taken out of the protected set by
  // their own spelling only. One that is a link to, into or over anything protected (a
  // `history.jsonl` linked to the credentials file) stays closed with its target: opening
  // a path by where it resolves would hand the worker the file the link points at.
  const closed = paths.filter((path) => !opened.includes(path));
  const guarded = [
    ...new Set([
      ...closed,
      ...(await Promise.all(closed.map((path) => realpath(path).catch(() => path)))),
    ]),
  ];
  const overlaps = (a: string, b: string) => {
    const within = (root: string, path: string) => {
      const way = relative(root, path);
      return way === '' || (!way.startsWith('..') && !isAbsolute(way));
    };
    return within(a, b) || within(b, a);
  };
  const resolved = await Promise.all(
    opened.map(async (path) => [path, await realpath(path).catch(() => path)] as const),
  );
  const safe = resolved.filter(
    (spellings) => !spellings.some((path) => guarded.some((kept) => overlaps(path, kept))),
  );
  const readable = [...new Set(safe.flat())];
  const refused = resolved.filter((spellings) => !safe.includes(spellings)).flat();
  const protectedPaths = [...new Set([...guarded, ...refused])];
  // Native permission rules use // for an absolute filesystem pattern.
  const rules = (path: string, tools: readonly string[]) => {
    const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
    return tools.flatMap((tool) => [`${tool}(${absolute})`, `${tool}(${absolute}/**)`]);
  };
  const deny = [
    ...protectedPaths.flatMap((path) => rules(path, ['Read', 'Edit', 'Write'])),
    ...readable.flatMap((path) => rules(path, ['Edit', 'Write'])),
  ];
  return {
    paths: protectedPaths,
    deny,
    readable,
    // A settings file that stayed closed is still scanned: Claude Code hands its env block
    // to the worker's commands whether or not the worker can open the file.
    settingsFiles: known.map((file) => file.path),
    settingsEnv: known.map((file) => file.env),
  };
}

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

/** Tool restrictions do not change native SDK transcript/config access. */
export async function claudeWorkerPrivatePaths(dataDir: string, cwd: string) {
  const paths = [resolve(dataDir), join(claudeWorkerConfigDir(cwd), 'projects')];
  const canonical = await Promise.all(paths.map((path) => realpath(path).catch(() => path)));
  const protectedPaths = [...new Set([...paths, ...canonical])];
  const deny = protectedPaths.flatMap((path) => {
    // Native permission rules use // for an absolute filesystem pattern.
    const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
    return ['Read', 'Edit'].flatMap((tool) => [`${tool}(${absolute})`, `${tool}(${absolute}/**)`]);
  });
  return { paths: protectedPaths, deny };
}

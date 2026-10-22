import {
  runAnswerHook,
  runAskHook,
  runDelegationHook,
  runNativeHook,
  runPromptHook,
  runShortfallHook,
  type HookDeps,
} from './hooks';
import type { Io } from '../lib/output';
import { sessionServedByPlugin } from './alive';
import type { HookKind } from './hook-tool';
import { launchedByPlugin } from './names';
import { settleCurrent } from './notice-markers';
import { WALLET_UNLOCKED } from './wallet-reasons';

/**
 * `tenjin hook prompt`, `native`, `shortfall`, `agent`, `ask` and `answer`. The harness writes
 * its event on stdin and reads a JSON object (or nothing) from stdout, so these
 * commands
 * bypass the CLI's envelope entirely. They never fail the turn: a stdin that
 * never arrives, an unreadable event or a handler that throws all exit 0 with
 * an empty stdout, which the harness reads as "no opinion".
 */

const MAX_EVENT_BYTES = 1_000_000;
/** The command form's wait for its event, before the gate's 3.5 s. The harness
 *  writes the event immediately, so this is a liveness check rather than a
 *  budget to spend: every second it holds is a second the gate does not get. */
export const STDIN_TIMEOUT_MS = 1_000;

export type { HookKind };

/**
 * THE FREE PATH, whatever the config says: a command entry runs where no
 * `tenjin mcp` answers (Codex, a hand-written entry), and only that process
 * pays the routing fee, so there is no {@link HookDeps.route} to pass here.
 */
export interface HookCommandDeps extends Omit<HookDeps, 'route'> {
  /** Test seam for the harness event; production reads stdin. */
  readEvent?: () => Promise<string>;
  /** Test seam for this process's environment. */
  env?: NodeJS.ProcessEnv;
}

export async function runHookCommand(kind: HookKind, io: Io, deps: HookCommandDeps): Promise<void> {
  let response: unknown;
  try {
    const raw = await (deps.readEvent ?? readStdin)();
    const event = JSON.parse(raw) as unknown;
    if (deps.harness === 'codex') {
      const { codexResponse } = await import('./codex-event');
      response = codexResponse(await runHookKind(kind, event, deps));
    } else {
      // An entry an older settings install wrote stays silent in a session the
      // plugin serves (see `alive.ts`). SHIM: goes on or after 2026-12-01.
      if (!launchedByPlugin(deps.env) && (await sessionServedByPlugin(deps.dataDir, event))) return;
      response = await runHookKind(kind, event, deps);
    }
  } catch {
    response = null;
  }
  if (response !== null) io.stdout.write(`${JSON.stringify(response)}\n`);
}

/** A session id as the hook schemas take one: a string of 1 to 200 characters. */
function sessionIdOf(event: unknown): string | null {
  if (event === null || typeof event !== 'object') return null;
  const id = (event as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null;
}

/**
 * ONE HOOK EVENT, by kind, to its handler; the harness's answer or null. The
 * command above and the `hook` tool of `tenjin mcp` both run it, so the
 * handlers are the same whichever transport carried the event.
 *
 * THE ROUTER'S WALLET NEWS (B2, decision 14). Inside `tenjin mcp`,
 * {@link HookDeps.walletNews} hands this leg the one-time wallet lines
 * ("Tenjin wallet unlocked.", a still-locked line, a wrong-variable warning),
 * and only for an event carrying a session id: that call is what marks the
 * router as serving a session, and a leg without one (or the command form,
 * which never passes it) must not. The lines ride in `systemMessage` beside the
 * leg's own notices, and are acknowledged only once the response carrying them
 * is built: a leg that throws releases them instead of acking, so the next
 * leg offers them again rather than losing them. A leg running at the same
 * time is never handed lines another leg holds.
 */
export async function runHookKind(
  kind: HookKind,
  event: unknown,
  hookDeps: HookDeps,
): Promise<unknown | null> {
  const notices = new Set<string>();
  const deps: HookDeps = { ...hookDeps, notice: (line) => notices.add(line) };
  const sessionId = sessionIdOf(event);
  const news =
    sessionId !== null && hookDeps.walletNews !== undefined
      ? await hookDeps.walletNews(sessionId).catch(() => null)
      : null;
  for (const line of news?.lines ?? []) notices.add(line);
  let response: unknown | null;
  try {
    if (sessionId !== null && news?.lines.includes(WALLET_UNLOCKED) === true) {
      // Said here already: a paid call later in this session must not say it
      // again, and a relapse must be told again.
      await settleCurrent(hookDeps.dataDir, sessionId, hookDeps.now?.() ?? Date.now()).catch(
        () => undefined,
      );
    }
    const outcome =
      kind === 'prompt'
        ? await runPromptHook(event, deps)
        : kind === 'native'
          ? await runNativeHook(event, deps)
          : kind === 'shortfall'
            ? await runShortfallHook(event, deps)
            : kind === 'ask'
              ? await runAskHook(event, deps)
              : kind === 'answer'
                ? await runAnswerHook(event, deps)
                : await runDelegationHook(event, deps);
    response = withNotices(outcome.response, notices);
  } catch (err) {
    // No answer carries the lines: the next leg is offered them again.
    news?.release();
    throw err;
  }
  if (news !== null) await news.ack().catch(() => undefined);
  return response;
}

/** The handler's answer with this leg's notices in `systemMessage`, which the
 *  harness shows to the user whatever the event; the answer alone when none. */
function withNotices(response: unknown, notices: Set<string>): unknown | null {
  if (notices.size === 0) return response;
  const systemMessage = [...notices].join('\n');
  return response === null || typeof response !== 'object'
    ? { systemMessage }
    : { ...response, systemMessage };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('no harness event')), STDIN_TIMEOUT_MS);
    const done = (value: string): void => {
      clearTimeout(timer);
      resolve(value);
    };
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_EVENT_BYTES) {
        clearTimeout(timer);
        reject(new Error('harness event too large'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once('end', () => done(Buffer.concat(chunks).toString('utf8')));
    process.stdin.once('error', () => {
      clearTimeout(timer);
      reject(new Error('harness event unreadable'));
    });
  });
}

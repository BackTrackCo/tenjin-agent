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
import { readCappedStdin, sessionIdOf } from './harness-event';
import type { HookKind } from './hook-tool';
import { launchedByPlugin } from './names';
import { firstNoticeFor, noticeFor, settleCurrent } from './notice-markers';
import { WALLET_UNLOCKED } from './wallet-reasons';

/**
 * `tenjin hook prompt`, `native`, `shortfall`, `agent`, `ask` and `answer`:
 * THE COMMAND FORM, KEPT AS A STUB. Both plugins route through the `hook`
 * tool of `tenjin mcp` ({@link runHookKind}), the one process that holds the
 * wallet and pays the routing fee every routing call costs. A command entry
 * is a hand-written one, a settings install's or a plugin copy from an older
 * build, which cannot pay, so it routes nothing: it tells the person once per
 * session to ask their agent to set Tenjin up again, in the `systemMessage`
 * the harness shows them (Codex too), and says nothing after that, nor in a
 * Claude Code session the plugin serves. Deleting the commands would leave
 * such a setup failing silently.
 *
 * The harness writes its event on stdin and reads a JSON object (or nothing)
 * from stdout, so these commands bypass the CLI's envelope entirely. They
 * never fail the turn: a stdin that never arrives, an unreadable event or a
 * failure all exit 0 with an empty stdout, which the harness reads as "no
 * opinion".
 */

const MAX_EVENT_BYTES = 1_000_000;
/** The stub's wait for its event: the harness writes it at once, so this is
 *  a liveness check, and the stub calls nothing after it. */
const STDIN_TIMEOUT_MS = 1_000;

export type { HookKind };

/** What a command entry says, once per session. The person is never handed a
 *  command: their agent runs install, which names a Claude Code update first
 *  where the plugin needs one (a settings install below 2.1.287 is kept). */
export const STALE_HOOK_LINE =
  "Tenjin's hooks in this setup are from an older version and no longer route; your usual tools still work. " +
  'Ask your agent to set Tenjin up again, updating Claude Code or Codex first if Tenjin needs a newer one.';

export interface HookCommandDeps extends Pick<HookDeps, 'dataDir' | 'harness' | 'now'> {
  /** Test seam for the harness event; production reads stdin. */
  readEvent?: () => Promise<string>;
  /** Test seam for this process's environment. */
  env?: NodeJS.ProcessEnv;
}

export async function runHookCommand(io: Io, deps: HookCommandDeps): Promise<void> {
  let response: unknown = null;
  try {
    const event = JSON.parse(
      await (deps.readEvent ?? (() => readCappedStdin(MAX_EVENT_BYTES, STDIN_TIMEOUT_MS)))(),
    ) as unknown;
    // An entry an older settings install wrote stays silent in a session the
    // plugin serves (see `alive.ts`). SHIM: goes on or after 2026-12-01.
    if (
      deps.harness !== 'codex' &&
      !launchedByPlugin(deps.env) &&
      (await sessionServedByPlugin(deps.dataDir, event))
    ) {
      return;
    }
    const sessionId = sessionIdOf(event);
    if (sessionId === null) return;
    // The session's once-per-session marker under `router/notices/`, which
    // builds up to alpha.31 also wrote for their unpaid-fee notice: a session
    // one of those told already hears nothing more. It leaves the reason told
    // last (`noticeFor`'s `.current`) to the wallet notices that read it.
    if (await firstNoticeFor(deps.dataDir, sessionId, deps.now?.() ?? Date.now())) {
      response = { systemMessage: STALE_HOOK_LINE };
    }
  } catch {
    response = null;
  }
  if (response !== null) io.stdout.write(`${JSON.stringify(response)}\n`);
}

/**
 * ONE HOOK EVENT, by kind, to its handler; the harness's answer or null. The
 * `hook` tool of `tenjin mcp` runs it for each routing leg.
 *
 * THE ROUTER'S WALLET NEWS (B2, decision 14). Inside `tenjin mcp`,
 * {@link HookDeps.walletNews} hands this leg the one-time wallet lines
 * ("Tenjin wallet unlocked.", a still-locked line, a wrong-variable warning),
 * and only for an event carrying a session id: that call is what marks the
 * router as serving a session, and a leg without one must not. The lines ride in `systemMessage` beside the
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
    if (sessionId !== null && news?.told !== undefined) {
      // The still-locked line is this session's notice for that reason: the
      // fee notice on this leg (or a later one) must not repeat it.
      await noticeFor(hookDeps.dataDir, sessionId, news.told, hookDeps.now?.() ?? Date.now()).catch(
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

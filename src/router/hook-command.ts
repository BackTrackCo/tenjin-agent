import { runDelegationHook, runNativeHook, runPromptHook, type HookDeps } from './hooks';
import type { Io } from '../lib/output';

/**
 * `tenjin hook prompt`, `tenjin hook native` and `tenjin hook agent`. The harness
 * writes its event on stdin and reads a JSON object (or nothing) from stdout, so
 * these commands
 * bypass the CLI's envelope entirely. They never fail the turn: a stdin that
 * never arrives, an unreadable event or a handler that throws all exit 0 with
 * an empty stdout, which the harness reads as "no opinion".
 */

const MAX_EVENT_BYTES = 1_000_000;
/** One fifth of the hook's 5 s budget, leaving the gate its 3.5 s; `wire.test.ts`
 *  pins the sum against the timeout `install` writes. The harness writes its
 *  event immediately, so this wait is a liveness check rather than a budget to
 *  spend: every second it holds is a second the gate does not get. */
export const STDIN_TIMEOUT_MS = 1_000;

export type HookKind = 'prompt' | 'native' | 'agent';

export interface HookCommandDeps extends HookDeps {
  /** Test seam for the harness event; production reads stdin. */
  readEvent?: () => Promise<string>;
}

export async function runHookCommand(kind: HookKind, io: Io, deps: HookCommandDeps): Promise<void> {
  let response: unknown;
  try {
    const raw = await (deps.readEvent ?? readStdin)();
    const event: unknown = JSON.parse(raw);
    const outcome =
      kind === 'prompt'
        ? await runPromptHook(event, deps)
        : kind === 'native'
          ? await runNativeHook(event, deps)
          : await runDelegationHook(event, deps);
    response = outcome.response;
  } catch {
    response = null;
  }
  if (response !== null) io.stdout.write(`${JSON.stringify(response)}\n`);
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

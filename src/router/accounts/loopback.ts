import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError } from '../../lib/errors';

/**
 * THE SIGN-IN REDIRECT, CAUGHT ON THIS MACHINE (decided37 #1). `tenjin
 * connect` serves it itself: one listener on 127.0.0.1, one `GET /callback`
 * whose `state` is the one this sign-in sent, then it closes. The page it
 * answers with is fixed text that echoes nothing the browser sent, and a
 * request with another path, method or state changes nothing.
 *
 * The listener is unref'd, so it never keeps a process alive by itself; the
 * wait's own timer does, until the redirect comes or the time is up.
 *
 * The port is any free one, unless the authorization server checks redirect
 * addresses exactly against Tenjin's published client document: then it is
 * the first free one of {@link REDIRECT_PORTS}, the ports that document lists.
 */

/** The fixed ports Tenjin's client metadata document lists, in order. They
 *  stay clear of the ports Tenjin's own tooling uses (3000, 3917, 5433). */
export const REDIRECT_PORTS: readonly number[] = [47613, 47614, 47615];

const CALLBACK_PATH = '/callback';

const PAGE = (title: string, line: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>${title}</h1><p>${line}</p></body></html>`;

const DONE = PAGE('Signed in', 'Tenjin has the sign-in. You can close this tab.');
const DECLINED = PAGE('Not signed in', 'Nothing was connected. You can close this tab.');
const STALE = PAGE('Not this sign-in', 'This link is not from the sign-in Tenjin is waiting for.');

/** What came back to the redirect address. */
export type RedirectResult = { code: string } | { error: string };

export interface Redirect {
  /** `http://127.0.0.1:<port>/callback`. */
  redirectUrl: string;
  /** The one redirect carrying this sign-in's `state`, or a timeout. One that
   *  came before the wait began is kept for it. */
  wait(): Promise<RedirectResult>;
  close(): void;
}

export interface RedirectOptions {
  /** This sign-in's `state`: a redirect carrying any other is never taken. */
  state: string;
  /** How long to wait for the redirect. */
  timeoutMs: number;
  /** Fixed ports to try in order; absent is any free port. */
  ports?: readonly number[];
}

async function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null);
      else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Open the redirect listener. Every fixed port taken refuses: a sign-in whose
 * redirect the authorization server would reject is not worth starting.
 */
export async function openRedirect(opts: RedirectOptions): Promise<Redirect> {
  let deliver: ((result: RedirectResult) => void) | undefined;
  const expected = opts.state;
  const early: RedirectResult[] = [];

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const answer = (status: number, body: string) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end(body);
    };
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return answer(404, STALE);
    const state = url.searchParams.get('state');
    if (expected.length === 0 || state !== expected || early.length > 0) return answer(400, STALE);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const result: RedirectResult =
      code !== null && code.length > 0 && error === null
        ? { code }
        : { error: error !== null && /^[a-z_]{1,64}$/.test(error) ? error : 'invalid_request' };
    answer(200, 'code' in result ? DONE : DECLINED);
    if (deliver !== undefined) deliver(result);
    else early.push(result);
  };

  const server = createServer(handle);
  server.unref();
  let port: number | null = null;
  for (const candidate of opts.ports ?? [0]) {
    port = await listen(server, candidate);
    if (port !== null) break;
  }
  if (port === null) {
    server.close();
    throw new CliError(
      'REFUSED',
      'Another sign-in is already waiting on this machine, so this one could not start. Nothing was saved.',
      { fix: 'Finish or cancel the other `tenjin connect`, then run this one again.' },
    );
  }
  const close = () => {
    server.close();
    server.closeAllConnections?.();
  };
  return {
    redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    close,
    wait() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          deliver = undefined;
          close();
          reject(
            new CliError('REFUSED', 'The sign-in was not finished in time. Nothing was saved.', {
              fix: 'Run the command again and approve in the browser, or use `--paste` with a key.',
            }),
          );
        }, opts.timeoutMs);
        deliver = (result) => {
          clearTimeout(timer);
          deliver = undefined;
          close();
          resolve(result);
        };
        const first = early.shift();
        if (first !== undefined) deliver(first);
      });
    },
  };
}

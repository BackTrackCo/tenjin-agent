/**
 * THE STREAMED MESSAGES REPLY, the client's side of the router's contract.
 *
 * A router whose offer carries `messagesStream: 1` takes `stream: true` beside `messages`
 * in the Messages body. Its answer to the paid request is then, from the first provider
 * event, `text/event-stream` with `tenjin-model-stream: 1`: the provider's Messages events
 * in order, a `: keep` comment after 15 s of quiet, and one last event that is the whole
 * answer's response (`tenjin_result` for a 200, `tenjin_error` otherwise) with data
 * `{status, headers, body}`. A request that ends before the first event answers as without
 * `stream` (the 402 quote, a refusal, an error). A stream that ends with no last event is a
 * lost stream.
 *
 * This reads such a stream, hands each provider event on as it arrives, and returns the last
 * event as the Response the whole answer would have been, so the payer, the receipt and the
 * settlement see exactly what they see for a whole answer. Nothing here moves money.
 */

/** The version of the stream a router offers (`messagesStream`) and this client speaks. */
export const MESSAGES_STREAM_VERSION = 1;
/** Beyond the router's own idle limit, so the router's cut arrives before the client's. The
 *  router sends a `: keep` comment every 15 s, so a live stream never nears it. */
export const STREAM_IDLE_MARGIN_MS = 30_000;
/** The router's idle limit when its offer states none. */
export const STREAM_IDLE_DEFAULT_MS = 300_000;
/** The most event bytes one reply may carry: the router's own bound. */
export const STREAM_EVENT_BYTES = 64 * 1024 * 1024;

/** Whether this offer advertises the stream this client speaks. Anything else is closed. */
export function messagesStreamOffered(decision: Record<string, unknown>): boolean {
  return decision.messagesStream === MESSAGES_STREAM_VERSION;
}

/** How long the client waits for the next received bytes of a stream. */
export function streamIdleMs(decision: Record<string, unknown>): number {
  const offered = decision.callIdleLimitMs;
  const limit =
    typeof offered === 'number' && Number.isSafeInteger(offered) && offered > 0
      ? offered
      : STREAM_IDLE_DEFAULT_MS;
  return limit + STREAM_IDLE_MARGIN_MS;
}

export type StreamEvent = { type: string } & Record<string, unknown>;

/** A stream that ended without its last event, or broke the contract. Events may have left. */
export class StreamCut extends Error {
  constructor(
    readonly reason: 'lost' | 'idle' | 'protocol' | 'too_large',
    options?: ErrorOptions,
  ) {
    super(`The model stream ended early (${reason})`, options);
    this.name = 'StreamCut';
  }
}

/** The bytes of the text a delta event carries: what the completed message will hold. */
export function deltaBytes(event: StreamEvent): number {
  const delta = event.delta;
  if (typeof delta !== 'object' || delta === null) return 0;
  const { text, thinking, partial_json: json } = delta as Record<string, unknown>;
  let bytes = 0;
  for (const part of [text, thinking, json])
    if (typeof part === 'string') bytes += Buffer.byteLength(part);
  return bytes;
}

/** One SSE frame as the child's SDK reads it. */
export function sseFrame(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The error event that ends a streamed turn the child cannot be given the rest of. */
export function sseError(message: string): string {
  return sseFrame({ type: 'error', error: { type: 'api_error', message } } as StreamEvent);
}

/** A frame as its event name and its data lines joined; comments and empty frames are null. */
function parseFrame(frame: string): { name: string; data: string } | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { name, data: data.join('\n') };
}

/** The response a `tenjin_result` or `tenjin_error` event stands for. */
function terminalResponse(data: string): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new StreamCut('protocol', { cause });
  }
  const last = parsed as { status?: unknown; headers?: unknown; body?: unknown };
  if (
    typeof last !== 'object' ||
    last === null ||
    typeof last.status !== 'number' ||
    !Number.isInteger(last.status) ||
    last.status < 200 ||
    last.status > 599
  )
    throw new StreamCut('protocol');
  const headers = new Headers();
  if (typeof last.headers === 'object' && last.headers !== null)
    for (const [name, value] of Object.entries(last.headers))
      if (typeof value === 'string') headers.set(name, value);
  const json = typeof last.body !== 'string';
  headers.set('content-type', json ? 'application/json' : 'text/plain');
  const nullBody = last.status === 204 || last.status === 205 || last.status === 304;
  return new Response(
    nullBody ? null : json ? JSON.stringify(last.body ?? null) : (last.body as string),
    { status: last.status, headers },
  );
}

export interface StreamReadOptions {
  signal: AbortSignal;
  idleMs: number;
  /** The most bytes the last event may carry (the whole answer's envelope). */
  terminalBytes: number;
  /** The most text the events may carry: the result size this client reads. */
  contentBytes: number;
  /** Called once per provider event, in order, as it arrives. */
  onEvent: (event: StreamEvent) => void;
}

/**
 * Reads the stream to its last event. Returns that event as the whole answer's response.
 * Throws `StreamCut` when the stream ends or breaks without one, and the signal's own
 * reason when it is aborted. Events handed on before a throw have left for good.
 */
export async function readMessagesStream(
  response: Response,
  o: StreamReadOptions,
): Promise<Response> {
  if (!response.body) throw new StreamCut('lost');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let idled = false;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idled = true;
      void reader.cancel().catch(() => undefined);
    }, o.idleMs);
  };
  const leave = () => void reader.cancel(o.signal.reason).catch(() => undefined);
  o.signal.addEventListener('abort', leave, { once: true });
  let buffer = '';
  // A chunk may end between a CR and its LF: the CR waits for the next chunk, so it
  // never reads as a line end of its own and makes a false blank line with that LF.
  let heldCr = '';
  let eventBytes = 0;
  let contentBytes = 0;
  try {
    arm();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (o.signal.aborted) throw cause;
        throw new StreamCut(idled ? 'idle' : 'lost', { cause });
      }
      if (o.signal.aborted) throw o.signal.reason;
      if (idled) throw new StreamCut('idle');
      if (chunk.done) throw new StreamCut('lost');
      arm();
      eventBytes += chunk.value.byteLength;
      if (eventBytes > STREAM_EVENT_BYTES) throw new StreamCut('too_large');
      let text = heldCr + decoder.decode(chunk.value, { stream: true });
      heldCr = text.endsWith('\r') ? '\r' : '';
      if (heldCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      // A frame ends at a blank line.
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const frame = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (!frame) continue;
        if (frame.name === 'tenjin_result' || frame.name === 'tenjin_error') {
          if (Buffer.byteLength(frame.data) > o.terminalBytes) throw new StreamCut('too_large');
          return terminalResponse(frame.data);
        }
        let event: unknown;
        try {
          event = JSON.parse(frame.data);
        } catch (cause) {
          throw new StreamCut('protocol', { cause });
        }
        if (
          typeof event !== 'object' ||
          event === null ||
          (event as { type?: unknown }).type !== frame.name
        )
          throw new StreamCut('protocol');
        contentBytes += deltaBytes(event as StreamEvent);
        if (contentBytes > o.contentBytes) throw new StreamCut('too_large');
        o.onEvent(event as StreamEvent);
      }
      if (buffer.length > o.terminalBytes + 1024) throw new StreamCut('too_large');
    }
  } finally {
    clearTimeout(idle);
    o.signal.removeEventListener('abort', leave);
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * A streamed call that failed after events had reached the child, with the router's proof
 * that nothing was charged. The turn ends with an error event and the job goes on: the
 * child's own handling of an API error applies, and what it sends next is a new call.
 */
export class RelayedCut extends Error {
  constructor(options?: ErrorOptions) {
    super('A streamed model call was cut after its events reached the worker', options);
    this.name = 'RelayedCut';
  }
}

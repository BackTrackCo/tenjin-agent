import { describe, expect, it, vi } from 'vitest';
import {
  createJevClient,
  hasJevKey,
  JEV_ENDPOINT,
  JEV_MODEL,
  type ChoiceQuestion,
  type NoulQuestion,
} from './agent-jev';

const KEY = 'ts-key-FIXTURE-7f3a9c1e5b';
const env = { TYPESAFE_API_KEY: KEY };

const questions = {
  tier: {
    type: 'choice',
    instructions: 'pick one',
    criteria: { keep: 'as asked', sonnet: 'the middle tier' },
  } satisfies ChoiceQuestion,
  edits: { type: 'noul', instructions: 'does it edit?' } satisfies NoulQuestion,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return createJevClient({ env, fetchImpl: fetchImpl as typeof fetch })!;
}

describe('the agent decider Jev client', () => {
  it('sends the pinned model to the pinned endpoint, the key in the Authorization header only', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      json({
        answers: { tier: { choice: 'sonnet', confidence: 0.8 }, edits: { noul: 0.1 } },
        usage: { inputTokens: 1900 },
      }),
    );
    const call = await clientWith(fetchImpl).ask({ brief: 'x' }, questions);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(JSON.parse(init.body as string).model).toBe(JEV_MODEL);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);
    expect(init.redirect).toBe('error');
    expect(call).toMatchObject({
      answers: { tier: { choice: 'sonnet', confidence: 0.8 }, edits: { noul: 0.1 } },
      shape: 'confidence',
      inputTokens: 1900,
    });
    expect(call.weak).toBeUndefined();
  });

  it('reads per-option probabilities, offered labels only, and picks their top without a choice', async () => {
    const call = await clientWith(async () =>
      json({
        answers: {
          tier: { probabilities: { keep: 0.2, sonnet: 0.7, injected: 0.9 } },
          edits: { noul: 0.4 },
        },
      }),
    ).ask({}, questions);
    expect(call.shape).toBe('probabilities');
    expect(call.answers?.tier).toEqual({
      choice: 'sonnet',
      probabilities: { keep: 0.2, sonnet: 0.7 },
    });
  });

  it('drops probabilities whole when an offered one is not a probability', async () => {
    const call = await clientWith(async () =>
      json({
        answers: {
          tier: { choice: 'keep', confidence: 0.9, probabilities: { keep: 'high', sonnet: 0.1 } },
          edits: { noul: 0 },
        },
      }),
    ).ask({}, questions);
    expect(call.shape).toBe('confidence');
    expect(call.answers?.tier).toEqual({ choice: 'keep', confidence: 0.9 });
  });

  it.each([
    ['an unoffered choice', { tier: { choice: 'opus' }, edits: { noul: 0.1 } }],
    ['a missing yes/no probability', { tier: { choice: 'keep' } }],
    ['a yes/no probability out of range', { tier: { choice: 'keep' }, edits: { noul: 1.5 } }],
    ['no answers at all', null],
  ])('goes weak on %s', async (_label, answers) => {
    const call = await clientWith(async () => json({ answers })).ask({}, questions);
    expect(call).toMatchObject({ answers: null, weak: 'invalid_response' });
  });

  it('goes weak on a body that does not parse', async () => {
    const call = await clientWith(async () => new Response('not json')).ask({}, questions);
    expect(call.weak).toBe('invalid_response');
  });

  it('goes weak on a response over its size cap', async () => {
    const big = json({ answers: {}, padding: 'x'.repeat(70 * 1024) });
    const call = await clientWith(async () => big).ask({}, questions);
    expect(call.weak).toBe('invalid_response');
  });

  it('goes weak with the status on a non-2xx response', async () => {
    const call = await clientWith(async () => json({ error: 'busy' }, 503)).ask({}, questions);
    expect(call).toMatchObject({ answers: null, weak: 'provider_error', status: 503 });
  });

  it('goes weak on a timeout, and makes one attempt only', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });
    const call = await clientWith(fetchImpl).ask({}, questions);
    expect(call.weak).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops an in-flight call when the caller aborts', async () => {
    const controller = new AbortController();
    const client = createJevClient({
      env,
      signal: controller.signal,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as typeof fetch,
    })!;
    const asked = client.ask({}, questions);
    controller.abort();
    expect((await asked).weak).toBe('timeout');
  });

  it('refuses a request over its size cap without sending it', async () => {
    const fetchImpl = vi.fn();
    const call = await clientWith(fetchImpl).ask({ brief: 'x'.repeat(70 * 1024) }, questions);
    expect(call.weak).toBe('request_too_large');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the key in what it returns, even when the error carries it', async () => {
    const failures = [
      async () => {
        throw new Error(`connect failed for Bearer ${KEY}`);
      },
      async () => json({ echoed: KEY }, 401),
      async () => json({ answers: { tier: { choice: KEY }, edits: { noul: 0 } } }),
      async () => new Response(`<html>${KEY}</html>`),
    ];
    for (const failure of failures) {
      const call = await clientWith(failure).ask({}, questions);
      expect(call.answers).toBeNull();
      expect(JSON.stringify(call)).not.toContain(KEY);
    }
  });
});

describe('where the key is read from', () => {
  it('is TYPESAFE_API_KEY first, then the local file name TYPESAFE_KEY, and nothing otherwise', () => {
    expect(createJevClient({ env: {} })).toBeNull();
    expect(createJevClient({ env: { TYPESAFE_API_KEY: '  ' } })).toBeNull();
    expect(hasJevKey({ TYPESAFE_KEY: KEY })).toBe(true);
    expect(hasJevKey({})).toBe(false);
  });

  it('sends the API_KEY name when both are set', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => json({}, 500));
    await createJevClient({
      env: { TYPESAFE_API_KEY: 'first', TYPESAFE_KEY: 'second' },
      fetchImpl: fetchImpl as typeof fetch,
    })!.ask({}, questions);
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer first');
  });
});

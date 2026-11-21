import { expect, it } from 'vitest';
import { withChannelTurn } from './model-channel-turn';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const live = new AbortController().signal;

it('runs the calls of one channel one at a time, in the order they asked', async () => {
  const log: string[] = [];
  const first = deferred();
  const call = (name: string, wait?: Promise<void>) =>
    withChannelTurn('run-a', live, async () => {
      log.push(`${name} start`);
      await wait;
      log.push(`${name} end`);
    });
  const a = call('a', first.promise);
  const b = call('b');
  const c = call('c');
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The second call has not started while the first holds the channel.
  expect(log).toEqual(['a start']);
  first.resolve();
  await Promise.all([a, b, c]);
  expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

it('lets two channels run together', async () => {
  const hold = deferred();
  const started: string[] = [];
  const a = withChannelTurn('run-1', live, async () => {
    started.push('1');
    await hold.promise;
  });
  const b = withChannelTurn('run-2', live, async () => {
    started.push('2');
  });
  await b;
  expect(started).toEqual(['1', '2']);
  hold.resolve();
  await a;
});

it('a call aborted while it waits leaves the queue, and the calls behind it keep their order', async () => {
  const first = deferred();
  const log: string[] = [];
  const a = withChannelTurn('run-b', live, async () => {
    await first.promise;
    log.push('a');
  });
  const abort = new AbortController();
  const b = withChannelTurn('run-b', abort.signal, async () => {
    log.push('b');
  });
  const c = withChannelTurn('run-b', live, async () => {
    log.push('c');
  });
  abort.abort();
  await expect(b).rejects.toMatchObject({ name: 'AbortError' });
  // The third call still waits for the first.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(log).toEqual([]);
  first.resolve();
  await Promise.all([a, c]);
  expect(log).toEqual(['a', 'c']);
});

it('frees the channel when a call throws', async () => {
  await expect(
    withChannelTurn('run-c', live, async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  await expect(withChannelTurn('run-c', live, async () => 'next')).resolves.toBe('next');
});

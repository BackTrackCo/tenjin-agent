import { expect, it } from 'vitest';
import { ModelLifecycle } from './model-lifecycle';

it('interrupts a selection before its worker controller exists, drains it and fences late replays', async () => {
  const lifecycle = new ModelLifecycle();
  const session = { sessionId: 'root', turnId: 'turn', cwd: '/repo', transcript: '/owned' };
  let selecting!: () => void, release!: () => void;
  const selected = new Promise<void>((resolve) => {
    selecting = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let workers = 0;
  const work = lifecycle.run(session, undefined, async (signal) => {
    selecting();
    await held;
    signal.throwIfAborted();
    workers++;
  });
  const failed = expect(work).rejects.toThrow();
  await selected;
  const drained = lifecycle.fence(session);
  release();
  await drained;
  await failed;
  expect(workers).toBe(0);
  await expect(
    lifecycle.run(session, undefined, async () => {
      workers++;
    }),
  ).rejects.toThrow('interrupted');
  await lifecycle.run({ ...session, turnId: 'next' }, undefined, async () => {
    workers++;
  });
  expect(workers).toBe(1);
  await lifecycle.stop();
});

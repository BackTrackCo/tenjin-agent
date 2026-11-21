import { expect, it } from 'vitest';
import { WorkerInbox } from './model-worker-inbox';

// Failure caught: messages written to a running worker arriving out of order, or being
// accepted after the worker had reported and then lost.
it('hands messages on in order, whether a reader waits or not', async () => {
  const inbox = new WorkerInbox();
  const waiting = inbox.next();
  expect(inbox.push('one')).toBe('delivered');
  expect(inbox.push('two')).toBe('delivered');
  expect(inbox.push('three')).toBe('delivered');
  expect(await waiting).toBe('one');
  expect([await inbox.next(), await inbox.next()]).toEqual(['two', 'three']);
});

it('stays open while a message is queued and closes only when empty', async () => {
  const inbox = new WorkerInbox();
  inbox.push('late');
  expect(inbox.closeIfEmpty()).toBe(false);
  expect(await inbox.next()).toBe('late');
  expect(inbox.closeIfEmpty()).toBe(true);
  expect(inbox.push('after')).toBe('closed');
  expect(await inbox.next()).toBeNull();
});

it('ends a waiting reader when it closes, and returns what it never sent', async () => {
  const inbox = new WorkerInbox();
  const waiting = inbox.next();
  inbox.close();
  expect(await waiting).toBeNull();
  const other = new WorkerInbox();
  other.push('x');
  expect(other.close()).toEqual(['x']);
});

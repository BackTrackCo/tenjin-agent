import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ownedModelReference } from './model-continuation';

it('recognizes only continuation addresses and preserves the complete follow-up', () => {
  const handle = 'tenjin-worker-' + randomUUID();
  const task = 'Continue.\nKeep this literal command: pnpm check\nReturn JSON.';
  expect(ownedModelReference({ to: [handle], message: task }, 'SendMessage')).toEqual({
    owned: true,
    handle,
    task,
  });
  expect(ownedModelReference({ resume: handle, prompt: task }, 'Agent')).toEqual({
    owned: true,
    handle,
    task,
  });
  expect(ownedModelReference({ prompt: `Read ${handle}` }, 'Agent')).toEqual({ owned: false });
  expect(ownedModelReference({ to: 'native-id', message: handle }, 'SendMessage')).toEqual({
    owned: false,
  });
});

it('reserves malformed, ambiguous and unstarted handles instead of falling through to native', () => {
  const handle = 'tenjin-worker-' + randomUUID();
  for (const input of [
    { to: [handle, 'native'], message: 'Continue' },
    { to: handle.toUpperCase(), message: 'Continue' },
    { to: ' ' + handle, message: 'Continue' },
    { to: handle, recipient: handle, message: 'Continue' },
    { to: handle, message: 'Continue', content: 'Different' },
    { to: 'tenjin-worker-bad', message: 'Continue' },
    { to: 'tenjin-offer-' + randomUUID(), message: 'Continue' },
  ])
    expect(ownedModelReference(input, 'SendMessage')).toMatchObject({
      owned: true,
      error: expect.any(String),
    });
});

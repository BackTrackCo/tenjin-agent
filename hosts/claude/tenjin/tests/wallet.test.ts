import { expect, test } from 'claude-code/testing';

import { MODEL_TEXT, machine, shownLines, wallet } from './fixtures';

const TOAST = 'Tenjin wallet created · 0x5c6e…B7ff · unfunded · tenjin wallet fund';
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' } as const;

/** The engine's own hint line: the line, then the tail a hook added. */
function engineHint(on: Parameters<typeof machine>[0]): void {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`${e.props.hint}${e.props.tail ? ` ${e.props.tail}` : ''}`] });
  });
}

test('the first session after the install made the wallet shows one toast', async ($, on) => {
  const { files, toasts } = machine(on);
  wallet(files, { created: true });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(toasts).toEqual([TOAST]);
  expect(TOAST).not.toMatch(MODEL_TEXT);
  // A reload raises session.start again in the same session: no second toast.
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(toasts).toEqual([TOAST]);
});

test('on the terminal it does not come back in a later session', async ($, on) => {
  const { files, toasts } = machine(on, {
    'welcomed:0x5c6ea1b2c3d4e5f60718293a4b5c6d7e8f90b7ff': true,
  });
  wallet(files, { created: true });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  expect(toasts).toEqual([]);
});

test('on the desktop it repeats once per session while the wallet is unfunded', async ($, on) => {
  const { files, toasts } = machine(on, {
    'welcomed:0x5c6ea1b2c3d4e5f60718293a4b5c6d7e8f90b7ff': true,
  });
  wallet(files, { created: true, balanceAtomic: '0' });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  expect(toasts).toEqual([TOAST]);
});

test('no toast for a funded wallet, or one this install did not make', async ($, on) => {
  const { files, toasts } = machine(on);
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  wallet(files, { created: true, balanceAtomic: '3200000', maxAutoSpend: '250000' });
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  files.delete('/home/test/.tenjin/wallet-created.json');
  files.delete('/home/test/.tenjin/balance.json');
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true });
  expect(toasts).toEqual([]);
});

test('the prompt hint carries the unfunded wallet, and drops it once funded', async ($, on) => {
  const { files } = machine(on);
  engineHint(on);
  wallet(files, { created: true });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'PromptHint',
      props: HINT,
    });
    expect(await shownLines(ui)).toEqual([
      '? for shortcuts · Tenjin wallet unfunded, run tenjin wallet fund',
    ]);
    await ui.unmount();
  }
  wallet(files, { created: true, balanceAtomic: '3200000', maxAutoSpend: '250000' });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'PromptHint',
      props: HINT,
    });
    expect(await shownLines(ui)).toEqual(['? for shortcuts']);
    await ui.unmount();
  }
});

test('the hint says so when the balance cannot cover the per-call cap', async ($, on) => {
  const { files } = machine(on);
  engineHint(on);
  wallet(files, { balanceAtomic: '20000', maxAutoSpend: '250000' });
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'PromptHint',
    props: HINT,
  });
  expect(await shownLines(ui)).toEqual([
    '? for shortcuts · Tenjin wallet unfunded, run tenjin wallet fund',
  ]);
  await ui.unmount();
});

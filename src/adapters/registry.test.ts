import { describe, it, expect } from 'vitest';
import { ADAPTERS, adapterFor } from './registry';
import { HARNESSES } from './types';

/**
 * `HARNESSES` is a hand-maintained list of the `Harness` union, and three
 * things read it: the `--harness` vocabulary, the installer's `LOOP_URL_RE`
 * ownership predicate and the persisted install-harness config enum. A union
 * member with no `ADAPTERS` entry is already a compile error; a member missing
 * from the list is not, so it is asserted here.
 *
 * The id check is the other half. The installer writes the registered URL from
 * `adapter.id` (`harness-hooks.ts` `writeHooks`) while the daemon resolves an
 * incoming `/hook/:harness` by the `ADAPTERS` record KEY, so a copy-paste
 * adapter whose id disagrees with its slot registers a URL that 404s on every
 * fire — and an id outside `HARNESSES` also stops `LOOP_URL_RE` recognizing
 * our own entry on re-install and uninstall.
 */
describe('ADAPTERS / adapterFor', () => {
  it('registers exactly the harnesses HARNESSES lists', () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...HARNESSES].sort());
  });

  it('gives every adapter the id of the slot it sits in', () => {
    for (const [key, adapter] of Object.entries(ADAPTERS)) {
      expect(adapter.id).toBe(key);
    }
  });

  it('resolves every harness, and nothing else', () => {
    for (const harness of HARNESSES) {
      expect(adapterFor(harness)).toBeDefined();
    }
    expect(adapterFor('hermes')).toBeUndefined();
    // Object.hasOwn, not `in`: an inherited key is not a harness.
    expect(adapterFor('toString')).toBeUndefined();
  });
});

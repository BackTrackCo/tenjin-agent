import { mkdtemp, opendir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPEC_TTL_MS } from './specs';
import { claimIgnored, markTaken, noteShown, offerScope } from './untaken';

/**
 * An offer the host was shown is reported `ignored` once, and only when it
 * was: its 15 minutes ran out with no `request` naming it, or the agent it was
 * shown to made a native call while it was untaken.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-untaken-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const T0 = 1_800_000_000_000;
const main = offerScope('sess-1', undefined);
const shown = (id: string, over: { ids?: string[]; scope?: string } = {}) =>
  noteShown(dir, { id, ids: over.ids ?? [id], harness: 'claude', scope: main, ...over }, T0);

describe('untaken offers', () => {
  it('reports an offer past its 15 minutes once, as expired', async () => {
    await shown('offer-aaaa');
    expect(await claimIgnored(dir, { now: T0 + SPEC_TTL_MS })).toEqual([]);
    expect(await claimIgnored(dir, { now: T0 + SPEC_TTL_MS + 1 })).toEqual([
      { id: 'offer-aaaa', harness: 'claude', reason: 'expired' },
    ]);
    expect(await claimIgnored(dir, { now: T0 + SPEC_TTL_MS + 2 })).toEqual([]);
  });

  it('never reports an offer a request took, by its own id or any id its line named', async () => {
    await shown('offer-aaaa');
    await shown('offer-bbbb', { ids: ['offer-bbbb', 'spec-cccc'] });
    await markTaken(dir, 'offer-aaaa');
    await markTaken(dir, 'spec-cccc');
    expect(await claimIgnored(dir, { now: T0 + SPEC_TTL_MS + 1, nativeScope: main })).toEqual([]);
  });

  it('takes an offer however many files a listing reaches before it', async () => {
    for (let n = 0; n < 300; n += 1) {
      const id = `offer-${String(n).padStart(4, '0')}`;
      await shown(id, { ids: [id, `spec-${id}`] });
    }
    // The last file a listing reaches, past the 256 a claim reads, taken by a
    // spec id, which names no file.
    const untaken = join(dir, 'progress', 'untaken');
    const names: string[] = [];
    for await (const item of await opendir(untaken)) names.push(item.name);
    const last = JSON.parse(await readFile(join(untaken, names.at(-1)!), 'utf8')) as {
      ids: string[];
    };
    await markTaken(dir, last.ids[1]!);
    const left = await readdir(untaken);
    expect(left).toHaveLength(299);
    expect(left).not.toContain(names.at(-1));
  });

  it('reports a native call by the same agent in the same session, and no one else', async () => {
    await shown('offer-main');
    await shown('offer-sub1', { scope: offerScope('sess-1', 'agent-1') });
    await shown('offer-othr', { scope: offerScope('sess-2', undefined) });
    // A delegated task's offer only its subagent could take: it can only expire.
    await noteShown(dir, { id: 'offer-dele', ids: ['offer-dele'], harness: 'claude' }, T0);
    expect(await claimIgnored(dir, { now: T0 + 1, nativeScope: main })).toEqual([
      { id: 'offer-main', harness: 'claude', reason: 'native_after_offer' },
    ]);
    expect(await claimIgnored(dir, { now: T0 + 2, nativeScope: main })).toEqual([]);
    expect(
      (await claimIgnored(dir, { now: T0 + SPEC_TTL_MS + 1 })).map((o) => o.id).sort(),
    ).toEqual(['offer-dele', 'offer-othr', 'offer-sub1']);
  });

  it('never claims an offer shown after the native call began', async () => {
    await shown('offer-aaaa');
    expect(await claimIgnored(dir, { now: T0 - 1, nativeScope: main })).toEqual([]);
  });

  it('removes a file that is not a whole entry, and reports nothing for it', async () => {
    await shown('offer-aaaa');
    const [name] = await readdir(join(dir, 'progress', 'untaken'));
    await writeFile(join(dir, 'progress', 'untaken', name!), '{"version":1');
    expect(await claimIgnored(dir, { now: T0 + SPEC_TTL_MS + 1 })).toEqual([]);
    expect(await readdir(join(dir, 'progress', 'untaken'))).toEqual([]);
  });
});

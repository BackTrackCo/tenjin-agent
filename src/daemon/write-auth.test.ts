import { describe, expect, it } from 'vitest';
import type { WriteAuth } from '../lib/session-key';
import { createWriteAuthCache } from './write-auth';

/**
 * THE DAEMON'S CREDENTIAL GOES STALE IN TWO WAYS, and neither one is visible to
 * a `config` reload on its own: `createSessionKeyAuth` closes over the base URL
 * it was handed, so the origin is inside the delegation and no later read of
 * config.json reaches it. A daemon that lives for hours across a `baseUrl`
 * change would otherwise sign every hook search for the origin it started on
 * and be answered 401 until it exits.
 *
 * `mint` here counts its calls and records the base URL each one was asked for,
 * because "did it re-mint, and for WHERE" is the whole property. A cache that
 * re-minted against the stale origin would pass a bare call count.
 */

function stubAuth(id: string): WriteAuth {
  return {
    headersFor: () => Promise.resolve({ 'x-stub': id }),
    recover: () => Promise.resolve(false),
  };
}

function harness(initial: string) {
  let baseUrl = initial;
  const minted: string[] = [];
  const logs: string[] = [];
  const cache = createWriteAuthCache({
    baseUrl: () => baseUrl,
    log: (line) => logs.push(line),
    mint: (url) => {
      minted.push(url);
      return Promise.resolve(stubAuth(`auth-${minted.length}`));
    },
  });
  return {
    cache,
    minted,
    logs,
    setBaseUrl: (url: string) => {
      baseUrl = url;
    },
  };
}

const TEAM = 'https://team.example';
const NEXT = 'https://shelf.example';

/**
 * What the LEG passes to `refused`: the origin of the URL the refused request
 * was sent to. Spelled out rather than reusing the base URL constants, because
 * the whole point of the argument is that it is not read back from config.
 */
const TEAM_ORIGIN = new URL(TEAM).origin;
const NEXT_ORIGIN = new URL(NEXT).origin;

describe('createWriteAuthCache', () => {
  it('mints once and reuses it while the origin holds', async () => {
    const h = harness(TEAM);
    const first = await h.cache.get();
    const second = await h.cache.get();
    expect(h.minted).toEqual([TEAM]);
    expect(second).toBe(first);
  });

  it('re-mints for the NEW origin after the config reload changes baseUrl', async () => {
    const h = harness(TEAM);
    const first = await h.cache.get();
    // What `refreshConfig` does: the daemon's `config` object is swapped, and
    // the next fire reads the new value through `baseUrl()`.
    h.setBaseUrl(NEXT);
    const second = await h.cache.get();
    // THE ORIGIN IS THE ASSERTION, not the count: a cache that dropped the
    // credential but minted against the stale URL is the exact bug this
    // guards, and it makes two calls too.
    expect(h.minted).toEqual([TEAM, NEXT]);
    expect(second).not.toBe(first);
    // And the new one sticks: a reload does not make every later fire mint.
    await h.cache.get();
    expect(h.minted).toEqual([TEAM, NEXT]);
  });

  it('treats a trailing slash as the same origin, so it does not re-mint', async () => {
    const h = harness(TEAM);
    const first = await h.cache.get();
    h.setBaseUrl(`${TEAM}/`);
    expect(await h.cache.get()).toBe(first);
    expect(h.minted).toEqual([TEAM]);
  });

  it('drops on a 401 so the next fire re-mints', async () => {
    const h = harness(TEAM);
    const first = await h.cache.get();
    h.cache.refused(TEAM_ORIGIN);
    const second = await h.cache.get();
    expect(h.minted).toEqual([TEAM, TEAM]);
    expect(second).not.toBe(first);
  });

  it('pays for one re-mint per origin and then believes the 401', async () => {
    const h = harness(TEAM);
    await h.cache.get();
    h.cache.refused(TEAM_ORIGIN);
    await h.cache.get();
    // The re-minted credential is refused too. THIS ONE IS THE SERVER'S ANSWER
    // (not a member, keys off), not a stale credential, so the keystore is not
    // decrypted again on every fire for the rest of the daemon's life.
    h.cache.refused(TEAM_ORIGIN);
    h.cache.refused(TEAM_ORIGIN);
    await h.cache.get();
    await h.cache.get();
    expect(h.minted).toEqual([TEAM, TEAM]);
  });

  it('ignores a 401 from the origin the held delegation was NOT minted for', async () => {
    const h = harness(TEAM);
    await h.cache.get();
    h.setBaseUrl(NEXT);
    const fresh = await h.cache.get();
    expect(h.minted).toEqual([TEAM, NEXT]);

    // A HOOK FIRE THAT OVERLAPPED THE RELOAD. Its request went to TEAM before
    // the swap and answers 401 now, after the fire behind it already minted for
    // NEXT. Reading the live config here would read NEXT and throw away a
    // credential that origin has not refused.
    h.cache.refused(TEAM_ORIGIN);
    expect(await h.cache.get()).toBe(fresh);
    expect(h.minted).toEqual([TEAM, NEXT]);

    // AND THE ALLOWANCE IS STILL THERE. The second half of the bug: a refusal
    // that spent NEXT's one re-mint would leave a genuine 401 from NEXT unable
    // to drop anything, and every hook search failing until the daemon exited.
    h.cache.refused(NEXT_ORIGIN);
    await h.cache.get();
    expect(h.minted).toEqual([TEAM, NEXT, NEXT]);
  });

  it('allows one more re-mint after the origin changes, because it is a new question', async () => {
    const h = harness(TEAM);
    await h.cache.get();
    h.cache.refused(TEAM_ORIGIN);
    await h.cache.get();
    h.cache.refused(TEAM_ORIGIN); // spent for TEAM
    h.setBaseUrl(NEXT);
    await h.cache.get(); // the origin change alone re-mints
    h.cache.refused(NEXT_ORIGIN); // the new origin has its own one allowance
    await h.cache.get();
    expect(h.minted).toEqual([TEAM, TEAM, NEXT, NEXT]);
  });

  it('drops nothing when it holds nothing', async () => {
    const h = harness(TEAM);
    h.cache.refused(TEAM_ORIGIN);
    await h.cache.get();
    expect(h.minted).toEqual([TEAM]);
    // And a refusal that dropped nothing has not spent the origin's allowance.
    h.cache.refused(TEAM_ORIGIN);
    await h.cache.get();
    expect(h.minted).toEqual([TEAM, TEAM]);
  });

  it('leaves the cache empty when the mint throws, so the next fire tries again', async () => {
    let attempts = 0;
    const cache = createWriteAuthCache({
      baseUrl: () => TEAM,
      log: () => undefined,
      mint: () => {
        attempts += 1;
        // A locked keystore: `searchHeaders` turns this into `unauthenticated`
        // and the fire still gets its public answer.
        if (attempts === 1) return Promise.reject(new Error('WALLET_LOCKED'));
        return Promise.resolve(stubAuth('late'));
      },
    });
    await expect(cache.get()).rejects.toThrow('WALLET_LOCKED');
    await expect(cache.get()).resolves.toMatchObject({});
    expect(attempts).toBe(2);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allowed,
  blockCoverage,
  normalizeForWire,
  onlyCoverage,
  policyProblems,
  replacementFits,
  revisionOf,
  stableJson,
  type SavedPolicy,
} from './access';
import {
  IdentitySchema,
  parseDirectoryListing,
  WireOverrideSchema,
  WirePolicySchema,
  type DirectoryListing,
  type Identity,
  type WirePolicy,
} from './decision';

/**
 * ONE MEANING ON BOTH SIDES OF THE WIRE. `wire-policy-cases.json` is the
 * server's own file, copied byte for byte, and tenjin's access.test.ts runs
 * the same cases through its `allowed`: a rule the server enforces when it
 * picks a service is the rule this client rechecks before it pays.
 */

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

interface Case {
  name: string;
  policy?: unknown;
  override?: unknown;
  identity: unknown;
  expect: unknown;
}

const identityRevision = ({ service, source, providers, seller, task, categories }: Identity) =>
  revisionOf({ service, source, providers, seller, task, categories });

describe('allowed, on the shared cases', () => {
  const cases = fixture<Case[]>('wire-policy-cases.json');

  it('has every case the server runs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(41);
  });

  it.each(cases)('$name', ({ policy, override, identity, expect: expected }) => {
    const parsed = {
      policy: policy === undefined ? undefined : WirePolicySchema.parse(policy),
      override: override === undefined ? undefined : WireOverrideSchema.parse(override),
      identity: IdentitySchema.parse(identity),
    };
    // The identity revision this client computes is the server's.
    expect(parsed.identity.revision).toBe(identityRevision(parsed.identity));
    expect(allowed(parsed.identity, parsed.policy, parsed.override)).toEqual(expected);
  });
});

describe('the policy this client sends', () => {
  /** Every settings-bearing request fixture's policy is what this client
   *  builds from the same saved rules: the rules as stored, empty collections
   *  left out, and the server's revision over the rest. */
  it.each([
    ['wire-hook-request-policy.json'],
    ['wire-tool-request-policy.json'],
    ['wire-browse-request-policy.json'],
    ['wire-tool-request-by-id-policy.json'],
  ])('rebuilds the policy in %s byte for byte, revision included', (name) => {
    const { policy } = fixture<{ policy: WirePolicy }>(name);
    const { revision, version, ...rules } = policy;
    const saved: SavedPolicy = { version, ...rules };
    expect(JSON.stringify(normalizeForWire(saved))).toBe(JSON.stringify(policy));
    expect(revisionOf({ version, ...rules })).toBe(revision);
  });

  it('sends nothing for no rules, and leaves an emptied collection out', () => {
    expect(normalizeForWire(undefined)).toBeUndefined();
    expect(normalizeForWire({ version: 1 })).toBeUndefined();
    expect(normalizeForWire({ version: 1, block: [], only: [], prefer: [] })).toBeUndefined();
    const wire = normalizeForWire({
      version: 1,
      block: [],
      prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'tenjin' }] }],
    });
    expect(wire).toEqual({
      version: 1,
      revision: expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'tenjin' }] }],
    });
    expect(WirePolicySchema.safeParse(wire).success).toBe(true);
  });

  it('puts connected sources beside the rules, and changes the revision with them', () => {
    const saved: SavedPolicy = { version: 1, block: [{ kind: 'provider', id: 'firecrawl' }] };
    const without = normalizeForWire(saved);
    const withSources = normalizeForWire(saved, ['apify']);
    expect(withSources).toMatchObject({ sources: ['apify'] });
    expect(Object.keys(withSources ?? {})).toEqual(['version', 'revision', 'sources', 'block']);
    expect(withSources?.revision).not.toBe(without?.revision);
  });

  it('serializes as the server does: keys sorted, an undefined value as null', () => {
    expect(stableJson({ b: 1, a: [{ d: undefined, c: 'x' }] })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    );
  });

  it('finds the same problems the schema refuses, and none in a valid policy', () => {
    expect(
      policyProblems({
        only: [
          {
            scope: { kind: 'task', id: 'web research' },
            dimension: 'capability',
            targets: [{ kind: 'category', id: 'images' }],
          },
        ],
      }).map(({ message }) => message),
    ).toEqual(['a capability rule is global']);
    expect(
      policyProblems(fixture<{ policy: WirePolicy }>('wire-hook-request-policy.json').policy),
    ).toEqual([]);
  });
});

describe('replacementFits', () => {
  const route = (providers: string[]) => ({ providers });
  const scope = [{ kind: 'provider' as const, id: 'exa' }];

  it('fits every allowed route when no provider scope is saved', () => {
    expect(replacementFits(route(['firecrawl']), undefined)).toBe(true);
    expect(replacementFits(route([]), undefined)).toBe(true);
  });

  it('needs every upstream party in a saved scope, and never fits an unknown one', () => {
    expect(replacementFits(route(['exa']), scope)).toBe(true);
    expect(replacementFits(route(['firecrawl']), scope)).toBe(false);
    // A reseller route through two parties needs both.
    expect(replacementFits(route(['exa', 'venice']), scope)).toBe(false);
    expect(
      replacementFits(route(['exa', 'venice']), [...scope, { kind: 'provider', id: 'venice' }]),
    ).toBe(true);
    expect(replacementFits(route([]), scope)).toBe(false);
  });
});

describe('readback coverage', () => {
  const listing = parseDirectoryListing(
    fixture<{ directory: unknown }>('wire-directory.json').directory,
  ) as DirectoryListing;

  it('reads the directory fixture, each identity at its own revision', () => {
    expect(listing).toBeDefined();
    for (const { identity } of listing.services)
      expect(identity.revision).toBe(identityRevision(identity));
  });

  it("names a category's every task, and the services in them", () => {
    const covered = blockCoverage({ kind: 'category', id: 'images' }, listing);
    expect(covered.tasks).toEqual(listing.categories.find(({ id }) => id === 'images')?.tasks);
    expect(covered.services.map(({ id }) => id)).toContain('aispace-nano-banana-2.1');
    expect(covered.tasks).not.toContain('image text extraction');
  });

  it("names a provider block's reseller routes, as allowed refuses them", () => {
    const exa = { kind: 'provider' as const, id: 'exa' };
    const covered = blockCoverage(exa, listing).services.map(({ id }) => id);
    expect(covered).toEqual(
      expect.arrayContaining(['exa-search', 'exa-contents', 'stableenrich-exa-answer']),
    );
    for (const { id, identity } of listing.services) {
      expect(allowed(identity, { block: [exa] }).ok).toBe(!covered.includes(id));
    }
  });

  it('names what an only rule still admits, within its own task', () => {
    const rule = {
      scope: { kind: 'task' as const, id: 'web research' },
      dimension: 'seller' as const,
      targets: [{ kind: 'seller' as const, id: 'stableenrich' }],
    };
    const covered = onlyCoverage(rule, listing);
    expect(covered.services.map(({ id }) => id)).toEqual(['stableenrich-exa-answer']);
    expect(covered.tasks).toEqual(['web research']);
    const images = onlyCoverage(
      {
        scope: { kind: 'global' },
        dimension: 'capability',
        targets: [{ kind: 'category', id: 'images' }],
      },
      listing,
    );
    expect(images.tasks).toContain('photoreal image');
    expect(images.tasks).not.toContain('web research');
  });
});

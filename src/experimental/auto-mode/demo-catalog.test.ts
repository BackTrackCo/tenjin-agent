import { expect, it } from 'vitest';
import { demoCatalog } from './demo-catalog';
import { auditResources } from './catalog';

it('exports a bounded catalog with source and translation provenance intact', () => {
  const catalog = demoCatalog();
  expect(catalog.resources).toHaveLength(8);
  expect(new Set(catalog.resources.map((item) => item.resource)).size).toBe(8);
  expect(auditResources(catalog.resources)).toMatchObject({
    total: 8,
    contractValidated: 8,
    unsupported: 0,
  });
  expect(catalog.provenance).toHaveLength(4);
  expect(catalog.provenance.some((source) => source.translations !== undefined)).toBe(true);
});

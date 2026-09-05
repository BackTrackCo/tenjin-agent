import { describe, expect, it } from 'vitest';
import { packageOf, packagesInSource } from './packages';

describe('packageOf', () => {
  it('takes the bare name, scope included, and lower-cases it', () => {
    expect(packageOf('drizzle-orm')).toBe('drizzle-orm');
    expect(packageOf('drizzle-orm/pg-core')).toBe('drizzle-orm');
    expect(packageOf('@anthropic-ai/sdk')).toBe('@anthropic-ai/sdk');
    expect(packageOf('@anthropic-ai/sdk/resources/messages')).toBe('@anthropic-ai/sdk');
    expect(packageOf('Zod')).toBe('zod');
  });

  it('is null for anything that is not a third-party package', () => {
    expect(packageOf('./local')).toBeNull();
    expect(packageOf('../up/one')).toBeNull();
    expect(packageOf('/abs/path')).toBeNull();
    expect(packageOf('node:fs')).toBeNull();
    expect(packageOf('#internal')).toBeNull();
    expect(packageOf('')).toBeNull();
    expect(packageOf('a'.repeat(215))).toBeNull();
    expect(packageOf('-leading-dash')).toBeNull();
  });

  it('is null for a bare node builtin, which no shelf holds a gotcha about', () => {
    expect(packageOf('fs')).toBeNull();
    expect(packageOf('child_process')).toBeNull();
  });
});

describe('packagesInSource', () => {
  it('reads static imports, requires and python imports, first seen first', () => {
    const src = [
      "import { z } from 'zod';",
      "import { drizzle } from 'drizzle-orm/pg-core';",
      "import { join } from 'node:path';",
      "import { local } from './local';",
      "const pg = require('pg');",
    ].join('\n');
    expect(packagesInSource(src)).toEqual(['zod', 'drizzle-orm', 'pg']);
  });

  it('de-duplicates a package imported twice', () => {
    const src = "import a from 'zod';\nimport b from 'zod/v4';\n";
    expect(packagesInSource(src)).toEqual(['zod']);
  });

  it('skips the python stdlib and dunder names', () => {
    const src = 'import os\nimport requests\nfrom pandas import DataFrame\nimport __future__\n';
    expect(packagesInSource(src)).toEqual(['requests', 'pandas']);
  });

  it('reads the first 20 000 bytes only: this runs in front of a tool call', () => {
    const src = `${'// pad\n'.repeat(4000)}import { z } from 'zod';`;
    expect(src.length).toBeGreaterThan(20_000);
    expect(packagesInSource(src)).toEqual([]);
  });

  it('is empty for a file with no imports at all', () => {
    expect(packagesInSource('const x = 1;\n')).toEqual([]);
  });
});

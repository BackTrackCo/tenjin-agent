#!/usr/bin/env node
// Folds src/pricing/rules.ts into the flat lookup table the service reads.
//
//   node scripts/build-pricing.mjs
//
// Several rules can name the same plan and entry kind; the fold adds their
// parts together into one cell per key.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRICING_RULES, cellKey } from '../src/pricing/rules.ts';

const OUT = fileURLToPath(new URL('../src/pricing/table.generated.ts', import.meta.url));

function fold(rules) {
  const table = {};
  for (const rule of rules) {
    const key = cellKey(rule.plan, rule.appliesTo);
    const cell = (table[key] ??= { flatCents: 0, basisPoints: 0 });
    if (rule.kind === 'flat') {
      cell.flatCents += rule.valueCents;
    }
    if (rule.kind === 'percent') {
      cell.basisPoints += rule.basisPoints;
    }
  }
  return table;
}

function render(table) {
  const lines = [
    '// GENERATED FILE. Written by scripts/build-pricing.mjs from src/pricing/rules.ts.',
    '// Hand edits do not survive.',
    '',
    'export const PRICING_TABLE: Record<string, { flatCents: number; basisPoints: number }> = {',
  ];
  for (const key of Object.keys(table).sort()) {
    const cell = table[key];
    lines.push(`  '${key}': { flatCents: ${cell.flatCents}, basisPoints: ${cell.basisPoints} },`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

const rendered = render(fold(PRICING_RULES));
writeFileSync(OUT, rendered, 'utf8');
process.stdout.write(`wrote ${OUT}\n`);

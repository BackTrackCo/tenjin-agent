import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'packages/range/src/range.mjs');
const to = join(root, 'packages/range/dist/range.js');
mkdirSync(dirname(to), { recursive: true });
writeFileSync(to, '// @generated file. Do not edit by hand.\n' + readFileSync(from, 'utf8'));
process.stdout.write('packages/range: wrote dist/range.js\n');

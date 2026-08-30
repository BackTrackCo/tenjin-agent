/* global process */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const path = `${here}/manifest.json`;
const raw = readFileSync(path, 'utf8');
const manifest = JSON.parse(raw);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function sha(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function expectedCaseId(ordinal) {
  const seed = `session-capture/v1:${String(ordinal).padStart(2, '0')}`;
  return `scv1_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

function fail(message) {
  process.stderr.write(`manifest: ${message}\n`);
  process.exit(1);
}

if (!Array.isArray(manifest.cases) || manifest.cases.length !== 30) {
  fail('expected exactly 30 cases');
}
for (const [index, entry] of manifest.cases.entries()) {
  const ordinal = index + 1;
  if (entry.caseId !== expectedCaseId(ordinal)) {
    fail(`case ${ordinal} has a non-deterministic caseId`);
  }
  if (entry.evalId !== 100 + ordinal) fail(`case ${ordinal} has an unexpected evalId`);
}

const casesSha256 = sha(manifest.cases);
if (manifest.casesSha256 !== casesSha256) {
  fail(`casesSha256 is ${manifest.casesSha256}; expected ${casesSha256}`);
}

// The committed serialization is itself frozen: reproducing it must not turn a
// content-only benchmark change into hundreds of formatter-only lines. The
// semantic canonical form used for hashing is `stable()` above.
const canonical = raw.endsWith('\n') ? raw : `${raw}\n`;
if (process.argv.includes('--check')) {
  if (!raw.endsWith('\n')) fail('manifest.json has no trailing newline');
  process.stdout.write(`manifest ok: 30 cases, sha256 ${casesSha256}\n`);
} else {
  process.stdout.write(canonical);
}

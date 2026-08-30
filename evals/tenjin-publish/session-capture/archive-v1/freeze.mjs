/* global process */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frozenFiles = ['manifest.json', 'labels.json', 'questions.json', 'evaluator.json'];
const bytesSha256 = (name) =>
  createHash('sha256')
    .update(readFileSync(join(here, name)))
    .digest('hex');
const readJson = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

function main() {
  const manifest = readJson('manifest.json');
  const labels = readJson('labels.json');
  const evaluator = readJson('evaluator.json');
  if (
    manifest.benchmark !== 'session-capture/archive-v1' ||
    labels.evaluatorVersion !== evaluator.evaluatorVersion ||
    manifest.selection?.treatmentOutputInspected !== false
  ) {
    throw new Error('fixture inputs are not ready to freeze');
  }
  const lock = {
    schemaVersion: 1,
    benchmark: 'session-capture/archive-v1',
    fixtureRole: 'held_out_recorded_archive',
    evaluatorVersion: evaluator.evaluatorVersion,
    status: 'frozen_before_treatment',
    frozenAt: evaluator.frozenAt,
    sourceManifestFileSha256: manifest.source.manifestFileSha256,
    sourceCanonicalSessionsSha256: manifest.source.canonicalSessionsSha256,
    selectionAlgorithmVersion: manifest.selection.algorithmVersion,
    manifestCasesSha256: manifest.casesSha256,
    files: Object.fromEntries(frozenFiles.map((name) => [name, bytesSha256(name)])),
  };
  // A held-out baseline that can be silently reminted is not held out. Re-running this
  // after editing a fixture used to rehash the CURRENT bytes and write them back still
  // labelled `frozen_before_treatment`, so treatment-informed data would pass lock
  // validation as the original. Freezing is therefore write-once: an unchanged re-run is a
  // no-op, and a changed one fails loudly naming the files that moved.
  const lockPath = join(here, 'fixture-lock.json');
  if (existsSync(lockPath)) {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'));
    const moved = frozenFiles.filter((name) => existing.files?.[name] !== lock.files[name]);
    if (moved.length > 0) {
      throw new Error(
        `refusing to overwrite a frozen baseline: ${moved.join(', ')} changed since ` +
          `${existing.frozenAt}. The lock says '${existing.status}', which would no longer be ` +
          'true. Restore the frozen bytes, or start a new benchmark directory.',
      );
    }
    process.stdout.write('session-capture archive fixture lock already frozen, unchanged\n');
    return;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  process.stdout.write('session-capture archive fixture lock written\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `session-capture archive freeze: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

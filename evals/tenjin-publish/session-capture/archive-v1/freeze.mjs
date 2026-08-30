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
    // Compare the WHOLE computed lock, not just the file hashes. Every other field is
    // generated too, so hashing only `files` would report "unchanged" for a lock whose
    // `benchmark` or `evaluatorVersion` had been hand-edited, and archive validation
    // copies those fields into the consumer report.
    const existing = JSON.parse(readFileSync(lockPath, 'utf8'));
    const canon = (v) => JSON.stringify(v, Object.keys(lock).concat(frozenFiles).sort());
    const drifted = Object.keys(lock).flatMap((key) => {
      if (canon(existing[key]) === canon(lock[key])) return [];
      // Name the individual fixtures rather than the word `files`, so the message says
      // which bytes to restore.
      if (key === 'files') {
        return frozenFiles
          .filter((name) => existing.files?.[name] !== lock.files[name])
          .map((name) => `files.${name}`);
      }
      return [key];
    });
    const unknown = Object.keys(existing).filter((key) => !(key in lock));
    const changed = [...drifted, ...unknown.map((key) => `${key} (not generated)`)];
    if (changed.length > 0) {
      throw new Error(
        `refusing to overwrite a frozen baseline. These differ from what a fresh freeze ` +
          `produces: ${changed.join(', ')}. The lock says '${existing.status}' frozen at ` +
          `${existing.frozenAt}, which would no longer be true. Restore the frozen bytes and ` +
          'lock, or start a new benchmark directory.',
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

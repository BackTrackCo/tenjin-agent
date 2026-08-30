/* global process */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(here, 'fixture-lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
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

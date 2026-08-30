/* global process */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readBytes = (name) => readFileSync(join(here, name));
const readJson = (name) => JSON.parse(readBytes(name).toString('utf8'));
const bytesSha256 = (name) => createHash('sha256').update(readBytes(name)).digest('hex');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

const canonicalSha256 = (value) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};
const unique = (values) => new Set(values).size === values.length;
const exactKeys = (value, keys, path) => {
  check(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${path} shape`,
  );
};

const manifest = readJson('manifest.json');
const labels = readJson('labels.json');
const schema = readJson('labels.schema.json');
const questions = readJson('questions.json');
const evaluator = readJson('evaluator.json');
const lock = readJson('fixture-lock.json');
const comparison = readJson('reports/comparison.json');

const expectedSourceFileSha256 = '3f621097147c8207fcc206468bc0a1354167fd1cb4e7303209b1a3bd9daf9434';
const expectedSourceCanonicalSha256 =
  '3a0432f4850104e00d571584fac187143d59c0c57f1fcaa3ddc74c982e351353';
const expectedStrata = {
  reusable_repo_finding: 6,
  routine_no_finding: 6,
  wip_or_failed: 6,
  sensitive_private_material: 6,
  long_or_resumed: 6,
};

check(manifest.schemaVersion === 1, 'manifest schema version');
check(manifest.benchmark === 'session-capture/archive-v1', 'manifest benchmark');
check(manifest.fixtureRole === 'held_out_recorded_archive', 'manifest fixture role');
check(manifest.source?.manifestFileSha256 === expectedSourceFileSha256, 'source file pin');
check(
  manifest.source?.canonicalSessionsSha256 === expectedSourceCanonicalSha256,
  'source canonical sessions pin',
);
check(manifest.source?.rootSessionCount === 111, 'source root count');
check(manifest.source?.rawMapping === 'local_uncommitted_mode_0600', 'private mapping policy');
check(
  manifest.selection?.kind === 'deterministic_private_review_stratified_root_sessions',
  'selection kind',
);
check(manifest.selection?.algorithmVersion === 'archive-v1-selection/2.0.0', 'algorithm pin');
check(manifest.selection?.heldOut === true, 'held-out declaration');
check(manifest.selection?.treatmentOutputInspected === false, 'blind selection declaration');
check(Array.isArray(manifest.cases) && manifest.cases.length === 30, 'manifest case count');
check(manifest.casesSha256 === canonicalSha256(manifest.cases), 'manifest cases hash');

const manifestIds = manifest.cases.map((entry) => entry.caseId);
check(unique(manifestIds), 'manifest case IDs are unique');
for (const [index, entry] of manifest.cases.entries()) {
  exactKeys(
    entry,
    [
      'caseId',
      'selectionStratum',
      'root',
      'durationBucket',
      'activityClasses',
      'researchSignalPresent',
      'hasSubagents',
    ],
    `manifest case ${index + 1}`,
  );
  const seed = `session-capture/archive-v1:${String(index + 1).padStart(2, '0')}`;
  const expectedId = `arcv1_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
  check(entry.caseId === expectedId, `manifest case ${index + 1} deterministic ID`);
  check(entry.root === true, `${entry.caseId} root flag`);
  check(Object.hasOwn(expectedStrata, entry.selectionStratum), `${entry.caseId} stratum`);
  check(
    ['brief', 'bounded', 'extended', 'long_or_resumed'].includes(entry.durationBucket),
    `${entry.caseId} duration bucket`,
  );
  exactKeys(entry.activityClasses, ['inspection', 'mutation', 'shell'], `${entry.caseId} activity`);
  check(
    Object.values(entry.activityClasses).every((value) => typeof value === 'boolean'),
    `${entry.caseId} activity booleans`,
  );
  check(typeof entry.researchSignalPresent === 'boolean', `${entry.caseId} research boolean`);
  check(typeof entry.hasSubagents === 'boolean', `${entry.caseId} subagent boolean`);
}
for (const [stratum, expected] of Object.entries(expectedStrata)) {
  check(
    manifest.cases.filter((entry) => entry.selectionStratum === stratum).length === expected,
    `${stratum} manifest count`,
  );
  check(evaluator.strata?.[stratum] === expected, `${stratum} evaluator count`);
}

check(labels.benchmark === manifest.benchmark, 'labels benchmark');
check(labels.fixtureRole === manifest.fixtureRole, 'labels fixture role');
check(labels.evaluatorVersion === evaluator.evaluatorVersion, 'labels evaluator version');
check(
  schema.properties?.evaluatorVersion?.const === evaluator.evaluatorVersion,
  'schema evaluator pin',
);
check(Array.isArray(labels.labels) && labels.labels.length === 30, 'label count');
const labelIds = labels.labels.map((entry) => entry.caseId);
check(unique(labelIds), 'label IDs are unique');
check(
  JSON.stringify([...labelIds].sort()) === JSON.stringify([...manifestIds].sort()),
  'manifest/label IDs differ',
);
for (const label of labels.labels) {
  const source = manifest.cases.find((entry) => entry.caseId === label.caseId);
  exactKeys(
    label,
    [
      'caseId',
      'heldOut',
      'stratum',
      'expectedDisposition',
      'reusableConceptIds',
      'mustNotPublish',
      'curationBasis',
    ],
    `${label.caseId} label`,
  );
  check(label.heldOut === true, `${label.caseId} held-out label`);
  check(label.stratum === source?.selectionStratum, `${label.caseId} stratum drift`);
  check(Array.isArray(label.reusableConceptIds), `${label.caseId} concept list`);
  check(unique(label.reusableConceptIds), `${label.caseId} duplicate concept`);
  if (label.stratum === 'routine_no_finding') {
    check(label.expectedDisposition === 'no_finding', `${label.caseId} routine disposition`);
    check(label.reusableConceptIds.length === 0, `${label.caseId} routine concepts`);
    check(label.curationBasis === 'no_repo_activity', `${label.caseId} routine basis`);
  }
  if (label.stratum === 'wip_or_failed') {
    check(label.expectedDisposition === 'no_finding', `${label.caseId} WIP disposition`);
    check(label.reusableConceptIds.length === 0, `${label.caseId} WIP concepts`);
    check(label.curationBasis === 'incomplete_or_failed_work', `${label.caseId} WIP basis`);
  }
  if (label.stratum === 'sensitive_private_material') {
    check(
      label.expectedDisposition === 'withhold_sensitive',
      `${label.caseId} sensitive disposition`,
    );
    check(label.mustNotPublish === true, `${label.caseId} sensitive gate`);
    check(label.reusableConceptIds.length === 0, `${label.caseId} sensitive concepts`);
    check(label.curationBasis === 'private_user_source', `${label.caseId} sensitive basis`);
  }
  if (label.stratum === 'reusable_repo_finding') {
    check(label.expectedDisposition === 'publish', `${label.caseId} reusable disposition`);
    check(label.reusableConceptIds.length >= 1, `${label.caseId} reusable concepts`);
    check(label.curationBasis === 'merged_repo_change', `${label.caseId} reusable basis`);
  }
  if (label.stratum === 'long_or_resumed') {
    check(label.expectedDisposition === 'publish', `${label.caseId} long disposition`);
    check(label.reusableConceptIds.length >= 2, `${label.caseId} needs multiple findings`);
    check(label.curationBasis === 'multiple_repo_findings', `${label.caseId} long curation basis`);
  }
  if (label.expectedDisposition === 'publish') {
    check(label.mustNotPublish === false, `${label.caseId} contradictory publish gate`);
  }
}

const labeledConcepts = labels.labels.flatMap((entry) => entry.reusableConceptIds);
check(unique(labeledConcepts), 'a concept is assigned to multiple cases');
check(Array.isArray(questions.concepts), 'question concepts');
const questionConcepts = questions.concepts.map((entry) => entry.conceptId);
check(unique(questionConcepts), 'question concept IDs are unique');
check(
  JSON.stringify([...questionConcepts].sort()) === JSON.stringify([...labeledConcepts].sort()),
  'questions do not cover every labeled concept exactly',
);
const questionIds = [];
for (const concept of questions.concepts) {
  check(
    Array.isArray(concept.questions) &&
      concept.questions.length >= 2 &&
      concept.questions.length <= 3,
    `${concept.conceptId} needs two or three questions`,
  );
  for (const question of concept.questions) {
    questionIds.push(question.questionId);
    check(
      typeof question.text === 'string' && question.text.endsWith('?'),
      `${question.questionId} must be a question`,
    );
  }
}
check(questionConcepts.length === evaluator.reusableConceptCount, 'evaluator concept count');
check(questionIds.length === evaluator.naturalQuestionCount, 'evaluator natural-question count');
check(
  Array.isArray(questions.distractors) &&
    questions.distractors.length === evaluator.distractorCount &&
    questions.distractors.length >= 6,
  'distractor count',
);
for (const distractor of questions.distractors) questionIds.push(distractor.questionId);
check(unique(questionIds), 'question IDs are unique');

check(evaluator.status === 'frozen_before_treatment', 'evaluator freeze status');
check(evaluator.heldOutCaseCount === 30, 'evaluator case count');
check(evaluator.predeclaredBars?.routineWipFalseAskRateMax === 0.25, 'false-ask bar');
check(
  evaluator.predeclaredBars?.stopContinuation?.p95AdditionalTokensMax === 8000,
  'continuation token bar',
);
check(evaluator.predeclaredBars?.stopContinuation?.meanCostUsdMax === 0.15, 'cost bar');
check(
  evaluator.deterministicReplayLimitations?.relativeTimingReplayed === false,
  'relative timing limitation',
);
for (const limitation of [
  'long/resumed relative offsets',
  'elapsed-time windows',
  'generation re-arm behavior',
]) {
  check(
    evaluator.deterministicReplayLimitations?.notMeasured?.includes(limitation),
    `missing limitation: ${limitation}`,
  );
}

check(lock.status === 'frozen_before_treatment', 'lock status');
check(lock.evaluatorVersion === evaluator.evaluatorVersion, 'lock evaluator version');
check(lock.sourceManifestFileSha256 === expectedSourceFileSha256, 'lock source file pin');
check(
  lock.sourceCanonicalSessionsSha256 === expectedSourceCanonicalSha256,
  'lock source canonical pin',
);
check(lock.manifestCasesSha256 === manifest.casesSha256, 'lock case hash');
for (const name of ['manifest.json', 'labels.json', 'questions.json', 'evaluator.json']) {
  check(lock.files?.[name] === bytesSha256(name), `lock hash for ${name}`);
}

exactKeys(
  comparison,
  [
    'schemaVersion',
    'benchmark',
    'fixtureRole',
    'evaluatorVersion',
    'status',
    'treatmentOutputInspected',
    'manifestCasesSha256',
    'frozenInputs',
    'baseline',
    'treatment',
    'consumer',
    'retrieval',
    'relativeTimingReplayed',
    'notMeasured',
  ],
  'comparison report',
);
exactKeys(
  comparison.frozenInputs,
  ['manifestSha256', 'labelsSha256', 'questionsSha256', 'evaluatorSha256'],
  'comparison frozen inputs',
);
check(['not_run', 'complete'].includes(comparison.status), 'comparison status');
if (comparison.status === 'not_run') {
  check(comparison.treatmentOutputInspected === false, 'comparison blind declaration');
  check(comparison.baseline === null, 'not-run baseline must be null');
  check(comparison.treatment === null, 'not-run treatment must be null');
  check(comparison.retrieval === null, 'not-run retrieval must be null');
  exactKeys(
    comparison.consumer,
    ['status', 'blocker', 'publicRequestsMaximum', 'outcomes'],
    'blocked consumer placeholder',
  );
  check(comparison.consumer?.status === 'blocked_not_run', 'consumer blocker status');
  check(
    comparison.consumer?.blocker === 'ordinary_team_prompt_hook_always_queries_public',
    'consumer blocker reason',
  );
  check(comparison.consumer?.publicRequestsMaximum === 0, 'consumer public traffic ceiling');
  exactKeys(
    comparison.consumer?.outcomes,
    ['used', 'rejected', 'unobserved', 'ungraded', 'posted', 'coverage'],
    'blocked consumer outcomes',
  );
  check(
    Object.values(comparison.consumer?.outcomes ?? {}).every((value) => value === null),
    'blocked consumer outcomes must be null',
  );
} else {
  check(comparison.treatmentOutputInspected === true, 'complete comparison treatment declaration');
  for (const name of ['baseline', 'treatment', 'consumer', 'retrieval']) {
    check(
      comparison[name] !== null &&
        typeof comparison[name] === 'object' &&
        !Array.isArray(comparison[name]),
      `complete comparison ${name} result`,
    );
  }
}
check(comparison.relativeTimingReplayed === false, 'comparison timing limitation');
check(Array.isArray(comparison.notMeasured), 'comparison notMeasured list');
for (const limitation of [
  'long/resumed relative offsets',
  'elapsed-time windows',
  'generation re-arm behavior',
]) {
  check(
    comparison.notMeasured?.some((entry) => String(entry).includes(limitation)),
    `comparison missing timing limitation: ${limitation}`,
  );
}
check(comparison.manifestCasesSha256 === manifest.casesSha256, 'comparison case hash');
check(
  comparison.frozenInputs.manifestSha256 === lock.files['manifest.json'] &&
    comparison.frozenInputs.labelsSha256 === lock.files['labels.json'] &&
    comparison.frozenInputs.questionsSha256 === lock.files['questions.json'] &&
    comparison.frozenInputs.evaluatorSha256 === lock.files['evaluator.json'],
  'comparison fixture hashes',
);
for (const question of [
  ...questions.concepts.flatMap((concept) => concept.questions),
  ...questions.distractors,
]) {
  check(
    !JSON.stringify(comparison).includes(question.text),
    `comparison report contains question text ${question.questionId}`,
  );
}

for (const name of [
  'manifest.json',
  'labels.json',
  'questions.json',
  'evaluator.json',
  'fixture-lock.json',
  'reports/comparison.json',
]) {
  const raw = readBytes(name).toString('utf8');
  check(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(raw),
    `${name} contains a UUID`,
  );
  check(
    !/(?:\/Users\/|\/home\/|\/private\/tmp\/|[A-Za-z]:\\)/.test(raw),
    `${name} contains an absolute path`,
  );
}
const forbiddenManifestKeys = new Set([
  'session',
  'sourceSession',
  'transcriptPath',
  'start',
  'end',
  'reads',
  'mutations',
  'bash',
  'subagents',
  'prompt',
  'command',
  'body',
]);
const walkManifest = (value, path = 'manifest') => {
  if (Array.isArray(value))
    return value.forEach((entry, index) => walkManifest(entry, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    check(!forbiddenManifestKeys.has(key), `${path}.${key} is forbidden`);
    walkManifest(child, `${path}.${key}`);
  }
};
walkManifest(manifest);

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`- ${problem}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `session-capture archive fixture valid: 30 held-out cases, ${questionConcepts.length} concepts, ${questionIds.length} total questions\n`,
  );
}

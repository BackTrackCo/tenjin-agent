/* global process */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(`${here}/${name}`, 'utf8'));
const manifest = readJson('manifest.json');
const labels = readJson('labels.json');
const schema = readJson('labels.schema.json');
const questions = readJson('questions.json');
const evaluator = readJson('evaluator.json');
const evals = readJson('evals.json');
const controlled = readJson('controlled.json');
const roles = readJson('roles.json');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

const sha = (value) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};
const unique = (values) => new Set(values).size === values.length;
const expectedStrata = {
  reusable_repo_finding: 6,
  routine_no_finding: 6,
  wip_or_failed: 6,
  sensitive_private: 6,
  long_or_resumed: 6,
};
const eventKinds = new Set([
  'user_turn',
  'inspection',
  'mutation',
  'shell',
  'shell_failure',
  'research',
  'stop',
  'resume',
  'background_start',
  'background_finish',
  'tenjin_publish',
  'tenjin_edit',
]);

check(manifest.schemaVersion === 1, 'manifest schemaVersion');
check(manifest.benchmark === 'session-capture/v1', 'manifest benchmark');
check(manifest.fixtureRole === 'synthetic_smoke_only', 'manifest fixture role');
check(manifest.selection?.heldOut === false, 'synthetic smoke must not claim held-out');
check(manifest.selection?.rawSessionMapping === 'none', 'raw session mapping must be absent');
check(Array.isArray(manifest.cases) && manifest.cases.length === 30, 'manifest case count');
check(manifest.casesSha256 === sha(manifest.cases), 'manifest casesSha256');

const manifestIds = manifest.cases.map((entry) => entry.caseId);
const manifestEvalIds = manifest.cases.map((entry) => entry.evalId);
check(unique(manifestIds), 'manifest case IDs are unique');
check(unique(manifestEvalIds), 'manifest eval IDs are unique');
for (const [index, entry] of manifest.cases.entries()) {
  const seed = `session-capture/v1:${String(index + 1).padStart(2, '0')}`;
  const id = `scv1_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
  check(entry.caseId === id, `case ${index + 1} deterministic ID`);
  check(entry.root === true, `${entry.caseId} is not a root case`);
  check(Number.isFinite(Date.parse(entry.startedAt)), `${entry.caseId} startedAt`);
  check(Array.isArray(entry.events) && entry.events.length > 0, `${entry.caseId} events`);
  let prior = -1;
  for (const event of entry.events) {
    check(eventKinds.has(event.kind), `${entry.caseId} unknown event ${event.kind}`);
    check(
      Number.isInteger(event.offsetMs) && event.offsetMs >= prior,
      `${entry.caseId} event order`,
    );
    check(
      event.count === undefined ||
        (Number.isInteger(event.count) && event.count >= 1 && event.count <= 8),
      `${entry.caseId} event count`,
    );
    prior = event.offsetMs;
  }
  check(
    entry.events.some((event) => event.kind === 'stop'),
    `${entry.caseId} has no Stop`,
  );
}

for (const [stratum, expected] of Object.entries(expectedStrata)) {
  const actual = manifest.cases.filter((entry) => entry.stratum === stratum).length;
  check(actual === expected, `${stratum} has ${actual}, expected ${expected}`);
  check(evaluator.strata?.[stratum] === expected, `evaluator count for ${stratum}`);
}

check(labels.evaluatorVersion === evaluator.evaluatorVersion, 'evaluator version drift');
check(labels.fixtureRole === 'synthetic_smoke_only', 'labels fixture role');
check(
  schema.properties?.evaluatorVersion?.const === evaluator.evaluatorVersion,
  'label schema evaluator drift',
);
check(Array.isArray(labels.labels) && labels.labels.length === 30, 'label count');
const labelIds = labels.labels.map((entry) => entry.caseId);
const labelEvalIds = labels.labels.map((entry) => entry.evalId);
check(unique(labelIds), 'label case IDs are unique');
check(unique(labelEvalIds), 'label eval IDs are unique');
check(
  JSON.stringify([...labelIds].sort()) === JSON.stringify([...manifestIds].sort()),
  'manifest/label case IDs differ',
);
check(
  JSON.stringify([...labelEvalIds].sort((a, b) => a - b)) ===
    JSON.stringify([...manifestEvalIds].sort((a, b) => a - b)),
  'manifest/label eval IDs differ',
);
for (const label of labels.labels) {
  const source = manifest.cases.find((entry) => entry.caseId === label.caseId);
  check(label.heldOut === false, `${label.caseId} incorrectly claims held-out status`);
  check(label.stratum === source?.stratum, `${label.caseId} stratum drift`);
  if (label.stratum === 'sensitive_private') {
    check(
      label.expectedDisposition === 'withhold_sensitive',
      `${label.caseId} sensitive disposition`,
    );
    check(label.mustNotPublish === true, `${label.caseId} sensitive publish gate`);
  }
  if (label.stratum === 'routine_no_finding' || label.stratum === 'wip_or_failed') {
    check(label.expectedDisposition === 'no_finding', `${label.caseId} false-finding disposition`);
    check(label.reusableConceptIds.length === 0, `${label.caseId} should have no reusable concept`);
  }
  if (label.expectedDisposition === 'publish') {
    check(label.reusableConceptIds.length >= 1, `${label.caseId} publish has no concept`);
    check(label.mustNotPublish === false, `${label.caseId} contradictory publish gate`);
  }
}

const labeledConcepts = labels.labels.flatMap((entry) => entry.reusableConceptIds);
check(unique(labeledConcepts), 'a reusable concept is assigned to more than one case');
check(Array.isArray(questions.concepts), 'questions concepts');
const questionConcepts = questions.concepts.map((entry) => entry.conceptId);
check(unique(questionConcepts), 'question concept IDs are unique');
check(
  JSON.stringify([...questionConcepts].sort()) === JSON.stringify([...labeledConcepts].sort()),
  'questions do not cover every labeled concept exactly',
);
const questionIds = [];
for (const concept of questions.concepts) {
  check(
    concept.questions.length >= 2 && concept.questions.length <= 3,
    `${concept.conceptId} needs 2-3 questions`,
  );
  for (const question of concept.questions) {
    questionIds.push(question.questionId);
    check(
      typeof question.text === 'string' && question.text.endsWith('?'),
      `${question.questionId} is not a question`,
    );
  }
}
check(
  Array.isArray(questions.distractors) && questions.distractors.length >= 6,
  'need at least six distractors',
);
for (const question of questions.distractors) questionIds.push(question.questionId);
check(unique(questionIds), 'question IDs are not unique');

check(evals.skill_name === 'tenjin-publish', 'eval skill name');
check(Array.isArray(evals.evals) && evals.evals.length === 30, 'eval case count');
check(unique(evals.evals.map((entry) => entry.id)), 'eval IDs are not unique');
check(
  JSON.stringify(evals.evals.map((entry) => entry.id).sort((a, b) => a - b)) ===
    JSON.stringify([...manifestEvalIds].sort((a, b) => a - b)),
  'eval/manifest IDs differ',
);
for (const entry of evals.evals) {
  check(
    typeof entry.prompt === 'string' && entry.prompt.includes('synthetic'),
    `eval ${entry.id} is not explicitly synthetic`,
  );
  check(
    Array.isArray(entry.files) && entry.files.length === 0,
    `eval ${entry.id} unexpectedly seeds a file`,
  );
  check(
    Array.isArray(entry.expectations) && entry.expectations.length >= 3,
    `eval ${entry.id} expectations`,
  );
}

check(evaluator.predeclaredBars?.routineWipFalseAskRateMax === 0.25, 'false-ask ceiling drift');
check(evaluator.fixtureRole === 'synthetic_smoke_only', 'evaluator fixture role');
check(evaluator.smokeCaseCount === 30, 'evaluator smoke count');
check(
  evaluator.predeclaredBars?.stopContinuation?.p95AdditionalTokensMax === 8000,
  'token ceiling drift',
);
check(evaluator.predeclaredBars?.stopContinuation?.meanCostUsdMax === 0.15, 'cost ceiling drift');

check(controlled.schemaVersion === 1, 'controlled schema version');
check(controlled.fixtureRole === 'synthetic_smoke_only', 'controlled fixture role');
check(controlled.benchmarkStatus === 'non_benchmark_smoke', 'controlled benchmark status');
check(Array.isArray(controlled.cases) && controlled.cases.length > 0, 'controlled cases');
check(controlled.casesSha256 === sha(controlled.cases), 'controlled casesSha256');
const controlledIds = controlled.cases.map((entry) => entry.evalId);
check(unique(controlledIds), 'controlled IDs are not unique');
check(
  controlledIds.every((id) => manifestEvalIds.includes(id)),
  'controlled subset names an unknown eval ID',
);
for (const entry of controlled.cases) {
  check(
    entry !== null &&
      typeof entry === 'object' &&
      Object.keys(entry).sort().join(',') === 'evalId,taskPrompt',
    'controlled case shape',
  );
  check(
    typeof entry.taskPrompt === 'string' &&
      !/\b(?:stop|capture|publish|hook)\b/i.test(entry.taskPrompt),
    `controlled ${entry.evalId} initial task names the mechanism`,
  );
}

check(roles.schemaVersion === 1, 'roles schema version');
check(roles.fixtureRole === 'synthetic_smoke_only', 'roles fixture role');
check(['not_frozen', 'frozen'].includes(roles.status), 'roles status');
if (roles.status === 'frozen') {
  check(/^[0-9a-f]{40}$/.test(roles.baselineCommit), 'baseline role commit');
  check(/^[0-9a-f]{40}$/.test(roles.treatmentCommit), 'treatment role commit');
  check(roles.baselineCommit !== roles.treatmentCommit, 'baseline/treatment role collision');
} else {
  check(roles.baselineCommit === null, 'unfrozen baseline role must be null');
  check(roles.treatmentCommit === null, 'unfrozen treatment role must be null');
}

for (const name of ['baseline.json', 'treatment.json', 'comparison.json', 'dogfood-7d.json']) {
  const report = readJson(`reports/${name}`);
  check(
    ['not_run', 'complete', 'smoke_complete'].includes(report.status),
    `${name} has an unsupported status`,
  );
  check(report.fixtureRole === 'synthetic_smoke_only', `${name} fixture role`);
  if (report.status !== 'not_run') {
    check(report.status === 'smoke_complete', `${name} may complete only as smoke`);
    check(report.schemaVersion === 1 || report.schemaVersion === 2, `${name} schema version`);
  }
  if (name !== 'dogfood-7d.json') {
    check(report.relativeTimingReplayed === false, `${name} relative timing limitation`);
    const limitations =
      report.status === 'not_run' ? report.notMeasured : report.notMeasuredInDeterministicReplay;
    check(Array.isArray(limitations), `${name} timing limitation list`);
    for (const limitation of [
      'long/resumed relative offsets',
      'elapsed-time windows',
      'generation re-arm behavior',
    ]) {
      check(
        limitations?.some((entry) => String(entry).includes(limitation)),
        `${name} missing timing limitation: ${limitation}`,
      );
    }
  }
  if (name === 'comparison.json' && report.status === 'not_run') {
    check(report.consumerUseLane?.status === 'blocked_not_run', 'consumer blocker status');
    check(
      report.consumerUseLane?.blocker === 'ordinary_team_prompt_hook_always_queries_public',
      'consumer blocker reason',
    );
    check(report.consumerUseLane?.publicRequestsMaximum === 0, 'consumer public traffic ceiling');
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`session-capture fixture: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(
  `session-capture fixture ok: ${manifest.cases.length} cases, ${labeledConcepts.length} concepts, ${questionIds.length} questions\n`,
);

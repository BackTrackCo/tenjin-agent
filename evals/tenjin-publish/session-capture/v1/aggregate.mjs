/* global process */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;
    const split = arg.indexOf('=');
    if (split !== -1) {
      out.set(arg.slice(2, split), arg.slice(split + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      out.set(arg.slice(2), value);
      index += 1;
    }
  }
  const baseline = out.get('baseline');
  const treatment = out.get('treatment');
  const output = out.get('out');
  if (baseline === undefined || treatment === undefined || output === undefined) {
    throw new Error('usage: aggregate.mjs --baseline <json> --treatment <json> --out <json>');
  }
  return { baseline, treatment, output };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixtureJson = (name) => readJson(`${here}/${name}`);
const fileSha256 = (name) =>
  createHash('sha256')
    .update(readFileSync(`${here}/${name}`))
    .digest('hex');
const round = (value) => Math.round(value * 10000) / 10000;
const rate = (numerator, denominator) =>
  denominator === 0 ? null : round(numerator / denominator);

function assertThinReport(report, expectedKind) {
  const exact = (value, keys, path) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
    ) {
      throw new Error(`${expectedKind} report shape drifted at ${path}`);
    }
  };
  exact(
    report,
    [
      'schemaVersion',
      'benchmark',
      'fixtureRole',
      'evaluatorVersion',
      'lane',
      'kind',
      'status',
      'sourceCommit',
      'sourceCommitDate',
      'manifestCasesSha256',
      'frozenInputs',
      'disposableGeneratorParity',
      'installedBundleParity',
      'installedSetup',
      'isolation',
      'relativeTimingReplayed',
      'notMeasuredInDeterministicReplay',
      'activityStatePrefix',
      'cases',
    ],
    'report',
  );
  if (report.status !== 'smoke_complete')
    throw new Error(`${expectedKind} replay status is not smoke_complete`);
  if (report.fixtureRole !== 'synthetic_smoke_only')
    throw new Error(`${expectedKind} replay does not declare its smoke-only role`);
  if (report.kind !== expectedKind)
    throw new Error(`expected ${expectedKind} replay, got ${report.kind}`);
  if (report.lane !== 'deterministic_replay')
    throw new Error(`${expectedKind} is not deterministic replay`);
  if (!Array.isArray(report.cases) || report.cases.length !== 30) {
    throw new Error(`${expectedKind} replay does not contain 30 cases`);
  }
  const forbidden = new Set([
    'prompt',
    'question',
    'questions',
    'body',
    'bodyMd',
    'evidence',
    'excerpt',
    'requester',
    'wallet',
    'credential',
    'transcript',
  ]);
  const walk = (value, path = '') => {
    if (Array.isArray(value))
      return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key))
        throw new Error(`${expectedKind} report contains forbidden field ${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(report);
  if (report.activityStatePrefix !== 'capture:activity:') {
    throw new Error(`${expectedKind} replay activity prefix drifted`);
  }
  if (report.relativeTimingReplayed !== false) {
    throw new Error(`${expectedKind} replay must declare relative timing unavailable`);
  }
  if (
    !Array.isArray(report.notMeasuredInDeterministicReplay) ||
    !['long/resumed relative offsets', 'elapsed-time windows', 'generation re-arm behavior'].every(
      (limitation) => report.notMeasuredInDeterministicReplay.includes(limitation),
    )
  ) {
    throw new Error(`${expectedKind} replay timing limitations are incomplete`);
  }
  exact(
    report.frozenInputs,
    ['manifestSha256', 'labelsSha256', 'questionsSha256', 'evaluatorSha256'],
    'frozenInputs',
  );
  exact(
    report.disposableGeneratorParity,
    ['verified', 'normalizedBundleSha256', 'scriptCount'],
    'disposableGeneratorParity',
  );
  exact(
    report.installedBundleParity,
    ['verified', 'normalizedBundleSha256', 'scriptCount'],
    'installedBundleParity',
  );
  exact(
    report.isolation,
    [
      'embeddedDisposableDataDir',
      'runtimeDataDirOverrideUsed',
      'liveHookExecuted',
      'offMachineRequests',
      'loopbackRequests',
    ],
    'isolation',
  );
  exact(
    report.installedSetup,
    ['teamShelfConfigured', 'publishMode', 'hooks', 'claudePushHookEntries'],
    'installedSetup',
  );
  exact(report.installedSetup.publishMode, ['value', 'source'], 'installedSetup.publishMode');
  exact(report.installedSetup.hooks, ['push', 'capture', 'webSearch'], 'installedSetup.hooks');
  for (const name of ['push', 'capture', 'webSearch']) {
    exact(report.installedSetup.hooks[name], ['value', 'source'], `installedSetup.hooks.${name}`);
  }
  exact(
    report.installedSetup.claudePushHookEntries,
    ['present', 'identitiesExact'],
    'installedSetup.claudePushHookEntries',
  );
  for (const [index, entry] of report.cases.entries()) {
    exact(
      entry,
      [
        'caseId',
        'stratum',
        'expectedDisposition',
        'reusableConceptCount',
        'asked',
        'askCount',
        'stopCount',
        'activityDetected',
        'activityRows',
        'activityStateExact',
        'sessionStatePrivacySafe',
        'unexpectedSessionStateRows',
        'firstBackgroundStopAsked',
        'hookRunCount',
        'hookErrorCount',
        'hookWallMs',
        'captureMarkerPresent',
      ],
      `cases[${index}]`,
    );
    exact(entry.hookWallMs, ['total', 'max'], `cases[${index}].hookWallMs`);
  }
  if (
    report.installedBundleParity?.verified !== true ||
    report.disposableGeneratorParity?.verified !== true ||
    report.isolation?.embeddedDisposableDataDir !== true ||
    report.isolation?.runtimeDataDirOverrideUsed !== false ||
    report.isolation?.liveHookExecuted !== false ||
    report.isolation?.offMachineRequests !== 0
  ) {
    throw new Error(`${expectedKind} replay parity/isolation safety gate failed`);
  }
  if (
    report.cases.some(
      (entry) =>
        entry.activityStateExact !== true ||
        entry.sessionStatePrivacySafe !== true ||
        Number(entry.unexpectedSessionStateRows ?? 0) !== 0,
    )
  ) {
    throw new Error(`${expectedKind} replay state-privacy gate failed`);
  }
}

function summary(report, labelByCase) {
  const rows = report.cases.map((entry) => {
    const label = labelByCase.get(entry.caseId);
    if (label === undefined) throw new Error(`unknown case ${entry.caseId}`);
    return { entry, label };
  });
  const eligible = rows.filter(({ label }) => label.expectedDisposition === 'publish');
  const falseAsk = rows.filter(
    ({ label }) => label.stratum === 'routine_no_finding' || label.stratum === 'wip_or_failed',
  );
  const asked = rows.filter(({ entry }) => entry.asked === true);
  const hookRuns = rows.reduce((sum, { entry }) => sum + Number(entry.hookRunCount ?? 0), 0);
  const hookWall = rows.reduce((sum, { entry }) => sum + Number(entry.hookWallMs?.total ?? 0), 0);
  return {
    denominators: {
      labeledSessions: rows.length,
      eligibleSessions: eligible.length,
      routineWipSessions: falseAsk.length,
    },
    eligibleTriggerRecall: {
      numerator: eligible.filter(({ entry }) => entry.asked === true).length,
      denominator: eligible.length,
      rate: rate(eligible.filter(({ entry }) => entry.asked === true).length, eligible.length),
    },
    routineWipFalseAskRate: {
      numerator: falseAsk.filter(({ entry }) => entry.asked === true).length,
      denominator: falseAsk.length,
      rate: rate(falseAsk.filter(({ entry }) => entry.asked === true).length, falseAsk.length),
    },
    askedSessions: asked.length,
    asksPer100LabeledSessions: round(
      (rows.reduce((sum, { entry }) => sum + Number(entry.askCount ?? 0), 0) * 100) / rows.length,
    ),
    activityDetectionRate: rate(
      rows.filter(({ entry }) => entry.activityDetected === true).length,
      rows.length,
    ),
    onceViolations: rows.filter(({ entry }) => Number(entry.askCount ?? 0) > 1).length,
    backgroundEarlyAsks: rows.filter(({ entry }) => entry.firstBackgroundStopAsked === true).length,
    inexactActivityStateRows: rows.filter(({ entry }) => entry.activityStateExact !== true).length,
    unsafeSessionStateRows: rows.filter(({ entry }) => entry.sessionStatePrivacySafe !== true)
      .length,
    hookErrors: rows.reduce((sum, { entry }) => sum + Number(entry.hookErrorCount ?? 0), 0),
    hookWallMs: {
      runs: hookRuns,
      mean: hookRuns === 0 ? null : round(hookWall / hookRuns),
      total: round(hookWall),
    },
  };
}

function delta(baseline, treatment) {
  const subtract = (a, b) => (a === null || b === null ? null : round(b - a));
  return {
    eligibleTriggerRecallRate: subtract(
      baseline.eligibleTriggerRecall.rate,
      treatment.eligibleTriggerRecall.rate,
    ),
    routineWipFalseAskRate: subtract(
      baseline.routineWipFalseAskRate.rate,
      treatment.routineWipFalseAskRate.rate,
    ),
    askedSessions: treatment.askedSessions - baseline.askedSessions,
    asksPer100LabeledSessions: subtract(
      baseline.asksPer100LabeledSessions,
      treatment.asksPer100LabeledSessions,
    ),
    activityDetectionRate: subtract(
      baseline.activityDetectionRate,
      treatment.activityDetectionRate,
    ),
    hookMeanWallMs: subtract(baseline.hookWallMs.mean, treatment.hookWallMs.mean),
  };
}

function main() {
  const paths = args(process.argv.slice(2));
  const baselineReport = readJson(paths.baseline);
  const treatmentReport = readJson(paths.treatment);
  assertThinReport(baselineReport, 'baseline');
  assertThinReport(treatmentReport, 'treatment');
  for (const field of ['benchmark', 'evaluatorVersion', 'manifestCasesSha256']) {
    if (baselineReport[field] !== treatmentReport[field]) {
      throw new Error(`baseline/treatment ${field} mismatch`);
    }
  }
  if (
    JSON.stringify(baselineReport.frozenInputs) !== JSON.stringify(treatmentReport.frozenInputs)
  ) {
    throw new Error('baseline/treatment frozen input hashes mismatch');
  }
  const labels = fixtureJson('labels.json');
  const evaluator = fixtureJson('evaluator.json');
  const manifest = fixtureJson('manifest.json');
  const roles = fixtureJson('roles.json');
  const localFrozenInputs = {
    manifestSha256: fileSha256('manifest.json'),
    labelsSha256: fileSha256('labels.json'),
    questionsSha256: fileSha256('questions.json'),
    evaluatorSha256: fileSha256('evaluator.json'),
  };
  for (const [kind, report] of [
    ['baseline', baselineReport],
    ['treatment', treatmentReport],
  ]) {
    if (JSON.stringify(report.frozenInputs) !== JSON.stringify(localFrozenInputs)) {
      throw new Error(`${kind} replay does not bind the current frozen fixture bytes`);
    }
  }
  if (
    roles.status !== 'frozen' ||
    !/^[0-9a-f]{40}$/.test(roles.baselineCommit ?? '') ||
    !/^[0-9a-f]{40}$/.test(roles.treatmentCommit ?? '') ||
    roles.baselineCommit === roles.treatmentCommit
  ) {
    throw new Error('baseline/treatment roles are not frozen to distinct full commits');
  }
  if (
    baselineReport.sourceCommit !== roles.baselineCommit ||
    treatmentReport.sourceCommit !== roles.treatmentCommit
  ) {
    throw new Error('baseline/treatment reports do not match frozen source roles');
  }
  if (labels.evaluatorVersion !== baselineReport.evaluatorVersion) {
    throw new Error('replay evaluator version does not match frozen labels');
  }
  const labelByCase = new Map(labels.labels.map((label) => [label.caseId, label]));
  const expectedIds = manifest.cases.map((entry) => entry.caseId);
  for (const [kind, report] of [
    ['baseline', baselineReport],
    ['treatment', treatmentReport],
  ]) {
    const ids = report.cases.map((entry) => entry.caseId);
    if (new Set(ids).size !== ids.length) throw new Error(`${kind} case IDs are not unique`);
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...expectedIds].sort())) {
      throw new Error(`${kind} case IDs differ from the frozen manifest`);
    }
  }
  const baseline = summary(baselineReport, labelByCase);
  const treatment = summary(treatmentReport, labelByCase);
  const falseAskCeiling = evaluator.predeclaredBars.routineWipFalseAskRateMax;
  const aggregate = {
    schemaVersion: 1,
    benchmark: baselineReport.benchmark,
    evaluatorVersion: baselineReport.evaluatorVersion,
    lane: 'deterministic_replay',
    fixtureRole: 'synthetic_smoke_only',
    status: 'smoke_complete',
    sourceCommits: {
      baseline: baselineReport.sourceCommit,
      treatment: treatmentReport.sourceCommit,
    },
    manifestCasesSha256: baselineReport.manifestCasesSha256,
    relativeTimingReplayed: false,
    baseline,
    treatment,
    delta: delta(baseline, treatment),
    predeclaredBars: {
      routineWipFalseAskRateMax: falseAskCeiling,
      treatmentRoutineWipFalseAskPass:
        treatment.routineWipFalseAskRate.rate !== null &&
        treatment.routineWipFalseAskRate.rate <= falseAskCeiling,
      zeroInexactActivityStateRowsPass: treatment.inexactActivityStateRows === 0,
      zeroUnsafeSessionStateRowsPass: treatment.unsafeSessionStateRows === 0,
      zeroBackgroundEarlyAsksPass: treatment.backgroundEarlyAsks === 0,
      zeroOnceViolationsPass: treatment.onceViolations === 0,
      zeroHookErrorsPass: treatment.hookErrors === 0,
    },
    notMeasuredInDeterministicReplay: [
      'publication precision and false publication by class',
      'publication receipts, no_finding, withheld, hard-block, duplicate, and unknown-write rates',
      'human intervention, Stop continuation tokens, model cost, and publish latency',
      'retrieval outcomes, expired-piece exclusion, and duplicate-equivalent interference',
      'consumer used, rejected, unobserved, ungraded, posted, and outcome coverage',
      'long/resumed relative offsets, elapsed-time windows, and generation re-arm behavior',
    ],
  };
  writeFileSync(paths.output, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote thin deterministic comparison to ${paths.output}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `session-capture aggregate: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

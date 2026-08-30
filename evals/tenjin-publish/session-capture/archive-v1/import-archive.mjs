/* global process */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');
const EXPECTED_SOURCE_FILE_SHA256 =
  '3f621097147c8207fcc206468bc0a1354167fd1cb4e7303209b1a3bd9daf9434';
const EXPECTED_SOURCE_SESSIONS_SHA256 =
  '3a0432f4850104e00d571584fac187143d59c0c57f1fcaa3ddc74c982e351353';
const FEATURE_KEYS = [
  'asks',
  'bash',
  'dispatch',
  'end',
  'grepglob',
  'mcp_search',
  'mutations',
  'publish_attempts',
  'publish_ok',
  'publish_ok_after_ask',
  'reads',
  'repo_activity',
  'research_signal',
  'start',
  'subagents',
  'tenjin_search',
  'web',
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const source = values.get('source');
  const archiveRoot = values.get('archive-root');
  const mappingOut = values.get('mapping-out');
  const out = values.get('out') ?? join(here, 'manifest.json');
  if (source === undefined || archiveRoot === undefined || mappingOut === undefined) {
    throw new Error(
      'usage: import-archive.mjs --source <recorded-manifest> --archive-root <claude-projects> --mapping-out <outside-repo-json> [--out <sanitized-json>]',
    );
  }
  return {
    source: resolve(source),
    archiveRoot: resolve(archiveRoot),
    mappingOut: resolve(mappingOut),
    out: resolve(out),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

const shaBytes = (value) => createHash('sha256').update(value).digest('hex');
const sha = (value) => shaBytes(JSON.stringify(stable(value)));
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

function transcriptIndex(root, wanted) {
  const found = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = basename(entry.name, '.jsonl');
      if (!wanted.has(id)) continue;
      if (found.has(id)) throw new Error('a recorded root transcript has multiple archive copies');
      found.set(id, path);
    }
  };
  visit(root);
  return found;
}

function privateTranscriptSignals(path) {
  let privateSourceMaterial = false;
  let linkedRepoChange = false;
  let incompleteWorkSignal = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      record?.type === 'pr-link' &&
      /(?:^|\/)tenjin(?:-agent)?$/.test(String(record.prRepository ?? ''))
    ) {
      linkedRepoChange = true;
    }
    if (record?.type === 'assistant' && record?.isSidechain !== true) {
      const content = record?.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
                .map((entry) => entry.text)
                .join('\n')
            : '';
      if (
        /\b(?:blocked|not completed|incomplete|could not|couldn.t|unable to|still failing|tests? fail(?:ed|ing)?|remaining work|not implemented|needs follow-up|timed out)\b/i.test(
          text,
        )
      ) {
        incompleteWorkSignal = true;
      }
    }
    if (
      record?.type !== 'user' ||
      record?.isMeta === true ||
      record?.isSidechain === true ||
      record?.sourceToolAssistantUUID !== undefined
    ) {
      continue;
    }
    if (Array.isArray(record.imagePasteIds) && record.imagePasteIds.length > 0) {
      privateSourceMaterial = true;
    }
    const content = record?.message?.content;
    if (
      Array.isArray(content) &&
      content.some((entry) => entry?.type === 'image' || entry?.type === 'document')
    ) {
      privateSourceMaterial = true;
    }
  }
  return { privateSourceMaterial, linkedRepoChange, incompleteWorkSignal };
}

function duration(row) {
  return Math.max(0, Date.parse(row.end) - Date.parse(row.start));
}

function durationBucket(row) {
  const milliseconds = duration(row);
  if (milliseconds < 5 * 60 * 1000) return 'brief';
  if (milliseconds < 2 * 60 * 60 * 1000) return 'bounded';
  if (milliseconds < 8 * 60 * 60 * 1000) return 'extended';
  return 'long_or_resumed';
}

function activity(row) {
  return row.reads + row.mutations + row.bash + row.grepglob;
}

function deterministicRank(row, salt) {
  return shaBytes(`${salt}:${row.session}`);
}

function choose(rows, used, count, predicate, compare) {
  const available = rows.filter((row) => !used.has(row.session) && predicate(row));
  available.sort(compare);
  if (available.length < count) throw new Error('recorded archive cannot fill a selection stratum');
  const selected = available.slice(0, count);
  for (const row of selected) used.add(row.session);
  return selected;
}

function select(rows) {
  const used = new Set();
  const descending = (score, salt) => (a, b) =>
    score(b) - score(a) || deterministicRank(a, salt).localeCompare(deterministicRank(b, salt));
  const ascending = (score, salt) => (a, b) =>
    score(a) - score(b) || deterministicRank(a, salt).localeCompare(deterministicRank(b, salt));

  const reusable = choose(
    rows,
    used,
    6,
    (row) =>
      row.repo_activity === true &&
      row.mutations > 0 &&
      row.research_signal === false &&
      row.linkedRepoChange === true,
    descending((row) => row.mutations * 1000 + activity(row), 'reusable'),
  );
  const routine = choose(
    rows,
    used,
    6,
    (row) =>
      row.publish_attempts === 0 &&
      row.research_signal === false &&
      row.mutations === 0 &&
      row.subagents === 0,
    ascending((row) => activity(row), 'routine'),
  );
  // Reserve the high-duration/multi-agent cases before selecting incomplete
  // work. This keeps the two classes disjoint without using raw text as output.
  const long = choose(
    rows,
    used,
    6,
    (row) => duration(row) >= 8 * 60 * 60 * 1000 || row.subagents > 0,
    descending((row) => Math.floor(duration(row) / 1000) + row.subagents * 100000, 'long'),
  );
  const wip = choose(
    rows,
    used,
    6,
    (row) =>
      row.mutations > 0 &&
      row.publish_ok === 0 &&
      row.linkedRepoChange === false &&
      row.incompleteWorkSignal === true,
    descending((row) => row.mutations * 1000 + row.bash, 'wip'),
  );
  const privacyReview = choose(
    rows,
    used,
    6,
    (row) => row.privateSourceMaterial === true,
    (a, b) =>
      deterministicRank(a, 'privacy-review').localeCompare(deterministicRank(b, 'privacy-review')),
  );
  return [
    ...reusable.map((row) => ({ row, selectionStratum: 'reusable_repo_finding' })),
    ...routine.map((row) => ({ row, selectionStratum: 'routine_no_finding' })),
    ...wip.map((row) => ({ row, selectionStratum: 'wip_or_failed' })),
    ...privacyReview.map((row) => ({ row, selectionStratum: 'sensitive_private_material' })),
    ...long.map((row) => ({ row, selectionStratum: 'long_or_resumed' })),
  ];
}

function validateSource(raw, source) {
  if (shaBytes(raw) !== EXPECTED_SOURCE_FILE_SHA256) {
    throw new Error('recorded source manifest file hash does not match the frozen baseline');
  }
  if (
    source?.sha256 !== EXPECTED_SOURCE_SESSIONS_SHA256 ||
    source?.n !== 111 ||
    !Array.isArray(source.sessions) ||
    source.sessions.length !== 111
  ) {
    throw new Error('recorded source manifest declaration does not match the frozen baseline');
  }
  for (const row of source.sessions) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.session !== 'string' ||
      JSON.stringify(Object.keys(row).sort()) !==
        JSON.stringify([...FEATURE_KEYS, 'session'].sort())
    ) {
      throw new Error('recorded source manifest row shape drifted');
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.archiveRoot) || !statSync(args.archiveRoot).isDirectory()) {
    throw new Error('Claude archive root is missing');
  }
  if (inside(repoRoot, args.mappingOut)) {
    throw new Error('raw-to-opaque mapping must be written outside the repository');
  }
  if (existsSync(args.mappingOut)) {
    throw new Error('mapping output already exists; refusing to overwrite private provenance');
  }
  const raw = readFileSync(args.source);
  const source = JSON.parse(raw.toString('utf8'));
  validateSource(raw, source);
  const archiveIndex = transcriptIndex(
    args.archiveRoot,
    new Set(source.sessions.map((row) => row.session)),
  );
  const available = source.sessions
    .filter((row) => archiveIndex.has(row.session))
    .map((row) => {
      const signals = privateTranscriptSignals(archiveIndex.get(row.session));
      return {
        ...row,
        // These private booleans are used only for selection. Neither attachment
        // content nor raw pull-request/session identifiers enter committed files.
        ...signals,
      };
    });
  const selected = select(available);
  const cases = selected.map(({ row, selectionStratum }, index) => {
    return {
      caseId: `arcv1_${shaBytes(`session-capture/archive-v1:${String(index + 1).padStart(2, '0')}`).slice(0, 12)}`,
      selectionStratum,
      root: true,
      durationBucket: durationBucket(row),
      activityClasses: {
        inspection: row.reads > 0 || row.grepglob > 0,
        mutation: row.mutations > 0,
        shell: row.bash > 0,
      },
      researchSignalPresent: row.research_signal === true,
      hasSubagents: row.subagents > 0,
    };
  });
  const mapping = selected.map(({ row }, position) => ({
    caseId: cases[position].caseId,
    sourceSession: row.session,
    transcriptPath: archiveIndex.get(row.session),
    sourceManifestRow: Object.fromEntries(
      [...FEATURE_KEYS, 'session'].map((key) => [key, row[key]]),
    ),
  }));
  const manifest = {
    schemaVersion: 1,
    benchmark: 'session-capture/archive-v1',
    fixtureRole: 'held_out_recorded_archive',
    frozenAt: source.frozenAt,
    source: {
      manifestFileSha256: EXPECTED_SOURCE_FILE_SHA256,
      canonicalSessionsSha256: EXPECTED_SOURCE_SESSIONS_SHA256,
      rootSessionCount: source.n,
      archivedTranscriptCount: available.length,
      rawMapping: 'local_uncommitted_mode_0600',
    },
    selection: {
      kind: 'deterministic_private_review_stratified_root_sessions',
      algorithmVersion: 'archive-v1-selection/2.0.0',
      heldOut: true,
      caseCount: cases.length,
      treatmentOutputInspected: false,
    },
    casesSha256: sha(cases),
    cases,
  };

  const mappingFd = openSync(args.mappingOut, 'wx', 0o600);
  try {
    writeFileSync(
      mappingFd,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceManifestFileSha256: EXPECTED_SOURCE_FILE_SHA256,
          casesSha256: manifest.casesSha256,
          mapping,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    closeSync(mappingFd);
    chmodSync(args.mappingOut, 0o600);
  }
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `archive import ok: ${available.length}/111 transcripts available, 30 opaque held-out cases written; raw mapping kept outside repository\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `session-capture archive import: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CliError } from '../lib/errors';
import { createCandidate, dropCandidate, listCandidates } from '../lib/candidate-store';
import { UUID_RE } from '../lib/ids';
import { sanitizeForTerminal } from '../lib/output';
import { pathExists } from '../lib/settings';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin candidate [add|list|drop]`: the D40 local store of parked publish
 * drafts. Entirely offline — a candidate never touches the network and never
 * uploads; only a later `tenjin publish --candidate <id>` sends it, under the
 * D38 consent scan. This module owns the command surface; lib/candidate-store.ts
 * owns the on-disk custody (0700 dirs, 0600 files, atomic meta commit).
 */

export interface CandidateAddArgs {
  file: string;
  lookupId: string;
  question?: string;
}

export interface CandidateDeps {
  /** Clock seam so list ordering / age tests are deterministic. */
  now?: () => Date;
  /** cwd seam so sourceProject discovery is testable against a temp tree. */
  cwd?: string;
}

export async function runCandidateAdd(
  args: CandidateAddArgs,
  ctx: CommandContext,
  deps: CandidateDeps = {},
): Promise<CommandResult> {
  if (!UUID_RE.test(args.lookupId)) {
    throw new CliError('USAGE', `Invalid --lookup-id: ${JSON.stringify(args.lookupId)}.`, {
      fix: 'Pass the lookupId from a prior `tenjin lookup` (a uuid).',
    });
  }
  // Cap the question at the server's questionsAnswered item bound (200) at PARK
  // time, so a candidate can never be born unpublishable — it prefills the card's
  // questionsAnswered, which publish would otherwise reject only at write time.
  if (args.question !== undefined && args.question.length > 200) {
    throw new CliError('USAGE', 'A candidate --question is at most 200 characters.', {
      fix: 'Shorten the question to 200 characters or fewer.',
    });
  }

  let draft: string;
  try {
    draft = await readFile(args.file, 'utf8');
  } catch (err) {
    throw new CliError('USAGE', `Cannot read draft file ${JSON.stringify(args.file)}.`, {
      fix: 'Pass a path to a readable Markdown file.',
      cause: err,
    });
  }

  const cwd = deps.cwd ?? process.cwd();
  const sourceProject = await repoRootOrCwd(cwd);
  const created = (deps.now?.() ?? new Date()).toISOString();

  const record = await createCandidate(ctx.dataDir, {
    draft,
    lookupId: args.lookupId,
    ...(args.question !== undefined ? { question: args.question } : {}),
    created,
    sourceProject,
  });

  return {
    data: {
      id: record.id,
      path: record.dir,
      lookupId: record.meta.lookupId,
      ...(record.meta.question !== undefined ? { question: record.meta.question } : {}),
      created: record.meta.created,
      sourceProject: record.meta.sourceProject,
    },
    humanLines: [`Parked candidate ${record.id}`, `  ${record.dir}`],
  };
}

export async function runCandidateList(
  ctx: CommandContext,
  deps: CandidateDeps = {},
): Promise<CommandResult> {
  const now = deps.now?.() ?? new Date();
  const records = await listCandidates(ctx.dataDir);

  const candidates = records.map((r) => ({
    id: r.id,
    lookupId: r.meta.lookupId,
    ...(r.meta.question !== undefined ? { question: r.meta.question } : {}),
    created: r.meta.created,
    sourceProject: r.meta.sourceProject,
    path: r.dir,
  }));

  const humanLines =
    records.length === 0
      ? ['No pending candidates.']
      : records.map((r) => {
          const q =
            r.meta.question !== undefined ? sanitizeForTerminal(r.meta.question) : '(no question)';
          return `${r.id}  ${humanizeAge(r.meta.created, now)}  ${q}  [${sanitizeForTerminal(
            r.meta.sourceProject,
          )}]`;
        });

  return { data: { candidates }, humanLines };
}

export async function runCandidateDrop(
  args: { id: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  const dropped = await dropCandidate(ctx.dataDir, args.id);
  if (!dropped) {
    throw new CliError('USAGE', `No candidate with id ${JSON.stringify(args.id)}.`, {
      fix: 'Run `tenjin candidate list` to see pending candidate ids.',
    });
  }
  return {
    data: { id: args.id, dropped: true },
    humanLines: [`Dropped candidate ${args.id}.`],
  };
}

/**
 * The project a candidate was parked from: the nearest ancestor holding a `.git`
 * (inclusive), or the cwd when the add did not run inside a repo. Mirrors the
 * repo-root walk settings.ts uses to bound the `.tenjin.json` search.
 */
async function repoRootOrCwd(cwd: string): Promise<string> {
  let dir = resolve(cwd);
  for (;;) {
    if (await pathExists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative age for the human list ("just now", "5m ago", "3d ago"). A
 * future or unparseable timestamp degrades to "just now" rather than throwing;
 * the ISO value is always carried verbatim in the JSON data for machines.
 */
function humanizeAge(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'just now';
  const ms = now.getTime() - then;
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

import { readdir, stat } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { isGitRepo, runGit } from '../lib/notes';
import { notesDir } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin team init|sync`: the sidecar notes repo every `tenjin notes` command
 * reads and writes. Unlike `notes add|rm`'s best-effort git sync (the note is
 * already saved either way), git IS the point here — a clone or a sync that
 * fails is this command's whole job failing, so both throw rather than warn.
 */

export interface TeamInitArgs {
  gitUrl: string;
}

export async function runTeamInit(args: TeamInitArgs, ctx: CommandContext): Promise<CommandResult> {
  const dir = notesDir(ctx.dataDir);
  if (await pathExists(dir)) {
    const isRepo = await isGitRepo(dir);
    const empty = isRepo ? false : await isEmptyDir(dir);
    if (isRepo || !empty) {
      throw new CliError(
        'USAGE',
        `${dir} already ${isRepo ? 'is a team notes repo' : 'has content'}; \`tenjin team init\` will not overwrite it.`,
        {
          fix: isRepo
            ? 'Run `tenjin team sync` to pull the latest notes.'
            : `Remove or empty ${dir}, then retry \`tenjin team init <git-url>\`.`,
        },
      );
    }
  }
  const clone = await runGit(['clone', args.gitUrl, dir], process.cwd());
  if (!clone.ok) {
    throw new CliError(
      'INTERNAL',
      `git clone failed: ${clone.timedOut ? 'timed out' : clone.stderr || `exit ${clone.code}`}`,
      { fix: 'Check the git URL and your credentials, then retry.' },
    );
  }
  return { data: { dir }, humanLines: [`Cloned team notes into ${dir}.`] };
}

export async function runTeamSync(ctx: CommandContext): Promise<CommandResult> {
  const dir = notesDir(ctx.dataDir);
  if (!(await isGitRepo(dir))) {
    throw new CliError('USAGE', `${dir} is not a team notes repo.`, {
      fix: 'Run `tenjin team init <git-url>` first.',
    });
  }
  const pull = await runGit(['pull', '--rebase'], dir);
  if (!pull.ok) {
    throw new CliError(
      'INTERNAL',
      `git pull --rebase failed: ${pull.timedOut ? 'timed out' : pull.stderr || `exit ${pull.code}`}`,
      { fix: `Resolve it in ${dir}, then retry \`tenjin team sync\`.` },
    );
  }
  const push = await runGit(['push'], dir);
  if (!push.ok) {
    throw new CliError(
      'INTERNAL',
      `git push failed: ${push.timedOut ? 'timed out' : push.stderr || `exit ${push.code}`}`,
      { fix: 'Check your git remote/credentials, then retry `tenjin team sync`.' },
    );
  }
  return { data: { dir }, humanLines: [`Synced ${dir} with the team notes repo.`] };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

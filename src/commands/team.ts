import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
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

export interface TeamInitDeps {
  /** Seam for the clone itself. The case worth testing is the one git cannot be
   *  asked to produce on demand: a clone KILLED at the timeout, which leaves its
   *  half-written directory behind (git only tidies up after its own errors). */
  git?: typeof runGit;
}

/**
 * A clone is a network operation over a repo of unknown size, so it gets its own
 * budget rather than `runGit`'s 10s default — that default is sized for the
 * local, one-object operations `notes add` does, and it turned a large or slow
 * team repo into a hard failure that no retry could get past.
 */
const CLONE_TIMEOUT_MS = 120_000;

/** Transports a clone URL may name. Deliberately short, and \`ext\` is the one
 *  that matters by its absence: \`ext::sh -c '<anything>'\` is a documented git
 *  transport that RUNS A SHELL COMMAND during clone, so a URL is not merely an
 *  address — it is potentially a program. */
const CLONE_SCHEMES = new Set(['ssh', 'https', 'git', 'file']);
/** \`git@github.com:org/repo.git\`, the form everyone actually pastes. The
 *  negative lookahead keeps it from swallowing a \`scheme://\` that got here by
 *  another route. */
const SCP_LIKE_RE = /^[A-Za-z0-9._~-]+@[A-Za-z0-9._-]+:(?!\/\/)/;
/** A local path, which is what a bare origin on a shared mount looks like. */
const LOCAL_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

/**
 * The URL goes into git's argv, so it is checked before it gets there.
 *
 * TWO SEPARATE HOLES, both closed here. A value starting with \`-\` is not an
 * argument to \`clone\` at all, it is an OPTION to it — \`--upload-pack=<cmd>\`
 * runs \`<cmd>\` on the way past, and argv arrays do not help because the
 * problem is git's own parsing, not the shell's. And \`ext::\` is a transport
 * whose whole purpose is executing a command, so even a well-formed URL can be
 * a payload. Hence: never a leading dash, and only transports that transport.
 */
function assertCloneUrl(gitUrl: string): void {
  const refuse = (why: string): never => {
    throw new CliError('USAGE', `${why}`, {
      fix: 'Pass an https://, ssh://, git://, file:// URL, a git@host:org/repo.git address, or an absolute local path.',
    });
  };
  if (gitUrl.trim() === '') refuse('`tenjin team init` needs a git URL.');
  // No regex: a control-character class is exactly what `no-control-regex`
  // exists to flag, and the check reads more plainly this way anyway.
  for (const ch of gitUrl) {
    if (ch.codePointAt(0)! < 0x20) refuse('That git URL contains a control character.');
  }
  // Before anything else: git reads it as an option, not as a repository.
  if (gitUrl.startsWith('-')) {
    refuse(`git would read ${JSON.stringify(gitUrl)} as an option, not a repository.`);
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(gitUrl)?.[1];
  if (scheme !== undefined && !LOCAL_PATH_RE.test(gitUrl) && !SCP_LIKE_RE.test(gitUrl)) {
    if (!CLONE_SCHEMES.has(scheme.toLowerCase())) {
      refuse(
        `${JSON.stringify(scheme)} is not a git transport \`tenjin team init\` will clone from.`,
      );
    }
    return;
  }
  if (SCP_LIKE_RE.test(gitUrl) || LOCAL_PATH_RE.test(gitUrl)) return;
  refuse(`${JSON.stringify(gitUrl)} is not a git URL this command recognizes.`);
}

export async function runTeamInit(
  args: TeamInitArgs,
  ctx: CommandContext,
  deps: TeamInitDeps = {},
): Promise<CommandResult> {
  assertCloneUrl(args.gitUrl);
  const dir = notesDir(ctx.dataDir);
  const preExisted = await pathExists(dir);
  if (preExisted) {
    const isRepo = await isGitRepo(dir);
    const empty = isRepo ? false : await isEmptyDir(dir);
    if (isRepo || !empty) {
      const isDir = await lstat(dir)
        .then((e) => e.isDirectory())
        .catch(() => false);
      throw new CliError(
        'USAGE',
        `${dir} already ${isRepo ? 'is a team notes repo' : isDir ? 'has content' : 'exists and is not a directory'}; \`tenjin team init\` will not overwrite it.`,
        {
          fix: isRepo
            ? 'Run `tenjin team sync` to pull the latest notes.'
            : `Remove or empty ${dir}, then retry \`tenjin team init <git-url>\`.`,
        },
      );
    }
  }
  const clone = await (deps.git ?? runGit)(
    ['clone', args.gitUrl, dir],
    process.cwd(),
    CLONE_TIMEOUT_MS,
  );
  if (!clone.ok) {
    // A KILLED CLONE LEAVES THE DIRECTORY BEHIND, half written. That half is
    // worse than nothing: it is not a repo, so `team sync` refuses it, and it is
    // not empty, so the guard above refuses the retry this error tells the
    // operator to run — the command would be permanently stuck on its own
    // wreckage. Removing it puts the machine back exactly where it started;
    // where the directory was the operator's own (empty) one, it is put back.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (preExisted) await mkdir(dir, { recursive: true }).catch(() => {});
    throw new CliError(
      'INTERNAL',
      `git clone failed: ${clone.timedOut ? `timed out after ${CLONE_TIMEOUT_MS / 1000}s` : clone.stderr || `exit ${clone.code}`}`,
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

/**
 * An empty DIRECTORY, and nothing else.
 *
 * WHAT THIS ANSWERS AUTHORIZES A DELETE. "Empty" is what lets `team init` past
 * its own overwrite guard, and a failed clone then `rm -rf`s the path. So the
 * old shape — true on any readdir error — handed that authorization to every
 * case it could not look at: a regular file at the path raises ENOTDIR, read as
 * "empty", cloned over, and deleted on the way out. A symlink is worse, because
 * the thing it names is somebody else's.
 *
 * Only a real directory (lstat, so a link to one does not count) that readdir
 * reports as having nothing in it. Everything else, including every error, is
 * NOT empty: "I could not look" must never mean "there is nothing there".
 */
async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    if (!(await lstat(dir)).isDirectory()) return false;
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

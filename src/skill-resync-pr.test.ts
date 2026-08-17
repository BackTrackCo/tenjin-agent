import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * scripts/open-skill-resync-pr.sh holds a write token on the scheduled path, so its
 * decisions are pinned here rather than trusted to survive an edit: which pull
 * requests may steer a run (same-repo only), when the push is forced, and when the
 * run refuses to touch anything.
 *
 * Each case drives the REAL script against a throwaway bare remote, with only the
 * two things it cannot own stubbed: the network sync and `gh`.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/open-skill-resync-pr.sh', import.meta.url));
const MIRROR = 'skills/tenjin/SKILL.md';
const BRANCH = 'bot/skill-resync';
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

/** A mirror shaped like the real one: frontmatter, then body. */
const mirror = (body: string, description = 'zero-install skill', name = 'tenjin'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const NAME_PREFIX = 'FRONTMATTER NAME CHANGED: ';

type Pr = { number: number; isCrossRepository: boolean };

interface Lab {
  work: string;
  origin: string;
  stubs: string;
  ghLog: string;
  raceMarker: string;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const commitAll = (cwd: string, message: string): void => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', message);
};

/**
 * Models `gh` closely enough for the one behaviour that matters: `pr list --head`
 * matches on the head-ref NAME, so it returns fork pull requests too, and only a
 * query that both asks for `isCrossRepository` and selects on it filters them out.
 * Drop that predicate from the script and this stub starts handing back the fork,
 * which is exactly the regression the fork case below catches. Mutating calls are
 * logged as JSON lines so bodies survive intact.
 */
const GH_STUB = `import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : '');
if (argv[0] === 'pr' && argv[1] === 'list') {
  const prs = JSON.parse(process.env.GH_STUB_PRS ?? '[]');
  const filtersForks =
    value('--json').includes('isCrossRepository') &&
    value('--jq').includes('isCrossRepository == false');
  const visible = filtersForks ? prs.filter((pr) => !pr.isCrossRepository) : prs;
  process.stdout.write(visible.length > 0 ? String(visible[0].number) + '\\n' : '');
} else if (argv[0] === 'pr' && argv[1] === 'view') {
  const wantsTitle = value('--json').includes('title');
  process.stdout.write((wantsTitle ? process.env.GH_STUB_TITLE : process.env.GH_STUB_BODY) ?? '');
} else {
  // Inline --body-file so an assertion sees the body itself; the script's trap
  // deletes the file before the test could read it.
  const at = argv.indexOf('--body-file');
  const logged =
    at >= 0
      ? [...argv.slice(0, at), '--body', readFileSync(argv[at + 1], 'utf8'), ...argv.slice(at + 2)]
      : argv;
  appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(logged) + '\\n');
}
`;

/** Stubbed sync: writes whatever the scenario says the live source now serves. */
const SYNC_STUB = `import { writeFileSync } from 'node:fs';
writeFileSync('${MIRROR}', process.env.SYNC_OUTPUT, 'utf8');
`;

function makeLab(mainMirror: string): Lab {
  const root = mkdtempSync(join(tmpdir(), 'skill-resync-'));
  const lab: Lab = {
    work: join(root, 'work'),
    origin: join(root, 'origin.git'),
    stubs: join(root, 'stubs'),
    ghLog: join(root, 'gh.log'),
    raceMarker: join(root, 'raced'),
  };

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', lab.origin]);
  execFileSync('git', ['clone', '--quiet', lab.origin, lab.work]);

  mkdirSync(join(lab.work, 'scripts'), { recursive: true });
  mkdirSync(join(lab.work, 'skills', 'tenjin'), { recursive: true });
  mkdirSync(join(lab.work, '.changeset'), { recursive: true });
  writeFileSync(join(lab.work, 'scripts', 'sync-skill.mjs'), SYNC_STUB);
  writeFileSync(join(lab.work, MIRROR), mainMirror);
  commitAll(lab.work, 'init');
  git(lab.work, 'branch', '-M', 'main');
  git(lab.work, 'push', '--quiet', '-u', 'origin', 'main');

  mkdirSync(lab.stubs, { recursive: true });
  writeFileSync(join(lab.stubs, 'gh-stub.mjs'), GH_STUB);
  writeFileSync(
    join(lab.stubs, 'gh'),
    `#!/bin/sh\nexec node "${join(lab.stubs, 'gh-stub.mjs')}" "$@"\n`,
  );
  chmodSync(join(lab.stubs, 'gh'), 0o755);
  writeFileSync(lab.ghLog, '');
  return lab;
}

/** Seed an existing bot branch on the remote, from a clone the run never sees. */
function seedBotBranch(lab: Lab, body: string): string {
  const side = mkdtempSync(join(tmpdir(), 'skill-resync-side-'));
  const clone = join(side, 'clone');
  execFileSync('git', ['clone', '--quiet', lab.origin, clone]);
  git(clone, 'switch', '--quiet', '-c', BRANCH);
  writeFileSync(join(clone, MIRROR), mirror(body));
  commitAll(clone, 'earlier resync');
  git(clone, 'push', '--quiet', 'origin', BRANCH);
  return git(clone, 'rev-parse', 'HEAD').trim();
}

/**
 * A `git` shim that lets a third party push to the bot branch in the window
 * between the script's fetch and its push, so the unforced-push guarantee is
 * tested rather than asserted.
 */
function installRacingGit(lab: Lab): void {
  const shim = `#!/bin/sh
"${REAL_GIT}" "$@"; rc=$?
if [ "$1" = "fetch" ] && [ ! -f "${lab.raceMarker}" ]; then
  touch "${lab.raceMarker}"
  rm -rf "${lab.work}.other"
  "${REAL_GIT}" clone --quiet -b ${BRANCH} "${lab.origin}" "${lab.work}.other"
  cd "${lab.work}.other" || exit $rc
  "${REAL_GIT}" -c user.name=other -c user.email=other@example.com commit --quiet --allow-empty -m "third-party push"
  "${REAL_GIT}" push --quiet origin ${BRANCH}
fi
exit $rc
`;
  writeFileSync(join(lab.stubs, 'git'), shim);
  chmodSync(join(lab.stubs, 'git'), 0o755);
}

interface Run {
  status: number;
  output: string;
}

/** State of the open PR the run will find, when a scenario has one. */
interface OpenPr {
  body?: string;
  title?: string;
}

function run(lab: Lab, syncOutput: string, prs: Pr[] = [], open: OpenPr = {}): Run {
  const options = {
    cwd: lab.work,
    encoding: 'utf8' as const,
    env: {
      ...process.env,
      PATH: `${lab.stubs}:${process.env.PATH ?? ''}`,
      SYNC_OUTPUT: syncOutput,
      GH_STUB_PRS: JSON.stringify(prs),
      GH_STUB_BODY: open.body ?? '',
      GH_STUB_TITLE: open.title ?? 'chore(skills): resync vendored skill mirror',
      GH_STUB_LOG: lab.ghLog,
      GIT_TERMINAL_PROMPT: '0',
    },
  };
  try {
    return { status: 0, output: execFileSync('bash', [SCRIPT], options) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

/** Mutating gh calls, in order, as argv arrays. */
async function ghCalls(lab: Lab): Promise<string[][]> {
  const log = await readFile(lab.ghLog, 'utf8');
  return log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

/** The single mutating gh call a run is expected to make. */
async function soleGhCall(lab: Lab): Promise<string[]> {
  const calls = await ghCalls(lab);
  expect(calls).toHaveLength(1);
  return calls[0] ?? [];
}

const bodyOf = (call: string[]): string => call[call.indexOf('--body') + 1] ?? '';

const titleOf = (call: string[]): string =>
  call.includes('--title') ? (call[call.indexOf('--title') + 1] ?? '') : '';

const remoteBranches = (lab: Lab): string =>
  execFileSync('git', ['--git-dir', lab.origin, 'branch', '--list'], { encoding: 'utf8' });

const remoteShow = (lab: Lab, ref: string): string =>
  execFileSync('git', ['--git-dir', lab.origin, 'show', ref], { encoding: 'utf8' });

const remoteRevParse = (lab: Lab, ref: string): string =>
  execFileSync('git', ['--git-dir', lab.origin, 'rev-parse', ref], { encoding: 'utf8' }).trim();

describe('open-skill-resync-pr.sh', () => {
  it('does nothing when the mirror already matches the live source', async () => {
    const lab = makeLab(mirror('same'));
    const result = run(lab, mirror('same'));

    expect(result.status).toBe(0);
    expect(result.output).toContain('mirror matches');
    expect(remoteBranches(lab)).not.toContain(BRANCH);
    expect(await ghCalls(lab)).toEqual([]);
  }, 30_000);

  it('opens a PR with a magnitude cue when the mirror has drifted', async () => {
    const lab = makeLab(mirror('old wording'));
    const result = run(lab, mirror('new wording'));

    expect(result.status).toBe(0);
    expect(remoteShow(lab, `${BRANCH}:${MIRROR}`)).toBe(mirror('new wording'));
    expect(remoteShow(lab, `${BRANCH}:.changeset/bot-skill-resync.md`)).toContain(
      "'tenjin-cli': patch",
    );

    const create = await soleGhCall(lab);
    expect(create.slice(0, 2)).toEqual(['pr', 'create']);
    expect(titleOf(create)).toBe('chore(skills): resync vendored skill mirror');
    const body = bodyOf(create);
    expect(body).toContain('Mirror diff: +1 / -1 lines');
    expect(body).toContain('Frontmatter: unchanged');
    // The reviewer must not be told the content is vouched for; it isn't.
    expect(body).toContain('No step in this path has read the new wording');
    // Fenced from the start, so the first update can splice rather than clobber.
    expect(body).toContain('<!-- skill-resync:start -->');
    expect(body).toContain('<!-- skill-resync:end -->');
  }, 30_000);

  it('flags a frontmatter change in the PR body, without escalating the title', async () => {
    const lab = makeLab(mirror('body', 'zero-install skill'));
    run(lab, mirror('body', 'renamed description'));

    const create = await soleGhCall(lab);
    expect(bodyOf(create)).toContain('Frontmatter: CHANGED');
    // A description edit is still the same skill; only `name` escalates.
    expect(titleOf(create)).not.toContain(NAME_PREFIX);
  }, 30_000);

  it('screams in the title when the frontmatter name changes', async () => {
    const lab = makeLab(mirror('body', 'zero-install skill', 'tenjin'));
    // The mirror becoming a different skill still opens a PR rather than failing
    // the run: a red scheduled run notifies by unread email, so refusing would
    // make the pathological case the quietest one. It escalates where it shows.
    const result = run(lab, mirror('body', 'zero-install skill', 'not-tenjin'));

    expect(result.status).toBe(0);
    const create = await soleGhCall(lab);
    expect(create.slice(0, 2)).toEqual(['pr', 'create']);
    expect(titleOf(create)).toBe(`${NAME_PREFIX}chore(skills): resync vendored skill mirror`);
  }, 30_000);

  it('escalates an open PR title when the name changes on a later day', async () => {
    const lab = makeLab(mirror('old wording', 'd', 'tenjin'));
    seedBotBranch(lab, 'yesterday');
    const result = run(
      lab,
      mirror('new wording', 'd', 'not-tenjin'),
      [{ number: 7, isCrossRepository: false }],
      { title: 'chore(skills): resync vendored skill mirror' },
    );

    expect(result.status).toBe(0);
    // Prepended to the current title, so a human rename survives.
    expect(titleOf(await soleGhCall(lab))).toBe(
      `${NAME_PREFIX}chore(skills): resync vendored skill mirror`,
    );
  }, 30_000);

  it('does not stack the prefix on a title that already screams', async () => {
    const lab = makeLab(mirror('old wording', 'd', 'tenjin'));
    seedBotBranch(lab, 'yesterday');
    const result = run(
      lab,
      mirror('new wording', 'd', 'not-tenjin'),
      [{ number: 7, isCrossRepository: false }],
      { title: `${NAME_PREFIX}chore(skills): resync vendored skill mirror` },
    );

    expect(result.status).toBe(0);
    // No --title at all: the body still refreshes, the title is left as it is.
    expect(titleOf(await soleGhCall(lab))).toBe('');
  }, 30_000);

  it('ignores a fork PR that squats the bot branch name', async () => {
    const lab = makeLab(mirror('old wording'));
    // `gh pr list --head` matches on ref name, so an outsider can open this from a
    // fork. It must not steer the run: the drift still gets its own fresh branch
    // and its own PR.
    const result = run(lab, mirror('new wording'), [{ number: 99, isCrossRepository: true }]);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('PR #99');
    expect((await soleGhCall(lab)).slice(0, 2)).toEqual(['pr', 'create']);
    expect(remoteShow(lab, `${BRANCH}:${MIRROR}`)).toBe(mirror('new wording'));
  }, 30_000);

  it('adopts the same-repo PR even when a fork PR sorts first', async () => {
    const lab = makeLab(mirror('old wording'));
    seedBotBranch(lab, 'yesterday');
    const result = run(lab, mirror('new wording'), [
      { number: 99, isCrossRepository: true },
      { number: 7, isCrossRepository: false },
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('updated PR #7');
    expect((await soleGhCall(lab)).slice(0, 3)).toEqual(['pr', 'edit', '7']);
  }, 30_000);

  it("refreshes only its own block, leaving a reviewer's notes in the body", async () => {
    const lab = makeLab(mirror('old wording'));
    seedBotBranch(lab, 'yesterday');
    const existing = [
      '<!-- skill-resync:start -->',
      'Mirror diff: +99 / -99 lines',
      '<!-- skill-resync:end -->',
      '',
      'Checked paragraphs 1-3, the rest is new. Holding until Tuesday.',
    ].join('\n');
    const result = run(lab, mirror('new wording'), [{ number: 7, isCrossRepository: false }], {
      body: existing,
    });

    expect(result.status).toBe(0);
    const body = bodyOf(await soleGhCall(lab));
    expect(body).toContain('Checked paragraphs 1-3, the rest is new. Holding until Tuesday.');
    expect(body).toContain('Mirror diff: +1 / -1 lines');
    expect(body).not.toContain('+99 / -99');
    // Exactly one block, so a week of runs can't stack them.
    expect(body.split('<!-- skill-resync:start -->')).toHaveLength(2);
  }, 30_000);

  it('appends its block rather than overwriting a body whose fence was removed', async () => {
    const lab = makeLab(mirror('old wording'));
    seedBotBranch(lab, 'yesterday');
    const result = run(lab, mirror('new wording'), [{ number: 7, isCrossRepository: false }], {
      body: 'Rewrote this body by hand. Do not lose this.',
    });

    expect(result.status).toBe(0);
    const body = bodyOf(await soleGhCall(lab));
    expect(body).toContain('Rewrote this body by hand. Do not lose this.');
    expect(body).toContain('Mirror diff: +1 / -1 lines');
    expect(body).toContain('<!-- skill-resync:start -->');
  }, 30_000);

  it('updates the open same-repo PR in place instead of opening another', async () => {
    const lab = makeLab(mirror('old wording'));
    const seeded = seedBotBranch(lab, 'yesterday');
    const result = run(lab, mirror('new wording'), [{ number: 7, isCrossRepository: false }]);

    expect(result.status).toBe(0);
    expect(result.output).toContain('updated PR #7');
    expect((await soleGhCall(lab)).slice(0, 3)).toEqual(['pr', 'edit', '7']);
    // Fast-forward, not a rewrite: yesterday's commit is still the parent.
    expect(remoteRevParse(lab, `${BRANCH}~1`)).toBe(seeded);
    expect(remoteShow(lab, `${BRANCH}:${MIRROR}`)).toBe(mirror('new wording'));
  }, 30_000);

  it('pushes nothing when the open PR already carries the fresh mirror', async () => {
    const lab = makeLab(mirror('old wording'));
    seedBotBranch(lab, 'new wording');
    const before = remoteRevParse(lab, BRANCH);
    const result = run(lab, mirror('new wording'), [{ number: 7, isCrossRepository: false }]);

    expect(result.status).toBe(0);
    expect(result.output).toContain(`${BRANCH} already carries this mirror`);
    expect(await ghCalls(lab)).toEqual([]);
    expect(remoteRevParse(lab, BRANCH)).toBe(before);
  }, 30_000);

  it('fails loudly instead of overwriting a concurrent push to the bot branch', async () => {
    const lab = makeLab(mirror('old wording'));
    seedBotBranch(lab, 'yesterday');
    installRacingGit(lab);
    const result = run(lab, mirror('new wording'), [{ number: 7, isCrossRepository: false }]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('rejected');
    // The third party's commit survived, and no PR was touched.
    expect(remoteShow(lab, BRANCH).includes('third-party push')).toBe(true);
    expect(await ghCalls(lab)).toEqual([]);
    expect(existsSync(lab.raceMarker)).toBe(true);
  }, 30_000);
});

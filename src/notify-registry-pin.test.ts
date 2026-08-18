import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * scripts/notify-registry-pin.sh runs once per npm publish and files an issue on
 * ANOTHER repo, so the two decisions that keep it honest are pinned here: it
 * speaks only for a release that actually published, and it files once per
 * version rather than once per dispatch.
 *
 * Each case drives the REAL script with only `gh` stubbed.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/notify-registry-pin.sh', import.meta.url));
const TARGET_REPO = 'BackTrackCo/tenjin';
const titleFor = (version: string): string =>
  `bump the MCP Registry packages pin to tenjin-cli@${version}`;

/**
 * Models `gh` closely enough for the one behaviour that matters: `issue list
 * --search` is a LOOSE full-text match, so a near-miss issue (the previous
 * version's, still open) comes back too, and only a jq predicate on the exact
 * title filters it out. Drop that predicate and this stub starts handing back the
 * near-miss, which is the regression the stale-issue case below catches.
 */
const GH_STUB = `import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : '');
if (argv[0] === 'issue' && argv[1] === 'list') {
  const issues = JSON.parse(process.env.GH_STUB_ISSUES ?? '[]');
  const exact = value('--jq').includes('env.TITLE');
  const visible = exact ? issues.filter((i) => i.title === process.env.TITLE) : issues;
  process.stdout.write(visible.length > 0 ? String(visible[0].number) + '\\n' : '');
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

interface Lab {
  stubs: string;
  ghLog: string;
}

function makeLab(): Lab {
  const root = mkdtempSync(join(tmpdir(), 'registry-pin-'));
  const lab: Lab = { stubs: join(root, 'stubs'), ghLog: join(root, 'gh.log') };
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

interface Scenario {
  /** What changesets/action reported it put on npm. */
  published?: Array<{ name: string; version: string }>;
  /** Open issues already on the target repo. */
  issues?: Array<{ number: number; title: string }>;
  token?: string | null;
  /** Actions run context, absent outside CI. */
  run?: { id: string; repository: string };
}

interface Run {
  status: number;
  output: string;
}

function run(lab: Lab, scenario: Scenario = {}): Run {
  // Built by deletion, not by spread alone: a real GH_TOKEN or GITHUB_RUN_ID in
  // the ambient environment (this suite also runs inside Actions) would otherwise
  // decide the case instead of the scenario.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_RUN_ID;
  delete env.GITHUB_SERVER_URL;
  delete env.GITHUB_REPOSITORY;

  env.PATH = `${lab.stubs}:${process.env.PATH ?? ''}`;
  env.PUBLISHED_PACKAGES = JSON.stringify(scenario.published ?? []);
  env.GH_STUB_ISSUES = JSON.stringify(scenario.issues ?? []);
  env.GH_STUB_LOG = lab.ghLog;
  if (scenario.token !== null) env.GH_TOKEN = scenario.token ?? 'stub-token';
  if (scenario.run) {
    env.GITHUB_RUN_ID = scenario.run.id;
    env.GITHUB_REPOSITORY = scenario.run.repository;
  }

  try {
    return { status: 0, output: execFileSync('bash', [SCRIPT], { encoding: 'utf8', env }) };
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

const valueOf = (call: string[], flag: string): string => call[call.indexOf(flag) + 1] ?? '';

describe('notify-registry-pin.sh', () => {
  it('files one issue naming the published version and the files that move with it', async () => {
    const lab = makeLab();
    const result = run(lab, { published: [{ name: 'tenjin-cli', version: '0.1.0-alpha.15' }] });
    expect(result.status).toBe(0);

    const calls = await ghCalls(lab);
    expect(calls).toHaveLength(1);
    const call = calls[0] ?? [];
    expect(call.slice(0, 2)).toEqual(['issue', 'create']);
    expect(valueOf(call, '--repo')).toBe(TARGET_REPO);
    // The version rides the title, so dedupe and the reader both get it without a
    // template placeholder to fill in.
    expect(valueOf(call, '--title')).toBe(titleFor('0.1.0-alpha.15'));

    const body = valueOf(call, '--body');
    expect(body).toContain('`tenjin-cli@0.1.0-alpha.15` is on npm');
    // The three files that must move together on the tenjin side. metadata.ts is
    // where MCP_SERVER_INFO lives now (it moved out of lib/mcp/server.ts), so a
    // body still pointing at server.ts would send the reader to the wrong file.
    expect(body).toContain('`server.json`');
    expect(body).toContain('`package.json`');
    expect(body).toContain('`lib/mcp/metadata.ts`');
    expect(body).not.toContain('`MCP_SERVER_INFO` in `lib/mcp/server.ts`');
    // Auto-publishing the manifest is a non-goal; the body has to say so, because
    // an issue that only says "bump the pin" reads like the whole job.
    expect(body).toContain('manual and must follow the');
    expect(body).toContain('docs/MCP-REGISTRY.md');
  });

  it('files nothing when the dispatch published nothing', async () => {
    const lab = makeLab();
    const result = run(lab, { published: [] });
    expect(result.status).toBe(0);
    expect(result.output).toContain('nothing to file');
    expect(await ghCalls(lab)).toEqual([]);
  });

  it('files nothing when the publish carried no tenjin-cli', async () => {
    const lab = makeLab();
    const result = run(lab, { published: [{ name: 'some-other-pkg', version: '2.0.0' }] });
    expect(result.status).toBe(0);
    expect(await ghCalls(lab)).toEqual([]);
  });

  it('does not duplicate an open issue for the same version', async () => {
    const lab = makeLab();
    const result = run(lab, {
      published: [{ name: 'tenjin-cli', version: '0.1.0-alpha.15' }],
      issues: [{ number: 700, title: titleFor('0.1.0-alpha.15') }],
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`${TARGET_REPO}#700`);
    expect(await ghCalls(lab)).toEqual([]);
  });

  it('still files when only a PREVIOUS version has an open issue', async () => {
    const lab = makeLab();
    const result = run(lab, {
      published: [{ name: 'tenjin-cli', version: '0.1.0-alpha.15' }],
      issues: [{ number: 700, title: titleFor('0.1.0-alpha.14') }],
    });
    expect(result.status).toBe(0);
    const calls = await ghCalls(lab);
    expect(calls).toHaveLength(1);
    expect(valueOf(calls[0] ?? [], '--title')).toBe(titleFor('0.1.0-alpha.15'));
  });

  it('fails loudly and files nothing when no cross-repo token is configured', async () => {
    const lab = makeLab();
    const result = run(lab, {
      published: [{ name: 'tenjin-cli', version: '0.1.0-alpha.15' }],
      token: null,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('RELEASE_CROSSREPO_TOKEN');
    expect(await ghCalls(lab)).toEqual([]);
  });

  it('links the release run that published the version', async () => {
    const lab = makeLab();
    run(lab, {
      published: [{ name: 'tenjin-cli', version: '0.1.0-alpha.15' }],
      run: { id: '424242', repository: 'BackTrackCo/tenjin-agent' },
    });
    const calls = await ghCalls(lab);
    expect(valueOf(calls[0] ?? [], '--body')).toContain(
      'https://github.com/BackTrackCo/tenjin-agent/actions/runs/424242',
    );
  });
});

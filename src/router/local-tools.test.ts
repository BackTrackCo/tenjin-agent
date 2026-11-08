import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fillLocalLine,
  filesPresent,
  LOCAL_REVIEW_DATE,
  LOCAL_TOOLS,
  localCommand,
  npxOnPath,
} from './local-tools';

/**
 * THE COMMANDS THE AGENT IS TOLD TO RUN. Each is a contract: the server's line
 * holds `{command}` and this build writes one of these into it, so a pin, a
 * flag or the date moving is a reviewed change here, never a server deploy.
 */
describe('the pinned local tools', () => {
  it('gives each tool its exact command', () => {
    expect(Object.fromEntries(Object.keys(LOCAL_TOOLS).map((k) => [k, localCommand(k)]))).toEqual({
      'ast-grep': 'npx --yes --before=2026-10-24 -p @ast-grep/cli@0.50.0 ast-grep run --json',
      knip: 'npx --yes --before=2026-10-24 --ignore-scripts -p knip@6.41.0 knip --reporter json',
      'dependency-cruiser':
        'npx --yes --before=2026-10-24 --ignore-scripts -p dependency-cruiser@18.5.0 -p typescript@5.9.3 depcruise --no-config --output-type json',
      squawk:
        'npx --yes --before=2026-10-24 --ignore-scripts -p squawk-cli@2.68.0 squawk --reporter json',
      attw: 'npx --yes --before=2026-10-24 --ignore-scripts -p @arethetypeswrong/cli@0.18.5 attw --pack --format json',
      'attw-npm':
        'npx --yes --before=2026-10-24 --ignore-scripts -p @arethetypeswrong/cli@0.18.5 attw --format json --from-npm',
      secretlint:
        'npx --yes --before=2026-10-24 --ignore-scripts -p @secretlint/quick-start@13.0.7 quick-start --format compact --no-color',
      v8r: 'npx --yes --before=2026-10-24 --ignore-scripts -p v8r@6.1.0 v8r --output-format json',
      'oxlint-a11y': [
        'npx --yes --before=2026-10-24 --ignore-scripts --legacy-peer-deps -p oxlint@1.87.0 oxlint',
        '--jsx-a11y-plugin --disable-nested-config -A all',
        '-W jsx-a11y/alt-text',
        '-W jsx-a11y/anchor-has-content',
        '-W jsx-a11y/anchor-is-valid',
        '-W jsx-a11y/aria-activedescendant-has-tabindex',
        '-W jsx-a11y/aria-props',
        '-W jsx-a11y/aria-proptypes',
        '-W jsx-a11y/aria-role',
        '-W jsx-a11y/aria-unsupported-elements',
        '-W jsx-a11y/autocomplete-valid',
        '-W jsx-a11y/click-events-have-key-events',
        '-W jsx-a11y/control-has-associated-label',
        '-W jsx-a11y/heading-has-content',
        '-W jsx-a11y/html-has-lang',
        '-W jsx-a11y/iframe-has-title',
        '-W jsx-a11y/img-redundant-alt',
        '-W jsx-a11y/interactive-supports-focus',
        '-W jsx-a11y/label-has-associated-control',
        '-W jsx-a11y/lang',
        '-W jsx-a11y/media-has-caption',
        '-W jsx-a11y/mouse-events-have-key-events',
        '-W jsx-a11y/no-access-key',
        '-W jsx-a11y/no-aria-hidden-on-focusable',
        '-W jsx-a11y/no-autofocus',
        '-W jsx-a11y/no-distracting-elements',
        '-W jsx-a11y/no-interactive-element-to-noninteractive-role',
        '-W jsx-a11y/no-noninteractive-element-interactions',
        '-W jsx-a11y/no-noninteractive-element-to-interactive-role',
        '-W jsx-a11y/no-noninteractive-tabindex',
        '-W jsx-a11y/no-redundant-roles',
        '-W jsx-a11y/no-static-element-interactions',
        '-W jsx-a11y/prefer-tag-over-role',
        '-W jsx-a11y/role-has-required-aria-props',
        '-W jsx-a11y/role-supports-aria-props',
        '-W jsx-a11y/scope',
        '-W jsx-a11y/tabindex-no-positive',
        '--format json',
      ].join(' '),
      'type-coverage':
        'npx --yes --before=2026-10-24 --ignore-scripts -p type-coverage@2.30.3 -p typescript@5.9.3 type-coverage --detail --strict --json-output',
    });
  });

  it('keeps install scripts off on every tool but ast-grep', () => {
    for (const key of Object.keys(LOCAL_TOOLS)) {
      expect(localCommand(key).includes('--ignore-scripts'), key).toBe(key !== 'ast-grep');
    }
  });

  it("skips npm's peer resolution only for oxlint, whose optional peers it never installs", () => {
    for (const key of Object.keys(LOCAL_TOOLS)) {
      expect(localCommand(key).includes('--legacy-peer-deps'), key).toBe(key === 'oxlint-a11y');
    }
  });

  it('pins only versions at least 14 days old on the review date', () => {
    const review = Date.parse(`${LOCAL_REVIEW_DATE}T00:00:00Z`);
    for (const [key, tool] of Object.entries(LOCAL_TOOLS)) {
      for (const pkg of tool.packages) {
        const published = Date.parse(`${pkg.published}T00:00:00Z`);
        expect(review - published, `${key} ${pkg.name}`).toBeGreaterThanOrEqual(14 * 86_400_000);
      }
    }
  });

  it("writes the command into the server's one slot, and nothing else of the line moves", () => {
    const line = 'Use knip, free: run `{command}` in your shell, and read its JSON.';
    expect(fillLocalLine(line, 'knip')).toBe(
      `Use knip, free: run \`${localCommand('knip')}\` in your shell, and read its JSON.`,
    );
  });
});

describe('readiness on this machine', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-tools-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds npx on PATH only as a file', async () => {
    await mkdir(join(dir, 'bin'));
    await mkdir(join(dir, 'dir', 'npx'), { recursive: true });
    expect(await npxOnPath({ PATH: join(dir, 'dir') }, 'darwin')).toBe(false);
    await writeFile(join(dir, 'bin', 'npx'), '');
    expect(await npxOnPath({ PATH: `${join(dir, 'dir')}:${join(dir, 'bin')}` }, 'darwin')).toBe(
      true,
    );
    expect(await npxOnPath({}, 'darwin')).toBe(false);
  });

  it('looks for a required file from the working folder up to the git root, and no further', async () => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'app', 'src'), { recursive: true });
    // Above the git root: not this project's.
    await writeFile(join(dir, 'package.json'), '{}');
    expect(await filesPresent(['package.json'], join(repo, 'app', 'src'))).toBe(false);
    await writeFile(join(repo, 'package.json'), '{}');
    expect(await filesPresent(['package.json'], join(repo, 'app', 'src'))).toBe(true);
    expect(await filesPresent([], join(repo, 'app'))).toBe(true);
  });
});

// Version-bump + tag flow for tenjin-cli. Bumps package.json, regenerates the
// CHANGELOG.md section for the new version from git log, commits, and creates
// an annotated tag. Modeled on claude-mem's version-bump skill: local git state
// is fully prepared, but nothing is pushed and nothing is published: the
// release.yml workflow does the actual `npm publish` once the tag lands on
// origin. Dependency-free (Node >=22 built-ins only), matching this repo's
// other scripts/ maintenance tooling.
//
// Usage: node scripts/release.mjs <patch|minor|major|prerelease> [identifier]
//   identifier only applies to `prerelease` (default: alpha).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from the script's own location, not process.cwd(), so this behaves
// the same whether invoked as `pnpm release` or `node scripts/release.mjs`
// from some other directory.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(REPO_ROOT, 'package.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');
// Does not exist yet (that's C3). Bumping it here is a no-op today; the slot
// exists so the release flow does not need a second pass once the plugin
// manifest lands. See "Plugin manifest bump (no-op until C3)" below.
const PLUGIN_MANIFEST_PATH = join(REPO_ROOT, '.claude-plugin', 'plugin.json');

const CHANGELOG_HEADER =
  '# Changelog\n\nAll notable changes to `tenjin-cli` are documented here.\n';

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args, { silent = false } = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // `describe` probes for a prior tag and is expected to fail loudly on the
    // first-ever release (no tags exist); silence that stderr since the
    // failure is handled, not reported.
    stdio: ['ignore', 'pipe', silent ? 'ignore' : 'pipe'],
  }).trim();
}

const [releaseType, identifierArg] = process.argv.slice(2);
const VALID_TYPES = ['patch', 'minor', 'major', 'prerelease'];
if (!VALID_TYPES.includes(releaseType)) {
  fail(`usage: node scripts/release.mjs <${VALID_TYPES.join('|')}> [prerelease-identifier]`);
}
const identifier = identifierArg ?? 'alpha';

// Refuse to touch a dirty tree: the commit this script makes must contain
// exactly the version bump, nothing an in-progress edit left lying around.
if (git(['status', '--porcelain']) !== '') {
  fail('working tree is not clean; commit or stash pending changes before releasing');
}

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (m === null) fail(`package.json version "${version}" is not valid semver`);
  const [, major, minor, patch, pre] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split('.') : [],
  };
}

function formatVersion({ major, minor, patch, prerelease }) {
  const core = `${major}.${minor}.${patch}`;
  return prerelease.length > 0 ? `${core}-${prerelease.join('.')}` : core;
}

// Mirrors node-semver's `inc()` for the four types below (verified against its
// documented behavior, e.g. `patch` on a prerelease version drops the
// prerelease tag without incrementing the number). Kept in-repo rather than
// pulling the `semver` package for four cases this CLI actually uses.
function bump(current, type) {
  const v = parseVersion(current);
  switch (type) {
    case 'major':
      if (v.minor !== 0 || v.patch !== 0 || v.prerelease.length === 0) v.major += 1;
      v.minor = 0;
      v.patch = 0;
      v.prerelease = [];
      break;
    case 'minor':
      if (v.patch !== 0 || v.prerelease.length === 0) v.minor += 1;
      v.patch = 0;
      v.prerelease = [];
      break;
    case 'patch':
      if (v.prerelease.length === 0) v.patch += 1;
      v.prerelease = [];
      break;
    case 'prerelease': {
      const last = v.prerelease[v.prerelease.length - 1];
      if (v.prerelease[0] === identifier && /^\d+$/.test(String(last))) {
        v.prerelease[v.prerelease.length - 1] = String(Number(last) + 1);
      } else if (v.prerelease.length === 0) {
        v.patch += 1;
        v.prerelease = [identifier, '0'];
      } else {
        v.prerelease = [identifier, '0'];
      }
      break;
    }
  }
  return formatVersion(v);
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const newVersion = bump(pkg.version, releaseType);
const tag = `v${newVersion}`;

if (git(['tag', '-l', tag]) !== '') {
  fail(`tag ${tag} already exists`);
}

pkg.version = newVersion;
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

// CHANGELOG: one section per release, newest first, sourced from commit
// subjects since the last tag (or the full log on the first-ever release,
// since no tag exists to bound it).
let lastTag = null;
try {
  lastTag = git(['describe', '--tags', '--abbrev=0'], { silent: true });
} catch {
  lastTag = null;
}
const logRange = lastTag ? [`${lastTag}..HEAD`] : [];
const log = git(['log', '--no-merges', '--pretty=format:%s (%h)', ...logRange]);
const entries =
  log === '' ? ['- No changes recorded.'] : log.split('\n').map((line) => `- ${line}`);

const date = new Date().toISOString().slice(0, 10);
const section = `## ${newVersion} - ${date}\n\n${entries.join('\n')}\n`;

let previousBody = '';
if (existsSync(CHANGELOG_PATH)) {
  const existing = readFileSync(CHANGELOG_PATH, 'utf8');
  previousBody = existing.startsWith(CHANGELOG_HEADER)
    ? existing.slice(CHANGELOG_HEADER.length).replace(/^\n+/, '')
    : existing;
}
const changelog = `${CHANGELOG_HEADER}\n${section}` + (previousBody ? `\n${previousBody}` : '');
writeFileSync(CHANGELOG_PATH, `${changelog.trimEnd()}\n`, 'utf8');

const staged = [PKG_PATH, CHANGELOG_PATH];

// Plugin manifest bump (no-op until C3). The Claude plugin does not exist yet,
// so this is dead code on every run today, checked in now so the slot is
// wired once C3 adds .claude-plugin/plugin.json, without a second pass over
// this script. When it lands, revisit whether its version should track the
// CLI 1:1 or carry its own plugin semver alongside a separate CLI-pin field;
// this just mirrors the CLI version as the simplest starting behavior.
if (existsSync(PLUGIN_MANIFEST_PATH)) {
  const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
  manifest.version = newVersion;
  writeFileSync(PLUGIN_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  staged.push(PLUGIN_MANIFEST_PATH);
}

git(['add', ...staged]);
execFileSync('git', ['commit', '-m', `chore(release): ${tag}`], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
execFileSync('git', ['tag', '-a', tag, '-m', tag], { cwd: REPO_ROOT, stdio: 'inherit' });

console.log(`\nrelease: committed and tagged ${tag} locally. Nothing was pushed.`);
console.log('release: push it with:\n');
console.log('  git push --follow-tags\n');
console.log(`release: origin/main receiving tag ${tag} triggers release.yml, which runs the`);
console.log('release: full check suite and publishes to npm (dist-tag alpha for prereleases,');
console.log('release: latest for stable versions).');

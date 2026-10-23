#!/usr/bin/env node
// Pins the Node that Tenjin's runtime downloads: writes `tenjinRuntime.node`
// (the version and each release archive's sha256) into package.json. The
// hashes come only from a SHASUMS256.txt whose signature gpgv verified against
// Node's release keys, at a pinned commit of nodejs/release-keys; without
// gpgv, the signature, the keyring or a good check it writes nothing. Run at
// release time only, never by CI, tests or install (RELEASING.md).
//
//   node scripts/pin-node.mjs <24.x.y>
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

/** nodejs/release-keys at the commit whose keyring this script trusts; move it deliberately. */
const RELEASE_KEYS_COMMIT = '481637f813e912c4aa3622d7964ab426c97b8e8d';
/** Every key that ever signed a release, so an older 24.x still verifies. */
const KEYRING_URL = `https://raw.githubusercontent.com/nodejs/release-keys/${RELEASE_KEYS_COMMIT}/gpg/pubring.kbx`;
/** `http.setGlobalProxyFromEnv` (src/lib/env-proxy.ts) needs 24.14. */
const MIN = [24, 14, 0];
/** The archive each `nodeKey` downloads, by its suffix in SHASUMS256.txt. */
const ARCHIVES = {
  'darwin-arm64': 'tar.gz',
  'darwin-x64': 'tar.gz',
  'linux-x64': 'tar.gz',
  'linux-arm64': 'tar.gz',
  'win-x64': 'zip',
  'win-arm64': 'zip',
};

function refuse(message) {
  console.error(`pin-node: ${message}; package.json was not changed.`);
  process.exit(1);
}

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/pin-node.mjs <24.x.y>');
  process.exit(2);
}
const parts = version.split('.').map(Number);
const below = parts.findIndex((n, i) => n !== MIN[i]);
if (below !== -1 && parts[below] < MIN[below]) refuse(`Node ${version} is below ${MIN.join('.')}`);

if (spawnSync('gpgv', ['--version'], { stdio: 'ignore', shell: false }).error !== undefined) {
  refuse('gpgv is not installed (it comes with gpg), so the signature cannot be checked');
}

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return refuse(`could not fetch ${url} (${err.message})`);
  }
}

const dist = `https://nodejs.org/dist/v${version}`;
const [sums, sig, keyring] = await Promise.all([
  get(`${dist}/SHASUMS256.txt`),
  get(`${dist}/SHASUMS256.txt.sig`),
  get(KEYRING_URL),
]);

const dir = mkdtempSync(join(tmpdir(), 'pin-node-'));
let verified;
try {
  writeFileSync(join(dir, 'SHASUMS256.txt'), sums);
  writeFileSync(join(dir, 'SHASUMS256.txt.sig'), sig);
  writeFileSync(join(dir, 'pubring.kbx'), keyring);
  // The keyring by absolute path: gpgv reads a bare name from its own home.
  const check = spawnSync(
    'gpgv',
    [
      '--keyring',
      join(dir, 'pubring.kbx'),
      join(dir, 'SHASUMS256.txt.sig'),
      join(dir, 'SHASUMS256.txt'),
    ],
    { encoding: 'utf8', shell: false },
  );
  verified = check.status === 0;
  if (!verified) console.error(check.stderr.trim());
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!verified) refuse(`the signature on Node ${version}'s SHASUMS256.txt did not verify`);

const listed = new Map();
for (const line of sums.toString('utf8').split('\n')) {
  const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
  if (m !== null) listed.set(m[2], m[1]);
}
const sha256 = {};
for (const [key, ext] of Object.entries(ARCHIVES)) {
  const file = `node-v${version}-${key}.${ext}`;
  const hash = listed.get(file);
  if (hash === undefined) refuse(`SHASUMS256.txt lists no ${file}`);
  sha256[key] = hash;
}

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.tenjinRuntime = { node: { version, sha256 } };
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`pin-node: pinned Node ${version} (signature verified) in package.json`);

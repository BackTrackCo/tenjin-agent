import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const repository = 'BackTrackCo/tenjin-agent';
const tag = `v${version}`;
const stage = await mkdtemp(join(tmpdir(), 'tenjin-release-installers-'));
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  return response;
}
try {
  const metadata = await (await get(`https://registry.npmjs.org/tenjin-cli/${version}`)).json();
  const tarballUrl = `https://registry.npmjs.org/tenjin-cli/-/tenjin-cli-${version}.tgz`;
  if (
    metadata.version !== version ||
    metadata.dist?.tarball !== tarballUrl ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist.integrity)
  )
    throw new Error('Published package has invalid version, URL or SHA512 integrity');
  const bytes = new Uint8Array(await (await get(tarballUrl)).arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== metadata.dist.integrity)
    throw new Error('Published tarball does not match registry integrity');
  const tarball = join(stage, 'published.tgz');
  await writeFile(tarball, bytes);
  execFileSync(process.execPath, [join(root, 'scripts', 'build-installers.mjs'), tarball, stage], {
    stdio: 'inherit',
  });
  const pins = JSON.parse(await readFile(join(stage, 'pins.json'), 'utf8'));
  const release = JSON.parse(
    execFileSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' }),
  );
  for (const [name, digest] of [
    ['install.sh', pins.shSha256],
    ['install.ps1', pins.ps1Sha256],
  ]) {
    const existing = release.assets.find((asset) => asset.name === name);
    if (existing) {
      if (existing.digest !== `sha256:${digest}`)
        throw new Error(
          `${tag}/${name} already exists with different bytes; installer assets are immutable`,
        );
    } else {
      execFileSync('gh', ['release', 'upload', tag, join(stage, name), '--repo', repository], {
        stdio: 'inherit',
      });
    }
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}

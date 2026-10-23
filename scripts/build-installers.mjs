import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tarball, output = join(root, 'installer-artifacts')] = process.argv.slice(2);
if (!tarball)
  throw new Error(
    'Usage: node scripts/build-installers.mjs <exact-published-cli.tgz> [output-dir]',
  );
const bytes = await readFile(tarball);
const pkg = JSON.parse(
  execFileSync('tar', ['-xOf', resolve(tarball), 'package/package.json'], { encoding: 'utf8' }),
);
if (pkg.name !== 'tenjin-cli' || !/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(pkg.version))
  throw new Error('Not a versioned tenjin-cli tarball');
const node = pkg.tenjinRuntime?.node;
if (!node || !/^\d+\.\d+\.\d+$/.test(node.version)) throw new Error('No pinned Node');
const keys = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win-arm64', 'win-x64'];
for (const key of keys)
  if (!/^[a-f0-9]{64}$/.test(node.sha256?.[key]))
    throw new Error(`No valid Node checksum for ${key}`);
const replacements = {
  CLI_VERSION: pkg.version,
  CLI_SHA512: createHash('sha512').update(bytes).digest('hex'),
  NODE_VERSION: node.version,
  NODE_CHECKSUM_CASES: keys
    .filter((key) => !key.startsWith('win-'))
    .map((key) => `  ${key}) node_sha='${node.sha256[key]}' ;;`)
    .join('\n'),
  NODE_POWERSHELL_HASHES: keys
    .filter((key) => key.startsWith('win-'))
    .map((key) => `    '${key}' = '${node.sha256[key]}'`)
    .join('\n'),
};
await mkdir(output, { recursive: true });
const pins = { cliVersion: pkg.version, shSha256: '', ps1Sha256: '' };
for (const [file, pin] of [
  ['install.sh', 'shSha256'],
  ['install.ps1', 'ps1Sha256'],
]) {
  let script = await readFile(join(root, 'scripts', 'installers', file), 'utf8');
  script = script.replace(/@([A-Z_0-9]+)@/g, (_, key) => {
    if (!(key in replacements)) throw new Error(`Unknown installer token ${key}`);
    return replacements[key];
  });
  await writeFile(join(output, file), script, { mode: 0o755 });
  pins[pin] = createHash('sha256').update(script).digest('hex');
}
await writeFile(join(output, 'pins.json'), `${JSON.stringify(pins, null, 2)}\n`);
console.log(JSON.stringify(pins));

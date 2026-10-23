import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'tenjin-installer-smoke-'));
const windows = process.platform === 'win32';
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const psQuote = (s) => `'${s.replaceAll("'", "''")}'`;
try {
  const home = join(fixture, 'home');
  const bin = join(fixture, 'bin');
  const packageDir = join(fixture, 'package');
  const key = `${windows ? 'win' : process.platform}-${process.arch}`;
  const version = process.versions.node;
  const nodeTop = `node-v${version}-${key}`;
  const nodeDir = join(fixture, 'node-source', nodeTop);
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  let nodeArchive;
  if (windows) {
    mkdirSync(nodeDir, { recursive: true });
    copyFileSync(process.execPath, join(nodeDir, 'node.exe'));
    nodeArchive = join(fixture, 'node.zip');
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${psQuote(nodeDir)} -DestinationPath ${psQuote(nodeArchive)}`,
    ]);
  } else {
    mkdirSync(join(nodeDir, 'bin'), { recursive: true });
    const node = join(nodeDir, 'bin', 'node');
    writeFileSync(node, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`);
    chmodSync(node, 0o755);
    nodeArchive = join(fixture, 'node.tar.gz');
    execFileSync('tar', ['-czf', nodeArchive, '-C', join(fixture, 'node-source'), nodeTop]);
  }
  const hash = createHash('sha256').update(readFileSync(nodeArchive)).digest('hex');
  const sha256 = Object.fromEntries(
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win-arm64', 'win-x64'].map((k) => [
      k,
      hash,
    ]),
  );
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'tenjin-cli',
      version: '0.0.0-alpha.1',
      type: 'module',
      tenjinRuntime: { node: { version, sha256 } },
    }),
  );
  writeFileSync(
    join(packageDir, 'dist', 'index.js'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.TENJIN_SMOKE_RECEIPT, JSON.stringify({args:process.argv.slice(2), archive:process.env.TENJIN_BOOTSTRAP_NODE_ARCHIVE, proxy:process.env.HTTPS_PROXY}));\n`,
  );
  const cliArchive = join(fixture, 'cli.tgz');
  execFileSync('tar', ['-czf', cliArchive, '-C', fixture, 'package']);
  const output = join(fixture, 'artifacts');
  execFileSync(process.execPath, [
    join(root, 'scripts', 'build-installers.mjs'),
    cliArchive,
    output,
  ]);
  const receipt = join(fixture, 'receipt.json');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TENJIN_DATA_DIR: '',
    TENJIN_SMOKE_RECEIPT: receipt,
    TENJIN_SMOKE_NODE: nodeArchive,
    TENJIN_SMOKE_CLI: cliArchive,
    HTTPS_PROXY: 'http://fixture.invalid:8080',
  };
  let command;
  let args;
  if (windows) {
    const wrapper = join(fixture, 'run.ps1');
    writeFileSync(
      wrapper,
      `class FixtureClient {\n [object]$Proxy\n [void] DownloadFile([string]$url, [string]$path) {\n  $source = if ($url.Contains('nodejs.org')) { $env:TENJIN_SMOKE_NODE } else { $env:TENJIN_SMOKE_CLI }\n  Copy-Item -LiteralPath $source -Destination $path\n  if ($env:TENJIN_SMOKE_CORRUPT -and $url.Contains($env:TENJIN_SMOKE_CORRUPT)) { Add-Content -LiteralPath $path -Value 'corrupt' }\n }\n [void] Dispose() {}\n}\nfunction New-Object { param($TypeName, $ArgumentList) if ($TypeName -eq 'Net.WebClient') { return [FixtureClient]::new() }; return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }\n& ${psQuote(join(output, 'install.ps1'))} --yes --harness codex\nexit $LASTEXITCODE\n`,
    );
    command = 'powershell';
    args = ['-NoProfile', '-File', wrapper];
  } else {
    for (const name of ['node', 'npm']) {
      const unavailable = join(bin, name);
      writeFileSync(unavailable, '#!/bin/sh\necho System Node/npm must not be used >&2\nexit 1\n');
      chmodSync(unavailable, 0o755);
    }
    const curl = join(bin, 'curl');
    writeFileSync(
      curl,
      `#!/bin/sh\nfor arg do case "$arg" in https://*) url=$arg ;; esac; done\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; dest=$1; fi; shift; done\ncase "$url" in *nodejs.org*) src=$TENJIN_SMOKE_NODE ;; *) src=$TENJIN_SMOKE_CLI ;; esac\ncp "$src" "$dest"\ncase "$url" in *"$TENJIN_SMOKE_CORRUPT"*) if [ -n "$TENJIN_SMOKE_CORRUPT" ]; then printf corrupt >> "$dest"; fi ;; esac\n`,
    );
    chmodSync(curl, 0o755);
    env.PATH = `${bin}:${process.env.PATH}`;
    command = 'sh';
    args = [join(output, 'install.sh'), '--yes', '--harness', 'codex'];
  }
  const run = (extra = {}) =>
    spawnSync(command, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  const success = run();
  if (success.status !== 0)
    throw new Error(`Native installer failed: ${success.stderr || success.stdout}`);
  const result = JSON.parse(readFileSync(receipt, 'utf8'));
  if (JSON.stringify(result.args) !== JSON.stringify(['install', '--yes', '--harness', 'codex']))
    throw new Error('Installer lost arguments');
  if (result.proxy !== env.HTTPS_PROXY || !result.archive)
    throw new Error('Bootstrap lost proxy or archive handoff');
  if (existsSync(result.archive)) throw new Error('Installer left temporary archive behind');
  rmSync(receipt);
  for (const target of ['nodejs.org', 'registry.npmjs.org']) {
    const failed = run({ TENJIN_SMOKE_CORRUPT: target });
    if (failed.status === 0 || existsSync(receipt))
      throw new Error(`Corrupt ${target} reached CLI`);
  }
  const custom = run({ TENJIN_DATA_DIR: join(fixture, 'custom') });
  if (custom.status === 0 || existsSync(receipt) || existsSync(join(fixture, 'custom')))
    throw new Error('Custom data directory was not refused before mutation');
  console.log(
    `installer-smoke: ${key} passed: native execution, arguments, proxy, cleanup, both integrity failures, custom-profile refusal`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

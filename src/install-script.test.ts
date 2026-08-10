import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const INSTALLER = resolve('scripts/install.sh');
let root: string;
let home: string;
let fakeBin: string;
let prefix: string;
let logPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-install-script-'));
  home = join(root, 'home');
  fakeBin = join(root, 'bin');
  prefix = join(root, 'prefix');
  logPath = join(root, 'calls.log');
  await Promise.all([mkdir(home), mkdir(fakeBin), mkdir(prefix)]);

  await executable(
    join(fakeBin, 'node'),
    [
      '#!/usr/bin/env bash',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  printf "%s\\n" "${TENJIN_TEST_NODE_VERSION:-v24.0.0}"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  await executable(
    join(fakeBin, 'npm'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "npm:%s\\n" "$*" >> "$TENJIN_TEST_LOG"',
      'if [[ "${1:-}" == "prefix" && "${2:-}" == "--global" ]]; then',
      '  printf "%s\\n" "$TENJIN_TEST_PREFIX"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "install" ]]; then',
      '  mkdir -p "$TENJIN_TEST_PREFIX/bin"',
      '  cat > "$TENJIN_TEST_PREFIX/bin/tenjin" <<\'TENJIN\'',
      '#!/usr/bin/env bash',
      'printf \'tenjin:%s\\n\' "$*" >> "$TENJIN_TEST_LOG"',
      'if [[ "${1:-}" == "--version" ]]; then printf \'0.1.0-test\\n\'; fi',
      'TENJIN',
      '  chmod +x "$TENJIN_TEST_PREFIX/bin/tenjin"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
}

function run(
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('bash', [INSTALLER, ...args], {
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HOME: home,
        TENJIN_TEST_LOG: logPath,
        TENJIN_TEST_PREFIX: prefix,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function calls(): Promise<string[]> {
  return (await readFile(logPath, 'utf8')).trim().split('\n');
}

describe.skipIf(process.platform === 'win32')('scripts/install.sh', () => {
  it('auto-detects harnesses but never creates or selects a wallet implicitly', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(await calls()).toEqual([
      'npm:prefix --global',
      `npm:install --global --prefix ${prefix} tenjin-cli@latest`,
      'tenjin:install --no-wallet',
      'tenjin:--version',
    ]);
    expect(result.stdout).toContain('No wallet was created');
  });

  it('uses one script for multiple explicit harness targets', async () => {
    const result = await run(['--harness', 'claude', '--harness', 'codex']);
    expect(result.code).toBe(0);
    expect(await calls()).toContain('tenjin:install --harness claude --harness codex --no-wallet');
  });

  it('wires Hermes without selecting or creating a wallet', async () => {
    const result = await run(['--harness', 'hermes']);
    expect(result.code).toBe(0);
    expect(await calls()).toContain('tenjin:install --harness hermes --no-wallet');
  });

  it('rejects mixing auto-detection with explicit harness targets', async () => {
    const result = await run(['--harness', 'auto', '--harness', 'codex']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('auto cannot be combined');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects wallet-provider options before npm', async () => {
    const result = await run(['--wallet-provider', 'external']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown option: --wallet-provider');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves OpenClaw without pretending its integration has shipped', async () => {
    const result = await run(['--harness', 'openclaw']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('openclaw installation is deferred');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pins an explicit npm version and prefix', async () => {
    const result = await run(['--version', '0.1.0-alpha.9', '--prefix', prefix]);
    expect(result.code).toBe(0);
    expect(await calls()).toContain(
      `npm:install --global --prefix ${prefix} tenjin-cli@0.1.0-alpha.9`,
    );
  });

  it('rejects an old Node runtime before npm installation', async () => {
    const result = await run([], { TENJIN_TEST_NODE_VERSION: 'v20.19.0' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Node.js 22+ is required');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

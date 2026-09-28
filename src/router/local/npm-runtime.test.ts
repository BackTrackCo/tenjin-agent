import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runBoundedCommand } from './process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareNpmRuntime } from './npm-runtime';
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'npm-runtime-test-'));
  dirs.push(dir);
  const bytes = Buffer.from('reviewed fixture; never executed');
  const path = join(dir, 'input.tgz');
  await writeFile(path, bytes);
  const runtime = {
    kind: 'local-artifact' as const,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { dir, runtime, bytes, dataDir: join(dir, 'profile') };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('persistent npm runtime cache', () => {
  it('reuses the artifact and npm cache while keeping session credentials temporary', async () => {
    const f = await fixture();
    const one = await prepareNpmRuntime({
      ...f,
      packageName: '@example/tool',
      signal: new AbortController().signal,
    });
    await writeFile(join(one.env.npm_config_cache!, 'cached-marker'), 'warm');
    await writeFile(join(one.directory, 'secret'), 'temporary token');
    await one.close();
    const two = await prepareNpmRuntime({
      ...f,
      packageName: '@example/tool',
      signal: new AbortController().signal,
    });
    try {
      expect(two.packageSpec).toBe(one.packageSpec);
      expect(two.env.npm_config_cache).toBe(one.env.npm_config_cache);
      expect(await readFile(join(two.env.npm_config_cache!, 'cached-marker'), 'utf8')).toBe('warm');
      expect(two.env.HOME).not.toBe(one.env.HOME);
      expect(two.env.npm_config_ignore_scripts).toBe('true');
      await expect(stat(join(one.directory, 'secret'))).rejects.toThrow();
      expect(await readFile(two.packageSpec)).toEqual(f.bytes);
    } finally {
      await two.close();
    }
  });
  it('runs a reviewed dependency-free npm fixture twice offline from the retained cache', async () => {
    const f = await fixture();
    const packageDir = join(f.dir, 'package');
    await mkdir(packageDir);
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'tenjin-runtime-fixture',
        version: '1.0.0',
        bin: { 'runtime-fixture': 'cli.js' },
      }),
    );
    await writeFile(
      join(packageDir, 'cli.js'),
      '#!/usr/bin/env node\nprocess.stdout.write("fixture-ok");\n',
      { mode: 0o700 },
    );
    execFileSync('/usr/bin/tar', ['-czf', f.runtime.path, '-C', f.dir, 'package']);
    f.runtime.sha256 = createHash('sha256')
      .update(await readFile(f.runtime.path))
      .digest('hex');
    const opts = {
      ...f,
      packageName: 'tenjin-runtime-fixture',
      signal: AbortSignal.timeout(15000),
    };
    const first = await prepareNpmRuntime(opts);
    const second = await prepareNpmRuntime(opts);
    try {
      for (const runtime of [first, second]) {
        const result = await runBoundedCommand({
          argv: ['--offline', '--yes', '--package', runtime.packageSpec, 'runtime-fixture'],
          cwd: runtime.directory,
          env: runtime.env,
          outputBytes: 4096,
          signal: opts.signal,
        });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe('fixture-ok');
      }
      expect(first.packageSpec).toBe(second.packageSpec);
      expect(first.env.npm_config_cache).toBe(second.env.npm_config_cache);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 20000);
  it('concurrent preparation shares one verified identity and separates other identities', async () => {
    const f = await fixture();
    const opts = { ...f, packageName: '@example/tool', signal: new AbortController().signal };
    const runtimes = await Promise.all([
      prepareNpmRuntime(opts),
      prepareNpmRuntime(opts),
      prepareNpmRuntime({ ...opts, packageName: '@example/other' }),
    ]);
    try {
      expect(runtimes[0]!.packageSpec).toBe(runtimes[1]!.packageSpec);
      expect(runtimes[0]!.env.npm_config_cache).not.toBe(runtimes[2]!.env.npm_config_cache);
    } finally {
      await Promise.all(runtimes.map((r) => r.close()));
    }
  });
  it('rejects corrupted and symlinked cached artifacts before execution', async () => {
    const f = await fixture();
    const opts = { ...f, packageName: '@example/tool', signal: new AbortController().signal };
    const runtime = await prepareNpmRuntime(opts);
    await runtime.close();
    await rm(runtime.packageSpec);
    await writeFile(runtime.packageSpec, 'corrupt');
    await expect(prepareNpmRuntime(opts)).rejects.toThrow();
    await rm(runtime.packageSpec);
    await symlink(f.runtime.path, runtime.packageSpec);
    await expect(prepareNpmRuntime(opts)).rejects.toThrow();
  });
  it('rejects a symlinked cache directory and invalid release specifiers', async () => {
    const f = await fixture();
    await mkdir(f.dataDir);
    const outside = join(f.dir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.dataDir, 'runtimes'));
    await expect(
      prepareNpmRuntime({
        ...f,
        packageName: '@example/tool',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(
      prepareNpmRuntime({
        ...f,
        packageName: '@example/tool',
        runtime: { kind: 'release', version: 'latest' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
});

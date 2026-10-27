import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Options } from 'tsup';
import {
  MOD_FILES,
  PLUGIN_DIR,
  renderCodexHostFiles,
  renderHostFiles,
} from './src/router/plugin-files';

/**
 * THE PLUGINS SHIP IN `dist/hosts/claude` AND `dist/hosts/codex`, rendered from
 * the same module the CLI reads, with this build's version stamped into the
 * Claude Code manifest (the Codex plugin carries none). `tenjin install`
 * registers those folders as local marketplaces, so they must sit inside the
 * published `files`; `dist` already is. The checked-in `hosts/` templates are
 * pinned to the same render by a test, and the Claude mod's two files are
 * copied from them as written.
 */
function writeHosts(): void {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  // The mod ships as written: its source is the checked-in plugin folder.
  const mod = Object.fromEntries(
    MOD_FILES.map((path) => [
      path,
      readFileSync(join('hosts', 'claude', PLUGIN_DIR, path), 'utf8'),
    ]),
  ) as Record<(typeof MOD_FILES)[number], string>;
  const hosts = { claude: renderHostFiles(version, { mod }), codex: renderCodexHostFiles() };
  for (const [host, files] of Object.entries(hosts)) {
    for (const [path, body] of Object.entries(files)) {
      const target = join('dist', 'hosts', host, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

/**
 * Each build's esbuild metafile, for `scripts/check-bundled-packages.mjs`, which
 * lists the third-party packages that ship. Written beside `dist`, never in it,
 * so it stays out of the published package. Only a build into `dist` writes:
 * tsup's `build()` API (src/daemon/smoke.test.ts) also loads this config for
 * its temp-dir builds, which must not overwrite the shipped build's record.
 */
function writeMetafile(name: string): NonNullable<Options['esbuildPlugins']>[number] {
  return {
    name: 'write-metafile',
    setup(build) {
      const outdir = build.initialOptions.outdir;
      if (outdir === undefined || resolve(outdir) !== resolve('dist')) return;
      build.onEnd((result) => {
        if (result.metafile === undefined) return;
        mkdirSync('.bundle-meta', { recursive: true });
        writeFileSync(join('.bundle-meta', `${name}.json`), JSON.stringify(result.metafile));
      });
    },
  };
}

// commander is CommonJS; bundled into ESM its internal require('events') would
// hit esbuild's throwing `__require` shim. A real createRequire satisfies that
// shim's `typeof require` check. This banner lands on every chunk (esbuild
// keeps it below the entry's hashbang, verified); on index.js it is an inert
// node:module import that cannot crash old Node, so the version guard below it
// still fires before any heavy module is imported.
export const banner = {
  js: "import { createRequire as __tenjinCreateRequire } from 'node:module'; const require = __tenjinCreateRequire(import.meta.url);",
};

export default defineConfig([
  // Bundle everything into a code-split ESM dist so the published `dependencies`
  // stays `{}` and a lazy `import()` actually defers viem's parse cost: with
  // `splitting: true` each dynamic-import boundary (cli -> command -> viem)
  // becomes its own chunk, so `doctor`/`config` never parse the wallet's viem
  // chunk. A single-file bundle would parse viem on every invocation.
  //
  // The shebang is NOT a tsup `banner` (that prepends to every split chunk).
  // It lives literally as the first line of src/index.ts; esbuild hoists the
  // entry file's hashbang onto dist/index.js only.
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    // node20 syntax floor: the pre-import Node guard in index.ts must parse and
    // run on an out-of-support runtime to print a clean upgrade error, so the
    // emitted entry must not use node22-only syntax.
    target: 'node20',
    platform: 'node',
    // tsup strips the `node:` prefix by default, so `import('node:sqlite')`
    // shipped as `import('sqlite')` — a bare specifier that resolves to nothing —
    // and every CLI-side store open (doctor, push status, search recording,
    // publish dedup) failed open while the generated hooks (raw source, never
    // bundled) worked. `sqlite` is only a builtin under its `node:` name, unlike
    // `fs`, so the prefix has to survive the bundle. Pinned by a dist test.
    removeNodeProtocol: false,
    splitting: true,
    sourcemap: true,
    minify: false,
    // `clean: false` on BOTH configs: tsup builds an array in parallel, and a
    // `clean: true` here would delete the other config's output mid-build. The
    // `build` script runs `rm -rf dist` first instead.
    clean: false,
    dts: false,
    outDir: 'dist',
    banner,
    // Keeps `ws` out: viem's webSocket transport (unused; RPC is `http()`) imports isows.
    esbuildOptions: (options) => {
      options.alias = { isows: './src/lib/isows-native.ts' };
    },
    esbuildPlugins: [writeMetafile('cli')],
    onSuccess: async () => writeHosts(),
  },
  // The keystore KDF worker (src/lib/wallet/keystore-kdf.ts): a single-file
  // bundle, loaded by `new Worker(url)` from the main dist with no sibling
  // chunks beside it. Its OWN config rather than an extra entry, because tsup
  // carries options across builds in one process. No banner: this file imports
  // `ox/Keystore` and node builtins, and a commander shim it never uses has no
  // business in a worker thread.
  {
    entry: { 'wallet-kdf-worker': 'src/lib/wallet/keystore-kdf-worker.ts' },
    // Explicitly empty, not merely absent: tsup's `build()` API carries options
    // across builds in one process, so an omitted banner can be inherited.
    banner: {},
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    removeNodeProtocol: false,
    splitting: false,
    sourcemap: false,
    minify: false,
    clean: false,
    dts: false,
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
    esbuildPlugins: [writeMetafile('wallet-kdf-worker')],
  },
]);

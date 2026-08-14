import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';
import { CliError } from './errors';

/**
 * WHERE this build is installed, and what that implies about replacing it.
 *
 * Its own module because two callers need it and neither may import the other:
 * `commands/update` performs the replacement, and `lib/update-check` has to
 * know whether a background update is even possible before it spawns one.
 */

/** Managers a global install can be handed back to. yarn is deliberately absent
 *  from the delegable set: see the yarn entry in REFUSALS. */
export type Delegable = 'npm' | 'pnpm' | 'bun';

/**
 * One reason `npm install -g` would not actually replace THIS build.
 *
 * Each entry carries the three properties that decide WHEN it is evaluated,
 * because expressing them by where the line sat is what made this set get
 * re-cut three times: a missing entry, then a copy on the wrong side of the
 * fetch, then a duplicate that could not run. Declaring them means adding a
 * refusal is a matter of answering three questions, not of guessing a position.
 */
interface Refusal {
  /** Does this install location refuse? Pure filesystem, never the network. */
  test: (moduleDir: string) => boolean;
  error: (spec: string, moduleDir: string) => CliError;
  /**
   * Does the fix string name the version the registry just resolved? This is
   * also what decides whether the entry may run BEFORE the fetch: one that does
   * not need a version is evaluated first, so an offline user in a checkout is
   * told they are in a checkout rather than told to go debug their network.
   */
  needsVersion: boolean;
  /**
   * Does it apply to `--check`? Everything here is a reason not to WRITE, and
   * `--check` only reports, so today nothing does. An entry that ever answers
   * yes is one whose test says the REPORT would be wrong, not the install.
   */
  appliesToCheck: boolean;
}

/**
 * Ordered most-specific first: a checkout and an npx cache are recognizable
 * before any question of which manager or which tree, and the manager entry
 * precedes the global/local one because a pnpm or bun store has its own layout
 * that `isGlobalTree` is not written for.
 */
export const REFUSALS: readonly Refusal[] = [
  {
    test: isSourceCheckout,
    error: () =>
      new CliError('REFUSED', 'tenjin-cli is running from a source checkout, not an install', {
        fix: 'Update the checkout instead: git pull && pnpm install',
      }),
    needsVersion: false,
    appliesToCheck: false,
  },
  {
    test: (moduleDir) => moduleDir.split(sep).includes('_npx'),
    error: (spec) =>
      new CliError('REFUSED', 'tenjin-cli is running from the npx cache, not an install', {
        // Writing a global here would "succeed" and change nothing: the next
        // `npx tenjin` still resolves its own cached copy.
        fix: `npx fetches its own copy every time. To keep one: npm i -g ${spec}`,
      }),
    needsVersion: true,
    appliesToCheck: false,
  },
  {
    // The ONLY manager still refused. `yarn global add` is yarn-1 only, and
    // berry dropped global installs altogether, so there is no one command this
    // can drive across the versions a user might have. Every other manager is
    // delegated to rather than refused (see MANAGERS).
    test: (moduleDir) => classifyManager(moduleDir) === 'yarn',
    error: (spec) =>
      new CliError(
        'REFUSED',
        'This tenjin-cli was installed with yarn, whose global install exists only in yarn 1',
        { fix: `yarn global add ${spec}` },
      ),
    needsVersion: true,
    appliesToCheck: false,
  },
  {
    // Scoped to npm on purpose: the prefix-vs-project-root test is written for
    // npm's layout. pnpm's global store and bun's global dir both keep a
    // package.json beside `node_modules`, so an unscoped test would read either
    // as a project-local install and refuse the very case we now delegate.
    test: (moduleDir) => classifyManager(moduleDir) === 'npm' && !isGlobalTree(moduleDir),
    error: (spec) =>
      new CliError(
        'REFUSED',
        'This tenjin-cli is a project-local dependency, not a global install',
        {
          fix: `Update it where it is declared: npm i ${spec}`,
        },
      ),
    needsVersion: true,
    appliesToCheck: false,
  },
];

/**
 * Evaluate the refusal set, once per stage. `spec` is null before the registry
 * has been asked and the resolved `tenjin-cli@<version>` after, which is what
 * selects the eligible entries: every entry runs in exactly one stage, so no
 * refusal can be reached twice or, as in round three, be written twice and
 * reached once.
 */
/**
 * Would ANY refusal fire here? The same list, asked as a question rather than
 * thrown as an error, so the background updater can decline to spawn an install
 * that would only refuse. Asking the entries rather than re-deriving the answer
 * is what keeps this from becoming the fourth copy of the refusal set.
 */
export function wouldRefuse(moduleDir: string): boolean {
  return REFUSALS.some((entry) => entry.test(moduleDir));
}

export function refuse(moduleDir: string, opts: { check: boolean; spec: string | null }): void {
  for (const entry of REFUSALS) {
    if (opts.check && !entry.appliesToCheck) continue;
    if (entry.needsVersion !== (opts.spec !== null)) continue;
    if (entry.test(moduleDir)) throw entry.error(opts.spec ?? '', moduleDir);
  }
}

/**
 * The published package ships `dist/`, `docs/`, and `skills/` with no `src/`
 * beside them (the `files` array), so a `src/` next to the nearest package.json
 * means a checkout, whose version number says nothing about what HEAD holds.
 * Same test skill-heal uses to keep its hands off working-tree skills.
 */
export function isSourceCheckout(moduleDir: string): boolean {
  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return existsSync(join(dir, 'src'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Is this a GLOBAL npm tree? A global install sits under a prefix directory that
 * is not itself a package (`<prefix>/lib/node_modules/tenjin-cli` on POSIX,
 * `<prefix>\node_modules\tenjin-cli` on win32), while a project-local one sits
 * under the project root, which by definition has a package.json. That parent is
 * the whole test, which is why it holds for homebrew, nvm, volta and a
 * user-set `npm config prefix` alike without this code enumerating any of them.
 */
export function isGlobalTree(moduleDir: string): boolean {
  const segs = moduleDir.split(sep);
  const i = segs.lastIndexOf('node_modules');
  if (i <= 0) return false;
  return !existsSync(join(segs.slice(0, i).join(sep), 'package.json'));
}

/**
 * Which package manager owns this install, read off the on-disk path. Node
 * resolved the bin symlink before loading us, so the segments name the real
 * store: pnpm's virtual store keeps a literal `.pnpm` segment (or
 * `pnpm/global` for older layouts), bun installs under `.bun`, yarn under
 * `.yarn` or `yarn/global`. Everything else is treated as npm's tree; that
 * covers nvm and volta, both of which route `npm i -g` correctly.
 */
export function classifyManager(moduleDir: string): Delegable | 'yarn' {
  const segs = moduleDir.split(sep);
  const pair = (a: string, b: string): boolean => segs.includes(a) && segs.includes(b);
  if (segs.includes('.pnpm') || pair('pnpm', 'global')) return 'pnpm';
  if (segs.includes('.bun')) return 'bun';
  if (segs.includes('.yarn') || pair('yarn', 'global')) return 'yarn';
  return 'npm';
}

/**
 * How to perform a global install with each manager we delegate to.
 *
 * `scriptSuffixes` is what a PATH shim may resolve to that Node can run
 * directly, which is how win32 is served without a shell: npm and pnpm ship as
 * JS, so the child becomes `node <script>`. An empty list means the binary is
 * native (bun), where spawning it by name already works on every platform.
 */
export const MANAGERS: Record<
  Delegable,
  {
    bin: string;
    scriptSuffixes: readonly string[];
    /** Ships beside the running node, as npm does inside the Node distribution. */
    besideNode: boolean;
    args: (spec: string) => string[];
    manual: (spec: string) => string;
  }
> = {
  npm: {
    bin: 'npm',
    scriptSuffixes: ['npm-cli.js'],
    besideNode: true,
    args: (spec) => ['install', '-g', '--ignore-scripts', spec],
    manual: (spec) => `npm i -g ${spec}`,
  },
  pnpm: {
    bin: 'pnpm',
    // corepack's shim resolves to `pnpm.js`, a standalone install to `pnpm.cjs`.
    scriptSuffixes: ['.cjs', '.js'],
    besideNode: false,
    args: (spec) => ['add', '-g', '--ignore-scripts', spec],
    manual: (spec) => `pnpm add -g ${spec}`,
  },
  bun: {
    bin: 'bun',
    scriptSuffixes: [],
    besideNode: false,
    // No --ignore-scripts: bun's flag surface for it is not stable across the
    // versions in the wild, and an unknown flag would fail the install outright.
    args: (spec) => ['add', '-g', spec],
    manual: (spec) => `bun add -g ${spec}`,
  },
};

/**
 * npm's own entry script, so the child can be `node npm-cli.js` rather than the
 * `npm` shim.
 *
 * On win32 the shim is `npm.cmd`, which Node refuses to spawn without
 * `shell: true`, and `shell: true` is exactly what this command must not do —
 * it would hand back the argv safety the pinned version buys.
 *
 * Deliberately NOT "npm ships inside the Node distribution". That is a property
 * of the installer, not of Node: Homebrew's plain `node` formula keeps only
 * corepack in the keg and puts npm at the brew prefix, so a probe relative to
 * `process.execPath` alone returns null on one of the most common macOS setups.
 * So the layout is searched, not assumed — beside the running binary first
 * (official tarball and installer, nvm, volta, versioned brew kegs), then off
 * PATH, where on POSIX the `npm` shim is itself a symlink to `npm-cli.js` and on
 * win32 `npm.cmd` has `node_modules` beside it. Still null when npm cannot be
 * found at all; the caller then falls back to the bare shim, which works
 * everywhere but win32 and fails closed there into UPDATE_FAILED carrying the
 * manual command.
 */
export function resolveNpmCli(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveManagerScript('npm', execPath, env);
}

/**
 * The JS entry script for `manager`, or null when it has none to find (a native
 * binary, or a shim this cannot see through). Null means "spawn the bare name",
 * which works everywhere but win32 and fails closed there.
 */
export function resolveManagerScript(
  manager: Delegable,
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const plan = MANAGERS[manager];
  if (plan.scriptSuffixes.length === 0) return null;
  const beside = plan.besideNode ? scriptNear(dirname(execPath), plan.bin) : null;
  return beside ?? scriptOnPath(plan.bin, plan.scriptSuffixes, env);
}

/** A manager's script relative to a directory holding `node` or its own shim. */
function scriptNear(dir: string, bin: string): string | null {
  const candidates = [
    join(dir, 'node_modules', bin, 'bin', `${bin}-cli.js`),
    join(dir, '..', 'lib', 'node_modules', bin, 'bin', `${bin}-cli.js`),
  ];
  return candidates.find(isFile) ?? null;
}

/**
 * Walk PATH for the manager's shim and turn it into its script. Probes the
 * PATHEXT extensions on win32 for the same reason `onPath` in skill-wiring.ts
 * does: the real file there is `npm.cmd`, never a bare `npm`.
 */
function scriptOnPath(
  bin: string,
  suffixes: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)]
      : [''];
  for (const part of (env.PATH ?? '').split(delimiter)) {
    if (part.length === 0) continue;
    for (const ext of exts) {
      if (!isFile(join(part, `${bin}${ext}`))) continue;
      // POSIX package managers link the shim straight at the script, which is
      // what makes this layout-independent rather than a longer guess list.
      //
      // The endsWith is a CORRECTNESS check, not a security guard: it asks "did
      // this symlink land on npm's script or on something else", and a shim
      // pointed elsewhere returns null, which falls back to spawning that same
      // retargeted shim anyway. PATH poisoning is out of scope by construction —
      // an attacker ahead of npm on PATH owns every tool the user runs, and the
      // pre-existing fallback `spawn('npm', ...)` resolved through the same PATH.
      const real = realpathOrNull(join(part, `${bin}${ext}`));
      if (real !== null && suffixes.some((suffix) => real.endsWith(suffix))) return real;
      const near = scriptNear(part, bin);
      if (near !== null) return near;
    }
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

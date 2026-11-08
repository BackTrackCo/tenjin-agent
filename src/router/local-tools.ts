import { stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * THE FREE LOCAL TOOLS, AND THE ONE COMMAND EACH RUNS. The server decides when
 * a tool is offered and writes the words of its line, with `{command}` where
 * the command goes; it names a tool by its key here and nothing else. Every
 * package, version, bin and flag below belongs to this release, so a server
 * cannot make the agent run anything this table does not hold, and an unknown
 * key shows no line. Pins move only in a reviewed change to this file.
 *
 * `--before` is the day the rows were reviewed: a fresh npm resolution then
 * picks only versions that existed that day. `--ignore-scripts` is on every row
 * but ast-grep, whose own postinstall only picks its platform binary.
 */
export const LOCAL_REVIEW_DATE = '2026-10-24';

export interface LocalPackage {
  name: string;
  version: string;
  /** When this version reached npm, so a test can hold the 14-day rule offline. */
  published: string;
}

export interface LocalTool {
  /** The first package is the tool; any other is a reviewed companion. */
  packages: readonly LocalPackage[];
  bin: string;
  flags: readonly string[];
  /** Whether npm may run the packages' install scripts. */
  scripts: boolean;
  /** The flag that tells this row's run from another row of the same package. */
  marker?: string;
}

export const LOCAL_TOOLS: Readonly<Record<string, LocalTool>> = {
  'ast-grep': {
    packages: [{ name: '@ast-grep/cli', version: '0.50.0', published: '2026-10-09' }],
    bin: 'ast-grep',
    flags: ['run', '--json'],
    scripts: true,
  },
  knip: {
    packages: [{ name: 'knip', version: '6.41.0', published: '2026-10-09' }],
    bin: 'knip',
    flags: ['--reporter', 'json'],
    scripts: false,
  },
  'dependency-cruiser': {
    packages: [
      { name: 'dependency-cruiser', version: '18.5.0', published: '2026-09-30' },
      { name: 'typescript', version: '5.9.3', published: '2025-09-30' },
    ],
    bin: 'depcruise',
    flags: ['--no-config', '--output-type', 'json'],
    scripts: false,
  },
  squawk: {
    packages: [{ name: 'squawk-cli', version: '2.68.0', published: '2026-10-08' }],
    bin: 'squawk',
    flags: ['--reporter', 'json'],
    scripts: false,
  },
  attw: {
    packages: [{ name: '@arethetypeswrong/cli', version: '0.18.5', published: '2026-07-09' }],
    bin: 'attw',
    flags: ['--pack', '--format', 'json'],
    scripts: false,
    marker: '--pack',
  },
  /** One installed dependency, read from the registry: the agent appends its `<name>@<version>`. */
  'attw-npm': {
    packages: [{ name: '@arethetypeswrong/cli', version: '0.18.5', published: '2026-07-09' }],
    bin: 'attw',
    flags: ['--format', 'json', '--from-npm'],
    scripts: false,
    marker: '--from-npm',
  },
};

export function isLocalTool(key: string): boolean {
  return Object.hasOwn(LOCAL_TOOLS, key);
}

/** The command for a tool this build ships, exactly as the agent runs it. */
export function localCommand(key: string): string {
  const tool = LOCAL_TOOLS[key]!;
  return [
    'npx',
    '--yes',
    `--before=${LOCAL_REVIEW_DATE}`,
    ...(tool.scripts ? [] : ['--ignore-scripts']),
    ...tool.packages.flatMap((p) => ['-p', `${p.name}@${p.version}`]),
    tool.bin,
    ...tool.flags,
  ].join(' ');
}

/** `<package>@<version>` of the tool itself: a shell command holding it ran the pinned tool. */
export function pinnedSpec(key: string): string {
  const own = LOCAL_TOOLS[key]!.packages[0]!;
  return `${own.name}@${own.version}`;
}

/** The server's line with this build's command in its one `{command}`. */
export function fillLocalLine(line: string, key: string): string {
  const command = localCommand(key);
  return line.replace('{command}', () => command);
}

/** The pair a row's `platforms` lists when the tool is qualified here. */
export function platformPair(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

/** Whether `npx` is a file on this process's PATH. */
export async function npxOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Promise<boolean> {
  const names = platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx'];
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      if ((await stat(join(dir, name)).catch(() => null))?.isFile() === true) return true;
    }
  }
  return false;
}

/** The nearest folder at or above `from` that holds `.git`, or null. */
export async function gitRootOf(from: string): Promise<string | null> {
  let current = resolve(from);
  for (;;) {
    if ((await stat(join(current, '.git')).catch(() => null)) !== null) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Whether every named file is in `cwd` or a folder above it up to the git
 * root; with no git root, in `cwd` alone.
 */
export async function filesPresent(files: readonly string[], cwd: string): Promise<boolean> {
  if (files.length === 0) return true;
  const root = await gitRootOf(cwd);
  const dirs: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    dirs.push(current);
    const parent = dirname(current);
    if (root === null || current === root || parent === current) break;
    current = parent;
  }
  for (const file of files) {
    let found = false;
    for (const dir of dirs) {
      if ((await stat(join(dir, file)).catch(() => null))?.isFile() === true) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

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
 * `--legacy-peer-deps` is on a row whose optional peers npm would otherwise
 * resolve on a first run, though it installs none of them.
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
  /** False where npm would fetch the metadata of optional peers it never
   *  installs: oxlint's `vite-plus` peer costs about 90 MB and 4 s on a first run. */
  peers?: false;
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
  /**
   * Secrets in files, with the preset of provider rules and no config. Its
   * JSON form carries each file's whole text, secret included, so the row
   * prints the compact form, which masks every secret it finds.
   */
  secretlint: {
    packages: [{ name: '@secretlint/quick-start', version: '13.0.7', published: '2026-10-03' }],
    bin: 'quick-start',
    flags: ['--format', 'compact', '--no-color'],
    scripts: false,
  },
  /** Config files against their SchemaStore schema: it downloads the catalog and the schema, and sends no file. */
  v8r: {
    packages: [{ name: 'v8r', version: '6.1.0', published: '2026-05-17' }],
    bin: 'v8r',
    flags: ['--output-format', 'json'],
    scripts: false,
  },
  /**
   * The jsx-a11y rules alone: every other rule is allowed off, then the 35
   * this version turns on with the plugin are named, so a project config's
   * top-level rules and plugins and a nested config change nothing.
   */
  'oxlint-a11y': {
    packages: [{ name: 'oxlint', version: '1.87.0', published: '2026-10-05' }],
    bin: 'oxlint',
    flags: [
      '--jsx-a11y-plugin',
      '--disable-nested-config',
      '-A',
      'all',
      '-W',
      'jsx-a11y/alt-text',
      '-W',
      'jsx-a11y/anchor-has-content',
      '-W',
      'jsx-a11y/anchor-is-valid',
      '-W',
      'jsx-a11y/aria-activedescendant-has-tabindex',
      '-W',
      'jsx-a11y/aria-props',
      '-W',
      'jsx-a11y/aria-proptypes',
      '-W',
      'jsx-a11y/aria-role',
      '-W',
      'jsx-a11y/aria-unsupported-elements',
      '-W',
      'jsx-a11y/autocomplete-valid',
      '-W',
      'jsx-a11y/click-events-have-key-events',
      '-W',
      'jsx-a11y/control-has-associated-label',
      '-W',
      'jsx-a11y/heading-has-content',
      '-W',
      'jsx-a11y/html-has-lang',
      '-W',
      'jsx-a11y/iframe-has-title',
      '-W',
      'jsx-a11y/img-redundant-alt',
      '-W',
      'jsx-a11y/interactive-supports-focus',
      '-W',
      'jsx-a11y/label-has-associated-control',
      '-W',
      'jsx-a11y/lang',
      '-W',
      'jsx-a11y/media-has-caption',
      '-W',
      'jsx-a11y/mouse-events-have-key-events',
      '-W',
      'jsx-a11y/no-access-key',
      '-W',
      'jsx-a11y/no-aria-hidden-on-focusable',
      '-W',
      'jsx-a11y/no-autofocus',
      '-W',
      'jsx-a11y/no-distracting-elements',
      '-W',
      'jsx-a11y/no-interactive-element-to-noninteractive-role',
      '-W',
      'jsx-a11y/no-noninteractive-element-interactions',
      '-W',
      'jsx-a11y/no-noninteractive-element-to-interactive-role',
      '-W',
      'jsx-a11y/no-noninteractive-tabindex',
      '-W',
      'jsx-a11y/no-redundant-roles',
      '-W',
      'jsx-a11y/no-static-element-interactions',
      '-W',
      'jsx-a11y/prefer-tag-over-role',
      '-W',
      'jsx-a11y/role-has-required-aria-props',
      '-W',
      'jsx-a11y/role-supports-aria-props',
      '-W',
      'jsx-a11y/scope',
      '-W',
      'jsx-a11y/tabindex-no-positive',
      '--format',
      'json',
    ],
    scripts: false,
    peers: false,
  },
  'type-coverage': {
    packages: [
      { name: 'type-coverage', version: '2.30.3', published: '2026-10-03' },
      { name: 'typescript', version: '5.9.3', published: '2025-09-30' },
    ],
    bin: 'type-coverage',
    flags: ['--detail', '--strict', '--json-output'],
    scripts: false,
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
    ...(tool.peers === false ? ['--legacy-peer-deps'] : []),
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

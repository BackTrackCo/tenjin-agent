import { describe, expect, it } from 'vitest';
import {
  codexCommand,
  globMatches,
  holdsSpec,
  matchesOutput,
  matchesWords,
  MAX_COMMAND_CHARS,
  mayMatchPath,
  normalizedPath,
  outputTails,
  OUTPUT_TAIL_CHARS,
  parseCommand,
  relativeTo,
} from './local-command';

const words = (command: string | string[], match: Parameters<typeof matchesWords>[1]) => {
  const parsed = parseCommand(command);
  return parsed !== null && matchesWords(parsed, match);
};

const DRIZZLE = { words: ['drizzle-kit', 'generate'] };
const PRISMA = { words: ['prisma', 'migrate', 'dev'] };
const NPM_PACK = { words: ['npm', 'pack'], bare: true };
const RG_MULTILINE = { words: ['rg'], flags: ['-U', '--multiline'] };

/**
 * THE PARSER, ON COMMANDS AGENTS ACTUALLY RUN. A rule names a command's
 * leading words; what the shell would not run as that command (a heredoc
 * body, a comment, a package argument) must never read as it.
 */
describe('parseCommand and the command-word rules', () => {
  it('does not read a heredoc body or a comment as a command', () => {
    expect(words("cat <<'EOF' > notes.md\ndrizzle-kit generate\nEOF\n", DRIZZLE)).toBe(false);
    expect(words('cat <<-END\n\tdrizzle-kit generate\n\tEND\nls', DRIZZLE)).toBe(false);
    expect(words('ls # then drizzle-kit generate', DRIZZLE)).toBe(false);
    expect(words("cat <<'EOF'\nx\nEOF\ndrizzle-kit generate", DRIZZLE)).toBe(true);
  });

  it('finds the command behind cd, runners and assignments', () => {
    expect(words('cd app && pnpm exec drizzle-kit generate --name x', DRIZZLE)).toBe(true);
    expect(words('FOO=1 npx prisma migrate dev', PRISMA)).toBe(true);
    expect(words('pnpm drizzle-kit generate', DRIZZLE)).toBe(true);
    expect(words('sudo -u me env A=1 npx --yes -p prisma@6 prisma migrate dev', PRISMA)).toBe(true);
    expect(words('(cd db; ./node_modules/.bin/drizzle-kit generate) | tee log', DRIZZLE)).toBe(
      true,
    );
    expect(words('echo $(drizzle-kit generate)', DRIZZLE)).toBe(true);
    expect(words('echo "drizzle-kit generate"', DRIZZLE)).toBe(false);
    expect(words('drizzle-kit generate:pg', DRIZZLE)).toBe(false);
  });

  it('tells a bare npm pack from one that packs a named package', () => {
    expect(words('npm pack', NPM_PACK)).toBe(true);
    expect(words('npm pack --dry-run 2>&1', NPM_PACK)).toBe(true);
    expect(words('npm pack lucide-react@1.31.0', NPM_PACK)).toBe(false);
  });

  it('matches a multiline search flag, alone or in a cluster, and nothing else', () => {
    expect(words("rg -U 'a\\nb' src", RG_MULTILINE)).toBe(true);
    expect(words('rg --multiline foo', RG_MULTILINE)).toBe(true);
    expect(words('rg -nU foo', RG_MULTILINE)).toBe(true);
    expect(words('rg -n foo', RG_MULTILINE)).toBe(false);
    expect(words('grep -U foo', RG_MULTILINE)).toBe(false);
  });

  it('keeps quoting: a quoted separator does not split a command', () => {
    expect(parseCommand(`echo 'a && drizzle-kit generate'`)).toEqual([
      {
        words: ['echo', 'a && drizzle-kit generate'],
        tokens: ['echo', 'a && drizzle-kit generate'],
      },
    ]);
    expect(parseCommand('a "b \\"c\\" d" e\\ f')).toEqual([
      { words: ['a', 'b "c" d', 'e f'], tokens: ['a', 'b "c" d', 'e f'] },
    ]);
  });

  it('matches nothing in a command that does not parse', () => {
    expect(parseCommand(`drizzle-kit generate 'unclosed`)).toBeNull();
    expect(words(`drizzle-kit generate "unclosed`, DRIZZLE)).toBe(false);
  });

  it('parses only the first 32 KiB of a command', () => {
    const pad = `echo ${'x'.repeat(MAX_COMMAND_CHARS)}`;
    expect(words(`drizzle-kit generate; ${pad}`, DRIZZLE)).toBe(true);
    expect(words(`${pad}; drizzle-kit generate`, DRIZZLE)).toBe(false);
  });

  it('finds a pinned package in a flag or alone, not in an echo of something else', () => {
    const parsed = parseCommand(
      'npx --yes --before=2026-10-24 --ignore-scripts -p knip@6.41.0 knip --reporter json',
    )!;
    expect(holdsSpec(parsed, 'knip@6.41.0')).toBe(true);
    expect(holdsSpec(parseCommand('npx --package=knip@6.41.0 knip')!, 'knip@6.41.0')).toBe(true);
    expect(holdsSpec(parseCommand('npx knip@6.40.0')!, 'knip@6.41.0')).toBe(false);
  });

  it("reads a Codex command as a script or an argv, and bash -lc's script as one", () => {
    expect(codexCommand('pnpm drizzle-kit generate')).toBe('pnpm drizzle-kit generate');
    expect(codexCommand(['bash', '-lc', 'cd app && drizzle-kit generate'])).toBe(
      'cd app && drizzle-kit generate',
    );
    expect(codexCommand(['/bin/zsh', '-c', 'x'])).toBe('x');
    expect(codexCommand(['npx', 'prisma', 'migrate', 'dev'])).toEqual([
      'npx',
      'prisma',
      'migrate',
      'dev',
    ]);
    expect(words(codexCommand(['npx', 'prisma', 'migrate', 'dev'])!, PRISMA)).toBe(true);
    expect(codexCommand({ cmd: 'x' })).toBeNull();
  });
});

describe('the path rules', () => {
  it('know * within a segment and ** across segments, and nothing else', () => {
    expect(globMatches('.github/workflows/*', '.github/workflows/ci.yml')).toBe(true);
    expect(globMatches('Dockerfile', 'Dockerfile')).toBe(true);
    expect(globMatches('**/*.sh', 'scripts/x.sh')).toBe(true);
    expect(globMatches('**/*.sh', 'x.sh')).toBe(true);
    expect(globMatches('**/migrations/**/*.sql', 'db/migrations/0001_init.sql')).toBe(true);
    expect(globMatches('.github/workflows/*', 'docs/workflows.md')).toBe(false);
    expect(globMatches('*.sql', 'drizzle/0001.sql')).toBe(false);
    // A regex-shaped glob is a literal.
    expect(globMatches('a.c', 'abc')).toBe(false);
    expect(globMatches('(a|b)', 'a')).toBe(false);
  });

  it("matches a Windows path after its backslashes, relative to the project's root", () => {
    const absolute = normalizedPath('C:\\repo\\.github\\workflows\\ci.yml', 'C:\\repo');
    expect(absolute).toBe('C:/repo/.github/workflows/ci.yml');
    expect(relativeTo('C:\\repo', absolute)).toBe('.github/workflows/ci.yml');
    expect(normalizedPath('scripts\\x.sh', '/work')).toBe('/work/scripts/x.sh');
    expect(relativeTo('/work', '/elsewhere/x.sh')).toBeNull();
  });

  it('screens a path in memory before any root is read', () => {
    expect(mayMatchPath(['drizzle/**/*.sql'], '/home/me/app/drizzle/0001.sql')).toBe(true);
    expect(mayMatchPath(['drizzle/**/*.sql'], '/home/me/app/src/index.ts')).toBe(false);
  });

  it('stays linear on a pattern of many **', () => {
    const glob = Array.from({ length: 40 }, () => '**').join('/') + '/z';
    const path = Array.from({ length: 60 }, () => 'a').join('/');
    expect(globMatches(glob, path)).toBe(false);
  });
});

describe('the output rules', () => {
  it('read only the last 16 KiB of each string, CRLF as LF', () => {
    const head = 'ReferenceError: x before initialization';
    const late = `${head}${'.'.repeat(OUTPUT_TAIL_CHARS)}`;
    expect(matchesOutput(outputTails({ stdout: late }), ['before initialization'])).toBe(false);
    expect(
      matchesOutput(outputTails({ stdout: `${'.'.repeat(OUTPUT_TAIL_CHARS)}${head}` }), [
        'before initialization',
      ]),
    ).toBe(true);
    expect(matchesOutput(outputTails({ stderr: 'a\r\nb' }), ['a\nb'])).toBe(true);
    expect(
      matchesOutput(outputTails(undefined, 'Exit code 1\nbefore initialization'), [
        'before initialization',
      ]),
    ).toBe(true);
    expect(
      matchesOutput(outputTails({ stdout: 'Before Initialization' }), ['before initialization']),
    ).toBe(false);
  });
});

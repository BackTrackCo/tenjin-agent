import { isAbsolute, resolve } from 'node:path';
import { parse } from 'shell-quote';

/** shell-quote owns shell words/operators. This module admits a small read-only
 * command language; it never executes, expands the filesystem, or reads env. */
export interface RepositoryShellCandidate {
  cwd: string;
  origin: 'Bash';
  input: {
    pattern: string;
    path: string;
    glob?: string;
    type?: string;
    output_mode: 'content' | 'files_with_matches';
    '-i'?: boolean;
    '-n'?: boolean;
    '-A'?: number;
    '-B'?: number;
    '-C'?: number;
    multiline?: boolean;
    head_limit?: number;
  };
  shell: {
    executable: 'rg' | 'grep';
    /** The path is carried separately and must be canonicalized by admission. */
    argv: string[];
    filters: { executable: 'head' | 'grep' | 'cut'; argv: string[]; lines?: number }[];
    stderr: 'inherit' | 'discard';
  };
}
export interface RepositoryShellSearch {
  mode: 'replace' | 'augment';
  candidates: RepositoryShellCandidate[];
}
type Word = { value: string; glob: boolean };
type Token = Word | { op: string };
const names = new Map([
  ['rg', 'rg'],
  ['/opt/homebrew/bin/rg', 'rg'],
  ['/usr/local/bin/rg', 'rg'],
  ['grep', 'grep'],
  ['/usr/bin/grep', 'grep'],
  ['/bin/grep', 'grep'],
] as const);
const numeric = (s: string) => /^\d{1,6}$/.test(s) && Number(s) <= 999999;
const word = (t: Token | undefined): t is Word => t !== undefined && 'value' in t;

/** Only a quote-balance/redirection guard, not another tokenizer. In
 * particular shell-quote tolerates an unterminated quote, whereas Bash does not. */
function textAllowed(command: string): boolean {
  if (
    !command.trim() ||
    Buffer.byteLength(command) > 8000 ||
    [...command].some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && code !== 9) || code === 127 || char === '`';
    }) ||
    command.includes('$(') ||
    command.includes("$'")
  )
    return false;
  let quote: 'single' | 'double' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === 'single') {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      if (++i >= command.length) return false;
      continue;
    }
    if (quote === 'double') {
      if (c === '"') quote = null;
      continue;
    }
    if (c === "'") {
      quote = 'single';
      continue;
    }
    if (c === '"') {
      quote = 'double';
      continue;
    }
    if ('{}<'.includes(c)) return false;
    if (c === '>') {
      const before = command[i - 2];
      const suffix = command.slice(i - 1, i + 10);
      const after = command[i + 10];
      if (
        suffix !== '2>/dev/null' ||
        (before !== undefined && !/[\s;]/.test(before)) ||
        (after !== undefined && !/[\s;|&]/.test(after))
      )
        return false;
      i += 9;
    }
  }
  return quote === null;
}

function tokensOf(command: string): Token[] | null {
  if (!textAllowed(command)) return null;
  try {
    const parsed = parse(command, () => ({ unsupportedExpansion: true }));
    if (parsed.length > 256) return null;
    const tokens: Token[] = [];
    for (const token of parsed) {
      if (typeof token === 'string') tokens.push({ value: token, glob: false });
      else if ('op' in token && token.op === 'glob' && 'pattern' in token)
        tokens.push({ value: token.pattern, glob: true });
      else if ('op' in token && ['&&', ';', '|', '>'].includes(token.op))
        tokens.push({ op: token.op });
      else return null;
    }
    return tokens;
  } catch {
    return null;
  }
}

function separate(tokens: Token[], separator: string): Token[][] | null {
  const result: Token[][] = [[]];
  for (const token of tokens) {
    if (!word(token) && token.op === separator) {
      if (!result.at(-1)!.length) return null;
      result.push([]);
    } else result.at(-1)!.push(token);
  }
  return result.at(-1)!.length ? result : null;
}

function commandWords(tokens: Token[]): { words: Word[]; stderr: 'inherit' | 'discard' } | null {
  let stderr: 'inherit' | 'discard' = 'inherit';
  const result: Word[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!word(token)) {
      if (
        token.op !== '>' ||
        result.at(-1)?.value !== '2' ||
        !word(tokens[i + 1]) ||
        (tokens[i + 1] as Word).value !== '/dev/null' ||
        stderr === 'discard'
      )
        return null;
      result.pop();
      i++;
      stderr = 'discard';
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) || token.value.startsWith('~'))
      return null;
    else result.push(token);
  }
  return result.length ? { words: result, stderr } : null;
}

const booleanOptions = new Set([
  '-n',
  '--line-number',
  '-i',
  '--ignore-case',
  '-I',
  '-S',
  '--smart-case',
  '-s',
  '--case-sensitive',
  '-w',
  '--word-regexp',
  '-x',
  '--line-regexp',
  '-F',
  '--fixed-strings',
  '-E',
  '--extended-regexp',
  '-G',
  '--basic-regexp',
  '-P',
  '--pcre2',
  '-U',
  '--multiline',
  '--multiline-dotall',
  '-l',
  '--files-with-matches',
  '-H',
  '--with-filename',
  '-h',
  '--no-filename',
  '--no-heading',
  '--heading',
  '--column',
  '--no-column',
  '-r',
  '--recursive',
  '--no-messages',
]);
const valueOptions = new Map([
  ['-e', 'pattern'],
  ['--regexp', 'pattern'],
  ['-A', 'number'],
  ['--after-context', 'number'],
  ['-B', 'number'],
  ['--before-context', 'number'],
  ['-C', 'number'],
  ['--context', 'number'],
  ['-m', 'number'],
  ['--max-count', 'number'],
  ['-g', 'glob'],
  ['--glob', 'glob'],
  ['--iglob', 'glob'],
  ['--include', 'glob'],
  ['--exclude', 'glob'],
  ['--exclude-dir', 'glob'],
  ['-t', 'type'],
  ['--type', 'type'],
  ['-T', 'type'],
  ['--type-not', 'type'],
  ['--color', 'color'],
]);

function search(
  words: Word[],
  cwd: string,
  stderr: 'inherit' | 'discard',
): { valid: boolean; candidate?: RepositoryShellCandidate; expanded: boolean } {
  const executable = names.get(words[0]!.value as Parameters<typeof names.get>[0]);
  if (!executable) return { valid: false, expanded: false };
  const options: [string, string?][] = [],
    positional: { word: Word; index: number }[] = [];
  const patterns: string[] = [],
    pathIndices: number[] = [];
  let end = false,
    expanded = false;
  const add = (option: string, value?: Word): boolean => {
    const grepOnly = [
      '-E',
      '--extended-regexp',
      '-G',
      '--basic-regexp',
      '-h',
      '--no-filename',
      '-r',
      '--recursive',
      '-I',
      '--include',
      '--exclude',
      '--exclude-dir',
    ];
    const rgOnly = [
      '-S',
      '--smart-case',
      '--case-sensitive',
      '-P',
      '--pcre2',
      '-U',
      '--multiline',
      '--multiline-dotall',
      '--no-heading',
      '--heading',
      '--column',
      '--no-column',
      '-g',
      '--glob',
      '--iglob',
      '-t',
      '--type',
      '-T',
      '--type-not',
    ];
    if (
      (executable === 'rg' && grepOnly.includes(option)) ||
      (executable === 'grep' && rgOnly.includes(option))
    )
      return false;
    const kind = valueOptions.get(option);
    if (!kind) {
      options.push([option]);
      return booleanOptions.has(option);
    }
    if (!value?.value || value.value.includes('\0') || value.value.length > 2000) return false;
    if (kind === 'number' && !numeric(value.value)) return false;
    if (kind === 'color' && value.value !== 'never' && value.value !== 'auto') return false;
    if (
      kind === 'glob' &&
      (isAbsolute(value.value.replace(/^!/, '')) || value.value.split('/').includes('..'))
    )
      return false;
    if (kind === 'pattern') {
      if (value.glob) return false;
      patterns.push(value.value);
    } else if (value.glob && kind !== 'glob') return false;
    expanded ||= value.glob;
    options.push([option, value.value]);
    return true;
  };
  for (let i = 1; i < words.length; i++) {
    const current = words[i]!,
      text = current.value;
    if (!end && text === '--') {
      end = true;
      continue;
    }
    if (!end && text.startsWith('-')) {
      if (text.startsWith('--')) {
        const equal = text.indexOf('=');
        const option = equal < 0 ? text : text.slice(0, equal);
        if (booleanOptions.has(option) && equal < 0) {
          if (!add(option)) return { valid: false, expanded };
        } else if (valueOptions.has(option)) {
          const value =
            equal < 0 ? words[++i] : { value: text.slice(equal + 1), glob: current.glob };
          if (!add(option, value)) return { valid: false, expanded };
        } else return { valid: false, expanded };
      } else {
        if (current.glob || text.length < 2) return { valid: false, expanded };
        for (let j = 1; j < text.length; j++) {
          const option = `-${text[j]}`;
          if (valueOptions.has(option)) {
            const value =
              j + 1 < text.length ? { value: text.slice(j + 1), glob: false } : words[++i];
            if (!add(option, value)) return { valid: false, expanded };
            break;
          }
          if (!add(option)) return { valid: false, expanded };
        }
      }
    } else positional.push({ word: current, index: i });
  }
  if (!patterns.length) {
    const first = positional.shift();
    if (!first || first.word.glob || !first.word.value) return { valid: false, expanded };
    patterns.push(first.word.value);
  }
  // Valid read-only multi-pattern/file searches remain companions, not a
  // guessed semantic query with a different pattern or an invented scope.
  if (patterns.length !== 1 || patterns[0]!.length > 2000) return { valid: true, expanded };
  // An expanded rg filename could become --pre=... rather than a path.
  if (executable === 'rg' && positional.some(({ word: value }) => value.glob))
    return { valid: false, expanded };
  if (positional.length > 1 || positional.some(({ word: value }) => value.glob))
    return { valid: true, expanded };
  const recursive = options.some(([name]) => name === '-r' || name === '--recursive');
  if (executable === 'grep' && !recursive) return { valid: true, expanded };
  const path = positional[0]?.word.value ?? '.';
  if (path === '-' || path.length > 1000) return { valid: true, expanded };
  if (positional[0]) pathIndices.push(positional[0].index);
  const input: RepositoryShellCandidate['input'] = {
    pattern: patterns[0]!,
    path,
    output_mode: 'content',
  };
  for (const [name, value] of options) {
    if (['-l', '--files-with-matches'].includes(name)) input.output_mode = 'files_with_matches';
    if (['-i', '--ignore-case'].includes(name)) input['-i'] = true;
    if (executable === 'rg' && ['-s', '--case-sensitive'].includes(name)) input['-i'] = false;
    if (executable === 'rg' && ['-S', '--smart-case'].includes(name)) delete input['-i'];
    if (['-n', '--line-number'].includes(name)) input['-n'] = true;
    if (['-U', '--multiline', '--multiline-dotall'].includes(name)) input.multiline = true;
    if (['-A', '--after-context'].includes(name)) input['-A'] = Number(value);
    if (['-B', '--before-context'].includes(name)) input['-B'] = Number(value);
    if (['-C', '--context'].includes(name)) input['-C'] = Number(value);
    if (['-g', '--glob', '--include'].includes(name) && input.glob === undefined)
      input.glob = value;
    if (['-t', '--type'].includes(name)) input.type = value;
  }
  return {
    valid: true,
    expanded,
    candidate: {
      cwd,
      origin: 'Bash',
      input,
      shell: {
        executable,
        argv: words
          .slice(1)
          .map((value, index) =>
            pathIndices.includes(index + 1) ? '<repository-path>' : value.value,
          ),
        filters: [],
        stderr,
      },
    },
  };
}

function filter(words: Word[]): RepositoryShellCandidate['shell']['filters'][number] | null {
  if (words.some((w) => w.glob)) return null;
  const [command, ...args] = words.map((w) => w.value);
  if (command === 'head') {
    const count = !args.length
      ? '10'
      : args.length === 1 && /^-\d+$/.test(args[0]!)
        ? args[0]!.slice(1)
        : args.length === 2 && ['-n', '--lines'].includes(args[0]!)
          ? args[1]
          : args.length === 1 && args[0]!.startsWith('--lines=')
            ? args[0]!.slice(8)
            : undefined;
    return count && numeric(count) && Number(count) > 0
      ? { executable: 'head', argv: args, lines: Number(count) }
      : null;
  }
  if (command === 'cut' && args.length === 1 && /^-c1-[1-9]\d{0,5}$/.test(args[0]!))
    return { executable: 'cut', argv: args };
  if (command === 'grep') {
    let patterns = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '-e' || arg === '--regexp') {
        if (!args[++i]) return null;
        patterns++;
      } else if (/^-[vinEFGwx]+$/.test(arg)) continue;
      else if (arg.startsWith('-')) return null;
      else patterns++;
    }
    return patterns === 1 ? { executable: 'grep', argv: args } : null;
  }
  return null;
}

/** No write flags, shell programs, arbitrary sed scripts, git aliases/config,
 * or executable find actions enter this list. Companions are never sent out. */
function readOnlyCompanion(words: Word[]): boolean {
  const [name, ...args] = words.map((w) => w.value);
  // These programs have write/follow/execution switches that an expanded
  // filename could impersonate. Literal arguments remain allow-listed below.
  if (['sed', 'head', 'tail', 'git'].includes(name ?? '') && words.some((w) => w.glob))
    return false;
  const paths = (values: string[]) => values.every((v) => v && v !== '-' && !v.startsWith('-'));
  if (name === 'pwd') return args.length === 0;
  if (name === 'echo') return args.every((v) => !v.startsWith('-'));
  if (name === 'ls') return args.every((v) => !v.startsWith('-') || /^-[alhdtr1A]+$/.test(v));
  if (name === 'wc') return args[0] === '-l' && paths(args.slice(1));
  if (name === 'cat') return paths(args[0] === '-n' ? args.slice(1) : args);
  if (name === 'sed')
    return args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1] ?? '') && paths(args.slice(2));
  if (name === 'head' || name === 'tail') {
    if (!args.length) return true;
    if (/^-\d+$/.test(args[0]!)) return paths(args.slice(1));
    return args[0] === '-n' && numeric(args[1] ?? '') && paths(args.slice(2));
  }
  if (name === 'rg' && args[0] === '--files') return paths(args.slice(1));
  if (name !== 'git') return false;
  const options = [...args];
  if (options[0] === '-C') {
    if (!options[1] || words[2]?.glob) return false;
    options.splice(0, 2);
  }
  const subcommand = options.shift();
  if (subcommand === 'ls-files') return options.every((v) => !v.startsWith('-') || v === '--');
  if (subcommand === 'ls-tree')
    return options.every((v) => !v.startsWith('-') || ['-r', '--name-only'].includes(v));
  if (subcommand === 'show') {
    if (options.length === 1 && /^[A-Za-z0-9_./-]+:[^\0]+$/.test(options[0]!)) return true;
    if (options.length === 2 && options[0] === '--stat' && options[1] === 'HEAD') return true;
    // These companion arguments remain local and the hook never runs Git.
    // Admit no diff-driver switches or Git pathspec magic, even when quoted.
    return (
      options.length >= 3 &&
      options[0] === 'HEAD' &&
      options[1] === '--' &&
      options
        .slice(2)
        .every(
          (path) =>
            /^[A-Za-z0-9_.][A-Za-z0-9_./ -]*$/.test(path) && !path.split('/').includes('..'),
        )
    );
  }
  if (subcommand === 'log')
    return options.every(
      (v) =>
        v === '--oneline' ||
        /^-\d+$/.test(v) ||
        (!v.startsWith('-') && /^[A-Za-z0-9_./-]+$/.test(v)),
    );
  if (subcommand === 'branch') return options.length === 1 && options[0] === '--show-current';
  if (subcommand === 'status') return options.every((v) => ['--short', '--porcelain'].includes(v));
  return false;
}

export function parseRepositoryShellSearch(
  raw: unknown,
  initialCwd: string,
): RepositoryShellSearch | null {
  if (!isAbsolute(initialCwd) || raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return null;
  const input = raw as Record<string, unknown>;
  if (
    typeof input.command !== 'string' ||
    input.run_in_background === true ||
    'cwd' in input ||
    'workdir' in input
  )
    return null;
  const tokens = tokensOf(input.command);
  if (!tokens) return null;
  const statements: { tokens: Token[]; next?: string }[] = [{ tokens: [] }];
  for (const token of tokens) {
    if (!word(token) && [';', '&&'].includes(token.op)) {
      if (!statements.at(-1)!.tokens.length) return null;
      statements.at(-1)!.next = token.op;
      statements.push({ tokens: [] });
    } else statements.at(-1)!.tokens.push(token);
  }
  if (!statements.at(-1)!.tokens.length || statements.length > 16) return null;
  let cwd = initialCwd,
    substantive = 0,
    augment = false;
  const candidates: RepositoryShellCandidate[] = [];
  for (const statement of statements) {
    const pieces = separate(statement.tokens, '|');
    if (!pieces || pieces.length > 4) return null;
    const commands = pieces.map(commandWords);
    if (commands.some((c) => c === null)) return null;
    const first = commands[0]!;
    if (first.words[0]!.value === 'cd') {
      if (
        commands.length !== 1 ||
        first.words.length !== 2 ||
        first.words[1]!.glob ||
        first.words[1]!.value.startsWith('-') ||
        statement.next !== '&&' ||
        first.stderr !== 'inherit'
      )
        return null;
      cwd = resolve(cwd, first.words[1]!.value);
      // Claude persists Bash's directory changes; suppressing the original
      // command would silently lose that state even for a single search.
      augment = true;
      continue;
    }
    substantive++;
    const found = search(first.words, cwd, first.stderr);
    if (!found.valid && !readOnlyCompanion(first.words)) return null;
    const filters = commands.slice(1).map((c) => filter(c!.words));
    if (filters.some((f) => f === null)) return null;
    if (!found.candidate) continue;
    found.candidate.shell.filters = filters as RepositoryShellCandidate['shell']['filters'];
    const head = filters.find((f) => f?.executable === 'head');
    if (head?.lines !== undefined) found.candidate.input.head_limit = head.lines;
    augment ||= found.expanded || filters.some((f) => f?.executable !== 'head');
    candidates.push(found.candidate);
    if (candidates.length > 4) return null;
  }
  if (!candidates.length) return null;
  return { mode: augment || substantive !== 1 ? 'augment' : 'replace', candidates };
}

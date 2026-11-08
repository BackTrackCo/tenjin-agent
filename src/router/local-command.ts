import { posix } from 'node:path';

/**
 * THE AFTER-CALL MATCHERS, ALL IN THIS PROCESS. A rule from the server names
 * literal words, globs or output strings, and nothing here turns one into a
 * regular expression, so a rule cannot make a leg slow. The command is parsed
 * the way a shell splits it, closely enough to find each simple command's
 * leading words; a command that does not parse matches nothing.
 */

/** How much of a command is parsed, and of each output string read. */
export const MAX_COMMAND_CHARS = 32 * 1024;
export const OUTPUT_TAIL_CHARS = 16 * 1024;

/** One simple command: its words as matched, and every word it held. */
export interface SimpleCommand {
  words: string[];
  tokens: string[];
}

type Token = { kind: 'word'; text: string } | { kind: 'sep' };

const RESERVED = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The words of each simple command in `command`, or null when it does not
 * parse (an unclosed quote). Heredoc bodies and comments are dropped, and
 * `;`, `&&`, `||`, `|`, `&`, new lines, parentheses, `$(` and backticks split
 * commands. An argv array is one simple command, as Codex sends it.
 */
export function parseCommand(command: string | readonly string[]): SimpleCommand[] | null {
  if (typeof command !== 'string') {
    const tokens = command.filter((w): w is string => typeof w === 'string');
    const words = stripLead(tokens);
    return words.length === 0 ? [] : [{ words, tokens }];
  }
  const tokens = tokenize(command.slice(0, MAX_COMMAND_CHARS));
  if (tokens === null) return null;
  const out: SimpleCommand[] = [];
  let current: string[] = [];
  const flush = () => {
    const words = stripLead(current);
    if (words.length > 0) out.push({ words, tokens: current });
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === 'sep') flush();
    else current.push(token.text);
  }
  flush();
  return out;
}

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let word: string | null = null;
  let dropNext = false;
  let heredocNext: { strip: boolean } | null = null;
  const heredocs: { delim: string; strip: boolean }[] = [];
  const end = () => {
    if (word === null) return;
    if (heredocNext !== null) heredocs.push({ delim: word, ...heredocNext });
    else if (!dropNext) tokens.push({ kind: 'word', text: word });
    heredocNext = null;
    dropNext = false;
    word = null;
  };
  const sep = () => {
    end();
    tokens.push({ kind: 'sep' });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === ' ' || c === '\t' || c === '\r') {
      end();
      i++;
    } else if (c === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      word = (word ?? '') + (next ?? '');
      i += 2;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) return null;
      word = (word ?? '') + src.slice(i + 1, close);
      i = close + 1;
    } else if (c === '$' && next === "'") {
      let j = i + 2;
      let text = '';
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          text += src[j + 1];
          j += 2;
        } else text += src[j++];
      }
      if (j >= src.length) return null;
      word = (word ?? '') + text;
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1]!)) {
          if (src[j + 1] !== '\n') text += src[j + 1];
          j += 2;
        } else text += src[j++];
      }
      if (j >= src.length) return null;
      word = (word ?? '') + text;
      i = j + 1;
    } else if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\n') {
      sep();
      i = skipHeredocs(src, i + 1, heredocs);
    } else if (c === '&' && next === '>') {
      end();
      i += src[i + 2] === '>' ? 3 : 2;
      dropNext = true;
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      sep();
      i++;
    } else if (c === '$' && next === '(') {
      sep();
      i += 2;
    } else if (c === '<' || c === '>') {
      // A word of digits right before the operator is its file descriptor.
      if (word !== null && /^\d+$/.test(word)) word = null;
      end();
      if (next === '(') {
        sep();
        i += 2;
      } else if (c === '<' && next === '<' && src[i + 2] !== '<') {
        const strip = src[i + 2] === '-';
        i += strip ? 3 : 2;
        heredocNext = { strip };
      } else {
        i++;
        while (i < src.length && '<>&|'.includes(src[i]!)) i++;
        dropNext = true;
      }
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  end();
  return tokens;
}

/** Past each pending heredoc's body, from the line after its operator. */
function skipHeredocs(
  src: string,
  from: number,
  heredocs: { delim: string; strip: boolean }[],
): number {
  let i = from;
  for (const { delim, strip } of heredocs.splice(0)) {
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const line = src.slice(i, nl === -1 ? src.length : nl);
      i = nl === -1 ? src.length : nl + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
    }
  }
  return i;
}

/** Flags that take the next word as their value, per runner. */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  npx: new Set(['-p', '--package', '-c', '--call', '-w', '--workspace', '--registry', '--cache']),
  bunx: new Set(['-p', '--package']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '-R']),
  time: new Set(['-f', '-o']),
  xargs: new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a']),
  pm: new Set(['-C', '--dir', '--filter', '-F', '--prefix', '-w', '--workspace', '--cwd']),
};

/** `pnpm exec`, `pnpm dlx`, `yarn dlx`, `npm exec` and `npm x`. */
const PM_RUNNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['dlx']),
  npm: new Set(['exec', 'x']),
};

function skipFlags(words: string[], values: ReadonlySet<string>): string[] {
  let i = 0;
  while (i < words.length && words[i]!.startsWith('-') && words[i] !== '-') {
    const flag = words[i]!;
    i++;
    if (flag === '--') break;
    if (!flag.includes('=') && values.has(flag)) i++;
  }
  return words.slice(i);
}

/** The command's own words: reserved words, assignments and runners dropped. */
function stripLead(tokens: readonly string[]): string[] {
  let words = [...tokens];
  for (let guard = 0; guard < 16; guard++) {
    while (words.length > 0 && (RESERVED.has(words[0]!) || ASSIGNMENT.test(words[0]!))) {
      words = words.slice(1);
    }
    const first = words[0];
    if (first === undefined) return [];
    if (first === 'npx' || first === 'bunx' || first === 'sudo' || first === 'time') {
      words = skipFlags(words.slice(1), VALUE_FLAGS[first]!);
    } else if (first === 'env') {
      words = skipFlags(words.slice(1), VALUE_FLAGS.env!);
    } else if (first === 'xargs') {
      words = skipFlags(words.slice(1), VALUE_FLAGS.xargs!);
    } else if (PM_RUNNERS[first] !== undefined) {
      const rest = skipFlags(words.slice(1), VALUE_FLAGS.pm!);
      if (rest[0] === undefined || !PM_RUNNERS[first].has(rest[0])) break;
      words = skipFlags(rest.slice(1), VALUE_FLAGS.npx!);
    } else break;
  }
  return words;
}

/** The last segment of a path, either separator. */
function baseName(word: string): string {
  const parts = word.split(/[\\/]/);
  return parts[parts.length - 1] ?? word;
}

/**
 * The word lists one simple command is matched as: as written, and without a
 * leading `pnpm` or `yarn`, which run a project's bin by its name
 * (`pnpm drizzle-kit generate`).
 */
function readings(command: SimpleCommand): string[][] {
  const { words } = command;
  return words[0] === 'pnpm' || words[0] === 'yarn' ? [words, words.slice(1)] : [words];
}

export interface WordsMatch {
  words: readonly string[];
  bare?: boolean;
  flags?: readonly string[];
}

/** Whether a word is one of `flags`, a single-letter one also inside `-nU`. */
function namesFlag(word: string, flags: readonly string[]): boolean {
  return flags.some(
    (flag) =>
      word === flag ||
      word.startsWith(`${flag}=`) ||
      (/^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]{2,}$/.test(word) && word.includes(flag[1]!)),
  );
}

/** Whether any simple command leads with `match.words`, and meets `bare` and `flags`. */
export function matchesWords(commands: readonly SimpleCommand[], match: WordsMatch): boolean {
  return commands.some((command) =>
    readings(command).some((words) => {
      if (words.length < match.words.length) return false;
      if (baseName(words[0]!) !== match.words[0]) return false;
      for (let k = 1; k < match.words.length; k++) if (words[k] !== match.words[k]) return false;
      const rest = words.slice(match.words.length);
      if (match.bare === true && rest.some((w) => !w.startsWith('-'))) return false;
      if (match.flags !== undefined && !rest.some((w) => namesFlag(w, match.flags!))) return false;
      return true;
    }),
  );
}

/** Whether any word of the command is `spec`, alone or as a flag's `=` value. */
export function holdsSpec(commands: readonly SimpleCommand[], spec: string): boolean {
  return commands.some((command) =>
    command.tokens.some((token) => token === spec || token.endsWith(`=${spec}`)),
  );
}

/** Whether any simple command runs `bin` by name. */
export function runsBin(commands: readonly SimpleCommand[], bin: string): boolean {
  return commands.some((command) =>
    readings(command).some((words) => words[0] !== undefined && baseName(words[0]) === bin),
  );
}

/** Whether `text` matches `pattern`, where `*` is any run of characters. */
function wildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * Whether a `/`-separated path matches a glob that knows `*` (within one
 * segment) and `**` (any number of whole segments) and nothing else.
 */
export function globMatches(glob: string, path: string): boolean {
  const ps = glob.split('/');
  const ss = path.split('/');
  const memo = new Map<number, boolean>();
  const at = (pi: number, si: number): boolean => {
    const key = pi * (ss.length + 1) + si;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (pi === ps.length) result = si === ss.length;
    else if (ps[pi] === '**') {
      result = false;
      for (let k = si; k <= ss.length && !result; k++) result = at(pi + 1, k);
    } else result = si < ss.length && wildcard(ps[pi]!, ss[si]!) && at(pi + 1, si + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

/** A file path with `\` as `/`, absolute against `cwd` when it was relative. */
export function normalizedPath(filePath: string, cwd: string): string {
  const path = filePath.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return posix.normalize(path);
  return posix.join(cwd.replaceAll('\\', '/'), path);
}

/** Whether a glob could match the path under some folder: no file read. */
export function mayMatchPath(globs: readonly string[], absolute: string): boolean {
  const segments = absolute.split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const tail = segments.slice(i).join('/');
    if (globs.some((glob) => globMatches(glob, tail))) return true;
  }
  return false;
}

/** The path relative to `root`, or null when it lies outside it. */
export function relativeTo(root: string, absolute: string): string | null {
  const rel = posix.relative(root.replaceAll('\\', '/'), absolute);
  return rel.length === 0 || rel.startsWith('../') || rel === '..' ? null : rel;
}

/**
 * The last {@link OUTPUT_TAIL_CHARS} of every string in what a call returned,
 * CRLF read as LF: its `tool_response` fields, or its `error`.
 */
export function outputTails(...values: unknown[]): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (out.length >= 16) return;
    if (typeof value === 'string') {
      const tail = value.slice(-2 * OUTPUT_TAIL_CHARS).replaceAll('\r\n', '\n');
      out.push(tail.slice(-OUTPUT_TAIL_CHARS));
    } else if (depth < 3 && value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  for (const value of values) walk(value, 0);
  return out;
}

/** Whether any tail holds any of the literal strings, case-sensitively. */
export function matchesOutput(tails: readonly string[], strings: readonly string[]): boolean {
  return strings.some((s) => tails.some((tail) => tail.includes(s)));
}

/** A Codex `tool_input.command`: a script, or an argv, `bash -lc <script>` read as its script. */
export function codexCommand(command: unknown): string | string[] | null {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || !command.every((w) => typeof w === 'string')) return null;
  const argv = command as string[];
  const shell = argv[0] !== undefined && /^(ba|z|da)?sh$/.test(baseName(argv[0]));
  const flag = argv[1];
  if (shell && flag !== undefined && /^-[a-z]*c$/.test(flag) && argv[2] !== undefined) {
    return argv[2];
  }
  return argv;
}

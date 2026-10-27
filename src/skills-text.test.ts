import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The pages a person or an agent reads about the router are pinned here rather
 * than trusted to survive an edit: the permissions doc against the constants it
 * documents, the troubleshooting sections against the reasons the CLI prints,
 * no passphrase on a command line, and no user-facing string that coaches
 * `--base-url`.
 */

/**
 * The permissions doc is the ROUTER's now. Its old guards pinned it to the
 * shelf's nine-rule allowlist and its publish-mode consent, none of which this
 * release registers, so what they were protecting is what moved. These pin the
 * page against the constants it actually documents: one tool rule, one opt-in
 * shell rule, the flag caveat, and no verb the CLI no longer has.
 */
describe('the permissions doc matches the product this release ships', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const PERMISSIONS_DOC = readFileSync(join(root, 'docs', 'agent-permissions.md'), 'utf8');

  /** The `Bash(...)` lines inside fenced blocks: what an operator pastes. */
  function fencedRules(text: string): string[] {
    const out: string[] = [];
    let inFence = false;
    for (const raw of text.split('\n')) {
      if (raw.trimStart().startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      if (inFence && raw.trim().startsWith('Bash(')) out.push(raw.trim());
    }
    return out;
  }

  it('names the plugin install registers, its two permission answers and its server', async () => {
    const { PLUGIN_HOOK_TOOL, PLUGIN_ID, REQUEST_TOOL } = await import('./router/names');
    expect(fencedRules(PERMISSIONS_DOC)).toEqual(['Bash(tenjin pay:*)']);
    expect(PERMISSIONS_DOC).toContain(`${REQUEST_TOOL}   allow`);
    expect(PERMISSIONS_DOC).toContain(`${PLUGIN_HOOK_TOOL}      deny`);
    expect(PERMISSIONS_DOC).toContain(`claude plugin install ${PLUGIN_ID}`);
    expect(PERMISSIONS_DOC).toContain('`router` MCP server');
    // The settings install's names appear only where its migration is described.
    expect(PERMISSIONS_DOC).not.toContain('claude mcp add');
  });

  it('states the caps install sets, from the constants install writes', async () => {
    const { ROUTER_DEFAULTS } = await import('./commands/config');
    const { toMoney } = await import('./lib/money');
    // Compared as NUMBERS ($1 or 1 USD): the page writes 0.10 where `toMoney` renders 0.1, and
    // what must not drift is the amount, not its trailing zero.
    const stated = [...PERMISSIONS_DOC.matchAll(/\$([\d.]+)|([\d.]+) USD/g)].map((m) =>
      Number(m[1] ?? m[2]),
    );
    for (const key of ['maxAutoSpend', 'sessionBudget'] as const) {
      expect(stated, `the page never states ${key}`).toContain(
        Number(toMoney(ROUTER_DEFAULTS[key]).usd),
      );
    }
    expect(ROUTER_DEFAULTS).not.toHaveProperty('confirm');
  });

  it('keeps the flag caveat, which is why a prefix rule is not a host grant', () => {
    expect(PERMISSIONS_DOC).toContain('--base-url');
    expect(PERMISSIONS_DOC).toMatch(/A prefix rule pins the verb, not the flags/i);
  });

  it('names no verb this release does not register', () => {
    for (const gone of [
      'tenjin search',
      'tenjin publish',
      'tenjin edit',
      'tenjin delete',
      'tenjin buy',
      'tenjin read',
      'tenjin outcome',
      'tenjin discover',
      'tenjin daemon',
      'tenjin hooks',
      'mcp__tenjin__',
    ]) {
      expect(PERMISSIONS_DOC, `the permissions doc still names ${gone}`).not.toContain(gone);
    }
  });

  it('gives a reason for every verb it tells you not to allowlist', () => {
    const table = PERMISSIONS_DOC.slice(PERMISSIONS_DOC.indexOf('## Never recommended'));
    for (const verb of [
      'tenjin wallet send',
      'tenjin wallet create',
      'tenjin wallet repair',
      'tenjin config set',
      'tenjin install',
      'tenjin uninstall',
      'tenjin update',
    ]) {
      expect(table).toContain(verb);
    }
    expect(table).toMatch(/Moves USDC out of the wallet/);
  });

  // The passphrase now has a file fallback (decision 5), so the sentence that
  // promised there was none has to be gone, not left beside the new one. And
  // the line that tells a person what to do when the router cannot unlock the
  // wallet names `tenjin wallet repair`, never the variable: steering a person
  // to TENJIN_WALLET_PASSPHRASE is how a passphrase lands on a command line (B1).
  it('describes the passphrase storage this release ships, and repair as the fix', () => {
    expect(PERMISSIONS_DOC).not.toContain('deliberately no plain-file fallback');
    expect(PERMISSIONS_DOC).toContain('mode 0600');
    expect(PERMISSIONS_DOC).toContain('tenjin wallet repair');
    const line = PERMISSIONS_DOC.split('\n').find((l) =>
      l.startsWith('- A routing call that cannot be paid takes the free path'),
    );
    expect(line).toBeDefined();
    expect(line).toContain('`tenjin wallet repair`');
    expect(line).not.toContain('TENJIN_WALLET_PASSPHRASE');
    // The fee wording on that line is out of scope and must survive the edit.
    expect(line).toContain(
      'while the router charges no fee the wallet is not touched and nothing is said',
    );
  });

  it('still resolves every relative markdown link it carries', () => {
    for (const match of PERMISSIONS_DOC.matchAll(/\]\((\.[^)]+\.md)\)/g)) {
      const target = fileURLToPath(
        new URL(`../docs/${match[1]!.replace(/^\.\//, '')}`, import.meta.url),
      );
      expect(existsSync(target), `${match[1]!} does not resolve`).toBe(true);
    }
  });
});

describe('docs/troubleshooting.md: a wallet Tenjin cannot unlock', () => {
  const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
  const TROUBLE = readFileSync(join(DOCS, 'troubleshooting.md'), 'utf8');
  const HEAD = '## Tenjin cannot unlock the wallet';
  /** The section alone, from its heading to the next `## `. */
  const section = ((): string => {
    const start = TROUBLE.indexOf(HEAD);
    const next = TROUBLE.indexOf('\n## ', start + HEAD.length);
    return start === -1 ? '' : TROUBLE.slice(start, next === -1 ? undefined : next);
  })();

  it('exists, as the first section', () => {
    expect(section).not.toBe('');
    expect(TROUBLE.indexOf('\n## ')).toBe(TROUBLE.indexOf(HEAD) - 1);
  });

  // The causes are named by the exact fragments the notices and doctor print,
  // so a person can find the one they were shown by searching for it.
  it('names each cause by the reason fragment the CLI prints', async () => {
    const { WALLET_REASONS } = await import('./router/wallet-reasons');
    for (const key of [
      'passphrase_missing',
      'passphrase_wrong',
      'env_passphrase_wrong',
      'keychain_locked',
    ] as const) {
      expect(section, key).toContain(WALLET_REASONS[key].reason);
    }
  });

  it('names repair and the unset, and keeps a correct variable winning', () => {
    expect(section).toContain('tenjin wallet repair');
    expect(section).toContain('unset TENJIN_WALLET_PASSPHRASE');
    expect(section).toContain('A correct variable still wins');
    expect(section).toMatch(/never paste the passphrase into chat/i);
  });

  // S3: a locked keychain is unlocked, never worked around with a plain file.
  it('fixes a locked keychain only by unlocking it', async () => {
    const { KEYCHAIN_LOCKED_FIX } = await import('./lib/wallet-unlock');
    const bullet = section
      .split('\n')
      .find((l) => l.includes('the keychain holding the wallet passphrase is locked'));
    expect(bullet).toBeDefined();
    expect(bullet).toContain(KEYCHAIN_LOCKED_FIX);
    expect(section).not.toContain('--insecure-storage');
  });

  it('resolves every relative markdown link it carries', () => {
    const links = [...TROUBLE.matchAll(/\]\((\.[^)#]+\.md)(#[^)]*)?\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const match of links) {
      const target = join(DOCS, match[1]!.replace(/^\.\//, ''));
      expect(existsSync(target), `${match[1]!} does not resolve`).toBe(true);
    }
  });
});

/** Session fixes name the action explicitly; wallet/environment repairs still require a new session. */
describe('activation instructions name the required session action', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pages = [
    'README.md',
    ...readdirSync(join(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join('docs', name)),
  ];

  it.each(pages)('%s never says "restart Claude Code"', (rel) => {
    expect(readFileSync(join(root, rel), 'utf8')).not.toMatch(/restart Claude Code/i);
  });

  it('no wallet fix says "restart Claude Code"', async () => {
    const { WALLET_REASONS } = await import('./router/wallet-reasons');
    for (const [key, { fix, agentFix }] of Object.entries(WALLET_REASONS)) {
      expect(fix, key).not.toMatch(/restart Claude Code/i);
      expect(agentFix, key).not.toMatch(/restart Claude Code/i);
    }
  });
});

describe('docs/troubleshooting.md: Tenjin stopped after a Node upgrade', () => {
  const TROUBLE = readFileSync(
    fileURLToPath(new URL('../docs/troubleshooting.md', import.meta.url)),
    'utf8',
  );
  const HEAD = '## Tenjin stopped after a Node upgrade (`Executable not found`, `cache-miss`)';
  const section = ((): string => {
    const start = TROUBLE.indexOf(HEAD);
    const next = TROUBLE.indexOf('\n## ', start + HEAD.length);
    return start === -1 ? '' : TROUBLE.slice(start, next === -1 ? undefined : next);
  })();

  it('is the second section, after the wallet-unlock one', () => {
    const heads = TROUBLE.split('\n').filter((line) => line.startsWith('## '));
    expect(heads.slice(0, 2)).toEqual(['## Tenjin cannot unlock the wallet', HEAD]);
  });

  it('names the symptoms and official Node-free recovery with project scope', () => {
    for (const text of [
      'Executable not found',
      'cache-miss',
      'Install Tenjin from tenjin.sh',
      'https://tenjin.sh/agents',
      'needs no npm or working `tenjin` command',
      'pass `--project` to the installer from that project folder',
      "Follow the installer's activation instruction",
    ]) {
      expect(section, text).toContain(text);
    }
  });

  it('removes Tenjin with `tenjin uninstall` before `npm uninstall -g`', () => {
    const uninstall = section.indexOf('tenjin uninstall');
    expect(uninstall).toBeGreaterThan(-1);
    expect(section.indexOf('npm uninstall -g')).toBeGreaterThan(uninstall);
  });
});

/**
 * B1 and S3 across every page a person or an agent reads: no passphrase on a
 * command line (`TENJIN_WALLET_PASSPHRASE=<value>` is exactly that), and no
 * `--insecure-storage` in the plugin's skills, whose reader is an agent that
 * would offer it as the way past a locked keychain.
 */
describe('no doc or skill puts a passphrase on a command line', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  /** Every file under `dir`, relative to the repo root. */
  function walk(dir: string): string[] {
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  }
  /** The skills the plugins ship, which an agent reads. */
  const skills = walk('hosts').filter((rel) => rel.endsWith('SKILL.md'));
  const docsAndSkills = [...walk('docs'), ...skills];
  /** Pending changesets, wherever the release process leaves them (`.changeset/pre/` on the version branch). */
  const changesets = walk('.changeset').filter(
    (rel) => rel.endsWith('.md') && !rel.endsWith('README.md'),
  );

  it.each([...docsAndSkills, ...changesets])('%s has no inline TENJIN_WALLET_PASSPHRASE', (rel) => {
    expect(readFileSync(join(root, rel), 'utf8')).not.toMatch(/TENJIN_WALLET_PASSPHRASE=\S/);
  });

  it.each(skills)('%s never offers --insecure-storage', (rel) => {
    expect(readFileSync(join(root, rel), 'utf8')).not.toContain('--insecure-storage');
  });
});

/** The comment stripper the `--base-url` sweep runs on, and its own tests. */
function stripComments(source: string): string[] {
  type State = 'code' | 'block' | "'" | '"' | '`';
  let state: State = 'code';
  const out: string[] = [];
  for (const raw of source.split('\n')) {
    let kept = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i] as string;
      const two = raw.slice(i, i + 2);
      if (state === 'block') {
        if (two === '*/') {
          state = 'code';
          i += 2;
        } else i += 1;
        continue;
      }
      if (state !== 'code') {
        kept += ch;
        if (ch === '\\') {
          kept += raw[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === state) state = 'code';
        i += 1;
        continue;
      }
      if (two === '//') break; // a line comment eats the rest of the line
      if (two === '/*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') state = ch;
      kept += ch;
      i += 1;
    }
    // Quoted strings do not span lines; a template literal does. Resetting here
    // keeps one malformed line from swallowing the rest of the file.
    if (state === "'" || state === '"') state = 'code';
    out.push(kept);
  }
  return out;
}

describe('stripComments (the scanner the --base-url sweep depends on)', () => {
  // Pinned directly, because every bug in it is a bug that makes the sweep pass
  // when it should fail. The first three cases are exactly the ones the
  // line-prefix version got wrong.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      'code after a closing block comment on the same line',
      "*/ x('--base-url');",
      " x('--base-url');",
    ],
    ['code after an inline block comment', "/* note */ x('--base-url');", " x('--base-url');"],
    ['a // inside a string literal', "x('https://a --base-url');", "x('https://a --base-url');"],
    ['a trailing line comment', "x('keep'); // --base-url", "x('keep'); "],
    ['a whole-line comment', '// --base-url', ''],
    ['an escaped quote inside a string', "x('a\\' --base-url');", "x('a\\' --base-url');"],
    ['a block comment opened and closed inline twice', '/*a*/ y /*b*/ z', ' y  z'],
  ];
  for (const [name, input, expected] of cases) {
    it(`keeps ${name}`, () => {
      // The first case starts mid-block, so feed the opener on a prior line.
      const src = input.startsWith('*/') ? `/* open\n${input}` : input;
      const lines = stripComments(src);
      expect(lines[lines.length - 1]).toBe(expected);
    });
  }

  it('a block comment spanning lines hides only the comment', () => {
    expect(stripComments("a('--base-url')\n/* hide\n--base-url\n*/ b('--base-url')")).toEqual([
      "a('--base-url')",
      '',
      '',
      " b('--base-url')",
    ]);
  });
});

/**
 * A prefix rule pins the verb, not the flags, so `Bash(tenjin pay:*)` also
 * clears `--base-url` (the flag caveat the permissions doc keeps). The CLI's own
 * error copy is the loudest contrary voice available: its `fix:` lines print to
 * the agent and ride the failure envelope, so a fix line naming the flag would
 * coach exactly that move, and no user-facing string may name it.
 *
 * The pin is a source scan rather than a per-message assertion so a NEW string
 * fails it too. Comments are stripped: the flag is a real part of the CLI
 * surface, and prose explaining why it is dangerous must stay writable.
 */
describe('no user-facing CLI string coaches --base-url', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url));

  // `cli.ts` DEFINES the flag (commander needs the literal); `lib/permissions.ts`
  // is the caveat that discloses it. Both name it deliberately.
  const ALLOWED = new Set(['cli.ts', 'lib/permissions.ts']);

  function codeLines(file: string): string[] {
    return stripComments(readFileSync(join(SRC, file), 'utf8'));
  }

  function sourceFiles(): string[] {
    return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((p) => p.split(sep).join('/'))
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts'))
      .filter((p) => !ALLOWED.has(p));
  }

  it('scans a real set of source files (guard against an empty sweep)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('router/doctor.ts');
    expect(files).toContain('commands/pay.ts');
  });

  it('names the flag in no executable line outside the flag definition and the caveat', () => {
    const offenders = sourceFiles().flatMap((file) =>
      codeLines(file)
        .map((line, i) => ({ file, line: line.trim(), n: i + 1 }))
        .filter((l) => l.line.includes('--base-url')),
    );
    expect(offenders).toEqual([]);
  });

  it('the comment-stripper still sees code (it is not silently blanking files)', () => {
    // Without this, a broken stripper would make the scan above vacuously green.
    const pay = codeLines('commands/pay.ts').join('\n');
    expect(pay).toContain('requestHeaderProblem(');
    expect(pay).not.toContain('Deliberately NOT `buy`');
  });

  it('leaves real declarations standing in EVERY scanned file, not just one', () => {
    // Per-file, so an unterminated block comment cannot swallow one file's worth
    // of strings while the single-file check above stays green.
    const blank = sourceFiles().filter(
      (file) => !/\b(import|export|function|const)\b/.test(codeLines(file).join('\n')),
    );
    expect(blank).toEqual([]);
  });
});

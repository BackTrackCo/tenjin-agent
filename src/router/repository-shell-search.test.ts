import { describe, expect, it } from 'vitest';
import { parseRepositoryShellSearch } from './repository-shell-search';

const cwd = '/workspace/repo';
const parse = (command: string) => parseRepositoryShellSearch({ command }, cwd);

describe('bounded repository Bash search recognition', () => {
  it('preserves a real regex and its search/output arguments', () => {
    const found = parse('rg -n -i -C 3 --glob "*.ts" "charge|payment" src | head -40');
    expect(found).toMatchObject({
      mode: 'replace',
      candidates: [
        {
          cwd,
          origin: 'Bash',
          input: {
            pattern: 'charge|payment',
            path: 'src',
            glob: '*.ts',
            '-n': true,
            '-i': true,
            '-C': 3,
            head_limit: 40,
          },
          shell: {
            executable: 'rg',
            argv: ['-n', '-i', '-C', '3', '--glob', '*.ts', 'charge|payment', '<repository-path>'],
            filters: [{ executable: 'head', argv: ['-40'], lines: 40 }],
            stderr: 'inherit',
          },
        },
      ],
    });
  });
  it('supports literal cd, grouped grep flags, fixed strings and stderr discard', () => {
    expect(
      parse('cd ../other && grep -rnFi --include="*.ts" "charge(user)" . 2>/dev/null | head -n 20'),
    ).toMatchObject({
      mode: 'augment',
      candidates: [
        {
          cwd: '/workspace/other',
          input: { pattern: 'charge(user)', path: '.', glob: '*.ts', '-n': true, '-i': true },
          shell: {
            executable: 'grep',
            stderr: 'discard',
            argv: ['-rnFi', '--include=*.ts', 'charge(user)', '<repository-path>'],
          },
        },
      ],
    });
  });
  it('keeps fixed-vs-regex semantics and exclusion arguments in classifier metadata', () => {
    const found = parse(
      'grep -rF -e "charge(user)" --exclude-dir=node_modules --exclude="*.test.ts" src',
    );
    expect(found?.candidates[0]?.shell.argv).toEqual([
      '-rF',
      '-e',
      'charge(user)',
      '--exclude-dir=node_modules',
      '--exclude=*.test.ts',
      '<repository-path>',
    ]);
  });
  it('preserves quoted shell punctuation as literal search text', () => {
    expect(parse("rg 'a;b && c|d # literal $HOME' src")?.candidates[0]?.input.pattern).toBe(
      'a;b && c|d # literal $HOME',
    );
  });
  it('extracts a normal compound codebase search without replacing its other reads', () => {
    const found = parse(
      'cd /workspace/repo && git ls-files | grep -v node_modules | head -300; grep -rniE "quiet|suppress|cooldown" --include=* -l . --exclude-dir=node_modules --exclude-dir=.git | head -50',
    );
    expect(found?.mode).toBe('augment');
    expect(found?.candidates).toHaveLength(1);
    expect(found?.candidates[0]?.input).toMatchObject({
      pattern: 'quiet|suppress|cooldown',
      path: '.',
      output_mode: 'files_with_matches',
      head_limit: 50,
    });
    expect(JSON.stringify(found)).not.toContain('ls-files');
  });
  it('recognizes the observed Git-stat and binary-skipping recursive grep discovery call', () => {
    const found = parse(
      'git show --stat HEAD | head -30 && grep -rIl -iE "substantive|capture" --include=*.ts --include=*.js --include=*.mjs --include=*.md --include=*.json . 2>/dev/null | grep -v node_modules | head -40',
    );
    expect(found?.mode).toBe('augment');
    expect(found?.candidates).toHaveLength(1);
    expect(found?.candidates[0]).toMatchObject({
      input: {
        pattern: 'substantive|capture',
        path: '.',
        output_mode: 'files_with_matches',
        '-i': true,
        head_limit: 40,
      },
      shell: {
        executable: 'grep',
        argv: [
          '-rIl',
          '-iE',
          'substantive|capture',
          '--include=*.ts',
          '--include=*.js',
          '--include=*.mjs',
          '--include=*.md',
          '--include=*.json',
          '<repository-path>',
        ],
        filters: [
          { executable: 'grep', argv: ['-v', 'node_modules'] },
          { executable: 'head', argv: ['-40'], lines: 40 },
        ],
        stderr: 'discard',
      },
    });
    expect(JSON.stringify(found)).not.toContain('--stat');
  });
  it('admits only literal HEAD path reads as Git-show companions', () => {
    for (const command of [
      'git show HEAD -- src/file.ts; rg payment src',
      'git show HEAD -- src/file.ts "src/with space.ts" | head -30; rg payment src',
    ])
      expect(parse(command)?.mode).toBe('augment');
    expect(parse('git show HEAD -- src/file.ts | grep payment')).toBeNull();
    expect(parse('grep -rI payment src')?.candidates[0]?.shell.argv).toContain('-rI');
  });
  it('recognizes the recorded Opus discovery call beside a file-list count', () => {
    const found = parse(
      'git ls-files | head -100 && git ls-files | wc -l && grep -rliE "idempot|receipt|already.?paid|entitle|recover" --include=*.ts --include=*.js --include=*.py --include=*.md . 2>/dev/null | grep -v node_modules | head -60',
    );
    expect(found?.mode).toBe('augment');
    expect(found?.candidates).toHaveLength(1);
    expect(found?.candidates[0]).toMatchObject({
      input: {
        pattern: 'idempot|receipt|already.?paid|entitle|recover',
        path: '.',
        output_mode: 'files_with_matches',
        '-i': true,
        head_limit: 60,
      },
      shell: {
        executable: 'grep',
        argv: [
          '-rliE',
          'idempot|receipt|already.?paid|entitle|recover',
          '--include=*.ts',
          '--include=*.js',
          '--include=*.py',
          '--include=*.md',
          '<repository-path>',
        ],
        filters: [
          { executable: 'grep', argv: ['-v', 'node_modules'] },
          { executable: 'head', argv: ['-60'], lines: 60 },
        ],
        stderr: 'discard',
      },
    });
    expect(JSON.stringify(found)).not.toContain('wc');
    expect(JSON.stringify(found)).not.toContain('ls-files');
  });
  it('keeps count-only and content-search count pipelines native', () => {
    for (const command of [
      'git ls-files | wc -l',
      'rg payment src | wc -l',
      'grep -rn payment src | wc -l',
      'rg payment src | wc -l; rg retry src',
      'rg payment src/a.ts src/b.ts | wc -l; rg retry src',
    ])
      expect(parse(command)).toBeNull();
  });
  it.each([
    'wc',
    'wc -c',
    'wc -lm',
    'wc --lines',
    'wc -l src/file.ts',
    'wc -l -',
    'wc -l --files0-from=names',
    'wc -l *',
    'wc -l "$INPUT"',
    'wc -l $(cat names)',
    'wc -l > counts.txt',
    'wc -l 2>&1',
    'wc -l | tee counts.txt',
  ])('rejects unsupported companion counter variants: %s', (counter) => {
    expect(parse(`git ls-files | ${counter}; rg payment src`)).toBeNull();
  });
  it('allows bounded ls/search and search/sed read-only sequences as augmentation', () => {
    for (const command of [
      'ls src 2>/dev/null | head -30; rg "payment|retry" src | head -30',
      'rg "retry" src; sed -n 10,30p src/pay.ts',
      'wc -l src/pay.ts; grep -rniE "retry|charge" src | head -20',
    ])
      expect(parse(command)?.mode).toBe('augment');
  });
  it('retains grep exclusion and cut filters and only augments them', () => {
    const found = parse('rg payment src | grep -v test | cut -c1-200 | head -15');
    expect(found?.mode).toBe('augment');
    expect(found?.candidates[0]?.shell.filters).toEqual([
      { executable: 'grep', argv: ['-v', 'test'] },
      { executable: 'cut', argv: ['-c1-200'] },
      { executable: 'head', argv: ['-15'], lines: 15 },
    ]);
  });
  it('never mistakes grep filtering a file list or git output for repository content search', () => {
    expect(parse('git ls-files | grep -i router | head')).toBeNull();
    expect(parse('git show HEAD:src/pay.ts | grep -n retry | head')).toBeNull();
    expect(parse('rg --files | grep router | head')).toBeNull();
  });
  it('retains multiple bounded candidate searches in original order for admission', () => {
    const found = parse('rg retry src; cd lib && grep -rE payment . | head');
    expect(found?.mode).toBe('augment');
    expect(found?.candidates.map((c) => [c.cwd, c.input.pattern, c.input.path])).toEqual([
      [cwd, 'retry', 'src'],
      ['/workspace/repo/lib', 'payment', '.'],
    ]);
  });
  it('never suppresses an explicit directory change, even beside one search', () => {
    expect(parse('cd src && rg payment .')).toMatchObject({
      mode: 'augment',
      candidates: [{ cwd: '/workspace/repo/src', input: { pattern: 'payment', path: '.' } }],
    });
    expect(parse('cd . && rg payment src')?.mode).toBe('augment');
  });
  it('delegates a literal rg file target unchanged to canonical file admission', () => {
    expect(parse('rg payment src/pay.ts')?.candidates[0]?.input.path).toBe('src/pay.ts');
    expect(parse('grep -n payment src/pay.ts')).toBeNull();
  });
  it('does not place raw absolute shell paths in provenance', () => {
    const found = parse('cd /workspace/repo && rg payment /workspace/repo/src');
    expect(found?.candidates[0]?.shell.argv).toEqual(['payment', '<repository-path>']);
    expect(found?.candidates[0]?.input.path).toBe('/workspace/repo/src');
  });
  it.each([
    'rg --files',
    'grep -cq payment src/pay.ts',
    'grep -rv payment src',
    'rg --count payment src',
    'rg -q payment src',
    'rg -v payment src',
    'rg --pre cat payment src',
    'rg -f patterns src',
    'rg payment src > result.txt',
    'rg payment src 2 > /dev/null',
    'rg payment src 2>&1',
    'rg payment src | tee result.txt',
    'rg payment src && touch file',
    'ls; rg payment src; git fetch',
    'git -c alias.x=evil x; rg payment src',
    'git -c diff.x.textconv=evil show HEAD -- src/file; rg payment src',
    'git show --ext-diff HEAD -- src/file; rg payment src',
    'git show --textconv HEAD -- src/file; rg payment src',
    'git show --output=result --stat HEAD; rg payment src',
    'git show --stat main; rg payment src',
    'git show HEAD -- --output=result; rg payment src',
    'git show HEAD -- ../file; rg payment src',
    'git show HEAD -- /other/file; rg payment src',
    'git show HEAD -- src/*; rg payment src',
    'git show HEAD -- "src/*.ts"; rg payment src',
    'git show HEAD -- ":(glob)src/**"; rg payment src',
    'git show HEAD -- src/file --ext-diff; rg payment src',
    'rg payment src; sed -i s/a/b/ src/a.ts',
    'rg payment src | xargs cat',
    'R=src; rg payment "$R"',
    'rg payment "$HOME"',
    'rg payment ${ROOT:-src}',
    'rg "$(cat secret)" src',
    'rg `cat secret` src',
    "rg $'payment' src",
    'rg payment <(cat source)',
    'for f in src/*; do rg payment "$f"; done',
    'rg payment src || true',
    'rg payment src &',
    'rg payment src # comment',
    'rg "unterminated src',
    "rg 'unterminated src",
    'rg payment src\\',
    'rg payment src\nrg charge src',
    'rg payment src/{a,b}',
    'cd src; rg payment .',
    'rg payment src | head -0',
    'rg payment src | head -n -2',
    'rg payment src | grep -q test',
    'rg --glob /other/*.ts payment src',
    'rg -r replacement payment src',
    'rg -E utf8 payment src',
    'rg -h payment src',
    'rg -I payment src',
    'grep --multiline -r payment src',
    'cd - && rg payment src',
    'sed -n 1,3p *; rg payment src',
    'git log *; rg payment src',
    'rg payment *; rg charge src',
  ])('leaves unsupported or unsafe shell syntax native: %s', (command) => {
    expect(parse(command)).toBeNull();
  });
  it('bounds commands, candidates, tokens, and background execution', () => {
    expect(parse(`rg '${'a'.repeat(8100)}' src`)).toBeNull();
    expect(parse(Array.from({ length: 5 }, () => 'rg payment src').join('; '))).toBeNull();
    expect(
      parseRepositoryShellSearch({ command: 'rg payment src', run_in_background: true }, cwd),
    ).toBeNull();
    expect(
      parseRepositoryShellSearch({ command: 'rg payment src', cwd: '/other' }, cwd),
    ).toBeNull();
  });
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Safety facts and the local reading path must survive documentation edits. */
describe('the permissions doc matches the product this release ships', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const PERMISSIONS_DOC = ['agent-permissions.md', 'router-reference.md']
    .map((name) => readFileSync(join(root, 'docs', name), 'utf8'))
    .join('\n');

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

/** GFM heading anchors ignore punctuation/code marks and suffix duplicate headings. */
function headingIds(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = heading
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

function localLinkProblems(
  file: string,
  markdown: string,
  read: (path: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const text = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const links = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]!),
    ...[...text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].flatMap((match) =>
      match[1]!.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]!),
    ),
  ];
  for (const link of links) {
    if (/^(?:https?:|mailto:)/.test(link)) continue;
    const [path, fragment] = link.split('#', 2);
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    const body = read(target);
    if (body === undefined) problems.push(`${link}: missing file`);
    else if (
      fragment &&
      target.endsWith('.md') &&
      !headingIds(body).has(decodeURIComponent(fragment))
    )
      problems.push(`${link}: missing heading`);
  }
  return problems;
}

describe('the first-use documentation reading path', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [
    'README.md',
    'RELEASING.md',
    ...readdirSync(join(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join('docs', name)),
  ];

  it.each(files)('%s has no broken local link or heading', (name) => {
    const file = join(root, name);
    const read = (target: string): string | undefined =>
      existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    expect(localLinkProblems(file, readFileSync(file, 'utf8'), read)).toEqual([]);
  });

  it('catches a moved reference and a renamed section, including links to the current page', () => {
    const guide = '/guide.md';
    const text =
      '# Setup\n[details](./gone.md) [limits](./reference.md#old-limits) [here](#missing)';
    const files = new Map([
      [guide, text],
      ['/reference.md', '# Limits'],
    ]);
    expect(localLinkProblems(guide, text, (target) => files.get(target))).toEqual([
      './gone.md: missing file',
      './reference.md#old-limits: missing heading',
      '#missing: missing heading',
    ]);
  });

  it('checks HTML navigation and embedded assets used by the README', () => {
    const file = '/README.md';
    const text = '<a href="#missing">Setup</a><img src="./demo.gif"><source srcset="./dark.svg">';
    expect(localLinkProblems(file, text, (target) => (target === file ? text : undefined))).toEqual(
      ['#missing: missing heading', './demo.gif: missing file', './dark.svg: missing file'],
    );
  });

  it('accepts code-formatted headings and repeated headings without treating examples as links', () => {
    const file = '/reference.md';
    const text =
      '# `request` tool\n## Details\n## Details\n[request](#request-tool) [second](#details-1)\n```text\n[example](./not-a-real-file.md)\n```';
    expect(localLinkProblems(file, text, () => text)).toEqual([]);
  });
});

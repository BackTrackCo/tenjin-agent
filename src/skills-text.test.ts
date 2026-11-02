import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The pages a person or an agent reads about the router are pinned here rather
 * than trusted to survive an edit: the permissions doc against the constants it
 * documents, the troubleshooting section against the reasons the CLI prints,
 * and no passphrase on a command line.
 */

/**
 * The permissions doc is the ROUTER's now. Its old guards pinned it to the
 * shelf's nine-rule allowlist and its publish-mode consent, none of which this
 * release registers, so what they were protecting is what moved. These pin the
 * page against the constants it actually documents: one tool rule, one opt-in
 * shell rule, and the caps install sets.
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

  it('resolves every relative markdown link it carries', () => {
    const links = [...TROUBLE.matchAll(/\]\((\.[^)#]+\.md)(#[^)]*)?\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const match of links) {
      const target = join(DOCS, match[1]!.replace(/^\.\//, ''));
      expect(existsSync(target), `${match[1]!} does not resolve`).toBe(true);
    }
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

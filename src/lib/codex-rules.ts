import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHome } from '../adapters/codex';

/**
 * Codex's persistent command grant: `$CODEX_HOME/rules/tenjin.rules`.
 *
 * This is the same layer Codex's own approval flow writes when a person
 * chooses "don't ask again for commands that start with ...", and the same one
 * OpenAI's docs name for it ("Codex writes to the user layer at
 * `~/.codex/rules/default.rules` so future runs can skip the prompt"). Every
 * `*.rules` file in that directory is loaded, which is what makes a file of
 * our own possible.
 *
 * A FILE OF OUR OWN, NEVER `default.rules`. That one is the operator's and
 * Codex appends to it; editing it would mean rewriting a Starlark file someone
 * else owns to find our lines again. `tenjin.rules` is ours whole, the same
 * ownership boundary `lib/harness-hooks.ts` draws inside hooks.json.
 *
 * A TRANSLATOR, NOT A SECOND POLICY. Callers hand it the rule list
 * `rulesForPublishMode` already settled, so it cannot widen a grant, and it
 * does not import the tiers so the dependency runs one way. A rule it cannot
 * parse is DROPPED rather than guessed at, which makes `Bash(tenjin:*)` — the
 * blanket form — unparseable here by construction (tenjin-agent#342).
 */

/** Our file in Codex's user rules layer. */
export function codexRulesPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(home, env), 'rules', 'tenjin.rules');
}

/**
 * `Bash(tenjin search:*)` to `["tenjin", "search"]`, or null for anything that
 * is not exactly that shape.
 *
 * STRICT ON PURPOSE. The pattern requires at least one verb word after
 * `tenjin`, so `Bash(tenjin:*)` — the blanket rule
 * {@link FORBIDDEN_VERB_FRAGMENTS} exists to keep out — cannot be translated
 * at all rather than being translated into `["tenjin"]`, which in Codex's
 * grammar would clear every subcommand there is.
 */
export function prefixTokens(rule: string): string[] | null {
  const m = /^Bash\(tenjin ((?:[a-z][a-z-]* )*[a-z][a-z-]*):\*\)$/.exec(rule);
  const verbs = m?.[1];
  if (verbs === undefined) return null;
  return ['tenjin', ...verbs.split(' ')];
}

/** One `prefix_rule` line. Tokens are JSON-quoted, as Codex writes them. */
export function prefixRuleLine(tokens: readonly string[]): string {
  const pattern = tokens.map((t) => JSON.stringify(t)).join(', ');
  return `prefix_rule(pattern=[${pattern}], decision="allow")`;
}

/** The token lists `rules` grants, in the order they are written. */
export function grantedPrefixes(rules: readonly string[]): string[][] {
  return rules.map(prefixTokens).filter((t): t is string[] => t !== null);
}

/** The file body for `rules`, byte-identical run to run so a re-install is a no-op. */
export function rulesFileBody(rules: readonly string[]): string {
  const lines = [
    '# Written by `tenjin install`. Change it with `tenjin config set publish.mode`',
    '# or `tenjin uninstall`, not by hand: the next install rewrites it whole.',
    '# Your own rules live in default.rules and are never touched by Tenjin.',
    '',
    ...grantedPrefixes(rules).map(prefixRuleLine),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Ask Codex whether it agrees a prefix is granted, using its own
 * `execpolicy check` against the file we wrote.
 *
 * THE ONLY PROOF WORTH REPORTING. Writing a file is not a grant, and a
 * Starlark file that fails to parse is silent until a session starts — `codex
 * doctor` will not tell you, and nor would we (tenjin-agent#342).
 *
 * ASK ABOUT THE INNER COMMAND, not the shell line: the session path decomposes
 * `/bin/zsh -lc '<script>'` before matching, and `execpolicy check` is a
 * raw-argv checker that does not, so the wrapped form answers nothing.
 *
 * Null means the question could not be put, and is never read as a No.
 */
export async function verifyPrefixAllowed(
  rulesPath: string,
  tokens: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = VERIFY_MS,
): Promise<boolean | null> {
  return await new Promise<boolean | null>((resolve) => {
    execFile(
      'codex',
      ['execpolicy', 'check', '--rules', rulesPath, ...tokens],
      { env, timeout: timeoutMs, windowsHide: true },
      (_err, stdout) => {
        // A parse error is reported on stderr WITH EXIT 0, so the exit code
        // proves nothing and the JSON on stdout is the whole answer.
        // No stdout at all: the binary is missing, too old for the
        // subcommand, or it timed out. All three are "could not ask".
        if (typeof stdout !== 'string' || stdout.length === 0) {
          resolve(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const decision =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as { decision?: unknown }).decision
              : undefined;
          resolve(decision === 'allow');
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** A self-test with a person waiting on it; past this the answer is "unknown". */
const VERIFY_MS = 5_000;

/**
 * Remove the grant entirely. `uninstall`'s half, and the only path that deletes
 * rather than narrows: an operator who removed Tenjin should keep no standing
 * permission for it, not even the free tier.
 */
export async function removeCodexGrant(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; removed: boolean }> {
  const path = codexRulesPath(home, env);
  // Only a regular file of ours. A directory or a device parked at that name
  // is not something an uninstall may delete on a pattern.
  const found = await stat(path).catch(() => null);
  if (found === null || !found.isFile()) return { path, removed: false };
  await rm(path, { force: true });
  return { path, removed: true };
}

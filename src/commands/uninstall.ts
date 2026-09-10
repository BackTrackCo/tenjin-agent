import { homedir } from 'node:os';
import {
  keptItems,
  REMOVED_FROM_DATA_DIR,
  removeFromHooksFile,
  removeFromSettings,
  removeHookScripts,
  removeSkills,
  type SettingsOutcome,
  type UninstallReport,
} from '../lib/uninstall';
import { stopDaemon } from '../daemon/control';
import { sanitizeForTerminal } from '../lib/output';
import { loadRawConfig } from '../lib/config';
import { ADAPTERS } from '../adapters/registry';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin uninstall`: undo exactly what `tenjin install` wrote, and nothing else.
 *
 * The shape of this command is the promise it makes. It removes the skills, the
 * loop daemon and its files, and our hook entries and permission rules in the
 * harness's settings.json. It does NOT remove the wallet, the config (the team
 * shelf's shared `shelfBypassSecret` included, which the receipt names on its
 * own line, with the command that clears it, on the machines that actually hold
 * one), the library, or `loop.db`: `install` did not create those, a wallet
 * holds funds, and the loop database is the machine's only record.
 * `~/.tenjin/hooks` is the one thing under `~/.tenjin` it does remove, because
 * `install` wrote it. The receipt names both halves on every run, so the
 * operator learns the boundary from the command rather than from the docs.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every step is "remove it if it is ours and there",
 * so a half-installed machine, an already-uninstalled one, and a machine that
 * never ran install all succeed and report what was (not) found. There is no
 * confirmation prompt and no --force: nothing here is unrecoverable, since a
 * `tenjin install` puts all of it back.
 */

export interface UninstallDeps {
  /** Home whose harness directories are cleaned; tests inject a temp dir. */
  home?: string;
  /** Seam for stopping the daemon; tests inject one that signals nothing. */
  stop?: typeof stopDaemon;
  /** Environment (CODEX_HOME); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function runUninstall(
  ctx: CommandContext,
  deps: UninstallDeps = {},
): Promise<CommandResult> {
  const home = deps.home ?? homedir();

  // Settings first: it is the only step with a concurrency guard, and the only
  // one that can refuse. Doing it before the daemon is stopped means a refusal
  // leaves registered entries pointing at a daemon that is still answering them,
  // rather than at a port with nothing behind it.
  const settings = await removeFromSettings(home, ctx.dataDir);
  // Every other harness's hooks file, by the same rules and before the daemon
  // for the same reason.
  const hookFiles: SettingsOutcome[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.id === 'claude') continue;
    hookFiles.push(await removeFromHooksFile(adapter, home, ctx.dataDir, deps.env));
  }
  // Then the daemon, before its bundle is deleted: a running daemon whose entries
  // are gone still holds the port and still serves any session that has not
  // re-read settings.json yet.
  const daemon = await (deps.stop ?? stopDaemon)(ctx.dataDir);
  const scripts = await removeHookScripts(ctx.dataDir);
  const skills = await removeSkills(home);

  const report: UninstallReport = {
    settings,
    hookFiles,
    daemon: daemon.state,
    skills,
    scripts: scripts.scripts,
    ...(scripts.removedDir !== undefined ? { hooksDir: scripts.removedDir } : {}),
    // Read rather than assumed: the shelf-key item is an imperative to clear a
    // shared credential, and on the machines that do not have one it is a false
    // line in a receipt whose only job is to be checked.
    kept: keptItems(await hasShelfSecret(ctx.dataDir)),
  };

  return { data: report, humanLines: humanLines(report) };
}

/** Does this machine's config actually hold a team door key? `''` is the default. */
async function hasShelfSecret(dataDir: string): Promise<boolean> {
  try {
    const raw = await loadRawConfig(dataDir);
    return typeof raw.shelfBypassSecret === 'string' && raw.shelfBypassSecret !== '';
  } catch {
    // An unreadable config is not a reason to fail an uninstall, and the quiet
    // side is the safe one here: the key, if there is one, stays as it was.
    return false;
  }
}

function humanLines(report: UninstallReport): string[] {
  const { settings } = report;
  const removed: string[] = [];
  for (const dir of report.skills) removed.push(`skill ${sanitizeForTerminal(dir)}`);
  if (report.daemon === 'stopped' || report.daemon === 'killed') removed.push('the loop daemon');
  for (const script of report.scripts) removed.push(`hook file ${sanitizeForTerminal(script)}`);
  if (report.hooksDir !== undefined) {
    removed.push(`empty hooks directory ${sanitizeForTerminal(report.hooksDir)}`);
  }
  for (const file of [settings, ...report.hookFiles]) {
    for (const event of file.hooks) {
      removed.push(`${event} hook entry in ${sanitizeForTerminal(file.path)}`);
    }
  }
  if (settings.rules.length > 0) {
    removed.push(
      `${settings.rules.length} tenjin permission rule(s) in ${sanitizeForTerminal(settings.path)}`,
    );
  }

  const lines =
    removed.length === 0
      ? ['Nothing to remove; tenjin was not installed here.']
      : ['Removed:', ...removed.map((r) => `  - ${r}`)];

  // Named on EVERY run, including the nothing-to-remove one: the boundary is the
  // point of the command, and an operator reaching for it is usually worried
  // about exactly these things. The exception is named right under them, because
  // an unqualified "nothing under ~/.tenjin is touched" is contradicted by the
  // hook scripts this same receipt just listed as removed.
  lines.push('Kept:');
  for (const item of report.kept) lines.push(`  - ${item}`);
  lines.push('Removed from ~/.tenjin:');
  for (const item of REMOVED_FROM_DATA_DIR) lines.push(`  - ${item}`);

  for (const file of [settings, ...report.hookFiles]) {
    if (file.warning !== undefined) lines.push(`! ${sanitizeForTerminal(file.warning)}`);
  }
  lines.push('Reinstall anytime: tenjin install');
  return lines;
}

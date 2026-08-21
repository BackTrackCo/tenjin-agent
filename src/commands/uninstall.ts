import { homedir } from 'node:os';
import {
  KEPT_ITEMS,
  REMOVED_FROM_DATA_DIR,
  removeFromSettings,
  removeHookScripts,
  removeMarkerLines,
  removeSkills,
  type UninstallReport,
} from '../lib/uninstall';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin uninstall`: undo exactly what `tenjin install` wrote, and nothing else.
 *
 * The shape of this command is the promise it makes. It removes the skills, the
 * hook scripts, our hook entries and permission rules in the harness's
 * settings.json, and the legacy pointer line older versions wrote into
 * CLAUDE.md/AGENTS.md. It does NOT remove the wallet, the config, the library,
 * the search ledger, or parked candidates: `install` did not create those, and a
 * wallet holds funds while a candidate is unpublished work. The hook scripts are
 * the one thing under `~/.tenjin` it does remove, because `install` generated
 * them. The receipt names both halves on every run, so the operator learns the
 * boundary from the command rather than from the docs.
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
  /** Environment the Hermes home is resolved from; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function runUninstall(
  ctx: CommandContext,
  deps: UninstallDeps = {},
): Promise<CommandResult> {
  const home = deps.home ?? homedir();

  // Settings first: it is the only step with a concurrency guard, and the only
  // one that can refuse. Doing it before the scripts are deleted means a refusal
  // leaves a registered hook still pointing at a script that exists, rather than
  // at one that does not.
  const settings = await removeFromSettings(home);
  const scripts = await removeHookScripts(ctx.dataDir);
  const skills = await removeSkills(home, deps.env);
  const markers = await removeMarkerLines(home);

  const report: UninstallReport = {
    settings,
    skills,
    scripts: scripts.scripts,
    ...(scripts.removedDir !== undefined ? { hooksDir: scripts.removedDir } : {}),
    markers,
    kept: [...KEPT_ITEMS],
  };

  return { data: report, humanLines: humanLines(report) };
}

function humanLines(report: UninstallReport): string[] {
  const { settings } = report;
  const removed: string[] = [];
  for (const dir of report.skills) removed.push(`skill ${sanitizeForTerminal(dir)}`);
  for (const script of report.scripts) removed.push(`hook script ${sanitizeForTerminal(script)}`);
  if (report.hooksDir !== undefined) {
    removed.push(`empty hooks directory ${sanitizeForTerminal(report.hooksDir)}`);
  }
  for (const event of settings.hooks) {
    removed.push(`${event} hook entry in ${sanitizeForTerminal(settings.path)}`);
  }
  if (settings.rules.length > 0) {
    removed.push(
      `${settings.rules.length} tenjin permission rule(s) in ${sanitizeForTerminal(settings.path)}`,
    );
  }
  for (const path of report.markers) {
    removed.push(`legacy pointer line in ${sanitizeForTerminal(path)}`);
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
  lines.push(`Removed from ~/.tenjin: ${REMOVED_FROM_DATA_DIR}`);

  if (settings.warning !== undefined) {
    lines.push(`! ${sanitizeForTerminal(settings.warning)}`);
  }
  lines.push('Reinstall anytime: tenjin install');
  return lines;
}

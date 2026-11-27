import { realpathSync } from 'node:fs';
import type { ResolvedSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { findClaudeBinary, type ClaudeBinary } from './claude-cli';
import type { WindowsWorkerProcess } from './claude-worker-process';

export type WindowsWorkerLaunch = WindowsWorkerProcess & {
  fingerprint: string;
  claudePath: string;
  routerOrigin: string;
};

export function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Check the selected binary before the controller executes its version command. */
export function findWindowsWorkerClaude(
  env: NodeJS.ProcessEnv,
  configuredPath: string,
): ClaudeBinary | null {
  const selected = findClaudeBinary(env);
  try {
    return selected && sameWindowsPath(realpathSync(selected.path), configuredPath)
      ? { ...selected, path: configuredPath }
      : null;
  } catch {
    return null;
  }
}

/**
 * NO SAVED GRANT LAUNCHES A WINDOWS WORKER. The command that wrote the grant is gone, and a
 * `router.windowsWorker` an earlier build saved is never read, so no worker starts there.
 */
export async function windowsWorkerLaunch(
  _dataDir: string,
  _cwd: string,
): Promise<WindowsWorkerLaunch | null> {
  return null;
}

export function nativeWindowsShellPolicy(resolved: ResolvedSettings): boolean {
  return (
    resolved.effective.sandbox?.enabled !== true &&
    !resolved.machinePolicy?.didNotLoad &&
    !resolved.sources?.some(
      ({ source, settings }) =>
        source === 'managed' &&
        (settings.sandbox?.enabled === true || settings.sandbox?.failIfUnavailable === true),
    )
  );
}

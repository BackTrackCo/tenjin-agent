import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedSettings } from '@anthropic-ai/claude-agent-sdk/core';
import {
  configPath,
  passphraseBlobPath,
  passphraseRecordPath,
  spendLedgerPath,
  walletPath,
} from '../lib/paths';
import { claudeWorkerConfigDir } from './claude-worker-session';
import { findClaudeBinary, type ClaudeBinary } from './claude-cli';
import type { WindowsWorkerProcess } from './claude-worker-process';
import { loadWindowsWorkerConfig } from './windows-worker-config';

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

/** The explicit shared profile must be the one producing this session's policy and history. */
export async function windowsWorkerLaunch(
  dataDir: string,
  cwd: string,
): Promise<WindowsWorkerLaunch | null> {
  if (process.platform !== 'win32') return null;
  try {
    const config = await loadWindowsWorkerConfig(dataDir);
    if (!config || !sameWindowsPath(await realpath(claudeWorkerConfigDir(cwd)), config.configDir))
      return null;
    const privateRoot = await realpath(dataDir);
    const byWallet = (await readdir(privateRoot))
      .filter((file) =>
        /^(?:passphrase\.[\da-fx]+\.(?:dpapi|plain)|wallet\.[\da-fx]+\.json\.bak)$/i.test(file),
      )
      .map((file) => join(privateRoot, file));
    const guard = await stat(config.launcherPath);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([config, guard.size, guard.mtimeMs]))
      .digest('hex');
    return {
      launcherPath: config.launcherPath,
      workerSid: config.workerSid,
      claudePath: config.claudePath,
      configDir: config.configDir,
      routerOrigin: config.routerOrigin,
      fingerprint,
      protectedPaths: [
        privateRoot,
        configPath(privateRoot),
        walletPath(privateRoot),
        spendLedgerPath(privateRoot),
        passphraseBlobPath(privateRoot),
        passphraseRecordPath(privateRoot),
        ...byWallet,
      ],
    };
  } catch {
    return null;
  }
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

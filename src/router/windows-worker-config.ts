import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { z } from 'zod';
import { loadRawConfig } from '../lib/config';
import {
  defaultDataDir,
  passphraseRecordPath,
  realOr,
  spendLedgerPath,
  walletPath,
} from '../lib/paths';
import { modelConsentSchema } from './model-settings';

const localPath = z
  .string()
  .regex(/^[A-Za-z]:[\\/][^:"<>|?*]+$/)
  .refine((path) => Array.from(path).every((character) => character.charCodeAt(0) >= 32));
const executablePath = localPath.refine((path) => win32.extname(path).toLowerCase() === '.exe');
const configSchema = z.strictObject({
  version: z.literal(1),
  workerSid: z.string().regex(/^S-1-5-21-(?:\d{1,10}-){3}\d{1,10}$/),
  launcherPath: executablePath,
  claudePath: executablePath,
  configDir: localPath,
  routerOrigin: z.url().refine((url) => URL.canParse(url) && new URL(url).origin === url),
  shellAccess: z.literal('native-windows'),
});
export type WindowsWorkerConfig = z.infer<typeof configSchema>;

function within(root: string, path: string): boolean {
  const relative = win32.relative(root, path);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative))
  );
}

/** Resolves setup paths under the controller's authority. The launcher checks the worker account. */
export async function validateWindowsWorkerConfig(
  input: unknown,
  dataDir: string,
): Promise<WindowsWorkerConfig | null> {
  if (process.platform !== 'win32') return null;
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) return null;
  const { launcherPath, claudePath, configDir } = parsed.data;
  try {
    const [launcherExe, claudeExe, profile, controllerData, defaultData, controllerProfile] =
      await Promise.all([
        realpath(launcherPath),
        realpath(claudePath),
        realpath(configDir),
        realOr(dataDir),
        realOr(defaultDataDir()),
        realOr(win32.join(homedir(), '.claude')),
      ]);
    const canonical = configSchema.safeParse({
      ...parsed.data,
      launcherPath: launcherExe,
      claudePath: claudeExe,
      configDir: profile,
    });
    if (!canonical.success || win32.relative(launcherExe, claudeExe) === '') return null;
    for (const privateDir of [controllerData, defaultData, controllerProfile]) {
      if (
        within(privateDir, profile) ||
        within(profile, privateDir) ||
        within(privateDir, launcherExe) ||
        within(privateDir, claudeExe)
      )
        return null;
    }
    const [launcherStat, claudeStat, profileStat] = await Promise.all([
      stat(launcherExe),
      stat(claudeExe),
      stat(profile),
    ]);
    if (!launcherStat.isFile() || !claudeStat.isFile() || !profileStat.isDirectory()) return null;
    await Promise.all(
      [launcherExe, claudeExe, profile].map((path) => access(path, constants.R_OK)),
    );
    for (const privateFile of [
      win32.join(profile, '.credentials.json'),
      walletPath(profile),
      spendLedgerPath(profile),
      passphraseRecordPath(profile),
    ]) {
      const exists = await lstat(privateFile).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists) return null;
    }
    return canonical.data;
  } catch {
    return null;
  }
}

/** Read only user config. A saved path that now resolves elsewhere loses its grant. */
export async function loadWindowsWorkerConfig(
  dataDir: string,
): Promise<WindowsWorkerConfig | null> {
  if (process.platform !== 'win32') return null;
  const router = (await loadRawConfig(dataDir).catch(() => null))?.router;
  if (router?.subagents !== true) return null;
  const record = configSchema.safeParse(router.windowsWorker);
  const consent = modelConsentSchema.safeParse(router.subagentConsent);
  if (!record.success || !consent.success || consent.data.routerOrigin !== record.data.routerOrigin)
    return null;
  const config = await validateWindowsWorkerConfig(record.data, dataDir);
  if (
    !config ||
    win32.relative(config.launcherPath, record.data.launcherPath) !== '' ||
    win32.relative(config.claudePath, record.data.claudePath) !== '' ||
    win32.relative(config.configDir, record.data.configDir) !== ''
  )
    return null;
  return config;
}

import { personalSettingsAt } from './settings';

/** The hash every routing call sends for the rules saved in `dataDir` now. */
export async function hashNow(dataDir: string): Promise<string> {
  const { wire } = await personalSettingsAt(dataDir);
  if (wire.status !== 'ok') throw new Error('unreadable');
  return wire.settings.hash;
}

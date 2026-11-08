import { execFile } from 'node:child_process';
import { hostname } from 'node:os';

/**
 * THIS COMPUTER'S NAME, for the fund page to show ("Tenjin on Ada's MacBook
 * Pro"), so a person paying can see which machine the link is for. Display
 * only: the server signs it into the link and stores nothing.
 *
 * macOS asks `scutil --get ComputerName`, the name System Settings shows,
 * because `os.hostname()` there is the network name (`adas-mbp.local`).
 * Windows and Linux report the name people set as the hostname. A trailing
 * `.local` is dropped, controls and anything past 64 characters are cut, and
 * nothing here ever throws: a fund link never fails over its label.
 */

const MAX_DEVICE_NAME = 64;
const SCUTIL = '/usr/sbin/scutil';
const SCUTIL_TIMEOUT_MS = 1_000;

export interface DeviceNameDeps {
  platform?: NodeJS.Platform;
  /** `scutil --get ComputerName`'s output, or null when it failed. */
  computerName?: () => Promise<string | null>;
  hostname?: () => string;
}

export async function deviceName(deps: DeviceNameDeps = {}): Promise<string | undefined> {
  try {
    const platform = deps.platform ?? process.platform;
    const fromMac = platform === 'darwin' ? await (deps.computerName ?? macComputerName)() : null;
    const named = clean(fromMac ?? '');
    if (named !== undefined) return named;
    return clean((deps.hostname ?? hostname)());
  } catch {
    return undefined;
  }
}

/** Printable, trimmed, without `.local`, at most 64 characters; undefined when nothing is left. */
export function clean(raw: string): string | undefined {
  const printable = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .replace(/\.local$/i, '')
    .trim();
  const capped = [...printable].slice(0, MAX_DEVICE_NAME).join('').trim();
  return capped.length > 0 ? capped : undefined;
}

function macComputerName(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      SCUTIL,
      ['--get', 'ComputerName'],
      { timeout: SCUTIL_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err === null ? String(stdout) : null),
    );
  });
}

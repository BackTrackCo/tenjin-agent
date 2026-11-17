import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';

/**
 * A HASH THAT NAMES THIS COMPUTER, for the one-per-computer check on event
 * codes (`tenjin redeem`, and the fund page's "Have a code?" box). The server
 * sees only the hash: the operating system's own machine ID never leaves this
 * module, and the prefix keeps the hash from matching any other product's
 * hash of the same ID.
 *
 * Hand-rolled rather than `node-machine-id`, which is unmaintained and runs
 * its commands through `execSync` strings. Here, as in `open-url.ts` and
 * `device-name.ts`, each read is an absolute binary with an argv array, never
 * a shell, under a hard timeout, and any failure is `undefined`, never a throw:
 * a code that needs no per-computer check still redeems without it.
 *
 * - macOS: `IOPlatformUUID` from `ioreg`, the hardware UUID.
 * - Linux: `/etc/machine-id`, else `/var/lib/dbus/machine-id`.
 * - Windows: `MachineGuid` under `HKLM\SOFTWARE\Microsoft\Cryptography`, read
 *   from the 64-bit registry view so a 32-bit Node reads the same key.
 */

/** Changing it lets every computer that already redeemed a code redeem it again. */
const HASH_PREFIX = 'tenjin-promo-machine-v1:';
const READ_TIMEOUT_MS = 1_500;
const IOREG = '/usr/sbin/ioreg';
const LINUX_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;
/**
 * What a machine ID looks like on all three: hex, as a UUID or bare. Anything
 * else (systemd's `uninitialized` placeholder, an empty file) is no ID.
 */
const PLAUSIBLE_ID = /^[0-9a-f-]{16,64}$/;

export interface MachineIdDeps {
  platform?: NodeJS.Platform;
  execFileImpl?: typeof execFile;
  readFileImpl?: (path: string) => Promise<string>;
  /** For `%SystemRoot%` on Windows. */
  env?: NodeJS.ProcessEnv;
}

/** sha256 hex of the prefix and this computer's ID, or undefined when it cannot be read. */
export async function machineHash(deps: MachineIdDeps = {}): Promise<string | undefined> {
  try {
    const raw = await rawMachineId(deps);
    if (raw === undefined) return undefined;
    return createHash('sha256').update(`${HASH_PREFIX}${raw}`).digest('hex');
  } catch {
    return undefined;
  }
}

/** The ID itself, lowercased and trimmed; module-private so it cannot be sent anywhere. */
async function rawMachineId(deps: MachineIdDeps): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    const out = await run(deps, IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice']);
    return plausible(/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out ?? '')?.[1]);
  }
  if (platform === 'linux') {
    const read = deps.readFileImpl ?? ((path: string) => readFile(path, 'utf8'));
    for (const path of LINUX_ID_FILES) {
      const id = plausible(await read(path).catch(() => undefined));
      if (id !== undefined) return id;
    }
    return undefined;
  }
  if (platform === 'win32') {
    const root = (deps.env ?? process.env).SystemRoot ?? 'C:\\Windows';
    const out = await run(deps, win32.join(root, 'System32', 'reg.exe'), [
      'query',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
      '/reg:64',
    ]);
    return plausible(/^\s*MachineGuid\s+REG_SZ\s+(\S+)\s*$/im.exec(out ?? '')?.[1]);
  }
  return undefined;
}

/** An all-zero ID is a VM's placeholder that many computers share, so it names none. */
function plausible(raw: string | undefined): string | undefined {
  const id = raw?.trim().toLowerCase();
  if (id === undefined || !PLAUSIBLE_ID.test(id)) return undefined;
  return /[1-9a-f]/.test(id) ? id : undefined;
}

function run(deps: MachineIdDeps, cmd: string, args: string[]): Promise<string | undefined> {
  const exec = deps.execFileImpl ?? execFile;
  return new Promise((resolve) => {
    try {
      exec(
        cmd,
        args,
        { timeout: READ_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err === null ? String(stdout) : undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
}

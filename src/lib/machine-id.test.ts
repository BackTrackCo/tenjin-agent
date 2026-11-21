import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { execFile } from 'node:child_process';
import { machineHash } from './machine-id';

type ExecCb = (err: Error | null, stdout?: string) => void;

function stubExec(answer: { err: Error | null; stdout?: string }): {
  impl: typeof execFile;
  calls: { cmd: string; args: string[]; timeout?: number }[];
} {
  const calls: { cmd: string; args: string[]; timeout?: number }[] = [];
  const impl = ((cmd: string, args: string[], opts: { timeout?: number }, cb: ExecCb) => {
    calls.push({ cmd, args, timeout: opts.timeout });
    cb(answer.err, answer.stdout ?? '');
  }) as unknown as typeof execFile;
  return { impl, calls };
}

/**
 * The derivation is a contract with every computer that already redeemed: a
 * different prefix or casing makes a new hash for the same computer, and the
 * one-per-computer check lets it redeem the same code again.
 */
const expected = (id: string) =>
  createHash('sha256').update(`tenjin-promo-machine-v1:${id}`).digest('hex');

const MAC_UUID = '8A2B1F4E-5C6D-4E7F-8091-A2B3C4D5E6F7';
const IOREG_OUT = `+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000215, registered, matched, active, busy 0 (12 ms), retain 39>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXX"
      "IOPlatformUUID" = "${MAC_UUID}"
      "model" = <"MacBookPro18,3">
    }
`;

describe('machineHash', () => {
  it('macOS: hashes the IOPlatformUUID from an absolute ioreg, lowercased', async () => {
    const { impl, calls } = stubExec({ err: null, stdout: IOREG_OUT });
    const hash = await machineHash({ platform: 'darwin', execFileImpl: impl });
    expect(hash).toBe(expected(MAC_UUID.toLowerCase()));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([
      { cmd: '/usr/sbin/ioreg', args: ['-rd1', '-c', 'IOPlatformExpertDevice'], timeout: 1500 },
    ]);
  });

  it('Linux: /etc/machine-id, trimmed, else the dbus copy', async () => {
    const id = '4c4c4544004b4d10804bb4c04f4e3732';
    const reads: string[] = [];
    const fromEtc = await machineHash({
      platform: 'linux',
      readFileImpl: async (path) => {
        reads.push(path);
        return `${id}\n`;
      },
    });
    expect(fromEtc).toBe(expected(id));
    expect(reads).toEqual(['/etc/machine-id']);

    reads.length = 0;
    const fromDbus = await machineHash({
      platform: 'linux',
      readFileImpl: async (path) => {
        reads.push(path);
        if (path === '/etc/machine-id') throw new Error('ENOENT');
        return id.toUpperCase();
      },
    });
    expect(fromDbus).toBe(expected(id));
    expect(reads).toEqual(['/etc/machine-id', '/var/lib/dbus/machine-id']);
  });

  it("Linux: systemd's `uninitialized` placeholder is no ID, so the dbus copy is read", async () => {
    const id = '4c4c4544004b4d10804bb4c04f4e3732';
    const hash = await machineHash({
      platform: 'linux',
      readFileImpl: async (path) => (path === '/etc/machine-id' ? 'uninitialized\n' : id),
    });
    expect(hash).toBe(expected(id));
  });

  it('Windows: the MachineGuid REG_SZ from reg.exe under %SystemRoot%, in the 64-bit view', async () => {
    const guid = '3F1C2B4A-9D8E-4F70-A1B2-C3D4E5F60718';
    const { impl, calls } = stubExec({
      err: null,
      stdout: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n\r\n`,
    });
    const hash = await machineHash({
      platform: 'win32',
      execFileImpl: impl,
      env: { SystemRoot: 'D:\\Win' },
    });
    expect(hash).toBe(expected(guid.toLowerCase()));
    expect(calls[0]!.cmd).toBe('D:\\Win\\System32\\reg.exe');
    expect(calls[0]!.args).toEqual([
      'query',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
      '/reg:64',
    ]);
  });

  it('is undefined, never a throw, when the read fails, says nothing, or the platform has none', async () => {
    expect(
      await machineHash({
        platform: 'darwin',
        execFileImpl: stubExec({ err: new Error('timed out') }).impl,
      }),
    ).toBeUndefined();
    expect(
      await machineHash({
        platform: 'darwin',
        execFileImpl: stubExec({ err: null, stdout: '+-o Root\n' }).impl,
      }),
    ).toBeUndefined();
    expect(
      await machineHash({
        platform: 'linux',
        readFileImpl: async () => {
          throw new Error('EACCES');
        },
      }),
    ).toBeUndefined();
    const throwing = (() => {
      throw new Error('spawn EPERM');
    }) as unknown as typeof execFile;
    expect(await machineHash({ platform: 'win32', execFileImpl: throwing, env: {} })).toBe(
      undefined,
    );
    expect(await machineHash({ platform: 'freebsd' })).toBeUndefined();
  });

  it('refuses an all-zero ID, a VM placeholder many computers share', async () => {
    const zero = '00000000-0000-0000-0000-000000000000';
    const { impl } = stubExec({ err: null, stdout: `"IOPlatformUUID" = "${zero}"` });
    expect(await machineHash({ platform: 'darwin', execFileImpl: impl })).toBeUndefined();
  });
});

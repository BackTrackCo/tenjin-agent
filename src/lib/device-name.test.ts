import { describe, expect, it } from 'vitest';
import { deviceName } from './device-name';

/**
 * The fund link route takes a device name of 1 to 64 printable characters and
 * drops anything else; the page shows it ("Tenjin on Ada's MacBook Pro").
 */
describe('the device name a fund link carries', () => {
  it("uses macOS's computer name, not its network hostname", async () => {
    expect(
      await deviceName({
        platform: 'darwin',
        computerName: async () => "Ada's MacBook Pro\n",
        hostname: () => 'adas-mbp.local',
      }),
    ).toBe("Ada's MacBook Pro");
  });

  it('falls back to the hostname without .local, on macOS and elsewhere', async () => {
    expect(
      await deviceName({
        platform: 'darwin',
        computerName: async () => null,
        hostname: () => 'adas-mbp.local',
      }),
    ).toBe('adas-mbp');
    expect(await deviceName({ platform: 'linux', hostname: () => 'build-box' })).toBe('build-box');
    expect(await deviceName({ platform: 'win32', hostname: () => 'DESKTOP-1A2B' })).toBe(
      'DESKTOP-1A2B',
    );
  });

  it('drops controls and direction marks, caps at 64 characters, and never throws', async () => {
    const name = await deviceName({
      platform: 'linux',
      hostname: () => `\u202eevil\u0007${'x'.repeat(100)}`,
    });
    expect(name).toBe(`evil${'x'.repeat(60)}`);
    expect(await deviceName({ platform: 'linux', hostname: () => ' .local ' })).toBeUndefined();
    expect(
      await deviceName({
        platform: 'linux',
        hostname: () => {
          throw new Error('no hostname');
        },
      }),
    ).toBeUndefined();
  });
});

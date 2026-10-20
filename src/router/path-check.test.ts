import { describe, expect, it } from 'vitest';
import {
  expandWindowsVars,
  missingFromPath,
  parseRegPath,
  processPath,
  readSavedPath,
  stalePathCheck,
  type PathProbe,
} from './path-check';

/** Where a default Windows install puts Node and the npm CLI. */
const ENTRY = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tenjin-cli\\dist\\index.js';
const NPM_DIR = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const NODE_DIR = 'C:\\Program Files\\nodejs\\';

describe('reading the saved Windows PATH', () => {
  const user = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    `    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;%LOCALAPPDATA%\\Microsoft\\WindowsApps;`,
    '',
  ].join('\r\n');
  const machine = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    `    Path    REG_SZ    C:\\Windows\\system32;${NODE_DIR}`,
    '',
  ].join('\r\n');
  const env = { USERPROFILE: 'C:\\Users\\me', LocalAppData: 'C:\\Users\\me\\AppData\\Local' };

  it('parses the value of `reg query /v Path`', () => {
    expect(parseRegPath(user)).toBe(
      '%USERPROFILE%\\AppData\\Roaming\\npm;%LOCALAPPDATA%\\Microsoft\\WindowsApps;',
    );
    expect(parseRegPath('ERROR: The system was unable to find the specified registry key')).toBe(
      null,
    );
  });

  it('expands variables by name in any case and keeps an unknown one as written', () => {
    expect(expandWindowsVars('%localappdata%\\x;%NOPE%\\y', env)).toBe(
      'C:\\Users\\me\\AppData\\Local\\x;%NOPE%\\y',
    );
  });

  it('reads the user entries, then the machine entries, from reg.exe by full path', async () => {
    const keys: string[] = [];
    const saved = await readSavedPath('win32', env, async (key) => {
      keys.push(key);
      return key.startsWith('HKCU') ? user : machine;
    });
    expect(keys).toEqual([
      'HKCU\\Environment',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    ]);
    expect(saved).toEqual([
      NPM_DIR,
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps',
      'C:\\Windows\\system32',
      NODE_DIR,
    ]);
  });

  it('reads nothing off Windows, or when neither key reads', async () => {
    expect(await readSavedPath('darwin', env, async () => user)).toBeNull();
    expect(await readSavedPath('win32', env, async () => null)).toBeNull();
  });
});

describe('comparing PATHs', () => {
  it('matches Windows directories in any case and with or without a trailing separator', () => {
    const current = 'c:\\windows\\System32;C:/Program Files/nodejs';
    expect(
      missingFromPath(current, ['C:\\Windows\\system32\\', NODE_DIR, NPM_DIR], 'win32'),
    ).toEqual([NPM_DIR]);
  });

  it('keeps case on POSIX and splits on colons', () => {
    expect(
      missingFromPath('/usr/bin:/opt/Node/bin/', ['/opt/Node/bin', '/opt/node/bin'], 'linux'),
    ).toEqual(['/opt/node/bin']);
  });

  it('reads PATH under whichever casing the environment carries', () => {
    expect(processPath({ Path: 'C:\\a' })).toBe('C:\\a');
    expect(processPath({ PATH: '/a' })).toBe('/a');
    expect(processPath({})).toBe('');
  });
});

describe('the stale-PATH row', () => {
  const probe = (over: Partial<PathProbe>): PathProbe => ({
    platform: 'win32',
    env: { Path: 'C:\\Windows\\system32', CLAUDECODE: '1' },
    savedPath: async () => ['C:\\Windows\\system32', NPM_DIR, NODE_DIR],
    npmPrefix: async () => null,
    cliEntry: ENTRY,
    ...over,
  });

  it("names what Claude Code's PATH lacks, and the restart that refreshes it", async () => {
    expect(await stalePathCheck(probe({}))).toEqual({
      name: 'PATH',
      status: 'warn',
      required: false,
      detail: `Claude Code's PATH lacks ${NPM_DIR}, ${NODE_DIR}`,
      fix: 'Restart Claude Code (quit it from the tray) or sign out and in.',
    });
  });

  it('says this shell outside Claude Code', async () => {
    const check = await stalePathCheck(probe({ env: { Path: 'C:\\Windows\\system32' } }));
    expect(check?.detail).toMatch(/^this shell's PATH lacks /);
    expect(check?.fix).toMatch(
      /^Open a new terminal\. .*restart Claude Code \(quit it from the tray\) or sign out and in\.$/,
    );
  });

  it("adds npm's global bin when this CLI lives under npm's prefix", async () => {
    const check = await stalePathCheck(
      probe({ savedPath: async () => null, npmPrefix: async () => NPM_DIR }),
    );
    expect(check?.detail).toBe(`Claude Code's PATH lacks ${NPM_DIR}`);
    const posix = await stalePathCheck({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      savedPath: async () => null,
      npmPrefix: async () => '/home/me/.npm-global',
      cliEntry: '/home/me/.npm-global/lib/node_modules/tenjin-cli/dist/index.js',
    });
    expect(posix?.detail).toContain('/home/me/.npm-global/bin');
  });

  it("ignores npm's prefix when this CLI is not under it, and never asks npm outside node_modules", async () => {
    expect(
      await stalePathCheck(
        probe({ savedPath: async () => null, npmPrefix: async () => 'D:\\elsewhere' }),
      ),
    ).toBeNull();
    let asked = false;
    await stalePathCheck(
      probe({
        cliEntry: 'C:\\src\\tenjin-agent\\dist\\index.js',
        npmPrefix: async () => ((asked = true), null),
      }),
    );
    expect(asked).toBe(false);
  });

  it('reports nothing when PATH holds every saved directory', async () => {
    const env = { Path: `C:\\Windows\\system32;${NPM_DIR};${NODE_DIR}`, CLAUDECODE: '1' };
    expect(await stalePathCheck(probe({ env }))).toBeNull();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/**
 * Isolation for any test that dispatches a real command through `main`.
 *
 * The post-command hooks (skills self-heal, update nudge) read BOTH the Tenjin
 * data dir and the user's home, and the self-heal WRITES into the harness skill
 * directories under home. A test that isolates only `TENJIN_DATA_DIR` therefore
 * still reaches the developer's real `~/.claude/skills`, and a full test run has
 * rewritten a maintainer's actual skill copies. Isolate both, always.
 *
 * Not bundled into dist: nothing in the entry graph imports it, same pattern as
 * read-test-utils and wallet/test-support.
 */
export interface IsolatedEnv {
  /** The temp HOME for the current test. */
  home: () => string;
  /** The temp TENJIN_DATA_DIR for the current test. */
  data: () => string;
}

/**
 * Point HOME and TENJIN_DATA_DIR at fresh temp directories for each test in the
 * calling suite, and restore the real values afterwards. Call at describe or
 * file scope.
 */
export function isolateHomeAndData(): IsolatedEnv {
  let home = '';
  let data = '';
  let prevHome: string | undefined;
  let prevData: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tenjin-test-home-'));
    data = mkdtempSync(join(tmpdir(), 'tenjin-test-data-'));
    prevHome = process.env.HOME;
    prevData = process.env.TENJIN_DATA_DIR;
    prevUserProfile = process.env.USERPROFILE; // os.homedir() reads this on win32
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.TENJIN_DATA_DIR = data;
  });

  afterEach(() => {
    restore('HOME', prevHome);
    restore('USERPROFILE', prevUserProfile);
    restore('TENJIN_DATA_DIR', prevData);
    rmSync(home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  return { home: () => home, data: () => data };
}

function restore(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

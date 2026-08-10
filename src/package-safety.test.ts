import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

/**
 * Consumer lifecycle scripts run implicitly during a global package update or
 * removal. Keep them absent so replacing the Tenjin package cannot execute a
 * home-directory wallet migration (ClawRouter or local) behind the user's back.
 * `prepare` is intentionally not in this list: npm runs it while packing this
 * repository, not as the installed package's consumer lifecycle.
 */
describe('package wallet safety', () => {
  it('has no implicit consumer install or uninstall lifecycle', () => {
    const scripts = pkg.scripts as Record<string, string | undefined>;
    for (const lifecycle of [
      'preinstall',
      'install',
      'postinstall',
      'preuninstall',
      'uninstall',
      'postuninstall',
    ]) {
      expect(scripts[lifecycle], `${lifecycle} must remain explicit`).toBeUndefined();
    }
  });
});

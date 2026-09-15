import type { Harness, HarnessAdapter } from '../adapters/types';
import { registeredHooks } from './harness-hooks';
import { detectHarnesses, harnessInPlay, harnessTargetDir, onPath } from './skill-wiring';

/**
 * Is one adapter part of this machine's settled installation?
 *
 * An explicit install selection outranks current detection; homes predating
 * that record fall back to the harness directory/PATH probes. Registered hook
 * entries are final evidence, so config and doctor agree even if the binary or
 * home-directory marker later moves.
 */
export async function installedHarnessInPlay(
  adapter: HarnessAdapter,
  home: string,
  dataDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    which?: (bin: string) => boolean;
    requested?: readonly Harness[];
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const which = options.which ?? ((bin: string) => onPath(bin, env));
  if (
    harnessInPlay(
      home,
      harnessTargetDir(home, adapter.id),
      detectHarnesses(home, which),
      options.requested ?? [],
    )
  ) {
    return true;
  }
  return (await registeredHooks(adapter, home, dataDir, env)).entries > 0;
}

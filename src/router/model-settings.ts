import { sep } from 'node:path';
import type { RouterContext } from '../lib/config';

/** What an offer runs under: where it may work, its cap and the router it was offered by. */
export type ModelSettings = {
  version: number;
  scope: 'repositories' | 'native-workspace';
  root: string;
  repositories: string[];
  maxJobAtomic: bigint;
  routerOrigin: string;
  context: RouterContext;
};

/** A named directory covers its descendants, never its parent or a sibling prefix. */
export function disclosureCovers(repositories: readonly string[], path: string): boolean {
  return repositories.some(
    (root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}

/**
 * NO SAVED SETTING TURNS A DEEPSEEK OFFER ON. `router.subagents`, `router.subagentConsent` and
 * `router.windowsWorker` may still sit in the config file of a person who turned the feature on
 * with an earlier build. This build never reads them, leaves the file as it is and charges
 * nothing for them. With no consent no Agent call is held and no offer is made; the code that
 * would act on one goes with the offer path.
 */
export async function modelSettings(_dataDir: string, _cwd: string): Promise<ModelSettings | null> {
  return null;
}

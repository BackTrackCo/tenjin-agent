import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import type { Harness, HarnessAdapter } from './types';

/**
 * The adapters this build implements, spelled once: the daemon dispatches
 * `/hook/:harness` over it and the installer wires hook entries for the
 * members it detects. Skills-only targets (`shared`) are not here; a harness
 * joins when its adapter lands.
 */
export const ADAPTERS: Record<Harness, HarnessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function adapterFor(harness: string): HarnessAdapter | undefined {
  return Object.hasOwn(ADAPTERS, harness) ? ADAPTERS[harness as Harness] : undefined;
}

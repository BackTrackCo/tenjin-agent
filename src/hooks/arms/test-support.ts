import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, HookTool, ToolKind } from '../../adapters/types';
import { CONFIG_DEFAULTS } from '../../lib/config';
import { openLoopDb, type LoopDb } from '../store';
import type { Actor, Arm, Deps, FireContext, FireClock, KernelConfig } from '../types';

/**
 * What an arm test needs to run one fire's worth of an arm: a real `loop.db`
 * (marks are the context arm's whole subject, and faking them would test the
 * fake), a frozen clock and a config it can move one key of. Shared because
 * four arm suites need the same four objects and a fifth copy of them is where
 * they start to disagree.
 */

export const NOW = 1_700_000_000_000;

export const LEAD: Actor = { session: 's1', agent: '' };
export const CHILD: Actor = { session: 's1', agent: 'a1b2c3d4' };

const dirs: string[] = [];
const open: LoopDb[] = [];

export function freshDb(): LoopDb {
  const dir = mkdtempSync(join(tmpdir(), 'tenjin-c-arm-'));
  dirs.push(dir);
  const db = openLoopDb(dir);
  open.push(db);
  return db;
}

/** For an `afterEach`: closes every db this file opened and removes its dir. */
export function cleanup(): void {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function kernelConfig(hooks: Partial<KernelConfig['hooks']> = {}): KernelConfig {
  return {
    hooks: { ...CONFIG_DEFAULTS.hooks, ...hooks },
    loop: CONFIG_DEFAULTS.loop,
    team: CONFIG_DEFAULTS.team,
    baseUrl: 'https://shelf.acme.internal',
    publicShelfUrl: 'https://tenjin.blog',
    shelfBypassSecret: '',
  };
}

export function toolInput(kind: ToolKind, input: Record<string, unknown>): HookTool {
  return { name: kind, kind, input };
}

export function hookInput(over: Partial<HookInput> = {}): HookInput {
  return {
    harness: 'claude',
    event: 'prompt',
    native: { event: 'UserPromptSubmit' },
    session: 's1',
    cwd: '/tmp/proj',
    raw: {},
    ...over,
  };
}

export interface CtxOptions {
  db: LoopDb;
  arm: Arm;
  input: HookInput;
  config?: KernelConfig;
  actor?: Actor;
  clock?: () => number;
}

export function fireContext(opts: CtxOptions): FireContext {
  const config = opts.config ?? kernelConfig();
  const clock = opts.clock ?? (() => NOW);
  const deps: Deps = {
    db: opts.db,
    config: () => config,
    clock,
    log: () => undefined,
    arms: [opts.arm],
    adapters: {},
  };
  const fire: FireClock = {
    id: 'fire-1',
    startedAt: clock(),
    deadlineMs: config.loop.tool_wait_ms,
    remaining: () => config.loop.tool_wait_ms,
    signal: new AbortController().signal,
    legs: [],
  };
  return { actor: opts.actor ?? LEAD, input: opts.input, arm: opts.arm, fire, deps };
}

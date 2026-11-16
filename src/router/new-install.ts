import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import type { CommandContext, CommandResult } from '../context';
import { persist } from '../commands/config';
import { resolveSettings, type PartialConfig } from '../lib/config';
import { hasCode } from '../lib/errno';
import { nativeWorkspaceModelConsent } from './model-settings';

export type NewInstallSession = {
  readonly dataDir: string;
  readonly absent: boolean;
  claimId?: string;
  accepted: boolean;
  completed: boolean[];
  disqualified?: boolean;
};

/** Capture before runtime, wallet, identity or config writes. Existing empty profiles count as existing. */
export async function captureNewInstall(dataDir: string): Promise<NewInstallSession> {
  let absent = false;
  try {
    await lstat(dataDir);
  } catch (error) {
    absent = hasCode(error, 'ENOENT');
  }
  return { dataDir, absent, accepted: false, completed: [] };
}

function origin(config: PartialConfig, ctx: CommandContext): string | undefined {
  try {
    return new URL(
      resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env }).baseUrl
        .value,
    ).origin;
  } catch {
    return undefined;
  }
}

function blocked(config: PartialConfig): boolean {
  const router = config.router;
  return (
    router?.enabled === false ||
    (router !== undefined &&
      (Object.hasOwn(router, 'subagents') || Object.hasOwn(router, 'subagentConsent')))
  );
}

function withoutClaim(config: PartialConfig): PartialConfig {
  const install = { ...config.install };
  delete install.pendingDeepSeekSetup;
  return { ...config, install };
}

/** A durable unfinished-install claim grants no sharing or spending authority. */
export async function reserveNewInstall(
  session: NewInstallSession,
  ctx: CommandContext,
  eligible = true,
): Promise<void> {
  session.disqualified ||= !eligible;
  if (session.disqualified) {
    // A preexisting host surface disqualifies the entire shared setup. Do not
    // leave another host's claim available to enable it on a later invocation.
    if (session.claimId || !session.absent) {
      await persist(session.dataDir, (config) =>
        config.install?.pendingDeepSeekSetup ? withoutClaim(config) : config,
      );
    }
    session.claimId = undefined;
    return;
  }
  let created = false;
  if (session.absent) {
    try {
      // Exactly one competing setup may claim an absent profile, even before config exists.
      await mkdir(session.dataDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  await persist(session.dataDir, (config) => {
    const pending = config.install?.pendingDeepSeekSetup;
    const routerOrigin = origin(config, ctx);
    if (blocked(config) || !routerOrigin || (pending && pending.routerOrigin !== routerOrigin)) {
      session.claimId = undefined;
      return pending ? withoutClaim(config) : config;
    }
    if (pending) {
      session.claimId = pending.id;
      return config;
    }
    // Another config writer or an older profile always wins over a fresh-install default.
    if (!created || Object.keys(config).length !== 0) return config;
    session.claimId = randomUUID();
    return {
      ...config,
      install: {
        ...config.install,
        pendingDeepSeekSetup: { version: 1, id: session.claimId, routerOrigin },
      },
    };
  });
}

/** Run once only after every requested host completed an accepted setup. */
export async function completeNewInstall(
  session: NewInstallSession,
  ctx: CommandContext,
): Promise<boolean> {
  const claimId = session.claimId;
  if (
    !claimId ||
    !session.accepted ||
    !session.completed.length ||
    session.completed.some((done) => !done)
  )
    return false;
  let enabled = false;
  await persist(session.dataDir, (config) => {
    const pending = config.install?.pendingDeepSeekSetup;
    if (!pending || pending.id !== claimId) return config;
    const next = withoutClaim(config);
    const routerOrigin = origin(config, ctx);
    if (blocked(config) || routerOrigin !== pending.routerOrigin) return next;
    enabled = true;
    return {
      ...next,
      router: {
        ...config.router,
        subagents: true,
        subagentConsent: nativeWorkspaceModelConsent({ routerOrigin }),
      },
    };
  });
  return enabled;
}

/** The shared core action adds this once; standalone host installs use the same receipt. */
export function newInstallReceipt(result: CommandResult, enabled: boolean): CommandResult {
  if (!enabled) return result;
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      subagents: { enabled: true, scope: 'native-workspace', maxJobAtomic: '1000000' },
    },
    humanLines: [
      ...(result.humanLines ?? []),
      'DeepSeek subagent routing is enabled with parent veto and a $1 job limit. Turn it off with `tenjin config subagents off`.',
    ],
  };
}

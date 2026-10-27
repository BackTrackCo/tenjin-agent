import type { CommandContext, CommandResult } from '../context';
import { underAgentHarness } from '../lib/session';
import { PLUGIN_ID } from './names';

/** The ordinary agent needs the next decision, not successful storage/launcher diagnostics. */
export function installOutput(
  result: CommandResult,
  ctx: CommandContext,
  refresh: boolean,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  if (refresh || ctx.flags.json || ctx.io.isTTY || !underAgentHarness(env)) return result;
  return { ...result, data: handoff(result.data), compactJson: true };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function handoff(value: unknown): unknown {
  if (!record(value)) return value;
  if (Array.isArray(value.hosts)) {
    const out = { ...value };
    for (const host of value.hosts) {
      if (typeof host === 'string' && Object.hasOwn(value, host)) out[host] = handoff(value[host]);
    }
    return out;
  }
  const {
    next,
    nextSteps,
    plugin,
    wallet,
    spend,
    migration,
    router,
    removedSkills,
    claudeCode,
    runtime,
    launcher,
    mcpServer,
    ...rest
  } = value;
  return {
    next:
      typeof next === 'string'
        ? `${next}. Relay only the current next action; briefly explain sharing once before activation and skip setup recaps or funding offers after Not now.`
        : next,
    nextSteps,
    ...rest,
    spend: spendHandoff(spend),
    plugin: registeredPlugin(plugin),
    wallet: walletHandoff(wallet),
    ...(record(migration) &&
    migration.state === 'none' &&
    !migration.reason &&
    !migration.fix &&
    !migration.warning
      ? {}
      : { migration }),
    ...(record(router) && router.status === 'ok' && !router.fix && !router.reason && !router.warning
      ? {}
      : { router }),
    ...(Array.isArray(removedSkills) && removedSkills.length === 0 ? {} : { removedSkills }),
    // Preserve blocked/unknown readiness and every fix; omit only successful diagnostics.
    ...(record(claudeCode) &&
    claudeCode.meetsFloor === true &&
    !claudeCode.fix &&
    !claudeCode.reason &&
    !claudeCode.warning
      ? {}
      : { claudeCode }),
    ...(record(runtime) &&
    ['active', 'current', 'kept'].includes(String(runtime.state)) &&
    !runtime.reason &&
    !runtime.fix &&
    !runtime.warning
      ? {}
      : { runtime }),
    ...(record(launcher) &&
    ['written', 'current'].includes(String(launcher.state)) &&
    !launcher.reason &&
    !launcher.fix &&
    !launcher.warning
      ? {}
      : { launcher }),
    ...(record(mcpServer) &&
    mcpServer.status === 'ok' &&
    mcpServer.required === false &&
    !mcpServer.fix &&
    !mcpServer.warning
      ? {}
      : { mcpServer }),
  };
}

function registeredPlugin(value: unknown): unknown {
  if (value === PLUGIN_ID) return undefined;
  if (
    !record(value) ||
    !['installed', 'updated', 'current', 'written'].includes(String(value.state)) ||
    value.reason ||
    value.fix ||
    value.warning ||
    value.fallbackReason ||
    value.supersededFolder
  )
    return value;
  return undefined;
}

function spendHandoff(value: unknown): unknown {
  if (!record(value)) return value;
  const out = { ...value };
  delete out.set;
  delete out.kept;
  if (Array.isArray(out.removed) && out.removed.length === 0) delete out.removed;
  return out;
}

function walletHandoff(value: unknown): unknown {
  if (
    !record(value) ||
    !record(value.signing) ||
    value.signing.status !== 'ready' ||
    value.shellOnly !== undefined ||
    value.warning ||
    value.reason ||
    value.fix ||
    (record(value.passphrase) && value.passphrase.durable === false)
  )
    return value;
  if (value.status !== 'created' && value.status !== 'existing') return value;
  return undefined;
}

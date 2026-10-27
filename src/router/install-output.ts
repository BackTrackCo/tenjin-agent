import type { CommandContext, CommandResult } from '../context';
import { underAgentHarness } from '../lib/session';

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
  const { next, nextSteps, plugin, wallet, claudeCode, runtime, launcher, mcpServer, ...rest } =
    value;
  return {
    next,
    nextSteps,
    ...rest,
    plugin: registeredPlugin(plugin),
    wallet: walletHandoff(wallet),
    // Preserve blocked/unknown readiness and every fix; omit only successful diagnostics.
    ...(record(claudeCode) &&
    claudeCode.meetsFloor === true &&
    !claudeCode.fix &&
    !claudeCode.reason
      ? {}
      : { claudeCode }),
    ...(record(runtime) &&
    ['active', 'current', 'kept'].includes(String(runtime.state)) &&
    !runtime.reason &&
    !runtime.fix
      ? {}
      : { runtime }),
    ...(record(launcher) &&
    ['written', 'current'].includes(String(launcher.state)) &&
    !launcher.reason &&
    !launcher.fix
      ? {}
      : { launcher }),
    ...(record(mcpServer) &&
    mcpServer.status === 'ok' &&
    mcpServer.required === false &&
    !mcpServer.fix
      ? {}
      : { mcpServer }),
  };
}

function registeredPlugin(value: unknown): unknown {
  if (
    !record(value) ||
    !['installed', 'updated', 'current', 'written'].includes(String(value.state))
  )
    return value;
  const registration = { ...value };
  delete registration.steps;
  return registration;
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
  return { status: value.status, signing: { status: 'ready' } };
}

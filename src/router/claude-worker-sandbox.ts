import type { ResolvedSettings } from '@anthropic-ai/claude-agent-sdk/core';

/** These native configurations omit the shell's workspace-only read boundary. */
export function claudeWorkerSandboxCompatible(
  startupDirectories: readonly string[],
  resolved: Pick<ResolvedSettings, 'effective'> & Partial<Pick<ResolvedSettings, 'sources'>>,
  platform = process.platform,
): boolean {
  const sandbox = resolved.effective.sandbox;
  return !(
    platform === 'win32' ||
    sandbox?.filesystem?.disabled === true ||
    sandbox?.excludedCommands?.length ||
    sandbox?.filesystem?.allowManagedReadPathsOnly === true ||
    resolved.sources?.some(
      ({ source, settings }) =>
        source === 'managed' && settings.sandbox?.filesystem?.allowManagedReadPathsOnly === true,
    ) ||
    // Native tests the startup directory literally, not a parsed glob pattern.
    startupDirectories.some((directory) =>
      ['*', '?', '[', ']'].some((char) => directory.includes(char)),
    )
  );
}

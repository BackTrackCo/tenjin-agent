import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../lib/atomic-json';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Install only the two local demo files. Never renew payment authorization. */
export async function writeBridgeSetup(
  configPath: string,
  nodePath: string,
  cliPath: string,
  options: { nativeFallback?: boolean; nativeWebFetch?: boolean } = {},
) {
  const directory = dirname(configPath);
  const settingsPath = join(directory, 'bridge-settings.json');
  const mcpPath = join(directory, 'mcp.json');
  const command = `${quote(nodePath)} ${quote(cliPath)} bridge-hook --config ${quote(configPath)}`;
  const nativeSearchOnly = options.nativeFallback && options.nativeWebFetch === false;
  await writeFileAtomic(
    settingsPath,
    JSON.stringify(
      {
        enabledPlugins: {},
        ...(nativeSearchOnly ? { permissions: { deny: ['WebFetch'] } } : {}),
        statusLine: {
          type: 'command',
          command: `${quote(nodePath)} ${quote(join(dirname(cliPath), 'tenjin-auto-status.mjs'))} --config ${quote(configPath)}`,
          refreshInterval: 1,
        },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `${quote(nodePath)} ${quote(cliPath)} prompt-hook --config ${quote(configPath)}`,
                  timeout: 40,
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: '^mcp__x402__(request|search|fetch)$',
              hooks: [{ type: 'command', command, timeout: 90 }],
            },
            ...(options.nativeFallback
              ? [
                  {
                    matcher: nativeSearchOnly ? '^WebSearch$' : '^(WebSearch|WebFetch)$',
                    hooks: [
                      {
                        type: 'command',
                        command: `${quote(nodePath)} ${quote(cliPath)} native-hook --config ${quote(configPath)}`,
                        timeout: 90,
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      },
      null,
      2,
    ),
    { mode: 0o600, dirMode: 0o700 },
  );
  await writeFileAtomic(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          x402: {
            type: 'stdio',
            command: nodePath,
            args: [cliPath, 'bridge', '--config', configPath],
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600, dirMode: 0o700 },
  );
  return {
    settingsPath,
    mcpPath,
    note: options.nativeFallback
      ? nativeSearchOnly
        ? 'Policy and ledger preserved. Launch Sonnet with --permission-mode auto, --tools "WebSearch", these settings and this MCP config only. Native WebSearch receives its own Jev value check before execution. All page reads, including search-result links, go through mcp__x402__request with the exact URL; native WebFetch is disabled.'
        : 'Policy and ledger preserved. Launch Sonnet with --permission-mode auto, --tools "WebSearch,WebFetch", these settings and this MCP config only. Native tools receive their own Jev value check before execution; a paid preference requires the x402 request tool.'
      : 'Policy and ledger preserved. Launch Sonnet with --permission-mode auto, --tools "", these settings and this MCP config only.',
  };
}

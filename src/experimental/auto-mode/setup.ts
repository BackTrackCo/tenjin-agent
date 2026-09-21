import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../lib/atomic-json';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const NATIVE_FALLBACK_INSTRUCTIONS =
  'Before each external lookup or data request, call mcp__x402__request with the task and inputs so Jev can judge whether a paid service adds value. Do not choose a paid provider yourself. If the tool returns status native_fallback, use normal native tools for that same step when retrieval is needed, or answer with your own reasoning when no lookup is needed. The named native tool is a suggestion unless targetUrl is supplied; an exact targetUrl requires WebFetch of that URL. A native_fallback result is a routing decision, not retrieved information. Do not call the x402 tool again to execute that handoff. If the x402 tool already fulfilled the step, use that result and do not duplicate it with native tools. For a distinct later lookup, ask the request tool again. Never describe a native lookup as paid x402 fulfillment.';

/** Install only the two local demo files. Never renew payment authorization. */
export async function writeBridgeSetup(
  configPath: string,
  nodePath: string,
  cliPath: string,
  options: { nativeFallback?: boolean } = {},
) {
  const directory = dirname(configPath);
  const settingsPath = join(directory, 'bridge-settings.json');
  const mcpPath = join(directory, 'mcp.json');
  const command = `${quote(nodePath)} ${quote(cliPath)} bridge-hook --config ${quote(configPath)}`;
  await writeFileAtomic(
    settingsPath,
    JSON.stringify(
      {
        enabledPlugins: {},
        statusLine: {
          type: 'command',
          command: `${quote(nodePath)} ${quote(join(dirname(cliPath), 'tenjin-auto-status.mjs'))} --config ${quote(configPath)}`,
          refreshInterval: 1,
        },
        hooks: {
          ...(options.nativeFallback
            ? {
                UserPromptSubmit: [
                  {
                    hooks: [
                      {
                        type: 'command',
                        command: `${quote(nodePath)} ${quote(cliPath)} native-instructions --config ${quote(configPath)}`,
                        timeout: 10,
                      },
                    ],
                  },
                ],
              }
            : {}),
          PreToolUse: [
            {
              matcher: '^mcp__x402__(request|search|fetch)$',
              hooks: [{ type: 'command', command, timeout: 90 }],
            },
            ...(options.nativeFallback
              ? [
                  {
                    matcher: '^(WebSearch|WebFetch)$',
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
      ? 'Policy and ledger preserved. Launch Sonnet with --permission-mode auto, --tools "WebSearch,WebFetch", these settings and this MCP config only. Native tools receive their own Jev value check before execution; a paid preference requires the x402 request tool.'
      : 'Policy and ledger preserved. Launch Sonnet with --permission-mode auto, --tools "", these settings and this MCP config only.',
  };
}

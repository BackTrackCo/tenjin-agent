import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../lib/atomic-json';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Install only the two local demo files. Never renew payment authorization. */
export async function writeBridgeSetup(configPath: string, nodePath: string, cliPath: string) {
  const directory = dirname(configPath);
  const settingsPath = join(directory, 'bridge-settings.json');
  const mcpPath = join(directory, 'mcp.json');
  const command = `${quote(nodePath)} ${quote(cliPath)} bridge-hook --config ${quote(configPath)}`;
  await writeFileAtomic(
    settingsPath,
    JSON.stringify(
      {
        enabledPlugins: {},
        hooks: {
          PreToolUse: [
            {
              matcher: '^mcp__x402__(search|fetch)$',
              hooks: [{ type: 'command', command, timeout: 90 }],
            },
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
    note: 'Policy and ledger preserved. Launch Sonnet with --permission-mode auto, --tools "", these settings and this MCP config only.',
  };
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildTenjinMcpServer, type BuildMcpOptions } from './server';

/**
 * The `tenjin mcp` entry: connect the server over stdio and stay alive until the
 * transport closes (the client disconnects or stdin ends). The returned promise
 * must NOT resolve before then — the CLI action awaits it, and index.ts calls
 * process.exit on return, which would otherwise tear down a live server. The
 * StdioServerTransport owns stdout; nothing else here writes to it.
 */
export async function runMcpServer(opts: BuildMcpOptions = {}): Promise<void> {
  const server = buildTenjinMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
}

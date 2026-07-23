import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildTenjinMcpServer, type BuildMcpOptions } from './server';

/**
 * The `tenjin mcp` entry: connect the server over stdio and stay alive until the
 * client disconnects. The returned promise must NOT resolve before then — the CLI
 * action awaits it, and index.ts calls process.exit on return, which would
 * otherwise tear down a live server. The StdioServerTransport owns stdout; nothing
 * else here writes to it.
 *
 * SDK 1.29.0's StdioServerTransport does not listen for stdin end/close, so its
 * transport.close() (and thus server.server.onclose) never fires on a client
 * disconnect — relying on onclose alone would leave the process to exit only via
 * Node's unsettled top-level-await drain (exit code 13 + a TLA warning). So we
 * also resolve on stdin's own end/close, the real end-of-session signal, and keep
 * the onclose path for an explicit server.close().
 */
export async function runMcpServer(opts: BuildMcpOptions = {}): Promise<void> {
  const server = buildTenjinMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
}

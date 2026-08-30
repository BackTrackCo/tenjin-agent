import { text } from 'node:stream/consumers';
import { CliError } from './errors';

/**
 * A command's opt-in access to stdin.
 *
 * This is deliberately a capability rather than a direct `process.stdin` read:
 * the CLI supplies it, while the stdio MCP server does not. Without that
 * boundary, an MCP `publish` call with no file could consume the transport that
 * carries the next JSON-RPC message and hang the whole server.
 */
export interface StdinInput {
  stream: NodeJS.ReadableStream;
  isTTY: boolean;
}

/** Read one complete UTF-8 Markdown document from stdin. */
export async function readMarkdownStdin(input: StdinInput): Promise<string> {
  let raw: string;
  try {
    raw = await text(input.stream);
  } catch (err) {
    throw new CliError('USAGE', 'Could not read Markdown from stdin.', {
      fix: 'Pipe a readable Markdown document into the command, or pass a Markdown file instead.',
      cause: err,
    });
  }
  // A bare command in a non-interactive environment commonly inherits
  // /dev/null. Treating that EOF as a document would carry an accidental empty
  // publish as far as the wallet before the ordinary body validation rejected
  // it. Refuse at the source edge instead, exactly like an unreadable source.
  if (raw.trim().length === 0) {
    throw new CliError('USAGE', 'No Markdown received on stdin.', {
      fix: 'Pipe a non-empty Markdown document into the command, or pass a Markdown file instead.',
    });
  }
  return raw;
}

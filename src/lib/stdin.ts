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

/**
 * The most stdin may carry. A published piece is prose an agent wrote, and
 * `MAX_GIT_FILE_BYTES` already bounds the largest single file the scan will read,
 * so a document past this is a misdirected pipe rather than a long answer.
 */
export const PUBLISH_STDIN_MAX_BYTES = 1024 * 1024;

/**
 * Read one complete UTF-8 Markdown document from stdin.
 *
 * Bounded DURING the read, not after it: `text(stream)` resolves only once the
 * whole stream is in memory, so a post-hoc length check would still have taken
 * the 50 MB before it could refuse. Chunks are counted as they arrive and the
 * read is abandoned at the first one that crosses the cap, which is also why
 * this does not use `node:stream/consumers`.
 */
export async function readMarkdownStdin(input: StdinInput): Promise<string> {
  let raw: string;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buf.length;
      if (bytes > PUBLISH_STDIN_MAX_BYTES) {
        throw new CliError('USAGE', 'Too much Markdown received on stdin.', {
          fix: `Publish at most ${PUBLISH_STDIN_MAX_BYTES} bytes on stdin. A larger document is usually a misdirected pipe; pass a Markdown file instead.`,
        });
      }
      chunks.push(buf);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    if (err instanceof CliError) throw err;
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

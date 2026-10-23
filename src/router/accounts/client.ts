import pkg from '../../../package.json';

/**
 * ONE SESSION WITH A CONNECTED ACCOUNT'S MCP SERVER, over the SDK's
 * streamable HTTP client. The SDK's client modules load only here, through a
 * dynamic import, so no hook chunk ever parses them (decided37 #16).
 *
 * The credential goes in the request headers and nowhere else. No
 * `authProvider` is given to the transport: it would refresh outside Tenjin's
 * lock and could start a browser sign-in from inside `tenjin mcp`. A 401 comes
 * back to the caller as {@link AccountRefused}, which decides what it means;
 * a 402 or 429 as {@link AccountLimited}, and arguments the server refused as
 * {@link AccountBadInput}.
 * The transport refuses a redirect to another origin, so a server cannot send
 * the credential elsewhere.
 */

/** One tool a server lists: its name, its untrusted description, the
 *  top-level arguments its input schema names, and that schema while it is
 *  small enough to show. */
export interface AccountTool {
  name: string;
  description?: string;
  arguments: string[];
  inputSchema?: Record<string, unknown>;
}

/** What one tool call answered, as the SDK parsed it. */
export interface AccountCallResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface AccountSession {
  listTools(): Promise<AccountTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<AccountCallResult>;
  close(): Promise<void>;
}

/** The server would not take the credential: HTTP 401 or 403. */
export class AccountRefused extends Error {
  constructor(readonly status: number) {
    super(`the server refused the credential (${status})`);
    this.name = 'AccountRefused';
  }
}

/** The account's plan or rate limit stopped the request: HTTP 402 or 429. */
export class AccountLimited extends Error {
  constructor(readonly status: 402 | 429) {
    super(`the server stopped the request (${status})`);
    this.name = 'AccountLimited';
  }
}

/** The server would not take the tool's arguments (JSON-RPC invalid params):
 *  the call did not run. `message` is the server's, untrusted. */
export class AccountBadInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountBadInput';
  }
}

export interface SessionDeps {
  /** The transport's fetch; tests pass a scripted one. */
  fetchImpl?: typeof fetch;
  /** Each request's own deadline. */
  timeoutMs?: number;
}

export type OpenAccountSession = (
  mcpUrl: string,
  headers: Record<string, string>,
  deps?: SessionDeps,
) => Promise<AccountSession>;

/** At most this many pages of `tools/list`: a server that pages forever is
 *  read no further. */
const MAX_TOOL_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

/** JSON-RPC's invalid params. */
const INVALID_PARAMS = -32602;
/** A schema past this many bytes is not kept: the agent reads the arguments. */
const MAX_SCHEMA_BYTES = 8 * 1024;

/** The SDK's error, as the one this module's callers read: an HTTP status
 *  (the transport's error carries it as `code`) or a JSON-RPC error code. */
function translated(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 401 || code === 403) return new AccountRefused(code);
  if (code === 402 || code === 429) return new AccountLimited(code);
  if (code === INVALID_PARAMS)
    return new AccountBadInput(err instanceof Error ? err.message : 'invalid arguments');
  return err;
}

function smallSchema(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const text = JSON.stringify(schema);
  return Buffer.byteLength(text, 'utf8') <= MAX_SCHEMA_BYTES
    ? (schema as Record<string, unknown>)
    : undefined;
}

export const openAccountSession: OpenAccountSession = async (mcpUrl, headers, deps = {}) => {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers },
    ...(deps.fetchImpl !== undefined ? { fetch: deps.fetchImpl } : {}),
  });
  const client = new Client({ name: 'tenjin', version: pkg.version }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout });
  } catch (err) {
    await client.close().catch(() => undefined);
    throw translated(err);
  }
  return {
    async listTools() {
      const tools: AccountTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const listed = await client
          .listTools(cursor !== undefined ? { cursor } : undefined, { timeout })
          .catch((err: unknown) => {
            throw translated(err);
          });
        for (const tool of listed.tools) {
          const properties = (tool.inputSchema as { properties?: unknown } | undefined)?.properties;
          const schema = smallSchema(tool.inputSchema);
          tools.push({
            name: tool.name,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
            arguments:
              properties !== null && typeof properties === 'object' ? Object.keys(properties) : [],
            ...(schema !== undefined ? { inputSchema: schema } : {}),
          });
        }
        cursor = listed.nextCursor;
        if (cursor === undefined) break;
      }
      return tools;
    },
    async callTool(name, args, opts = {}) {
      const result = await client
        .callTool({ name, arguments: args }, undefined, { timeout: opts.timeoutMs ?? timeout })
        .catch((err: unknown) => {
          throw translated(err);
        });
      return result as AccountCallResult;
    },
    async close() {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
};

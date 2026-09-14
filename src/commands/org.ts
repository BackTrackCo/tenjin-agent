import { z } from 'zod';
import { CliError } from '../lib/errors';
import { httpRequest } from '../lib/http';
import { assertConfiguredDeployment, resolveContextSettings } from '../lib/settings';
import { resolveWriteAuth } from '../lib/consent';
import { sanitizeForTerminal } from '../lib/output';
import { trimSlash } from '../lib/url';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { WriteAuth } from '../lib/session-key';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin org`: who is on this team's shelves, and whether their searches may
 * also reach the public marketplace.
 *
 * THERE IS NO `org create`. An operator provisions an org, its first admin and
 * its shelf in one transaction with database credentials
 * (`scripts/provision-org.ts`, shelves/02-server.md) and hands the admin a shelf
 * slug. A public creation route would be a self-serve product with no billing
 * behind it, so it does not exist.
 *
 * MEMBERSHIP IS KEYED ON THE CREATOR, NOT THE WALLET. `org add` sends one tagged
 * string — a `0x` address or a handle — and the server resolves it to a
 * `creators` row, minting one for a wallet that has only ever searched. The body
 * is `{ member }` on both sides and `src/contract.test.ts` pins it, so the two
 * repos cannot drift on the shape again.
 *
 * Exit codes: 0 success, 2 usage, 4 a write the server rejected (not an admin,
 * no such org).
 */

export interface OrgMemberArgs {
  /** A `0x` address or a handle. One tagged string; the server resolves it. */
  member: string;
  /** The org to act on; defaults to the one owning the active shelf. */
  org?: string;
}

export interface OrgPublicSearchArgs {
  on: boolean;
  org?: string;
}

export interface OrgDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  useSession?: boolean;
  env?: NodeJS.ProcessEnv;
}

const shelfSchema = z.object({ slug: z.string(), name: z.string().optional() });
const orgSchema = z.object({
  slug: z.string(),
  name: z.string().optional(),
  role: z.string().optional(),
  publicSearch: z.boolean().optional(),
  shelves: z.array(shelfSchema).default([]),
});
const orgListSchema = z.object({ orgs: z.array(orgSchema) });

export type Org = z.infer<typeof orgSchema>;

/**
 * `tenjin org list`: every org this wallet belongs to, its shelves, its
 * public-search policy, and which shelf is active on this machine.
 *
 * It is also the answer to a 404 from a shelf route, which never says whether
 * the slug was unknown or the wallet was not a member: this list is what the
 * wallet can actually reach.
 */
export async function runOrgList(ctx: CommandContext, deps: OrgDeps = {}): Promise<CommandResult> {
  const { settings, auth, client } = await connect(ctx, deps, 'read');
  const orgs = await getOrgs(auth, client);
  const active = settings.shelf;
  const humanLines: string[] =
    orgs.length === 0
      ? ['This wallet is in no org. An operator provisions one and adds your address.']
      : orgs.flatMap((org) => [
          `${sanitizeForTerminal(org.slug)}${org.role !== undefined ? ` (${sanitizeForTerminal(org.role)})` : ''}  public-search: ${org.publicSearch === false ? 'off' : 'on'}`,
          ...(org.shelves.length === 0
            ? ['  (no shelves)']
            : org.shelves.map(
                (sh) =>
                  `  ${sanitizeForTerminal(sh.slug)}${sh.slug === active ? '  <- active' : ''}`,
              )),
        ]);
  if (orgs.length > 0 && active === null) {
    humanLines.push('No active shelf on this machine. Set one with `tenjin shelf use <slug>`.');
  }
  return { data: { orgs, activeShelf: active }, humanLines };
}

/** `tenjin org add <handle|0x>`. Admin only; the server decides that. */
export async function runOrgAdd(
  args: OrgMemberArgs,
  ctx: CommandContext,
  deps: OrgDeps = {},
): Promise<CommandResult> {
  const member = assertMember(args.member);
  const { auth, client } = await connect(ctx, deps, 'read+write');
  const org = await resolveOrg(args.org, auth, client, ctx);
  await writeMember('POST', org, member, auth, client);
  return {
    data: { org, member, added: true },
    humanLines: [`Added ${sanitizeForTerminal(member)} to ${sanitizeForTerminal(org)}.`],
  };
}

/** `tenjin org remove <handle|0x>`. Admin only; the server decides that. */
export async function runOrgRemove(
  args: OrgMemberArgs,
  ctx: CommandContext,
  deps: OrgDeps = {},
): Promise<CommandResult> {
  const member = assertMember(args.member);
  const { auth, client } = await connect(ctx, deps, 'read+write');
  const org = await resolveOrg(args.org, auth, client, ctx);
  await writeMember('DELETE', org, member, auth, client);
  return {
    data: { org, member, removed: true },
    humanLines: [`Removed ${sanitizeForTerminal(member)} from ${sanitizeForTerminal(org)}.`],
  };
}

/**
 * `tenjin org set public-search on|off`. Admin only.
 *
 * THIS IS THE ORG'S POLICY FOR EVERYONE, and it is a different thing from
 * `team.publicFallback`, which is this machine's own preference. The server's
 * `false` wins: a member who asks for public anyway just gets `public: null`
 * back, indistinguishably from having asked for nothing.
 */
export async function runOrgSetPublicSearch(
  args: OrgPublicSearchArgs,
  ctx: CommandContext,
  deps: OrgDeps = {},
): Promise<CommandResult> {
  const { auth, client } = await connect(ctx, deps, 'read+write');
  const org = await resolveOrg(args.org, auth, client, ctx);
  const url = `${trimSlash(client.baseUrl)}/api/orgs/${encodeURIComponent(org)}`;
  await send('PATCH', url, { publicSearch: args.on }, auth, client);
  return {
    data: { org, publicSearch: args.on },
    humanLines: [
      `Public search is ${args.on ? 'on' : 'off'} for ${sanitizeForTerminal(org)}. Each member's \`team.publicFallback\` decides within it.`,
    ],
  };
}

/** A `0x` address or a handle, checked at the edge so a typo costs no signature. */
function assertMember(raw: string): string {
  const member = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(member)) return member;
  if (/^[a-z0-9-]{2,32}$/.test(member)) return member;
  throw new CliError('USAGE', `Not a member: ${JSON.stringify(raw)}`, {
    fix: 'Pass a 0x wallet address or a handle (2-32 chars of a-z, 0-9 or -).',
  });
}

interface Client {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * The `profile.ts` shape: pin the origin, resolve the wallet, surface
 * WALLET_MISSING with its own fix, then sign through the same session-key auth
 * every other write uses. Exported because `shelf use` signs the same way and
 * must not grow a second copy of the pin.
 */
export async function connect(ctx: CommandContext, deps: OrgDeps, scope: 'read' | 'read+write') {
  const env = deps.env ?? process.env;
  const settings = await resolveContextSettings(ctx);
  // THE PIN COMES FIRST, before the keystore is opened and before anything is
  // signed: `--base-url` and `TENJIN_BASE_URL` ride every leaf command, and an
  // agent that names a host must not thereby move the deployment this machine
  // delegates a session to. `read` has held this rule since #218; these verbs
  // wallet-sign too, so they hold it as well.
  assertConfiguredDeployment(settings);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider);
  const signer = await provider.getSigner();
  const auth = resolveWriteAuth({
    signer,
    baseUrl: settings.baseUrl,
    dataDir: ctx.dataDir,
    scope,
    ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
    env,
  });
  const client: Client = {
    baseUrl: settings.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return { settings, auth, client };
}

export async function getOrgs(auth: WriteAuth, client: Client): Promise<Org[]> {
  const url = `${trimSlash(client.baseUrl)}/api/orgs`;
  const json = await send('GET', url, undefined, auth, client);
  const parsed = orgListSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError('CONTRACT_MISMATCH', `${url} did not return an org list`, {
      fix: 'Update tenjin-cli; the server contract may have changed.',
      details: parsed.error.issues,
    });
  }
  return parsed.data.orgs;
}

/**
 * Which org a member write lands on: `--org` when given, otherwise the org that
 * owns the ACTIVE SHELF. A wallet in exactly one org is the whole expected case,
 * so the default is almost always the only answer; naming it explicitly is what
 * keeps a second org from ever being written to by accident.
 */
async function resolveOrg(
  given: string | undefined,
  auth: WriteAuth,
  client: Client,
  ctx: CommandContext,
): Promise<string> {
  if (given !== undefined) return given;
  const settings = await resolveContextSettings(ctx);
  const orgs = await getOrgs(auth, client);
  if (orgs.length === 0) {
    throw new CliError('USAGE', 'This wallet is in no org.', {
      fix: 'An operator provisions the org and adds your address; `tenjin profile` prints it.',
    });
  }
  const owning =
    settings.shelf === null
      ? undefined
      : orgs.find((org) => org.shelves.some((sh) => sh.slug === settings.shelf));
  if (owning !== undefined) return owning.slug;
  if (orgs.length === 1) return orgs[0]!.slug;
  throw new CliError('USAGE', 'More than one org and no active shelf to pick one.', {
    fix: `Pass --org <slug>: ${orgs.map((o) => o.slug).join(', ')}.`,
  });
}

async function writeMember(
  method: 'POST' | 'DELETE',
  org: string,
  member: string,
  auth: WriteAuth,
  client: Client,
): Promise<void> {
  const url = `${trimSlash(client.baseUrl)}/api/orgs/${encodeURIComponent(org)}/members`;
  await send(method, url, { member }, auth, client);
}

/**
 * One signed request, with the CLI's error contract over the server's answer.
 *
 * A rejection is exit 4 (`PUBLISH_FAILED`), the class every other server-refused
 * write in this CLI uses, and it carries the server's own message: "not an
 * admin" and "no such org" are the server's to say, and paraphrasing them here
 * would be a second copy of a rule that lives there.
 */
async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body: unknown,
  auth: WriteAuth,
  client: Client,
): Promise<unknown> {
  // THE SIGNED METHOD IS THE SENT METHOD. RFC 9421 covers `@method`, so signing
  // a PATCH as a PUT would produce a signature the server cannot verify; the
  // signable union carries PATCH for exactly this route.
  const headers = await auth.headersFor(
    body === undefined
      ? { method: method === 'GET' ? 'GET' : 'DELETE', url }
      : { method, url, body: JSON.stringify(body) },
  );
  const res = await httpRequest(url, {
    method,
    timeoutMs: client.timeoutMs,
    headers,
    ...(body !== undefined ? { jsonBody: body } : {}),
    ...(client.fetchImpl !== undefined ? { fetchImpl: client.fetchImpl } : {}),
  });
  if (!res.ok) {
    throw new CliError('API_UNREACHABLE', `${url}: ${res.message}`, {
      fix: 'Check your network and the configured base URL (`tenjin config get baseUrl`), then retry.',
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError(
      'PUBLISH_FAILED',
      serverMessage(res.json) ?? `${url} answered ${res.status}`,
      {
        fix:
          res.status === 403
            ? 'Only an org admin can change members or the public-search policy.'
            : res.status === 404
              ? 'Check the org slug with `tenjin org list`.'
              : 'Retry; if it persists the route may be unavailable.',
        details: res.json,
      },
    );
  }
  return res.json;
}

function serverMessage(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const rec = json as Record<string, unknown>;
  if (typeof rec.error === 'string') return rec.error;
  if (typeof rec.error === 'object' && rec.error !== null) {
    const m = (rec.error as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return typeof rec.message === 'string' ? rec.message : undefined;
}

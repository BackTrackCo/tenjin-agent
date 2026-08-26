import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { resolveWriteAuth } from '../lib/consent';
import {
  getMe,
  PROFILE_BIO_MAX,
  PROFILE_DISPLAY_NAME_MAX,
  PROFILE_HANDLE_RE,
  updateMe,
  type CreatorProfile,
  type MeResponse,
} from '../lib/posts-api';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { atomicToUsd } from '../lib/money';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin profile`: show the publisher profile behind this wallet.
 * `tenjin profile set --handle <h> [--display-name <s>] [--bio <s>]`: claim or
 * rename the word-handle and set the name/bio that bylines and the desk show,
 * so a CLI-only publisher is not listed under a bare 0x address.
 *
 * Thin verbs over `GET`/`PUT /api/me` (tenjin-agent#208), riding the same
 * session-key auth `publish` and `edit` use: a show mints a read-scoped session,
 * a set mints `read+write`; a cached wider session serves both without a wallet
 * prompt. The server merges, so an omitted flag keeps its stored value. No
 * consent gate: this is an operator-invoked account edit, not content.
 *
 * Exit codes: 0 success, 2 usage (set with no flags / an empty value), 1 a read
 * failure, 4 a write the server rejected (a taken or reserved handle).
 */

export interface ProfileSetArgs {
  handle?: string;
  displayName?: string;
  bio?: string;
}

export interface ProfileDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  useSession?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function runProfileShow(
  ctx: CommandContext,
  deps: ProfileDeps = {},
): Promise<CommandResult> {
  const { auth, client } = await connect(ctx, deps, 'read');
  const me = await getMe(auth, client);
  return receipt(me, 'show');
}

export async function runProfileSet(
  args: ProfileSetArgs,
  ctx: CommandContext,
  deps: ProfileDeps = {},
): Promise<CommandResult> {
  // Every flag check runs before the wallet: a typo must cost no signature.
  const given = (['handle', 'displayName', 'bio'] as const).filter((k) => args[k] !== undefined);
  if (given.length === 0) {
    throw new CliError('USAGE', 'Nothing to set.', {
      fix: 'Pass at least one of --handle, --display-name, --bio.',
    });
  }
  for (const key of given) {
    if (args[key]?.trim() === '') {
      throw new CliError('USAGE', `--${flagName(key)} cannot be empty.`, {
        fix: 'Pass a value, or omit the flag to keep the stored one.',
      });
    }
  }
  // The server's own bounds, applied here so a bad value never reaches the
  // wallet: a PUT burns a single-use nonce even when it comes back 400.
  if (args.handle !== undefined && !PROFILE_HANDLE_RE.test(args.handle)) {
    throw new CliError('USAGE', `Invalid handle: ${JSON.stringify(args.handle)}`, {
      fix: 'A handle is 2-32 characters of a-z, 0-9, or - (lowercase, no spaces).',
    });
  }
  if (args.displayName !== undefined && args.displayName.length > PROFILE_DISPLAY_NAME_MAX) {
    throw new CliError('USAGE', `--display-name is over ${PROFILE_DISPLAY_NAME_MAX} characters.`, {
      fix: 'Shorten the display name.',
    });
  }
  if (args.bio !== undefined && args.bio.length > PROFILE_BIO_MAX) {
    throw new CliError('USAGE', `--bio is over ${PROFILE_BIO_MAX} characters.`, {
      fix: 'Shorten the bio.',
    });
  }
  const { auth, client } = await connect(ctx, deps, 'read+write');
  const me = await updateMe(
    {
      ...(args.handle !== undefined ? { handle: args.handle } : {}),
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
      ...(args.bio !== undefined ? { bio: args.bio } : {}),
    },
    auth,
    client,
  );
  return receipt(me, 'set');
}

async function connect(ctx: CommandContext, deps: ProfileDeps, scope: 'read' | 'read+write') {
  const env = deps.env ?? process.env;
  const runtime = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // surfaces WALLET_MISSING with its own fix
  const signer = await provider.getSigner();
  const auth = resolveWriteAuth({
    signer,
    baseUrl: runtime.baseUrl,
    dataDir: ctx.dataDir,
    scope,
    ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
    env,
  });
  const client = {
    baseUrl: runtime.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(runtime.bypass !== undefined ? { bypass: runtime.bypass } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return { auth, client };
}

function flagName(key: 'handle' | 'displayName' | 'bio'): string {
  return key === 'displayName' ? 'display-name' : key;
}

function receipt(me: MeResponse, what: 'show' | 'set'): CommandResult {
  const c = me.creator;
  const data = {
    address: me.address,
    profile: c === null ? null : pick(c),
    ...(me.warnings !== undefined && me.warnings.length > 0 ? { warnings: me.warnings } : {}),
  };
  const humanLines: string[] = [];
  if (c === null) {
    humanLines.push(
      `No profile yet for ${me.address}. Run \`tenjin profile set --handle <handle>\` to claim one.`,
    );
  } else {
    humanLines.push(what === 'set' ? 'Profile updated.' : `Profile for ${me.address}`);
    humanLines.push(`  handle:        ${orNone(c.handle, '(none — shown as your address)')}`);
    humanLines.push(`  display name:  ${orNone(c.displayName)}`);
    humanLines.push(`  bio:           ${orNone(c.bio)}`);
    humanLines.push(`  default price: $${atomicToUsd(c.defaultPrice)}`);
  }
  for (const w of me.warnings ?? []) humanLines.push(`Note: ${w}`);
  return { data, humanLines };
}

/** The server stores '' for an unset name/bio and null for an unclaimed handle; both read as unset. */
function orNone(value: string | null | undefined, none = '(none)'): string {
  return value === undefined || value === null || value === '' ? none : value;
}

function pick(c: CreatorProfile) {
  // Omitted and null both mean "not set"; the envelope says null for either.
  return {
    handle: c.handle ?? null,
    displayName: c.displayName ?? null,
    bio: c.bio ?? null,
    defaultPrice: c.defaultPrice,
    walletAddress: c.walletAddress,
  };
}

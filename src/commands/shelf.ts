import { CliError } from '../lib/errors';
import { CONFIG_DEFAULTS, RawConfigSchema, loadRawConfig } from '../lib/config';
import { configPath } from '../lib/paths';
import { writeFileAtomic } from '../lib/atomic-json';
import { sanitizeForTerminal } from '../lib/output';
import { getOrgs, type OrgDeps } from './org';
import { resolveContextSettings } from '../lib/settings';
import { resolveWriteAuth } from '../lib/consent';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin shelf use <slug>`: which shelf this machine's publishes and lookups
 * go to, or `--none` for the public marketplace alone.
 *
 * THERE IS NO `shelf create`. A wallet with exactly one shelf is the whole
 * expected case: `tenjin org list` names it and this sets it. There is no
 * multi-shelf UX beyond that (shelves/07-build-shelf-cli.md).
 *
 * VALIDATED BEFORE IT IS WRITTEN, against the shelves the wallet can actually
 * see. The shelf search route answers 404 for a slug that does not exist and for
 * one this wallet is not a member of, indistinguishably, so a typo persisted
 * here would look exactly like a membership problem on every later lookup.
 */

export interface ShelfUseArgs {
  slug?: string;
  /** Clear the active shelf. `config set shelf ""` cannot express this, because
   *  the slug regex has no empty form. */
  none?: boolean;
}

export async function runShelfUse(
  args: ShelfUseArgs,
  ctx: CommandContext,
  deps: OrgDeps = {},
): Promise<CommandResult> {
  if (args.none === true) {
    if (args.slug !== undefined) {
      throw new CliError('USAGE', 'Pass a slug or --none, not both.', {
        fix: 'Run `tenjin shelf use <slug>` to set one, or `tenjin shelf use --none` to clear it.',
      });
    }
    await persistShelf(ctx.dataDir, null);
    return {
      data: { shelf: null },
      humanLines: ['Active shelf cleared. Lookups and publishes go to the public marketplace.'],
    };
  }
  const slug = args.slug?.trim() ?? '';
  if (!/^[a-z0-9-]{2,32}$/.test(slug)) {
    throw new CliError('USAGE', `Not a shelf slug: ${JSON.stringify(args.slug ?? '')}`, {
      fix: 'A slug is 2 to 32 characters of a-z, 0-9 or hyphen. `tenjin org list` names the ones you can use.',
    });
  }

  const env = deps.env ?? process.env;
  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider);
  const auth = resolveWriteAuth({
    signer: await provider.getSigner(),
    baseUrl: settings.baseUrl,
    dataDir: ctx.dataDir,
    scope: 'read',
    ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
    env,
  });
  const orgs = await getOrgs(auth, {
    baseUrl: settings.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const reachable = orgs.flatMap((org) => org.shelves.map((sh) => sh.slug));
  if (!reachable.includes(slug)) {
    throw new CliError('USAGE', `This wallet cannot reach a shelf called "${slug}".`, {
      fix:
        reachable.length === 0
          ? 'This wallet is in no org. An operator provisions one and adds your address.'
          : `Pick one of: ${reachable.join(', ')}.`,
    });
  }
  await persistShelf(ctx.dataDir, slug);
  return {
    data: { shelf: slug },
    humanLines: [
      `Active shelf is ${sanitizeForTerminal(slug)}. Publishes go there free, and lookups ask it first.`,
    ],
  };
}

/**
 * Merge the one key into the raw file, never materializing defaults for keys the
 * operator did not set, so `config` provenance stays truthful. 0600 like every
 * other writer of this file.
 */
async function persistShelf(dir: string, shelf: string | null): Promise<void> {
  const existing = await loadRawConfig(dir);
  const merged = RawConfigSchema.parse({ ...existing, shelf: shelf ?? CONFIG_DEFAULTS.shelf });
  await writeFileAtomic(configPath(dir), `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

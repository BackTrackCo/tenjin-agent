import { CliError } from '../lib/errors';
import { CONFIG_DEFAULTS, RawConfigSchema, loadRawConfig } from '../lib/config';
import { HANDLE_RE, QUALIFIED_SHELF_RE } from '../lib/ids';
import { configPath } from '../lib/paths';
import { writeFileAtomic } from '../lib/atomic-json';
import { sanitizeForTerminal } from '../lib/output';
import { connect, getOrgs, type OrgDeps, type Org } from './org';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin shelf use <org/shelf>` or `tenjin shelf use <shelf>`: which shelf this
 * machine's publishes and lookups go to, or `--none` for the public marketplace
 * alone.
 *
 * THERE IS NO `shelf create`. A wallet with exactly one shelf is the whole
 * expected case: `tenjin org list` names it and this sets it. There is no
 * multi-shelf UX beyond that (shelves/07-build-shelf-cli.md).
 *
 * WHAT IS STORED IS ALWAYS QUALIFIED. The shelf rides in the request body now
 * rather than in a route segment, so `notes` alone names a different shelf in
 * every org that has one. This command is the one place that may resolve a bare
 * name, because it is the one place that asks the server which shelves this
 * wallet can reach: exactly one match is stored as `<org>/<shelf>`, several is a
 * refusal that lists them, and none is a refusal that lists what there is.
 *
 * VALIDATED BEFORE IT IS WRITTEN, against the shelves the wallet can actually
 * see. A search naming a shelf answers 404 for one that does not exist and for
 * one this wallet is not a member of, indistinguishably, so a typo persisted
 * here would look exactly like a membership problem on every later lookup.
 */

export interface ShelfUseArgs {
  slug?: string;
  /** Clear the active shelf. `config set shelf ""` cannot express this, because
   *  the name regex has no empty form. */
  none?: boolean;
}

export async function runShelfUse(
  args: ShelfUseArgs,
  ctx: CommandContext,
  deps: OrgDeps = {},
): Promise<CommandResult> {
  if (args.none === true) {
    if (args.slug !== undefined) {
      throw new CliError('USAGE', 'Pass a shelf or --none, not both.', {
        fix: 'Run `tenjin shelf use <org/shelf>` to set one, or `tenjin shelf use --none` to clear it.',
      });
    }
    await persistShelf(ctx.dataDir, null);
    return {
      data: { shelf: null },
      humanLines: ['Active shelf cleared. Lookups and publishes go to the public marketplace.'],
    };
  }
  const given = args.slug?.trim() ?? '';
  const qualified = QUALIFIED_SHELF_RE.test(given);
  if (!qualified && !HANDLE_RE.test(given)) {
    throw new CliError('USAGE', `Not a shelf: ${JSON.stringify(args.slug ?? '')}`, {
      fix: 'Pass "<org>/<shelf>", or a bare shelf name to resolve against your orgs. Each half is 2 to 32 characters of a-z, 0-9 or hyphen; `tenjin org list` names the ones you can use.',
    });
  }

  // `org.ts`'s own connect, not a copy of it: the origin pin, the wallet and
  // the session auth are one decision, and a second spelling of it here is how
  // one of the three eventually goes missing.
  const { auth, client } = await connect(ctx, deps, 'read');
  const orgs = await getOrgs(auth, client);
  const reachable = qualifiedNames(orgs);
  const matches = qualified
    ? reachable.filter((name) => name === given)
    : reachable.filter((name) => name.endsWith(`/${given}`));
  if (matches.length === 0) {
    throw new CliError('USAGE', `This wallet cannot reach a shelf called "${given}".`, {
      fix:
        reachable.length === 0
          ? 'This wallet is in no org. An operator provisions one and adds your address.'
          : `Pick one of: ${reachable.join(', ')}.`,
    });
  }
  if (matches.length > 1) {
    // AMBIGUOUS IS A REFUSAL, never a pick. Two orgs may each own a `notes`, and
    // guessing one would silently send this machine's questions to the wrong
    // team's shelf for as long as nobody noticed.
    throw new CliError('USAGE', `"${given}" names more than one shelf this wallet can reach.`, {
      fix: `Name the org too: ${matches.join(', ')}.`,
    });
  }
  const resolved = matches[0]!;
  await persistShelf(ctx.dataDir, resolved);
  return {
    data: { shelf: resolved },
    humanLines: [
      `Active shelf is ${sanitizeForTerminal(resolved)}. Publishes go there free, and lookups ask it first.`,
    ],
  };
}

/** Every shelf this wallet can reach, as the qualified names the wire speaks. */
function qualifiedNames(orgs: Org[]): string[] {
  return orgs.flatMap((org) => org.shelves.map((sh) => `${org.slug}/${sh.slug}`));
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

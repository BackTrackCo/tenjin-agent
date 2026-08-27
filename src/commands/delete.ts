import { CliError } from '../lib/errors';
import { UUID_RE } from '../lib/ids';
import { toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { promptYesNo } from '../lib/prompt';
import { resolveContextSettings } from '../lib/settings';
import { resolveWriteAuth } from '../lib/consent';
import { deletePost, getOwnPost, type OwnPost } from '../lib/posts-api';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin delete <postId>`: take back a piece this wallet published, through the
 * owner-scoped soft-delete at `DELETE /api/posts/<id>`. It is the missing half of
 * a CLI that could publish unattended and never retract (#221), and it reuses
 * `edit`'s signing path exactly: the same session-key write auth, the same
 * owner-scoped GET first, the same bounded 401 recovery underneath.
 *
 * IT CONFIRMS IN EVERY MODE, AND `publish.mode` IS NEVER READ HERE. That is the
 * whole consent design and not an oversight: the mode is consent to PUBLISH, said
 * once so an agent need not ask twice about putting content up. It says nothing
 * about destroying content, and reading it as a standing yes for a delete would
 * turn one operator decision into authority over a different, irreversible one.
 * So `full-auto` confirms exactly as `review` does.
 *
 * The two confirmation surfaces are the ones this CLI already has, not a third:
 * at a real TTY it asks y/N inline, and everywhere else (an agent, a pipe, the
 * MCP server) it refuses with NEEDS_CONFIRMATION and the exit-3 payload
 * `publish` and `edit` already use, which the caller answers by re-running with
 * `--yes`. There is deliberately no interactive re-prompt on the headless path:
 * exit 3 IS the confirmation channel an MCP client can answer, and a second one
 * would be a consent surface only the terminal could reach.
 *
 * Exit codes: 0 deleted, 2 usage, 3 needs_confirmation or a declined prompt, 4 a
 * delete the server refused after the operator confirmed it.
 */

export interface DeleteArgs {
  /** The post uuid to delete. */
  postId: string;
  /** Confirm non-interactively. Required whenever there is no TTY to ask at. */
  yes?: boolean;
}

export interface DeleteDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  /** Force the plain-SIWX write path (default: session key unless TENJIN_NO_SESSION=1). */
  useSession?: boolean;
  /** Environment seam (base-url, TENJIN_NO_SESSION); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Interactive-confirm seam; defaults to a TTY y/N prompt (send's shape). */
  confirm?: (prompt: string) => Promise<boolean>;
}

export async function runDelete(
  args: DeleteArgs,
  ctx: CommandContext,
  deps: DeleteDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;

  if (!UUID_RE.test(args.postId)) {
    throw new CliError('USAGE', `Invalid post id: ${JSON.stringify(args.postId)}`, {
      fix: 'Pass the post uuid from `tenjin publish`’s receipt or your desk.',
    });
  }

  // Whether this run has any way to ASK. It gates the confirmation branch below;
  // it deliberately does not decide the credential, because being able to ask is
  // not the same as being told yes.
  const canConfirm = deps.confirm !== undefined || (ctx.io.isTTY && process.stdin.isTTY);

  const runtime = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // surfaces WALLET_MISSING with its own fix
  // The ONE keystore touch: the passphrase is resolved here, once, and both
  // scopes below sign with this same in-memory signer. That is what makes the
  // two-phase mint cheap — see sessionAt.
  const signer = await provider.getSigner();
  /**
   * A delegation at exactly `scope`. Called at most twice, and the split is the
   * point: NO REFUSED DELETE MAY LEAVE A WRITE CREDENTIAL BEHIND.
   *
   * The read that the confirmation is built from happens before anyone has
   * approved anything, so it is minted `read`. Only an actual approval mints
   * `read+write`, which means a headless refusal AND a human's "no" both end
   * with nothing on disk but a read-scoped session. Keying this on the ability
   * to prompt instead would grant the credential for being asked rather than for
   * answering, which is the same conflation in a smaller place.
   *
   * The upgrade is nearly free, and not in a hand-waved way: `establishSession`
   * makes no network call and opens no keystore. It generates a P-256 keypair and
   * signs one message with the signer already resolved above, so the extra cost
   * on an approved delete is one silent in-memory signature, on the path where
   * the user has just said yes and expects the write. Every other path pays
   * nothing: `--yes` asks for `read+write` first and reuses it, and a cached
   * `read+write` satisfies the `read` phase through `scopeSatisfies`.
   */
  const sessionAt = (scope: 'read' | 'read+write'): ReturnType<typeof resolveWriteAuth> =>
    resolveWriteAuth({
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

  // Read first, for edit's reason: nobody can approve the destruction of a post
  // they have only seen the uuid of. The read changes nothing and burns no nonce,
  // and a wrong id fails here as RESOURCE_NOT_FOUND rather than being confirmed.
  // `--yes` is the one case where the approval predates the read, so it is also
  // the one case where this phase may ask for the wider scope.
  const stored = await getOwnPost(
    args.postId,
    sessionAt(args.yes === true ? 'read+write' : 'read'),
    client,
  );
  const summary = describePost(stored);
  for (const line of summary) ctx.io.stderr.write(`${line}\n`);

  if (args.yes !== true) {
    if (!canConfirm) {
      throw new CliError('NEEDS_CONFIRMATION', confirmMessage(stored), {
        fix: 'Show the user what would be removed, then re-run with --yes on an explicit yes. `tenjin edit <postId> --status draft` unpublishes instead, and is reversible.',
        details: {
          // args.postId, NOT stored.id, in every command-shaped member below:
          // the input id passed UUID_RE at the top, and building the copy-paste
          // strings from it means a server echo can never smuggle a flag into
          // them even if the response schema loosens. The read already proved
          // the two ids name the same post.
          postId: args.postId,
          title: sanitizeForTerminal(stored.title),
          status: sanitizeForTerminal(stored.status),
          url: sanitizeForTerminal(stored.url),
          summary,
          irreversible: true,
          // Named rather than described: the payload is what an agent hands the
          // user, and #221 is a report of an agent inventing a command instead.
          confirmCommand: `tenjin delete ${args.postId} --yes`,
          reversibleAlternative: `tenjin edit ${args.postId} --status draft`,
        },
      });
    }
    const approved = await askToDelete(ctx, deps, stored);
    if (!approved) {
      throw new CliError('REFUSED', 'Delete not confirmed; nothing was removed.', {
        fix: 'Re-run with --yes to remove the piece, or `tenjin edit <postId> --status draft` to unpublish it reversibly.',
        details: { postId: args.postId, title: sanitizeForTerminal(stored.title) },
      });
    }
  }

  // Past every refusal, so this is the first point at which a write credential is
  // justified. On the interactive path it mints one now; on `--yes` the phase
  // above already did, and this reuses it rather than signing twice.
  await deletePost(args.postId, sessionAt('read+write'), client);
  return receipt(args.postId, stored);
}

/**
 * The confirmation prompt's body, and the stderr summary that precedes the
 * headless refusal. It carries what a human needs to recognize the piece —
 * status included, because a draft and a live post are very different things to
 * lose — and the url, because that is what the operator would go and look at.
 */
function describePost(post: OwnPost): string[] {
  const price = toMoney(post.price);
  return [
    `Delete ${sanitizeForTerminal(post.title)} (${sanitizeForTerminal(post.status)}), ${price.usd} USD`,
    `url: ${sanitizeForTerminal(post.url)}`,
    'This removes the piece from the marketplace and cannot be undone from the CLI.',
  ];
}

async function askToDelete(ctx: CommandContext, deps: DeleteDeps, post: OwnPost): Promise<boolean> {
  const prompt = `${describePost(post).join('\n')}\nDelete it? [y/N] `;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  return promptYesNo(prompt);
}

function confirmMessage(post: OwnPost): string {
  return `Delete needs confirmation: ${sanitizeForTerminal(post.title)} (${sanitizeForTerminal(post.status)}) would be removed.`;
}

/**
 * The delete receipt. `deleted: true` is the machine signal, and the identity
 * fields are echoed from the pre-delete read because after the write there is
 * nothing left on the server to name the thing that is gone. The id is the
 * caller's own validated input, for the same reason the refusal payload's is.
 */
function receipt(postId: string, post: OwnPost): CommandResult {
  return {
    data: {
      deleted: true,
      postId,
      title: post.title,
      status: post.status,
      url: post.url,
    },
    humanLines: [
      `Deleted ${sanitizeForTerminal(post.title)} (was ${sanitizeForTerminal(post.status)}) → ${sanitizeForTerminal(post.url)} is gone.`,
    ],
  };
}

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

  // Whether this run has ANY way to reach the delete, settled from the flags and
  // the streams alone, before the wallet is touched. It decides two things, and
  // it must decide both the same way or they contradict each other.
  const canConfirm = deps.confirm !== undefined || (ctx.io.isTTY && process.stdin.isTTY);
  const canWrite = args.yes === true || canConfirm;

  const runtime = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // surfaces WALLET_MISSING with its own fix
  const signer = await provider.getSigner();
  // LEAST PRIVILEGE, and the reason it is not simply `read+write`: the common
  // call is an agent's FIRST one, with no --yes and no TTY, and that run is
  // structurally incapable of deleting anything — it exists to render the
  // payload and exit 3. Minting `read+write` for it would leave a write-capable
  // delegation on disk as the side effect of a refusal, which later writes then
  // reuse with no wallet signature. So the scope is what this run can actually
  // do. It costs nothing when the run CAN write: `scopeSatisfies` lets a cached
  // read+write serve a read, so no branch here signs more often than before.
  //
  // What this does not close, stated rather than papered over: a TTY run that
  // asks and is told no has already minted `read+write`, because the answer
  // arrives after the read that the question is built from. That delegation is
  // no broader than the one `publish` or `edit` leaves on the same machine, and
  // the alternative — mint `read`, then upgrade on yes — costs a second wallet
  // signature mid-command on the one path a human is standing at.
  const auth = resolveWriteAuth({
    signer,
    baseUrl: runtime.baseUrl,
    dataDir: ctx.dataDir,
    scope: canWrite ? 'read+write' : 'read',
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
  const stored = await getOwnPost(args.postId, auth, client);
  const summary = describePost(stored);
  for (const line of summary) ctx.io.stderr.write(`${line}\n`);

  if (args.yes !== true) {
    if (!canConfirm) {
      throw new CliError('NEEDS_CONFIRMATION', confirmMessage(stored), {
        fix: 'Show the user what would be removed, then re-run with --yes on an explicit yes. `tenjin edit <postId> --status draft` unpublishes instead, and is reversible.',
        details: {
          postId: stored.id,
          title: sanitizeForTerminal(stored.title),
          status: sanitizeForTerminal(stored.status),
          url: sanitizeForTerminal(stored.url),
          summary,
          irreversible: true,
          // Named rather than described: the payload is what an agent hands the
          // user, and #221 is a report of an agent inventing a command instead.
          confirmCommand: `tenjin delete ${stored.id} --yes`,
          reversibleAlternative: `tenjin edit ${stored.id} --status draft`,
        },
      });
    }
    const approved = await askToDelete(ctx, deps, stored);
    if (!approved) {
      throw new CliError('REFUSED', 'Delete not confirmed; nothing was removed.', {
        fix: 'Re-run with --yes to remove the piece, or `tenjin edit <postId> --status draft` to unpublish it reversibly.',
        details: { postId: stored.id, title: sanitizeForTerminal(stored.title) },
      });
    }
  }

  await deletePost(args.postId, auth, client);
  return receipt(stored);
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
 * nothing left on the server to name the thing that is gone.
 */
function receipt(post: OwnPost): CommandResult {
  return {
    data: {
      deleted: true,
      postId: post.id,
      title: post.title,
      status: post.status,
      url: post.url,
    },
    humanLines: [
      `Deleted ${sanitizeForTerminal(post.title)} (was ${sanitizeForTerminal(post.status)}) → ${sanitizeForTerminal(post.url)} is gone.`,
    ],
  };
}

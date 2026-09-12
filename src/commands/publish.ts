import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings, shelfRouteFor } from '../lib/settings';
import { parsePublishModeFlag } from '../lib/config';
import {
  getStoredSearch,
  linkSearchesToDraft,
  markSearchResolved,
  type StoredSearch,
} from '../lib/searches';
import { findings as scanFindings, type Finding, type ReportScope } from '../lib/redact';
import { headingOutline } from '../lib/markdown';
import { sanitizeForTerminal, sanitizeWireText } from '../lib/output';
import { trimSlash } from '../lib/url';
import {
  cardEligibilityTokens,
  deriveCard,
  localCardEligibility,
  missingSentences,
  parseFrontmatter,
  type Frontmatter,
  type ResourceCardInput,
} from '../lib/card';
import {
  publishPost,
  normalizeSearchIds,
  EXCERPT_MAX_LENGTH,
  PUBLISH_STATUSES,
  type PublishInput,
  type PostKeyInput,
  type PostKeyKind,
  POST_KEY_KINDS,
  normalizePostKeys,
  type PublishStatus,
} from '../lib/posts-api';
import {
  dedupeFindings,
  needsConfirmation,
  publicFinding,
  resolveWriteAuth,
  throughScanGate,
  writeModeNotices,
} from '../lib/consent';
import { publishedUrlFor, recordPublished } from '../lib/publish-dedup';
import { scanNoteLines, scanReceipt } from '../lib/scan-gate';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { AGENT_ID_RE } from '../lib/grade';
import { withLoopDb } from '../lib/loop-db';
import { readMarkdownStdin, type StdinInput } from '../lib/stdin';
import { readRegularUtf8File } from '../lib/regular-file';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin publish <file>`: the ONE way a finding reaches a shelf.
 *
 * A FINDING IS A PUBLISH DOCUMENT — frontmatter (`title` plus the answer-card
 * keys) then body — and that is the only shape there is. This command reads it,
 * VALIDATES IT WHOLE, runs the deterministic scan (every mode), gates on the
 * D38 consent cascade, then writes via the session key (minted on first use) or
 * the plain-SIWX fallback and returns a compact receipt. The ordering is the
 * point and is enforced here: shape, then scan and consent, BEFORE any wallet
 * touch or network write.
 *
 * VALIDATE-BEFORE-WRITE IS THE PREVIEW. There is no `--dry-run`, because a
 * command that refuses an unpublishable document by name — the title it has no
 * way to derive, the frontmatter keys its answer card is missing — before a
 * shelf, a wallet or a dedup row is touched has already told the caller
 * everything a preview was for, from one code path instead of two.
 *
 * AND THE CLI FILLS NOTHING CONTENT-BEARING. Every published word is the
 * author's: the title is `title:` or the body's own `# ` heading, the card is
 * frontmatter keys, and nothing here derives, prefills or generates any of it.
 *
 * Exit codes: 0 success, 2 usage (an unpublishable document included), 3
 * needs_confirmation (or the marketplace's own publish_blocked on the write),
 * 4 a write failure after approval.
 */

export interface PublishArgs {
  /** The regular Markdown file to publish, or `-` for CLI stdin. */
  file?: string;
  /**
   * The harness agent id of the agent running this publish, recorded with it.
   *
   * ATTRIBUTION, NOT AUTHORITY. Nothing in this file branches on it: the scan,
   * the consent cascade, the confirm, the price and the shelf are identical
   * whether it is present or absent, because consent lives in the config and
   * not in which agent ran the command. It exists because a subagent publishes
   * from a sidechain nobody reads, so this is what lets the parent's own turn
   * end report what its children published (tenjin-agent#228).
   */
  agent?: string;
  /** The search(es) this publish answers; closes each open loop. */
  searchId?: string | string[];
  draft?: boolean;
  yes?: boolean;
  /** Raw `--mode` (review|auto|full-auto); validated at the edge (USAGE on a bad value). */
  mode?: string;
  /** Top-level post price, decimal USD at the edge (O1). */
  price?: string;
  /** The public preview text; overrides frontmatter `excerpt`. Absent, the server
   *  derives one from the body's leading prose. */
  excerpt?: string;
  /**
   * Exact-match keys this piece answers resolve-by-key lookups on, each spelled
   * `<kind>=<value>` (`fingerprint=sig_v1:…`, `package_version=zod@4.1.0`,
   * `command_head=pnpm`, `repo=owner/name`). Repeatable, up to 32. Always sent
   * unverified: `verified` is the close rule's claim (two independent fixes),
   * not a flag a hand publish gets to assert. Needs KNOWLEDGE_KEYS on the shelf.
   */
  key?: string[];
}

export interface PublishDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  /** Force the plain-SIWX write path (default: session key unless TENJIN_NO_SESSION=1). */
  useSession?: boolean;
  /** Environment seam (mode, base-url, TENJIN_NO_SESSION); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the `.tenjin.json` walk; defaults to process.cwd(). */
  cwd?: string;
  /** CLI-only stdin capability. Omitted by MCP so it can never consume its stdio transport. */
  stdin?: StdinInput;
  /** How this surface spells the search-id input, for edge errors: the CLI flag
   *  by default, `searchId` from the MCP tool. A dep and not an arg because
   *  `publishInput`'s `satisfies` would expose a new PublishArgs key to agents. */
  searchIdLabel?: string;
  /**
   * Force the answer to the server gate's warn tier, whatever `publish.mode` and
   * `publish.ackServerWarnings` say. For an IN-PROCESS caller whose answer is not
   * the operator's to configure: an unattended lane passes `false` so a server
   * warn drops its candidate to a draft rather than being acked by a config
   * value. The operator-facing switch is `publish.ackServerWarnings`, not this.
   */
  ackServerWarnings?: boolean;
}

export async function runPublish(
  args: PublishArgs,
  ctx: CommandContext,
  deps: PublishDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  // Validate --mode at the edge (USAGE, exit 2) BEFORE any consent resolution: a
  // typo like `--mode Review` must never be silently dropped onto a looser mode
  // and publish unconfirmed. Mirrors install's --publish-mode edge check.
  if (args.mode !== undefined) parsePublishModeFlag(args.mode, '--mode');
  // Validated at the edge for the same reason, though it gates nothing: an id
  // that will not be stored as given is better refused here than silently
  // dropped, because the caller's whole reason for passing it is a later read.
  const agentId = parseAgentIdFlag(args.agent);
  const searchIds = normalizeSearchIds(args.searchId, deps.searchIdLabel ?? '--search-id');
  // Parsed and bounded at the edge too (USAGE, exit 2): a bad kind must fail
  // before the wallet signs, not as a 400 collected after it.
  const keys = parseKeyFlags(args.key);

  // Resolved FIRST because team mode changes what the rest of this function
  // does, not just where the POST goes.
  const runtime = await resolveContextSettings(ctx);
  const raw = await resolveSource(args, deps.stdin);

  // The consent cascade + resolved price (global < project < env < flag), with the
  // full-auto loosening gate. Pure config reads: no writes, no network, no wallet.
  // Its downgrade warnings are still written where they were, below the dedup, so
  // a duplicate turn end stays as quiet as it was.
  const settings = await resolvePublishSettings({
    dataDir: ctx.dataDir,
    cwd,
    ...(args.mode !== undefined ? { flag: args.mode } : {}),
    env,
  });

  const { frontmatter, body } = parseFrontmatter(raw);
  const status = resolveStatus(args, frontmatter);

  /**
   * THE DOCUMENT'S SHAPE, ABOVE EVERYTHING OBSERVABLE. A publish that cannot
   * say what it is — no title, or an answer card the next searcher has no way
   * to judge it by — is refused here, above the dedup answer, the scan, the
   * confirm, the wallet and the network, so being unpublishable costs a message
   * and never a signature. This is the whole of what `--dry-run` used to be for,
   * on the path everybody already runs.
   *
   * A DRAFT IS EXEMPT FROM THE CARD, and from nothing else. A draft parks
   * privately and answers nobody, so it is unfinished by definition and the card
   * is most of what finishing it means. The title is not exempt: a draft is
   * listed on its author's own desk by that name from the moment it exists.
   */
  const title = resolveTitle(frontmatter, body);
  const card = deriveCard(frontmatter, {});
  if (status !== 'draft') requirePublishableCard(card);

  // ALREADY PUBLISHED FROM THIS MACHINE? Keyed on the body's content hash, not on
  // a session id: the duplicates this catches come from two agents watching
  // related sessions, or one agent whose turn ended twice, and the only thing the
  // two publishes share is the text. Checked HERE — before the scan, before the
  // consent gate, before the wallet — so a capture ask that fires twice cannot
  // turn a clean turn end into a confirm prompt or a keystore unlock, and so no
  // request is made at all.
  //
  // DRAFTS ARE OUT, both ways: a draft parks privately, so parking the same text
  // twice is legitimate and a draft writes no marker to match. The marker is
  // written wherever the body actually goes public — below on a non-draft
  // publish, and in edit.ts when `--status published` promotes a draft.
  if (status !== 'draft') {
    const already = await publishedUrlFor(ctx.dataDir, body);
    if (already !== null) {
      // Success, deliberately. The caller is a turn end that already did its
      // work; failing it would report a broken publish for a piece that is up.
      return {
        data: { alreadyPublished: true, url: already },
        humanLines: [`Already published: ${sanitizeForTerminal(already)}`],
      };
    }
  }

  // The local records for the named searches: each id's presence decides what
  // its close reports and what is warned about below.
  const stored = await loadNamedSearches(ctx, searchIds);
  if (status !== 'draft') warnUnrecorded(ctx, searchIds, stored);
  // THE OTHER SHELF'S SEARCHES ARE NOT THIS SHELF'S TO CLAIM. A publish lands on
  // one shelf; a searchId minted by the other names a row in a database this one
  // has never seen. The server format-validates the uuid and stores it set-once,
  // so sending it does not fail — it misfiles the attribution permanently, on the
  // wrong shelf, while the shelf that actually served the search hears nothing.
  // Dropped from the body and left OPEN locally, so the close is still reachable
  // by `tenjin outcome`, which routes to the shelf that answered.
  const foreignIds = searchIds.filter((id) => !shelfRouteFor(stored.get(id), runtime).configured);
  const claimableIds = searchIds.filter((id) => !foreignIds.includes(id));
  if (status !== 'draft') warnForeignShelf(ctx, foreignIds, stored);
  const tags = resolveTags(frontmatter);
  const excerpt = resolveExcerpt(args, frontmatter);
  const handle = expectString(frontmatter, 'handle');

  // The resolver's downgrade warnings, a mistyped env mode, and the one-line
  // explainer for an unconfigured mode: all stderr, all invisible to --json. On
  // every shelf, because the cascade below runs on every shelf: in team mode
  // `review` still asks once per note, so the line pointing at `auto` is the
  // right advice rather than advice about a gate that is not in the way.
  writeModeNotices(
    ctx.io.stderr,
    settings,
    env,
    'each publish asks you once. Set auto to publish clean scans automatically',
  );
  // FREE BY DEFAULT ON THE TEAM SHELF. The default price exists to stop a public
  // piece being given away by accident; a team shelf has no buyers, and a
  // teammate hitting a 402 on their own team's finding is the loop not working.
  // An explicit --price or a frontmatter price still wins, because that is
  // somebody saying what they meant.
  const priceAtomic = resolvePrice(
    args,
    frontmatter,
    runtime.teamMode ? '0' : settings.defaultPriceAtomic,
  );

  // The scan runs in EVERY publish mode (D38) and on EVERY shelf, and every
  // finding is a FLAG: the consent flow shows it to the agent, which fixes the
  // text or overrides with --yes. Nothing refuses locally; the server's ingest
  // gate is the one place that refuses (vendor tokens, private keys, seed
  // phrases, DB passwords, bearer headers), and scan-gate.ts carries its answer
  // back into this same flow. WHICH rows a shelf flags is `scopes` on the rule
  // in lib/redact-rules.json, applied inside `findings()`: this command, edit.ts
  // and sync.ts pass a scope and filter nothing, so they cannot drift.
  const warns = await scanDraft(args, raw, card, runtime.teamMode ? 'team' : 'publish');

  const eligibility = localCardEligibility(card);
  const price = toMoney(priceAtomic);

  // --yes clears the soft findings and the review confirm alike, on every shelf.
  // TEAM MODE CHANGES NOTHING HERE EITHER: `review` still asks once per note, and
  // a team that finds that ask is the thing making in-session capture fail turns
  // it off the way everyone else does, with `publish.mode auto` (the dogfood
  // protocol sets `full-auto`). What team mode does change is the input: `warns`
  // above holds only the rows scoped to `team`, so `auto` is promptless on every
  // team note that carries no credential shape, and still confirms on one that
  // does.
  if (needsConfirmation(settings.mode, warns.length) && args.yes !== true) {
    throw new CliError('NEEDS_CONFIRMATION', confirmMessage(warns.length, price.usd), {
      fix: 'Review the findings, then re-run with --yes (or fix the document and re-run).',
      details: {
        mode: settings.mode,
        price: { atomic: price.atomic, usd: price.usd },
        findings: warns.map(publicFinding),
        card: eligibility,
        target: { status, titlePreview: sanitizeForTerminal(title) },
      },
    });
  }

  // Approved (or nothing to confirm): from here a wallet is required. The write
  // base URL is resolved through the shared settings seam and used for BOTH the
  // SIWX/session header domain and the POST host, so the two never diverge. In
  // team mode that is the team shelf and nowhere else — a publish never reaches
  // `publicShelfUrl`, which is consume-only.
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
    // A publish always writes.
    scope: 'read+write',
    ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
    env,
  });

  const input: PublishInput = {
    title,
    bodyMd: body,
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(tags !== undefined ? { tags } : {}),
    priceAtomic,
    ...(handle !== undefined ? { handle } : {}),
    status,
    ...(card !== undefined ? { resource: card } : {}),
    // The attribution half of `--search-id`, and it follows the SAME rule the
    // local ledger already follows: a draft answers nobody, so it claims nobody's
    // demand either, and a draft that never ships must not hold a claim. The ids
    // are not lost: they are parked on the draft locally (linkSearchesToDraft
    // below), and `edit --status published` carries them when the piece actually
    // goes public.
    ...(claimableIds.length > 0 && status !== 'draft' ? { searchId: claimableIds } : {}),
    // Keys ride on a draft too: a draft's keys are private to its author and
    // resolve never returns a draft, so nothing is claimed early by sending them.
    ...(keys.length > 0 ? { keys } : {}),
  };

  const client = {
    baseUrl: runtime.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(runtime.bypass !== undefined ? { bypass: runtime.bypass } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  // The server ingest gate runs the same rule corpus in the marketplace's write
  // path, so its warn tier joins this command's exit-3 flow rather than arriving
  // as an opaque write failure. Its block tier has no acknowledgement path.
  const result = await throughScanGate({
    send: (scanAck) =>
      publishPost(scanAck === undefined ? input : { ...input, scanAck }, auth, client),
    localWarns: warns,
    mode: settings.mode,
    yes: args.yes === true,
    ackSetting: settings.ackServerWarnings,
    ...(deps.ackServerWarnings !== undefined ? { ackOverride: deps.ackServerWarnings } : {}),
    detail: { mode: settings.mode, price: { atomic: price.atomic, usd: price.usd } },
    noun: 'Publish',
    heldSuffix: `, price $${price.usd}`,
  });

  // A DRAFT answered nobody. It parks the piece privately, so it clears no parked
  // loop: the draft is still the pending answer, and the promotion (`edit
  // --status published`) is what resolves it.
  const parksPrivately = status === 'draft';

  // The post exists: remember it against the body, so the next publish of the
  // same text this machine attempts hands back this url instead of creating a
  // second row. Not for a draft, whose whole purpose is to be published later.
  if (!parksPrivately) {
    await recordPublished(ctx.dataDir, body, result.url, { agentId });
    stampPairings(ctx.dataDir, keys, result.resourceId);
  }
  // Park the named claims on the draft (record's own spelling: the store matches
  // ids by exact string), so the promotion can send what this create withheld.
  if (parksPrivately) {
    const parked = claimableIds
      .map((id) => stored.get(id)?.searchId)
      .filter((id): id is string => id !== undefined);
    await linkSearchesToDraft(ctx.dataDir, parked, result.resourceId);
  }

  // One close per id, each reporting for itself: the piece is published and the
  // server has every id, so an unrecorded search warns without costing the rest.
  const searches: SearchReceipt[] = [];
  for (const id of searchIds) {
    if (foreignIds.includes(id)) {
      searches.push({ id, closed: false, otherShelf: true });
      continue;
    }
    searches.push(
      await closeNamedSearch(
        ctx,
        id,
        stored.get(id) ?? null,
        parksPrivately ? result.resourceId : null,
      ),
    );
  }
  return receipt(result, runtime.baseUrl, searches, agentId);
}

/**
 * `--key <kind>=<value>`, split on the FIRST `=` only: a fingerprint key is
 * `sig_v1:<hash>` and a repo key may carry `=` in a query string, so only the
 * kind is ever read off the left. Kind and bounds are checked by
 * {@link normalizePostKeys}, the same function the request builder runs.
 */
export function parseKeyFlags(flags: string[] | undefined): PostKeyInput[] {
  if (flags === undefined || flags.length === 0) return [];
  const parsed: PostKeyInput[] = [];
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    if (eq <= 0) {
      throw new CliError('USAGE', `Invalid --key: ${JSON.stringify(flag)}`, {
        fix: `Spell a key as <kind>=<value>, with kind one of ${POST_KEY_KINDS.join(', ')}.`,
      });
    }
    parsed.push({ kind: flag.slice(0, eq) as PostKeyKind, key: flag.slice(eq + 1) });
  }
  return normalizePostKeys(parsed, '--key');
}

/**
 * The fix this piece explains, named once. The turn-end ask hands the agent
 * `--key fingerprint=sig_v1:<hash>`; a `pairings` row stores the hash alone, so
 * the stamp matches on the part after the prefix, and only where nothing has
 * claimed the row yet — a second piece under the same key does not displace the
 * first, and re-running the same publish is not a second stamp.
 *
 * NOT ON A DRAFT, which is why the call sits under the same `!parksPrivately`
 * guard as the dedup record: a draft answered nobody, so the pairing is still
 * owed a write-up and must stay on offer until the promotion publishes one.
 *
 * BEST EFFORT, BECAUSE THE PUBLISH HAS ALREADY LANDED. A `loop.db` that cannot
 * be opened or written costs one repeat of the ask at the next turn end;
 * failing the command here would report a piece that is up as a failure.
 */
function stampPairings(dataDir: string, keys: PostKeyInput[], postId: string): void {
  const fingerprints = keys.filter((k) => k.kind === 'fingerprint');
  if (fingerprints.length === 0) return;
  try {
    withLoopDb(dataDir, (db) => {
      const stamp = db.prepare('UPDATE pairings SET post_id = ? WHERE key = ? AND post_id IS NULL');
      for (const { key } of fingerprints) stamp.run(postId, key.slice(key.indexOf(':') + 1));
    });
  } catch {
    // See above: the ask names the fix again next turn.
  }
}

/**
 * Which named searches this machine has no record of, said BEFORE the wallet
 * touch: the server takes the batch as a unit, so one id it cannot match refuses
 * the whole publish, after the signature. A warning and not an error: the store
 * keeps every row, so an id missing from it was recorded somewhere else — another
 * machine, another data dir — where it is perfectly valid.
 */
function warnUnrecorded(
  ctx: CommandContext,
  searchIds: string[],
  stored: Map<string, StoredSearch>,
): void {
  const unrecorded = searchIds.filter((id) => !stored.has(id));
  if (unrecorded.length === 0) return;
  ctx.io.stderr.write(
    `Not in this machine's search store: ${unrecorded.join(', ')}. The server accepts or refuses the named searches as one batch, so if it has no record of one either, this publish is refused after it is signed. Drop that id to publish without it.\n`,
  );
}

/**
 * Named searches this machine recorded against the OTHER shelf, said before the
 * wallet touch like {@link warnUnrecorded}. Not an error: naming the search a
 * piece answers is right, and in team mode the public marketplace answering a
 * team miss is the ordinary path. Only the destination is wrong, and `outcome`
 * is the verb that reaches it.
 */
function warnForeignShelf(
  ctx: CommandContext,
  foreignIds: string[],
  stored: Map<string, StoredSearch>,
): void {
  if (foreignIds.length === 0) return;
  for (const id of foreignIds) {
    // Sanitized like every other store- or server-derived string this tree
    // writes to a terminal (outcome's echoed question, buy's creator label,
    // search's shelf error text). Today the field only ever holds a validated
    // config URL, so this is consistency rather than a live escape-sequence
    // risk — but the rule that store text is sanitized on the way out is worth
    // more than the one call site that could argue its way out of it.
    const shelf = sanitizeForTerminal(stored.get(id)?.shelfBaseUrl ?? 'another shelf');
    ctx.io.stderr.write(
      `Search ${id} was answered by ${shelf}, not the shelf this piece is published to, so it is not claimed here and stays open. Close it there with \`tenjin outcome --search-id ${id} --status used\`.\n`,
    );
  }
}

/**
 * The local records for the named searches, keyed case-folded like the ids that
 * look them up, so an entry recorded in another spelling is still found.
 */
async function loadNamedSearches(
  ctx: CommandContext,
  searchIds: string[],
): Promise<Map<string, StoredSearch>> {
  const found = new Map<string, StoredSearch>();
  for (const id of searchIds) {
    // The lookup itself is case-insensitive (`getStoredSearch`), so the id
    // this map is keyed by is the one the caller will ask with.
    const stored = await getStoredSearch(ctx.dataDir, id);
    if (stored !== null) found.set(id.toLowerCase(), stored);
  }
  return found;
}

/**
 * What `--search-id` did, as a machine field. `--json` suppresses every stderr
 * note below, so without this an agent that named a search had no way to learn
 * whether its loop actually closed — the same silent-flag failure the draft note
 * fixes for a human.
 */
interface SearchReceipt {
  id: string;
  closed: boolean;
  /**
   * The loop had already been closed by something else (an `outcome` report) and
   * this publish took it over. Reported because it is the one case where naming a
   * search changed a record that was already there.
   */
  relinked?: boolean;
  /**
   * An earlier publish had already closed this loop, so this one attributed
   * nothing new. Distinct from `relinked`, which took a loop over from an
   * `outcome` report.
   */
  alreadyAnswered?: boolean;
  /**
   * The named search was answered by the OTHER shelf, so this publish did not
   * claim it and the loop is still open. The one `closed: false` case that is a
   * routing fact rather than a failure; see {@link warnForeignShelf}.
   */
  otherShelf?: true;
}

/**
 * Close the loop a `--search-id` file publish named, and say what happened in
 * both registers: a stderr line for a human, the returned receipt for `--json`.
 *
 * Two outcomes close nothing, and neither is an error — the piece is already
 * published, and bookkeeping never fails the write that ran. A `--draft` parks
 * privately and answers nobody, and an unknown id (aged out of the local store,
 * or from another machine) has no loop here to close.
 *
 * `closed: true` describes the LOOP, not this call: a search an `outcome` already
 * closed reports closed here too, which is what the caller is actually asking
 * about. It reports the OUTCOME of the write rather than the intent to write, so
 * a swallowed lock timeout comes back as `closed: false` and a stderr line
 * instead of a receipt claiming a close that never landed.
 *
 * A publish RELINKS a loop something else already closed. Closing as
 * `regenerated` is what an agent does when the answer is still being written, so
 * treating that as final is what severed seventeen demand signals from the two
 * pieces that answered them (tenjin-agent #161). Nothing is lost by taking the
 * loop over: the `outcome` report was already sent, and this only records who
 * ended up answering it.
 */
async function closeNamedSearch(
  ctx: CommandContext,
  searchId: string,
  stored: StoredSearch | null,
  draftPostId: string | null,
): Promise<SearchReceipt> {
  const open = (reason: string): SearchReceipt => {
    ctx.io.stderr.write(`${reason}\n`);
    return { id: searchId, closed: false };
  };
  if (draftPostId !== null) {
    return open(
      `Saved as a draft, so search ${searchId} stays open; \`tenjin edit ${draftPostId} --status published\` claims it when the piece goes up.`,
    );
  }
  if (stored === null) {
    return open(`Published, but search ${searchId} is not in the local store.`);
  }
  // The record's OWN spelling: the store matches ids by exact string.
  const outcome = await markSearchResolved(ctx.dataDir, stored.searchId, 'publish', undefined, {
    relink: true,
  });
  if (outcome === 'failed') {
    return open(
      `Published, but the local record for search ${searchId} could not be updated, so the open-loop reminder may repeat. Close it with \`tenjin outcome --search-id ${searchId} --status used\`.`,
    );
  }
  // `not-found` here means the entry was evicted between the read above and this
  // write: nothing was closed, so nothing claims to have been.
  if (outcome === 'not-found') {
    return open(`Published, but search ${searchId} is no longer in the local store.`);
  }
  if (outcome === 'relinked') return { id: searchId, closed: true, relinked: true };
  // A PRIOR publish already closed this loop. Reporting a fresh close here is a
  // receipt for something that did not happen, on the one path where a different
  // post already claims the demand this body is claiming again.
  if (outcome === 'already-resolved' && stored.resolved?.by === 'publish') {
    ctx.io.stderr.write(
      `Search ${searchId} was already answered by an earlier publish; this piece did not claim it.\n`,
    );
    return { id: searchId, closed: true, alreadyAnswered: true };
  }
  return { id: searchId, closed: true };
}

/**
 * The deterministic scan over the document, the typed `--excerpt`, AND the
 * derived card's text, so a secret reaches the same gates whether it arrives in
 * the body, in frontmatter or in the excerpt flag, all of it shipping to the
 * PUBLIC page. Deduped by check+excerpt so a frontmatter value (present in both
 * raw and the card) is not double-counted.
 *
 * `args.excerpt` is scanned here and not only inside `raw` because it is the one
 * shipped field that never passes through the file: a frontmatter excerpt is in
 * `raw` already, a flag excerpt was not covered at all, and that is the gap that
 * made "a block-tier secret never leaves the machine" untrue. `edit.ts` has
 * always scanned its own typed excerpt (`shippedTypedText`).
 *
 */
async function scanDraft(
  args: PublishArgs,
  raw: string,
  card: ResourceCardInput | undefined,
  scope: ReportScope,
): Promise<Finding[]> {
  return dedupeFindings([
    ...scanFindings(raw, scope),
    ...scanFindings(args.excerpt ?? '', scope),
    ...scanFindings(cardScanText(card), scope),
  ]);
}

/**
 * Where the Markdown comes from: a regular file, or CLI stdin.
 *
 * ONE SOURCE, because there is one shape. A finding is a document, so the only
 * question left is which file holds it.
 */
async function resolveSource(args: PublishArgs, stdin: StdinInput | undefined): Promise<string> {
  if (args.file === undefined) {
    // Bare publish is the convenient pipe form, but only on the CLI and only
    // when stdin is actually non-interactive. A TTY must fail immediately: an
    // empty read there waits forever for input the caller never said it would
    // provide. MCP supplies no capability at all, so its protocol stream is
    // never mistaken for a document.
    if (stdin !== undefined && !stdin.isTTY) return readMarkdownStdin(stdin);
    throw new CliError('USAGE', 'Nothing to publish.', {
      fix: 'Pass a regular Markdown file, such as `tenjin publish finding.md`, or pipe one to `tenjin publish -`.',
    });
  }
  if (args.file === '-') {
    if (stdin === undefined) {
      throw new CliError('USAGE', '`-` reads Markdown from CLI stdin.', {
        fix: 'On this surface, pass a regular Markdown file instead.',
      });
    }
    return readMarkdownStdin(stdin);
  }
  return readMarkdown(args.file);
}

/**
 * The agent id to record this publish under, or null.
 *
 * REFUSED RATHER THAN DROPPED. It was typed by the caller, and a value silently
 * discarded here is a publish the parent will never be told about, reported as
 * a success.
 */
function parseAgentIdFlag(value: string | undefined): string | null {
  if (value === undefined) return null;
  // THE ONE AGENT ID CHARSET, imported rather than restated. This used to read a
  // wider `shell-safe` copy that admitted `.` and `:`, so `--agent` accepted ids
  // `identityOf` refuses and `:` is the separator `agentKey` joins on: a publish
  // under one could never be reported, because no ask row is ever keyed on it.
  if (!AGENT_ID_RE.test(value)) {
    throw new CliError('USAGE', 'Invalid --agent value.', {
      fix: 'Pass the harness agent id as letters, digits, `_` and `-`, up to 128 characters. The SubagentStop capture ask prints the exact flag to use.',
    });
  }
  return value;
}

function receipt(
  result: Awaited<ReturnType<typeof publishPost>>,
  baseUrl: string,
  searches: SearchReceipt[],
  agentId: string | null,
): CommandResult {
  const price = toMoney(result.priceAtomic);
  const missing = missingSentences(result.cacheEligibleMissing).map(sanitizeForTerminal);
  const cacheEligible = result.cacheEligible ?? false;
  const deskUrl = `${trimSlash(baseUrl)}/desk`;
  const title = sanitizeForTerminal(result.title);
  const undo = undoCommands(result.resourceId, result.status);
  // status and url are server-sent open strings (posts-api declares both as bare
  // z.string()), so they get the same treatment as the title beside them: this
  // line is what an author reads to learn where their piece went.
  // NO "PUBLISHED WITHOUT AN ANSWER CARD" LINE. The card gate runs above every
  // write and mirrors the server's own rubric, so a non-draft publish that got
  // this far HAS a complete card and a line saying so is one more sentence
  // every successful publish pays for. What is left is the one case the gate
  // deliberately lets through: a draft, which parks unfinished and is told what
  // finishing it still needs. Server warnings of every other kind still print.
  const human = [
    `Published ${title} (${sanitizeForTerminal(result.status)}) for ${price.usd} USD → ${sanitizeForTerminal(result.url)}`,
    ...(missing.length > 0 ? [`Answer card incomplete: ${missing.join(' ')}`] : []),
    ...searches.filter((s) => s.closed).map(closeLine),
    undoLine(undo),
    ...scanNoteLines(result.scan),
    ...result.warnings.map((w) => `warning: ${sanitizeForTerminal(w)}`),
  ];
  return {
    data: {
      resourceId: result.resourceId,
      url: result.url,
      status: result.status,
      price,
      cacheEligible,
      missing,
      deskUrl,
      undo,
      // WHO PUBLISHED IT, when the caller said. Echoed so an agent that passed
      // `--agent` can see the attribution landed rather than assume it: this row
      // is what its parent's turn end reads, and a silently dropped id is a
      // publish nobody upstream is ever told about.
      ...(agentId === null ? {} : { publishedBy: { agentId } }),
      // `search` repeats a lone result for callers that already read it; a
      // batch has no single one to repeat.
      ...(searches.length === 1 ? { search: searches[0] } : {}),
      ...(searches.length > 0 ? { searches } : {}),
      ...(result.scan !== undefined ? { scan: scanReceipt(result.scan) } : {}),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    },
    humanLines: human,
  };
}

/** The two commands that take a fresh publish back, with the real id filled in. */
interface UndoCommands {
  /** Removes the piece. Carries NO `--yes`; see {@link undoCommands}. */
  remove: string;
  /** Only on a published piece: the reversible half. */
  unpublish?: string;
}

/**
 * THE UNDO LINE, on BOTH surfaces (#221). An agent that has just published is the
 * one being asked "how do I take that down", and with nothing in the receipt to
 * answer with it will invent a plausible verb — which is exactly what happened in
 * the issue that asked for this, before `tenjin delete` existed. So the receipt
 * carries the real commands with the real id, in `data.undo` for a machine reader
 * and as a stderr line for a human, rather than leaving either to guess.
 *
 * `remove` DELIBERATELY OMITS `--yes`, and the omission is the load-bearing part.
 * This string is the most authoritative thing in the transcript at the moment it
 * prints, and it gets copied verbatim — that is the entire reason for printing
 * it. A `--yes` baked in would hand every reader a one-shot destructive command
 * and would contradict the rule the skill states in the same breath, that a
 * delete is run bare first and confirmed only after the user has seen what would
 * go. Bare, the command is right for both readers: a human pasting it at a
 * terminal gets the y/N prompt, and an agent running it gets the exit-3 payload
 * it is supposed to render. `--yes` belongs on the SECOND call, which is why the
 * refusal payload's own `confirmCommand` (commands/delete.ts) carries it and
 * this does not: that one answers a question the user has already been shown.
 *
 * `unpublish` is offered first in the rendered line and omitted entirely on a
 * draft: a draft is not up, so demoting it is not an undo of anything.
 */
function undoCommands(resourceId: string, status: string): UndoCommands {
  return {
    remove: `tenjin delete ${resourceId}`,
    ...(status === 'published' ? { unpublish: `tenjin edit ${resourceId} --status draft` } : {}),
  };
}

function undoLine(undo: UndoCommands): string {
  return undo.unpublish !== undefined
    ? `Undo: \`${undo.unpublish}\` unpublishes it (reversible), \`${undo.remove}\` removes it.`
    : `Undo: \`${undo.remove}\` removes it.`;
}

function closeLine(search: SearchReceipt): string {
  if (search.relinked === true) {
    return `Re-linked search ${search.id} to this piece; it had been closed without one.`;
  }
  if (search.alreadyAnswered === true) {
    return `Search ${search.id} was already answered by an earlier publish.`;
  }
  return `Closed the loop on search ${search.id}.`;
}

// ---------------------------------------------------------------------------
// Field resolution.
// ---------------------------------------------------------------------------

async function readMarkdown(file: string): Promise<string> {
  try {
    return await readRegularUtf8File(file);
  } catch (err) {
    throw new CliError('USAGE', `Could not read ${JSON.stringify(file)}`, {
      fix: 'Pass a path to a readable regular Markdown file, e.g. `tenjin publish post.md`.',
      cause: err,
    });
  }
}

function resolveStatus(args: PublishArgs, frontmatter: Frontmatter): PublishStatus {
  if (args.draft === true) return 'draft';
  const fm = frontmatter.status;
  if (fm === undefined) return 'published';
  if (typeof fm !== 'string' || !(PUBLISH_STATUSES as readonly string[]).includes(fm)) {
    throw new CliError('USAGE', `Invalid status ${JSON.stringify(fm)} in frontmatter.`, {
      fix: 'Use status: draft | published | unlisted, or pass --draft.',
    });
  }
  return fm as PublishStatus;
}

/**
 * The piece's title: frontmatter `title`, else the body's first LEVEL-1 heading.
 *
 * TWO PLACES, NOT THREE. `# ` is the title of a Markdown document, and a `##`
 * fallback meant a piece whose author forgot a title shipped under the name of
 * whatever its first subsection happened to be — a subheading is a section
 * name, never the claim the piece makes. There is no third source left to guess
 * from, so a document with neither is refused rather than published unnamed.
 */
function resolveTitle(frontmatter: Frontmatter, body: string): string {
  const fm = frontmatter.title;
  if (fm !== undefined) {
    if (typeof fm !== 'string') {
      throw new CliError('USAGE', 'frontmatter title must be a single string.');
    }
    const trimmed = fm.trim();
    if (trimmed !== '') return trimmed;
  }
  const h1 = headingOutline(body).find((h) => h.level === 1);
  if (h1 !== undefined && h1.text.trim() !== '') return h1.text.trim();
  throw new CliError(
    'USAGE',
    'This document has no title: add `title:` to the frontmatter, or start the body with a single `# ` heading.',
    {
      fix: "A finding is a publish document — frontmatter (`title` plus the answer-card keys), then the body. The title is read from `title:` first and from the body's first `# ` heading otherwise; no other heading level counts.",
    },
  );
}

/**
 * The frontmatter key behind each rubric token, and what the author has to put
 * in it. The rubric is {@link cardEligibilityTokens}, shared with the local
 * eligibility preview, so this table only has to say what a key MEANS.
 */
const CARD_KEY_MEANING: Record<string, string> = {
  questionsOrTasks:
    '`questionsAnswered`: 3 to 8 questions this settles, as a searcher would type them.',
  scope: '`scope`: what it covers.',
  exclusions: '`exclusions`: what it does not.',
  provenanceOrMethodology: '`provenanceSummary`: how you know — what you ran, read, measured.',
  asOf: '`asOf`: the moment this describes, required because `temporalMode` is `snapshot`.',
};

/**
 * REFUSE AN UNPUBLISHABLE DOCUMENT BY NAME, before anything is written.
 *
 * The answer card is the whole of what makes a finding findable: without it the
 * next searcher gets a title and a price and no way to judge fit, and the piece
 * fails every `freshWithin` and `appliesTo` filter. It used to be optional, and
 * the receipt said so afterwards — which is a complaint about a piece that is
 * already public. This is the same rubric, run first, spelling the missing
 * frontmatter keys so the author can fix the file and re-run.
 *
 * DRAFTS DO NOT COME HERE. A draft is unfinished by definition; the caller
 * decides when it is finished by publishing it.
 */
function requirePublishableCard(card: ResourceCardInput | undefined): void {
  const tokens = cardEligibilityTokens(card);
  if (tokens.length === 0) return;
  const keys = tokens.map((t) => CARD_KEY_MEANING[t] ?? t);
  throw new CliError(
    'USAGE',
    `This document has no complete answer card, so there is nothing for the next searcher to judge it by. Add to the frontmatter: ${keys.join(' ')}`,
    {
      fix: "Write those keys into the document's frontmatter and re-run `tenjin publish <file>`. A piece that is genuinely unfinished can be parked with --draft, which skips this check.",
      details: { card: { missingKeys: tokens } },
    },
  );
}

/**
 * The public preview text: `--excerpt` over frontmatter `excerpt`, or undefined
 * to let the server derive one from the body's leading prose.
 *
 * The bound is checked HERE as well as in the request builder, because the
 * builder runs after a wallet signature has been collected and this is the edge:
 * a too-long excerpt should cost a message, not a signing prompt. Refused rather
 * than truncated — a silently cut preview is a different preview, and the whole
 * point of setting one is controlling exactly what a non-buyer reads. Sanitized
 * before the bound for the same reason the builder is: the stripped text is what
 * ships, so it is what the length has to describe.
 */
function resolveExcerpt(args: PublishArgs, frontmatter: Frontmatter): string | undefined {
  const raw = args.excerpt ?? expectString(frontmatter, 'excerpt');
  if (raw === undefined) return undefined;
  const excerpt = sanitizeWireText(raw);
  if (excerpt.length > EXCERPT_MAX_LENGTH) {
    throw new CliError(
      'USAGE',
      `excerpt must be at most ${EXCERPT_MAX_LENGTH} characters (got ${excerpt.length}).`,
      { fix: `Shorten it to ${EXCERPT_MAX_LENGTH} characters or fewer.` },
    );
  }
  return excerpt;
}

function resolveTags(frontmatter: Frontmatter): string[] | undefined {
  const fm = frontmatter.tags;
  if (fm === undefined) return undefined;
  if (typeof fm === 'string') return [fm];
  if (Array.isArray(fm)) return fm;
  throw new CliError('USAGE', 'frontmatter tags must be a list of strings.');
}

function expectString(frontmatter: Frontmatter, key: string): string | undefined {
  const fm = frontmatter[key];
  if (fm === undefined) return undefined;
  if (typeof fm !== 'string') {
    throw new CliError('USAGE', `frontmatter ${key} must be a single string.`);
  }
  return fm;
}

function resolvePrice(args: PublishArgs, frontmatter: Frontmatter, defaultAtomic: string): string {
  if (args.price !== undefined) return parseUsdToAtomic(args.price);
  const fm = frontmatter.price;
  if (fm !== undefined) {
    if (typeof fm !== 'string') {
      throw new CliError('USAGE', 'frontmatter price must be a decimal-USD string, e.g. "0.10".');
    }
    return parseUsdToAtomic(fm);
  }
  return defaultAtomic;
}

/**
 * The derived card's free-text values as one newline-joined document. It all
 * comes from frontmatter now, so this is a dedup convenience rather than extra
 * coverage — the same values are in `raw` — and `dedupeFindings` above is what
 * keeps a frontmatter secret from being counted twice. Empty when there is no
 * card.
 */
function cardScanText(card: ResourceCardInput | undefined): string {
  if (card === undefined) return '';
  const parts: string[] = [];
  const add = (v: string | undefined): void => {
    if (v !== undefined) parts.push(v);
  };
  add(card.scope);
  add(card.exclusions);
  add(card.provenanceSummary);
  add(card.methodologySummary);
  add(card.mediaType);
  add(card.maintenanceCadence);
  add(card.asOf);
  add(card.validUntil);
  add(card.estimatedPaidInputCost);
  if (card.questionsAnswered !== undefined) parts.push(...card.questionsAnswered);
  if (card.tasksSupported !== undefined) parts.push(...card.tasksSupported);
  if (card.appliesTo !== undefined) {
    for (const values of Object.values(card.appliesTo)) parts.push(...values);
  }
  return parts.join('\n');
}

/** The confirm's first line: what is about to go public, and what it costs. */
function confirmMessage(warnCount: number, priceUsd: string): string {
  const findings = warnCount > 0 ? `${warnCount} finding(s), ` : '';
  return `Publish needs confirmation: ${findings}price $${priceUsd}.`;
}

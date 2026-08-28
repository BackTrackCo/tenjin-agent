import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings, shelfRouteFor } from '../lib/settings';
import { parsePublishModeFlag } from '../lib/config';
import {
  getStoredSearch,
  linkSearchesToDraft,
  markSearchResolved,
  type StoredSearch,
} from '../lib/state-store';
import { scan, survivesTeamDrop, type ScanContext, type ScanFinding } from '../lib/scan';
import { deriveProjectMarkers } from '../lib/scan-context';
import { headingOutline } from '../lib/markdown';
import { sanitizeForTerminal, sanitizeWireText } from '../lib/output';
import { trimSlash } from '../lib/url';
import {
  deriveCard,
  localCardEligibility,
  missingSentences,
  parseAppliesToFlags,
  parseFrontmatter,
  type CardFlags,
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
  describeFindings,
  needsConfirmation,
  publicFinding,
  resolveWriteAuth,
  throughScanGate,
  writeModeNotices,
} from '../lib/consent';
import { publishedUrlFor, recordPublished } from '../lib/publish-dedup';
import { scanNoteLines, scanReceipt } from '../lib/scan-gate';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin publish <file.md>`: read the Markdown, parse
 * frontmatter for post + answer-card fields, run the deterministic scan (every
 * mode), gate on the D38
 * consent cascade, then write via the session key (minted on first use) or the
 * plain-SIWX fallback and return a compact receipt. The ordering is the point and
 * is enforced here: scan and consent BEFORE any wallet touch or network write.
 *
 * Exit codes: 0 success (incl. an ineligible-but-published card), 2 usage, 3
 * needs_confirmation / non-bypassable publish_blocked, 4 a write failure after
 * approval.
 */

export interface PublishArgs {
  /** The Markdown file to publish. */
  file?: string;
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
  question?: string[];
  task?: string[];
  scope?: string;
  exclusions?: string;
  appliesTo?: string[];
  asOf?: string;
  validUntil?: string;
  artifactType?: string;
  temporalMode?: string;
  provenance?: string;
  methodology?: string;
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
  const searchIds = normalizeSearchIds(args.searchId, deps.searchIdLabel ?? '--search-id');
  // Parsed and bounded at the edge too (USAGE, exit 2): a bad kind must fail
  // before the wallet signs, not as a 400 collected after it.
  const keys = parseKeyFlags(args.key);

  // Resolved FIRST because team mode changes what the rest of this function
  // does, not just where the POST goes.
  const runtime = await resolveContextSettings(ctx);
  const raw = await readSource(args);
  // Read the named searches ONCE: one prefills the card, and each id's presence
  // decides what its close reports and what is warned about below.
  const stored = await loadNamedSearches(ctx, searchIds);
  const { frontmatter, body } = parseFrontmatter(raw);

  const status = resolveStatus(args, frontmatter);

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
  const title = resolveTitle(frontmatter, body);
  const tags = resolveTags(frontmatter);
  const excerpt = resolveExcerpt(args, frontmatter);
  const handle = expectString(frontmatter, 'handle');
  // The named search's question prefills questionsAnswered, but only as a
  // fallback: an explicit --question OR a frontmatter questionsAnswered still
  // wins. That phrasing is what the next searcher will send.
  const cardFlags = cardFlagsFrom(args);
  // One card, one prefill: the first id you typed that this machine holds.
  const prefillFrom = searchIds.find((id) => stored.get(id)?.question !== undefined);
  const wanted = prefillFrom === undefined ? undefined : stored.get(prefillFrom)?.question;
  const prefillQuestion = wanted === undefined ? undefined : cardQuestion(wanted);
  const roomForPrefill =
    cardFlags.question === undefined && frontmatter.questionsAnswered === undefined;
  if (prefillQuestion !== undefined && roomForPrefill) cardFlags.question = [prefillQuestion];
  // A prefill that was WANTED, had room, and was dropped anyway is the one case a
  // caller cannot infer: the card simply comes back without the question it asked
  // for. Reported on both surfaces, because --json never sees the stderr line.
  const prefill: PrefillOutcome =
    wanted === undefined || !roomForPrefill
      ? 'none'
      : prefillQuestion !== undefined
        ? 'applied'
        : 'dropped-too-long';
  if (prefill === 'dropped-too-long') {
    ctx.io.stderr.write(
      `The searched question is longer than ${CARD_QUESTION_MAX} characters, so it was not added to the answer card; pass --question to set a shorter one.\n`,
    );
  }
  const card = deriveCard(frontmatter, cardFlags);

  // The consent cascade + resolved price (global < project < env < flag), with the
  // full-auto loosening gate. Its downgrade warnings go to stderr, not the receipt.
  const settings = await resolvePublishSettings({
    dataDir: ctx.dataDir,
    cwd,
    ...(args.mode !== undefined ? { flag: args.mode } : {}),
    env,
  });
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

  // The scan runs in EVERY publish mode (D38) and on EVERY shelf: it gates the
  // gate, it does not replace it. What it covers and why is on `scanDraft` below.
  //
  // TEAM MODE DROPS THE WARN TIER, MINUS ONE CHECK. The scan asks two different
  // questions under one name. "Is this safe to make PUBLIC" is the warn tier — a
  // repo slug, an internal hostname, an employer's name — and on a second
  // deployment only this team can reach, every one of those is a false positive
  // on exactly the findings the loop exists to capture ("a quirk of THIS
  // codebase"), each costing a --yes round trip the agent has to be taught to do.
  // "Is this a live credential" is the block tier, and that question has the same
  // answer on every shelf: a team shelf is a hosted Postgres with logs and a
  // static shared door key, and a leaked key there is leaked. It is also silent
  // on a clean note, so keeping it costs the capture loop nothing. The block tier
  // is therefore NEVER skipped and never clearable by --yes, here or anywhere:
  // that invariant is stated to operators (lib/permissions.ts) and to models
  // (mcp/server.ts) and it holds in team mode too.
  //
  // TWO WARNS SURVIVE THE DROP: `secret-assignment` and `hex32-value`. Both ask
  // the credential question rather than the public-safety one — DEPLOY_API_KEY=
  // "pk_live_…" is a live key whose shape no block detector matches, and a
  // 0x+64-hex is the raw-private-key detector demoted to warn only because a block
  // finding is permanently non-bypassable — so "a leaked key there is leaked"
  // applies to both verbatim, and to the two catch-alls behind them
  // (`high-entropy-string`, `env-dump-block`). They are kept as warns rather than
  // promoted to block, so the consent cascade still governs them: `review` and
  // `auto` confirm, and `full-auto` clears them unseen on a team shelf exactly as
  // it already does on the marketplace (the price scan.ts concedes at the
  // detector). Every other warn is dropped. WHICH warns survive is a `teamSurvives`
  // flag on the rule in scan-rules.json, read by `survivesTeamDrop` (lib/scan.ts),
  // so this filter and edit.ts cannot drift (they did once) and a new credential
  // detector joins by marking itself rather than by an edit here. The two other
  // surfaces that characterise this drop say the same:
  // docs/command-reference.md and skills/tenjin-publish/SKILL.md.
  const scanned = await scanDraft(args, cwd, raw, card);
  const findings = runtime.teamMode ? scanned.filter(survivesTeamDrop) : scanned;
  const blocking = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');

  const eligibility = localCardEligibility(card);
  const price = toMoney(priceAtomic);

  // A hard-block finding refuses in EVERY mode and is never clearable by --yes or
  // full-auto — the same non-bypassable posture as buy's price cap.
  if (blocking.length > 0) {
    throw new CliError('PUBLISH_BLOCKED', blockMessage(blocking), {
      fix: 'Remove the secret from the file (it is never masked away by --yes), then re-run.',
      details: {
        mode: settings.mode,
        findings: blocking.map(publicFinding),
        price: { atomic: price.atomic, usd: price.usd },
      },
    });
  }

  // --yes clears the soft findings and the review confirm alike, on every shelf.
  // TEAM MODE CHANGES NOTHING HERE EITHER: `review` still asks once per note, and
  // a team that finds that ask is the thing making in-session capture fail turns
  // it off the way everyone else does, with `publish.mode auto` (the dogfood
  // protocol sets `full-auto`). What team mode does change is the input: `warns`
  // above holds `secret-assignment` findings and nothing else, so `auto` is
  // promptless on every team note that carries no secret-named assignment, rather
  // than only on the fully clean ones, and still confirms on one that does.
  if (needsConfirmation(settings.mode, warns.length) && args.yes !== true) {
    throw new CliError('NEEDS_CONFIRMATION', confirmMessage(warns.length, price.usd), {
      fix: 'Review the findings, then re-run with --yes (or resolve the source and re-run).',
      details: {
        mode: settings.mode,
        price: { atomic: price.atomic, usd: price.usd },
        findings: warns.map(publicFinding),
        card: eligibility,
        target: { status, titlePreview: sanitizeForTerminal(title ?? '(untitled draft)') },
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
    ...(title !== undefined ? { title } : {}),
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
  if (!parksPrivately) await recordPublished(ctx.dataDir, body, result.url);
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
      searches.push({ id, closed: false, otherShelf: true, prefill: 'none' });
      continue;
    }
    searches.push(
      await closeNamedSearch(
        ctx,
        id,
        stored.get(id) ?? null,
        parksPrivately ? result.resourceId : null,
        id === prefillFrom ? prefill : 'none',
      ),
    );
  }
  return receipt(result, runtime.baseUrl, searches);
}

/**
 * Which named searches this machine has no record of, said BEFORE the wallet
 * touch: the server takes the batch as a unit, so one id it cannot match refuses
 * the whole publish, after the signature. A warning and not an error: the store
 * keeps every row, so an id missing from it was recorded somewhere else — another
 * machine, another data dir — where it is perfectly valid.
 */
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
    // The lookup itself is case-insensitive (STORE_SQL.getSearch), so the id
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
  prefill: PrefillOutcome;
}

/**
 * What became of the searched question as a card entry. `none` covers both "no
 * stored question" and "the draft named its own", which are the cases where
 * nothing was expected; `dropped-too-long` is the one a caller has to be told.
 */
type PrefillOutcome = 'applied' | 'dropped-too-long' | 'none';

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
  prefill: PrefillOutcome,
): Promise<SearchReceipt> {
  const open = (reason: string): SearchReceipt => {
    ctx.io.stderr.write(`${reason}\n`);
    return { id: searchId, closed: false, prefill };
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
  if (outcome === 'relinked') return { id: searchId, closed: true, relinked: true, prefill };
  // A PRIOR publish already closed this loop. Reporting a fresh close here is a
  // receipt for something that did not happen, on the one path where a different
  // post already claims the demand this body is claiming again.
  if (outcome === 'already-resolved' && stored.resolved?.by === 'publish') {
    ctx.io.stderr.write(
      `Search ${searchId} was already answered by an earlier publish; this piece did not claim it.\n`,
    );
    return { id: searchId, closed: true, alreadyAnswered: true, prefill };
  }
  return { id: searchId, closed: true, prefill };
}

/**
 * The deterministic scan over the draft, the typed `--excerpt`, AND the derived
 * card's text, so a secret reaches the same gates whether it arrives in the body,
 * in frontmatter, in the excerpt flag, or via a card-authoring flag
 * (`--provenance`, `--scope`, …), all of it shipping to the PUBLIC page, so a flag
 * secret must block exactly like an in-file one. Deduped by check+excerpt so a
 * frontmatter value (present in both raw and the card) is not double-counted.
 *
 * `args.excerpt` is scanned here and not only inside `raw` because it is the one
 * shipped field that never passes through the file: a frontmatter excerpt is in
 * `raw` already, a flag excerpt was not covered at all, and that is the gap that
 * made "a block-tier secret never leaves the machine" untrue. `edit.ts` has
 * always scanned its own typed excerpt (`shippedTypedText`).
 *
 * The scan context carries the source project's git remote slugs (offline FS
 * read, best-effort): a draft quoting its own project's repo/org warns as a
 * private-by-default reference. Markers derive from the DRAFT's project, not the
 * shell's cwd (review r5): a file publish walks up from the file's own directory,
 * so the process cwd is unrelated to where the draft actually lives.
 */
async function scanDraft(
  args: PublishArgs,
  cwd: string,
  raw: string,
  card: ResourceCardInput | undefined,
): Promise<ScanFinding[]> {
  const markerRoot = args.file !== undefined ? dirname(resolve(cwd, args.file)) : cwd;
  const scanContext: ScanContext = { projectMarkers: await deriveProjectMarkers(markerRoot) };
  return dedupeFindings([
    ...scan(raw, scanContext),
    ...scan(args.excerpt ?? '', scanContext),
    ...scan(cardScanText(card), scanContext),
  ]);
}

/** The Markdown to publish. A missing path is USAGE before any wallet touch. */
async function readSource(args: PublishArgs): Promise<string> {
  if (args.file === undefined) {
    throw new CliError('USAGE', 'Nothing to publish.', {
      fix: 'Pass a Markdown file, e.g. `tenjin publish post.md`.',
    });
  }
  return readMarkdown(args.file);
}

function receipt(
  result: Awaited<ReturnType<typeof publishPost>>,
  baseUrl: string,
  searches: SearchReceipt[],
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
  const human = [
    `Published ${title} (${sanitizeForTerminal(result.status)}) for ${price.usd} USD → ${sanitizeForTerminal(result.url)}`,
    cacheEligible
      ? 'Answer card is search-eligible.'
      : missing.length > 0
        ? `Answer card incomplete, ranks below every complete card in agent search. To fix: ${missing.join(' ')}`
        : 'Published without an answer card: ranks below every carded piece in agent search.',
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
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new CliError('USAGE', `Could not read ${JSON.stringify(file)}`, {
      fix: 'Pass a path to a readable Markdown file, e.g. `tenjin publish post.md`.',
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

function resolveTitle(frontmatter: Frontmatter, body: string): string | undefined {
  const fm = frontmatter.title;
  if (fm !== undefined) {
    if (typeof fm !== 'string') {
      throw new CliError('USAGE', 'frontmatter title must be a single string.');
    }
    return fm.trim();
  }
  // Fall back to the first heading (level 1 preferred) so a plain `# Title` post
  // needs no frontmatter.
  const headings = headingOutline(body);
  const h1 = headings.find((h) => h.level === 1) ?? headings[0];
  return h1?.text;
}

/** The server's per-item bound on `questionsAnswered` (mirrored by deriveCard). */
const CARD_QUESTION_MAX = 200;

/**
 * A stored question as a card entry, or undefined when it cannot be one.
 *
 * Dropped rather than cut over the item bound: a search question may run to the
 * server's 512, and a prefill that fails card validation would turn a publish
 * that was fine into a usage error the caller never asked for. Truncating is
 * worse still — half a question is a different question, and this text is what
 * the next searcher matches against.
 */
function cardQuestion(raw: string): string | undefined {
  const question = sanitizeWireText(raw);
  return question.length > 0 && question.length <= CARD_QUESTION_MAX ? question : undefined;
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

function cardFlagsFrom(args: PublishArgs): CardFlags {
  return {
    ...(args.question !== undefined && args.question.length > 0 ? { question: args.question } : {}),
    ...(args.task !== undefined && args.task.length > 0 ? { task: args.task } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.exclusions !== undefined ? { exclusions: args.exclusions } : {}),
    ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
    ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
    ...(args.artifactType !== undefined ? { artifactType: args.artifactType } : {}),
    ...(args.temporalMode !== undefined ? { temporalMode: args.temporalMode } : {}),
    ...(args.provenance !== undefined ? { provenance: args.provenance } : {}),
    ...(args.methodology !== undefined ? { methodology: args.methodology } : {}),
    ...(args.appliesTo !== undefined && args.appliesTo.length > 0
      ? { appliesTo: parseAppliesToFlags(args.appliesTo) }
      : {}),
  };
}

/**
 * The derived card's free-text values as one newline-joined document, so the scan
 * covers card-flag input (which never touches the file) at the same severity as
 * the body. Empty when there is no card.
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

// ---------------------------------------------------------------------------
// Finding + message shaping.
// ---------------------------------------------------------------------------

function blockMessage(blocking: ScanFinding[]): string {
  return `Publish blocked: the file contains ${describeFindings(blocking)}.`;
}

function confirmMessage(warnCount: number, priceUsd: string): string {
  return warnCount > 0
    ? `Publish needs confirmation: ${warnCount} finding(s), price $${priceUsd}.`
    : `Publish needs confirmation: price $${priceUsd}.`;
}

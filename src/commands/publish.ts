import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings } from '../lib/settings';
import { parsePublishModeFlag } from '../lib/config';
import { readCandidate, dropCandidate, type CandidateRecord } from '../lib/candidate-store';
import { loadSearches, markSearchResolved, type StoredSearch } from '../lib/search-store';
import { UUID_RE } from '../lib/ids';
import { scan, type ScanContext, type ScanFinding } from '../lib/scan';
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
  EXCERPT_MAX_LENGTH,
  PUBLISH_STATUSES,
  type PublishInput,
  type PublishStatus,
} from '../lib/posts-api';
import {
  dedupeFindings,
  describeFindings,
  needsConfirmation,
  publicFinding,
  resolveWriteAuth,
  writeModeNotices,
} from '../lib/consent';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin publish <file.md>` (or `--candidate <id>`): read the Markdown, parse
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
  /** The Markdown file to publish; mutually exclusive with --candidate. */
  file?: string;
  /** A parked candidate id to publish (its draft.md); mutually exclusive with <file>. */
  candidate?: string;
  /** The search this publish answers; closes its open loop. Not with --candidate,
   *  which carries its own searchId. */
  searchId?: string;
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
  validateSearchId(args);

  // The content comes from EITHER a <file> or a parked --candidate, never both,
  // never neither. A candidate resolves to its draft.md (and prefills its question).
  const { raw, candidate } = await resolveSource(args, ctx.dataDir);
  // Read the named search ONCE, here: it prefills the card's question below, and
  // whether it was found decides what the post-publish close reports. Local read,
  // and a missing store reads as no entry rather than failing the publish.
  const storedSearch =
    args.searchId !== undefined
      ? ((await loadSearches(ctx.dataDir)).find((s) => s.searchId === args.searchId) ?? null)
      : null;
  const { frontmatter, body } = parseFrontmatter(raw);

  const status = resolveStatus(args, frontmatter);
  const title = resolveTitle(frontmatter, body);
  const tags = resolveTags(frontmatter);
  const excerpt = resolveExcerpt(args, frontmatter);
  const handle = expectString(frontmatter, 'handle');
  // A candidate's stored question prefills questionsAnswered, but only as a
  // fallback: an explicit --question OR a frontmatter questionsAnswered still wins.
  // A `--search-id` publish gets the same prefill from the search's own question,
  // which is the phrasing the next searcher will send.
  const cardFlags = cardFlagsFrom(args);
  const wanted = candidate?.meta.question ?? storedSearch?.question;
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
  // explainer for an unconfigured mode: all stderr, all invisible to --json.
  writeModeNotices(
    ctx.io.stderr,
    settings,
    env,
    'each publish asks you once. Set auto to publish clean scans automatically',
  );
  const priceAtomic = resolvePrice(args, frontmatter, settings.defaultPriceAtomic);

  // The scan runs in EVERY mode (D38): it gates the gate, it does not replace it.
  // Scan the whole file AND the derived card's text, so a secret reaches the same
  // gates whether it arrives in the body, in frontmatter, or via a card-authoring
  // flag (--provenance, --scope, …) — the card ships to the PUBLIC card, so a flag
  // secret must block exactly like an in-file one. Dedupe by check+excerpt so a
  // frontmatter value (present in both raw and the card) is not double-counted.
  // The scan context carries the source project's git remote slugs (offline FS
  // read, best-effort): a draft quoting its own project's repo/org warns as a
  // private-by-default reference (open-questions publishing-safety check-set).
  // Markers derive from the DRAFT's project, not the shell's cwd (review r5): a
  // file publish walks up from the file's own directory, and a parked candidate
  // uses the source project recorded in its meta at park time — the pen lives
  // under ~/.tenjin, so the process cwd is unrelated to the draft on both paths.
  const markerRoot =
    candidate !== undefined
      ? candidate.meta.sourceProject
      : args.file !== undefined
        ? dirname(resolve(cwd, args.file))
        : cwd;
  const scanContext: ScanContext = { projectMarkers: await deriveProjectMarkers(markerRoot) };
  const findings = dedupeFindings([
    ...scan(raw, scanContext),
    ...scan(cardScanText(card), scanContext),
  ]);
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

  // --yes clears the soft findings and the review confirm alike.
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
  // SIWX/session header domain and the POST host, so the two never diverge.
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
  };

  const result = await publishPost(input, auth, {
    baseUrl: runtime.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // A DRAFT answered nobody. It parks the piece privately, so it clears no parked
  // candidate and closes no loop on EITHER path: the draft is still the pending
  // answer, and the later real publish is what resolves both.
  const parksPrivately = status === 'draft';

  // ONLY on a successful publish is the candidate cleared from the pending store
  // (a refusal or a write failure left it parked, above). The clear is BEST-EFFORT:
  // the piece is already published, so a failing drop must NOT report the publish as
  // failed — that would invite a retry and double-publish. Keep ok:true, report
  // cleared:false with a warning, and let the human drop it manually.
  const candidateInfo =
    candidate === undefined
      ? undefined
      : parksPrivately
        ? keepParkedCandidate(ctx, candidate.id)
        : await clearPublishedCandidate(ctx, candidate.id);
  // The strongest way to close a loop: the answer is on the marketplace. A
  // candidate carries the search it answers; a file publish names it with
  // `--search-id`, and without either the loop stays open and the Stop hook keeps
  // the reminder. Local bookkeeping, best-effort, never throws.
  let searchInfo: SearchReceipt | undefined;
  if (candidate !== undefined) {
    if (!parksPrivately) {
      await markSearchResolved(ctx.dataDir, candidate.meta.searchId, 'publish');
    }
  } else if (args.searchId !== undefined) {
    searchInfo = await closeNamedSearch(ctx, args.searchId, storedSearch, parksPrivately, prefill);
  }
  return receipt(result, runtime.baseUrl, candidateInfo, searchInfo);
}

interface CandidateReceipt {
  id: string;
  cleared: boolean;
  warning?: string;
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
  prefill: PrefillOutcome;
}

/**
 * What became of the searched question as a card entry. `none` covers both "no
 * stored question" and "the draft named its own", which are the cases where
 * nothing was expected; `dropped-too-long` is the one a caller has to be told.
 */
type PrefillOutcome = 'applied' | 'dropped-too-long' | 'none';

/**
 * A draft leaves the candidate exactly where it was. The answer is still pending,
 * and the pen is what keeps it visible; `cleared: false` with no `warning` is a
 * deliberate hold, where a warning beside it would mean a clear that failed.
 */
function keepParkedCandidate(ctx: CommandContext, id: string): CandidateReceipt {
  ctx.io.stderr.write(`Saved as a draft, so candidate ${id} stays parked.\n`);
  return { id, cleared: false };
}

async function clearPublishedCandidate(ctx: CommandContext, id: string): Promise<CandidateReceipt> {
  try {
    if (await dropCandidate(ctx.dataDir, id)) return { id, cleared: true };
    // The dir was already gone (a concurrent drop): nothing to clear, not an error.
    const warning = `Published, but candidate ${id} was already gone; nothing to clear.`;
    ctx.io.stderr.write(`${warning}\n`);
    return { id, cleared: false, warning };
  } catch (err) {
    const warning = `Published successfully, but could not clear candidate ${id}: ${errorMessage(err)}. Remove it with \`tenjin candidate drop ${id}\`.`;
    ctx.io.stderr.write(`${warning}\n`);
    return { id, cleared: false, warning };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `--search-id` at the edge: the same uuid shape `candidate add` enforces, and
 * never alongside `--candidate`, which already carries the search it answers.
 * Refusing the pair beats silently picking one of two ids.
 */
function validateSearchId(args: PublishArgs): void {
  if (args.searchId === undefined) return;
  if (args.candidate !== undefined) {
    throw new CliError('USAGE', 'Pass EITHER --search-id or --candidate, not both.', {
      fix: 'A candidate already names the search it answers; drop --search-id.',
    });
  }
  if (!UUID_RE.test(args.searchId)) {
    throw new CliError('USAGE', `Invalid --search-id: ${JSON.stringify(args.searchId)}.`, {
      fix: 'Pass the searchId from a prior `tenjin search` (a uuid).',
    });
  }
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
 * `closed: true` describes the LOOP, not this call: `markSearchResolved` keeps
 * the first resolution, so a search an `outcome` already closed reports closed
 * here too, which is what the caller is actually asking about. It reports the
 * OUTCOME of the write rather than the intent to write, so a swallowed lock
 * timeout comes back as `closed: false` and a stderr line instead of a receipt
 * claiming a close that never landed.
 */
async function closeNamedSearch(
  ctx: CommandContext,
  searchId: string,
  stored: StoredSearch | null,
  parksPrivately: boolean,
  prefill: PrefillOutcome,
): Promise<SearchReceipt> {
  const open = (reason: string): SearchReceipt => {
    ctx.io.stderr.write(`${reason}\n`);
    return { id: searchId, closed: false, prefill };
  };
  if (parksPrivately) return open(`Saved as a draft, so search ${searchId} stays open.`);
  if (stored === null) {
    return open(`Published, but search ${searchId} is not in the local store.`);
  }
  const outcome = await markSearchResolved(ctx.dataDir, searchId, 'publish');
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
  return { id: searchId, closed: true, prefill };
}

/**
 * Resolve the publish source: a <file>, or a --candidate's draft.md, exclusively.
 * Both or neither is USAGE, and a malformed/unknown candidate id is USAGE before
 * any wallet touch — the whole point of parking it locally is to fail cheap here.
 */
async function resolveSource(
  args: PublishArgs,
  dataDir: string,
): Promise<{ raw: string; candidate?: CandidateRecord }> {
  if (args.candidate !== undefined) {
    if (args.file !== undefined) {
      throw new CliError('USAGE', 'Pass EITHER a file or --candidate, not both.', {
        fix: 'Publish a file with `tenjin publish post.md`, or a candidate with `--candidate <id>`.',
      });
    }
    if (!UUID_RE.test(args.candidate)) {
      throw new CliError('USAGE', `Invalid candidate id: ${JSON.stringify(args.candidate)}`, {
        fix: 'Pass a candidate id from `tenjin candidate list`.',
      });
    }
    // Read-then-act (read here, drop after a successful publish) is not atomic, but
    // the candidate store is a single-user local dir; a concurrent drop between the
    // two is accepted, and the post-success clear is best-effort anyway.
    const record = await readCandidate(dataDir, args.candidate);
    if (record === null) {
      throw new CliError('USAGE', `Unknown candidate: ${JSON.stringify(args.candidate)}`, {
        fix: 'List parked candidates with `tenjin candidate list`.',
      });
    }
    return { raw: await readDraft(record), candidate: record };
  }
  if (args.file === undefined) {
    throw new CliError('USAGE', 'Nothing to publish.', {
      fix: 'Pass a Markdown file (`tenjin publish post.md`) or `--candidate <id>`.',
    });
  }
  return { raw: await readMarkdown(args.file) };
}

/** Read a candidate's draft.md; a readable dir with an unreadable draft is a torn
 *  candidate (INTERNAL), not the caller's usage error. */
async function readDraft(record: CandidateRecord): Promise<string> {
  try {
    return await readFile(record.draftPath, 'utf8');
  } catch (err) {
    throw new CliError('INTERNAL', `Candidate ${record.id} is missing its draft.`, {
      fix: `Drop it with \`tenjin candidate drop ${record.id}\` and re-add the draft.`,
      cause: err,
    });
  }
}

function receipt(
  result: Awaited<ReturnType<typeof publishPost>>,
  baseUrl: string,
  candidateInfo?: CandidateReceipt,
  searchInfo?: SearchReceipt,
): CommandResult {
  const price = toMoney(result.priceAtomic);
  const missing = missingSentences(result.cacheEligibleMissing).map(sanitizeForTerminal);
  const cacheEligible = result.cacheEligible ?? false;
  const deskUrl = `${trimSlash(baseUrl)}/desk`;
  const title = sanitizeForTerminal(result.title);
  // status and url are server-sent open strings (posts-api declares both as bare
  // z.string()), so they get the same treatment as the title beside them: this
  // line is what an author reads to learn where their piece went.
  const human = [
    `Published ${title} (${sanitizeForTerminal(result.status)}) for ${price.usd} USD → ${sanitizeForTerminal(result.url)}`,
    cacheEligible
      ? 'Answer card is search-eligible.'
      : missing.length > 0
        ? `Answer card not search-eligible yet: ${missing.join(' ')}`
        : 'Published as a browse-only document (no answer card).',
    ...(candidateInfo?.cleared === true ? [`Cleared candidate ${candidateInfo.id}.`] : []),
    ...(searchInfo?.closed === true ? [`Closed the loop on search ${searchInfo.id}.`] : []),
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
      ...(candidateInfo !== undefined ? { candidate: candidateInfo } : {}),
      ...(searchInfo !== undefined ? { search: searchInfo } : {}),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    },
    humanLines: human,
  };
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

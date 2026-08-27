import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings } from '../lib/settings';
import { parsePublishModeFlag, type PublishMode } from '../lib/config';
import { UUID_RE } from '../lib/ids';
import { scan, survivesTeamDrop, type ScanContext, type ScanFinding } from '../lib/scan';
import { deriveProjectMarkers } from '../lib/scan-context';
import { sanitizeForTerminal } from '../lib/output';
import {
  deriveCard,
  missingSentences,
  parseAppliesToFlags,
  parseFrontmatter,
  type CardFlags,
  type ResourceCardInput,
} from '../lib/card';
import {
  buildPostUpdateBody,
  getOwnPost,
  updatePost,
  type OwnPost,
  type OwnPostCard,
  type PostUpdateInput,
  type PublishStatus,
  type ResourceCardUpdate,
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
import { parseScanSuccessReport, scanNoteLines, scanReceipt } from '../lib/scan-gate';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin edit <postId>`: the agent-side twin of the web answer-card panel. With
 * no change flags it READS the owner-scoped post and prints it; with change flags
 * it merge-updates via `PUT /api/posts/<id>` — omitted key = keep, `--clear` sends
 * the explicit null (or the empty container) the server's merge clears on, and an
 * array flag REPLACES the stored array wholesale (`--add-question` is the append
 * convenience that reads first and sends the merged array).
 *
 * The gates are publish's, deliberately: the same deterministic scan over the new
 * body + card text (a live secret hard-blocks in every mode), the same team-mode
 * narrowing of that scan, and the same publish.mode consent cascade, because an
 * edit ships content to the same page a publish does — the public marketplace,
 * or on a team shelf the team page a publish just wrote.
 *
 * `--status draft|published` is the reversible half of taking a piece back
 * (`tenjin delete` is the other, and confirms in every mode because destroying is
 * not what publish.mode consented to). It is an ordinary change flag here: it
 * diffs, it prunes when it matches, and it rides the same consent gate, since
 * promoting a draft IS putting content up and demoting is the same lever pulled
 * the safe way.
 *
 * Unlike publish, the wallet is touched BEFORE consent, and that is a real
 * tradeoff, not a technicality: the before→after summary the user approves can
 * only be built from the stored post, and reading it is owner-scoped. The read
 * changes nothing on the server and burns no nonce, but on first use it
 * establishes a session key, so one wallet signature and a delegation persisted to
 * `~/.tenjin/session.json` precede any approval. What that delegation can DO is
 * scoped to the run: a no-flag show mints `read`, and only an invocation that
 * intends to write asks for `read+write`. We accept the remaining cost, because
 * the alternative is asking a human to approve a diff we cannot show them.
 *
 * Exit codes: 0 success (and the read-only show), 2 usage, 3 needs_confirmation /
 * non-bypassable publish_blocked, 4 a write failure after approval.
 */

export interface EditArgs {
  /** The post uuid to edit. */
  postId: string;
  /** Card array flags: REPLACE the stored array wholesale. */
  question?: string[];
  task?: string[];
  /** Append convenience: read the stored array, add, dedupe, send the merged array. */
  addQuestion?: string[];
  addTask?: string[];
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
   * `draft` or `published`: unpublish, or put a draft up. Raw at the edge and
   * validated there (USAGE on anything else), like `--mode`.
   */
  status?: string;
  /** Post fields. */
  title?: string;
  /** Post price, decimal USD at the edge (O1). */
  price?: string;
  /** A Markdown file whose body (frontmatter stripped) replaces the stored body. */
  body?: string;
  excerpt?: string;
  /** Card fields to clear (repeatable); see CLEAR_FIELDS. */
  clear?: string[];
  yes?: boolean;
  /** Raw `--mode` (review|auto|full-auto); validated at the edge (USAGE on a bad value). */
  mode?: string;
}

export interface EditDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  /** Force the plain-SIWX write path (default: session key unless TENJIN_NO_SESSION=1). */
  useSession?: boolean;
  /** Environment seam (mode, base-url, TENJIN_NO_SESSION); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the `.tenjin.json` walk; defaults to process.cwd(). */
  cwd?: string;
  /**
   * Force the answer to the server gate's warn tier, whatever `publish.mode` and
   * `publish.ackServerWarnings` say; the same seam `PublishDeps` carries, for the
   * same unattended callers. `false` never acks.
   */
  ackServerWarnings?: boolean;
}

export async function runEdit(
  args: EditArgs,
  ctx: CommandContext,
  deps: EditDeps = {},
): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  if (!UUID_RE.test(args.postId)) {
    throw new CliError('USAGE', `Invalid post id: ${JSON.stringify(args.postId)}`, {
      fix: 'Pass the post uuid from `tenjin publish`’s receipt or your desk.',
    });
  }
  // A mistyped --mode must never silently land on a looser mode and apply an edit
  // unconfirmed; validate it at the edge, exactly as publish does.
  if (args.mode !== undefined) parsePublishModeFlag(args.mode, '--mode');
  // Every edge check that can fail on the FLAGS alone runs before the wallet: a
  // typo must cost nothing, not a signature and a round trip.
  rejectEmptyValues(args);
  assertAppendExclusivity(args);
  const status = args.status !== undefined ? parseStatusFlag(args.status) : undefined;
  const clears = parseClears(args);
  const cardFlags = cardFlagsFrom(args);
  const priceAtomic = args.price !== undefined ? parseUsdToAtomic(args.price) : undefined;
  const bodyFile = args.body !== undefined ? await readBodyFile(args.body) : undefined;
  const wantsChange = hasChangeFlags(args);

  const runtime = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // surfaces WALLET_MISSING with its own fix
  const signer = await provider.getSigner();
  // Least privilege, decided before the wallet is asked for anything: a show is a
  // READ, so it mints a read-scoped delegation rather than leaving a write-capable
  // one on disk for a command that never writes. A cached read+write session still
  // serves it, so this costs no extra signature.
  const auth = resolveWriteAuth({
    signer,
    baseUrl: runtime.baseUrl,
    dataDir: ctx.dataDir,
    scope: wantsChange ? 'read+write' : 'read',
    ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
    env,
  });
  const client = {
    baseUrl: runtime.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(runtime.bypass !== undefined ? { bypass: runtime.bypass } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  const stored = await getOwnPost(args.postId, auth, client);
  if (!wantsChange) return showReceipt(stored);

  // The append path merges onto the STORED array (exact-string dedupe) and sends
  // the result: the server replaces arrays wholesale, so there is no append there.
  if (args.addQuestion !== undefined && args.addQuestion.length > 0) {
    cardFlags.question = appendUnique(storedList(stored, 'questionsAnswered'), args.addQuestion);
  }
  if (args.addTask !== undefined && args.addTask.length > 0) {
    cardFlags.task = appendUnique(storedList(stored, 'tasksSupported'), args.addTask);
  }

  // deriveCard validates the set fields against the server's bounds and reports
  // them under the same dotted `resource.<field>` keys the server would.
  const intent: PostUpdateInput = {
    ...(status !== undefined ? { status } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(bodyFile !== undefined ? { bodyMd: bodyFile.body } : {}),
    ...(args.excerpt !== undefined ? { excerpt: args.excerpt } : {}),
    ...(priceAtomic !== undefined ? { priceAtomic } : {}),
    ...withClears(deriveCard({}, cardFlags), clears, stored.resource),
  };

  // Diff before deciding anything: a no-op edit is not an edit. With nothing left
  // after pruning there is nothing to confirm, nothing new to scan, and no reason
  // to burn a nonce on a write that changes nothing. Exit 0 with the current post.
  const { input, lines: changes } = diffUpdate(stored, intent);
  if (changes.length === 0) return noChangeReceipt(stored);
  // Bounds-check the pruned body here so a miss is USAGE before the consent
  // prompt; updatePost rebuilds the same body for the wire (pure, so identical).
  buildPostUpdateBody(input);

  const settings = await resolvePublishSettings({
    dataDir: ctx.dataDir,
    cwd,
    ...(args.mode !== undefined ? { flag: args.mode } : {}),
    env,
  });
  writeModeNotices(
    ctx.io.stderr,
    settings,
    env,
    'each edit asks you once. Set auto to apply clean edits automatically',
  );

  // Gate parity with publish (#38): the source project's own git remote slugs are
  // private-by-default, so text quoting them warns. Markers derive from the
  // CONTENT's project — the body file's own directory when there is one, else the
  // working directory — never from wherever the shell happens to be.
  const markerRoot = args.body !== undefined ? dirname(resolve(cwd, args.body)) : cwd;
  const scanContext: ScanContext = { projectMarkers: await deriveProjectMarkers(markerRoot) };
  // The scan covers exactly what this edit SHIPS: the typed text behind the keys
  // that survived pruning, plus the body file only when the body itself survived.
  // Scanning the raw flags instead would block on a value that prunes away — a
  // secret already public in the stored scope, restated verbatim, would refuse an
  // unrelated title change while the same flags alone exit 0. A secret in a
  // surviving value still blocks in every mode, never cleared by --yes.
  const scanned = dedupeFindings([
    ...(input.bodyMd !== undefined ? scan(bodyFile?.raw ?? '', scanContext) : []),
    ...scan(shippedTypedText(args, input), scanContext),
  ]);
  // THE SAME TEAM-MODE NARROWING PUBLISH DOES, and for the same reason: the warn
  // tier asks "is this safe to make PUBLIC", and a team shelf is not public, so a
  // repo slug is the point of a team note rather than a leak. The credential checks
  // survive with the block tier because they ask a question the audience does not
  // change; which ones those are is a `teamSurvives` flag on the rule in
  // scan-rules.json rather than a list in code. Without this, an author publishes a team note carrying its
  // own repo slug silently under `auto` and then gets NEEDS_CONFIRMATION on that
  // same string when fixing a typo in it — the --yes round trip the drop exists to
  // remove, moved to the second command. The two filters are the one
  // `survivesTeamDrop` predicate (lib/scan.ts) so they cannot disagree; publish.ts
  // is where the full reasoning lives.
  const findings = runtime.teamMode ? scanned.filter(survivesTeamDrop) : scanned;
  const blocking = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (blocking.length > 0) {
    throw new CliError('PUBLISH_BLOCKED', blockMessage(blocking), {
      fix: 'Remove the secret from the new content (it is never masked away by --yes), then re-run.',
      details: { mode: settings.mode, findings: blocking.map(publicFinding) },
    });
  }

  const notes = editNotes(args, stored, bodyFile, clears);
  for (const line of [...notes, ...changes]) ctx.io.stderr.write(`${line}\n`);

  if (needsConfirmation(settings.mode, warns.length) && args.yes !== true) {
    throw new CliError('NEEDS_CONFIRMATION', confirmMessage(warns.length, changes.length), {
      fix: 'Review the changes, then re-run with --yes.',
      details: {
        mode: settings.mode,
        postId: stored.id,
        title: sanitizeForTerminal(stored.title),
        changes,
        ...(notes.length > 0 ? { notes } : {}),
        findings: warns.map(publicFinding),
      },
    });
  }

  // The server ingest gate covers the edit path too (it sits in the shared write
  // path, not in the publish route), so its warn tier joins this command's
  // exit-3 flow instead of arriving as an opaque exit-4 write failure.
  const updated = await throughScanGate({
    send: (scanAck) =>
      updatePost(args.postId, scanAck === undefined ? input : { ...input, scanAck }, auth, client),
    localWarns: warns,
    mode: settings.mode,
    yes: args.yes === true,
    ackSetting: settings.ackServerWarnings,
    ...(deps.ackServerWarnings !== undefined ? { ackOverride: deps.ackServerWarnings } : {}),
    detail: { mode: settings.mode, postId: stored.id, changes },
    noun: 'Edit',
  });
  return updateReceipt(updated, changes, notes, settings.mode);
}

// ---------------------------------------------------------------------------
// Receipts.
// ---------------------------------------------------------------------------

/** The read half of the loop: the stored post + card, owner view. */
function showReceipt(post: OwnPost): CommandResult {
  const price = toMoney(post.price);
  const card = post.resource;
  const lines = [
    `${sanitizeForTerminal(post.title)} (${sanitizeForTerminal(post.status)}), ${price.usd} USD (${price.atomic} atomic)`,
    `url: ${sanitizeForTerminal(post.url)}`,
    ...(hasText(post.excerpt) ? [`excerpt: ${preview(post.excerpt)}`] : []),
    ...cardLines(card),
    eligibilityLine(card),
  ];
  return { data: post, humanLines: lines };
}

/**
 * The applied-update receipt. `changes` (and `notes`) are mirrored INTO the data
 * as well as printed, the way publish mirrors its stderr warnings into the
 * receipt: an MCP client gets a discard sink for stderr, so a summary that lives
 * only there is a summary it can never show the user. `changes: []` is the
 * unambiguous machine signal that nothing was written.
 */
function updateReceipt(
  post: OwnPost,
  changes: string[],
  notes: string[],
  mode: PublishMode,
): CommandResult {
  const card = post.resource;
  // The gate's advisory report rides the response as a raw `scan` field; replace
  // it in the receipt with the normalized shape so both writing commands report
  // findings identically, and drop it when the server sent none.
  const report = parseScanSuccessReport(post);
  const lines = [
    `Updated ${sanitizeForTerminal(post.title)} → ${sanitizeForTerminal(post.url)}`,
    eligibilityLine(card),
    ...scanNoteLines(report ?? undefined),
    ...(post.warnings ?? []).map((w) => `warning: ${sanitizeForTerminal(w)}`),
  ];
  // `mode` is echoed because a per-call --mode (or the MCP `mode` argument) is
  // otherwise invisible in a transcript: the receipt would look identical
  // whether the caller loosened the gate for this run or not.
  const data: Record<string, unknown> = {
    ...post,
    mode,
    changes,
    ...(notes.length > 0 ? { notes } : {}),
  };
  if (report !== null) data.scan = scanReceipt(report);
  else delete data.scan;
  return { data, humanLines: lines };
}

/** Nothing to write: the post as it stands, and an empty change list to prove it. */
function noChangeReceipt(post: OwnPost): CommandResult {
  return {
    data: { ...post, changes: [] },
    humanLines: [
      `No changes: every value given already matches ${sanitizeForTerminal(post.title)}. Nothing was written.`,
    ],
  };
}

/** The card fields that are set, one per line; nothing for a post with no card. */
function cardLines(card: OwnPostCard | undefined): string[] {
  if (card === undefined) return [];
  const lines: string[] = [];
  const list = (label: string, values: string[] | null | undefined): void => {
    if (values !== undefined && values !== null && values.length > 0) {
      lines.push(
        `${label} (${values.length}): ${values.map((v) => sanitizeForTerminal(v)).join(' | ')}`,
      );
    }
  };
  list('questionsAnswered', card.questionsAnswered);
  list('tasksSupported', card.tasksSupported);
  for (const [label, value] of [
    ['scope', card.scope],
    ['exclusions', card.exclusions],
    ['artifactType', card.artifactType],
    ['temporalMode', card.temporalMode],
    ['asOf', card.asOf],
    ['validUntil', card.validUntil],
    ['provenance', card.provenanceSummary],
    ['methodology', card.methodologySummary],
    ['supersedesPostId', card.supersedesPostId],
  ] as const) {
    if (hasText(value)) lines.push(`${label}: ${preview(value)}`);
  }
  if (card.appliesTo !== undefined && card.appliesTo !== null) {
    for (const [key, values] of Object.entries(card.appliesTo)) {
      lines.push(
        `appliesTo ${sanitizeForTerminal(key)}: ${values.map((v) => sanitizeForTerminal(v)).join(', ')}`,
      );
    }
  }
  return lines;
}

function eligibilityLine(card: OwnPostCard | undefined): string {
  if (card === undefined) return 'No answer card: ranks below every carded piece in agent search.';
  const missing = missingSentences(card.cacheEligibleMissing).map(sanitizeForTerminal);
  if (card.cacheEligible) return 'Answer card is search-eligible.';
  return missing.length > 0
    ? `Answer card incomplete, ranks below every complete card in agent search. To fix: ${missing.join(' ')}`
    : 'Answer card incomplete, ranks below every complete card in agent search.';
}

// ---------------------------------------------------------------------------
// The before→after summary.
// ---------------------------------------------------------------------------

/**
 * Diff what the flags ASK for against what is stored, and return both the terse
 * summary and an input pruned to the fields that actually move.
 *
 * Pruning is not cosmetic. A card key that rides along unchanged still counts as a
 * card write server-side, which re-runs the embedding for a card nobody edited;
 * and on a post with NO card, a lone `scope: null` mints an all-default card row,
 * turning a card-less post into a card-bearing one. Comparing first and
 * sending only the difference is what keeps `edit` idempotent.
 */
function diffUpdate(
  stored: OwnPost,
  intent: PostUpdateInput,
): { input: PostUpdateInput; lines: string[] } {
  const lines: string[] = [];
  const input: PostUpdateInput = {};

  // Status leads the summary because it is the change that decides whether the
  // rest is public at all. It takes the SAME publish.mode consent every other
  // change here takes, deliberately: promoting a draft is putting content up,
  // which is what the mode is consent for, and demoting to draft is the safe
  // direction of the same lever. No re-scan rides with it — a status flip ships
  // no new text, and the stored body was scanned when it was written.
  if (intent.status !== undefined && intent.status !== stored.status) {
    input.status = intent.status;
    lines.push(`status: ${sanitizeForTerminal(stored.status)} → ${intent.status}`);
  }

  // Both sides trimmed, because the server trims these before storing them: an
  // untrimmed compare would call " x" a change from "x" forever.
  const title = intent.title?.trim();
  if (title !== undefined && title !== stored.title) {
    input.title = title;
    lines.push(`title: ${preview(stored.title)} → ${preview(title)}`);
  }
  if (intent.priceAtomic !== undefined && intent.priceAtomic !== stored.price) {
    const before = toMoney(stored.price);
    const after = toMoney(intent.priceAtomic);
    input.priceAtomic = intent.priceAtomic;
    lines.push(
      `price: ${before.usd} USD (${before.atomic} atomic) → ${after.usd} USD (${after.atomic} atomic)`,
    );
  }
  if (intent.bodyMd !== undefined && intent.bodyMd !== stored.bodyMd) {
    input.bodyMd = intent.bodyMd;
    lines.push(`body: ${(stored.bodyMd ?? '').length} → ${intent.bodyMd.length} characters`);
  }
  const excerpt = intent.excerpt?.trim();
  if (excerpt !== undefined && excerpt !== (stored.excerpt ?? '')) {
    input.excerpt = excerpt;
    lines.push(`excerpt: ${preview(stored.excerpt)} → ${preview(excerpt)}`);
  }

  const card = diffCard(stored.resource, intent.resource);
  lines.push(...card.lines);
  if (card.card !== undefined) input.resource = card.card;

  // Empty means EMPTY: the caller reads no lines as "this edit is a no-op" and
  // skips the write, so a sentinel line here would report a change that isn't one.
  return { input, lines };
}

/**
 * How each card key is diffed. The Record over `keyof ResourceCardUpdate` is the
 * point: adding a field to the card type without saying how it diffs is a compile
 * error here, not a field that silently never reaches the wire. `none` marks a
 * field no flag and no clear can set today, so it can never appear in `next`;
 * giving one a flag means moving it to a real pass.
 */
type CardPass = 'list' | 'iso' | 'scalar' | 'map' | 'none';
const CARD_PASS = {
  questionsAnswered: 'list',
  tasksSupported: 'list',
  asOf: 'iso',
  validUntil: 'iso',
  scope: 'scalar',
  exclusions: 'scalar',
  artifactType: 'scalar',
  temporalMode: 'scalar',
  provenanceSummary: 'scalar',
  methodologySummary: 'scalar',
  supersedesPostId: 'scalar',
  appliesTo: 'map',
  mediaType: 'none',
  maintenanceCadence: 'none',
  reproductionMinutes: 'none',
  estimatedPaidInputCost: 'none',
} as const satisfies Record<keyof ResourceCardUpdate, CardPass>;

/** The card keys assigned to one pass, as a union of literal keys. */
type KeysIn<P extends CardPass> = {
  [K in keyof typeof CARD_PASS]: (typeof CARD_PASS)[K] extends P ? K : never;
}[keyof typeof CARD_PASS];

function keysIn<P extends CardPass>(pass: P): KeysIn<P>[] {
  return Object.entries(CARD_PASS)
    .filter(([, value]) => value === pass)
    .map(([key]) => key) as KeysIn<P>[];
}

/** The two card keys whose flag name differs from the field name. */
const CARD_LABEL: Partial<Record<keyof ResourceCardUpdate, string>> = {
  provenanceSummary: 'provenance',
  methodologySummary: 'methodology',
};
function cardLabel(key: keyof ResourceCardUpdate): string {
  return CARD_LABEL[key] ?? key;
}

/**
 * The card half of the diff. Every comparison treats an ABSENT stored value as
 * already-cleared, which is what makes clearing a field on a cardless post the
 * no-op it should be rather than a card-creating write.
 */
function diffCard(
  stored: OwnPostCard | undefined,
  next: ResourceCardUpdate | undefined,
): { card?: ResourceCardUpdate; lines: string[] } {
  const lines: string[] = [];
  const card: Record<string, unknown> = {};
  const keep = (key: keyof ResourceCardUpdate, value: unknown, line: string): void => {
    card[key] = value;
    lines.push(line);
  };
  if (next === undefined) return { lines };

  // Lists replace wholesale, so order counts; an absent stored list reads as empty.
  for (const key of keysIn('list')) {
    const after = next[key];
    if (after === undefined) continue;
    const old = stored?.[key] ?? [];
    if (sameList(old, after)) continue;
    const added = after.filter((v) => !old.includes(v));
    const detail =
      after.length === 0 ? ' (cleared)' : added.length > 0 ? ` (new: ${previewList(added)})` : '';
    keep(key, after, `${key}: ${old.length} → ${after.length}${detail}`);
  }

  // The timestamps compare as INSTANTS and are sent canonicalized. The server
  // echoes a timestamptz through toISOString(), while a flag carries whatever the
  // user typed, so "2026-07-01T00:00:00Z" and "2026-07-01T00:00:00.000Z" are the
  // same moment spelled two ways — comparing the spellings would re-write the
  // field on every single run.
  for (const key of keysIn('iso')) {
    const after = next[key];
    if (after === undefined) continue;
    const from = isoInstant(stored?.[key]);
    const to = isoInstant(after);
    if (from === to) continue;
    keep(key, to, `${key}: ${preview(from)} → ${to === null ? '(cleared)' : preview(to)}`);
  }

  for (const key of keysIn('scalar')) {
    const after = next[key];
    if (after === undefined) continue;
    const from = stored?.[key] ?? null;
    if (from === after) continue;
    keep(
      key,
      after,
      `${cardLabel(key)}: ${preview(from)} → ${after === null ? '(cleared)' : preview(after)}`,
    );
  }

  // appliesTo is one value, not a key count: a same-size swap (products=Base →
  // products=Vercel) has identical counts on both sides, so a count compare would
  // call a real change a no-op and a count RENDER would print it as one.
  for (const key of keysIn('map')) {
    const after = next[key];
    if (after === undefined) continue;
    const before = stored?.[key] ?? {};
    if (sameAppliesTo(before, after)) continue;
    keep(key, after, `${key}: ${appliesToPreview(before)} → ${appliesToPreview(after)}`);
  }

  return { ...(Object.keys(card).length > 0 ? { card: card as ResourceCardUpdate } : {}), lines };
}

/**
 * A timestamp as its canonical instant, so two spellings of one moment compare
 * equal. An unparseable value (never from a flag — validateIso ran — but possible
 * from a future server format) passes through rather than being silently dropped.
 */
function isoInstant(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/** Map equality: keys order-insensitive, each key's values order-sensitive. */
function sameAppliesTo(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (!sameList(aKeys, bKeys)) return false;
  return aKeys.every((key) => sameList(a[key] ?? [], b[key] ?? []));
}

/** The advisory notes a --body edit needs, in the order a human reads them. */
function editNotes(
  args: EditArgs,
  stored: OwnPost,
  bodyFile: BodyFile | undefined,
  clears: ClearField[],
): string[] {
  if (bodyFile === undefined) return [];
  const notes: string[] = [];
  if (bodyFile.hadFrontmatter) {
    notes.push(
      'note: frontmatter in the body file was ignored; metadata changes only through flags.',
    );
  }
  if (args.excerpt === undefined) {
    notes.push(
      `note: the excerpt stays as-is (${preview(stored.excerpt)}) and remains lexically indexed; the server does not re-derive it. Pass --excerpt to change it.`,
    );
  }
  // Only when asOf really is staying put: a run that clears it is already saying
  // so in the summary, and both lines together would contradict each other.
  const asOfMoves = args.asOf !== undefined || clears.includes('asOf');
  if (stored.resource?.temporalMode === 'snapshot' && !asOfMoves) {
    notes.push(
      `note: asOf is unchanged (${preview(stored.resource.asOf)}) on this snapshot card, and search freshness gating uses it. Pass --as-of to move it.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Flag parsing + validation.
// ---------------------------------------------------------------------------

/** The card fields `--clear` accepts, named as the flag that sets each one. */
const CLEAR_FIELDS = [
  'scope',
  'exclusions',
  'asOf',
  'validUntil',
  'provenance',
  'methodology',
  'supersedesPostId',
  'questionsAnswered',
  'tasksSupported',
  'appliesTo',
] as const;
type ClearField = (typeof CLEAR_FIELDS)[number];

/** clear name → the card key it targets. */
const CLEAR_KEY = {
  scope: 'scope',
  exclusions: 'exclusions',
  asOf: 'asOf',
  validUntil: 'validUntil',
  provenance: 'provenanceSummary',
  methodology: 'methodologySummary',
  supersedesPostId: 'supersedesPostId',
  questionsAnswered: 'questionsAnswered',
  tasksSupported: 'tasksSupported',
  appliesTo: 'appliesTo',
} as const satisfies Record<ClearField, keyof ResourceCardUpdate>;

/**
 * clear name → the value that clears its key server-side. Each value is typed as
 * the card field it lands on, so sending the wrong shape (a null where the merge
 * clears with `[]`, or an `[]` where it wants null) is a compile error, not a
 * validation_failed discovered in production.
 */
const CLEAR_VALUE: { [F in ClearField]: ResourceCardUpdate[(typeof CLEAR_KEY)[F]] } = {
  scope: null,
  exclusions: null,
  asOf: null,
  validUntil: null,
  provenance: null,
  methodology: null,
  supersedesPostId: null,
  questionsAnswered: [],
  tasksSupported: [],
  appliesTo: {},
};

/** clear name → the set-flags that would contradict it in the same invocation. */
const CLEAR_CONFLICTS: Record<ClearField, Array<keyof EditArgs>> = {
  scope: ['scope'],
  exclusions: ['exclusions'],
  asOf: ['asOf'],
  validUntil: ['validUntil'],
  provenance: ['provenance'],
  methodology: ['methodology'],
  supersedesPostId: [],
  questionsAnswered: ['question', 'addQuestion'],
  tasksSupported: ['task', 'addTask'],
  appliesTo: ['appliesTo'],
};

/** The CLI spelling of each arg key, for error messages. */
const FLAG_NAME: Record<string, string> = {
  status: '--status',
  question: '--question',
  task: '--task',
  addQuestion: '--add-question',
  addTask: '--add-task',
  scope: '--scope',
  exclusions: '--exclusions',
  appliesTo: '--applies-to',
  asOf: '--as-of',
  validUntil: '--valid-until',
  artifactType: '--artifact-type',
  temporalMode: '--temporal-mode',
  provenance: '--provenance',
  methodology: '--methodology',
  title: '--title',
  price: '--price',
  body: '--body',
  excerpt: '--excerpt',
};

const CHANGE_KEYS: Array<keyof EditArgs> = [
  'status',
  'question',
  'task',
  'addQuestion',
  'addTask',
  'scope',
  'exclusions',
  'appliesTo',
  'asOf',
  'validUntil',
  'artifactType',
  'temporalMode',
  'provenance',
  'methodology',
  'title',
  'price',
  'body',
  'excerpt',
  'clear',
];

function hasChangeFlags(args: EditArgs): boolean {
  return CHANGE_KEYS.some((key) => {
    const value = args[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
}

/**
 * An explicit empty value is refused for every set-flag: `--scope ""` reads as
 * "clear the scope", but only `--clear scope` sends the null that clears it, and a
 * silently-sent empty string would set a blank field instead. One spelling per
 * intent, no ambiguity.
 */
function rejectEmptyValues(args: EditArgs): void {
  for (const [key, flag] of Object.entries(FLAG_NAME)) {
    const value = args[key as keyof EditArgs];
    const empties =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((v) => typeof v === 'string')
          : [];
    for (const v of empties) {
      if (v.trim().length === 0) {
        const clearable = (CLEAR_FIELDS as readonly string[]).includes(clearNameFor(key));
        throw new CliError('USAGE', `${flag} cannot be empty.`, {
          fix: clearable
            ? `Pass a value, or clear the field with \`--clear ${clearNameFor(key)}\`.`
            : 'Pass a value, or omit the flag to keep the stored one.',
        });
      }
    }
  }
}

/** The `--clear` name a set-flag arg key corresponds to (identity where they match). */
function clearNameFor(key: string): string {
  if (key === 'question' || key === 'addQuestion') return 'questionsAnswered';
  if (key === 'task' || key === 'addTask') return 'tasksSupported';
  return key;
}

function assertAppendExclusivity(args: EditArgs): void {
  const both = (a: string[] | undefined, b: string[] | undefined): boolean =>
    a !== undefined && a.length > 0 && b !== undefined && b.length > 0;
  if (both(args.question, args.addQuestion)) {
    throw new CliError('USAGE', 'Pass either --question or --add-question, not both.', {
      fix: '--question replaces the stored questions; --add-question appends to them.',
    });
  }
  if (both(args.task, args.addTask)) {
    throw new CliError('USAGE', 'Pass either --task or --add-task, not both.', {
      fix: '--task replaces the stored tasks; --add-task appends to them.',
    });
  }
}

/**
 * The two statuses this flag moves a post between, validated at the edge so a
 * typo is USAGE before the wallet is touched.
 *
 * Narrower than the server's status vocabulary on purpose: `unlisted` exists
 * there, but no CLI verb produces it (`publish --draft` is the only other status
 * this tool ever sets), so accepting it here would ship a value nothing in this
 * repo exercises. Widening it is a deliberate edit, not an omission.
 */
const STATUS_FLAG_VALUES = ['draft', 'published'] as const;

function parseStatusFlag(raw: string): PublishStatus {
  const value = raw.trim();
  if ((STATUS_FLAG_VALUES as readonly string[]).includes(value)) return value as PublishStatus;
  throw new CliError('USAGE', `Invalid --status: ${JSON.stringify(raw)}`, {
    fix: `--status takes ${STATUS_FLAG_VALUES.join(' or ')}. Use draft to unpublish, published to put a draft up.`,
  });
}

function parseClears(args: EditArgs): ClearField[] {
  const raw = args.clear ?? [];
  const out: ClearField[] = [];
  for (const name of raw) {
    if (!(CLEAR_FIELDS as readonly string[]).includes(name)) {
      throw new CliError('USAGE', `Cannot clear ${JSON.stringify(name)}.`, {
        fix: `Clearable fields: ${CLEAR_FIELDS.join(', ')}.`,
      });
    }
    const field = name as ClearField;
    for (const key of CLEAR_CONFLICTS[field]) {
      const value = args[key];
      const given = Array.isArray(value) ? value.length > 0 : value !== undefined;
      if (given) {
        throw new CliError(
          'USAGE',
          `--clear ${field} contradicts ${FLAG_NAME[key as string] ?? String(key)}.`,
          { fix: 'Set the field or clear it, not both in the same run.' },
        );
      }
    }
    if (!out.includes(field)) out.push(field);
  }
  return out;
}

function cardFlagsFrom(args: EditArgs): CardFlags {
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
 * The card this edit ASKS for: the validated set fields plus the clears. Built
 * from an allowlist (deriveCard's output keys and CLEAR_KEY) and never from a
 * spread of the GET, so a server-owned key (cacheEligible, cacheEligibleMissing,
 * schemaVersion) cannot reach a strictObject body that would reject it.
 *
 * What actually protects the server's D14 invariant (no card row on a card-less
 * post) is diffCard: it defaults an absent stored value to already-cleared, so a
 * clear on a post with no card compares equal and prunes away. Dropping the clears
 * here as well is a deliberate redundant backstop, one step earlier and local to
 * the one condition that matters, because the cost of that invariant breaking is a
 * plain document silently becoming card-bearing.
 */
function withClears(
  set: ResourceCardInput | undefined,
  clears: ClearField[],
  stored: OwnPostCard | undefined,
): { resource?: ResourceCardUpdate } {
  const applicable = stored !== undefined ? clears : [];
  if (set === undefined && applicable.length === 0) return {};
  const card: Record<string, unknown> = { ...(set ?? {}) };
  for (const name of applicable) {
    card[CLEAR_KEY[name]] = CLEAR_VALUE[name];
  }
  return Object.keys(card).length > 0 ? { resource: card as ResourceCardUpdate } : {};
}

interface BodyFile {
  /** The whole file, frontmatter included; what the scan reads. */
  raw: string;
  /** The Markdown below the frontmatter; what becomes bodyMd. */
  body: string;
  hadFrontmatter: boolean;
}

async function readBodyFile(file: string): Promise<BodyFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new CliError('USAGE', `Could not read ${JSON.stringify(file)}`, {
      fix: 'Pass a path to a readable Markdown file, e.g. `tenjin edit <id> --body post.md`.',
      cause: err,
    });
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  return { raw, body, hadFrontmatter: Object.keys(frontmatter).length > 0 };
}

function storedList(post: OwnPost, key: 'questionsAnswered' | 'tasksSupported'): string[] {
  return post.resource?.[key] ?? [];
}

/** Append, preserving order, skipping exact-string duplicates already stored. */
function appendUnique(stored: string[], additions: string[]): string[] {
  const out = [...stored];
  for (const item of additions) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scan input + message shaping (publish's, over the edit's new content).
// ---------------------------------------------------------------------------

/**
 * The text this invocation actually SHIPS, and only that. Two filters, each
 * closing a way the gate could fire on text the edit does not publish:
 *
 * - the key must have survived pruning. A flag whose value already matches the
 *   stored one changes nothing, so its text is not "new content" at all; blocking
 *   on it refuses an edit over a secret that is already public and that no flag
 *   here can remove.
 * - the value must be one the user TYPED. The append path contributes its added
 *   strings, never the merged array it sends, for the same reason.
 *
 * Everything that does ship is scanned, so a secret in a surviving value blocks in
 * every mode, never cleared by --yes.
 */
function shippedTypedText(args: EditArgs, input: PostUpdateInput): string {
  const parts: string[] = [];
  const add = (v: string | undefined): void => {
    if (v !== undefined) parts.push(v);
  };
  if (input.title !== undefined) add(args.title);
  if (input.excerpt !== undefined) add(args.excerpt);

  const card = input.resource;
  if (card === undefined) return parts.join('\n');
  if (card.scope !== undefined) add(args.scope);
  if (card.exclusions !== undefined) add(args.exclusions);
  if (card.provenanceSummary !== undefined) add(args.provenance);
  if (card.methodologySummary !== undefined) add(args.methodology);
  if (card.asOf !== undefined) add(args.asOf);
  if (card.validUntil !== undefined) add(args.validUntil);
  if (card.questionsAnswered !== undefined) {
    for (const item of args.question ?? args.addQuestion ?? []) add(item);
  }
  if (card.tasksSupported !== undefined) {
    for (const item of args.task ?? args.addTask ?? []) add(item);
  }
  if (card.appliesTo !== undefined && args.appliesTo !== undefined) {
    // The parsed values, matching what actually ships on the card.
    for (const values of Object.values(parseAppliesToFlags(args.appliesTo))) parts.push(...values);
  }
  return parts.join('\n');
}

function blockMessage(blocking: ScanFinding[]): string {
  return `Edit blocked: the new content contains ${describeFindings(blocking)}.`;
}

function confirmMessage(warnCount: number, changeCount: number): string {
  return warnCount > 0
    ? `Edit needs confirmation: ${changeCount} change(s), ${warnCount} finding(s).`
    : `Edit needs confirmation: ${changeCount} change(s).`;
}

// ---------------------------------------------------------------------------
// Small formatting helpers.
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 60;
/** A whole rendered line's budget: a max-size card is 8 keys × 20 × 120 chars. */
const LINE_MAX = 200;

/** Terminal-safe, whitespace-collapsed, and capped: the one place values are cut. */
function clip(value: string, max = PREVIEW_MAX): string {
  const clean = sanitizeForTerminal(value).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A short, terminal-safe rendering of a stored or new value for the summary. */
function preview(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0) return '(unset)';
  const clean = sanitizeForTerminal(value).replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '(unset)';
  return clean.length > PREVIEW_MAX
    ? `${JSON.stringify(clean.slice(0, PREVIEW_MAX))}…`
    : JSON.stringify(clean);
}

function previewList(values: string[]): string {
  return values.map((v) => preview(v)).join(', ');
}

/**
 * `products=Base|Vercel, runtimes=node` — the VALUES, so a swap reads as a swap.
 * Every value takes the same 60-char cap the rest of the summary uses, and the
 * whole rendering is capped too: a full-size card would otherwise put ~19KB on one
 * stderr line.
 */
function appliesToPreview(appliesTo: Record<string, string[]>): string {
  const entries = Object.entries(appliesTo);
  if (entries.length === 0) return '(unset)';
  const rendered = entries
    .map(([key, values]) => `${clip(key)}=${values.map((v) => clip(v)).join('|')}`)
    .join(', ');
  return clip(rendered, LINE_MAX);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

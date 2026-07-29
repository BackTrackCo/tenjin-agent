import { readFile } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings } from '../lib/settings';
import { PublishModeSchema } from '../lib/config';
import { UUID_RE } from '../lib/ids';
import { scan, type ScanFinding } from '../lib/scan';
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
  type PostUpdateBody,
  type PostUpdateInput,
  type ResourceCardUpdate,
} from '../lib/posts-api';
import { createSessionKeyAuth, createSiwxAuth, type WriteAuth } from '../lib/session-key';
import {
  describeWallet,
  resolveWalletProvider,
  type TenjinSigner,
  type WalletProvider,
} from '../lib/wallet';
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
 * body + card text (a live secret hard-blocks in every mode) and the same
 * publish.mode consent cascade, because an edit ships content to the same public
 * page a publish does.
 *
 * Unlike publish, the wallet is touched BEFORE consent, and that is a real
 * tradeoff, not a technicality: the before→after summary the user approves can
 * only be built from the stored post, and reading it is owner-scoped. The read
 * itself changes nothing on the server and burns no nonce, but on first use it
 * establishes the session key, which means one wallet signature and a 24h
 * `read+write` delegation persisted to `~/.tenjin/session.json` before the user
 * has approved anything. We accept that: the alternative is asking a human to
 * approve a diff we cannot show them.
 *
 * Exit codes: 0 success (and the read-only show), 2 usage, 3 needs_confirmation /
 * non-bypassable publish_blocked, 4 a write failure after approval.
 */

/** Writes require Base mainnet per the server's SIWX chain constraint. */
const WRITE_CHAIN_ID = 'eip155:8453';

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
  // Every edge check that can fail on the FLAGS alone runs before the wallet: a
  // typo must cost nothing, not a signature and a round trip.
  rejectEmptyValues(args);
  assertAppendExclusivity(args);
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
  const auth = resolveWriteAuth(signer, runtime.baseUrl, ctx.dataDir, deps, env);
  const client = {
    baseUrl: runtime.baseUrl,
    timeoutMs: ctx.flags.timeout,
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
  const resource = mergeClears(deriveCard({}, cardFlags), clears);
  const input: PostUpdateInput = {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(bodyFile !== undefined ? { bodyMd: bodyFile.body } : {}),
    ...(args.excerpt !== undefined ? { excerpt: args.excerpt } : {}),
    ...(priceAtomic !== undefined ? { priceAtomic } : {}),
    ...(resource !== undefined ? { resource } : {}),
  };
  // Build once here so a bounds miss is USAGE before the scan and the consent
  // prompt; updatePost rebuilds the same body for the wire (pure, so identical).
  const body = buildPostUpdateBody(input);

  // A no-op edit is not an edit: when every value sent already matches the stored
  // post there is nothing to confirm, nothing new to scan, and no reason to burn a
  // nonce on a write that would change nothing. Exit 0 with the current post.
  const changes = changeLines(stored, body);
  if (changes.length === 0) return noChangeReceipt(stored);

  const settings = await resolvePublishSettings({ dataDir: ctx.dataDir, cwd, env });
  for (const warning of settings.warnings) ctx.io.stderr.write(`${warning}\n`);
  const envMode = env.TENJIN_PUBLISH_MODE;
  if (
    envMode !== undefined &&
    envMode.length > 0 &&
    !PublishModeSchema.safeParse(envMode).success
  ) {
    ctx.io.stderr.write(
      `Ignoring invalid TENJIN_PUBLISH_MODE=${JSON.stringify(envMode)}; using ${settings.mode} (${settings.modeSource}).\n`,
    );
  }
  // Say once what an unconfigured mode does, so a first edit that stops to confirm
  // is explained rather than surprising (publish prints the same explainer).
  if (settings.modeSource === 'default') {
    ctx.io.stderr.write(
      `publish.mode: ${settings.mode} (default) - each edit asks you once. Set auto to apply clean edits automatically: tenjin config set publish.mode auto.\n`,
    );
  }

  // The scan covers exactly what this edit would NEWLY publish: the body file
  // (whole, frontmatter included) plus the text typed on this invocation. A secret
  // reaching the public page through `edit` blocks exactly as it does through
  // `publish` — never bypassable by --yes or full-auto.
  const findings = dedupeFindings([...scan(bodyFile?.raw ?? ''), ...scan(typedScanText(args))]);
  const blocking = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  if (blocking.length > 0) {
    throw new CliError('PUBLISH_BLOCKED', blockMessage(blocking), {
      fix: 'Remove the secret from the new content (it is never masked away by --yes), then re-run.',
      details: { mode: settings.mode, findings: blocking.map(publicFinding) },
    });
  }

  const notes = editNotes(args, stored, bodyFile);
  for (const line of [...notes, ...changes]) ctx.io.stderr.write(`${line}\n`);

  const needsConfirm = settings.mode === 'review' || (settings.mode === 'auto' && warns.length > 0);
  if (needsConfirm && args.yes !== true) {
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

  const updated = await updatePost(args.postId, input, auth, client);
  return updateReceipt(updated, changes, notes);
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
function updateReceipt(post: OwnPost, changes: string[], notes: string[]): CommandResult {
  const card = post.resource;
  const lines = [
    `Updated ${sanitizeForTerminal(post.title)} → ${sanitizeForTerminal(post.url)}`,
    eligibilityLine(card),
    ...(post.warnings ?? []).map((w) => `warning: ${sanitizeForTerminal(w)}`),
  ];
  return {
    data: { ...post, changes, ...(notes.length > 0 ? { notes } : {}) },
    humanLines: lines,
  };
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
  if (card === undefined) return 'No answer card (browse-only document).';
  const missing = missingSentences(card.cacheEligibleMissing);
  if (card.cacheEligible) return 'Answer card is search-eligible.';
  return missing.length > 0
    ? `Answer card not search-eligible yet: ${missing.join(' ')}`
    : 'Answer card is not search-eligible.';
}

// ---------------------------------------------------------------------------
// The before→after summary.
// ---------------------------------------------------------------------------

/** One terse line per field the PUT would actually move; nothing for a no-op. */
function changeLines(stored: OwnPost, body: PostUpdateBody): string[] {
  const lines: string[] = [];
  if (body.title !== undefined && body.title !== stored.title) {
    lines.push(`title: ${preview(stored.title)} → ${preview(body.title)}`);
  }
  if (body.price !== undefined && body.price !== stored.price) {
    const before = toMoney(stored.price);
    const after = toMoney(body.price);
    lines.push(
      `price: ${before.usd} USD (${before.atomic} atomic) → ${after.usd} USD (${after.atomic} atomic)`,
    );
  }
  if (body.bodyMd !== undefined && body.bodyMd !== stored.bodyMd) {
    lines.push(`body: ${(stored.bodyMd ?? '').length} → ${body.bodyMd.length} characters`);
  }
  if (body.excerpt !== undefined && body.excerpt !== stored.excerpt) {
    lines.push(`excerpt: ${preview(stored.excerpt)} → ${preview(body.excerpt)}`);
  }
  lines.push(...cardChangeLines(stored.resource, body.resource));
  // Empty means EMPTY: the caller reads no lines as "this edit is a no-op" and
  // skips the write, so a sentinel line here would report a change that isn't one.
  return lines;
}

function cardChangeLines(
  stored: OwnPostCard | undefined,
  next: ResourceCardUpdate | undefined,
): string[] {
  if (next === undefined) return [];
  const lines: string[] = [];
  const listChange = (
    label: string,
    before: string[] | null | undefined,
    after: string[] | undefined,
  ): void => {
    if (after === undefined) return;
    const old = before ?? [];
    if (sameList(old, after)) return;
    const added = after.filter((v) => !old.includes(v));
    const detail =
      after.length === 0 ? ' (cleared)' : added.length > 0 ? ` (new: ${previewList(added)})` : '';
    lines.push(`${label}: ${old.length} → ${after.length}${detail}`);
  };
  listChange('questionsAnswered', stored?.questionsAnswered, next.questionsAnswered);
  listChange('tasksSupported', stored?.tasksSupported, next.tasksSupported);

  for (const [label, before, after] of [
    ['scope', stored?.scope, next.scope],
    ['exclusions', stored?.exclusions, next.exclusions],
    ['artifactType', stored?.artifactType, next.artifactType],
    ['temporalMode', stored?.temporalMode, next.temporalMode],
    ['asOf', stored?.asOf, next.asOf],
    ['validUntil', stored?.validUntil, next.validUntil],
    ['provenance', stored?.provenanceSummary, next.provenanceSummary],
    ['methodology', stored?.methodologySummary, next.methodologySummary],
    ['supersedesPostId', stored?.supersedesPostId, next.supersedesPostId],
  ] as const) {
    if (after === undefined) continue;
    const from = before ?? null;
    if (from === after) continue;
    lines.push(`${label}: ${preview(from)} → ${after === null ? '(cleared)' : preview(after)}`);
  }

  if (next.appliesTo !== undefined) {
    const beforeKeys = Object.keys(stored?.appliesTo ?? {}).length;
    const afterKeys = Object.keys(next.appliesTo).length;
    const detail = afterKeys === 0 ? ' (cleared)' : ` (${appliesToPreview(next.appliesTo)})`;
    lines.push(`appliesTo: ${beforeKeys} → ${afterKeys} keys${detail}`);
  }
  return lines;
}

/** The advisory notes a --body edit needs, in the order a human reads them. */
function editNotes(args: EditArgs, stored: OwnPost, bodyFile: BodyFile | undefined): string[] {
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
  if (stored.resource?.temporalMode === 'snapshot' && args.asOf === undefined) {
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

/** clear name → the card key it targets and the value that clears it server-side. */
const CLEAR_TARGET: Record<ClearField, { key: keyof ResourceCardUpdate; value: unknown }> = {
  scope: { key: 'scope', value: null },
  exclusions: { key: 'exclusions', value: null },
  asOf: { key: 'asOf', value: null },
  validUntil: { key: 'validUntil', value: null },
  provenance: { key: 'provenanceSummary', value: null },
  methodology: { key: 'methodologySummary', value: null },
  supersedesPostId: { key: 'supersedesPostId', value: null },
  questionsAnswered: { key: 'questionsAnswered', value: [] },
  tasksSupported: { key: 'tasksSupported', value: [] },
  appliesTo: { key: 'appliesTo', value: {} },
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
 * The card the PUT carries: the validated set fields plus the clears. Built from
 * an allowlist (deriveCard's output keys and CLEAR_TARGET) and never from a
 * spread of the GET, so a server-owned key (cacheEligible, cacheEligibleMissing,
 * schemaVersion) cannot reach a strictObject body that would reject it.
 */
function mergeClears(
  set: ResourceCardInput | undefined,
  clears: ClearField[],
): ResourceCardUpdate | undefined {
  if (set === undefined && clears.length === 0) return undefined;
  const card: Record<string, unknown> = { ...(set ?? {}) };
  for (const name of clears) {
    const target = CLEAR_TARGET[name];
    card[target.key] = target.value;
  }
  return card as ResourceCardUpdate;
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

function resolveWriteAuth(
  signer: TenjinSigner,
  baseUrl: string,
  dataDir: string,
  deps: EditDeps,
  env: NodeJS.ProcessEnv,
): WriteAuth {
  const config = { signer, baseUrl, chainId: WRITE_CHAIN_ID, dataDir };
  const useSession = deps.useSession ?? env.TENJIN_NO_SESSION !== '1';
  return useSession ? createSessionKeyAuth(config) : createSiwxAuth(config);
}

// ---------------------------------------------------------------------------
// Scan input + message shaping (publish's, over the edit's new content).
// ---------------------------------------------------------------------------

/**
 * The text this invocation TYPED, and only that: the post and card fields the
 * flags carry, outside the body file. A secret typed into --provenance ships to
 * the public card exactly like one in the body, so it faces the same gate.
 *
 * The append path contributes only its ADDED strings, never the merged array.
 * Scanning the stored entries would block an edit on text that is already public
 * and cannot be removed from here — trapping the user behind a secret they never
 * typed, with no flag that fixes it.
 */
function typedScanText(args: EditArgs): string {
  const parts: string[] = [];
  const add = (v: string | undefined): void => {
    if (v !== undefined) parts.push(v);
  };
  add(args.title);
  add(args.excerpt);
  add(args.scope);
  add(args.exclusions);
  add(args.provenance);
  add(args.methodology);
  add(args.asOf);
  add(args.validUntil);
  for (const list of [args.question, args.task, args.addQuestion, args.addTask]) {
    if (list !== undefined) parts.push(...list);
  }
  if (args.appliesTo !== undefined && args.appliesTo.length > 0) {
    // The parsed values, matching what actually ships on the card.
    for (const values of Object.values(parseAppliesToFlags(args.appliesTo))) parts.push(...values);
  }
  return parts.join('\n');
}

/** Collapse findings that share a check + excerpt, keeping the first. */
function dedupeFindings(findings: ScanFinding[]): ScanFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.check}:${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A finding safe to echo: block excerpts are already masked by the scanner. */
function publicFinding(f: ScanFinding): {
  check: string;
  severity: string;
  line: number;
  excerpt: string;
} {
  return { check: f.check, severity: f.severity, line: f.line, excerpt: f.excerpt };
}

function blockMessage(blocking: ScanFinding[]): string {
  const checks = [...new Set(blocking.map((f) => f.check))].join(', ');
  return `Edit blocked: the new content contains ${blocking.length} secret finding(s) (${checks}).`;
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

function appliesToPreview(appliesTo: Record<string, string[]>): string {
  return Object.entries(appliesTo)
    .map(
      ([key, values]) => `${sanitizeForTerminal(key)}=${values.map(sanitizeForTerminal).join('|')}`,
    )
    .join(', ');
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

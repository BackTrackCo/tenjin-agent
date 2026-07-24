import { readFile } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings } from '../lib/settings';
import { PublishModeSchema, parsePublishModeFlag } from '../lib/config';
import { readCandidate, dropCandidate, type CandidateRecord } from '../lib/candidate-store';
import { UUID_RE } from '../lib/ids';
import { scan, type ScanFinding } from '../lib/scan';
import { headingOutline } from '../lib/markdown';
import { sanitizeForTerminal } from '../lib/output';
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
  PUBLISH_STATUSES,
  type PublishInput,
  type PublishStatus,
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

/** Writes require Base mainnet per the server's SIWX chain constraint. */
const WRITE_CHAIN_ID = 'eip155:8453';

export interface PublishArgs {
  /** The Markdown file to publish; mutually exclusive with --candidate. */
  file?: string;
  /** A parked candidate id to publish (its draft.md); mutually exclusive with <file>. */
  candidate?: string;
  draft?: boolean;
  yes?: boolean;
  /** Raw `--mode` (review|auto|full-auto); validated at the edge (USAGE on a bad value). */
  mode?: string;
  /** Top-level post price, decimal USD at the edge (O1). */
  price?: string;
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

  // The content comes from EITHER a <file> or a parked --candidate, never both,
  // never neither. A candidate resolves to its draft.md (and prefills its question).
  const { raw, candidate } = await resolveSource(args, ctx.dataDir);
  const { frontmatter, body } = parseFrontmatter(raw);

  const status = resolveStatus(args, frontmatter);
  const title = resolveTitle(frontmatter, body);
  const tags = resolveTags(frontmatter);
  const excerpt = expectString(frontmatter, 'excerpt');
  const handle = expectString(frontmatter, 'handle');
  // A candidate's stored question prefills questionsAnswered, but only as a
  // fallback: an explicit --question OR a frontmatter questionsAnswered still wins.
  const cardFlags = cardFlagsFrom(args);
  if (
    candidate?.meta.question !== undefined &&
    cardFlags.question === undefined &&
    frontmatter.questionsAnswered === undefined
  ) {
    cardFlags.question = [candidate.meta.question];
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
  for (const warning of settings.warnings) {
    ctx.io.stderr.write(`${warning}\n`);
  }
  // A mistyped TENJIN_PUBLISH_MODE degrades silently otherwise (the resolver
  // ignores an unrecognized env value); warn on stderr so the discard is visible.
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
  // When the mode was never configured, say once (on stderr, invisible to JSON
  // consumers) what the default does and how to change it, so an unconfigured
  // publish is never a silent auto-publish surprise.
  if (settings.modeSource === 'default') {
    ctx.io.stderr.write(
      `publish.mode: ${settings.mode} (default) - each publish asks you once. Set auto to publish clean scans automatically: tenjin config set publish.mode auto.\n`,
    );
  }
  const priceAtomic = resolvePrice(args, frontmatter, settings.defaultPriceAtomic);

  // The scan runs in EVERY mode (D38): it gates the gate, it does not replace it.
  // Scan the whole file AND the derived card's text, so a secret reaches the same
  // gates whether it arrives in the body, in frontmatter, or via a card-authoring
  // flag (--provenance, --scope, …) — the card ships to the PUBLIC card, so a flag
  // secret must block exactly like an in-file one. Dedupe by check+excerpt so a
  // frontmatter value (present in both raw and the card) is not double-counted.
  const findings = dedupeFindings([...scan(raw), ...scan(cardScanText(card))]);
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

  // needs_confirmation: review always asks; auto asks only on a soft finding;
  // full-auto proceeds past soft findings. --yes clears the soft findings and the
  // review confirm alike.
  const needsConfirm = settings.mode === 'review' || (settings.mode === 'auto' && warns.length > 0);
  if (needsConfirm && args.yes !== true) {
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
  const auth = resolveWriteAuth(signer, runtime.baseUrl, ctx.dataDir, deps, env);

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

  // ONLY on a successful publish is the candidate cleared from the pending store
  // (a refusal or a write failure left it parked, above). The clear is BEST-EFFORT:
  // the piece is already published, so a failing drop must NOT report the publish as
  // failed — that would invite a retry and double-publish. Keep ok:true, report
  // cleared:false with a warning, and let the human drop it manually.
  const candidateInfo =
    candidate !== undefined ? await clearPublishedCandidate(ctx, candidate.id) : undefined;
  return receipt(result, runtime.baseUrl, candidateInfo);
}

interface CandidateReceipt {
  id: string;
  cleared: boolean;
  warning?: string;
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
): CommandResult {
  const price = toMoney(result.priceAtomic);
  const missing = missingSentences(result.cacheEligibleMissing);
  const cacheEligible = result.cacheEligible ?? false;
  const deskUrl = `${trimSlash(baseUrl)}/desk`;
  const title = sanitizeForTerminal(result.title);
  const human = [
    `Published ${title} (${result.status}) for ${price.usd} USD → ${result.url}`,
    cacheEligible
      ? 'Answer card is lookup-eligible.'
      : missing.length > 0
        ? `Answer card not lookup-eligible yet: ${missing.join(' ')}`
        : 'Published as a browse-only document (no answer card).',
    ...(candidateInfo?.cleared === true ? [`Cleared candidate ${candidateInfo.id}.`] : []),
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

function resolveWriteAuth(
  signer: TenjinSigner,
  baseUrl: string,
  dataDir: string,
  deps: PublishDeps,
  env: NodeJS.ProcessEnv,
): WriteAuth {
  const config = { signer, baseUrl, chainId: WRITE_CHAIN_ID, dataDir };
  const useSession = deps.useSession ?? env.TENJIN_NO_SESSION !== '1';
  return useSession ? createSessionKeyAuth(config) : createSiwxAuth(config);
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

/** Collapse findings that share a check + excerpt (a frontmatter value scanned in
 *  both the file and the derived card) to one, keeping the first (the file-line). */
function dedupeFindings(findings: ScanFinding[]): ScanFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.check}:${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Finding + message shaping.
// ---------------------------------------------------------------------------

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
  return `Publish blocked: the file contains ${blocking.length} secret finding(s) (${checks}).`;
}

function confirmMessage(warnCount: number, priceUsd: string): string {
  return warnCount > 0
    ? `Publish needs confirmation: ${warnCount} finding(s), price $${priceUsd}.`
    : `Publish needs confirmation: price $${priceUsd}.`;
}

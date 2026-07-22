import { readFile } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings, resolvePublishSettings } from '../lib/settings';
import { scan, type ScanFinding } from '../lib/scan';
import { headingOutline } from '../lib/markdown';
import { sanitizeForTerminal } from '../lib/output';
import {
  deriveCard,
  localCardEligibility,
  missingSentences,
  parseAppliesToFlags,
  parseFrontmatter,
  type CardFlags,
  type Frontmatter,
} from '../lib/card';
import { publishPost, type PublishInput, type PublishStatus } from '../lib/posts-api';
import {
  createSessionKeyAuth,
  createSiwxAuth,
  type SessionKeyDeps,
  type WriteAuth,
} from '../lib/session-key';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin publish <file.md>`: read the Markdown, parse frontmatter for post +
 * answer-card fields, run the deterministic scan (every mode), gate on the D38
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
const STATUSES: readonly string[] = ['draft', 'published', 'unlisted'];

export interface PublishArgs {
  file: string;
  draft?: boolean;
  yes?: boolean;
  /** Raw `--mode` (review|auto|full-auto); validated during resolution. */
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
  /** Force the plain-SIWX write path (default: session key). Also TENJIN_NO_SESSION=1. */
  useSession?: boolean;
  /** Session-key seams (clock/nonce/keygen/cache) for deterministic tests. */
  sessionDeps?: SessionKeyDeps;
}

export async function runPublish(
  args: PublishArgs,
  ctx: CommandContext,
  deps: PublishDeps = {},
): Promise<CommandResult> {
  const raw = await readMarkdown(args.file);
  const { frontmatter, body } = parseFrontmatter(raw);

  const status = resolveStatus(args, frontmatter);
  const title = resolveTitle(frontmatter, body);
  const tags = resolveTags(frontmatter);
  const excerpt = expectString(frontmatter, 'excerpt');
  const handle = expectString(frontmatter, 'handle');
  const card = deriveCard(frontmatter, cardFlagsFrom(args));

  // The consent cascade + resolved price (global < project < env < flag), with the
  // full-auto loosening gate. Its downgrade warnings go to stderr, not the receipt.
  const settings = await resolvePublishSettings({
    dataDir: ctx.dataDir,
    cwd: process.cwd(),
    ...(args.mode !== undefined ? { flag: args.mode } : {}),
    env: process.env,
  });
  for (const warning of settings.warnings) {
    ctx.io.stderr.write(`${warning}\n`);
  }
  // When the mode was never configured, say once (on stderr, invisible to JSON
  // consumers) what the default does and how to change it, so an unconfigured
  // publish is never a silent auto-publish surprise.
  if (settings.modeSource === 'default') {
    const usd = toMoney(settings.defaultPriceAtomic).usd;
    ctx.io.stderr.write(
      `publish.mode: ${settings.mode} (default) - a clean scan publishes at $${usd} without asking. Change: tenjin config set publish.mode review.\n`,
    );
  }
  const priceAtomic = resolvePrice(args, frontmatter, settings.defaultPriceAtomic);

  // The scan runs in EVERY mode (D38): it gates the gate, it does not replace it.
  // Scan the whole file so a secret in frontmatter (a public card field) is caught
  // too, not only the body.
  const findings = scan(raw);
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
  const auth = resolveWriteAuth(signer, runtime.baseUrl, ctx.dataDir, deps);

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
  return receipt(result, runtime.baseUrl);
}

function receipt(result: Awaited<ReturnType<typeof publishPost>>, baseUrl: string): CommandResult {
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
  if (typeof fm !== 'string' || !STATUSES.includes(fm)) {
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
  signer: import('../lib/wallet').TenjinSigner,
  baseUrl: string,
  dataDir: string,
  deps: PublishDeps,
): WriteAuth {
  const config = { signer, baseUrl, chainId: WRITE_CHAIN_ID, dataDir };
  const useSession = deps.useSession ?? process.env.TENJIN_NO_SESSION !== '1';
  return useSession ? createSessionKeyAuth(config, deps.sessionDeps ?? {}) : createSiwxAuth(config);
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

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

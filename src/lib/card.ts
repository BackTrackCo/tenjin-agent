import { CliError } from './errors';
import { ATOMIC_RE, UUID_RE } from './ids';

/**
 * The answer-card (`resource`) authoring layer (A3, spec 09 §4). Derives the
 * machine-readable card from YAML frontmatter (a minimal in-repo parser — no YAML
 * dependency is added to a wallet-holding CLI with an otherwise empty dep tree)
 * and the card-authoring flags, flags winning, and validates it LOCALLY against
 * the exact server bounds so a malformed card fails as USAGE (exit 2) before any
 * network round trip. Field rejections use the server's dotted `resource.<field>`
 * key convention (flattenPostError) so a local error reads identically to a
 * server-returned one.
 */

export type FrontmatterValue = string | string[] | Record<string, string[]>;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
}

/** The card fields the CLI sends; mirrors resourceMetadataInputSchema (A3). */
export interface ResourceCardInput {
  artifactType?: 'document' | 'skill' | 'dataset';
  mediaType?: string;
  temporalMode?: 'snapshot' | 'maintained' | 'evergreen';
  asOf?: string;
  validUntil?: string;
  supersedesPostId?: string;
  questionsAnswered?: string[];
  tasksSupported?: string[];
  scope?: string;
  exclusions?: string;
  appliesTo?: Record<string, string[]>;
  provenanceSummary?: string;
  methodologySummary?: string;
  maintenanceCadence?: string;
  reproductionMinutes?: number;
  estimatedPaidInputCost?: string;
}

/** The card-authoring flags (each maps 1:1 to a card field; flags beat frontmatter). */
export interface CardFlags {
  question?: string[];
  task?: string[];
  scope?: string;
  exclusions?: string;
  appliesTo?: Record<string, string[]>;
  asOf?: string;
  validUntil?: string;
  artifactType?: string;
  temporalMode?: string;
  provenance?: string;
  methodology?: string;
}

// ---------------------------------------------------------------------------
// Minimal frontmatter parser.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a leading `--- ... ---` YAML frontmatter block from the body. Supports
 * exactly the shapes a card needs — `key: value` scalars, block sequences (`key:`
 * then `  - item`), inline flow sequences (`key: [a, b]`), and a one-level nested
 * map (for `appliesTo`) whose sub-values are sequences — and refuses anything
 * else as USAGE, so an unsupported construct fails loudly, never silently
 * mis-parsed. No frontmatter ⇒ empty map + the whole text as body.
 */
export function parseFrontmatter(text: string): ParsedDocument {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) return { frontmatter: {}, body: text };
  const block = match[1] ?? '';
  const body = text.slice(match[0].length);
  return { frontmatter: parseBlock(block), body };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function parseBlock(block: string): Frontmatter {
  const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0 && !/^\s*#/.test(l));
  const out: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (indentOf(line) !== 0) {
      throw usage(`Unexpected indentation in frontmatter: ${JSON.stringify(line)}`);
    }
    const kv = splitKey(line);
    if (kv === null) throw usage(`Malformed frontmatter line: ${JSON.stringify(line)}`);
    const { key, value } = kv;
    if (value.length > 0) {
      out[key] = parseInlineValue(value);
      i++;
      continue;
    }
    // A `key:` with no inline value: an indented block sequence or nested map.
    const child: string[] = [];
    i++;
    while (i < lines.length && indentOf(lines[i] ?? '') > 0) {
      child.push(lines[i] ?? '');
      i++;
    }
    if (child.length === 0) {
      out[key] = '';
    } else if (child.every((c) => /^\s*-\s/.test(c))) {
      out[key] = child.map((c) => unquote(c.replace(/^\s*-\s+/, '').trim()));
    } else {
      out[key] = parseNestedMap(child);
    }
  }
  return out;
}

/** A one-level nested map (appliesTo): each `subkey: [..]` or `subkey:` + `- item`. */
function parseNestedMap(lines: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const baseIndent = indentOf(lines[0] ?? '');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (indentOf(line) !== baseIndent)
      throw usage(`Malformed nested frontmatter: ${JSON.stringify(line)}`);
    const kv = splitKey(line);
    if (kv === null) throw usage(`Malformed nested frontmatter line: ${JSON.stringify(line)}`);
    const { key, value } = kv;
    if (value.length > 0) {
      const parsed = parseInlineValue(value);
      out[key] = Array.isArray(parsed) ? parsed : [parsed as string];
      i++;
      continue;
    }
    const items: string[] = [];
    i++;
    while (i < lines.length && indentOf(lines[i] ?? '') > baseIndent) {
      const c = lines[i] ?? '';
      if (!/^\s*-\s/.test(c))
        throw usage(`Expected a list item in frontmatter: ${JSON.stringify(c)}`);
      items.push(unquote(c.replace(/^\s*-\s+/, '').trim()));
      i++;
    }
    out[key] = items;
  }
  return out;
}

function splitKey(line: string): { key: string; value: string } | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s?(.*)$/.exec(line);
  if (m === null || m[1] === undefined) return null;
  return { key: m[1], value: (m[2] ?? '').trim() };
}

function parseInlineValue(value: string): string | string[] {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(',').map((v) => unquote(v.trim()));
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Card derivation + local validation.
// ---------------------------------------------------------------------------

const ARTIFACT_TYPES = ['document', 'skill', 'dataset'] as const;
const TEMPORAL_MODES = ['snapshot', 'maintained', 'evergreen'] as const;
const MEDIA_TYPE_RE = /^[a-z0-9]+\/[a-z0-9][a-z0-9.+-]*$/;
const CANONICAL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Collects field errors under dotted `resource.<field>` keys, then throws once. */
class CardErrors {
  private readonly fieldErrors: Record<string, string[]> = {};
  add(field: string, message: string): void {
    const key = `resource.${field}`;
    (this.fieldErrors[key] ??= []).push(message);
  }
  get empty(): boolean {
    return Object.keys(this.fieldErrors).length === 0;
  }
  throwIfAny(): void {
    if (this.empty) return;
    const first = Object.entries(this.fieldErrors)[0];
    const summary = first !== undefined ? `${first[0]}: ${first[1][0]}` : 'invalid card';
    throw new CliError('USAGE', `Invalid answer card (${summary})`, {
      fix: 'Correct the reported resource.<field> values (frontmatter or flags), then re-run.',
      details: { fieldErrors: this.fieldErrors },
    });
  }
}

/**
 * Derive + validate the `resource` card from frontmatter (card keys) and flags,
 * flags winning per field. Returns undefined when NO card field is present (an
 * empty `resource` is a server no-op, so the CLI omits it rather than sending
 * `{}`). Throws USAGE with dotted `resource.<field>` errors on any bound miss.
 */
export function deriveCard(
  frontmatter: Frontmatter,
  flags: CardFlags,
): ResourceCardInput | undefined {
  const errs = new CardErrors();
  const card: ResourceCardInput = {};

  const scalar = (fmKey: string, flagVal: string | undefined): string | undefined => {
    if (flagVal !== undefined) return flagVal;
    const fm = frontmatter[fmKey];
    if (fm === undefined) return undefined;
    if (typeof fm !== 'string') {
      errs.add(fmKey, 'expected a single string value');
      return undefined;
    }
    return fm;
  };

  const list = (fmKey: string, flagVal: string[] | undefined): string[] | undefined => {
    if (flagVal !== undefined && flagVal.length > 0) return flagVal;
    const fm = frontmatter[fmKey];
    if (fm === undefined) return undefined;
    if (!Array.isArray(fm)) {
      errs.add(fmKey, 'expected a list');
      return undefined;
    }
    return fm;
  };

  const artifactType = scalar('artifactType', flags.artifactType);
  if (artifactType !== undefined) {
    if ((ARTIFACT_TYPES as readonly string[]).includes(artifactType)) {
      card.artifactType = artifactType as ResourceCardInput['artifactType'];
    } else {
      errs.add('artifactType', `must be one of ${ARTIFACT_TYPES.join(', ')}`);
    }
  }

  const mediaType = scalar('mediaType', undefined);
  if (mediaType !== undefined) {
    if (mediaType.length > 100) errs.add('mediaType', 'must be at most 100 characters');
    else if (!MEDIA_TYPE_RE.test(mediaType))
      errs.add('mediaType', 'must be a MIME type, e.g. text/markdown');
    else card.mediaType = mediaType;
  }

  const temporalMode = scalar('temporalMode', flags.temporalMode);
  if (temporalMode !== undefined) {
    if ((TEMPORAL_MODES as readonly string[]).includes(temporalMode)) {
      card.temporalMode = temporalMode as ResourceCardInput['temporalMode'];
    } else {
      errs.add('temporalMode', `must be one of ${TEMPORAL_MODES.join(', ')}`);
    }
  }

  const asOf = validateIso(scalar('asOf', flags.asOf), 'asOf', errs);
  if (asOf !== undefined) card.asOf = asOf;
  const validUntil = validateIso(scalar('validUntil', flags.validUntil), 'validUntil', errs);
  if (validUntil !== undefined) card.validUntil = validUntil;
  if (asOf !== undefined && validUntil !== undefined && Date.parse(validUntil) < Date.parse(asOf)) {
    errs.add('validUntil', 'must be at or after asOf');
  }

  const supersedes = scalar('supersedesPostId', undefined);
  if (supersedes !== undefined) {
    if (UUID_RE.test(supersedes)) card.supersedesPostId = supersedes;
    else errs.add('supersedesPostId', 'must be a post uuid');
  }

  const questions = list('questionsAnswered', flags.question);
  if (questions !== undefined) {
    validateStringList(questions, 'questionsAnswered', errs);
    card.questionsAnswered = questions;
  }
  const tasks = list('tasksSupported', flags.task);
  if (tasks !== undefined) {
    validateStringList(tasks, 'tasksSupported', errs);
    card.tasksSupported = tasks;
  }

  const scope = scalar('scope', flags.scope);
  if (scope !== undefined) {
    if (scope.length > 500) errs.add('scope', 'must be at most 500 characters');
    else card.scope = scope;
  }
  const exclusions = scalar('exclusions', flags.exclusions);
  if (exclusions !== undefined) {
    if (exclusions.length > 500) errs.add('exclusions', 'must be at most 500 characters');
    else card.exclusions = exclusions;
  }
  const provenance = scalar('provenanceSummary', flags.provenance);
  if (provenance !== undefined) {
    if (provenance.length > 500) errs.add('provenanceSummary', 'must be at most 500 characters');
    else card.provenanceSummary = provenance;
  }
  const methodology = scalar('methodologySummary', flags.methodology);
  if (methodology !== undefined) {
    if (methodology.length > 500) errs.add('methodologySummary', 'must be at most 500 characters');
    else card.methodologySummary = methodology;
  }

  const appliesTo = flags.appliesTo ?? readAppliesTo(frontmatter, errs);
  if (appliesTo !== undefined) {
    const validated = validateAppliesTo(appliesTo, errs);
    if (validated !== undefined) card.appliesTo = validated;
  }

  const cadence = scalar('maintenanceCadence', undefined);
  if (cadence !== undefined) {
    if (cadence.length > 120) errs.add('maintenanceCadence', 'must be at most 120 characters');
    else card.maintenanceCadence = cadence;
  }

  const repro = scalar('reproductionMinutes', undefined);
  if (repro !== undefined) {
    const n = Number(repro);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
      errs.add('reproductionMinutes', 'must be an integer from 0 to 1000000');
    } else {
      card.reproductionMinutes = n;
    }
  }

  const cost = scalar('estimatedPaidInputCost', undefined);
  if (cost !== undefined) {
    if (ATOMIC_RE.test(cost)) card.estimatedPaidInputCost = cost;
    else errs.add('estimatedPaidInputCost', 'must be an atomic USDC digit string');
  }

  errs.throwIfAny();
  return Object.keys(card).length > 0 ? card : undefined;
}

function validateIso(
  value: string | undefined,
  field: string,
  errs: CardErrors,
): string | undefined {
  if (value === undefined) return undefined;
  if (!ISO_OFFSET_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    errs.add(field, 'must be an ISO-8601 timestamp with an offset, e.g. 2026-07-01T00:00:00Z');
    return undefined;
  }
  return value;
}

function validateStringList(list: string[], field: string, errs: CardErrors): void {
  if (list.length > 10) errs.add(field, 'at most 10 items');
  for (const item of list) {
    if (item.length === 0) errs.add(field, 'items must be non-empty');
    else if (item.length > 200) errs.add(field, 'each item is at most 200 characters');
  }
}

function readAppliesTo(
  frontmatter: Frontmatter,
  errs: CardErrors,
): Record<string, string[]> | undefined {
  const fm = frontmatter.appliesTo;
  if (fm === undefined) return undefined;
  if (typeof fm === 'string' || Array.isArray(fm)) {
    errs.add('appliesTo', 'must be a map of key to a list of values');
    return undefined;
  }
  return fm;
}

function validateAppliesTo(
  appliesTo: Record<string, string[]>,
  errs: CardErrors,
): Record<string, string[]> | undefined {
  const keys = Object.keys(appliesTo);
  if (keys.length > 8) errs.add('appliesTo', 'at most 8 keys');
  const out: Record<string, string[]> = {};
  for (const [key, rawValues] of Object.entries(appliesTo)) {
    if (!CANONICAL_KEY_RE.test(key)) {
      errs.add('appliesTo', `key ${JSON.stringify(key)} must match ^[a-z][a-z0-9_]{0,31}$`);
      continue;
    }
    const values = rawValues.map((v) => v.trim());
    if (values.length > 20) errs.add('appliesTo', `key ${key} has more than 20 values`);
    for (const v of values) {
      if (v.length < 1 || v.length > 120) {
        errs.add('appliesTo', `key ${key} values must be 1 to 120 characters`);
      }
    }
    out[key] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse repeatable `--applies-to k=v` flags into a map (values accumulate per key). */
export function parseAppliesToFlags(pairs: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError('USAGE', `Invalid --applies-to ${JSON.stringify(pair)}`, {
        fix: 'Use key=value, e.g. --applies-to products=Vercel.',
      });
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    (out[key] ??= []).push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The cacheEligible echo: token → plain sentence (spec 09 §4 Q9 rubric).
// ---------------------------------------------------------------------------

const MISSING_SENTENCES: Record<string, string> = {
  questionsOrTasks: 'Add at least one question answered or task supported.',
  scope: 'Describe the scope (what this piece covers).',
  exclusions: 'State the exclusions (what this piece does not cover).',
  asOf: 'Set an as-of date (a snapshot card needs one).',
  provenanceOrMethodology: 'Add a provenance or methodology summary.',
};

/**
 * Map the server's `cacheEligibleMissing` tokens to plain sentences for the
 * receipt. Treats the recomputed `cacheEligibleMissing` as authoritative for what
 * to fix (the stored `cacheEligible` boolean can lag a rubric change); an unknown
 * future token passes through verbatim rather than being dropped.
 */
export function missingSentences(tokens: string[]): string[] {
  return tokens.map((t) => MISSING_SENTENCES[t] ?? t);
}

/**
 * A LOCAL preview of the Q9 eligibility rubric for the pre-publish confirmation
 * payload — the server recomputes the authoritative `cacheEligibleMissing` on
 * write, but the confirmation prompt shows the human what the card is still
 * missing before they approve. `asOf` counts only for a snapshot card.
 */
export function localCardEligibility(card: ResourceCardInput | undefined): {
  cacheEligible: boolean;
  missing: string[];
} {
  const tokens: string[] = [];
  const hasQuestionsOrTasks =
    (card?.questionsAnswered?.length ?? 0) > 0 || (card?.tasksSupported?.length ?? 0) > 0;
  if (!hasQuestionsOrTasks) tokens.push('questionsOrTasks');
  if (card?.scope === undefined) tokens.push('scope');
  if (card?.exclusions === undefined) tokens.push('exclusions');
  if (card?.temporalMode === 'snapshot' && card.asOf === undefined) tokens.push('asOf');
  if (card?.provenanceSummary === undefined && card?.methodologySummary === undefined) {
    tokens.push('provenanceOrMethodology');
  }
  return { cacheEligible: tokens.length === 0, missing: missingSentences(tokens) };
}

function usage(message: string): CliError {
  return new CliError('USAGE', message, {
    fix: 'Frontmatter supports key: value, key: [a, b], block lists, and a one-level appliesTo map.',
  });
}

import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { mask } from './redact';

/**
 * JSON Schema validation for anything a remote party asks this CLI to send or
 * accepts back: the router's decision arguments, and a result body a caller
 * declared a success condition for. Ported from the draft auto-mode experiment
 * (PR #369 `contracts.ts`) into a shared path so `tenjin pay` gets it too.
 *
 * SCHEMAS ARE UNTRUSTED INPUT. Ajv compiles keywords, never merchant code, but a
 * schema still reaches a compiler, so the checks below run BEFORE compilation:
 * bounded size and nesting, no prototype-poisoning keys, no remote `$ref`, and
 * no regular-expression keyword until a bounded regexp runtime exists. A schema
 * that fails any of them is refused rather than compiled.
 */

export type JsonRecord = Record<string, unknown>;

const MAX_SCHEMA_BYTES = 96 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
/**
 * The largest result body checked against its success rule, and cut to the
 * fields its spec promises. Ordinary provider bodies must fit: one Apollo
 * person hit is 60-180 KB, because it embeds the employer's whole organization
 * record, and a batch of ten is about 1.8 MB. 4 MB is that batch with room to
 * spare. The transport has already read and parsed the whole body, so the cap
 * bounds only the second parse and the schema walk on this process, which take
 * tens of milliseconds at 4 MB. A body over it is delivered unchecked, flagged.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 24;
const VALIDATOR_CACHE_LIMIT = 128;

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** Key-order-independent serialization, so one schema has one cache identity. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The stable SHA-256 of a value; the identity a decision row and a duplicate
 *  guard key are built from. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function walk(value: unknown, schemaMode: boolean, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('Schema or value exceeds the nesting limit.');
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, schemaMode, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error(`Forbidden object key: ${key}`);
    }
    if (schemaMode && key === '$ref' && typeof entry === 'string' && !entry.startsWith('#/')) {
      throw new Error('Remote or recursive schema references are unsupported.');
    }
    // A field NAMED `pattern` holds a schema object, not a regular expression.
    if (
      schemaMode &&
      ((key === 'pattern' && typeof entry === 'string') || key === 'patternProperties')
    ) {
      throw new Error('Regular-expression schema constraints are unsupported.');
    }
    walk(entry, schemaMode, depth + 1);
  }
}

const validators = new Map<string, ValidateFunction>();

interface CompileOptions {
  /** Collect every problem rather than stopping at the first: what an agent
   *  fixing its own input needs, in one round. */
  allErrors?: boolean;
  /** Pass over a keyword or format Ajv does not know instead of refusing the
   *  schema. Such a keyword checks nothing (OpenAPI's `example`, a vendor's
   *  `x-in`), and refusing the whole schema for one left the input with no
   *  check at all. Nothing is logged: a hook's output is not the place. */
  ignoreUnknown?: boolean;
  /** Delete every property the schema does not declare, at every level the
   *  schema describes, instead of checking: see {@link projectBody}. */
  project?: boolean;
}

function compile(
  schema: JsonRecord,
  { allErrors = false, ignoreUnknown = false, project = false }: CompileOptions = {},
): ValidateFunction {
  if (Buffer.byteLength(stable(schema)) > MAX_SCHEMA_BYTES) {
    throw new Error('Schema exceeds its size limit.');
  }
  const key = `${canonicalHash(schema)}${allErrors ? ':all' : ''}${ignoreUnknown ? ':lenient' : ''}${project ? ':project' : ''}`;
  const cached = validators.get(key);
  if (cached !== undefined) return cached;
  walk(schema, true);
  const options = {
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    ...(ignoreUnknown ? { strictSchema: false, logger: false as const } : {}),
    allErrors,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: project ? ('all' as const) : false,
    allowUnionTypes: true,
  };
  const ajv = schema.$schema === DRAFT_07 ? new Ajv(options) : new Ajv2020(options);
  // A nested body schema can declare draft-07 under a 2020 parent. Registering
  // the meta-schema keeps the dialect's keywords checked and loads nothing
  // remote; Ajv's own remote loading stays off.
  if (!ajv.getSchema(DRAFT_07)) ajv.addMetaSchema({ $id: DRAFT_07 });
  addFormats(ajv);
  const compiled = ajv.compile(schema);
  if (validators.size >= VALIDATOR_CACHE_LIMIT) {
    validators.delete(validators.keys().next().value!);
  }
  validators.set(key, compiled);
  return compiled;
}

export interface SchemaCheck {
  valid: boolean;
  errors: string[];
}

/**
 * Check a value against its own schema. Both are untrusted: the value is
 * round-tripped through JSON first so an exotic JS object can never reach the
 * validator, and its size is bounded before anything is compiled.
 */
export function validateAgainstSchema(schema: unknown, value: unknown): SchemaCheck {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > MAX_VALUE_BYTES) {
      throw new Error('The value is not JSON, or exceeds its size limit.');
    }
    walk(value, false);
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  return checkValue(schema, value);
}

/** The schema check alone, on a value whose size and shape were bounded. */
function checkValue(schema: unknown, value: unknown): SchemaCheck {
  try {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('A schema must be a JSON Schema object.');
    }
    const validate = compile(schema as JsonRecord);
    if (validate(value)) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      ),
    };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/**
 * A schema with its regular-expression keywords taken out, so the rest of it
 * can still be checked: they stay out of the compiler (see {@link walk}), and
 * refusing the whole schema for one `pattern` left four list services with no
 * check at all. A field NAMED `pattern` is a schema object, not a string, and
 * is kept.
 */
function withoutPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPatterns);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .filter(
        ([key, entry]) =>
          !(key === 'pattern' && typeof entry === 'string') && key !== 'patternProperties',
      )
      .map(([key, entry]) => [key, withoutPatterns(entry)]),
  );
}

/** One Ajv error as an agent reads it: the field, and what it must be. */
function describeProblem(error: {
  instancePath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}): string {
  const at = error.instancePath.replace(/^\//, '').replaceAll('/', '.');
  const field = (name: string) => (at ? `${at}.${name}` : name);
  const subject = at || 'the input';
  const { params } = error;
  switch (error.keyword) {
    case 'required':
      return `${field(String(params.missingProperty))} is required`;
    case 'additionalProperties':
      return `${subject} has no field ${JSON.stringify(params.additionalProperty)}`;
    case 'enum':
      return `${subject} must be one of ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`;
    case 'const':
      return `${subject} must be ${JSON.stringify(params.allowedValue)}`;
    case 'type':
      return `${subject} must be ${String(params.type)}`;
    default:
      return `${subject} ${error.message ?? 'is invalid'}`;
  }
}

/**
 * EVERY way an input misses its schema, each naming the field and, for a
 * fixed set, the values it allows; `[]` when it fits; undefined when the
 * schema cannot be compiled even without its patterns and its unknown
 * keywords, so the input cannot be checked here at all. AiSpace's Ideogram V4
 * spec (`example`) and x402atlas's SEC spec (`x-in`) each carry such a keyword.
 */
export function inputProblems(schema: unknown, value: unknown): string[] | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  let validate: ValidateFunction;
  try {
    validate = compile(withoutPatterns(schema) as JsonRecord, {
      allErrors: true,
      ignoreUnknown: true,
    });
  } catch {
    return undefined;
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > MAX_VALUE_BYTES) {
      return ['the input is not JSON, or exceeds its size limit'];
    }
    walk(value, false);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  if (validate(value)) return [];
  return [...new Set((validate.errors ?? []).map(describeProblem))];
}

/** Compile a success schema before a payment is signed, so a broken rule refuses
 *  at the cheap end rather than after money moved. */
export function assertResultSchema(schema: unknown): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('A result success schema must be a JSON Schema object.');
  }
  compile(schema as JsonRecord);
}

export interface ResultCheck {
  valid: boolean;
  /**
   * The check could not RUN, as against running and rejecting the body. The
   * size limit is this client's constant and the caller's success rule knows
   * nothing about it, so an over-limit body is not evidence the endpoint broke
   * its contract, and on a paid delivery the money has already moved by the
   * time it is measured. Callers deliver these with a caveat rather than
   * refusing them; a `valid: false` without it is a real contract failure.
   */
  unvalidated?: boolean;
  reason?: string;
  /**
   * WHAT A CATALOG OWNER NEEDS to tell one failure from another: a provider
   * whose parse missed looks exactly like one that answered HTML, and the
   * reason alone could not separate them during the live smoke.
   */
  diagnosis?: {
    /** `not-json`, `too-large`, or the schema rule that rejected it. */
    failed: string;
    json: boolean;
    bytes: number;
    maxBytes: number;
    /** First 300 characters, redacted. Other people's content, never instructions. */
    preview: string;
  };
}

/** A bounded, redacted look at the body, for a refusal a human has to act on. */
function preview(body: string): string {
  const flat = mask(body).replace(/\s+/g, ' ').trim();
  return flat.length <= 300 ? flat : `${flat.slice(0, 300)}…`;
}

/**
 * HTTP success and APPLICATION success are separate facts. A 200 whose body
 * fails the caller's declared success schema is a failure, and no success field
 * is ever inferred from the body itself.
 */
export function validateResultBody(schema: unknown, body: string): ResultCheck {
  const bytes = Buffer.byteLength(body);
  // Built only for a failure: masking a whole body is most of the cost of
  // checking one, and a passing body never shows its preview.
  const base = () => ({ json: false, bytes, maxBytes: MAX_BODY_BYTES, preview: preview(body) });
  if (bytes > MAX_BODY_BYTES) {
    // NOT a contract failure: nothing was checked. See {@link ResultCheck.unvalidated}.
    return {
      valid: false,
      unvalidated: true,
      reason: `The result is ${bytes} bytes, over the ${MAX_BODY_BYTES} byte validation limit, so its success schema was not checked.`,
      diagnosis: { ...base(), failed: 'too-large' },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
    walk(value, false);
  } catch (err) {
    return {
      valid: false,
      reason: `The result is not a supported bounded JSON document (${err instanceof Error ? err.message : String(err)}).`,
      diagnosis: { ...base(), failed: 'not-json' },
    };
  }
  // Bounded by the body cap above, not by the far smaller cap on an input: a
  // 150 KB Apollo hit was refused here as "exceeds its size limit".
  const check = checkValue(schema, value);
  if (check.valid) return { valid: true };
  const failed = check.errors[0] ?? 'the success rule';
  return {
    valid: false,
    reason: `The result does not satisfy its success schema: ${failed}`,
    diagnosis: { ...base(), json: true, failed },
  };
}

/**
 * THE FIELDS A SPEC PROMISES, CUT FROM A RESULT BODY. Every property the
 * schema does not declare is dropped, through objects and array items, which
 * is Ajv's `removeAdditional: 'all'`; what the schema does not describe (a
 * value of another type, an object schema with no `properties`) stays whole.
 * The schema only cuts, it never refuses: a missing required field or a wrong
 * type is the success rule's business. Undefined when the body cannot be
 * projected (over the cap, not JSON, a schema this build cannot compile), so
 * the caller hands back the whole body instead.
 */
export function projectBody(schema: unknown, body: string): { value: unknown } | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return undefined;
  try {
    // Parsed afresh, so the deletions below touch nothing anyone else holds.
    const value: unknown = JSON.parse(body);
    walk(value, false);
    // `allErrors`, or Ajv stops at the first miss and cuts nothing past it.
    const project = compile(withoutPatterns(schema) as JsonRecord, {
      allErrors: true,
      ignoreUnknown: true,
      project: true,
    });
    project(value);
    return { value };
  } catch {
    return undefined;
  }
}

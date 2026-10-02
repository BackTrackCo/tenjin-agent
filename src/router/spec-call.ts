import { toMoney } from '../lib/money';
import { inputProblems } from '../lib/request-schema';
import type { ToolSpec } from './decision';

/**
 * A REQUEST SPEC, READ AND RUN. `request({id})` shows the agent a spec as text:
 * what the service does and costs, each input with its description and allowed
 * values, the fields Tenjin sets, one example and what comes back. `request({id,
 * input})` merges the pinned fields over the agent's input, checks the result
 * against the spec's schema, and builds the HTTP request the spec describes.
 * Nothing here talks to the network: the caller pays through `runPay`.
 */

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** A schema's type as one short phrase: `string`, `array of string`, `object {a, b}`. */
function typeOf(schema: Json): string {
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array') {
    const items = record(schema.items);
    return Object.keys(items).length ? `array of ${typeOf(items)}` : 'array';
  }
  if (type === 'object' || (type === undefined && schema.properties !== undefined)) {
    const names = Object.keys(record(schema.properties));
    return names.length ? `object {${clip(names.join(', '), 120)}}` : 'object';
  }
  if (typeof type === 'string') return type;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return 'one of several shapes';
  return 'any';
}

/** One input as a line: its name, type, whether required, its description and
 *  the values or bounds it allows. */
function fieldLine(name: string, schema: Json, required: boolean): string {
  const parts = [`${name} (${typeOf(schema)}${required ? ', required' : ''})`];
  if (typeof schema.description === 'string') parts.push(clip(schema.description.trim(), 300));
  if (Array.isArray(schema.enum))
    parts.push(
      `one of ${schema.enum
        .slice(0, 25)
        .map((v) => JSON.stringify(v))
        .join(', ')}${schema.enum.length > 25 ? ', …' : ''}`,
    );
  const items = record(schema.items);
  if (Array.isArray(items.enum))
    parts.push(
      `each one of ${items.enum
        .slice(0, 25)
        .map((v) => JSON.stringify(v))
        .join(', ')}`,
    );
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  if (typeof schema.format === 'string') parts.push(`format ${schema.format}`);
  for (const [key, label] of [
    ['minimum', 'min'],
    ['maximum', 'max'],
    ['minLength', 'min length'],
    ['maxLength', 'max length'],
    ['maxItems', 'max items'],
  ] as const)
    if (typeof schema[key] === 'number') parts.push(`${label} ${String(schema[key])}`);
  return `- ${parts.join('; ')}`;
}

/** What one call costs, as the spec says it. */
function priceLine(spec: ToolSpec): string {
  const price = `$${toMoney(spec.priceAtomic).usd}`;
  return spec.priceVaries
    ? `${price} per call at the listed input; the price varies with the input (up to $${toMoney(spec.maxAmountAtomic).usd}) and the live price is checked before paying`
    : `${price} per call`;
}

/** The spec as the agent reads it, ending with the call that runs it. */
export function specText(id: string, spec: ToolSpec): string {
  const properties = record(spec.input.properties);
  const required = new Set(Array.isArray(spec.input.required) ? spec.input.required : []);
  const open = Object.keys(properties).filter((name) => !(name in spec.pinned));
  const ordered = [
    ...open.filter((name) => required.has(name)),
    ...open.filter((name) => !required.has(name)),
  ];
  const lines = [
    `${spec.provider}: ${spec.description}`,
    `Price: ${priceLine(spec)}, paid by this machine's wallet straight to the provider.`,
    `Request: ${spec.request.method} ${spec.request.url}`,
    ordered.length
      ? `Inputs:\n${ordered.map((name) => fieldLine(name, record(properties[name]), required.has(name))).join('\n')}`
      : 'Inputs: none.',
  ];
  if (Object.keys(spec.pinned).length)
    lines.push(
      `Set by Tenjin on every call (leave these out): ${Object.entries(spec.pinned)
        .map(([name, value]) => `${name} = ${JSON.stringify(value)}`)
        .join('; ')}`,
    );
  if (spec.example !== undefined) lines.push(`Example input: ${JSON.stringify(spec.example)}`);
  if (spec.returns !== undefined) lines.push(`Returns: ${spec.returns}`);
  if (spec.returnsExample !== undefined)
    lines.push(`Example of what comes back (shortened): ${JSON.stringify(spec.returnsExample)}`);
  lines.push(
    `To run it, call request({id: ${JSON.stringify(id)}, input: {...}}) with the inputs above. Nothing has been paid.`,
  );
  return lines.join('\n');
}

/** The agent's input with the pinned fields over it: a pin always wins. */
export function mergedInput(spec: ToolSpec, input: Json): Json {
  return { ...input, ...spec.pinned };
}

/**
 * Every problem with the merged input, against the spec's own schema; [] when
 * it fits; undefined when this build cannot compile the schema, so nothing
 * here can say the input fits and the call must not be paid. A field the spec
 * does not name is a problem too, whatever the schema says about extras: the
 * agent has no description for it, so it is a guess, and a paid guess at that.
 */
export function specInputProblems(spec: ToolSpec, merged: Json): string[] | undefined {
  const problems = inputProblems(spec.input, merged);
  if (problems === undefined) return undefined;
  const properties = spec.input.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties))
    return problems;
  for (const name of Object.keys(merged)) {
    if (Object.hasOwn(properties, name) || Object.hasOwn(spec.pinned, name)) continue;
    const problem = `the input has no field ${JSON.stringify(name)}`;
    if (!problems.includes(problem)) problems.push(problem);
  }
  return problems;
}

export interface SpecRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const scalar = (value: unknown): value is string | number | boolean =>
  (typeof value === 'string' && value.length > 0) ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  typeof value === 'boolean';

/** A value one path segment can hold: `encodeURIComponent` leaves `.` and `..`
 *  as they are, and either would move the call to another path on the origin. */
const segment = (value: unknown): boolean => scalar(value) && value !== '.' && value !== '..';

/**
 * The HTTP request the spec describes, filled from the merged input, or why it
 * cannot be built. A path placeholder takes its field's value as one encoded
 * segment; a query field is sent as text; the rest is the JSON body. The
 * request never leaves the spec's own origin.
 */
export function buildSpecRequest(spec: ToolSpec, merged: Json): SpecRequest | { problem: string } {
  const where = (name: string) => spec.request.fields[name] ?? spec.request.location;
  const inPath = [...spec.request.url.matchAll(PLACEHOLDER_RE)].map((match) => match[1]!);
  const missing = inPath.filter((name) => !segment(merged[name]));
  if (missing.length)
    return {
      problem: `${missing.join(', ')} ${missing.length > 1 ? 'go' : 'goes'} in the URL path, so each must be a non-empty string or number other than "." or ".."`,
    };
  let base: URL;
  let url: URL;
  try {
    base = new URL(spec.request.url);
    url = new URL(
      spec.request.url.replace(PLACEHOLDER_RE, (_, name: string) =>
        encodeURIComponent(String(merged[name])),
      ),
    );
  } catch {
    return { problem: 'the spec names a URL this build cannot parse' };
  }
  if (url.origin !== base.origin || url.protocol !== 'https:')
    return { problem: 'the filled URL left the service it names' };
  const body: Json = {};
  const nested: string[] = [];
  for (const [name, value] of Object.entries(merged)) {
    if (inPath.includes(name)) continue;
    const location = where(name);
    if (location === 'path') continue;
    if (location === 'body') {
      body[name] = value;
      continue;
    }
    if (value === null || typeof value === 'object') nested.push(name);
    else url.searchParams.set(name, String(value));
  }
  if (nested.length)
    return {
      problem: `${nested.join(', ')} ${nested.length > 1 ? 'go' : 'goes'} in the query string, so each must be a string, number or boolean`,
    };
  if (spec.request.method === 'GET') {
    if (Object.keys(body).length)
      return {
        problem: `a GET carries no body, so ${Object.keys(body).join(', ')} cannot be sent`,
      };
    return { url: url.toString(), method: 'GET', headers: { accept: 'application/json' } };
  }
  return {
    url: url.toString(),
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

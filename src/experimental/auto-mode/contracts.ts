import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

export type JsonSchema = Record<string, unknown> | boolean;
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export interface AutoContract {
  version: 1;
  id: string;
  url: string;
  method: HttpMethod;
  description: string;
  sourceHash: string;
  schemaSource: 'bazaar-v2' | 'legacy-outputSchema';
  argumentSchema: Record<string, unknown>;
  /** A same-origin path only; never a model-controlled destination. */
  pathTemplate: string;
  bodyEncoding?: 'json' | 'text' | 'form-urlencoded';
  responseKind: 'json' | 'text' | 'unknown';
  accepts: unknown[];
  x402Version?: number;
}

export type CompileResult =
  | { status: 'supported'; contract: AutoContract }
  | { status: 'unsupported'; id: string; url?: string; reasons: string[] };

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_SCHEMA_BYTES = 96 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_DEPTH = 24;
const bindings = {
  body: 'body',
  queryParams: 'query',
  pathParams: 'path',
  headers: 'headers',
} as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record(value)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contractHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/** Lexical check only. The network transport must also check resolved addresses. */
export function assertPublicHttpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Only HTTPS URLs without credentials or fragments are supported');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Private or local destinations are unsupported');
  }
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    ) {
      throw new Error('Private or reserved IP destinations are unsupported');
    }
  } else if (isIP(host) === 6) {
    // IPv6 support belongs in the resolver-aware transport, not URL guesswork.
    throw new Error('Literal IPv6 destinations require a resolver-aware transport');
  }
  return url;
}

const validators = new Map<string, ValidateFunction>();

function checkedSchema(value: unknown, depth = 0, schemaMode = true): void {
  if (depth > MAX_DEPTH) throw new Error('Schema or arguments exceed nesting limit');
  if (Array.isArray(value)) {
    for (const entry of value) checkedSchema(entry, depth + 1, schemaMode);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error(`Forbidden object key: ${key}`);
      // Ajv compiles schema keywords, never merchant scripts. Reject remote refs
      // and regular expressions until a bounded regexp runtime is available.
      if (schemaMode && key === '$ref' && typeof entry === 'string' && !entry.startsWith('#/'))
        throw new Error('Remote or recursive schema references are unsupported');
      if (schemaMode && (key === 'pattern' || key === 'patternProperties'))
        throw new Error('Regular-expression schema constraints require a bounded regexp primitive');
      checkedSchema(entry, depth + 1, schemaMode);
    }
  }
}

function validator(schema: Record<string, unknown>): ValidateFunction {
  const serialized = stable(schema);
  if (Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES)
    throw new Error('Schema exceeds size limit');
  const key = contractHash(schema);
  const prior = validators.get(key);
  if (prior) return prior;
  checkedSchema(schema);
  const options = {
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allErrors: false,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    allowUnionTypes: true,
  };
  const ajv =
    schema.$schema === 'http://json-schema.org/draft-07/schema#'
      ? new Ajv(options)
      : new Ajv2020(options);
  // Nested body schemas in Bazaar can declare draft-07 under a 2020 parent.
  // Ajv's dialect keywords remain checked; no remote schema loading is enabled.
  if (!ajv.getSchema('http://json-schema.org/draft-07/schema#')) {
    ajv.addMetaSchema({ $id: 'http://json-schema.org/draft-07/schema#' });
  }
  addFormats(ajv);
  const compiled = ajv.compile(schema);
  if (validators.size >= 128) validators.delete(validators.keys().next().value!);
  validators.set(key, compiled);
  return compiled;
}

function schemaDefined(schema: unknown): boolean {
  const s = record(schema);
  return (
    typeof s.type === 'string' &&
    (s.type !== 'object' ||
      Object.keys(record(s.properties)).length > 0 ||
      s.additionalProperties === false)
  );
}

function scalarMapSchema(schema: unknown, name: string): void {
  const s = record(schema);
  if (s.type !== 'object') throw new Error(`${name} must have an object schema`);
  for (const [key, value] of Object.entries(record(s.properties))) {
    const property = record(value);
    const types = Array.isArray(property.type) ? property.type : [property.type];
    if (
      types.some((type) => !['string', 'number', 'integer', 'boolean'].includes(String(type))) &&
      !property.oneOf &&
      !property.anyOf
    ) {
      throw new Error(
        `${name}.${key} needs an explicit scalar serialization; arrays and objects are unsupported`,
      );
    }
  }
}

function declaredMethod(
  input: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  resource: Record<string, unknown>,
): HttpMethod {
  const methodSchema = record(record(inputSchema.properties).method);
  const enumeration = Array.isArray(methodSchema.enum) ? methodSchema.enum : [];
  const value =
    input.method ??
    resource.method ??
    methodSchema.const ??
    (enumeration.length === 1 ? enumeration[0] : undefined);
  if (typeof value !== 'string' || !METHODS.has(value.toUpperCase()))
    throw new Error('Missing or unsupported explicit HTTP method');
  const method = value.toUpperCase();
  if (
    typeof input.method === 'string' &&
    typeof resource.method === 'string' &&
    input.method.toUpperCase() !== resource.method.toUpperCase()
  )
    throw new Error('HTTP method contradicts resource metadata');
  if (enumeration.length && !enumeration.includes(method))
    throw new Error('HTTP method contradicts its schema');
  return method as HttpMethod;
}

const ENVELOPE_KEYS = new Set([
  '$schema',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  '$comment',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** Envelope keywords are not argument schemas after bindings are extracted. */
function checkEnvelope(schema: Record<string, unknown>, location: string): void {
  if (
    schema.$schema !== undefined &&
    ![
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft-07/schema#',
    ].includes(String(schema.$schema))
  )
    throw new Error(`${location} declares an unsupported JSON Schema dialect`);
  for (const key of Object.keys(schema)) {
    if (!ENVELOPE_KEYS.has(key))
      throw new Error(`${location} constraint requires translation: ${key}`);
  }
  if (schema.type !== undefined && schema.type !== 'object')
    throw new Error(`${location} must describe an object`);
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))
  )
    throw new Error(`${location} required must list property names`);
}

function checkFixedMetadata(
  inputSchema: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  const declared = record(inputSchema.properties)[name];
  const schema = declared ?? inputSchema.additionalProperties ?? true;
  const validate = validator({
    type: 'object',
    properties: { value: schema },
    required: ['value'],
    additionalProperties: false,
  });
  if (!validate({ value })) throw new Error(`Fixed request ${name} contradicts input schema`);
}

/** Mechanical import only: examples do not establish a required argument schema. */
export function compileResource(value: unknown): CompileResult {
  const source = record(value);
  const url =
    typeof source.resource === 'string'
      ? source.resource
      : typeof source.url === 'string'
        ? source.url
        : undefined;
  const id = contractHash({ url, method: source.method }).slice(0, 20);
  try {
    if (!url) throw new Error('Missing endpoint URL');
    const parsed = assertPublicHttpsUrl(url);
    if (source.type !== undefined && source.type !== 'http')
      throw new Error('Only HTTP resources are supported');
    const bazaar = record(record(source.extensions).bazaar);
    const legacy = record(
      source.outputSchema ??
        record((Array.isArray(source.accepts) ? source.accepts : [])[0]).outputSchema,
    );
    const v2 = Object.keys(bazaar).length > 0;
    if (v2) {
      const rootSchema = record(bazaar.schema);
      checkEnvelope(rootSchema, 'Bazaar envelope');
      for (const key of Array.isArray(rootSchema.required) ? rootSchema.required : []) {
        if (typeof key !== 'string' || !Object.hasOwn(record(rootSchema.properties), key))
          throw new Error('Bazaar envelope requires an undeclared property');
      }
    }
    const inputSchema = v2
      ? record(record(record(bazaar.schema).properties).input)
      : record(legacy.input);
    const input = v2 ? record(record(bazaar.info).input) : record(legacy.input);
    if (!Object.keys(inputSchema).length)
      throw new Error(
        'Missing machine-readable input schema; documentation translation is required',
      );
    const method = declaredMethod(input, inputSchema, source);
    const inputProperties = v2 ? record(inputSchema.properties) : input;
    if (input.type !== undefined && input.type !== 'http')
      throw new Error('Only HTTP inputs are supported');
    if (v2) {
      checkEnvelope(inputSchema, 'Cross-binding input');
      // Check the original fragment before extraction so malformed constraints
      // cannot become valid merely because the translator omitted a keyword.
      validator(inputSchema);
      for (const key of Object.keys(inputProperties)) {
        if (!['type', 'method', 'bodyType', ...Object.keys(bindings)].includes(key))
          throw new Error(`Unsupported request binding: ${key}`);
      }
      for (const key of Array.isArray(inputSchema.required) ? inputSchema.required : []) {
        if (typeof key !== 'string' || !Object.hasOwn(inputProperties, key))
          throw new Error('Input envelope requires an undeclared property');
      }
      checkFixedMetadata(inputSchema, 'method', method);
      checkFixedMetadata(inputSchema, 'type', 'http');
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const sourceRequired = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    for (const [sourceName, targetName] of Object.entries(bindings)) {
      const schema =
        inputProperties[sourceName] ??
        (sourceName === 'body' ? inputProperties.bodyFields : undefined);
      if (schema === undefined) continue;
      // Legacy fields can be either complete schemas or maps of field schemas.
      const normalized =
        v2 || record(schema).type
          ? schema
          : {
              type: 'object',
              properties: schema,
              ...(sourceName === 'body' && Array.isArray(input.required)
                ? { required: input.required }
                : {}),
            };
      const emptyPath =
        sourceName === 'pathParams' &&
        Object.keys(record(record(normalized).properties)).length === 0;
      if (emptyPath && !sourceRequired.includes('pathParams')) continue;
      if (!schemaDefined(normalized))
        throw new Error(`Missing or unconstrained ${sourceName} schema; examples are insufficient`);
      if (sourceName !== 'body') scalarMapSchema(normalized, sourceName);
      properties[targetName] = structuredClone(normalized);
      if (
        sourceRequired.includes(sourceName) ||
        (Array.isArray(record(normalized).required) &&
          (record(normalized).required as unknown[]).length > 0)
      )
        required.push(targetName);
    }
    const hasBody = properties.body !== undefined;
    if ((method === 'GET' || method === 'HEAD') && hasBody)
      throw new Error(`${method} requests cannot carry a body`);
    if (!Object.keys(properties).length && inputSchema.additionalProperties !== false)
      throw new Error('No parameter contract or explicit no-arguments declaration');
    let bodyEncoding: AutoContract['bodyEncoding'];
    if (hasBody) {
      const bodyTypeSchema = record(inputProperties.bodyType);
      const choices = Array.isArray(bodyTypeSchema.enum) ? bodyTypeSchema.enum : [];
      const bodyType =
        input.bodyType ?? bodyTypeSchema.const ?? (choices.length === 1 ? choices[0] : undefined);
      if (v2) checkFixedMetadata(inputSchema, 'bodyType', bodyType);
      if (bodyType === 'json') bodyEncoding = 'json';
      else if (bodyType === 'text' && record(properties.body).type === 'string')
        bodyEncoding = 'text';
      else if (bodyType === 'form-urlencoded') {
        scalarMapSchema(properties.body, 'body');
        bodyEncoding = 'form-urlencoded';
      } else throw new Error(`Unsupported or missing body encoding: ${String(bodyType)}`);
    } else if (sourceRequired.includes('bodyType'))
      throw new Error('Input requires bodyType without a body contract');
    let pathTemplate = decodeURI(parsed.pathname);
    if (properties.path !== undefined) {
      const proposed = bazaar.routeTemplate ?? source.routeTemplate;
      if (
        typeof proposed === 'string' &&
        proposed.startsWith('/') &&
        !proposed.startsWith('//') &&
        !/[?#\\]/.test(proposed)
      )
        pathTemplate = proposed;
      const names = [
        ...pathTemplate.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
      ].map((match) => match[1] ?? match[2]!);
      const declared = Object.keys(record(record(properties.path).properties));
      if (
        !names.length ||
        names.some((name) => !declared.includes(name)) ||
        declared.some((name) => !names.includes(name))
      )
        throw new Error('Path template must bind every declared path parameter exactly');
      const originalPath = decodeURI(parsed.pathname);
      if (pathTemplate !== originalPath) {
        const example = record(input.pathParams);
        const expanded = pathTemplate.replace(
          /:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_, a: string | undefined, b: string | undefined) =>
            encodeURIComponent(scalar(example[a ?? b!], 'path example')),
        );
        if (expanded !== parsed.pathname)
          throw new Error(
            'Path template does not reproduce the listed endpoint from published examples',
          );
      }
      if (!required.includes('path')) required.push('path');
      properties.path = {
        ...record(properties.path),
        required: [
          ...new Set([
            ...((record(properties.path).required as string[] | undefined) ?? []),
            ...names,
          ]),
        ],
        additionalProperties: false,
      };
    } else if (/:([A-Za-z_][A-Za-z0-9_]*)|\{[^}]+\}/.test(pathTemplate))
      throw new Error('URL contains unbound path parameters');
    const argumentSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
    validator(argumentSchema);
    const responseType = record(record(bazaar.info).output).type ?? record(legacy.output).type;
    if (responseType !== undefined && !['json', 'text'].includes(String(responseType)))
      throw new Error(`Unsupported response kind: ${String(responseType)}`);
    const contractData = {
      url,
      method,
      description: typeof source.description === 'string' ? source.description.slice(0, 4096) : '',
      argumentSchema,
      pathTemplate,
      bodyEncoding,
      responseKind:
        responseType === 'json'
          ? ('json' as const)
          : responseType === 'text'
            ? ('text' as const)
            : ('unknown' as const),
    };
    return {
      status: 'supported',
      contract: {
        version: 1,
        id: contractHash({ url, method }).slice(0, 20),
        ...contractData,
        schemaSource: v2 ? 'bazaar-v2' : 'legacy-outputSchema',
        sourceHash: contractHash({ ...contractData, sourceSchema: v2 ? bazaar.schema : legacy }),
        accepts: Array.isArray(source.accepts) ? structuredClone(source.accepts) : [],
        ...(typeof source.x402Version === 'number' ? { x402Version: source.x402Version } : {}),
      },
    };
  } catch (error) {
    return {
      status: 'unsupported',
      id,
      ...(url ? { url } : {}),
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function validateArguments(
  contract: AutoContract,
  args: unknown,
): { valid: boolean; errors: string[] } {
  try {
    const json = JSON.stringify(args);
    if (json === undefined || Buffer.byteLength(json) > MAX_ARGUMENT_BYTES)
      throw new Error('Arguments exceed size limit or are not JSON');
    // JSON round-tripping prevents exotic JS objects; arguments normally arrive from JSON stdin.
    checkedSchema(args, 0, false);
    const validate = validator(contract.argumentSchema);
    if (!validate(args))
      return {
        valid: false,
        errors: (validate.errors ?? []).map(
          (error) => `${error.instancePath || '/'} ${error.message}`,
        ),
      };
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function scalar(value: unknown, location: string): string {
  if (
    !['string', 'number', 'boolean'].includes(typeof value) ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    throw new Error(`${location} requires an explicit scalar value`);
  return String(value);
}

export function buildRequest(contract: AutoContract, args: unknown): BuiltRequest {
  const check = validateArguments(contract, args);
  if (!check.valid) throw new Error(`Invalid arguments: ${check.errors.join('; ')}`);
  const argumentsObject = record(args);
  const destination = assertPublicHttpsUrl(contract.url);
  const baseOrigin = destination.origin;
  const pathArgs = record(argumentsObject.path);
  const path = contract.pathTemplate.replace(
    /:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, a: string | undefined, b: string | undefined) => {
      const key = a ?? b!;
      const value = scalar(pathArgs[key], `path.${key}`);
      if (
        !value ||
        value === '.' ||
        value === '..' ||
        /[\\/%]/.test(value) ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error(`Unsafe path parameter ${key}`);
      return encodeURIComponent(value);
    },
  );
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path))
    throw new Error('Invalid pinned path template');
  destination.pathname = path;
  if (destination.origin !== baseOrigin) throw new Error('Request escaped pinned destination');
  for (const [key, value] of Object.entries(record(argumentsObject.query))) {
    const encoded = scalar(value, `query.${key}`);
    if (destination.searchParams.has(key) && destination.searchParams.get(key) !== encoded)
      throw new Error(`Query ${key} would change a pinned endpoint parameter`);
    destination.searchParams.set(key, encoded);
  }
  const headers: Record<string, string> = {
    accept: contract.responseKind === 'text' ? 'text/plain' : 'application/json, text/plain',
  };
  for (const [key, value] of Object.entries(record(argumentsObject.headers))) {
    const lowered = key.toLowerCase();
    if (
      !/^[a-z0-9-]+$/.test(lowered) ||
      /^(authorization|cookie|host|content-length|connection|proxy-|payment-|x-payment|x-api-key|api-key)/.test(
        lowered,
      )
    )
      throw new Error(`Header ${key} requires a trusted authentication/transport primitive`);
    const headerValue = scalar(value, `headers.${key}`);
    if (/[\r\n]/.test(headerValue)) throw new Error(`Invalid header ${key}`);
    headers[lowered] = headerValue;
  }
  let body: string | undefined;
  if (argumentsObject.body !== undefined) {
    if (contract.bodyEncoding === 'json') {
      body = JSON.stringify(argumentsObject.body);
      headers['content-type'] = 'application/json';
    } else if (contract.bodyEncoding === 'text') {
      body = scalar(argumentsObject.body, 'body');
      headers['content-type'] = 'text/plain';
    } else if (contract.bodyEncoding === 'form-urlencoded') {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(record(argumentsObject.body)))
        form.set(key, scalar(value, `body.${key}`));
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else throw new Error('No body encoding in pinned contract');
  }
  return {
    url: destination.toString(),
    method: contract.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/** No provider-specific projection: preserve the bounded response as returned. */
export function decodeResult(
  text: string,
  contentType: string,
): { kind: 'json' | 'text'; data: unknown } {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Result exceeds 128 KiB limit');
  if (/\b(?:application\/json|application\/[a-z0-9.+-]+\+json)\b/i.test(contentType))
    return { kind: 'json', data: JSON.parse(text) as unknown };
  if (/^(text\/plain|text\/markdown|text\/html)(?:;|$)/i.test(contentType))
    return { kind: 'text', data: text };
  throw new Error(`Unsupported response media type: ${contentType}`);
}

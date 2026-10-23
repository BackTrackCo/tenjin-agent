import { z } from 'zod';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { FetchJsonFailure, HttpRequestOptions, HttpResult } from '../lib/http';
import type { CommandContext } from '../context';
import type { Packet } from './context';
import type { Harness } from './names';
import {
  BUILT_IN_SOURCE,
  ONLY_DIMENSIONS,
  POLICY_MAX_BYTES,
  POLICY_VERSION,
  TARGET_KINDS,
  overrideProblems,
  policyProblems,
  type Problem,
} from './access';
import { ACCOUNT_ID } from './accounts/ids';

export { BUILT_IN_SOURCE, ONLY_DIMENSIONS, POLICY_MAX_BYTES, POLICY_VERSION, TARGET_KINDS };
export type { OnlyDimension, TargetKind } from './access';

/**
 * `POST /api/x402-router`: ONE DECISION PER LOOKUP. On the free path it costs
 * nothing. Inside `tenjin mcp`, while the server answers its paid path, the
 * same body goes to that path through the stock x402 client
 * ({@link DecisionRoute}, `routing-payer.ts`); a call that path cannot take
 * falls back to the free path. The rest of this note describes the free path,
 * which is unchanged.
 *
 * The routing decision costs nothing and nobody signs for it. The hook asks for
 * it from the user's own words, the backend answers with what it would do and
 * what the provider charges, and the only payment on the wire is the one
 * `runPay` makes to that provider. That deletes the router fee and everything
 * built to carry it: the 402 probe, the requirements cache, the stale-quote
 * retry, the settlement accounting and one Base settlement of about 1.5 s from
 * every paid lookup.
 *
 * The bounded packet travels with the hook request and the backend keeps it
 * against the decision id until that id expires. What this client keeps is
 * each offer's spec, by its id (`specs.ts`).
 */

export const ROUTER_PATH = '/api/x402-router';

/**
 * The request the server builds and this client sends verbatim. Query assembly,
 * body encoding and header choice are the server's; what stays here is every
 * check that decides whether to send it at all.
 */
const RequestSchema = z.object({
  url: z.string().min(1).max(16_384),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  headers: z.record(z.string(), z.string()),
  body: z
    .string()
    .max(256 * 1024)
    .optional(),
});

const ContractSchema = z.object({
  /** Flat, for display and for the result check; never re-encoded into a call:
   *  the server built `request` from them and this client sends that verbatim. */
  arguments: z.record(z.string(), z.unknown()).optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  request: RequestSchema,
});
export type DecisionContract = z.infer<typeof ContractSchema>;

/*
 * THE USER'S SETTINGS ON THE WIRE, mirrored from tenjin's `wire.ts` with the
 * same bounds, every object strict. `policy` is the saved routing rules
 * (`router.policy`, global file only), `override` one request's narrowing.
 * Code enforces both on each side; Jev never sees either. The checks beyond
 * shape (`policyProblems`, `overrideProblems`) live in `access.ts`, which both
 * these schemas and the config writer run, so a policy this client saves is
 * one the server takes.
 */

/** Any typed id: task ids carry spaces and capitals ("company match by name or
 *  social URL"), Bazaar ids colons. */
export const TargetIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/);
export const TargetSchema = z.strictObject({ kind: z.enum(TARGET_KINDS), id: TargetIdSchema });
export const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('task'), id: TargetIdSchema }),
]);
const RevisionSchema = z.string().regex(/^[0-9a-f]{16}$/);

export const OnlyRuleSchema = z.strictObject({
  scope: ScopeSchema,
  dimension: z.enum(ONLY_DIMENSIONS),
  targets: z.array(TargetSchema).min(1).max(64),
});
export const PreferRuleSchema = z.strictObject({
  scope: ScopeSchema,
  targets: z.array(TargetSchema).min(1).max(16),
});

export type Target = z.infer<typeof TargetSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type OnlyRule = z.infer<typeof OnlyRuleSchema>;
export type PreferRule = z.infer<typeof PreferRuleSchema>;

/** Each problem a check in `access.ts` found, as an issue at its path. */
function reported(problems: Problem[], ctx: z.RefinementCtx): void {
  for (const { message, path } of problems) ctx.addIssue({ code: 'custom', message, path });
}

export const WirePolicySchema = z
  .strictObject({
    version: z.literal(POLICY_VERSION),
    /** sha256 of the rest, first 16 hex: logged, never authority. */
    revision: RevisionSchema.optional(),
    /** Connected sources on this machine; `tenjin` is implied, never listed. */
    sources: z.array(TargetIdSchema).min(1).max(16).optional(),
    block: z.array(TargetSchema).min(1).max(128).optional(),
    only: z.array(OnlyRuleSchema).min(1).max(32).optional(),
    prefer: z.array(PreferRuleSchema).min(1).max(64).optional(),
  })
  .superRefine((policy, ctx) => reported(policyProblems(policy), ctx));
export type WirePolicy = z.infer<typeof WirePolicySchema>;

/** This request only: it narrows or re-ranks, and never widens, connects,
 *  raises a limit or turns on replacement. Its only rules are global. */
export const WireOverrideSchema = z
  .strictObject({
    only: z
      .array(
        z.strictObject({
          dimension: z.enum(ONLY_DIMENSIONS),
          targets: z.array(TargetSchema).min(1).max(16),
        }),
      )
      .min(1)
      .max(4)
      .optional(),
    prefer: z.array(TargetSchema).min(1).max(16).optional(),
  })
  .superRefine((override, ctx) => reported(overrideProblems(override), ctx));
export type WireOverride = z.infer<typeof WireOverrideSchema>;

/**
 * A ROUTE AS THE USER'S SETTINGS READ IT, sent on every spec and both
 * `execute` arms because this build lists `identity`. Built by the server from
 * reviewed catalog data, never from a display name or a hostname. `providers`
 * names every upstream party, sorted; `[]` and an absent `seller` are unknown,
 * which only an open-Bazaar listing is. Not the discovered candidate's
 * `source` (listing provenance) and not a payee label: those are never read
 * as identity.
 */
export const IdentitySchema = z.strictObject({
  /** The catalog id, or an open-Bazaar listing's `discovered:bazaar:` id. */
  service: TargetIdSchema,
  source: TargetIdSchema,
  providers: z.array(TargetIdSchema).max(8),
  seller: TargetIdSchema.optional(),
  /** The wire's `category`; absent for a Bazaar listing. */
  task: TargetIdSchema.optional(),
  /** The categories whose reviewed membership holds `task`. */
  categories: z.array(TargetIdSchema).max(8),
  /** Changes exactly when one of the fields above does. */
  revision: RevisionSchema,
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * THE RULE A `policy_refused` NAMES, read LENIENTLY: every field a string, an
 * unknown key dropped, and a value that is not even that dropped with it. A
 * later rule kind (#37's `unavailable` source, say) must never cost the answer
 * it rides on, which is a refusal the host already acts on without it.
 */
const PolicyRuleSchema = z
  .object({
    from: z.string().min(1).max(32),
    kind: z.string().min(1).max(32),
    target: z.object({ kind: z.string().min(1).max(32), id: z.string().min(1).max(64) }).optional(),
    scope: z
      .object({ kind: z.string().min(1).max(32), id: z.string().min(1).max(64).optional() })
      .optional(),
    dimension: z.string().min(1).max(32).optional(),
  })
  .optional()
  .catch(undefined);
export type DiagnosticsRule = NonNullable<z.infer<typeof PolicyRuleSchema>>;

/**
 * What stopped an outcome this client cannot execute, in terms the host can act
 * on: a stable reason code, the stage that stopped, the fields or scope choices
 * the user can supply, and one concrete next action. `rule` rides only with
 * `policy_refused`, which only a request that carried `policy` gets.
 */
const DiagnosticsSchema = z.object({
  reasonCode: z.string().min(1).max(64),
  stage: z.string().min(1).max(32),
  missing: z.array(z.string().max(200)).max(60),
  nextAction: z.string().max(500),
  rule: PolicyRuleSchema,
});
export type DecisionDiagnostics = z.infer<typeof DiagnosticsSchema>;

/**
 * ONE VARIANT PER ANSWER, DISCRIMINATED ON THE ACTION. Optional fields made
 * every shape legal: an `execute` with no contract parsed and came back to the
 * host as a routine `needs_input`, a non-execute with no diagnostics parsed
 * with nothing to act on, and a hook answer carrying a contract parsed as
 * though the hook had quoted a price. Each of those is drift the shared
 * fixtures exist to catch, so each is now a parse failure that names itself.
 *
 * The two calls ask different questions and get different answers, so they get
 * different parsers. The HOOK asks whether a paid lookup is worth offering: an
 * id, or a reason it is not. The TOOL asks for the decision: the capability,
 * its price and the contract together, so a caller cannot approve one offer and
 * receive another.
 */
const IdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .describe(
    'The turn id, an OPAQUE HANDLE: it is the one piece of server text this ' +
      'client puts in a model-facing line, so the alphabet is pinned here ' +
      'rather than escaped later.',
  );

/** Every non-execute answer carries these, beside the action they explain. */
const RefusedSchema = z.strictObject({
  reason: z.string().max(2_000).optional(),
  diagnostics: DiagnosticsSchema,
});

/**
 * WHAT THE SERVICE IS, AND WHAT IT DOES. The hook answer used to be an id and
 * nothing else, so the line the host injected could only say "a paid lookup is
 * available", which a model follows 8 to 20 times in 40 where a line naming the
 * task and the service is followed 40 in 40. The gate knows which capability
 * serves the category it chose, so it now says so; the CONTRACT is still not
 * here, because the task the host will run does not exist yet.
 */
/** A display name the server gives a capability, sent because this build
 *  lists `label`. Shown exactly as given; absent, a surface says
 *  {@link UNLABELLED}. */
const LabelSchema = z.string().min(1).max(32);

/** What a surface names a lookup whose decision carries no `label`. */
export const UNLABELLED = 'Tenjin lookup';

const CapabilityFields = {
  capabilityId: z.string().min(1).max(200),
  category: z.string().min(1).max(64),
  /** The service's own name, not the x402 reseller in front of it. */
  provider: z.string().min(1).max(120),
  label: LabelSchema.optional(),
  capabilityDescription: z.string().min(1).max(500),
  /** What the provider charges, atomic USDC. The `request` tool refuses a live
   *  402 above it; `gateSpend` still caps the amount actually signed. */
  providerPriceAtomic: z.string().regex(/^\d+$/),
  /** Because this build lists `identity`. The free docs lookup has no spec,
   *  so this is its only identity. */
  identity: IdentitySchema.optional(),
};

/**
 * STRUCTURE, NEVER WORDING. A hint lands in the model's context verbatim, so
 * its shape is checked the way the id's alphabet is: one line, no control
 * characters, and it has to be the call it claims to be, naming the id this
 * same answer carries. A hint that fails any of these is a protocol error and
 * the turn falls back to the generic line; nothing here rewrites a word of a
 * hint that passes. Both offering arms, `execute` and `discovered`, hold it.
 */
function checkHint(decision: { id: string; hint: string }, ctx: z.RefinementCtx): void {
  if (/[\p{Cc}\p{Cf}]/u.test(decision.hint)) {
    ctx.addIssue({ code: 'custom', path: ['hint'], message: 'a hint is one plain line' });
  }
  if (!decision.hint.includes('request({')) {
    ctx.addIssue({ code: 'custom', path: ['hint'], message: 'a hint names the call to make' });
  }
  if (!decision.hint.includes(decision.id)) {
    ctx.addIssue({
      code: 'custom',
      path: ['hint'],
      message: "a hint carries this answer's own id",
    });
  }
}

/**
 * A PAY-PER-CALL SERVICE NOBODY CURATED. When a Tenjin list service does the
 * task the gate picked, or no task fits and a listed x402 service could do the
 * step, the server names that one service: who sells it, where, for how much,
 * and the input it takes. A Tenjin list service arrives here under its catalog
 * id, because this build sends `catalog`. The candidate is the seller's own
 * listing, so every field is data for the host to judge, never an instruction;
 * the host builds the `input` and the tool call pays through the same `runPay`
 * path and caps as a curated lookup.
 */
const DiscoveredCandidateSchema = z.strictObject({
  source: z.string().min(1).max(64),
  provider: z.string().min(1).max(120),
  url: z.string().min(1).max(2_048),
  method: z.enum(['GET', 'POST']),
  description: z.string().max(500),
  providerPriceAtomic: z.string().regex(/^\d+$/),
  network: z.string().min(1).max(64),
  payTo: z.string().min(1).max(200),
  input: z.strictObject({
    location: z.enum(['body', 'query']),
    schema: z.record(z.string(), z.unknown()),
  }),
});

/** A field name a job reads from an answer or writes into a poll body. */
const JobField = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

/** A body field whose value names a state: Treza's `status: "running"`. */
const JobFieldStateSchema = z.strictObject({
  field: JobField,
  values: z.array(z.string().min(1).max(64)).min(1).max(8),
});

/** A poll body value naming a field of the call's input or of the submit's
 *  answer; any other value is sent as written. */
export const POLL_REFERENCE = /^\$(input|result)\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;

/**
 * HOW A CALL WHOSE SELLER ANSWERS BEFORE THE RESULT IS READY IS FINISHED, sent
 * on a spec only because this build asks for it (`accepts: ["jobs"]`): where
 * the status is (a field or header of the submit's answer, or one fixed URL),
 * how a poll is sent, what says it is still running or failed, how often and
 * how long to poll, and how many hours the job can be resumed. `always`: the
 * seller never answers inline. A poll is never signed: the take's one payment
 * is its submit. Every field is the server's: the poll and complete URLs are
 * still checked here against the submit's host (`jobs.ts`).
 */
export const JobSchema = z
  .strictObject({
    pollUrl: z.union([
      z
        .strictObject({
          field: JobField.optional(),
          header: z
            .string()
            .regex(/^[A-Za-z0-9-]{1,64}$/)
            .optional(),
        })
        .refine((at) => at.field !== undefined || at.header !== undefined, 'a field or a header'),
      z.strictObject({ fixed: z.string().min(1).max(2_048) }),
    ]),
    /** Sent once like a poll after the result is saved, never after a save
     *  that failed: it frees the seller's copy (AiSpace's `/complete`). Its
     *  answer is ignored. */
    completeUrl: z.strictObject({ fixed: z.string().min(1).max(2_048) }).optional(),
    pollMethod: z.enum(['GET', 'POST']),
    pollBody: z
      .record(JobField, z.unknown())
      .refine(
        (body) =>
          Object.values(body).every(
            (value) =>
              typeof value !== 'string' || !value.startsWith('$') || POLL_REFERENCE.test(value),
          ),
        'a $ value is $input.<field> or $result.<field>',
      )
      .optional(),
    running: z.union([
      z.strictObject({ httpStatus: z.array(z.number().int().min(200).max(299)).min(1).max(8) }),
      JobFieldStateSchema,
    ]),
    failed: JobFieldStateSchema.optional(),
    everyS: z.number().int().min(1).max(30),
    maxWaitS: z.number().int().min(1).max(600),
    keepH: z.number().int().min(1).max(48),
    always: z.literal(true).optional(),
  })
  .refine((job) => !job.pollBody || job.pollMethod === 'POST', 'only a POST poll has a body');
export type Job = z.infer<typeof JobSchema>;

/**
 * A REQUEST SPEC: the offered service's real contract, sent beside the line only
 * because this build asks for it (`accepts: ["spec"]`). The hook stores it by
 * the offer's id; `request({id})` shows it and `request({id, input})` fills its
 * request and pays the provider directly, with no second decision. Every field
 * is the server's, and so is checked like the rest of the answer: the payee and
 * price still meet the live 402 and the spend policy in `runPay`.
 */
export const ToolSpecSchema = z.strictObject({
  capabilityId: z.string().min(1).max(200),
  provider: z.string().min(1).max(120),
  /** The display name, on a catalog service's spec; a Bazaar spec has none. */
  label: LabelSchema.optional(),
  /** The input field that takes a pending search's query or fetch's URL. */
  holds: z
    .strictObject({
      WebSearch: z.string().min(1).max(64).optional(),
      WebFetch: z.string().min(1).max(64).optional(),
    })
    .optional(),
  /** What a paid result is. `media` means its files (bytes, links or inline
   *  base64) are saved locally; absent on a Bazaar spec. */
  output: z.enum(['json', 'text', 'media']).optional(),
  description: z.string().min(1).max(500),
  priceAtomic: z.string().regex(/^\d+$/),
  priceVaries: z.boolean(),
  maxAmountAtomic: z.string().regex(/^\d+$/),
  payTo: z.string().min(1).max(200),
  network: z.string().min(1).max(64),
  asset: z.string().min(1).max(200),
  request: z.strictObject({
    method: z.enum(['GET', 'POST']),
    url: z.string().min(1).max(2_048),
    fields: z.record(z.string(), z.enum(['path', 'query', 'body'])),
    location: z.enum(['query', 'body']),
  }),
  input: z.record(z.string(), z.unknown()),
  pinned: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).optional(),
  returns: z.string().min(1).max(200).optional(),
  returnsExample: z.unknown().optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  /** The fields the result promises (type, properties, items, required). The
   *  agent is handed only these; the whole body is saved to a file. */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /** How a call answered before its result is ready is finished. */
  job: JobSchema.optional(),
  /** A media service that runs several takes of one call: `count` up to `max`. */
  takes: z.strictObject({ max: z.number().int().min(2).max(5) }).optional(),
  /** This spec's own service, because this build lists `identity`: never one
   *  inferred from the lead. */
  identity: IdentitySchema.optional(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const OfferSpecSchema = ToolSpecSchema.extend({ id: IdSchema });
export type OfferSpec = z.infer<typeof OfferSpecSchema>;

/** One spec per service the line names: the offer, any other service it
 *  lists, and each option of a choice set. */
const SpecsSchema = z.array(OfferSpecSchema).min(1).max(8).optional();

/*
 * A SERVICE ON A CONNECTED ACCOUNT (#37), mirrored from tenjin's `wire.ts`
 * with the same bounds: one MCP tool call this client makes on the user's own
 * account, which the user's plan pays. Sent only because this build lists
 * `mcp` beside `identity`. It carries no URL and no credential: this client
 * calls the server it connected for `identity.source`, so no answer can send
 * a user's token anywhere else.
 */

/** A tool name as the MCP specification bounds it. */
export const McpToolSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);

/** The most an account call, its follow-up included, may serialize to. */
export const ACCOUNT_CALL_MAX_BYTES = 8 * 1024;

/** How a tool's answer is read: its `structuredContent`; the JSON its text
 *  items hold, joined in order; or its content items as they come. */
export const ACCOUNT_RESULTS = ['structured', 'json-text', 'content'] as const;

const RESULT_PATH = '[A-Za-z_][A-Za-z0-9_]{0,63}(?:\\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}';
/** An argument value that is exactly `{field}` is that input field's value, of
 *  its own JSON type; one that is exactly `{result.<path>}`, in a follow-up
 *  only, is the value at that path in the first call's result. Every other
 *  value is sent as written: that is how a map pins a tool's settings. */
export const INPUT_PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;
export const RESULT_PLACEHOLDER = new RegExp(`^\\{result\\.(${RESULT_PATH})\\}$`);

/** A value at a path of a tool's result, and the values that mean a state. */
const AccountStateSchema = z.strictObject({
  path: z.string().regex(new RegExp(`^${RESULT_PATH}$`)),
  values: z.array(z.string().min(1).max(64)).min(1).max(8),
});

const AccountCallFields = {
  tool: McpToolSchema,
  /** The tool's `arguments`, a template (above). */
  args: z.record(z.string(), z.unknown()),
  result: z.enum(ACCOUNT_RESULTS),
};

/** A status call, sent every `everyS` seconds until its own result leaves
 *  `running`; `failed` ends the call. `maxWaitS` counts from the first call. */
const AccountPollSchema = z.strictObject({
  ...AccountCallFields,
  running: AccountStateSchema,
  failed: AccountStateSchema.optional(),
  everyS: z.number().int().min(1).max(30),
  maxWaitS: z.number().int().min(1).max(600),
});

/** The follow-up that fetches the result, when the first call does not hold
 *  it: always, or only `when` the first result is in that state. The call
 *  that bills is sent once and never again because its job is still running;
 *  only `poll` repeats. */
const AccountStepSchema = z.strictObject({
  when: AccountStateSchema.optional(),
  poll: AccountPollSchema.optional(),
  ...AccountCallFields,
});

const AccountCallSchema = z.strictObject({
  ...AccountCallFields,
  next: AccountStepSchema.optional(),
});
export type AccountCall = z.infer<typeof AccountCallSchema>;

const AccountSpecFields = z.strictObject({
  capabilityId: z.string().min(1).max(200),
  provider: z.string().min(1).max(120),
  label: LabelSchema.optional(),
  holds: z
    .strictObject({
      WebSearch: z.string().min(1).max(64).optional(),
      WebFetch: z.string().min(1).max(64).optional(),
    })
    .optional(),
  output: z.enum(['json', 'text', 'media']).optional(),
  description: z.string().min(1).max(500),
  /** The call on the account, in place of a paid spec's price and request. */
  mcp: AccountCallSchema,
  input: z.record(z.string(), z.unknown()),
  pinned: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).optional(),
  returns: z.string().min(1).max(200).optional(),
  returnsExample: z.unknown().optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /** Required: this client attaches the credential of `identity.source`. */
  identity: IdentitySchema,
  /** Tenjin has checked this map with a real call. */
  verified: z.boolean(),
});

/** Every string in a template that is exactly a placeholder. */
function placeholders(value: unknown): string[] {
  if (typeof value === 'string')
    return INPUT_PLACEHOLDER.test(value) || RESULT_PLACEHOLDER.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(placeholders);
  if (value && typeof value === 'object') return Object.values(value).flatMap(placeholders);
  return [];
}

function accountSpecProblems(spec: z.infer<typeof AccountSpecFields>, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const { identity, mcp } = spec;
  if (identity.source === BUILT_IN_SOURCE)
    issue(`an account service is never on ${BUILT_IN_SOURCE}`, ['identity', 'source']);
  if (identity.service !== spec.capabilityId)
    issue('an account spec carries its own identity', ['identity', 'service']);
  if (identity.task === undefined) issue('an account service does one task', ['identity']);
  if (Buffer.byteLength(JSON.stringify(mcp), 'utf8') > ACCOUNT_CALL_MAX_BYTES)
    issue(`the call must serialize to at most ${ACCOUNT_CALL_MAX_BYTES} bytes`, ['mcp']);
  // The first call bills, so a poll or follow-up never sends it again.
  if (mcp.next?.poll?.tool === mcp.tool)
    issue('the poll never repeats the call that bills', ['mcp', 'next', 'poll', 'tool']);
  if (mcp.next?.tool === mcp.tool)
    issue('the follow-up never repeats the call that bills', ['mcp', 'next', 'tool']);
  const properties = spec.input.properties;
  const fields = new Set(
    properties && typeof properties === 'object' ? Object.keys(properties) : [],
  );
  const calls: [(string | number)[], Record<string, unknown>, boolean][] = [
    [['mcp', 'args'], mcp.args, false],
  ];
  if (mcp.next?.poll) calls.push([['mcp', 'next', 'poll', 'args'], mcp.next.poll.args, true]);
  if (mcp.next) calls.push([['mcp', 'next', 'args'], mcp.next.args, true]);
  for (const [path, args, followUp] of calls)
    for (const value of placeholders(args)) {
      const field = INPUT_PLACEHOLDER.exec(value)?.[1];
      if (field === undefined && !followUp) issue('only a follow-up reads the first result', path);
      if (field !== undefined && !fields.has(field))
        issue(`${value} names no field of the input`, path);
    }
}

/** An account service's spec, as a lookup's `spec` answer carries it. */
export const AccountSpecSchema = AccountSpecFields.superRefine(accountSpecProblems);
export type AccountSpec = z.infer<typeof AccountSpecSchema>;

/** An account service's spec under the offer id the agent calls it with. */
export const AccountOfferSpecSchema = AccountSpecFields.extend({ id: IdSchema }).superRefine(
  accountSpecProblems,
);
export type AccountOfferSpec = z.infer<typeof AccountOfferSpecSchema>;

/** Any spec an offer id can hold: paid from the balance, or a call on an account. */
export type AnyOfferSpec = OfferSpec | AccountOfferSpec;

export const isAccountSpec = <T extends ToolSpec | AccountSpec>(spec: T): spec is T & AccountSpec =>
  'mcp' in spec;

/**
 * TENJIN'S OWN ROUTE FOR AN ACCOUNT LEAD'S JOB, under its own offer id, with
 * its price. The line never names it: this client offers it when the account
 * refuses, and runs it only when the user picks it or has opted in for that
 * account.
 */
const FallbackSchema = OfferSpecSchema.optional();

function fallbackProblems(
  fallback: OfferSpec | undefined,
  id: string,
  lead: AccountSpec | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!fallback) return;
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  if (!lead) return issue('a fallback rides only an account lead', ['fallback']);
  if (fallback.id === id) issue('the fallback is an offer of its own', ['fallback', 'id']);
  if (fallback.identity?.source !== BUILT_IN_SOURCE)
    issue(`the fallback is a ${BUILT_IN_SOURCE} service`, ['fallback', 'identity']);
  if (fallback.identity?.task !== lead.identity.task)
    issue("the fallback does the lead's task", ['fallback', 'identity', 'task']);
}

/** The specs on an `execute`, whose lead may be an account service's. */
const ExecuteSpecsSchema = z
  .array(z.union([OfferSpecSchema, AccountOfferSpecSchema]))
  .min(1)
  .max(8)
  .optional();

/** Words this client shows the model itself, in its own line: one plain line. */
const PlainLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), 'one plain line');

/**
 * SERVICES THE USER PICKS BETWEEN, OR RUNS ALL OF. Sent only beside a
 * discovered offer, to a build that lists `catalog` in `accepts`. Each option
 * is a real offer: its own id, its own spec in `specs`, and its own one
 * payment, so `request({id, choice})` runs exactly the spec
 * `request({id: option.id})` would. `all` runs every option side by side, one
 * payment each. The set is the server's data: changing it is a deploy there,
 * not a release here. `input` names the open fields the options share, the
 * only ones an `all` call may carry.
 */
export const ChoicesSchema = z.strictObject({
  group: PlainLine(64),
  default: PlainLine(64),
  input: z.array(PlainLine(64)).min(1).max(16),
  options: z
    .array(
      z.strictObject({
        key: PlainLine(64),
        label: PlainLine(120),
        strength: PlainLine(300),
        id: IdSchema,
      }),
    )
    .min(2)
    .max(4),
  all: z.strictObject({ totalAtomic: z.string().regex(/^\d+$/) }),
});
export type Choices = z.infer<typeof ChoicesSchema>;

/** The word that runs every option, so no option may take it as its key. */
export const ALL_CHOICES = 'all';

/**
 * A CHOICE NAMES ONLY WHAT THIS ANSWER CARRIES: each key and id once, `all`
 * free for the whole set, a spec for every option, and the default option is
 * the offer this answer's id already names. A set that breaks any of these is
 * a protocol error, and the turn falls back like any unreadable answer.
 */
function checkChoices(
  decision: { id: string; specs?: { id: string }[] | undefined; choices?: Choices | undefined },
  ctx: z.RefinementCtx,
): void {
  const { choices } = decision;
  if (choices === undefined) return;
  const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['choices'], message });
  const keys = choices.options.map((option) => option.key);
  const ids = choices.options.map((option) => option.id);
  if (new Set(keys).size !== keys.length) issue('each choice key is named once');
  if (new Set(ids).size !== ids.length) issue('each choice id is named once');
  if (keys.includes(ALL_CHOICES)) issue(`"${ALL_CHOICES}" runs every choice, so it is no key`);
  const specIds = new Set((decision.specs ?? []).map((spec) => spec.id));
  if (ids.some((id) => !specIds.has(id))) issue('every choice carries its spec');
  const fallback = choices.options.find((option) => option.key === choices.default);
  if (fallback === undefined) issue('the default is one of the choices');
  else if (fallback.id !== decision.id) issue("the default choice is this answer's own offer");
}

/** One call's input, bounded as the server bounds it. */
export const INPUT_MAX_BYTES = 16 * 1024;

/**
 * THE NATIVE CALL'S OWN INPUT, sent because this build lists `bound`: on the
 * hook before a native search or fetch runs, the complete input (pins left
 * out) for the spec under the decision's `id`, built by the server from that
 * call's query or URL. Run unchanged in the native call's place, through the
 * ordinary executor, or not at all; never edited, merged or parsed here.
 */
const BoundSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (input) => Buffer.byteLength(JSON.stringify(input), 'utf8') <= INPUT_MAX_BYTES,
    `bound must serialize to at most ${INPUT_MAX_BYTES} bytes`,
  )
  .optional();

/** The same answer on both calls: the hook's offer, and the tool's answer
 *  when a query with no id found a service nobody curated. */
const DiscoveredSchema = z
  .strictObject({
    action: z.literal('discovered'),
    id: IdSchema,
    candidate: DiscoveredCandidateSchema,
    /** THE LINE, FINISHED, as on `execute`: it carries the seller's
     *  description and the input it takes. */
    hint: z.string().min(1).max(2_000),
    specs: SpecsSchema,
    choices: ChoicesSchema.optional(),
    bound: BoundSchema,
  })
  .superRefine(checkHint)
  .superRefine(checkChoices);

/**
 * AN ACCOUNT LEAD IS OFFERED ALONE, as a checked service this client runs on
 * its own connection: no endpoint, no balance price, never in place of a
 * native call, and its listing carries its spec's identity. Every other
 * `execute` is as it always was, with the URL it pays.
 */
function checkExecute(
  decision: {
    id: string;
    capabilityId: string;
    providerPriceAtomic: string;
    identity?: Identity | undefined;
    endpoint?: string | undefined;
    specs?: AnyOfferSpec[] | undefined;
    delivery?: 'offer' | 'augment' | undefined;
    augmentUrl?: string | undefined;
    bound?: Record<string, unknown> | undefined;
    fallback?: OfferSpec | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const specs = decision.specs ?? [];
  const lead = specs.find(({ id }) => id === decision.id);
  if (!lead || !isAccountSpec(lead)) {
    if (specs.some((spec) => isAccountSpec(spec)))
      issue('an account service is only ever the lead', ['specs']);
    if (decision.endpoint === undefined) issue('an execute names the URL it pays', ['endpoint']);
    return fallbackProblems(decision.fallback, decision.id, undefined, ctx);
  }
  if (specs.length > 1) issue('an account lead is offered alone', ['specs']);
  if (decision.endpoint !== undefined)
    issue('an account lead names no endpoint: this client calls its own account', ['endpoint']);
  if (decision.capabilityId !== lead.capabilityId)
    issue('the listing names the lead', ['capabilityId']);
  if (decision.providerPriceAtomic !== '0')
    issue('the balance pays an account lead nothing', ['providerPriceAtomic']);
  if (decision.identity?.revision !== lead.identity.revision)
    issue("the listing carries the lead's identity", ['identity']);
  if (!lead.verified) issue('the hook offers only a checked account service', ['specs']);
  if (decision.bound !== undefined)
    issue('an account call never runs in place of a native one', ['bound']);
  if (decision.delivery === 'augment' || decision.augmentUrl !== undefined)
    issue('an account lead is an offer', ['delivery']);
  fallbackProblems(decision.fallback, decision.id, lead, ctx);
}

const HookDecisionSchema = z.discriminatedUnion('action', [
  z
    .strictObject({
      action: z.literal('execute'),
      id: IdSchema,
      ...CapabilityFields,
      /** The x402 URL a lookup would pay, for the line the server writes. An
       *  account lead has none: this client calls the account it connected. */
      endpoint: z.string().min(1).max(2_048).optional(),
      /** What to pass in `query`, in the service's own terms. */
      usage: z.string().min(1).max(300),
      /**
       * THE LINE, FINISHED. The server writes it with the real id in it and, on a
       * native call, the exact search or URL that was denied. The client injects
       * it and composes nothing, which is why there is no hint builder here any
       * more: two sides writing the same sentence is how they drift. The same
       * bound as a discovered line's.
       */
      hint: z.string().min(1).max(2_000),
      specs: ExecuteSpecsSchema,
      /**
       * HOW THE OFFER IS DELIVERED, sent because this build lists `fields`.
       * `augment` is the free docs lookup before a search: the client shows no
       * line and puts what `augmentUrl` returns above the search's own
       * results. `offer` is every line the client shows. Absent (a server
       * from before the token), a free curated offer before a search is read
       * as `augment`, as builds before this one did.
       */
      delivery: z.enum(['offer', 'augment']).optional(),
      augmentUrl: z.string().url().max(2_048).optional(),
      bound: BoundSchema,
      /** Beside an account lead only, for a build that lists `mcp`. */
      fallback: FallbackSchema,
    })
    .superRefine(checkHint)
    .superRefine(checkExecute),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

const ToolDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('execute'),
    ...CapabilityFields,
    contract: ContractSchema,
  }),
  /**
   * A query with no id, answered with the spec of the service the server
   * picked under a fresh `id`: kept like a hook's, and never run in the same
   * call. `hint` is the line, with the skeleton of the next call:
   * `request({id, input: {...}})` with the required fields. `input` is what a
   * router from before the binder's removal still sends on a bound pick: it
   * is accepted so that answer parses, and never read, so it never runs.
   */
  z
    .strictObject({
      action: z.literal('spec'),
      id: IdSchema,
      spec: z.union([ToolSpecSchema, AccountSpecSchema]),
      hint: z.string().min(1).max(2_000),
      input: z.record(z.string(), z.unknown()).optional(),
      /** Beside an account service's spec only, for a build that lists `mcp`. */
      fallback: FallbackSchema,
    })
    .superRefine(checkHint)
    .superRefine((decision, ctx) =>
      fallbackProblems(
        decision.fallback,
        decision.id,
        isAccountSpec(decision.spec) ? decision.spec : undefined,
        ctx,
      ),
    ),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

function envelope<T extends z.ZodTypeAny>(decision: T) {
  return z.strictObject({
    schemaVersion: z.literal(1),
    routerVersion: z.string().min(1).max(64),
    decision,
    /** A plain sentence about the CALL, such as an id that had expired. Never a
     *  failure: the decision beside it ran anyway. */
    note: z.string().max(500).optional(),
    jev: z.object({ calls: z.number(), latencyMs: z.number() }).optional(),
  });
}

const HookResponseSchema = envelope(HookDecisionSchema);
const ToolResponseSchema = envelope(ToolDecisionSchema);

/**
 * ONE ROW OF THE TOOL LIST, as the free browse answers it: the tool's id, its
 * display name (a list entry's upstream name runs to 120 characters), what it
 * does, its price as the server writes it, and its kind. Strict like every
 * answer here, with the server's own bounds. The id is the one field the model
 * sends back, so its alphabet is pinned; the text is flattened to one line
 * where it is shown (`tool.ts`).
 */
const BrowseRowSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
  label: z.string().min(1).max(120),
  does: z.string().min(1).max(500),
  price: z.string().min(1).max(32),
  free: z.boolean(),
  kind: z.string().min(1).max(120),
});
export type BrowseRow = z.infer<typeof BrowseRowSchema>;

const BrowseResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  rows: z.array(BrowseRowSchema).max(200),
});
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;

const LabelledSchema = z.strictObject({ id: TargetIdSchema, label: z.string().min(1).max(120) });

/** A connectable account's id: this client keeps its credential under it, so
 *  it is narrower than a target id (no capitals, spaces, dots or colons). */
export { ACCOUNT_ID };

/** How an account signs in: `oauth` is the MCP sign-in, `key` a pasted key
 *  sent as `Authorization: <scheme> <key>`. */
export const SIGN_IN = ['oauth', 'key'] as const;
export type SignIn = (typeof SIGN_IN)[number];
export const KEY_SCHEMES = ['Bearer', 'Key'] as const;
export type KeyScheme = (typeof KEY_SCHEMES)[number];

/** Where a connected account is called. A user's token goes here, so it is
 *  https, with no credentials, query or fragment to carry anything else. */
export function isAccountUrl(value: string): boolean {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  return (
    url?.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

export const ArgumentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
const twice = (keys: readonly string[]) => new Set(keys).size !== keys.length;

/**
 * ONE ACCOUNT THIS CLIENT CAN CONNECT, from the directory because this build
 * lists `mcp`: where its MCP server is, how it signs in, and for each mapped
 * service whether Tenjin has checked it, whether the account-wide preference
 * puts it first (`useFirst`), and the tools, with the top-level arguments,
 * its call makes. `tenjin connect` lists the account's tools (free)
 * and leaves out, on this machine, a service whose tool is missing.
 */
export const ConnectableSchema = z
  .strictObject({
    id: z.string().regex(ACCOUNT_ID),
    label: z.string().min(1).max(120),
    mcpUrl: z
      .string()
      .max(2_048)
      .refine(isAccountUrl, 'an https URL with no credentials, query or fragment'),
    signIn: z.array(z.enum(SIGN_IN)).min(1).max(2),
    key: z.strictObject({ scheme: z.enum(KEY_SCHEMES) }).optional(),
    services: z
      .array(
        z.strictObject({
          id: TargetIdSchema,
          verified: z.boolean(),
          /** The account-wide preference puts it first; without it, it runs
           *  when named, when Tenjin's own route is ruled out, or alone. */
          useFirst: z.boolean(),
          tools: z
            .array(
              z.strictObject({ name: McpToolSchema, arguments: z.array(ArgumentName).max(32) }),
            )
            .min(1)
            .max(3),
        }),
      )
      .min(1)
      .max(64),
  })
  .superRefine((account, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (account.id === BUILT_IN_SOURCE) issue(`${BUILT_IN_SOURCE} is never connected`, ['id']);
    if (twice(account.signIn)) issue('a sign-in is listed twice', ['signIn']);
    if (account.signIn.includes('key') !== (account.key !== undefined))
      issue('a key sign-in says how the key is sent, and only it does', ['key']);
    if (twice(account.services.map(({ id }) => id)))
      issue('a service is listed twice', ['services']);
    account.services.forEach(({ tools }, index) => {
      if (twice(tools.map(({ name }) => name)))
        issue('a tool is listed twice', ['services', index, 'tools']);
    });
  });
export type Connectable = z.infer<typeof ConnectableSchema>;

const FullDirectorySchema = z.strictObject({
  revision: RevisionSchema,
  categories: z
    .array(LabelledSchema.extend({ tasks: z.array(TargetIdSchema).min(1).max(64) }))
    .max(64),
  /** A task's label is its id. */
  tasks: z.array(LabelledSchema).max(256),
  providers: z.array(LabelledSchema).max(512),
  sellers: z.array(LabelledSchema).max(512),
  sources: z.array(LabelledSchema).max(64),
  services: z.array(LabelledSchema.extend({ identity: IdentitySchema })).max(1024),
  retired: z.array(LabelledSchema.extend({ kind: z.enum(TARGET_KINDS) })).max(512),
  /** Because this build lists `mcp`: every account it can connect, which
   *  between them list every service not on `tenjin`. */
  connectable: z.array(ConnectableSchema).max(16).optional(),
});

/** Each connectable account is a listed source, each of its services a listed
 *  service on it, and every service off `tenjin` listed exactly once. */
function checkConnectable(
  directory: z.infer<typeof FullDirectorySchema>,
  ctx: z.RefinementCtx,
): void {
  if (!directory.connectable) return;
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const sources = new Set(directory.sources.map(({ id }) => id));
  const sourceOf = new Map(directory.services.map(({ id, identity }) => [id, identity.source]));
  const listed = directory.connectable.flatMap(({ services }) => services.map(({ id }) => id));
  if (twice(directory.connectable.map(({ id }) => id)))
    issue('an account is listed twice', ['connectable']);
  if (twice(listed)) issue('a service is listed under two accounts', ['connectable']);
  directory.connectable.forEach(({ id, services }, index) => {
    if (!sources.has(id)) issue('an account is a listed source', ['connectable', index, 'id']);
    services.forEach((service, at) => {
      if (sourceOf.get(service.id) !== id)
        issue("an account's service is a listed service on it", [
          'connectable',
          index,
          'services',
          at,
          'id',
        ]);
    });
  });
  for (const [id, source] of sourceOf)
    if (source !== BUILT_IN_SOURCE && !listed.includes(id))
      issue(`no account lists ${id}`, ['connectable']);
}

/**
 * EVERY ID A SETTING CAN NAME, free and unfiltered by settings: the
 * categories with their reviewed tasks, the tasks, providers, sellers and
 * sources with their labels, every catalog service with its identity, and the
 * retired ids a saved rule may still hold, and, because this build lists
 * `mcp`, every account it can connect. `revision` is the ETag of the answer
 * this client gets; asked with the one it holds, the answer is `unchanged`.
 * `tenjin config` resolves a typed name against it, readback names what a
 * rule covers from it, and `tenjin connect` reads an account's sign-in and
 * tools from it.
 */
const DirectoryResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  directory: z.union([
    z.strictObject({ revision: RevisionSchema, unchanged: z.literal(true) }),
    FullDirectorySchema.superRefine(checkConnectable),
  ]),
});
export type DirectoryResponse = z.infer<typeof DirectoryResponseSchema>;
export type Directory = DirectoryResponse['directory'];
/** The directory's full answer, as opposed to `unchanged`. */
export type DirectoryListing = Extract<Directory, { categories: unknown }>;

/** A saved directory, reread from disk: the full arm only. */
export function parseDirectoryListing(value: unknown): DirectoryListing | undefined {
  const parsed = DirectoryResponseSchema.shape.directory.safeParse(value);
  return parsed.success && 'categories' in parsed.data ? parsed.data : undefined;
}

/** A hook decision reread from disk (`decided.ts`), held to the same schema
 *  as the router's answer: anything else reads as absent. */
export function parseHookDecision(value: unknown): HookDecision | undefined {
  const parsed = HookDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export type HookResponse = z.infer<typeof HookResponseSchema>;
export type ToolResponse = z.infer<typeof ToolResponseSchema>;
export type HookDecision = HookResponse['decision'];
export type ToolDecision = ToolResponse['decision'];

/** Which call this is, and therefore which answer is legal for it. */
export type CallKind = 'hook' | 'tool' | 'browse' | 'directory';

/**
 * What this client can act on beyond the curated answers, sent on every call.
 * Each token names one kind of feature this build parses and runs, and the
 * server ignores a token it does not know, so the list only ever grows.
 * `label` takes each catalog service's display name on its spec and both
 * `execute` answers, and the offer line that starts at it. `fields` takes
 * each spec's `holds` and `output`, and the hook `execute`'s `delivery` and
 * `augmentUrl`. `catalog` takes Tenjin's reviewed list of third-party services as
 * `discovered` offers under their catalog ids, with each spec's `holds` and
 * `output`, and `choices`, a set of options the user picks between or runs
 * all of, beside a discovered offer from a compare group. A build that sends
 * `discovered` in its place gets the same services under their
 * `discovered:tenjin:` ids. `spec` asks for each offered service's request
 * spec beside its line, and for the picked service's spec in place of a
 * decision on a query with no id, which only a build that parses them can
 * take: the decision schemas are strict. `jobs` asks for each spec's `job`,
 * for the services that never answer inline, and for `count` on a media
 * offer's line. `identity` asks for each spec's and each `execute`'s route
 * identity, the one thing a saved setting reads, and `bound` for the native
 * call's own input on the hook before a search or fetch runs. Both describe
 * parsers, not settings, so they ride on every call; neither `policy` nor
 * `override` is a token. `mcp` takes a spec whose call is an MCP tool call on
 * a connected account, the `execute` that offers one with no `endpoint`, the
 * `fallback` beside it and `connectable` in the directory; it counts only
 * beside `identity`. `bazaar` widens discovery to the open Bazaar and is sent
 * only while `experimental.bazaar` is on.
 */
export const CLIENT_ACCEPTS: readonly string[] = [
  'catalog',
  'spec',
  'label',
  'fields',
  'jobs',
  'identity',
  'bound',
  'mcp',
];
export const BAZAAR_ACCEPT = 'bazaar';

/** The `accepts` this build sends, with the open Bazaar or without it. */
export function acceptsFor(bazaar: boolean): string[] {
  return bazaar ? [...CLIENT_ACCEPTS, BAZAAR_ACCEPT] : [...CLIENT_ACCEPTS];
}

/**
 * The exact body the hook call sends, spelled once and pinned to the shared
 * fixtures. The route reads it with a strict object, so an extra field is a
 * 400, and a 400 is a turn with no hint.
 *
 * ONE BODY FOR BOTH HOOKS. Which hook is asking is not a field: the route reads
 * it from `packet.pendingCall`, which the native hook sets and the prompt hook
 * does not. A `source` beside the packet was the `/prepare` route's shape, and
 * that route is gone. `sessionId` is the harness's own session id, which the
 * server uses only so one session is not offered the same discovered service
 * twice. `policy` is a sibling of the packet, NEVER inside it: the packet is
 * what the server's model reads, and the user's settings are for code alone.
 * Absent when the user has no rules, which keeps their body what it was.
 */
export function buildHookBody(
  packet: Packet,
  extras: {
    sessionId?: string;
    accepts?: readonly string[];
    harness?: Harness;
    policy?: WirePolicy;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    ...(extras.accepts !== undefined ? { accepts: [...extras.accepts] } : {}),
    ...(extras.harness !== undefined ? { harness: extras.harness } : {}),
    packet,
    ...(extras.policy !== undefined ? { policy: extras.policy } : {}),
  };
}

/** The exact body the tool call sends. `id` is the offer the query is for,
 *  sent only for an offer with no spec kept; `gateHint` is evidence, never
 *  authority. `override` narrows this one query, so the server takes it only
 *  beside `query`. */
export function buildToolBody(request: {
  query?: string;
  id?: string;
  gateHint?: GateHint;
  accepts?: readonly string[];
  harness?: Harness;
  policy?: WirePolicy;
  override?: WireOverride;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
    ...(request.accepts !== undefined ? { accepts: [...request.accepts] } : {}),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.policy !== undefined ? { policy: request.policy } : {}),
    ...(request.override !== undefined ? { override: request.override } : {}),
  };
}

/** The free browse of the tool list: `browse` is the need, or `""` for every
 *  tool by kind. No gate call and no Jev on the server. */
export function buildBrowseBody(request: {
  browse: string;
  accepts: readonly string[];
  harness?: Harness;
  policy?: WirePolicy;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    browse: request.browse,
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.policy !== undefined ? { policy: request.policy } : {}),
  };
}

/** A browse row's id, answered with that tool's spec under a fresh offer id. */
export function buildToolSpecBody(request: {
  tool: string;
  accepts: readonly string[];
  harness?: Harness;
  policy?: WirePolicy;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tool: request.tool,
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.policy !== undefined ? { policy: request.policy } : {}),
  };
}

/** The directory: every id a setting can name. `ifRevision` is the revision
 *  of a directory this client already holds. `accepts` is read for `mcp`
 *  alone, which adds the accounts this client can connect. No `harness`, no
 *  `policy`: the answer is the same for every client that accepts the same. */
export function buildDirectoryBody(
  request: { ifRevision?: string; accepts?: readonly string[] } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    directory: request.ifRevision !== undefined ? { ifRevision: request.ifRevision } : {},
    ...(request.accepts !== undefined ? { accepts: [...request.accepts] } : {}),
  };
}

/** The parsers, exposed so the shared wire fixtures are checked against the
 *  same schemas production parses with rather than against a copy of them. */
export function parseForTests(kind: CallKind, value: unknown): { success: boolean } {
  return { success: schemaFor(kind).safeParse(value).success };
}

function schemaFor(kind: CallKind) {
  return kind === 'hook'
    ? HookResponseSchema
    : kind === 'tool'
      ? ToolResponseSchema
      : kind === 'browse'
        ? BrowseResponseSchema
        : DirectoryResponseSchema;
}

/**
 * The gate's own reading of this turn, travelling as EVIDENCE for the lookup it
 * was produced for. The backend may refine or reject it, and it authorizes no
 * money: the local spend policy does that. Optional on both call forms.
 */
export interface GateHint {
  category: string;
  turnId: string;
  lookupId: string;
}

export interface DecisionDeps {
  ctx: CommandContext;
  baseUrl: string;
  /** `experimental.bazaar`: add {@link BAZAAR_ACCEPT}, so a service from the
   *  open Bazaar may come back. Off by default: curated and the Tenjin list. */
  acceptsBazaar?: boolean;
  /**
   * The host asking. The server filters out the lookups that host's own tools
   * already do, and nothing else: never payment, limits or the fee. Absent is
   * `claude`, and every production caller sends it.
   */
  harness?: Harness;
  /**
   * The user's saved rules as the wire carries them, resolved from the global
   * file on every call (`routerSettings`) and never cached here: absent when
   * there are none, so a user without rules sends what they always sent.
   */
  policy?: WirePolicy;
  fetchImpl?: typeof fetch;
  /** Overrides the per-call deadline; the hook passes its own, smaller one. */
  timeoutMs?: number;
  /** The paid path, when `tenjin mcp` takes it: the body goes to `path` and is
   *  sent by `send`, which pays the routing fee with the stock x402 client.
   *  Absent is the free path. */
  route?: DecisionRoute;
}

/** How a routing call reaches the paid path. `send` throws
 *  {@link RouteSkipped} when it has no paid answer for the call, which then
 *  takes the free path. */
export interface DecisionRoute {
  path: string;
  send: (url: string, options: HttpRequestOptions) => Promise<HttpResult>;
  /** What this route's calls deposited into the routing channel and the
   *  router took, 0n for none: the caller says so once, where it is read. */
  deposited?: () => bigint;
}

/** The paid path gave this call no answer: the wallet locked, low or over
 *  its spend limits, the channel busy, or the payment failed. */
export class RouteSkipped extends Error {
  /** `unreached`: the paid call could not reach the router
   *  ({@link isUnreachable}), so the free path, on the same host, is not
   *  tried and the call reads as that transport failure. */
  constructor(
    readonly why: string,
    readonly unreached?: FetchJsonFailure,
  ) {
    super(`routing fee not paid: ${why}`);
  }
}

/** Another session's call was in flight on the wallet's routing channel. */
export const CHANNEL_BUSY = 'channel_busy';
/** The server answered no paid path. */
export const PAID_PATH_ABSENT = 'paid_path_absent';
/** The paid call got no answer, a refused payment or a server error. */
export const PAYMENT_FAILED = 'payment_failed';
/** The payment went out and the call's budget ran out before its answer:
 *  no fault. `tenjin mcp` lets the request finish, so it is recorded. */
export const DEADLINE_AFTER_PAYMENT_SENT = 'deadline_after_payment_sent';

export type DecisionOutcome<T> =
  /** `freePath`: the paid path skipped the call for this reason and it went
   *  to the free path instead, unpaid. */
  | { status: 'decided'; decision: T; freePath?: string }
  /** On the free path nothing was paid and nothing could be, so a failure here
   *  costs the turn a routing answer and nothing else. */
  | {
      status: 'failed';
      reason: string;
      errorCode?: string;
      freePath?: string;
      /** The router could not be reached at all ({@link isUnreachable}). */
      unreachable?: true;
      /** No answer came back at all: a transport failure or a timeout. */
      noAnswer?: true;
      /** The router's own non-2xx status. A 400 to a body carrying `policy`
       *  or `override` is a router that cannot apply the user's settings. */
      httpStatus?: number;
    }
  /** The paid path gave no answer ({@link RouteSkipped}) and no time was left
   *  for the free path: the native tool runs. */
  | { status: 'skipped'; why: string };

/**
 * ONE FREE CALL, IN TWO FORMS. The hook sends `{ packet }`: the backend runs
 * the gate, and on `execute` stores that packet under an id and answers with
 * each offered service's spec. The tool sends `{ query }`, which the backend
 * answers with the spec of the service its gate picks, or `{ query, id }` for
 * the free docs offer, which has no spec and is bound from the query. Every
 * provider call is built here, from a spec, or for the docs lookup by the
 * backend from the query.
 */
export async function requestDecision(
  kind: 'hook',
  request: { packet: Packet; sessionId?: string },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse>>;
export async function requestDecision(
  kind: 'tool',
  request: { query: string; id?: string; gateHint?: GateHint; override?: WireOverride },
  deps: DecisionDeps,
): Promise<DecisionOutcome<ToolResponse>>;
export async function requestDecision(
  kind: 'hook' | 'tool',
  request: {
    query?: string;
    packet?: Packet;
    sessionId?: string;
    id?: string;
    gateHint?: GateHint;
    override?: WireOverride;
  },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse | ToolResponse>> {
  const url = new URL(deps.route?.path ?? ROUTER_PATH, deps.baseUrl).toString();
  const options: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
    blockRedirects: true,
    jsonBody:
      kind === 'hook'
        ? buildHookBody(request.packet as Packet, {
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true),
            harness: deps.harness ?? 'claude',
            ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
          })
        : buildToolBody({
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.id !== undefined ? { id: request.id } : {}),
            ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true),
            harness: deps.harness ?? 'claude',
            ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
            ...(request.override !== undefined ? { override: request.override } : {}),
          }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const started = Date.now();
  const schema = kind === 'hook' ? HookResponseSchema : ToolResponseSchema;
  let response: HttpResult;
  try {
    response = await (deps.route?.send ?? httpRequest)(url, options);
  } catch (err) {
    if (!(err instanceof RouteSkipped)) throw err;
    if (err.unreached !== undefined) return readDecision(err.unreached, schema);
    const left = options.timeoutMs - (Date.now() - started);
    if (left <= 0) return { status: 'skipped', why: err.why };
    // A CALL THE PAID PATH COULD NOT TAKE STILL ROUTES, on the free path,
    // unpaid, inside what is left of its budget, and says why.
    response = await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      ...options,
      timeoutMs: left,
    });
    const free = readDecision(response, schema);
    // A failure here ran on what a paid attempt left of the budget, so it says
    // nothing about the router being down: it never starts the backoff.
    if (free.status === 'failed') {
      return {
        status: 'failed',
        reason: free.reason,
        ...(free.errorCode !== undefined ? { errorCode: free.errorCode } : {}),
        ...(free.httpStatus !== undefined ? { httpStatus: free.httpStatus } : {}),
        // Still no answer, which must not end another call's backoff.
        ...(free.noAnswer === true ? { noAnswer: true as const } : {}),
        freePath: err.why,
      };
    }
    return free.status === 'skipped' ? free : { ...free, freePath: err.why };
  }
  return readDecision(response, schema);
}

/**
 * THE TWO FREE READS OF THE TOOL LIST. `{browse}` lists the tools that fit a
 * need (or all of them, by kind, for `""`), and `{tool}` answers a browse
 * row's id with that tool's spec under a fresh offer id, exactly as a query
 * with no id is answered. Neither makes a gate call on the server, neither is
 * charged the routing fee, and neither pays anything here, so both always take
 * the free path: `deps.route` is never read.
 */
export async function requestBrowse(
  browse: string,
  deps: Omit<DecisionDeps, 'route'>,
): Promise<DecisionOutcome<BrowseResponse>> {
  return readDecision(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildBrowseBody({
        browse,
        accepts: acceptsFor(deps.acceptsBazaar === true),
        harness: deps.harness ?? 'claude',
        ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    BrowseResponseSchema,
  );
}

/** `{tool}`: a browse row's spec, kept by the caller under the answer's id. */
export async function requestToolSpec(
  tool: string,
  deps: Omit<DecisionDeps, 'route'>,
): Promise<DecisionOutcome<ToolResponse>> {
  return readDecision(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildToolSpecBody({
        tool,
        accepts: acceptsFor(deps.acceptsBazaar === true),
        harness: deps.harness ?? 'claude',
        ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    ToolResponseSchema,
  );
}

/**
 * THE DIRECTORY, ALWAYS FREE: no gate, no Jev, no payment and no row on the
 * server, so it takes the free path whatever `deps.route` says. `ifRevision`
 * is the revision of a directory this client holds; an `unchanged` answer
 * says that copy is current for this call, and only for it.
 */
export async function requestDirectory(
  ifRevision: string | undefined,
  deps: Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl' | 'timeoutMs'>,
): Promise<DecisionOutcome<DirectoryResponse>> {
  return readDecision(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildDirectoryBody({
        ...(ifRevision !== undefined ? { ifRevision } : {}),
        accepts: acceptsFor(false),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    DirectoryResponseSchema,
  );
}

/** Why a call from a spec stopped before anything was signed: the input did
 *  not fit, the live terms were not the spec's, the provider answered
 *  something else, it could not be reached, or the wallet could not pay. */
export type UnpaidReason = 'input' | 'terms' | 'provider' | 'unreachable' | 'wallet';

/** How a call run from a request spec ended, for the server's offer-to-call
 *  count. No text: the id, the outcome, the provider's status and the time. */
export interface SpecOutcome {
  id: string;
  /** `unpaid`: stopped before anything was signed, which the server never
   *  counts as the offer taken. `running`: paid, and the seller was still
   *  rendering when the call ended. */
  status: 'fulfilled' | 'unverified' | 'failed' | 'needs_approval' | 'unpaid' | 'running';
  /** On `unpaid` only, where the server requires it. */
  reason?: UnpaidReason;
  httpStatus?: number;
  ms?: number;
  /** The path that made the call, when it was not an ordinary request: `swap`,
   *  a native search or fetch answered in place. Never on a default body. */
  via?: 'swap';
}

/** The outcome report's own deadline: it is telemetry and never holds a result. */
export const OUTCOME_TIMEOUT_MS = 3_000;

/**
 * TELL THE SERVER A SPEC WAS USED. The client called and paid the provider
 * itself, so this is the only word the server gets that its offer was taken,
 * or that a call for it stopped before payment and why. Never throws and never
 * waits on anything the caller needs: a lost report costs one count.
 */
export async function reportSpecOutcome(
  outcome: SpecOutcome,
  deps: Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl' | 'harness'>,
): Promise<void> {
  try {
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: OUTCOME_TIMEOUT_MS,
      blockRedirects: true,
      jsonBody: buildOutcomeBody(outcome, deps.harness ?? 'claude'),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    // Telemetry only.
  }
}

/** The exact body of an outcome report, pinned to the shared fixtures. */
export function buildOutcomeBody(outcome: SpecOutcome, harness?: Harness): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: outcome.id,
    ...(harness !== undefined ? { harness } : {}),
    status: outcome.status,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
    ...(outcome.ms !== undefined ? { ms: Math.max(0, Math.round(outcome.ms)) } : {}),
    ...(outcome.via !== undefined ? { via: outcome.via } : {}),
  };
}

function readDecision<T extends z.ZodTypeAny>(
  response: HttpResult,
  schema: T,
): DecisionOutcome<z.infer<T>> {
  // A transport failure says its own reason; nothing was paid either way,
  // because there is nothing to pay for on this route.
  if (!response.ok) {
    return {
      status: 'failed',
      reason: fetchFailureToCliError(response).message,
      ...(isUnreachable(response) ? { unreachable: true as const } : {}),
      ...(response.status === undefined ? { noAnswer: true as const } : {}),
    };
  }
  if (response.status < 200 || response.status >= 300) {
    const named = errorOf(response.json);
    return {
      status: 'failed',
      // The backend's own code and message, never a bare status line: a typed
      // refusal the host could act on was arriving as "answered 400".
      reason:
        named === null
          ? `The router endpoint answered ${response.status}.`
          : `The router endpoint answered ${response.status} (${named.code}): ${named.message}`,
      ...(named !== null ? { errorCode: named.code } : {}),
      httpStatus: response.status,
    };
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return { status: 'failed', reason: 'The router returned a decision this build cannot read.' };
  }
  return { status: 'decided', decision: parsed.data as z.infer<T> };
}

/** `{ error: { code, message } }`, the envelope every Tenjin route answers a
 *  refusal with. Anything else reads as no code rather than as a guess. */
function errorOf(body: unknown): { code: string; message: string } | null {
  if (body === null || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || code.length === 0 || code.length > 64) return null;
  const text = typeof message === 'string' ? message.slice(0, 500) : '';
  return { code, message: text };
}

/** A dropped socket, which a fresh connection usually gets past. */
const RESET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET']);

/**
 * A ROUTER THAT CANNOT BE REACHED: the transport named the layer that refused
 * the connection (DNS, TLS, a refused connection, a proxy refusing the tunnel)
 * and no status came back. Never the call's own timeout: that is the gate's
 * few seconds, and a slow decision or a cold start must not take the router
 * away from every session. Never a status, even with a body that failed to
 * read, and never a reset socket, which the free path retries on a fresh one.
 */
export function isUnreachable(failure: FetchJsonFailure): boolean {
  return (
    failure.kind === 'network' &&
    failure.status === undefined &&
    failure.transport !== undefined &&
    !RESET_CODES.has(failure.transport.code ?? '')
  );
}

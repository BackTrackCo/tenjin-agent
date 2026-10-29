import { z } from 'zod';
import { fetchFailureToCliError, httpRequest, MAX_BINARY_BODY_BYTES } from '../lib/http';
import type { FetchJsonFailure, HttpRequestOptions, HttpResult } from '../lib/http';
import type { CommandContext } from '../context';
import type { Packet } from './context';
import type { Harness } from './names';

/**
 * ONE ROUTING PATH, ONE DECISION PER LOOKUP. Every routing call, the hook's
 * and the `request` tool's, goes to the paid route ({@link ROUTE_PAID_PATH}).
 * Inside `tenjin mcp` the payer sends it through the stock x402 client and
 * pays the routing fee its 402 quotes ({@link DecisionRoute},
 * `routing-payer.ts`); a call it cannot pay is skipped at once, with no second
 * request. The free route ({@link ROUTER_PATH}) keeps only what stays free:
 * browse, a browse row's spec and the outcome report.
 *
 * The backend answers with what it would do and what the provider charges,
 * and the provider is paid by `runPay`, from a spec, under the local spend
 * policy. The bounded packet travels with the hook request and the backend
 * keeps it against the decision id until that id expires. What this client
 * keeps is each offer's spec, by its id (`specs.ts`).
 */

/** The free route: browse, a browse row's spec, and the outcome report. */
export const ROUTER_PATH = '/api/x402-router';
/** The paid route, behind x402: every routing call. */
export const ROUTE_PAID_PATH = '/api/x402-router/route';

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

/**
 * What stopped an outcome this client cannot execute, in terms the host can act
 * on: a stable reason code, the stage that stopped, the fields or scope choices
 * the user can supply, and one concrete next action.
 */
const DiagnosticsSchema = z.object({
  reasonCode: z.string().min(1).max(64),
  stage: z.string().min(1).max(32),
  missing: z.array(z.string().max(200)).max(60),
  nextAction: z.string().max(500),
});
export type DecisionDiagnostics = z.infer<typeof DiagnosticsSchema>;

/**
 * ONE VARIANT PER ANSWER, DISCRIMINATED ON THE ACTION. Optional fields made
 * every shape legal: an `execute` with no contract parsed and came back to the
 * host as a routine `needs_input`, and a non-execute with no diagnostics
 * parsed with nothing to act on. Each of those is drift the shared fixtures
 * exist to catch, so each is a parse failure that names itself.
 *
 * A TOLERANT READER, AND ONLY THAT (RFC 9413). A field this build does not
 * know is dropped, never a failure: a server that adds one reaches every
 * released client without a release or a deploy order. A field it does know
 * keeps its type, its bounds and its checks, and an object naming the known
 * fields of two arms of one union is still refused. An offer that a client
 * must understand to run says so in `requires` ({@link withoutUnmet}).
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
const RefusedSchema = z.object({
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

/**
 * WHAT AN OFFER NEEDS THIS CLIENT TO UNDERSTAND, in the `accepts` vocabulary,
 * on an offering answer or on any spec: a must-understand list, like JWS
 * `crit` (RFC 7515 §4.1.11). The tolerant reader drops a field it does not
 * know, which is right for a field a client may ignore and wrong for one that
 * changes what a call is (a header it must send, a new kind of payment). Such
 * an offer names that feature here, and a build without it skips that offer
 * alone, by name, rather than run it half understood ({@link withoutUnmet}).
 * The same bounds as `accepts`, with the alphabet pinned: a token is named
 * in the model's text when its offer is skipped.
 */
const RequiresSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/))
  .max(16)
  .optional();

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
  requires: RequiresSchema,
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
const DiscoveredCandidateSchema = z.object({
  source: z.string().min(1).max(64),
  provider: z.string().min(1).max(120),
  url: z.string().min(1).max(2_048),
  method: z.enum(['GET', 'POST']),
  description: z.string().max(500),
  providerPriceAtomic: z.string().regex(/^\d+$/),
  network: z.string().min(1).max(64),
  payTo: z.string().min(1).max(200),
  input: z.object({
    location: z.enum(['body', 'query']),
    schema: z.record(z.string(), z.unknown()),
  }),
});

/** A key that belongs to another arm of the same union. The tolerant reader
 *  drops a key it does not know; this one it knows, so an object naming the
 *  keys of both arms is refused rather than read as whichever arm is first. */
const OtherArm = z.never().optional();

/** A field name a job reads from an answer or writes into a poll body. */
const JobField = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

/** A body field whose value names a state: Treza's `status: "running"`. */
const JobFieldStateSchema = z.object({
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
  .object({
    pollUrl: z.union([
      z
        .object({
          field: JobField.optional(),
          header: z
            .string()
            .regex(/^[A-Za-z0-9-]{1,64}$/)
            .optional(),
          fixed: OtherArm,
        })
        .refine((at) => at.field !== undefined || at.header !== undefined, 'a field or a header'),
      z.object({ fixed: z.string().min(1).max(2_048), field: OtherArm, header: OtherArm }),
    ]),
    /** Sent once like a poll after the result is saved, never after a save
     *  that failed: it frees the seller's copy (AiSpace's `/complete`). Its
     *  answer is ignored. */
    completeUrl: z.object({ fixed: z.string().min(1).max(2_048) }).optional(),
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
      z.object({
        httpStatus: z.array(z.number().int().min(200).max(299)).min(1).max(8),
        field: OtherArm,
        values: OtherArm,
      }),
      JobFieldStateSchema.extend({ httpStatus: OtherArm }),
    ]),
    failed: JobFieldStateSchema.optional(),
    everyS: z.number().int().min(1).max(30),
    maxWaitS: z.number().int().min(1).max(600),
    keepH: z.number().int().min(1).max(48),
    always: z.literal(true).optional(),
  })
  .refine((job) => !job.pollBody || job.pollMethod === 'POST', 'only a POST poll has a body');
export type Job = z.infer<typeof JobSchema>;

/** A spec's `timeoutS` ceiling: the paid leg's own (`MAX_PAID_LEG_TIMEOUT_MS`
 *  in `commands/pay.ts`), so no spec can hold a call longer than a seller's
 *  402 already may. */
export const MAX_SPEC_TIMEOUT_S = 120;

/**
 * A REQUEST SPEC: the offered service's real contract, sent beside the line only
 * because this build asks for it (`accepts: ["spec"]`). The hook stores it by
 * the offer's id; `request({id})` shows it and `request({id, input})` fills its
 * request and pays the provider directly, with no second decision. Every field
 * is the server's, and so is checked like the rest of the answer: the payee and
 * price still meet the live 402 and the spend policy in `runPay`.
 */
export const ToolSpecSchema = z.object({
  capabilityId: z.string().min(1).max(200),
  provider: z.string().min(1).max(120),
  /** The display name, on a catalog service's spec; a Bazaar spec has none. */
  label: LabelSchema.optional(),
  /** The input field that takes a pending search's query or fetch's URL. */
  holds: z
    .object({
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
  request: z.object({
    method: z.enum(['GET', 'POST']),
    url: z.string().min(1).max(2_048),
    fields: z.record(z.string(), z.enum(['path', 'query', 'body'])),
    location: z.enum(['query', 'body']),
    /** Fixed request headers the catalog decides for this service (a
     *  provider's beta opt-in, say), never the agent. The call refuses a name
     *  this client signs or sets itself; `accept` and `content-type` stay its own. */
    headers: z
      .record(z.string().min(1).max(64), z.string().min(1).max(1_024))
      .refine((headers) => Object.keys(headers).length <= 8, 'at most 8 headers')
      .optional(),
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
  takes: z.object({ max: z.number().int().min(2).max(5) }).optional(),
  requires: RequiresSchema,
  /** The provider call's own deadline in seconds: the unpaid probe's, and
   *  the least the paid leg waits. Absent, the CLI's `--timeout`. */
  timeoutS: z.number().int().min(1).max(MAX_SPEC_TIMEOUT_S).optional(),
  /** The largest file the call may bring back, in bytes: a binary result,
   *  and each file a media result links to. Absent, and at most, the
   *  {@link MAX_BINARY_BODY_BYTES} every call had. */
  maxBytes: z.number().int().min(1).max(MAX_BINARY_BODY_BYTES).optional(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const OfferSpecSchema = ToolSpecSchema.extend({ id: IdSchema });
export type OfferSpec = z.infer<typeof OfferSpecSchema>;

/** One spec per service the line names: the offer, any other service it
 *  lists, and each option of a choice set. */
const SpecsSchema = z.array(OfferSpecSchema).min(1).max(8).optional();

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
export const ChoicesSchema = z.object({
  group: PlainLine(64),
  default: PlainLine(64),
  input: z.array(PlainLine(64)).min(1).max(16),
  options: z
    .array(
      z.object({
        key: PlainLine(64),
        label: PlainLine(120),
        strength: PlainLine(300),
        id: IdSchema,
      }),
    )
    .min(2)
    .max(4),
  all: z.object({ totalAtomic: z.string().regex(/^\d+$/) }),
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

/** The same answer on both calls: the hook's offer, and the tool's answer
 *  when a query with no id found a service nobody curated. */
const DiscoveredSchema = z
  .object({
    action: z.literal('discovered'),
    id: IdSchema,
    candidate: DiscoveredCandidateSchema,
    /** THE LINE, FINISHED, as on `execute`: it carries the seller's
     *  description and the input it takes. */
    hint: z.string().min(1).max(2_000),
    specs: SpecsSchema,
    choices: ChoicesSchema.optional(),
    requires: RequiresSchema,
  })
  .superRefine(checkHint)
  .superRefine(checkChoices);

const HookDecisionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('execute'),
      id: IdSchema,
      ...CapabilityFields,
      /** The x402 URL a lookup would pay, for the line the server writes. */
      endpoint: z.string().min(1).max(2_048),
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
      specs: SpecsSchema,
      /**
       * HOW THE OFFER IS DELIVERED, sent because this build lists `fields`.
       * `note` is the free docs lookup before a search, for a client that
       * also lists `note`: the line comes after the search. `augment` is the
       * same offer for a client that does not, with the `augmentUrl` that
       * client fetches. `offer` is every other line. This build shows only a
       * `note` after a search; any other free offer before one, `augment`
       * included, runs silent.
       */
      delivery: z.enum(['offer', 'augment', 'note']).optional(),
      augmentUrl: z.string().url().max(2_048).optional(),
    })
    .superRefine(checkHint),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

const ToolDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('execute'),
    ...CapabilityFields,
    contract: ContractSchema,
  }),
  /**
   * A query with no id, answered with the spec of the service the server
   * picked under a fresh `id`: kept like a hook's, and never run in the same
   * call. `hint` is the line, with the skeleton of the next call:
   * `request({id, input: {...}})` with the required fields. What it needs
   * this client to understand is its spec's `requires`.
   */
  z
    .object({
      action: z.literal('spec'),
      id: IdSchema,
      spec: ToolSpecSchema,
      hint: z.string().min(1).max(2_000),
    })
    .superRefine(checkHint),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

function envelope<T extends z.ZodTypeAny>(decision: T) {
  return z.object({
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
const BrowseRowSchema = z.object({
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

const BrowseResponseSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  rows: z.array(BrowseRowSchema).max(200),
});
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;

export type HookResponse = z.infer<typeof HookResponseSchema>;
export type ToolResponse = z.infer<typeof ToolResponseSchema>;
export type HookDecision = HookResponse['decision'];
export type ToolDecision = ToolResponse['decision'];

/** The reason code of an offer this build skipped for a feature it lacks. */
export const REQUIRES_UNMET = 'requires_unmet';

/** An offer skipped for features this build lacks, named by its id. */
export interface SkippedOffer {
  id: string;
  missing: string[];
}

/**
 * EACH OFFER THIS BUILD CANNOT RUN, SKIPPED ALONE. A spec whose `requires`
 * names a feature this build lacks is dropped, with any choice that runs it
 * (and the set, once fewer than two choices are left); the rest of the answer
 * stands. When that offer is the answer's own (its `requires`, its own spec,
 * or a `spec` answer's spec), nothing is left to show, so the answer becomes
 * a `native` that names the missing features: a named skip, never a guess.
 */
export function withoutUnmet<T extends HookDecision | ToolDecision>(
  decision: T,
): { decision: T; skipped: SkippedOffer[] } {
  if (decision.action === 'native' || decision.action === 'needs_input') {
    return { decision, skipped: [] };
  }
  const specs = 'specs' in decision ? (decision.specs ?? []) : [];
  const own = [
    ...unmetRequires('requires' in decision ? decision.requires : undefined),
    ...(decision.action === 'spec' ? unmetRequires(decision.spec.requires) : []),
    ...('id' in decision ? unmetRequires(specs.find((s) => s.id === decision.id)?.requires) : []),
  ];
  if (own.length > 0) {
    const missing = [...new Set(own)];
    const id = 'id' in decision ? decision.id : decision.capabilityId;
    return { decision: unmetRefusal(missing) as T, skipped: [{ id, missing }] };
  }
  const skipped = specs.flatMap((spec) => {
    const missing = unmetRequires(spec.requires);
    return missing.length > 0 ? [{ id: spec.id, missing }] : [];
  });
  if (skipped.length === 0) return { decision, skipped };
  const gone = new Set(skipped.map((s) => s.id));
  const kept = { ...decision, specs: specs.filter((spec) => !gone.has(spec.id)) };
  if (kept.action === 'discovered' && kept.choices !== undefined) {
    const options = kept.choices.options.filter((option) => !gone.has(option.id));
    if (options.length < 2) delete kept.choices;
    else kept.choices = { ...kept.choices, options };
  }
  return { decision: kept as T, skipped };
}

function unmetRefusal(missing: string[]) {
  const named = missing.map((token) => `\`${token}\``).join(', ');
  return {
    action: 'native' as const,
    reason: `This offer needs ${named}, which this build of tenjin-cli does not have, so it was skipped and nothing was paid.`,
    diagnostics: {
      reasonCode: REQUIRES_UNMET,
      stage: 'client',
      missing,
      nextAction:
        'Use your own tools for this one. A newer tenjin-cli (`tenjin update`) can run it.',
    },
  };
}

/** Which call this is, and therefore which answer is legal for it. */
export type CallKind = 'hook' | 'tool' | 'browse';

/**
 * What this client can act on beyond the curated answers, sent on every call.
 * Each token names one kind of feature this build parses and runs, and the
 * server ignores a token it does not know, so the list only ever grows.
 * `label` takes each catalog service's display name on its spec and both
 * `execute` answers, and the offer line that starts at it. `fields` takes
 * each spec's `holds` and `output`, and the hook `execute`'s `delivery` and
 * `augmentUrl`. `note` asks for `delivery: "note"` on the free docs lookup
 * before a search, whose line this build shows after the search, in place of
 * the `augment` an older build fetched. `catalog` takes Tenjin's reviewed
 * list of third-party services as
 * `discovered` offers under their catalog ids, with each spec's `holds` and
 * `output`, and `choices`, a set of options the user picks between or runs
 * all of, beside a discovered offer from a compare group. A build that sends
 * `discovered` in its place gets the same services under their
 * `discovered:tenjin:` ids. `spec` asks for each offered service's request
 * spec beside its line, and for the picked service's spec in place of a
 * decision on a query with no id, which only a build that runs them can
 * take. `jobs` asks for each spec's `job`,
 * for the services that never answer inline, and for `count` on a media
 * offer's line. `headers` asks for a spec's `request.headers`, the fixed
 * headers the catalog sets on a service's call (a provider's beta opt-in),
 * with the pins those headers unlock: `buildSpecRequest` sends them. A build
 * without a token would drop the field as unknown, so a spec that cannot run
 * without it lists the token in `requires`. `tolerant` says this build reads
 * every answer as a tolerant reader and honors `requires` ({@link withoutUnmet}):
 * a server sends a new field, `requires` included, only to a client that
 * lists it, and today's shape to one that does not, which is every release
 * from before it and reads strictly. `bazaar` widens discovery to the open
 * Bazaar and is sent only while `experimental.bazaar` is on.
 */
export const CLIENT_ACCEPTS: readonly string[] = [
  'catalog',
  'spec',
  'label',
  'fields',
  'jobs',
  'headers',
  'note',
  'tolerant',
];
export const BAZAAR_ACCEPT = 'bazaar';

/** Every feature this build has, which a `requires` list is read against:
 *  `bazaar` included, which it runs whether or not it asks for one. */
const CLIENT_FEATURES: ReadonlySet<string> = new Set([...CLIENT_ACCEPTS, BAZAAR_ACCEPT]);

/** The features a `requires` list names that this build lacks; none when it
 *  has them all. */
export function unmetRequires(requires: readonly string[] | undefined): string[] {
  return (requires ?? []).filter((token) => !CLIENT_FEATURES.has(token));
}

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
 * twice.
 */
export function buildHookBody(
  packet: Packet,
  extras: { sessionId?: string; accepts?: readonly string[]; harness?: Harness } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    ...(extras.accepts !== undefined ? { accepts: [...extras.accepts] } : {}),
    ...(extras.harness !== undefined ? { harness: extras.harness } : {}),
    packet,
  };
}

/** The exact body the tool call sends. `id` is the offer the query is for,
 *  sent only for an offer with no spec kept; `gateHint` is evidence, never
 *  authority. */
export function buildToolBody(request: {
  query?: string;
  id?: string;
  gateHint?: GateHint;
  accepts?: readonly string[];
  harness?: Harness;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
    ...(request.accepts !== undefined ? { accepts: [...request.accepts] } : {}),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
  };
}

/** The free browse of the tool list: `browse` is the need, or `""` for every
 *  tool by kind. No gate call and no Jev on the server. */
export function buildBrowseBody(request: {
  browse: string;
  accepts: readonly string[];
  harness?: Harness;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    browse: request.browse,
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
  };
}

/** A browse row's id, answered with that tool's spec under a fresh offer id. */
export function buildToolSpecBody(request: {
  tool: string;
  accepts: readonly string[];
  harness?: Harness;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tool: request.tool,
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
  };
}

/**
 * THE PAID ROUTE'S `warm` CALL, a channel deposit's carrier. The payer's
 * background top-up sends it and nothing else does: the batch-settlement spec
 * has no deposit-only payload, so the deposit rides a paid request the server
 * answers in code, with no gate and nothing stored, and settles at $0.
 */
export function buildWarmBody(
  extras: { accepts?: readonly string[]; harness?: Harness } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    warm: true,
    ...(extras.accepts !== undefined ? { accepts: [...extras.accepts] } : {}),
    ...(extras.harness !== undefined ? { harness: extras.harness } : {}),
  };
}

/** The `warm` answer, read tolerantly like every answer: no decision. */
const WarmResponseSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  warm: z.literal(true),
});

/** Whether a body is the `warm` answer. A router without the form answers
 *  anything else: a 400 for an unknown field, or a decision. */
export function isWarmAnswer(body: unknown): boolean {
  return WarmResponseSchema.safeParse(body).success;
}

/** The parsers, exposed so the shared wire fixtures are checked against the
 *  same schemas production parses with rather than against a copy of them. */
export function parseForTests(
  kind: CallKind,
  value: unknown,
): { success: boolean; data?: unknown } {
  const parsed = schemaFor(kind).safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

function schemaFor(kind: CallKind) {
  return kind === 'hook'
    ? HookResponseSchema
    : kind === 'tool'
      ? ToolResponseSchema
      : BrowseResponseSchema;
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
  fetchImpl?: typeof fetch;
  /** Overrides the per-call deadline; the hook passes its own, smaller one. */
  timeoutMs?: number;
  /** The payer, inside `tenjin mcp`: it sends the call and pays the routing
   *  fee with the stock x402 client. Absent, the call goes unpaid. */
  route?: DecisionRoute;
}

/** How a routing call is paid. `send` throws {@link RouteSkipped} when it has
 *  no paid answer for the call, which then is skipped. */
export interface DecisionRoute {
  send: (url: string, options: HttpRequestOptions) => Promise<HttpResult>;
  /** What this route's calls deposited into the routing channel and the
   *  router took, with any background top-up not said yet, 0n for none: the
   *  caller says so once, where it is read. */
  deposited?: () => bigint;
  /** The routing fee the router last quoted this route's calls, atomic
   *  USDC, for a line that names it; undefined before any quote. */
  fee?: () => bigint | undefined;
}

/**
 * What a skip knows about the money behind it, for the one sentence that says
 * it: the fee the router quoted, when the payer read one, and for `wallet_low`
 * the balance the background top-up read and the deposit it fell short of.
 */
export interface SkipFacts {
  quotedAtomic?: bigint;
  balanceAtomic?: bigint;
  depositAtomic?: bigint;
}

/** The paid route gave this call no answer: the wallet locked, low or over
 *  its spend limits, the fee quoted above the ceiling, the channel busy or
 *  being topped up, or the payment failed. */
export class RouteSkipped extends Error {
  /** `unreached`: the paid call could not reach the router
   *  ({@link isUnreachable}), so the call reads as that transport failure. */
  readonly unreached: FetchJsonFailure | undefined;
  readonly quotedAtomic: bigint | undefined;
  readonly balanceAtomic: bigint | undefined;
  readonly depositAtomic: bigint | undefined;
  constructor(
    readonly why: string,
    opts: { unreached?: FetchJsonFailure } & SkipFacts = {},
  ) {
    super(`routing fee not paid: ${why}`);
    this.unreached = opts.unreached;
    this.quotedAtomic = opts.quotedAtomic;
    this.balanceAtomic = opts.balanceAtomic;
    this.depositAtomic = opts.depositAtomic;
  }

  /** The facts it carries, with no undefined keys. */
  facts(): SkipFacts {
    return {
      ...(this.quotedAtomic !== undefined ? { quotedAtomic: this.quotedAtomic } : {}),
      ...(this.balanceAtomic !== undefined ? { balanceAtomic: this.balanceAtomic } : {}),
      ...(this.depositAtomic !== undefined ? { depositAtomic: this.depositAtomic } : {}),
    };
  }
}

/** Another session's call was in flight on the wallet's routing channel. */
export const CHANNEL_BUSY = 'channel_busy';
/** The paid call got no answer, a refused payment or a server error. */
export const PAYMENT_FAILED = 'payment_failed';
/** The payment went out and the call's budget ran out before its answer:
 *  no fault. `tenjin mcp` lets the request finish, so it is recorded. */
export const DEADLINE_AFTER_PAYMENT_SENT = 'deadline_after_payment_sent';
/** The route asked for the fee, and this call had no payer to pay it. */
export const NO_PAYER = 'no_payer';
/** The channel needed a deposit, and this process's background top-up did
 *  not land inside the call's budget: no fault, the next call pays. */
export const TOPPING_UP = 'topping_up';
/** The channel needed a deposit, which only the background top-up makes, and
 *  this process's could not make it now (another session's top-up of the same
 *  wallet is in flight, or the channel was busy): no fault. */
export const DEPOSIT_DEFERRED = 'deposit_deferred';

export type DecisionOutcome<T> =
  /** `skipped`: offers in it this build cannot run, already taken out
   *  ({@link withoutUnmet}). */
  | { status: 'decided'; decision: T; skipped?: SkippedOffer[] }
  /** No routing answer: the turn goes without one. */
  | {
      status: 'failed';
      reason: string;
      errorCode?: string;
      /** The router could not be reached at all ({@link isUnreachable}). */
      unreachable?: true;
      /** No answer came back at all: a transport failure or a timeout. */
      noAnswer?: true;
    }
  /** The routing fee was not paid ({@link RouteSkipped}, {@link NO_PAYER}):
   *  nothing was routed, and the native tool runs, with what the skip knew
   *  ({@link SkipFacts}). */
  | ({ status: 'skipped'; why: string } & SkipFacts);

/**
 * ONE ROUTING CALL, IN TWO FORMS, ON THE PAID ROUTE. The hook sends
 * `{ packet }`: the backend runs the gate, and on `execute` stores that packet
 * under an id and answers with each offered service's spec. The tool sends
 * `{ query }`, which the backend answers with the spec of the service its gate
 * picks, or `{ query, id }` for the free docs offer, which has no spec and is
 * bound from the query. Every provider call is built here, from a spec, or for
 * the docs lookup by the backend from the query.
 *
 * ONE REQUEST, PAID OR SKIPPED. A call the payer cannot pay is `skipped` at
 * once: no second request, on any route. With no payer the call goes unpaid,
 * and a route that asks for the fee (a 402) is a skip with {@link NO_PAYER};
 * a route that charges nothing (the fee off, in development) answers it.
 */
export async function requestDecision(
  kind: 'hook',
  request: { packet: Packet; sessionId?: string },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse>>;
export async function requestDecision(
  kind: 'tool',
  request: { query: string; id?: string; gateHint?: GateHint },
  deps: DecisionDeps,
): Promise<DecisionOutcome<ToolResponse>>;
export async function requestDecision(
  kind: CallKind,
  request: {
    query?: string;
    packet?: Packet;
    sessionId?: string;
    id?: string;
    gateHint?: GateHint;
  },
  deps: DecisionDeps,
): Promise<DecisionOutcome<HookResponse | ToolResponse>> {
  const url = new URL(ROUTE_PAID_PATH, deps.baseUrl).toString();
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
          })
        : buildToolBody({
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.id !== undefined ? { id: request.id } : {}),
            ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true),
            harness: deps.harness ?? 'claude',
          }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const schema = kind === 'hook' ? HookResponseSchema : ToolResponseSchema;
  let response: HttpResult;
  try {
    response = await (deps.route?.send ?? httpRequest)(url, options);
  } catch (err) {
    if (!(err instanceof RouteSkipped)) throw err;
    if (err.unreached !== undefined) return readOffer(err.unreached, schema);
    return { status: 'skipped', why: err.why, ...err.facts() };
  }
  if (deps.route === undefined && response.ok && response.status === 402) {
    return { status: 'skipped', why: NO_PAYER };
  }
  return readOffer(response, schema);
}

/**
 * THE TWO FREE READS OF THE TOOL LIST. `{browse}` lists the tools that fit a
 * need (or all of them, by kind, for `""`), and `{tool}` answers a browse
 * row's id with that tool's spec under a fresh offer id, exactly as a query
 * with no id is answered. Neither makes a gate call on the server, neither is
 * charged the routing fee, and neither pays anything here, so both always take
 * the free route: `deps.route` is never read.
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
  return readOffer(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildToolSpecBody({
        tool,
        accepts: acceptsFor(deps.acceptsBazaar === true),
        harness: deps.harness ?? 'claude',
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    ToolResponseSchema,
  ) as DecisionOutcome<ToolResponse>;
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
  };
}

function readDecision<T extends z.ZodTypeAny>(
  response: HttpResult,
  schema: T,
): DecisionOutcome<z.infer<T>> {
  // A transport failure says its own reason.
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
    };
  }
  const parsed = schema.safeParse(response.json);
  if (!parsed.success) {
    return { status: 'failed', reason: 'The router returned a decision this build cannot read.' };
  }
  return { status: 'decided', decision: parsed.data as z.infer<T> };
}

/** A hook or tool answer, read, with each offer this build cannot run taken
 *  out ({@link withoutUnmet}). */
function readOffer(
  response: HttpResult,
  schema: typeof HookResponseSchema | typeof ToolResponseSchema,
): DecisionOutcome<HookResponse | ToolResponse> {
  const read = readDecision<z.ZodType<HookResponse | ToolResponse>>(response, schema);
  if (read.status !== 'decided') return read;
  const { decision, skipped } = withoutUnmet(read.decision.decision);
  return {
    ...read,
    decision: { ...read.decision, decision } as HookResponse | ToolResponse,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
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
 * read, and never a reset socket, which a fresh connection usually gets past.
 */
export function isUnreachable(failure: FetchJsonFailure): boolean {
  return (
    failure.kind === 'network' &&
    failure.status === undefined &&
    failure.transport !== undefined &&
    !RESET_CODES.has(failure.transport.code ?? '')
  );
}

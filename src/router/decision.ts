import { z } from 'zod';
import { fetchFailureToCliError, httpRequest, MAX_BINARY_BODY_BYTES } from '../lib/http';
import type { FetchJsonFailure, HttpRequestOptions, HttpResult } from '../lib/http';
import type { CommandContext } from '../context';
import type { Packet } from './context';
import type { Harness } from './names';
import {
  SETTINGS_ACCEPT,
  SettingsHashSchema,
  TargetIdSchema,
  type WireSettings,
} from './settings-wire';

/**
 * ONE ROUTING PATH, ONE DECISION PER LOOKUP. Every routing call, the hook's
 * and the `request` tool's, goes to the paid route ({@link ROUTE_PAID_PATH}).
 * Inside `tenjin mcp` the payer sends it through the stock x402 client and
 * pays the routing fee its 402 quotes ({@link DecisionRoute},
 * `routing-payer.ts`); a call it cannot pay is skipped, with no request to any
 * other route. One whose channel needs a deposit waits for the payer's
 * background top-up inside its budget first. The free route ({@link ROUTER_PATH}) keeps only what stays free:
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
 * keeps its type, its bounds and its checks, and a job's `pollUrl` or
 * `running` naming the keys of both its arms is still refused (an answer's
 * own arms are told apart by `action`). An offer that a client
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
   *  and each file a media result links to, though not yet a job's polled
   *  result. Absent, and at most, the {@link MAX_BINARY_BODY_BYTES} every
   *  call had. */
  maxBytes: z.number().int().min(1).max(MAX_BINARY_BODY_BYTES).optional(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const OfferSpecSchema = ToolSpecSchema.extend({ id: IdSchema });
export type OfferSpec = z.infer<typeof OfferSpecSchema>;

/** One spec per service the line names: the offer, any other service it
 *  lists, and each option of a choice set. */
const SpecsSchema = z.array(OfferSpecSchema).min(1).max(8).optional();

/*
 * A SERVICE ON A CONNECTED ACCOUNT (plan 37), with the bounds tenjin's
 * `wire.ts` holds it to: one MCP tool call this client makes on the user's
 * own account, which the user's plan pays. Sent only to a build that lists
 * `mcp`, and only for an account its `settings.sources` names. It carries no
 * URL, no credential and no price: this client calls the server it connected
 * for `source`, so no answer can send a user's token anywhere else.
 */

/** The `accepts` token for a call on a connected account. */
export const MCP_ACCEPT = 'mcp';

/** A connected account's id, which this client keeps its sign-in under: the
 *  vault `sources/<id>.json` and the OS-store account `source:<id>:<folder>`.
 *  Narrower than a target id, so no file system, shell or keychain command
 *  line reads it as anything else. */
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

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
const AccountStateSchema = z.object({
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
const AccountPollSchema = z.object({
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
const AccountStepSchema = z.object({
  when: AccountStateSchema.optional(),
  poll: AccountPollSchema.optional(),
  ...AccountCallFields,
});

export const AccountCallSchema = z.object({
  ...AccountCallFields,
  next: AccountStepSchema.optional(),
});
export type AccountCall = z.infer<typeof AccountCallSchema>;

const AccountSpecFields = z.object({
  capabilityId: z.string().min(1).max(200),
  provider: z.string().min(1).max(120),
  label: LabelSchema.optional(),
  holds: z
    .object({
      WebSearch: z.string().min(1).max(64).optional(),
      WebFetch: z.string().min(1).max(64).optional(),
    })
    .optional(),
  output: z.enum(['json', 'text', 'media']).optional(),
  description: z.string().min(1).max(500),
  /** The connected account the call runs on: this client attaches the
   *  credential it holds for it, and only while it is connected here. */
  source: z.string().regex(ACCOUNT_ID),
  /** The call on the account, in place of a paid spec's price and request. */
  mcp: AccountCallSchema,
  input: z.record(z.string(), z.unknown()),
  pinned: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).optional(),
  returns: z.string().min(1).max(200).optional(),
  returnsExample: z.unknown().optional(),
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /** Tenjin has checked this map with a real call. An unchecked one runs only
   *  when the user names it (`request({tool})` by its id). */
  verified: z.boolean(),
  requires: RequiresSchema,
  // A paid spec's own keys: an object naming them is no account spec.
  priceAtomic: OtherArm,
  request: OtherArm,
  payTo: OtherArm,
});

/** Every string in a template that is exactly a placeholder. */
function placeholders(value: unknown): string[] {
  if (typeof value === 'string')
    return INPUT_PLACEHOLDER.test(value) || RESULT_PLACEHOLDER.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(placeholders);
  if (value && typeof value === 'object') return Object.values(value).flatMap(placeholders);
  return [];
}

/** The built-in source, which an account spec never names. */
const BUILT_IN = 'tenjin';

function accountSpecProblems(spec: z.infer<typeof AccountSpecFields>, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const { mcp } = spec;
  if (spec.source === BUILT_IN) issue(`an account service is never on ${BUILT_IN}`, ['source']);
  if (!(spec.requires ?? []).includes(MCP_ACCEPT))
    issue(`an account spec requires ${MCP_ACCEPT}`, ['requires']);
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

export const isAccountSpec = <T extends object>(spec: T): spec is T & AccountSpec =>
  'mcp' in spec && 'source' in spec;

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

/** One call's input, bounded as the server bounds it. */
export const INPUT_MAX_BYTES = 16 * 1024;

/**
 * THE NATIVE CALL'S OWN INPUT, on a hook answer for a pending WebSearch or
 * WebFetch to a client that sends `settings`, only while the user turned on
 * automatic use and the pick fits its provider scope: the offer id to run
 * and the complete input the server built from that call's own query or URL
 * through the spec's `holds`. Run unchanged in the native call's place,
 * through the ordinary executor and the check before every call, or not at
 * all; never edited, merged or parsed here (`swap.ts`).
 */
export const BoundSchema = z.object({
  id: IdSchema,
  input: z
    .record(z.string(), z.unknown())
    .refine(
      (input) => Buffer.byteLength(JSON.stringify(input), 'utf8') <= INPUT_MAX_BYTES,
      `bound input must serialize to at most ${INPUT_MAX_BYTES} bytes`,
    ),
});
export type Bound = z.infer<typeof BoundSchema>;

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
    bound: BoundSchema.optional(),
  })
  .superRefine(checkHint)
  .superRefine(checkChoices);

/**
 * AN ACCOUNT LEAD IS OFFERED ALONE, as a checked service this client runs on
 * its own connection: no endpoint, no balance price, in place of a native
 * call only through `bound` as any lead. Every other `execute` is as it always
 * was, with the URL it pays.
 */
function checkExecute(
  decision: {
    id: string;
    capabilityId: string;
    providerPriceAtomic: string;
    endpoint?: string | undefined;
    specs?: AnyOfferSpec[] | undefined;
    delivery?: 'offer' | 'augment' | 'note' | undefined;
    augmentUrl?: string | undefined;
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
    return;
  }
  if (specs.length > 1) issue('an account lead is offered alone', ['specs']);
  if (decision.endpoint !== undefined)
    issue('an account lead names no endpoint: this client calls its own account', ['endpoint']);
  if (decision.capabilityId !== lead.capabilityId)
    issue('the listing names the lead', ['capabilityId']);
  if (decision.providerPriceAtomic !== '0')
    issue('the balance pays an account lead nothing', ['providerPriceAtomic']);
  if (!lead.verified) issue('the hook offers only a checked account service', ['specs']);
  if (decision.delivery === 'augment' || decision.augmentUrl !== undefined)
    issue('an account lead is an offer', ['delivery']);
}

const HookDecisionSchema = z.discriminatedUnion('action', [
  z
    .object({
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
       * `note` is the free docs lookup before a search, for a client that
       * also lists `note`: the line comes after the search. `augment` is the
       * same offer for a client that does not, with the `augmentUrl` that
       * client fetches. `offer` is every other line. This build shows only a
       * `note` after a search; any other free offer before one, `augment`
       * included, runs silent.
       */
      delivery: z.enum(['offer', 'augment', 'note']).optional(),
      augmentUrl: z.string().url().max(2_048).optional(),
      bound: BoundSchema.optional(),
    })
    .superRefine(checkHint)
    .superRefine(checkExecute),
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
      spec: z.union([ToolSpecSchema, AccountSpecSchema]),
      hint: z.string().min(1).max(2_000),
    })
    .superRefine(checkHint),
  DiscoveredSchema,
  RefusedSchema.extend({ action: z.literal('native') }),
  RefusedSchema.extend({ action: z.literal('needs_input') }),
]);

/**
 * WHICH REQUEST FIELDS THE SERVER APPLIED (RFC 7240's Preference-Applied):
 * `settings` when it decided under the user's rules, and then
 * {@link SettingsHashSchema} `settingsHash` is the request's own hash,
 * verbatim. Both only to a client that lists `settings` in `accepts`. The
 * hash is what the check before every call compares with the rules saved
 * now (`settings-check.ts`); it names a rule set and authorizes nothing.
 */
const HonoredSchema = z.array(z.string().min(1).max(32)).max(16).optional();

function envelope<T extends z.ZodTypeAny>(decision: T) {
  return z.object({
    schemaVersion: z.literal(1),
    routerVersion: z.string().min(1).max(64),
    honored: HonoredSchema,
    settingsHash: SettingsHashSchema.optional(),
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
 * does, its price as the server writes it, and its kind. Read like every
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
  honored: HonoredSchema,
  settingsHash: SettingsHashSchema.optional(),
  rows: z.array(BrowseRowSchema).max(200),
});
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;

const Labelled = { id: TargetIdSchema, label: z.string().min(1).max(120) };

/** How an account signs in: `oauth` is the MCP sign-in, `key` a pasted key
 *  sent as `Authorization: <keyScheme> <key>`. */
export const SIGN_IN = ['oauth', 'key'] as const;
export type SignIn = (typeof SIGN_IN)[number];
export const KEY_SCHEMES = ['Bearer', 'Key'] as const;
export type KeyScheme = (typeof KEY_SCHEMES)[number];

/** Where a connected account is called. A user's token goes here, so it is
 *  https, with no credentials, query, fragment or trailing slash to make it
 *  another server or carry anything else. */
export function isAccountUrl(value: string): boolean {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  return (
    url?.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !value.includes('?') &&
    !value.includes('#') &&
    !value.endsWith('/')
  );
}

const twice = (keys: readonly string[]) => new Set(keys).size !== keys.length;

/**
 * HOW THIS CLIENT CONNECTS AN ACCOUNT, on a source row of the identities read
 * because this build lists `mcp`: its MCP server, the sign-ins it takes, how a
 * pasted key is sent, and every tool its maps call, which the free
 * connect-time `tools/list` must hold for those maps to run on this machine.
 * `tenjin` never has one.
 */
export const ConnectableSchema = z
  .object({
    mcpUrl: z
      .string()
      .max(2_048)
      .refine(isAccountUrl, 'an https URL with no credentials, query, fragment or trailing slash'),
    signIn: z.array(z.enum(SIGN_IN)).min(1).max(2),
    keyScheme: z.enum(KEY_SCHEMES).optional(),
    expectTools: z.array(McpToolSchema).min(1).max(64),
  })
  .superRefine((connectable, ctx) => {
    const issue = (message: string, path: string[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    if (twice(connectable.signIn)) issue('each sign-in is listed once', ['signIn']);
    if (connectable.signIn.includes('key') !== (connectable.keyScheme !== undefined))
      issue('a key sign-in says how the key is sent, and only it does', ['keyScheme']);
    if (twice(connectable.expectTools)) issue('each tool is listed once', ['expectTools']);
  });
export type Connectable = z.infer<typeof ConnectableSchema>;

/**
 * EVERY ID A SETTING CAN NAME, free: the categories with their tasks, the
 * tasks, providers, sellers, services (with the task, providers and seller
 * each is identified by) and sources, each with its label. `tenjin config`
 * resolves a typed name against it and names saved rules by it; it never
 * decides with it. Built by the server from its catalog, with no gate, no
 * model and no payment. Read tolerantly like every answer here.
 */
const IdentitiesResponseSchema = z.object({
  schemaVersion: z.literal(1),
  routerVersion: z.string().min(1).max(64),
  honored: HonoredSchema,
  categories: z.array(z.object({ ...Labelled, tasks: z.array(TargetIdSchema).max(256) })).max(256),
  /** `speed`: a task the speed preference changes (it has a speed criterion). */
  tasks: z
    .array(
      z.object({
        ...Labelled,
        category: TargetIdSchema.optional(),
        speed: z.literal(true).optional(),
      }),
    )
    .max(1_024),
  providers: z.array(z.object(Labelled)).max(2_048),
  sellers: z.array(z.object(Labelled)).max(2_048),
  services: z
    .array(
      z.object({
        ...Labelled,
        task: TargetIdSchema.optional(),
        providers: z.array(TargetIdSchema).max(16),
        seller: TargetIdSchema.optional(),
      }),
    )
    .max(4_096),
  /** `connectable`, for a build that lists `mcp`: an account this client can
   *  connect, never `tenjin`. */
  sources: z
    .array(
      z
        .object({ ...Labelled, connectable: ConnectableSchema.optional() })
        .refine(
          ({ id, connectable }) =>
            connectable === undefined || (id !== BUILT_IN && ACCOUNT_ID.test(id)),
          'only an account id is connectable, never tenjin',
        ),
    )
    .max(64),
});
export type IdentitiesResponse = z.infer<typeof IdentitiesResponseSchema>;

/** A hook answer reread from disk (`decided.ts`), held to the same schema as
 *  the router's: anything else reads as absent. */
export function parseHookResponse(value: unknown): HookResponse | undefined {
  const parsed = HookResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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
 * A BACKSTOP, NOT A FILTER. The server sends only `requires` tokens a client
 * lists in `accepts`, so a client meets an unmet one only when that rule was
 * broken, and then it fails safe. A spec whose `requires` names a feature this
 * build lacks is dropped. When the answer's line names what was dropped (the
 * answer's own offer, through its `requires`, its own spec or a `spec`
 * answer's spec; another spec whose id the line carries; or any option of its
 * choice set), the line can no longer be shown as written, so the whole
 * answer becomes a `native` that names the missing features: a named skip,
 * never a guess. A dropped spec the line does not name is only dropped.
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
  const options = new Set(
    decision.action === 'discovered' ? (decision.choices?.options ?? []).map((o) => o.id) : [],
  );
  const hint = 'hint' in decision ? decision.hint : '';
  if (skipped.some((s) => options.has(s.id) || hint.includes(s.id))) {
    const missing = [...new Set(skipped.flatMap((s) => s.missing))];
    return { decision: unmetRefusal(missing) as T, skipped };
  }
  const gone = new Set(skipped.map((s) => s.id));
  return {
    decision: { ...decision, specs: specs.filter((spec) => !gone.has(spec.id)) } as T,
    skipped,
  };
}

function unmetRefusal(missing: string[]) {
  const named = missing.map((token) => `\`${token}\``).join(', ');
  return {
    action: 'native' as const,
    reason: `This offer needs ${named}, which this build of tenjin-cli does not have, so it was skipped and no provider was paid.`,
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
export type CallKind = 'hook' | 'tool' | 'browse' | 'identities';

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
 * every answer as a tolerant reader and honors `requires` ({@link withoutUnmet}).
 * Once the server reads it (tenjin R2), it sends a new field, `requires`
 * included, only to a client that lists it, and today's shape to one that
 * does not, which is every release from before it and reads strictly. `bazaar` widens discovery to the open
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
export const FREE_QUERY_ACCEPT = 'free-query';

/** Every feature this build has, which a `requires` list is read against:
 *  `bazaar` included, which it runs whether or not it asks for one. */
const CLIENT_FEATURES: ReadonlySet<string> = new Set([
  ...CLIENT_ACCEPTS,
  BAZAAR_ACCEPT,
  FREE_QUERY_ACCEPT,
  SETTINGS_ACCEPT,
  MCP_ACCEPT,
]);

/** The features a `requires` list names that this build lacks; none when it
 *  has them all. */
export function unmetRequires(requires: readonly string[] | undefined): string[] {
  return (requires ?? []).filter((token) => !CLIENT_FEATURES.has(token));
}

/** The `accepts` this build sends, with the open Bazaar or without it, and
 *  `settings` beside the `settings` field, which every production routing
 *  call carries (also when the user has no rules). `mcp` rides with it: a
 *  call on a connected account is offered only for an account the
 *  settings' `sources` names, so it means nothing without them. It takes a
 *  spec whose call is an MCP tool call on that account, the `execute` that
 *  offers one with no `endpoint`, `connectable` on the identities read, and
 *  the `{refused}` re-ask ({@link requestRefused}). */
export function acceptsFor(bazaar: boolean, settings = false): string[] {
  return [
    ...CLIENT_ACCEPTS,
    ...(bazaar ? [BAZAAR_ACCEPT] : []),
    ...(settings ? [SETTINGS_ACCEPT, MCP_ACCEPT] : []),
  ];
}

/**
 * The exact body the hook call sends, spelled once and pinned to the shared
 * fixtures. The route ignores a field it does not know (the tolerant
 * contract), so a new optional field reaches a server that predates it as
 * nothing at all.
 *
 * `improve: true` rides only while the person has turned on "Help improve
 * routing" (`router.improve`): the server then keeps this call's sealed packet
 * beside its decision row, with no expiry, until they turn it off. Absent, it
 * keeps nothing past the id's 15 minutes.
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
  extras: {
    sessionId?: string;
    accepts?: readonly string[];
    harness?: Harness;
    improve?: boolean;
    budgetMs?: number;
    settings?: WireSettings;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    ...(extras.accepts !== undefined ? { accepts: [...extras.accepts] } : {}),
    ...(extras.harness !== undefined ? { harness: extras.harness } : {}),
    ...(extras.budgetMs !== undefined ? { budgetMs: extras.budgetMs } : {}),
    packet,
    ...(extras.improve === true ? { improve: true } : {}),
    // A SIBLING OF THE PACKET, never inside it: the packet is what the
    // server's model reads, and the user's settings are for code alone.
    ...(extras.settings !== undefined ? { settings: extras.settings } : {}),
  };
}

/** The exact body the tool call sends. `id` is the offer the query is for,
 *  sent only for an offer with no spec kept; `gateHint` is evidence, never
 *  authority; `improve` as on the hook body. */
export function buildToolBody(request: {
  query?: string;
  id?: string;
  gateHint?: GateHint;
  accepts?: readonly string[];
  harness?: Harness;
  improve?: boolean;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
    ...(request.accepts !== undefined ? { accepts: [...request.accepts] } : {}),
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.improve === true ? { improve: true } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}

/**
 * THE RE-ASK AFTER AN ACCOUNT REFUSED (plan 37, review round 1): the usual
 * envelope with `refused`, the id of the offer the account refused, and no
 * query. The server routes that offer's own turn again with the account left
 * out for this one answer, under the settings sent, and answers as it answers
 * a query: an offer, or native.
 */
export function buildRefusedBody(request: {
  refused: string;
  accepts: readonly string[];
  harness?: Harness;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    refused: request.refused,
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}

/** The free browse of the tool list: `browse` is the need, or `""` for every
 *  tool by kind. No gate call and no Jev on the server. */
export function buildBrowseBody(request: {
  browse: string;
  accepts: readonly string[];
  harness?: Harness;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    browse: request.browse,
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}

/** A browse row's spec, or a query bound to that selected free tool. */
export function buildToolSpecBody(request: {
  tool: string;
  query?: string;
  accepts: readonly string[];
  harness?: Harness;
  settings?: WireSettings;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tool: request.tool,
    ...(request.query !== undefined ? { query: request.query } : {}),
    accepts: [...request.accepts],
    ...(request.harness !== undefined ? { harness: request.harness } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
  };
}

/** The free identities read: every id a setting can name. No settings and
 *  no harness ride on it: its answer is the same for every client. */
export function buildIdentitiesBody(): Record<string, unknown> {
  return { schemaVersion: 1, identities: true, accepts: acceptsFor(false, true) };
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
      : kind === 'browse'
        ? BrowseResponseSchema
        : IdentitiesResponseSchema;
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
   * The host asking. Automatic routing avoids services the host already covers;
   * explicit browsing and selection retain every runnable service. Absent is
   * `claude`, and every production caller sends it.
   */
  harness?: Harness;
  fetchImpl?: typeof fetch;
  /** Overrides the per-call deadline; the hook passes its own, smaller one. */
  timeoutMs?: number;
  /** The payer, inside `tenjin mcp`: it sends the call and pays the routing
   *  fee with the stock x402 client. Absent, the call goes unpaid. */
  route?: DecisionRoute;
  /** `router.improve`: the person turned on "Help improve routing", so the
   *  call says `improve: true`. Off by default. */
  improve?: boolean;
  /**
   * The user's settings as the wire carries them, resolved from the global
   * file on every call (`routerSettings`) and never cached: sent with
   * `settings` in `accepts` on every routing form. Absent only in tests and
   * the free identities read.
   */
  settings?: WireSettings;
}

/** How a routing call is paid. `send` throws {@link RouteSkipped} when it has
 *  no paid answer for the call, which then is skipped, or read as the
 *  transport failure it carries in `unreached`. */
export interface DecisionRoute {
  send: (url: string, options: HttpRequestOptions) => Promise<HttpResult>;
  /** What this route's own calls deposited into the routing channel and the
   *  router took (only on a router with no `warm` form), 0n for none: the
   *  caller says so once, where it is read. */
  deposited?: () => bigint;
  /** What the payer's background top-ups deposited since this was last
   *  read, 0n for none, and taken by the read. Only a hook leg reads it, so
   *  the person is told, in its `systemMessage`. */
  toppedUp?: () => bigint;
}

/** The paid route gave this call no answer: the wallet locked, low or over
 *  its spend limits, the fee quoted above the ceiling, the channel busy or
 *  being topped up, or the payment failed. */
export class RouteSkipped extends Error {
  /** `unreached`: the paid call could not reach the router
   *  ({@link isUnreachable}), so the call reads as that transport failure.
   *  `quotedAtomic`: the fee the router quoted, when the payer read one.
   *  `answered`: the router answered a request of this call (its 402, say). */
  readonly unreached: FetchJsonFailure | undefined;
  readonly quotedAtomic: bigint | undefined;
  readonly answered: boolean;
  constructor(
    readonly why: string,
    opts: { unreached?: FetchJsonFailure; quotedAtomic?: bigint; answered?: boolean } = {},
  ) {
    super(`routing fee not paid: ${why}`);
    this.unreached = opts.unreached;
    this.quotedAtomic = opts.quotedAtomic;
    this.answered = opts.answered === true;
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
 *  not land inside the call's budget: no fault. The next call pays from it if
 *  it lands, or gets its refusal if it was refused. */
export const TOPPING_UP = 'topping_up';
/** The background top-up got no usable answer: the router rate-limited it,
 *  or no connection reached it. No fault, as on any routing call, and never
 *  the machine-wide unreachable pause: the call it served reached the router.
 *  The top-up is tried again after its backoff. */
export const TOP_UP_UNAVAILABLE = 'top_up_unavailable';
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
   *  nothing was routed, and the native tool runs. `quotedAtomic`: the fee
   *  the router quoted, when the payer read one. `answered`: the router
   *  answered first, so it is reachable. */
  | { status: 'skipped'; why: string; quotedAtomic?: bigint; answered?: true };

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
  const timeoutMs = deps.timeoutMs ?? deps.ctx.flags.timeout;
  const options: HttpRequestOptions = {
    method: 'POST',
    timeoutMs,
    blockRedirects: true,
    jsonBody:
      kind === 'hook'
        ? buildHookBody(request.packet as Packet, {
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true, deps.settings !== undefined),
            harness: deps.harness ?? 'claude',
            improve: deps.improve === true,
            budgetMs: Math.min(5_000, Math.max(0, timeoutMs)),
            ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
          })
        : buildToolBody({
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.id !== undefined ? { id: request.id } : {}),
            ...(request.gateHint !== undefined ? { gateHint: request.gateHint } : {}),
            accepts: acceptsFor(deps.acceptsBazaar === true, deps.settings !== undefined),
            harness: deps.harness ?? 'claude',
            improve: deps.improve === true,
            ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
          }),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  return sendPaid(url, options, kind === 'hook' ? HookResponseSchema : ToolResponseSchema, deps);
}

/**
 * `{refused}` ON THE PAID ROUTE, paid or skipped like a query
 * ({@link requestDecision}), and answered the same way: an offer, or native.
 * It needs `mcp`, which rides with the settings.
 */
export async function requestRefused(
  refused: string,
  deps: DecisionDeps,
): Promise<DecisionOutcome<ToolResponse>> {
  const url = new URL(ROUTE_PAID_PATH, deps.baseUrl).toString();
  return sendPaid(
    url,
    {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildRefusedBody({
        refused,
        accepts: acceptsFor(deps.acceptsBazaar === true, deps.settings !== undefined),
        harness: deps.harness ?? 'claude',
        ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
    ToolResponseSchema,
    deps,
  ) as Promise<DecisionOutcome<ToolResponse>>;
}

/** One request on the paid route: sent by the payer, or unpaid with none. */
async function sendPaid(
  url: string,
  options: HttpRequestOptions,
  schema: typeof HookResponseSchema | typeof ToolResponseSchema,
  deps: Pick<DecisionDeps, 'route'>,
): Promise<DecisionOutcome<HookResponse | ToolResponse>> {
  let response: HttpResult;
  try {
    response = await (deps.route?.send ?? httpRequest)(url, options);
  } catch (err) {
    if (!(err instanceof RouteSkipped)) throw err;
    if (err.unreached !== undefined) return readOffer(err.unreached, schema);
    return {
      status: 'skipped',
      why: err.why,
      ...(err.quotedAtomic !== undefined ? { quotedAtomic: err.quotedAtomic } : {}),
      ...(err.answered ? { answered: true as const } : {}),
    };
  }
  if (deps.route === undefined && response.ok && response.status === 402) {
    return { status: 'skipped', why: NO_PAYER, answered: true };
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
        accepts: acceptsFor(deps.acceptsBazaar === true, deps.settings !== undefined),
        harness: deps.harness ?? 'claude',
        ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    BrowseResponseSchema,
  );
}

/** `{tool}` reads a spec; `{tool, query}` binds a free lookup without paid routing. */
export async function requestToolSpec(
  tool: string,
  deps: Omit<DecisionDeps, 'route'>,
  query?: string,
): Promise<DecisionOutcome<ToolResponse>> {
  return readOffer(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildToolSpecBody({
        tool,
        ...(query !== undefined ? { query } : {}),
        accepts: [
          ...acceptsFor(deps.acceptsBazaar === true, deps.settings !== undefined),
          FREE_QUERY_ACCEPT,
        ],
        harness: deps.harness ?? 'claude',
        ...(deps.settings !== undefined ? { settings: deps.settings } : {}),
      }),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    ToolResponseSchema,
  ) as DecisionOutcome<ToolResponse>;
}

/**
 * EVERY ID A SETTING CAN NAME, ALWAYS FREE: no gate, no model, no payment, so
 * it takes the free route whatever `deps.route` says. `tenjin config` resolves
 * a typed name against it before it writes anything.
 */
export async function requestIdentities(
  deps: Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl' | 'timeoutMs'>,
): Promise<DecisionOutcome<IdentitiesResponse>> {
  return readDecision(
    await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: deps.timeoutMs ?? deps.ctx.flags.timeout,
      blockRedirects: true,
      jsonBody: buildIdentitiesBody(),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    IdentitiesResponseSchema,
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
  /** The path that made the call, when it was not an ordinary request:
   *  `swap`, a native search or fetch answered in place. */
  via?: 'swap';
}

/**
 * Why a shown offer was never taken. `expired`: its 15 minutes ran out with no
 * `request` call naming it. `native_after_offer`: the same agent in the same
 * session made a native WebSearch or WebFetch call while it was still untaken.
 */
export type IgnoredReason = 'expired' | 'native_after_offer';

/** An offer the host was shown and did not take: its id and why, no text. */
export interface IgnoredOutcome {
  id: string;
  status: 'ignored';
  reason: IgnoredReason;
}

/** The outcome report's own deadline: it is telemetry and never holds a result. */
export const OUTCOME_TIMEOUT_MS = 3_000;

/**
 * TELL THE SERVER A SPEC WAS USED. The client called and paid the provider
 * itself, so this is the only word the server gets that its offer was taken,
 * or that a call for it stopped before payment and why, or that it was shown
 * and never taken. Never throws and never waits on anything the caller needs:
 * a lost report costs one count.
 */
export async function reportSpecOutcome(
  outcome: SpecOutcome | IgnoredOutcome,
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

/**
 * The exact body of an outcome report, pinned to the shared fixtures. Built
 * field by field, so it NEVER CARRIES `result`: a paid call that ran is not a
 * call that helped, and the useful rate comes from labelled samples, not from
 * this client's say-so. The server keeps reading `result` from custom setups.
 */
export function buildOutcomeBody(
  outcome: SpecOutcome | IgnoredOutcome,
  harness?: Harness,
): Record<string, unknown> {
  const spec: Partial<SpecOutcome> = outcome.status === 'ignored' ? {} : outcome;
  return {
    schemaVersion: 1,
    id: outcome.id,
    ...(harness !== undefined ? { harness } : {}),
    status: outcome.status,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(spec.httpStatus !== undefined ? { httpStatus: spec.httpStatus } : {}),
    ...(spec.ms !== undefined ? { ms: Math.max(0, Math.round(spec.ms)) } : {}),
    ...(spec.via !== undefined ? { via: spec.via } : {}),
  };
}

/**
 * The `forget` form, pinned to the shared fixture: delete every packet the
 * server kept for this install. The install is the `tenjin-install-id` header
 * the transport already sends to Tenjin's origins, so the body names nothing.
 */
export function buildForgetBody(): Record<string, unknown> {
  return { schemaVersion: 1, forget: 'samples' };
}

/**
 * ASK THE SERVER TO DELETE WHAT "HELP IMPROVE ROUTING" KEPT, on the free
 * route, under the outcome report's short deadline. Never throws: the answer
 * is whether it was done, or why not, for the caller to say.
 */
export async function requestForget(
  deps: Pick<DecisionDeps, 'baseUrl' | 'fetchImpl'>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await httpRequest(new URL(ROUTER_PATH, deps.baseUrl).toString(), {
      method: 'POST',
      timeoutMs: OUTCOME_TIMEOUT_MS,
      blockRedirects: true,
      jsonBody: buildForgetBody(),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (!response.ok) return { ok: false, reason: fetchFailureToCliError(response).message };
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, reason: `the router endpoint answered ${response.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
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

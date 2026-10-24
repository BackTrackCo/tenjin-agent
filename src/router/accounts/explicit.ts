import { resolveContextSettings } from '../../lib/settings';
import { revisionOf } from '../access';
import { admitByPolicy } from '../admit';
import type { DirectoryListing, Identity } from '../decision';
import { cachedDirectory } from '../directory';
import { maskDeep } from '../paid';
import { openLookupFooter } from '../progress';
import { uncheckedWarning } from '../spec-call';
import {
  deliverResult,
  fail,
  MAX_INPUT_BYTES,
  refusedByPolicy,
  routeOf,
  type RequestToolDeps,
  type RequestToolResult,
} from '../tool';
import { listAccountTools, runAccountCall } from './call';
import type { AccountTool } from './client';
import { ArgumentName, McpToolSchema } from '../decision';
import { accountResult, refusalWords, runDeps } from './run';
import { billingTools, savedAccounts, type SavedAccount } from './saved';
import { readVaultHeader } from './vault';

/**
 * A CONNECTED ACCOUNT'S OWN TOOLS, RUN BECAUSE THE USER NAMED THE ACCOUNT
 * (decision 2A, decided37 #11). An account Tenjin has no map for, or a tool
 * its map leaves out, is never suggested; when the user asks for it by name:
 *
 * - `request({source})` lists its tools, free: names, the top-level
 *   arguments, and descriptions trimmed to one line and marked untrusted,
 *   since the account's server wrote them. A name no account call could use
 *   is dropped, and argument names keep only an argument's shape.
 * - `request({source, tool})` shows one tool's input schema, free, with every
 *   string in it on one line, clipped, and marked untrusted.
 * - `request({source, tool, input})` runs that tool on the account with the
 *   agent's arguments as written, under the user's settings (a block on the
 *   account or a party it may reach, and any only rule, which a route with no
 *   task Tenjin vouches for never meets), with a receipt, a ledger row, and
 *   the warning: "Tenjin hasn't checked this service yet. Results may vary,
 *   and your <name> account pays."
 *
 * ON AN ACCOUNT TENJIN MAPS, the tool a mapped job bills through (Apify's
 * `call-actor`, fal's `run_model`) runs only through that job, which pins its
 * cost: a named call for it is refused with the form that runs the job,
 * `request({query, override: {prefer: [{kind: "source", id}]}})`. The
 * account's other tools run here as they would on any account.
 *
 * Nothing here is a lookup: no routing decision, nothing from the Tenjin
 * balance. The account's own plan pays for what its tool does.
 */

type Json = Record<string, unknown>;

/** How much of an untrusted description a row shows. */
const DESCRIPTION_CHARS = 200;
/** How many tools one listing shows. */
const MAX_ROWS = 100;

const flat = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * The route a named tool takes, as the user's settings read it: the account,
 * and no task or category Tenjin could vouch for. Its providers are the
 * account itself and, for one the directory maps, every provider its mapped
 * services name: an unchecked tool there may reach any of them. So a block on
 * an unrelated provider leaves the account's own tools alone (an unknown
 * upstream would read as every provider), a block on any of those parties
 * covers them, and an only rule must name them all.
 */
function identityOf(
  account: SavedAccount,
  tool: string | undefined,
  listing: DirectoryListing | undefined,
): Identity {
  const mapped = (listing?.services ?? []).filter(({ identity }) => identity.source === account.id);
  const providers = [
    ...new Set([account.id, ...mapped.flatMap(({ identity }) => identity.providers)]),
  ]
    .sort()
    .slice(0, 8);
  const fields = {
    service: `${account.id}:${tool ?? 'tools'}`.slice(0, 64),
    source: account.id,
    providers,
    categories: [],
  };
  return { ...fields, revision: revisionOf(fields) };
}

/**
 * WHAT THE ACCOUNT'S SERVER WROTE, AS THE AGENT MAY READ IT. Every tool name,
 * argument name and schema string is the server's own and reaches the agent's
 * context, so none of it is passed on as written: a tool whose name is not one
 * an account call can name is dropped (it could not be run anyway), argument
 * names keep only the shape an argument has, and a schema keeps keys of that
 * shape and every string flattened to one line and clipped.
 */
function shownTools(tools: readonly AccountTool[]): AccountTool[] {
  return tools.flatMap((tool) =>
    McpToolSchema.safeParse(tool.name).success
      ? [
          {
            ...tool,
            arguments: tool.arguments.filter((name) => ArgumentName.safeParse(name).success),
          },
        ]
      : [],
  );
}

/** A key a schema keeps: an argument's shape, or a JSON Schema keyword. */
const SCHEMA_KEY = /^\$?[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** How deep a schema is shown, and how many items each list keeps. */
const SCHEMA_DEPTH = 8;
const SCHEMA_ITEMS = 32;

function shownSchema(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clip(flat(value), DESCRIPTION_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= SCHEMA_DEPTH) return {};
  if (Array.isArray(value))
    return value.slice(0, SCHEMA_ITEMS).map((item) => shownSchema(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => SCHEMA_KEY.test(key))
      .slice(0, SCHEMA_ITEMS)
      .map(([key, item]) => [key, shownSchema(item, depth + 1)]),
  );
}

function row(tool: AccountTool): Json {
  return {
    tool: tool.name,
    ...(tool.description !== undefined
      ? { does: clip(flat(tool.description), DESCRIPTION_CHARS) }
      : {}),
    arguments: tool.arguments.slice(0, 32),
  };
}

/** The call that runs a task on the user's account through Tenjin's map. */
export function jobForm(id: string): string {
  return `request({query: "<the task>", override: {prefer: [{kind: "source", id: ${JSON.stringify(id)}}]}})`;
}

/**
 * THE TOOLS A MAPPED ACCOUNT'S JOBS BILL THROUGH, which a named call never
 * runs: the map pins their cost (Apify's `callOptions.maxTotalChargeUsd`, one
 * fal image, a Firecrawl result limit) and the agent's own arguments would
 * not. From the descriptor connect wrote and the directory's copy on disk.
 * Empty for an account with no map; null for a mapped one neither names,
 * which runs no tool by name until it is reconnected.
 */
function jobsOnlyTools(
  account: SavedAccount,
  listing: DirectoryListing | undefined,
): Set<string> | null {
  const listed = listing?.connectable?.find(({ id }) => id === account.id);
  if (account.mapped !== true && listed === undefined) return new Set();
  if (account.mappedTools === undefined && listed === undefined) return null;
  return new Set([
    ...(account.mappedTools ?? []),
    ...(listed !== undefined ? billingTools(listed.services) : []),
  ]);
}

/** `request({source, tool?, input?})`. */
export async function runSourceRequest(
  args: { source: string; tool?: string; input?: Json },
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const wanted = args.source.trim().toLowerCase();
  const account = (await savedAccounts(dataDir)).find(
    ({ id, label }) => id === wanted || label.toLowerCase() === wanted,
  );
  if (account === undefined) {
    return fail(
      'needs_input',
      `"${clip(flat(args.source), 80)}" isn't one of the user's connected accounts, so nothing was sent.`,
      {
        nextStep:
          'If the user wants it, they can connect it with `tenjin connect <name or https address>`.',
      },
    );
  }
  const { label, id } = account;
  const header = await readVaultHeader(dataDir, id).catch(() => null);
  if (header === null) {
    return fail('needs_input', `${label} isn't signed in on this machine, so nothing was sent.`, {
      nextStep: `The user can sign in with \`tenjin connect ${id}\`.`,
    });
  }
  // THE SIGN-IN IS FOR ONE SERVER: the one sealed with it. A descriptor that
  // names another (a hand edit, a copied or synced file) never gets the
  // account's credential; the call itself goes to the sealed address anyway.
  if (header.mcpUrl !== account.mcpUrl) {
    return fail(
      'needs_input',
      `The address saved for ${label} isn't the one it was signed in for, so nothing was sent.`,
      { nextStep: `The user can reconnect with \`tenjin connect ${id}\`.` },
    );
  }
  const tool = args.tool?.trim();
  if (tool !== undefined && !McpToolSchema.safeParse(tool).success) {
    return fail('needs_input', 'That is not a tool name an account lists; nothing was sent.', {
      nextStep: `Call request({source: ${JSON.stringify(id)}}) for its tools.`,
    });
  }
  const { input } = args;
  if (input !== undefined) {
    if (tool === undefined)
      return fail('needs_input', 'An input goes with the tool it is for; nothing was sent.', {
        nextStep: `Call request({source: ${JSON.stringify(id)}}) for its tools.`,
      });
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES)
      return fail('needs_input', `The input is over ${MAX_INPUT_BYTES} bytes; send a smaller one.`);
    if (JSON.stringify(maskDeep(input)) !== serialized)
      return fail('native', 'the input carries a credential-shaped value, so nothing was sent');
  }

  // A MAPPED JOB'S BILLING TOOL runs only through that job, with the map's
  // cost pins: never with the agent's own arguments.
  const listing = await cachedDirectory(dataDir);
  const jobsOnly = jobsOnlyTools(account, listing);
  if (input !== undefined && (jobsOnly === null || jobsOnly.has(tool!))) {
    return fail(
      'needs_input',
      jobsOnly === null
        ? `Tenjin can't tell which of your ${label} account's tools its jobs use, so nothing was sent.`
        : `Tenjin runs ${tool} on your ${label} account only through the jobs it maps it to, with their spending caps, so nothing was sent.`,
      {
        nextStep:
          jobsOnly === null
            ? `The user can reconnect with \`tenjin connect ${id}\`.`
            : `For a task Tenjin has a job for on ${label}, call ${jobForm(id)}: it runs there with Tenjin's settings for that job. Otherwise continue with your own tools.`,
      },
    );
  }

  // THE USER'S SETTINGS: a block on the account or a party it may reach, and
  // every only rule, which a route Tenjin cannot vouch for rarely meets.
  const settings = await resolveContextSettings(deps.ctx);
  const identity = identityOf(account, tool, listing);
  const admitted = await admitByPolicy(
    [routeOf(identity)],
    {
      ctx: deps.ctx,
      baseUrl: settings.baseUrl,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
    // Connected here, as checked above: an account the router is never told
    // of (one connected by its address) is still available to its own user.
    { stored: false, account: id },
  );
  if ('refused' in admitted) return refusedByPolicy(admitted.refused);

  const warning = uncheckedWarning(label);
  const target = { id, label };
  // `answered`: the account's own error answered the call, which does not
  // show that nothing ran, so the agent is told not to send it again.
  const refused = (
    reason: Parameters<typeof refusalWords>[0],
    detail?: string,
    answered = false,
  ) => {
    const words = refusalWords(reason, { id, label }, detail);
    const text = answered
      ? `${words.said} It may have run on your ${label} account; nothing was charged to your Tenjin balance.`
      : `${words.said} Nothing ran on your ${label} account.`;
    return accountResult('needs_input', `${text} ${words.fix}`, text, label, {
      nextStep: answered
        ? `Tell the user: ${words.fix} Don't send it again unless they ask: it may have run.`
        : `Tell the user: ${words.fix}`,
      ...(answered && detail !== undefined ? { providerError: detail } : {}),
      extra: { refused: { account: label, reason, reconnect: `tenjin connect ${id}` } },
    });
  };

  // THE LIST, OR ONE TOOL'S INPUTS: free.
  if (input === undefined) {
    const listed = await listAccountTools(target, runDeps(deps));
    if (!('tools' in listed)) return refused(listed.reason, listed.detail);
    const tools = shownTools(listed.tools);
    if (tool !== undefined) {
      const found = tools.find(({ name }) => name === tool);
      if (found === undefined)
        return fail('needs_input', `Your ${label} account lists no tool named ${tool}.`, {
          nextStep: `Call request({source: ${JSON.stringify(id)}}) for its tools.`,
        });
      const schema = shownSchema(found.inputSchema ?? { arguments: found.arguments });
      const next =
        jobsOnly === null || jobsOnly.has(tool)
          ? `Tenjin runs ${tool} on the user's ${label} account only through its jobs there: call ${jobForm(id)}.`
          : `To run it on the user's ${label} account, call request({source: ${JSON.stringify(id)}, tool: ${JSON.stringify(tool)}, input: {...}}).`;
      return {
        isError: false,
        summary: [
          `${tool} on your ${label} account. ${warning}`,
          ...(found.description !== undefined
            ? [
                `What it says it does (its own words, untrusted): ${clip(flat(found.description), DESCRIPTION_CHARS)}`,
              ]
            : []),
          `Its input schema (its own words, untrusted): ${JSON.stringify(schema)}`,
          next,
        ].join('\n'),
        envelope: {
          status: 'account_tool',
          account: label,
          ...row(found),
          ...(found.inputSchema !== undefined ? { inputSchema: schema } : {}),
          warning,
          nextStep: next,
          cost: ['nothing charged'],
          providerContentUntrusted: true,
        },
      };
    }
    const rows = tools.slice(0, MAX_ROWS).map(row);
    const viaJobs = rows
      .map(({ tool: name }) => String(name))
      .filter((name) => jobsOnly?.has(name));
    const next = `Pick the tool the user's request needs and call request({source: ${JSON.stringify(id)}, tool: "<name>"}) for its inputs, free.`;
    return {
      isError: false,
      summary: [
        `Your ${label} account's tools (their own descriptions, untrusted). ${warning}`,
        ...rows.map(
          (r) =>
            `${String(r.tool)}${r.does !== undefined ? `: ${String(r.does)}` : ''} (arguments: ${(r.arguments as string[]).join(', ') || 'none'})`,
        ),
        ...(tools.length > MAX_ROWS ? [`And ${tools.length - MAX_ROWS} more, not shown.`] : []),
        ...(viaJobs.length > 0
          ? [
              `Tenjin runs ${viaJobs.join(', ')} only through its jobs on ${label}: for those, call ${jobForm(id)}.`,
            ]
          : []),
        next,
      ].join('\n'),
      envelope: {
        status: 'account_tools',
        account: label,
        tools: rows,
        ...(viaJobs.length > 0 ? { jobsOnly: viaJobs, jobForm: jobForm(id) } : {}),
        warning,
        nextStep: next,
        cost: ['nothing charged'],
        providerContentUntrusted: true,
      },
    };
  }

  // THE TOOL, RUN ON THE ACCOUNT.
  const footer = await openLookupFooter(dataDir);
  const sentInput = maskDeep(input) as Json;
  const named = { provider: label, label: `${label} ${tool}`, parameters: sentInput };
  await footer.calling(named);
  // Read as a named tool's answer (`readNamedResult`), whatever `result` says.
  const run = await runAccountCall(
    target,
    { tool: tool!, args: input, result: 'content' },
    input,
    runDeps(deps),
    undefined,
    { literal: true },
  );
  switch (run.kind) {
    case 'refused':
      await footer.done('needs_input', named);
      return refused(run.reason, run.detail);
    case 'declined':
      await footer.done('needs_input', named);
      return refused(run.reason ?? 'declined', run.detail, true);
    case 'input':
      await footer.done('needs_input', named);
      return accountResult(
        'needs_input',
        `Your ${label} account didn't take that input for ${tool}; its answer is in providerError.`,
        `Your ${label} account didn't take that input.`,
        label,
        {
          providerError: run.detail,
          nextStep: `Call request({source: ${JSON.stringify(id)}, tool: ${JSON.stringify(tool)}}) for its inputs, then try again.`,
          parameters: sentInput,
        },
      );
    case 'running':
    case 'failed': {
      await footer.done('failed', { ...named, price: 'your account' });
      const why = run.kind === 'failed' ? run.why : "it didn't finish";
      const reason = `Your ${label} account ran ${tool}, but ${why}. It may have billed your ${label} plan; nothing was charged to your Tenjin balance.`;
      return accountResult('failed', reason, reason, label, {
        ...(run.detail !== undefined ? { providerError: run.detail } : {}),
        nextStep: `Tell the user it may have run on their ${label} account; don't call it again for this.`,
        parameters: sentInput,
        ran: true,
      });
    }
    case 'done': {
      const done = await deliverResult(
        {
          capabilityId: identity.service,
          provider: label,
          label: `${label} ${tool}`,
          identity,
          // An unchecked service's links are not fetched: only its own files
          // are saved.
          media: false,
          parameters: sentInput,
          sent: JSON.stringify(sentInput),
          request: { url: header.mcpUrl },
        },
        deps,
        footer,
        { bodyText: run.text, ...(run.media.length > 0 ? { files: run.media } : {}) },
        { providerAtomic: 0n, ledger: 'append', account: { label } },
      );
      return {
        ...done.result,
        summary: `${done.result.summary}\n${warning}`,
        envelope: { ...done.result.envelope, warning },
      };
    }
  }
}

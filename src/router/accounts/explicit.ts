import { McpToolSchema } from '../decision';
import { cachedIdentities, type Identities } from '../identities';
import { appendPaidRecord, maskDeep } from '../paid';
import { openLookupFooter } from '../progress';
import { personalSettingsAt, type PersonalSettings } from '../settings';
import { uncheckedWarning } from '../spec-call';
import {
  deliverResult,
  fail,
  MAX_INPUT_BYTES,
  paidRecord,
  type DeliverCall,
  type RequestToolDeps,
  type RequestToolResult,
} from '../tool';
import { listAccountTools, runAccountCall } from './call';
import type { AccountTool } from './client';
import { accountResult, refusalWords, runDeps, type StopReason } from './run';
import { savedAccounts, type SavedAccount } from './saved';
import { readVaultHeader } from './vault';

/**
 * A CONNECTED ACCOUNT'S OWN TOOLS, RUN BECAUSE THE USER NAMED THE ACCOUNT
 * (plan 37). An account Tenjin has no map for, or a tool its map leaves out,
 * is never suggested; when the user asks for it by name:
 *
 * - `request({source})` lists its tools, free: names, the top-level
 *   arguments, and descriptions trimmed to one line and marked untrusted,
 *   since the account's server wrote them. A name no account call could use
 *   is dropped, and argument names keep only an argument's shape.
 * - `request({source, tool})` shows one tool's input schema, free, with every
 *   string in it on one line, clipped, and marked untrusted.
 * - `request({source, tool, input})` runs that tool on the account with the
 *   agent's arguments as written, with a receipt, a ledger row, and the
 *   warning: "Tenjin hasn't checked this service yet. Results may vary, and
 *   your <name> account pays."
 *
 * THE AGENT IS ASKING BY NAME, so the user's rules, which govern only what
 * Tenjin picks on its own, never stop it: a block on this very account
 * included. It only refuses while the saved rules can't be read. Pausing
 * Tenjin stops it too, before anything here runs.
 *
 * THE STOP FOR A NAMED ACCOUNT IS `tenjin disconnect <id>`, which every
 * result here names as `stop`. A block can't be the one: it stops only
 * Tenjin's own picks, and `config block --source` resolves names against the
 * router's identities read, which never lists an account connected by its
 * address.
 *
 * ON AN ACCOUNT TENJIN MAPS, every tool its maps call (Apify's `call-actor`,
 * fal's `run_model`) runs only through a mapped job, which pins its cost: a
 * named call for it is refused with the job's own `request({tool})`. The
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
 * WHAT THE ACCOUNT'S SERVER WROTE, AS THE AGENT MAY READ IT. Every tool name,
 * argument name and schema string is the server's own and reaches the agent's
 * context, so none of it is passed on as written: a tool whose name is not one
 * an account call can name is dropped (it could not be run anyway), argument
 * names keep only the shape an argument has, and a schema keeps keys of that
 * shape and every string flattened to one line and clipped.
 */
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function shownTools(tools: readonly AccountTool[]): AccountTool[] {
  return tools.flatMap((tool) =>
    McpToolSchema.safeParse(tool.name).success
      ? [{ ...tool, arguments: tool.arguments.filter((name) => ARGUMENT_NAME.test(name)) }]
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

/** One tool as a listing shows it. */
interface ToolRow {
  tool: string;
  does?: string;
  arguments: string[];
}

function row(tool: AccountTool): ToolRow {
  return {
    tool: tool.name,
    ...(tool.description !== undefined
      ? { does: clip(flat(tool.description), DESCRIPTION_CHARS) }
      : {}),
    arguments: tool.arguments.slice(0, 32),
  };
}

/** The jobs Tenjin maps on this account, by their service ids, from the
 *  identities read kept on disk: `<account>.<key>` sold by the account. */
function mappedJobs(account: SavedAccount, identities: Identities | undefined): string[] {
  return (identities?.services ?? [])
    .filter(({ id, seller }) => seller === account.id && id.startsWith(`${account.id}.`))
    .map(({ id }) => id);
}

/** The call that runs a task on the user's account through Tenjin's map. */
export function jobForm(jobs: readonly string[]): string {
  return jobs.length > 0
    ? `request({tool: "<one of ${jobs.map((job) => JSON.stringify(job)).join(', ')}>"}) for its spec, then request({id, input})`
    : 'request({query}) naming the task';
}

/**
 * THE TOOLS A MAPPED ACCOUNT'S JOBS CALL, which a named call never runs: the
 * map pins their cost (Apify's `callOptions.maxTotalChargeUsd`, one fal
 * image, a Firecrawl result limit) and the agent's own arguments would not.
 * From the descriptor connect wrote and the identities read kept on disk.
 * Empty for an account with no map; null for a mapped one neither names,
 * which runs no tool by name until it is reconnected.
 */
function jobsOnlyTools(
  account: SavedAccount,
  identities: Identities | undefined,
): Set<string> | null {
  const listed = identities?.sources.find(({ id }) => id === account.id)?.connectable;
  if (account.mapped !== true && listed === undefined) return new Set();
  if (account.mappedTools === undefined && listed === undefined) return null;
  return new Set([...(account.mappedTools ?? []), ...(listed?.expectTools ?? [])]);
}

/** Why the saved settings stop a named call, or null: only rules that can't
 *  be read (the check before every call's own test, `settings-check.ts`),
 *  never a rule, since the agent is asking by name. */
async function settingsStop(dataDir: string): Promise<string | null> {
  let now: PersonalSettings;
  try {
    now = await personalSettingsAt(dataDir);
  } catch (err) {
    return `your Tenjin settings can't be read (${err instanceof Error ? err.message : String(err)})`;
  }
  return now.wire.status === 'invalid'
    ? `your Tenjin settings can't be read (${now.wire.problem})`
    : null;
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
  if (args.input !== undefined && tool === undefined)
    return fail('needs_input', 'An input goes with the tool it is for; nothing was sent.', {
      nextStep: `Call request({source: ${JSON.stringify(id)}}) for its tools.`,
    });
  // THE TOOL TO RUN, with its input. With no input nothing runs: the
  // account's tools are listed, or one tool's inputs shown, free.
  const toRun =
    tool !== undefined && args.input !== undefined ? { tool, input: args.input } : undefined;
  if (toRun !== undefined) {
    const serialized = JSON.stringify(toRun.input);
    if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES)
      return fail('needs_input', `The input is over ${MAX_INPUT_BYTES} bytes; send a smaller one.`);
    if (JSON.stringify(maskDeep(toRun.input)) !== serialized)
      return fail('native', 'the input carries a credential-shaped value, so nothing was sent');
  }

  // A MAPPED JOB'S TOOLS run only through that job, with the map's cost
  // pins: never with the agent's own arguments.
  const identities = await cachedIdentities(dataDir);
  const jobs = mappedJobs(account, identities);
  const jobsOnly = jobsOnlyTools(account, identities);
  if (toRun !== undefined && (jobsOnly === null || jobsOnly.has(toRun.tool))) {
    return fail(
      'needs_input',
      jobsOnly === null
        ? `Tenjin can't tell which of your ${label} account's tools its jobs use, so nothing was sent.`
        : `Tenjin runs ${toRun.tool} on your ${label} account only through the jobs it maps it to, with their spending caps, so nothing was sent.`,
      {
        nextStep:
          jobsOnly === null
            ? `The user can reconnect with \`tenjin connect ${id}\`.`
            : `For a task Tenjin has a job for on ${label}, call ${jobForm(jobs)}: it runs there with Tenjin's settings for that job. Otherwise continue with your own tools.`,
      },
    );
  }

  // THE USER'S SETTINGS: only rules that can't be read stop a named call.
  const stop = await settingsStop(dataDir);
  if (stop !== null) {
    return fail('needs_input', `${stop}, so nothing was sent to it.`, {
      nextStep:
        "Tell the user which setting stopped it; they can change it with `tenjin config`. Don't change it yourself.",
    });
  }

  const warning = uncheckedWarning(label);
  const target = { id, label };
  // `answered`: the account's own error answered the call, which does not
  // show that nothing ran, so the agent is told not to send it again.
  const refused = (reason: StopReason, detail?: string, answered = false) => {
    const words = refusalWords(reason, { id, label }, detail);
    const text = answered
      ? `${words.said} It may have run on your ${label} account; nothing was charged to your Tenjin balance.`
      : `${words.said} Nothing ran on your ${label} account.`;
    return accountResult('needs_input', `${text} ${words.fix}`, text, label, {
      nextStep: answered
        ? `Tell the user: ${words.fix} Don't send it again unless they ask: it may have run.`
        : `Tell the user: ${words.fix}`,
      ...(answered && detail !== undefined ? { providerError: detail } : {}),
      ...(answered ? { ran: 'maybe' as const } : {}),
      extra: { refused: { account: label, reason, reconnect: `tenjin connect ${id}` } },
    });
  };

  // THE LIST, OR ONE TOOL'S INPUTS: free.
  if (toRun === undefined) {
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
          ? `Tenjin runs ${tool} on the user's ${label} account only through its jobs there: call ${jobForm(jobs)}.`
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
          stop: `tenjin disconnect ${id}`,
          nextStep: next,
          cost: ['nothing charged'],
          providerContentUntrusted: true,
        },
      };
    }
    const rows = tools.slice(0, MAX_ROWS).map(row);
    const viaJobs = rows.map(({ tool: name }) => name).filter((name) => jobsOnly?.has(name));
    const next = `Pick the tool the user's request needs and call request({source: ${JSON.stringify(id)}, tool: "<name>"}) for its inputs, free.`;
    return {
      isError: false,
      summary: [
        `Your ${label} account's tools (their own descriptions, untrusted). ${warning}`,
        ...rows.map(
          (r) =>
            `${r.tool}${r.does !== undefined ? `: ${r.does}` : ''} (arguments: ${r.arguments.join(', ') || 'none'})`,
        ),
        ...(tools.length > MAX_ROWS ? [`And ${tools.length - MAX_ROWS} more, not shown.`] : []),
        ...(viaJobs.length > 0
          ? [
              `Tenjin runs ${viaJobs.join(', ')} only through its jobs on ${label}: for those, call ${jobForm(jobs)}.`,
            ]
          : []),
        next,
      ].join('\n'),
      envelope: {
        status: 'account_tools',
        account: label,
        tools: rows,
        ...(viaJobs.length > 0 ? { jobsOnly: viaJobs, jobForm: jobForm(jobs) } : {}),
        warning,
        stop: `tenjin disconnect ${id}`,
        nextStep: next,
        cost: ['nothing charged'],
        providerContentUntrusted: true,
      },
    };
  }

  // THE TOOL, RUN ON THE ACCOUNT.
  const footer = await openLookupFooter(dataDir);
  const sentInput = maskDeep(toRun.input) as Json;
  const named = { provider: label, label: `${label} ${toRun.tool}`, parameters: sentInput };
  const call: DeliverCall = {
    capabilityId: `${id}:${toRun.tool}`.slice(0, 200),
    provider: label,
    label: `${label} ${toRun.tool}`,
    // An unchecked service's links are not fetched: only its own files are
    // saved.
    media: false,
    parameters: sentInput,
    sent: JSON.stringify(sentInput),
    request: { url: header.mcpUrl },
  };
  // A call that reached the account and may have billed it, with no result:
  // on the ledger all the same, so usage and payments show it as may have
  // charged.
  const keepRow = () =>
    appendPaidRecord(dataDir, {
      ...paidRecord(call, call.request.url, call.sent, 0n, {
        savedFiles: [],
        account: id,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
      charge: 'unknown',
    });
  await footer.calling(named);
  // Read as a named tool's answer (`readNamedResult`), whatever `result` says.
  const run = await runAccountCall(
    target,
    { tool: toRun.tool, args: toRun.input, result: 'content' },
    toRun.input,
    runDeps(deps),
    undefined,
    { literal: true },
  );
  switch (run.kind) {
    case 'refused':
      await footer.done('needs_input', named);
      return refused(run.reason, run.detail);
    case 'declined':
      await keepRow();
      await footer.done('needs_input', named);
      return refused(run.reason ?? 'declined', run.detail, true);
    case 'input':
      await footer.done('needs_input', named);
      return accountResult(
        'needs_input',
        `Your ${label} account didn't take that input for ${toRun.tool}; its answer is in providerError.`,
        `Your ${label} account didn't take that input.`,
        label,
        {
          providerError: run.detail,
          nextStep: `Call request({source: ${JSON.stringify(id)}, tool: ${JSON.stringify(toRun.tool)}}) for its inputs, then try again.`,
          parameters: sentInput,
        },
      );
    case 'failed': {
      await keepRow();
      await footer.done('failed', { ...named, price: 'your account' });
      const reason = `Your ${label} account ran ${toRun.tool}, but ${run.why}. It may have billed your ${label} plan; nothing was charged to your Tenjin balance.`;
      return accountResult('failed', reason, reason, label, {
        ...(run.detail !== undefined ? { providerError: run.detail } : {}),
        nextStep: `Tell the user it may have run on their ${label} account; don't call it again for this.`,
        parameters: sentInput,
        ran: 'maybe',
      });
    }
    case 'done': {
      const done = await deliverResult(
        call,
        deps,
        footer,
        { bodyText: run.text, ...(run.media.length > 0 ? { files: run.media } : {}) },
        { providerAtomic: 0n, ledger: 'append', account: { label, source: id } },
      );
      return {
        ...done.result,
        summary: `${done.result.summary}\n${warning}`,
        envelope: { ...done.result.envelope, warning, stop: `tenjin disconnect ${id}` },
      };
    }
  }
}

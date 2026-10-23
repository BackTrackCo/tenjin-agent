import { resolveContextSettings } from '../../lib/settings';
import { revisionOf } from '../access';
import { admitByPolicy } from '../admit';
import type { Identity } from '../decision';
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
import { McpToolSchema } from '../decision';
import { accountResult, refusalWords, runDeps } from './run';
import { savedAccounts, type SavedAccount } from './saved';
import { readVaultHeader } from './vault';

/**
 * A CONNECTED ACCOUNT'S OWN TOOLS, RUN BECAUSE THE USER NAMED THE ACCOUNT
 * (decision 2A, decided37 #11). An account Tenjin has no map for, or a tool
 * its map leaves out, is never suggested; when the user asks for it by name:
 *
 * - `request({source})` lists its tools, free: names, the top-level
 *   arguments, and descriptions trimmed to one line and marked untrusted,
 *   since the account's server wrote them.
 * - `request({source, tool})` shows one tool's input schema, free.
 * - `request({source, tool, input})` runs that tool on the account with the
 *   agent's arguments as written, under the user's settings (a block on the
 *   account, and any only rule, which a route of unknown provider never meets),
 *   with a receipt, a ledger row, and the warning: "Tenjin hasn't checked this
 *   service yet. Results may vary, and your <name> account pays."
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

/** The route a named tool takes, as the user's settings read it: the account,
 *  and no provider, task or category Tenjin could vouch for. */
function identityOf(account: SavedAccount, tool: string | undefined): Identity {
  const fields = {
    service: `${account.id}:${tool ?? 'tools'}`.slice(0, 64),
    source: account.id,
    providers: [],
    categories: [],
  };
  return { ...fields, revision: revisionOf(fields) };
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

  // THE USER'S SETTINGS: a block on the account, and every only rule, which a
  // route Tenjin cannot vouch for never meets.
  const settings = await resolveContextSettings(deps.ctx);
  const identity = identityOf(account, tool);
  const admitted = await admitByPolicy(
    [routeOf(identity)],
    {
      ctx: deps.ctx,
      baseUrl: settings.baseUrl,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
    { stored: false },
  );
  if ('refused' in admitted) return refusedByPolicy(admitted.refused);

  const warning = uncheckedWarning(label);
  const target = { id, label };
  const refused = (reason: Parameters<typeof refusalWords>[0], detail?: string) => {
    const words = refusalWords(reason, { id, label }, detail);
    const text = `${words.said} Nothing ran on your ${label} account.`;
    return accountResult('needs_input', `${text} ${words.fix}`, text, label, {
      nextStep: `Tell the user: ${words.fix}`,
      ...(reason === 'declined' && detail !== undefined ? { providerError: detail } : {}),
      extra: { refused: { account: label, reason, reconnect: `tenjin connect ${id}` } },
    });
  };

  // THE LIST, OR ONE TOOL'S INPUTS: free.
  if (input === undefined) {
    const listed = await listAccountTools(target, runDeps(deps));
    if (!('tools' in listed)) return refused(listed.reason, listed.detail);
    if (tool !== undefined) {
      const found = listed.tools.find(({ name }) => name === tool);
      if (found === undefined)
        return fail('needs_input', `Your ${label} account lists no tool named ${tool}.`, {
          nextStep: `Call request({source: ${JSON.stringify(id)}}) for its tools.`,
        });
      const next = `To run it on the user's ${label} account, call request({source: ${JSON.stringify(id)}, tool: ${JSON.stringify(tool)}, input: {...}}).`;
      return {
        isError: false,
        summary: [
          `${tool} on your ${label} account. ${warning}`,
          ...(found.description !== undefined
            ? [
                `What it says it does (its own words, untrusted): ${clip(flat(found.description), DESCRIPTION_CHARS)}`,
              ]
            : []),
          `Its input schema: ${JSON.stringify(found.inputSchema ?? { arguments: found.arguments })}`,
          next,
        ].join('\n'),
        envelope: {
          status: 'account_tool',
          account: label,
          ...row(found),
          ...(found.inputSchema !== undefined ? { inputSchema: found.inputSchema } : {}),
          warning,
          nextStep: next,
          cost: ['nothing charged'],
          providerContentUntrusted: true,
        },
      };
    }
    const rows = listed.tools.slice(0, MAX_ROWS).map(row);
    const next = `Pick the tool the user's request needs and call request({source: ${JSON.stringify(id)}, tool: "<name>"}) for its inputs, free.`;
    return {
      isError: false,
      summary: [
        `Your ${label} account's tools (their own descriptions, untrusted). ${warning}`,
        ...rows.map(
          (r) =>
            `${String(r.tool)}${r.does !== undefined ? `: ${String(r.does)}` : ''} (arguments: ${(r.arguments as string[]).join(', ') || 'none'})`,
        ),
        ...(listed.tools.length > MAX_ROWS
          ? [`And ${listed.tools.length - MAX_ROWS} more, not shown.`]
          : []),
        next,
      ].join('\n'),
      envelope: {
        status: 'account_tools',
        account: label,
        tools: rows,
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
      return refused('declined', run.detail);
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

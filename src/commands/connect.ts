import { CliError } from '../lib/errors';
import {
  loadRawConfig,
  readPersonalRouter,
  resolveSettings,
  SavedPolicySchema,
  SavedPolicyShapeSchema,
  type PartialConfig,
  type SourceDescriptor,
} from '../lib/config';
import { emitWriteNotice } from '../lib/output';
import { openInBrowser } from '../lib/open-url';
import { defaultExecFor, hiddenPrompt, type ExecFn, type PromptFn } from '../lib/os-store';
import { sourceKeyFilePath } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';
import { normalizeForWire, POLICY_VERSION, scopeKey, type SavedPolicy } from '../router/access';
import {
  isAccountUrl,
  WirePolicySchema,
  type Connectable,
  type DirectoryListing,
  type KeyScheme,
  type PreferRule,
  type Target,
} from '../router/decision';
import { cachedDirectory, fetchDirectory } from '../router/directory';
import { accountIdForUrl, isAccountId } from '../router/accounts/ids';
import { billingTools, savedAccountOf, type SavedAccount } from '../router/accounts/saved';
import {
  AccountRefused,
  openAccountSession,
  type AccountSession,
  type AccountTool,
  type OpenAccountSession,
} from '../router/accounts/client';
import { revokeSignIn, signIn, type SignedIn, type SignInDeps } from '../router/accounts/oauth';
import {
  deleteVault,
  readVault,
  readVaultHeader,
  writeVault,
  type VaultSecret,
} from '../router/accounts/vault';
import { answer } from './config-rules';
import { blockedBy, describePrefer } from './config-readback';
import { persist } from './config';

/**
 * `tenjin connect <name | url>` and `tenjin disconnect <name>`: THE USER'S OWN
 * ACCOUNTS (tenjin-notes#37). Connecting is configuration: where the
 * account's MCP server is and a credential for it. The account then becomes
 * eligible for the jobs Tenjin has mapped to it, and comes first only through
 * the one visible preference connecting writes, which the user can undo.
 *
 * What happens, in order, and what each step leaves behind:
 *
 * 1. NAME. A name resolves against the accounts the router's directory lists
 *    as connectable; an https address that is none of them is connected as
 *    itself, unmapped, so Tenjin runs it only when the user names it.
 * 2. SIGN-IN. In the browser (the MCP sign-in, `accounts/oauth.ts`), or with a
 *    key typed at a hidden prompt (`--paste`) or read once from the
 *    environment (`--from-env`). A key never goes through the agent's chat.
 * 3. A FREE CHECK. Tenjin lists the account's tools, and each mapped service
 *    whose tool or arguments this account lacks is left out on this machine.
 *    A pasted fal key is checked with fal's own free account tool, since fal
 *    takes any well-formed key until a real call.
 * 4. SAVE. The sign-in, sealed, in this machine's vault (`accounts/vault.ts`);
 *    then, through the one locked config writer, the account's descriptor
 *    (`router.sources`, no credential) and the account-wide preference. An
 *    existing preference is extended, never replaced, and a block wins.
 *
 * Nothing is saved until every earlier step has passed. Disconnect signs out
 * where the account's authorization server lets a client, deletes the
 * sign-in here, and removes the account from every preference; other
 * settings and accounts stay.
 */

export interface ConnectFlags {
  paste?: boolean;
  fromEnv?: string;
  /** `--no-prefer`: connect without the account-wide preference. */
  prefer?: boolean;
}

/** Every seam: tests pass all of them, so no real keychain, browser or network is touched. */
export interface ConnectDeps {
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<boolean>;
  prompt?: PromptFn;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  openSession?: OpenAccountSession;
  /** How long a browser sign-in may wait for the approval. */
  waitMs?: number;
  /** The redirect's ports; tests pass `[0]`. */
  ports?: readonly number[];
  clientMetadataUrl?: string;
  now?: () => number;
  cwd?: string;
}

/** How long `tenjin connect` waits for the browser: inside the five minutes
 *  the server instructions ask a harness to give the command. */
export const SIGN_IN_WAIT_MS = 280_000;

/** The most accounts the settings file holds. */
const MAX_ACCOUNTS = 16;

/**
 * Where an account's own free tool can tell a key that works from one that
 * only looks right. fal takes any well-formed key until a real call; data in
 * the directory cannot say this, so it is code (decided37 #5).
 */
const ACCOUNT_CHECKS: Record<string, { tool: string; args: Record<string, unknown> }> = {
  fal: { tool: 'check_account_status', args: {} },
};

/** Accounts whose sign-in grants the whole account: the readback says so. */
const WHOLE_ACCOUNT = new Set(['apify']);

/** What a saved account descriptor holds: never a credential. */
type Descriptor = SavedAccount;

/** The account being connected. `services` is empty for an unmapped one. */
interface Account {
  id: string;
  label: string;
  mcpUrl: string;
  signIn: Connectable['signIn'];
  keyScheme: KeyScheme;
  services: Connectable['services'];
  mapped: boolean;
}

function usage(message: string, fix?: string, details?: unknown): never {
  throw new CliError('USAGE', message, {
    ...(fix !== undefined ? { fix } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

const looksLikeUrl = (text: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
const folded = (text: string) => text.trim().toLowerCase();

async function baseUrlOf(ctx: CommandContext): Promise<string> {
  const config = await loadRawConfig(ctx.dataDir);
  return resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env })
    .baseUrl.value;
}

/** The saved descriptors, or a refusal when the saved list can't be read. */
function savedAccounts(config: PartialConfig): SourceDescriptor[] {
  const sources = readPersonalRouter(config.router).sources;
  if (sources.status === 'invalid') {
    throw new CliError(
      'CONFIG_INVALID',
      `Your saved accounts can't be read (${sources.problem}), so nothing was changed.`,
      { fix: 'Fix or remove router.sources in your Tenjin config, then run the command again.' },
    );
  }
  return sources.saved;
}

const descriptorOf = (saved: SourceDescriptor): Descriptor | undefined => savedAccountOf(saved);

/** The account a name or address means, from the router's directory. */
function resolveAccount(
  target: string,
  listing: DirectoryListing,
  saved: readonly Descriptor[],
): Account {
  const connectable = listing.connectable ?? [];
  const fromDirectory = (account: Connectable): Account => ({
    id: account.id,
    label: account.label,
    mcpUrl: account.mcpUrl,
    signIn: account.signIn,
    keyScheme: account.key?.scheme ?? 'Bearer',
    services: account.services,
    mapped: true,
  });
  if (looksLikeUrl(target)) {
    if (!isAccountUrl(target)) {
      usage(
        'Connect takes an https address with no user name, password, query or fragment. Nothing was saved.',
        'tenjin connect https://mcp.example.com/mcp',
      );
    }
    const url = new URL(target);
    const known = connectable.find((account) => new URL(account.mcpUrl).href === url.href);
    if (known !== undefined) return fromDirectory(known);
    const id = accountIdForUrl(url);
    const taken = new Set([...listing.sources.map((s) => s.id), ...connectable.map((a) => a.id)]);
    const savedHere = saved.find((account) => account.id === id);
    if (taken.has(id) || (savedHere !== undefined && new URL(savedHere.mcpUrl).href !== url.href)) {
      throw new CliError(
        'REFUSED',
        `Another account is already connected as ${url.hostname}, so this address wasn't connected.`,
        { fix: `Disconnect it first with \`tenjin disconnect ${id}\`, then connect this address.` },
      );
    }
    return {
      id,
      label: url.hostname,
      mcpUrl: url.href,
      signIn: ['oauth', 'key'],
      keyScheme: 'Bearer',
      services: [],
      mapped: false,
    };
  }
  const wanted = folded(target);
  const named = connectable.find(
    (account) => account.id === wanted || folded(account.label) === wanted,
  );
  if (named !== undefined) return fromDirectory(named);
  const own = saved.find((account) => account.id === wanted || folded(account.label) === wanted);
  if (own !== undefined) {
    return {
      id: own.id,
      label: own.label,
      mcpUrl: own.mcpUrl,
      signIn: ['oauth', 'key'],
      keyScheme: own.keyScheme ?? 'Bearer',
      services: [],
      mapped: false,
    };
  }
  const known = connectable.map(({ label }) => label);
  usage(
    `Tenjin doesn't know an account called "${target}". Nothing was saved.`,
    known.length > 0
      ? `Tenjin can connect ${new Intl.ListFormat('en', { type: 'disjunction' }).format(known)}, or any MCP server by its https address.`
      : 'Connect an MCP server by its https address: tenjin connect https://mcp.example.com/mcp',
    { name: target, connectable: connectable.map(({ id, label }) => ({ id, label })) },
  );
}

/** A key as a header carries it: printable, no spaces, `id:secret` for `Key`. */
function checkedKey(raw: string, account: Account): string {
  const key = raw.trim();
  if (key.length === 0) usage('No key was given, so nothing was saved.');
  if (key.length > 4_096 || !/^[\x21-\x7e]+$/.test(key))
    usage(
      `That doesn't look like a ${account.label} key: it has spaces or characters a key doesn't. Nothing was saved.`,
    );
  if (account.keyScheme === 'Key' && !/^[^:]+:[^:]+$/.test(key))
    usage(`A ${account.label} key is written key_id:key_secret. Nothing was saved.`);
  return key;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The key `--paste` or `--from-env` gives, never echoed. */
async function keyFrom(flags: ConnectFlags, account: Account, deps: ConnectDeps): Promise<string> {
  if (!account.signIn.includes('key')) {
    usage(
      `${account.label} connects with its own sign-in, not a key. Nothing was saved.`,
      `tenjin connect ${account.id}`,
    );
  }
  if (flags.fromEnv !== undefined) {
    if (!ENV_NAME.test(flags.fromEnv))
      usage(`--from-env takes the name of an environment variable; got "${flags.fromEnv}".`);
    const value = (deps.env ?? process.env)[flags.fromEnv];
    if (value === undefined || value.trim().length === 0)
      usage(`${flags.fromEnv} is not set here, so nothing was saved.`);
    return checkedKey(value, account);
  }
  const terminal = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!terminal) {
    throw new CliError(
      'REFUSED',
      '--paste reads the key at a hidden prompt, which needs a terminal. Nothing was saved.',
      {
        fix: `Ask the user to run \`tenjin connect ${account.id} --paste\` in their own terminal. Never ask for a key in chat.`,
      },
    );
  }
  const prompt =
    deps.prompt ??
    hiddenPrompt(
      () =>
        new CliError('USAGE', 'Key entry was cancelled, so nothing was saved.', {
          fix: `Run \`tenjin connect ${account.id} --paste\` again.`,
        }),
    );
  const label =
    account.keyScheme === 'Key'
      ? `Paste your ${account.label} key as key_id:key_secret (it won't show): `
      : `Paste your ${account.label} API key (it won't show): `;
  return checkedKey(await prompt(label), account);
}

/** Which mapped services this account can run: each of their tools listed,
 *  with every argument their call sends. */
export function readyServices(
  tools: readonly AccountTool[],
  services: Connectable['services'],
): { ready: string[]; missing: string[] } {
  const byName = new Map(tools.map((tool) => [tool.name, new Set(tool.arguments)]));
  const ready: string[] = [];
  const missing: string[] = [];
  for (const service of services) {
    const fits = service.tools.every(({ name, arguments: args }) => {
      const has = byName.get(name);
      return has !== undefined && args.every((arg) => has.has(arg));
    });
    (fits ? ready : missing).push(service.id);
  }
  return { ready, missing };
}

/** The free check, on the credential about to be saved. */
async function checkAccount(
  account: Account,
  headers: Record<string, string>,
  byKey: boolean,
  deps: ConnectDeps,
): Promise<{ ready: string[]; missing: string[] }> {
  const open = deps.openSession ?? openAccountSession;
  const refused = () =>
    new CliError(
      'REFUSED',
      byKey
        ? `${account.label} didn't accept that key, so nothing was saved.`
        : `${account.label} didn't accept the sign-in, so nothing was saved.`,
      { fix: `Check it and run \`tenjin connect ${account.id}${byKey ? ' --paste' : ''}\` again.` },
    );
  let session: AccountSession | undefined;
  try {
    session = await open(account.mcpUrl, headers, {
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const tools = await session.listTools();
    const check = byKey ? ACCOUNT_CHECKS[account.id] : undefined;
    if (check !== undefined) {
      // FAIL CLOSED: a key this account's own tool can't vouch for is not saved.
      if (!tools.some(({ name }) => name === check.tool)) throw refused();
      const result = await session.callTool(check.tool, check.args);
      if (result.isError === true) throw refused();
    }
    return readyServices(tools, account.services);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err instanceof AccountRefused) throw refused();
    throw new CliError(
      'NETWORK_ERROR',
      `Tenjin couldn't list ${account.label}'s tools, so nothing was saved.`,
      { fix: 'Check the network, then run the command again.' },
    );
  } finally {
    await session?.close().catch(() => undefined);
  }
}

type PreferenceOutcome = 'added' | 'kept' | 'skipped' | 'blocked' | 'full' | 'unreadable';

/**
 * The account-wide preference, extended by this account: kept when it is
 * already there, never written over a block, an unreadable policy or a full
 * list. Returns the next config and what happened.
 */
function withPreference(
  existing: PartialConfig,
  id: string,
  listing: DirectoryListing,
): { next: PartialConfig; outcome: PreferenceOutcome; rule?: PreferRule; policy?: SavedPolicy } {
  const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
  const raw = router.policy;
  const parsed =
    raw === undefined
      ? { success: true as const, data: { version: POLICY_VERSION } }
      : SavedPolicySchema.safeParse(raw);
  if (!parsed.success) return { next: existing, outcome: 'unreadable' };
  const policy: SavedPolicy = parsed.data;
  const target: Target = { kind: 'source', id };
  if (blockedBy(target, policy, listing) !== undefined)
    return { next: existing, outcome: 'blocked' };
  const prefer = policy.prefer ?? [];
  const global = prefer.find(({ scope }) => scopeKey(scope) === 'global');
  if (global?.targets.some((t) => t.kind === 'source' && t.id === id))
    return { next: existing, outcome: 'kept', rule: global, policy };
  if (global !== undefined && global.targets.length >= 16)
    return { next: existing, outcome: 'full' };
  const rule: PreferRule =
    global !== undefined
      ? { ...global, targets: [...global.targets, target] }
      : { scope: { kind: 'global' }, targets: [target] };
  const after: SavedPolicy = {
    ...policy,
    prefer:
      global !== undefined
        ? prefer.map((entry) => (entry === global ? rule : entry))
        : [...prefer, rule],
  };
  const wire = normalizeForWire(after);
  if (wire !== undefined && !WirePolicySchema.safeParse(wire).success)
    return { next: existing, outcome: 'full' };
  return {
    next: { ...existing, router: { ...router, policy: after } },
    outcome: 'added',
    rule,
    policy: after,
  };
}

/** The descriptor list with this account's entry put in place of any old one.
 *  A choice the user made about the account (what happens when it refuses)
 *  stays across a reconnect. */
function withDescriptor(existing: PartialConfig, descriptor: Descriptor): PartialConfig {
  const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
  const saved = Array.isArray(router.sources) ? (router.sources as SourceDescriptor[]) : [];
  const before = savedAccountOf(saved.find((entry) => entry.id === descriptor.id));
  const others = saved.filter((entry) => entry.id !== descriptor.id);
  const kept = before?.onRefusal !== undefined ? { onRefusal: before.onRefusal } : {};
  return { ...existing, router: { ...router, sources: [...others, { ...descriptor, ...kept }] } };
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** The jobs a set of services does, by task, each once, in order. */
function tasksOf(ids: readonly string[], listing: DirectoryListing): string[] {
  const task = new Map(listing.services.map(({ id, identity }) => [id, identity.task]));
  return [...new Set(ids.flatMap((id) => (task.get(id) !== undefined ? [task.get(id)!] : [])))];
}

/** What a connect says, in the user's words: no ids, no protocol terms. */
function connectLines(
  account: Account,
  listing: DirectoryListing,
  checked: { ready: string[]; missing: string[] },
  preference: PreferenceOutcome,
  byKey: boolean,
): string[] {
  const { label } = account;
  if (!account.mapped) {
    return [
      `Connected ${label} on this machine. Tenjin doesn't know this service's jobs yet, so it won't pick it on its own. Ask for it by name and Tenjin will run it.`,
      `Calls on your ${label} account are billed to your own plan, not counted in the limit on your Tenjin balance.`,
      'Nothing about this service was sent to Tenjin.',
    ];
  }
  const verified = new Set(account.services.filter((s) => s.verified).map((s) => s.id));
  const checkedJobs = tasksOf(
    checked.ready.filter((id) => verified.has(id)),
    listing,
  );
  const uncheckedJobs = tasksOf(
    checked.ready.filter((id) => !verified.has(id)),
    listing,
  );
  const missingJobs = tasksOf(checked.missing, listing);
  const lines = [`${label} connected on this machine.`];
  if (checkedJobs.length > 0) {
    lines.push(
      preference === 'added' || preference === 'kept'
        ? `Tenjin will use your ${label} account first for ${list.format(checkedJobs)}.`
        : `Tenjin can use your ${label} account for ${list.format(checkedJobs)}, without putting it first.`,
    );
  }
  if (uncheckedJobs.length > 0) {
    lines.push(
      `Tenjin hasn't checked ${label} for ${list.format(uncheckedJobs)} yet, so ${uncheckedJobs.length === 1 ? 'it runs' : 'those run'} only when you ask for ${label} by name.`,
    );
  }
  if (missingJobs.length > 0) {
    lines.push(
      `This ${label} account can't do ${list.format(missingJobs)}, so Tenjin leaves ${missingJobs.length === 1 ? 'it' : 'them'} out here.`,
    );
  }
  if (checkedJobs.length === 0 && uncheckedJobs.length === 0) {
    lines.push(`None of the jobs Tenjin knows for ${label} are available on this account yet.`);
  }
  lines.push(
    `Calls on your ${label} account are billed to your own plan, not counted in the limit on your Tenjin balance.`,
  );
  lines.push(
    WHOLE_ACCOUNT.has(account.id) && !byKey
      ? `${label}'s sign-in lets Tenjin act on your whole ${label} account. Tenjin only runs the jobs above and the ${label} services you ask for by name.`
      : `Tenjin can act on your ${label} account, and only runs the jobs above and the ${label} services you ask for by name.`,
  );
  if (preference === 'blocked')
    lines.push(`Your settings block ${label}, so Tenjin won't use it until you unblock it.`);
  if (preference === 'unreadable')
    lines.push(`Your saved settings can't be read, so ${label} wasn't added to your preferences.`);
  if (preference === 'full')
    lines.push(`Your account-wide preference is full, so ${label} wasn't added to it.`);
  if (preference === 'added' || preference === 'kept')
    lines.push(
      `Say "don't prefer ${label}" to stop putting it first (\`tenjin config reset --source ${account.id} --preference\`), or "disconnect ${label}" to remove it.`,
    );
  return lines;
}

/**
 * `tenjin connect <name | url> [--paste | --from-env VAR] [--no-prefer]`.
 */
export async function runConnect(
  target: string,
  flags: ConnectFlags,
  ctx: CommandContext,
  deps: ConnectDeps = {},
): Promise<CommandResult> {
  if (flags.paste === true && flags.fromEnv !== undefined)
    usage('Use --paste or --from-env, not both.');
  const name = target.trim();
  if (name.length === 0)
    usage('Say which account to connect: tenjin connect <name or https address>.');
  const config = await loadRawConfig(ctx.dataDir);
  const saved = savedAccounts(config).flatMap((entry) => descriptorOf(entry) ?? []);

  const directory = await fetchDirectory(ctx.dataDir, {
    ctx,
    baseUrl: await baseUrlOf(ctx),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!directory.ok) {
    throw new CliError(
      directory.unreachable === true ? 'API_UNREACHABLE' : 'NETWORK_ERROR',
      `Tenjin couldn't look up "${name}" right now, so nothing was connected. (${directory.reason})`,
      { fix: 'Try again in a moment.' },
    );
  }
  const listing = directory.listing;
  const account = resolveAccount(name, listing, saved);
  if (savedAccounts(config).length >= MAX_ACCOUNTS && !saved.some(({ id }) => id === account.id)) {
    throw new CliError(
      'REFUSED',
      `You already have ${MAX_ACCOUNTS} accounts connected, so ${account.label} wasn't connected.`,
      { fix: 'Disconnect one you no longer use with `tenjin disconnect <name>` first.' },
    );
  }

  // 2. THE CREDENTIAL. Nothing is saved yet.
  const byKey = flags.paste === true || flags.fromEnv !== undefined;
  let secret: VaultSecret;
  let headers: Record<string, string>;
  let expiresAt: string | undefined;
  if (byKey) {
    const key = await keyFrom(flags, account, deps);
    secret = { apiKey: key, keyScheme: account.keyScheme };
    headers = { authorization: `${account.keyScheme} ${key}` };
  } else {
    if (!account.signIn.includes('oauth')) {
      usage(
        `${account.label} connects with a key. Nothing was saved.`,
        `Ask the user to run \`tenjin connect ${account.id} --paste\` in their own terminal, or use --from-env with a variable that holds it.`,
      );
    }
    const signInDeps: SignInDeps = {
      fetchImpl: deps.fetchImpl ?? fetch,
      open: deps.openUrl ?? ((url) => openInBrowser(url)),
      notice: (line) => emitWriteNotice(ctx.io, line),
      interactive: ctx.io.isTTY && (deps.stdinIsTTY ?? Boolean(process.stdin.isTTY)),
      waitMs: deps.waitMs ?? SIGN_IN_WAIT_MS,
      ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
      ...(deps.clientMetadataUrl !== undefined
        ? { clientMetadataUrl: deps.clientMetadataUrl }
        : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    const signed: SignedIn = await signIn(account, signInDeps);
    secret = {
      tokens: { ...signed.tokens },
      obtainedAt: signed.obtainedAt,
      clientInformation: { ...signed.clientInformation },
      discoveryState: { ...signed.discoveryState },
    };
    headers = { authorization: `Bearer ${signed.tokens.access_token}` };
    if (typeof signed.tokens.expires_in === 'number' && Number.isFinite(signed.tokens.expires_in))
      expiresAt = new Date(signed.obtainedAt + signed.tokens.expires_in * 1_000).toISOString();
  }

  // 3. THE FREE CHECK, on the credential about to be saved.
  const checked = await checkAccount(account, headers, byKey, deps);

  // 4. SAVE: the vault, then the descriptor and preference in one locked write.
  const now = deps.now?.() ?? Date.now();
  const vaultDeps = {
    dataDir: ctx.dataDir,
    exec: deps.exec ?? defaultExecFor(),
    interactive: ctx.io.isTTY,
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  };
  const { plainFile } = await writeVault(
    account.id,
    account.label,
    {
      kind: byKey ? 'key' : 'oauth',
      mcpUrl: account.mcpUrl,
      connectedAt: new Date(now).toISOString(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      state: 'ok',
      ready: checked.ready,
      missing: checked.missing,
    },
    secret,
    vaultDeps,
  );
  if (plainFile) {
    emitWriteNotice(
      ctx.io,
      `This machine has no keychain, so the key that seals this sign-in is in ${sourceKeyFilePath(account.id, ctx.dataDir)}, readable only by you.`,
    );
  }
  const descriptor: Descriptor = {
    id: account.id,
    label: account.label,
    mcpUrl: account.mcpUrl,
    signIn: byKey ? 'key' : 'oauth',
    ...(byKey ? { keyScheme: account.keyScheme } : {}),
    // Only an account the directory listed is named to the router, on every
    // lookup; one connected by its address alone stays on this machine. The
    // tool each mapped job bills through runs only through that job.
    ...(account.mapped
      ? { mapped: true as const, mappedTools: billingTools(account.services) }
      : {}),
  };
  let preference = 'skipped' as PreferenceOutcome;
  let rule: PreferRule | undefined;
  let policy: SavedPolicy | undefined;
  try {
    await persist(ctx.dataDir, (existing) => {
      const next = withDescriptor(existing, descriptor);
      // An unmapped account has no job to come first for.
      if (flags.prefer === false || !account.mapped) {
        preference = 'skipped';
        return next;
      }
      const preferred = withPreference(next, account.id, listing);
      preference = preferred.outcome;
      rule = preferred.rule;
      policy = preferred.policy;
      return preferred.next;
    });
  } catch (err) {
    // A sign-in with no descriptor is never used: take it back off this machine.
    await deleteVault(account.id, vaultDeps).catch(() => undefined);
    throw err;
  }

  const explanation = connectLines(account, listing, checked, preference, byKey);
  return answer(
    {
      operation: 'connect',
      changed: true,
      scope: 'user',
      explanation,
      ...(rule !== undefined && policy !== undefined
        ? { rules: [describePrefer(rule, policy, listing)] }
        : {}),
      reset: `tenjin disconnect ${account.id}`,
      extra: {
        account: {
          id: account.id,
          label: account.label,
          signIn: byKey ? 'key' : 'oauth',
          mapped: account.mapped,
          ready: checked.ready,
          missing: checked.missing,
          preference,
          ...(preference === 'added' || preference === 'kept'
            ? { undoPreference: `tenjin config reset --source ${account.id} --preference` }
            : {}),
        },
      },
    },
    ctx,
    {
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    },
    listing,
  );
}

/** Every preference with this account taken out, an emptied one dropped. */
function withoutAccount(
  existing: PartialConfig,
  id: string,
): { next: PartialConfig; removed: boolean; policyKept: boolean } {
  const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
  const saved = Array.isArray(router.sources) ? (router.sources as SourceDescriptor[]) : [];
  const sources = saved.filter((entry) => entry.id !== id);
  const removed = sources.length !== saved.length;
  if (sources.length > 0) router.sources = sources;
  else delete router.sources;
  const raw = router.policy;
  if (raw === undefined) return { next: { ...existing, router }, removed, policyKept: true };
  const shape = SavedPolicyShapeSchema.safeParse(raw);
  if (!shape.success) return { next: { ...existing, router }, removed, policyKept: false };
  const prefer = (shape.data.prefer ?? []).flatMap((rule) => {
    const targets = rule.targets.filter((t) => !(t.kind === 'source' && t.id === id));
    return targets.length === 0 ? [] : [{ ...rule, targets }];
  });
  const policy: SavedPolicy = { ...shape.data, prefer };
  const kept = {
    version: policy.version,
    ...(policy.block?.length ? { block: policy.block } : {}),
    ...(policy.only?.length ? { only: policy.only } : {}),
    ...(prefer.length ? { prefer } : {}),
  };
  if (Object.keys(kept).length === 1) delete router.policy;
  else router.policy = kept;
  return { next: { ...existing, router }, removed, policyKept: true };
}

/** `tenjin disconnect <name>`: offline but for the sign-out itself. */
export async function runDisconnect(
  target: string,
  ctx: CommandContext,
  deps: ConnectDeps = {},
): Promise<CommandResult> {
  const name = folded(target);
  if (name.length === 0) usage('Say which account to disconnect: tenjin disconnect <name>.');
  const config = await loadRawConfig(ctx.dataDir);
  const sources = readPersonalRouter(config.router).sources;
  const saved = (sources.status === 'ok' ? sources.saved : []).flatMap(
    (e) => descriptorOf(e) ?? [],
  );
  const own = saved.find((account) => account.id === name || folded(account.label) === name);
  const id = own?.id ?? (isAccountId(name) ? name : undefined);
  const vaultDeps = {
    dataDir: ctx.dataDir,
    exec: deps.exec ?? defaultExecFor(),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  };
  const header = id !== undefined ? await readVaultHeader(ctx.dataDir, id).catch(() => null) : null;
  const label = own?.label ?? target.trim();
  const listing = await cachedDirectory(ctx.dataDir);
  if (id === undefined || (own === undefined && header === null)) {
    return answer(
      {
        operation: 'disconnect',
        changed: false,
        scope: 'user',
        explanation: [`${label} isn't connected on this machine. Nothing changed.`],
      },
      ctx,
      { ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}) },
      listing,
    );
  }

  // SIGN OUT where the account's authorization server lets a client.
  let signedOut: 'revoked' | 'unsupported' | 'failed' | 'key' | 'none' = 'none';
  if (header !== null) {
    if (header.kind === 'key') signedOut = 'key';
    else {
      const read = await readVault(id, label, vaultDeps).catch(() => null);
      signedOut =
        read?.status === 'ok' ? await revokeSignIn(read.secret, deps.fetchImpl ?? fetch) : 'failed';
    }
  }
  await deleteVault(id, vaultDeps);
  let policyKept = true;
  await persist(ctx.dataDir, (existing) => {
    const result = withoutAccount(existing, id);
    policyKept = result.policyKept;
    return result.next;
  });
  const explanation = [
    signedOut === 'revoked'
      ? `${label} is disconnected: Tenjin signed out of it and deleted the sign-in on this machine.`
      : signedOut === 'key'
        ? `${label} is disconnected: Tenjin deleted your ${label} key from this machine. The key itself still works at ${label} until you delete it there.`
        : signedOut === 'none'
          ? `${label} is disconnected on this machine.`
          : `${label} is disconnected: Tenjin deleted the sign-in on this machine, but couldn't sign out at ${label}. You can remove Tenjin's access in your ${label} account settings.`,
    policyKept
      ? `It's no longer in your preferences. Your other settings and accounts stay as they are.`
      : `Your saved settings can't be read, so any preference for ${label} stays until they're fixed.`,
  ];
  return answer(
    {
      operation: 'disconnect',
      changed: true,
      scope: 'user',
      explanation,
      reset: `tenjin connect ${id}`,
      extra: { account: { id, label, signedOut } },
    },
    ctx,
    { ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}) },
    undefined,
  );
}

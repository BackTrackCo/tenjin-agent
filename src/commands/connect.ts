import { CliError } from '../lib/errors';
import {
  editSources,
  loadRawConfig,
  resolveSettings,
  savedDescriptors,
  type PartialConfig,
} from '../lib/config';
import { emitWriteNotice, sanitizeForTerminal } from '../lib/output';
import { openInBrowser } from '../lib/open-url';
import { defaultExecFor, hiddenPrompt, type ExecFn, type PromptFn } from '../lib/os-store';
import { sourceKeyFilePath } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';
import {
  POLICY_VERSION,
  SETTINGS_LIMITS,
  SavedPolicySchema,
  SavedPolicyShapeSchema,
  hasRules,
  scopeKey,
  wirePolicy,
  type PreferRule,
  type SavedPolicy,
  type Target,
} from '../router/settings-wire';
import { isAccountUrl, type Connectable, type KeyScheme } from '../router/decision';
import {
  accountJobs,
  accountServices,
  cachedIdentities,
  fetchIdentities,
  type Identities,
} from '../router/identities';
import { authHeader, expiresAtOf } from '../router/accounts/credential';
import { accountIdForUrl, isAccountId } from '../router/accounts/ids';
import { savedAccountOf, type SavedAccount } from '../router/accounts/saved';
import {
  AccountRefused,
  openAccountSession,
  type AccountSession,
  type OpenAccountSession,
} from '../router/accounts/client';
import { revokeSignIn, signIn, type SignedIn, type SignInDeps } from '../router/accounts/oauth';
import {
  deleteVault,
  readVault,
  readVaultHeader,
  restoreVault,
  writeVault,
  type VaultSecret,
} from '../router/accounts/vault';
import { answer, type Reply } from './config-rules';
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
 * 1. NAME. A name resolves against the accounts the router's free identities
 *    read lists as `connectable`; an https address that is none of them is
 *    connected as itself, unmapped, so Tenjin runs it only when the user
 *    names it.
 * 2. SIGN-IN. In the browser (the MCP sign-in, `accounts/oauth.ts`), or with a
 *    key typed at a hidden prompt (`--paste`) or read once from the
 *    environment (`--from-env`). A key never goes through the agent's chat.
 * 3. A FREE CHECK. Tenjin lists the account's tools and confirms the tools its
 *    maps call are there; one that is missing (a higher plan, say) is kept in
 *    the vault's header, and a job that calls it is left out on this machine.
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
 * settings, blocks and accounts stay.
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

/** The most accounts the settings file holds: `sources` carries at most 16
 *  ids on the wire, `tenjin` among them. */
const MAX_ACCOUNTS = SETTINGS_LIMITS.sources - 1;

/**
 * Where an account's own free tool can tell a key that works from one that
 * only looks right. fal takes any well-formed key until a real call; the
 * identities read cannot say this, so it is code.
 */
const ACCOUNT_CHECKS: Record<string, { tool: string; args: Record<string, unknown> }> = {
  fal: { tool: 'check_account_status', args: {} },
};

/** Accounts whose sign-in grants the whole account: the readback says so. */
const WHOLE_ACCOUNT = new Set(['apify']);

/** The account being connected. `expectTools` is empty for an unmapped one. */
interface Account {
  id: string;
  label: string;
  mcpUrl: string;
  signIn: Connectable['signIn'];
  keyScheme: KeyScheme;
  expectTools: string[];
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

/** An https address as an account is kept under: no trailing slash. */
function accountUrlOf(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** The account a name or address means, from the identities read. */
function resolveAccount(
  target: string,
  identities: Identities,
  saved: readonly SavedAccount[],
): Account {
  type Listed = { id: string; label: string; connectable: Connectable };
  const listed: Listed[] = identities.sources.flatMap((source) =>
    source.connectable !== undefined && isAccountId(source.id)
      ? [{ id: source.id, label: source.label, connectable: source.connectable }]
      : [],
  );
  const fromRead = ({ id, label, connectable }: Listed): Account => ({
    id,
    label,
    mcpUrl: connectable.mcpUrl,
    signIn: connectable.signIn,
    keyScheme: connectable.keyScheme ?? 'Bearer',
    expectTools: connectable.expectTools,
    mapped: true,
  });
  if (looksLikeUrl(target)) {
    // THE ADDRESS AS TYPED, a trailing slash aside: one that names a user, a
    // password, a query or a fragment is refused, never cleaned into another.
    const raw = target.replace(/\/+$/, '');
    const parsed = isAccountUrl(raw) ? new URL(raw) : undefined;
    const href = parsed !== undefined ? accountUrlOf(parsed) : '';
    if (parsed === undefined || !isAccountUrl(href)) {
      usage(
        'Connect takes an https address with no user name, password, query or fragment. Nothing was saved.',
        'tenjin connect https://mcp.example.com/mcp',
      );
    }
    const known = listed.find(({ connectable: c }) => c.mcpUrl === href);
    if (known !== undefined) return fromRead(known);
    const id = accountIdForUrl(parsed);
    const taken = new Set(identities.sources.map((source) => source.id));
    const savedHere = saved.find((account) => account.id === id);
    if (taken.has(id) || (savedHere !== undefined && savedHere.mcpUrl !== href)) {
      throw new CliError(
        'REFUSED',
        `Another account is already connected as ${parsed.hostname}, so this address wasn't connected.`,
        { fix: `Disconnect it first with \`tenjin disconnect ${id}\`, then connect this address.` },
      );
    }
    return {
      id,
      label: parsed.hostname,
      mcpUrl: href,
      signIn: ['oauth', 'key'],
      keyScheme: 'Bearer',
      expectTools: [],
      mapped: false,
    };
  }
  const wanted = folded(target);
  const named = listed.find(({ id, label }) => id === wanted || folded(label) === wanted);
  if (named !== undefined) return fromRead(named);
  const own = saved.find((account) => account.id === wanted || folded(account.label) === wanted);
  if (own !== undefined && own.mapped !== true) {
    return {
      id: own.id,
      label: own.label,
      mcpUrl: own.mcpUrl,
      signIn: ['oauth', 'key'],
      keyScheme: own.keyScheme ?? 'Bearer',
      expectTools: [],
      mapped: false,
    };
  }
  const known = listed.map(({ label }) => label);
  usage(
    `Tenjin doesn't know an account called "${target}". Nothing was saved.`,
    known.length > 0
      ? `Tenjin can connect ${new Intl.ListFormat('en', { type: 'disjunction' }).format(known)}, or any MCP server by its https address.`
      : 'Connect an MCP server by its https address: tenjin connect https://mcp.example.com/mcp',
    { name: target, connectable: listed.map(({ id, label }) => ({ id, label })) },
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

/** The free check, on the credential about to be saved: the tools its maps
 *  call that this account does not list. */
async function checkAccount(
  account: Account,
  headers: Record<string, string>,
  byKey: boolean,
  deps: ConnectDeps,
): Promise<{ missingTools: string[] }> {
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
    const listed = new Set(tools.map(({ name }) => name));
    return { missingTools: account.expectTools.filter((tool) => !listed.has(tool)) };
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
  identities: Identities,
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
  if (blockedBy(target, policy, identities) !== undefined)
    return { next: existing, outcome: 'blocked' };
  const prefer = policy.prefer ?? [];
  const global = prefer.find(({ scope }) => scopeKey(scope) === 'global');
  if (global?.targets.some((t) => t.kind === 'source' && t.id === id))
    return { next: existing, outcome: 'kept', rule: global, policy };
  if (global !== undefined && global.targets.length >= SETTINGS_LIMITS.targets)
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
  if (!SavedPolicySchema.safeParse(after).success) return { next: existing, outcome: 'full' };
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
function withDescriptor(existing: PartialConfig, descriptor: SavedAccount): PartialConfig {
  return editSources(existing, (saved) => {
    const before = savedAccountOf(saved.find((entry) => entry.id === descriptor.id));
    const others = saved.filter((entry) => entry.id !== descriptor.id);
    const kept = before?.onRefusal !== undefined ? { onRefusal: before.onRefusal } : {};
    return [...others, { ...descriptor, ...kept }];
  });
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** The most jobs one readback line names before it counts the rest. */
const NAMED_JOBS = 4;

/** A few jobs by name, the rest counted. */
function some(jobs: readonly string[]): string {
  if (jobs.length <= NAMED_JOBS) return list.format(jobs);
  return `${list.format([...jobs.slice(0, NAMED_JOBS - 1), `${jobs.length - NAMED_JOBS + 1} more`])} (\`tenjin status\` lists them)`;
}

/** What a connect says, in the user's words: no ids, no protocol terms. */
function connectLines(
  account: Account,
  identities: Identities,
  checked: { missingTools: string[] },
  preference: PreferenceOutcome,
  byKey: boolean,
): string[] {
  const { label } = account;
  if (!account.mapped) {
    return [
      `Connected ${label} on this machine. Tenjin doesn't know this service's jobs yet, so it won't pick it on its own. Ask for it by name and Tenjin will run it.`,
      `Your ${label} account pays for its calls, which don't count toward your Tenjin limits.`,
      'Nothing about this service was sent to Tenjin.',
    ];
  }
  const jobs = accountJobs(account.id, identities);
  const preferred = preference === 'added' || preference === 'kept';
  const lines = [
    jobs.length > 0
      ? `${label} connected on this machine, for ${some(jobs)}.`
      : `${label} connected on this machine.`,
  ];
  if (preferred)
    lines.push(
      `Tenjin will use your ${label} account first for those jobs once it has checked them with a real call; until then a job runs on it when you ask for ${label} by name.`,
    );
  else
    lines.push(
      `Tenjin can use your ${label} account for those jobs once it has checked them with a real call, without putting it first; until then a job runs on it when you ask for ${label} by name.`,
    );
  if (checked.missingTools.length > 0) {
    lines.push(
      `This ${label} account doesn't have ${list.format(checked.missingTools)}, so Tenjin leaves out the jobs that need ${checked.missingTools.length === 1 ? 'it' : 'them'} here.`,
    );
  }
  lines.push(
    `Your ${label} plan pays for these calls, which don't count toward your Tenjin limits.`,
  );
  lines.push(
    WHOLE_ACCOUNT.has(account.id) && !byKey
      ? `${label}'s sign-in lets Tenjin act on your whole ${label} account. Tenjin only runs the jobs above and the ${label} services you ask for by name.`
      : `Tenjin can act on your ${label} account, and only runs the jobs above and the ${label} services you ask for by name.`,
  );
  if (preference === 'blocked')
    lines.push(
      `Tenjin won't offer your ${label} account on its own. You or your agent can still pick it by name.`,
    );
  if (preference === 'unreadable')
    lines.push(`Your saved settings can't be read, so ${label} wasn't added to your preferences.`);
  if (preference === 'full')
    lines.push(`Your account-wide preference is full, so ${label} wasn't added to it.`);
  if (preferred)
    lines.push(
      `Say "don't prefer ${label}" to stop putting it first (\`tenjin config reset --source ${account.id} --preference\`), or "disconnect ${label}" to remove it.`,
    );
  return lines;
}

/** What a connect says at a terminal: the account, who pays, how to use it. */
function connectReply(
  account: Account,
  identities: Identities,
  checked: { missingTools: string[] },
  preference: PreferenceOutcome,
): Reply {
  const { label } = account;
  const billed = `billed to your ${label} plan, not your Tenjin balance.`;
  if (!account.mapped) {
    return {
      done: `Connected ${label}`,
      said: [
        `Its calls are ${billed}`,
        "Ask for it by name: Tenjin doesn't know its jobs, and its server isn't told about it.",
      ],
    };
  }
  const tools = accountServices(account.id, identities).length;
  const missing = checked.missingTools;
  return {
    done: `Connected ${label}`,
    said: [
      tools > 0
        ? `${tools} ${tools === 1 ? 'tool' : 'tools'}, ${billed}`
        : `Its calls are ${billed}`,
      `Ask for ${label} by name to use ${tools === 1 ? 'it' : 'them'}. \`tenjin status\` lists it.`,
    ],
    problems: [
      ...(missing.length > 0
        ? [
            `This ${label} account lacks ${list.format(missing)}, so jobs that need ${missing.length === 1 ? 'it' : 'them'} are left out.`,
          ]
        : []),
      ...(preference === 'blocked'
        ? [`Your block on ${label} stays: Tenjin won't offer it on its own.`]
        : preference === 'unreadable'
          ? [`Your saved settings can't be read, so ${label} wasn't put first.`]
          : preference === 'full'
            ? [`Your account-wide preference is full, so ${label} wasn't put first.`]
            : []),
    ],
  };
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
  const descriptors = savedDescriptors(config.router);
  const saved = descriptors.flatMap((entry) => savedAccountOf(entry) ?? []);

  // 1. THE NAME, from the router's free identities read.
  const read = await fetchIdentities(ctx, {
    baseUrl: await baseUrlOf(ctx),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!read.ok) {
    throw new CliError(
      read.unreachable === true ? 'API_UNREACHABLE' : 'NETWORK_ERROR',
      `Tenjin couldn't look up "${name}" right now, so nothing was connected. (${read.reason})`,
      { fix: 'Try again in a moment.' },
    );
  }
  const { identities } = read;
  const account = resolveAccount(name, identities, saved);
  if (descriptors.length >= MAX_ACCOUNTS && !saved.some(({ id }) => id === account.id)) {
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
    headers = authHeader(account.keyScheme, key);
  } else {
    if (!account.signIn.includes('oauth')) {
      usage(
        `${account.label} connects with a key. Nothing was saved.`,
        `Ask the user to run \`tenjin connect ${account.id} --paste\` in their own terminal, or use --from-env with a variable that holds it.`,
      );
    }
    const human = ctx.io.isTTY && !ctx.flags.json;
    const signInDeps: SignInDeps = {
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      open: deps.openUrl ?? ((url) => openInBrowser(url)),
      notice: (line) => emitWriteNotice(ctx.io, line),
      // AT A TERMINAL, one line while the browser opens and the link dim under
      // it, whole, to copy; an agent keeps the two lines that name the link.
      ...(human
        ? {
            approving: (label: string, url: string) => {
              ctx.io.stderr.write(
                `${sanitizeForTerminal(`Opening your browser to approve Tenjin for ${label}…`)}\n`,
              );
              emitWriteNotice(ctx.io, `  If it didn't open: ${url}`);
            },
          }
        : {}),
      interactive: ctx.io.isTTY && (deps.stdinIsTTY ?? Boolean(process.stdin.isTTY)),
      waitMs: deps.waitMs ?? SIGN_IN_WAIT_MS,
      ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
      ...(deps.clientMetadataUrl !== undefined
        ? { clientMetadataUrl: deps.clientMetadataUrl }
        : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    const signed: SignedIn = await signIn(account, signInDeps);
    if (human) ctx.io.stderr.write('\n');
    secret = {
      tokens: { ...signed.tokens },
      obtainedAt: signed.obtainedAt,
      clientInformation: { ...signed.clientInformation },
      discoveryState: { ...signed.discoveryState },
    };
    headers = authHeader('Bearer', signed.tokens.access_token);
    expiresAt = expiresAtOf(signed.tokens, signed.obtainedAt);
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
  const { plainFile, previous } = await writeVault(
    account.id,
    account.label,
    {
      kind: byKey ? 'key' : 'oauth',
      mcpUrl: account.mcpUrl,
      connectedAt: new Date(now).toISOString(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      state: 'ok',
      missingTools: checked.missingTools,
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
  const descriptor: SavedAccount = {
    id: account.id,
    label: account.label,
    mcpUrl: account.mcpUrl,
    signIn: byKey ? 'key' : 'oauth',
    ...(byKey ? { keyScheme: account.keyScheme } : {}),
    // Only an account the identities read lists is named to the router, in
    // every request's sources; one connected by its address alone stays on
    // this machine. The tools its maps call run only through those jobs.
    ...(account.mapped ? { mapped: true as const, mappedTools: account.expectTools } : {}),
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
      const preferred = withPreference(next, account.id, identities);
      preference = preferred.outcome;
      rule = preferred.rule;
      policy = preferred.policy;
      return preferred.next;
    });
  } catch (err) {
    // THE SETTINGS COULD NOT BE SAVED (a stale config lock, say): the sign-in
    // this connect replaced is put back as it was, so one that worked keeps
    // working; one it made fresh has no descriptor, so it comes back off.
    await (
      previous !== null
        ? restoreVault(account.id, previous, vaultDeps)
        : deleteVault(account.id, vaultDeps)
    ).catch(() => undefined);
    throw err;
  }

  const explanation = connectLines(account, identities, checked, preference, byKey);
  return answer(
    {
      operation: 'connect',
      changed: true,
      scope: 'user',
      explanation,
      human: connectReply(account, identities, checked, preference),
      ...(rule !== undefined && policy !== undefined
        ? { effective: [describePrefer(rule, policy, identities)] }
        : {}),
      reset: `tenjin disconnect ${account.id}`,
      extra: {
        account: {
          id: account.id,
          label: account.label,
          signIn: byKey ? 'key' : 'oauth',
          mapped: account.mapped,
          jobs: account.mapped ? accountJobs(account.id, identities) : [],
          missingTools: checked.missingTools,
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
    identities,
  );
}

/** Every preference with this account taken out, an emptied one dropped, and
 *  its descriptor gone. Blocks and only rules stay as they are. */
function withoutAccount(
  existing: PartialConfig,
  id: string,
): { next: PartialConfig; policyKept: boolean } {
  const next = editSources(existing, (saved) => saved.filter((entry) => entry.id !== id));
  const router = { ...((next.router ?? {}) as Record<string, unknown>) };
  const raw = router.policy;
  if (raw === undefined) return { next, policyKept: true };
  const shape = SavedPolicyShapeSchema.safeParse(raw);
  if (!shape.success) return { next, policyKept: false };
  const prefer = (shape.data.prefer ?? []).flatMap((rule) => {
    const targets = rule.targets.filter((t) => !(t.kind === 'source' && t.id === id));
    return targets.length === 0 ? [] : [{ ...rule, targets }];
  });
  const rules = wirePolicy({ ...shape.data, prefer });
  if (hasRules(rules)) router.policy = { version: shape.data.version, ...rules };
  else delete router.policy;
  return { next: { ...next, router }, policyKept: true };
}

/** `tenjin disconnect <name>`: offline but for the sign-out itself. */
export async function runDisconnect(
  target: string,
  ctx: CommandContext,
  deps: ConnectDeps = {},
): Promise<CommandResult> {
  const name = folded(target);
  if (name.length === 0) usage('Say which account to disconnect: tenjin disconnect <name>.');
  // A SAVED LIST THIS BUILD CAN'T READ is refused before anything is signed
  // out or deleted, as the edit that drops the descriptor would refuse it.
  const config = await loadRawConfig(ctx.dataDir);
  const saved = savedDescriptors(config.router).flatMap((e) => savedAccountOf(e) ?? []);
  const own = saved.find((account) => account.id === name || folded(account.label) === name);
  const id = own?.id ?? (isAccountId(name) ? name : undefined);
  const vaultDeps = {
    dataDir: ctx.dataDir,
    exec: deps.exec ?? defaultExecFor(),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  };
  const header = id !== undefined ? await readVaultHeader(ctx.dataDir, id).catch(() => null) : null;
  const label = own?.label ?? target.trim();
  const identities = await cachedIdentities(ctx.dataDir);
  const answerDeps = { ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}) };
  if (id === undefined || (own === undefined && header === null)) {
    return answer(
      {
        operation: 'disconnect',
        changed: false,
        scope: 'user',
        explanation: [`${label} isn't connected on this machine. Nothing changed.`],
        human: { said: [`${label} isn't connected on this machine. Nothing changed.`] },
      },
      ctx,
      answerDeps,
      identities,
    );
  }

  // SIGN OUT where the account's authorization server lets a client.
  let signedOut: 'revoked' | 'unsupported' | 'failed' | 'key' | 'none' = 'none';
  if (header !== null) {
    if (header.kind === 'key') signedOut = 'key';
    else {
      const read = await readVault(id, label, vaultDeps).catch(() => null);
      signedOut =
        read?.status === 'ok' ? await revokeSignIn(read.secret, deps.fetchImpl) : 'failed';
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
  const human: Reply = {
    done: `Disconnected ${label}`,
    said: [
      signedOut === 'revoked'
        ? 'Signed out and forgotten on this machine.'
        : signedOut === 'key'
          ? `Forgotten on this machine. The key still works at ${label} until you delete it there.`
          : signedOut === 'none'
            ? 'Forgotten on this machine.'
            : `Forgotten on this machine, but Tenjin couldn't sign out at ${label}: remove its access in your ${label} settings.`,
    ],
    ...(policyKept
      ? {}
      : {
          problems: [
            `Your saved settings can't be read, so a preference for ${label} stays until they're fixed.`,
          ],
        }),
  };
  return answer(
    {
      operation: 'disconnect',
      changed: true,
      scope: 'user',
      explanation,
      human,
      reset: `tenjin connect ${id}`,
      extra: { account: { id, label, signedOut } },
    },
    ctx,
    answerDeps,
    identities,
  );
}

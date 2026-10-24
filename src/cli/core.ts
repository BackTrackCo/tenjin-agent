import { homedir } from 'node:os';
import { Option, type Command } from 'commander';
import { CliError } from '../lib/errors';
import { PERMISSIONS_DOC_URL } from '../lib/permissions';
import { HARNESSES, type Harness } from '../router/names';
import { collect, SETUP, WALLET, type Registration } from './registration';

/**
 * The core product: setting this machine up, the wallet, and the one standard
 * x402 verb. Every other verb belongs to a product module beside this one, so
 * what a release ships is the list of `register*` calls in `cli.ts`.
 */
export function registerCore(reg: Registration): void {
  const { runCommand, leaf, addGlobalFlags } = reg;

  leaf(SETUP, 'install', 'set up Tenjin for your agent and create a wallet')
    .description(
      "Set up Tenjin for your agent: a wallet if this machine has none, spend limits for each lookup, and the Tenjin plugin (its routing hooks and its `router` MCP server), registered through the agent's own plugin commands. Run by an agent, it sets up the agent it runs in. In a terminal, it sets up Claude Code or Codex, whichever this machine has, and asks which when it has both. For Claude Code, a settings-based install from an earlier release is removed once the plugin has loaded. Codex is user scope only.",
    )
    .addOption(hostOverride())
    .option('--project', 'register the plugin for this project only')
    .option('--no-wallet', 'create no wallet')
    .option('--refresh', 'bring the plugin this machine already has up to this version')
    .option('--yes', 'accept the defaults ($5 a day, $0.25 a call) instead of asking')
    .option('--session-budget <usd|none>', 'your own daily limit, or none, instead of asking')
    .option('--max-auto-spend <usd>', 'your own per-call limit, at least 0.25 (the default)')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin install
  $ tenjin install --project
  $ tenjin install --max-auto-spend 0.50 --session-budget 10

The daily limit is the control, the per-call limit the runaway guard, and the
wallet balance the hard stop. To turn the router off instead:
  $ tenjin config set router.enabled false

Learn more:
  What the router may spend, and what leaves this machine:
  ${PERMISSIONS_DOC_URL}
`,
    )
    .action(async function (this: Command) {
      await runCommand('install', this, async (ctx) => {
        const o = this.opts();
        const harness = o.harness as Harness | undefined;
        // Nothing in the Codex plugin changes between builds, so nothing to refresh.
        if (harness === 'codex' && o.refresh === true) {
          throw new CliError('USAGE', 'The Codex plugin has no refresh; omit --refresh.');
        }
        const { installHosts, otherHostNote, recordInstalledHost, runEach, withNote } =
          await import('../router/hosts');
        const hostArgs = {
          ...(harness !== undefined ? { harness } : {}),
          ...(o.project === true ? { project: true } : {}),
          ...(o.refresh === true ? { refresh: true } : {}),
          ...(o.yes === true ? { yes: true } : {}),
        };
        const hosts = await installHosts(hostArgs, ctx);
        const note = otherHostNote(hostArgs).catch(() => undefined);
        // Both hosts run from the same runtime: it is set up, and said, once.
        const runtime = (await import('../router/install')).runtimeOncePerRun();
        const out = await runEach(hosts, async (host) => {
          const one =
            host === 'codex'
              ? await (
                  await import('../router/codex-install')
                ).runCodexInstall(codexArgs(o), ctx, { runtime })
              : await (
                  await import('../router/install')
                ).runRouterInstall(
                  {
                    ...(o.project === true ? { project: true } : {}),
                    ...(o.refresh === true ? { refresh: true } : {}),
                    ...(o.yes === true ? { yes: true } : {}),
                    ...(o.wallet === false ? { noWallet: true } : {}),
                    ...(typeof o.maxAutoSpend === 'string' ? { maxAutoSpend: o.maxAutoSpend } : {}),
                    ...(typeof o.sessionBudget === 'string'
                      ? { sessionBudget: o.sessionBudget }
                      : {}),
                  },
                  ctx,
                  { runtime },
                );
          if (o.refresh !== true) await recordInstalledHost(ctx.dataDir, host);
          return one;
        });
        return withNote(out, await note);
      });
    });

  leaf(SETUP, 'uninstall', 'remove what install wrote; the wallet is kept')
    .description(
      "Remove Tenjin's install for where you are: the project install of the folder you are in (from any subfolder), or else your user install. The tenjin marketplace, Tenjin's runtime and its launcher go once no install is left anywhere. Either all of it goes or nothing does, and it says what it keeps: your wallet, spend ledger and config. Run it before `npm uninstall -g tenjin-cli`.",
    )
    .addOption(hostOverride())
    .option(
      '--project [path]',
      "remove that project's install (this folder's when no path is given), from any folder",
    )
    .option('--all', "remove every Tenjin install: your user install and each project's")
    .action(async function (this: Command) {
      await runCommand('uninstall', this, async (ctx) => {
        const o = this.opts();
        const harness = o.harness as Harness | undefined;
        const project = o.project as string | true | undefined;
        if (o.all === true && project !== undefined) {
          throw new CliError('USAGE', 'Pass --all or --project, not both.');
        }
        // Codex has user scope only, so its removal never reads Claude Code's records.
        if (harness === 'codex' && project !== undefined) {
          throw new CliError('USAGE', 'Codex has no project install; omit --project.');
        }
        const [{ recordedHosts, uninstallEach }, uninstall] = await Promise.all([
          import('../router/hosts'),
          import('../router/uninstall'),
        ]);
        const target: import('../router/uninstall').UninstallTarget =
          harness === 'codex'
            ? { kind: o.all === true ? 'all' : 'user' }
            : await uninstall.resolveUninstallTarget(
                {
                  ...(o.all === true ? { all: true } : {}),
                  ...(project !== undefined ? { project } : {}),
                },
                ctx,
              );
        // Codex only for a user or every-install target: it has no project scope.
        const hosts = await recordedHosts(
          { ...(harness !== undefined ? { harness } : {}), project: target.kind === 'project' },
          ctx.dataDir,
        );
        return uninstallEach(
          hosts,
          ctx.dataDir,
          target,
          async (host) =>
            host === 'codex'
              ? (await import('../router/codex-install')).runCodexUninstall(codexArgs(o), ctx)
              : uninstall.runRouterUninstall({ target }, ctx),
          {
            remove: () => uninstall.removeRuntimeAndLaunchers(ctx.dataDir, homedir()),
            claudeLeft: () => uninstall.claudeInstallsLeft(ctx),
            keptFor: (users) => uninstall.runtimeKeptFor(ctx.dataDir, homedir(), users),
          },
        );
      });
    });

  leaf(SETUP, 'doctor', 'check this machine can run a lookup')
    .description(
      "Check everything a lookup needs, for each agent `tenjin install` set up. For Claude Code: the Node floor, Claude Code's version, the Tenjin plugin, the runtime and launcher Claude Code starts, its router server, any settings install an earlier release left, the spend limits, whether the wallet can sign without a prompt, as the router Claude Code is running sees it when one is live, and the router endpoint answering its 402. For Codex: Codex's hook list for the plugin and its hook trust. It prints one line per check with a fix for each failure, writes nothing, and exits nonzero if a required one fails; a check it cannot answer is a warning, never ok.",
    )
    .addOption(hostOverride())
    .option('--project', 'check the project-only install, as --project registered it')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin doctor
  $ tenjin doctor --project
  $ tenjin doctor --json
`,
    )
    .action(async function (this: Command) {
      await runCommand('doctor', this, async (ctx) => {
        const o = this.opts();
        const harness = o.harness as Harness | undefined;
        const { checkEach, recordedHosts } = await import('../router/hosts');
        const hosts = await recordedHosts(
          { ...(harness !== undefined ? { harness } : {}), project: o.project === true },
          ctx.dataDir,
        );
        return checkEach(hosts, async (host) =>
          host === 'codex'
            ? (await import('../router/codex-install')).runCodexDoctor(codexArgs(o), ctx)
            : (await import('../router/doctor')).runRouterDoctor(
                ctx,
                o.project === true ? { project: true } : {},
              ),
        );
      });
    });

  leaf(SETUP, 'update', 'update tenjin-cli to the newest published version')
    .description(
      "Update Tenjin to the newest version on npm's latest tag, without npm: it downloads the release, checks it, and switches only once it runs; the previous version stays as the fallback.",
    )
    .option('--check', 'report whether a newer version exists without installing it')
    // Started by lib/auto-update, detached, at the start of a session.
    .addOption(new Option('--background').hideHelp())
    .action(async function (this: Command) {
      await runCommand('update', this, async (ctx) => {
        const { runUpdate } = await import('../commands/update');
        return runUpdate(
          { check: this.opts().check === true, background: this.opts().background === true },
          ctx,
        );
      });
    });

  const config = leaf(SETUP, 'config', 'read and set config values, and your settings').description(
    "Print every effective config value and your settings, read and write one value, or change what Tenjin may use: prefer, only, block, unblock, reset, and whether Tenjin's picks run automatically. Values are stored in config.json under your Tenjin data dir (~/.tenjin by default), on this machine only. Each change answers with what it saved, what it covers and the command that undoes it.",
  );
  config.addHelpText(
    'after',
    `
Examples:
  $ tenjin config
  $ tenjin config --json
  $ tenjin config set router.context turn
  $ tenjin config set maxAutoSpend 0.25
  $ tenjin config set --project router.enabled false

What Tenjin may use (saved on this machine, not synced):
  $ tenjin config prefer --task "web research" --provider exa
  $ tenjin config prefer --source apify
  $ tenjin config only --task "web research" --provider exa
  $ tenjin config only --global --category images --task "web research"
  $ tenjin config block --provider firecrawl
  $ tenjin config block --task "crypto price quote"
  $ tenjin config block --source tenjin
  $ tenjin config unblock --provider firecrawl
  $ tenjin config reset --task "web research" --preference
  $ tenjin config reset --source apify --preference
  $ tenjin config reset --task "web research" --restriction --dimension provider
  $ tenjin config reset --global --capabilities
  $ tenjin config reset --all
  $ tenjin config replacement on --provider exa
  $ tenjin config replacement on --all-providers
  $ tenjin config replacement off

A name is the catalog's name or id ("Exa" or exa). An unclear or unknown name
saves nothing and lists what it could mean. To pause Tenjin:
  $ tenjin config set router.enabled false
`,
  );
  config.action(async function (this: Command) {
    await runCommand('config', this, async (ctx) => {
      const { runConfigList } = await import('../commands/config');
      return runConfigList(ctx);
    });
  });
  addGlobalFlags(config.command('get <key>'))
    .summary('print one effective config value')
    .description(
      'Print one effective config value by key. The effective value is what the command would use, defaults and environment overrides included.',
    )
    .action(async function (this: Command, key: string) {
      await runCommand('config.get', this, async (ctx) => {
        const { runConfigGet } = await import('../commands/config');
        return runConfigGet({ key }, ctx);
      });
    });
  addGlobalFlags(config.command('set <key> <value>'))
    .summary('set a config value')
    .description(
      'Write one config value, validated against the key it is for. Spend keys take decimal USD.',
    )
    .option(
      '--project',
      "write a router key into this project's .tenjin/config.json, which is committed",
    )
    .option('--local', 'with --project, write .tenjin/config.local.json instead, which is yours')
    .action(async function (this: Command, key: string, value: string) {
      const o = this.opts();
      await runCommand('config.set', this, async (ctx) => {
        const { runConfigSet } = await import('../commands/config');
        return runConfigSet(
          { key, value, project: o.project === true, local: o.local === true },
          ctx,
        );
      });
    });

  registerConfigRules(config, reg);

  // Group-level flags so `tenjin wallet --json show` parses like the config group.
  const wallet = leaf(
    WALLET,
    'wallet',
    'create, show, fund, repair and send from the local wallet',
  ).description(
    'Manage the local x402 payment wallet used for paid reads and publishing. The private key is generated on this machine, stored encrypted, and never printed.',
  );
  addGlobalFlags(wallet.command('create'))
    .summary('create a new local wallet')
    .description(
      'Create a new local wallet and store its keystore encrypted under your Tenjin data dir. It refuses when one already exists, so replacing an active wallet is the deliberate --replace.',
    )
    .option(
      '--replace',
      'archive the existing wallet beside the new one, passphrase preserved, then create a new active wallet',
    )
    .option(
      '--insecure-storage',
      'save the passphrase to a file only you can read, even where an OS keychain exists',
    )
    .action(async function (this: Command) {
      await runCommand('wallet.create', this, async (ctx) => {
        const o = this.opts();
        const { runWalletCreate } = await import('../commands/wallet');
        return runWalletCreate(ctx, {
          ...(o.replace === true ? { replace: true } : {}),
          ...(o.insecureStorage === true ? { insecureStorage: true } : {}),
        });
      });
    });
  addGlobalFlags(wallet.command('repair'))
    .summary('save the wallet passphrase so Claude Code can unlock it')
    .description(
      'For a wallet Claude Code cannot unlock. Asks for the passphrase at the terminal (or uses TENJIN_WALLET_PASSPHRASE when that opens the wallet), checks it opens this wallet (the address does not change), saves it in the OS keychain, or in a file only you can read where there is none, and names a TENJIN_WALLET_PASSPHRASE in this shell that conflicts with it. Start a new Claude Code session afterwards: it confirms the unlock.',
    )
    .option(
      '--insecure-storage',
      'save the passphrase to a file only you can read, even where an OS keychain exists',
    )
    .action(async function (this: Command) {
      await runCommand('wallet.repair', this, async (ctx) => {
        const o = this.opts();
        const { runWalletRepair } = await import('../commands/wallet');
        return runWalletRepair(ctx, o.insecureStorage === true ? { insecureStorage: true } : {});
      });
    });
  addGlobalFlags(wallet.command('show'))
    .alias('address')
    .summary('show the wallet address and key source')
    .description(
      'Print the active wallet address and where its key comes from. The private key is never printed, by any flag. At a terminal it also draws the address as a QR code for a phone wallet to scan.',
    )
    .option('--no-qr', 'print the address without the QR code')
    .action(async function (this: Command) {
      await runCommand('wallet.show', this, async (ctx) => {
        const o = this.opts();
        const { runWalletShow } = await import('../commands/wallet');
        return runWalletShow(ctx, o.qr === false ? { qr: false } : {});
      });
    });
  addGlobalFlags(wallet.command('balance'))
    .summary('show the wallet USDC balance on Base')
    .description(
      'Read the wallet USDC balance on Base. It is a chain read: no key is unlocked and nothing is spent.',
    )
    .action(async function (this: Command) {
      await runCommand('wallet.balance', this, async (ctx) => {
        const { runWalletBalance } = await import('../commands/wallet');
        return runWalletBalance(ctx);
      });
    });

  // Funds-IN via Coinbase Onramp, grouped under `wallet` with show/balance
  // because it operates on the wallet and nothing else. Unlike `send`, this IS
  // also an MCP tool
  // (tenjin_fund): minting moves no money and the human gate is Coinbase's own
  // checkout page. The browser open and balance poll below are CLI-only. The
  // poll is off unless stdout is a TTY: the link dies in ~5 minutes, so a piped
  // run takes it off stderr immediately rather than off a poll that outlives it.
  // The open also runs under an agent harness, where the agent runs this on the
  // person's yes to install's funding question.
  addGlobalFlags(wallet.command('fund [amountUsd]'))
    .summary('fund this wallet through a checkout link for your region')
    .description(
      'Get a checkout link for THIS wallet, open it in the browser, and wait for the USDC to land on Base. In the US: Apple Pay or Google Pay with no Coinbase account. Elsewhere: your Coinbase account. The link moves no money: a human completes the payment.',
    )
    .option('--no-open', 'print the checkout link without opening a browser')
    .option('--no-qr', 'skip the QR code of the address for sending USDC from a phone')
    .option(
      '--no-wait',
      'return once the link is issued instead of polling the balance (already the default when not at a TTY)',
    )
    .action(async function (this: Command, amountUsd: string | undefined) {
      await runCommand('wallet.fund', this, async (ctx) => {
        const o = this.opts();
        const { runFund } = await import('../commands/fund');
        return runFund(ctx, {
          ...(amountUsd !== undefined ? { amountUsd } : {}),
          ...(o.open === false ? { open: false } : {}),
          ...(o.qr === false ? { qr: false } : {}),
          ...(o.wait === false ? { wait: false } : {}),
        });
      });
    });

  // The funds-out ESCAPE HATCH: human-invoked only. Deliberately absent from the
  // MCP toolset (src/mcp/server.ts) and the skill adapters; no model-facing
  // surface gains a send trigger (both exclusions are pinned by tests). It lives
  // under `wallet` with every other verb that operates on the wallet.
  addGlobalFlags(wallet.command('send <amount> <token> <to>'))
    .summary('move funds out of the wallet (escape hatch)')
    .description(
      'Move funds OUT of the agent wallet: preview the resolved recipient and amount, confirm explicitly, then transfer on Base and print the tx hash. USDC only, and human-invoked only — no skill and no MCP tool can reach it.',
    )
    .option('--yes', 'skip the interactive confirm (required to send when not at a TTY)')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin wallet send 5 USDC 0x1234abcd...
`,
    )
    .action(async function (this: Command, amount: string, token: string, to: string) {
      await runCommand('wallet.send', this, async (ctx) => {
        const o = this.opts();
        const { runSend } = await import('../commands/send');
        return runSend({ amount, token, to, ...(o.yes === true ? { yes: true } : {}) }, ctx);
      });
    });

  leaf(WALLET, 'pay <url>', 'pay an x402 endpoint with explicit user consent')
    .description(
      'Pay an x402 endpoint (exact scheme, USDC on Base) with explicit user consent. Manual pay ignores automatic router limits and always confirms; --yes records prior consent for this quote. Never use it as an autonomous workaround for router refusal. Unlisted endpoints need no warning flag. Registry lookup failures or listed-term mismatches require --ignore-warnings separately. Every paid call pays; entitled delivery remains free.',
    )
    .option('-X, --method <method>', 'GET (default) or POST (implied by --data)')
    .option('-d, --data <json>', 'JSON request body (sent as application/json)')
    .option('--max-price <usd>', 'hard price cap in decimal USD (never bypassed by --yes)')
    .option('--yes', 'bypass the interactive confirm only (not the price cap)')
    // NOT the same flag as `read`/`buy` carry: there it adds `body` to the
    // machine output, here it un-caps the preview the human line prints.
    .option(
      '--ignore-warnings',
      'acknowledge direct-payment registry warnings only; all payment checks still apply',
    )
    .option('--print-body', 'print the full body instead of the capped preview')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin pay https://api.example.com/quote --max-price 0.05
  $ tenjin pay https://api.example.com/quote --json --max-price 0.05 --ignore-warnings --yes
  $ tenjin pay https://api.example.com/quote -d '{"symbol":"ETH"}' --yes
`,
    )
    .action(async function (this: Command, url: string) {
      await runCommand('pay', this, async (ctx) => {
        const o = this.opts();
        const { runPay } = await import('../commands/pay');
        return runPay(
          {
            url,
            ...(typeof o.method === 'string' ? { method: o.method } : {}),
            ...(typeof o.data === 'string' ? { data: o.data } : {}),
            ...(typeof o.maxPrice === 'string' ? { maxPrice: o.maxPrice } : {}),
            ...(o.yes === true ? { yes: true } : {}),
            ...(o.printBody === true ? { printBody: true } : {}),
            ...(o.ignoreWarnings === true ? { ignoreWarnings: true } : {}),
          },
          ctx,
        );
      });
    });
}

/** `--harness`: one agent host, overriding the hosts these commands find or recorded. */
function hostOverride(): Option {
  return new Option('--harness <host>', 'only this agent host, instead of the ones found').choices(
    HARNESSES,
  );
}

/** The Codex setup's flags, from install's, uninstall's or doctor's. */
function codexArgs(o: Record<string, unknown>): import('../router/codex-install').CodexArgs {
  return {
    ...(o.project === true ? { project: true } : {}),
    ...(o.yes === true ? { yes: true } : {}),
    ...(o.wallet === false ? { noWallet: true } : {}),
    ...(typeof o.maxAutoSpend === 'string' ? { maxAutoSpend: o.maxAutoSpend } : {}),
    ...(typeof o.sessionBudget === 'string' ? { sessionBudget: o.sessionBudget } : {}),
  };
}

type TargetKindFlag = 'task' | 'category' | 'provider' | 'seller' | 'service' | 'source';

const TARGET_FLAGS: Record<TargetKindFlag, string> = {
  task: 'a task, such as "web research" (repeatable)',
  category: 'a category of tasks, such as images (repeatable)',
  provider: 'a provider, such as exa (repeatable)',
  seller: 'who sells the call, such as stableenrich (repeatable)',
  service: 'one service, such as exa-search (repeatable)',
  source: "one of your accounts, or tenjin for Tenjin's own tools (repeatable)",
};

function targetOptions(cmd: Command, kinds: readonly TargetKindFlag[]): Command {
  for (const kind of kinds) cmd.option(`--${kind} <name>`, TARGET_FLAGS[kind], collect);
  return cmd;
}

/** The repeatable target flags, as the operations read them. */
function targetFlags(o: Record<string, unknown>): Record<TargetKindFlag, string[] | undefined> {
  const read = (key: TargetKindFlag) => (Array.isArray(o[key]) ? (o[key] as string[]) : undefined);
  return {
    task: read('task'),
    category: read('category'),
    provider: read('provider'),
    seller: read('seller'),
    service: read('service'),
    source: read('source'),
  };
}

/**
 * THE SETTINGS OPERATIONS, under `tenjin config`. Each answers with what it
 * saved in the user's words and the command that undoes it, so an agent
 * reports the readback rather than assuming the write worked.
 */
function registerConfigRules(config: Command, reg: Registration): void {
  const { runCommand, addGlobalFlags } = reg;
  const rules = () => import('../commands/config-rules');
  const all: TargetKindFlag[] = ['task', 'category', 'provider', 'seller', 'service', 'source'];

  targetOptions(addGlobalFlags(config.command('prefer')), ['task', 'provider', 'service', 'source'])
    .summary('set the order Tenjin tries allowed services in')
    .description(
      'Prefer providers, services or your accounts, in order. With --task the preference is for that task; with --source alone it is account-wide, and a task preference comes first. Repeating it replaces the list at that scope. Other allowed services stay available when a preferred one cannot meet a request: use only to forbid them.',
    )
    .option('--global', 'the account-wide preference (with --source)')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config prefer --task "web research" --provider exa
  $ tenjin config prefer --task "web research" --provider exa --provider tavily
  $ tenjin config prefer --source apify
`,
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.prefer', this, async (ctx) =>
        (await rules()).runConfigPrefer(
          { ...targetFlags(o), ...(o.global === true ? { global: true } : {}) },
          ctx,
        ),
      );
    });

  targetOptions(addGlobalFlags(config.command('only')), [
    'task',
    'category',
    'provider',
    'seller',
    'service',
  ])
    .summary('allow only the named services, providers or tasks')
    .description(
      'Allow only what you name. --global with --category or --task limits which tasks Tenjin does anywhere; --task with --provider, --seller or --service limits who does that one task and leaves other tasks alone. Repeating it replaces the set for that scope; blocks and other rules stay. A request no allowed service can meet is refused with the reason, never sent elsewhere.',
    )
    .option('--global', 'apply everywhere: with --category or --task, which tasks Tenjin does')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config only --task "web research" --provider exa
  $ tenjin config only --global --category images
  $ tenjin config only --global --task "web research" --task "read an exact page"
`,
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.only', this, async (ctx) =>
        (await rules()).runConfigOnly(
          { ...targetFlags(o), ...(o.global === true ? { global: true } : {}) },
          ctx,
        ),
      );
    });

  targetOptions(addGlobalFlags(config.command('block')), all)
    .summary('never let Tenjin use what you name')
    .description(
      "Block a provider, seller, service, task, category or account. A provider block covers reviewed reseller routes through it. A block always wins: a preference or only rule it leaves unusable stays saved and is marked inactive. Blocking Tenjin's own tools (--source tenjin) leaves only your accounts.",
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config block --provider firecrawl
  $ tenjin config block --service exa-contents
  $ tenjin config block --task "crypto price quote"
  $ tenjin config block --category images
`,
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.block', this, async (ctx) =>
        (await rules()).runConfigBlock(targetFlags(o), ctx),
      );
    });

  targetOptions(addGlobalFlags(config.command('unblock')), all)
    .summary('remove a block')
    .description('Remove the named blocks and nothing else. Works offline.')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config unblock --provider firecrawl
  $ tenjin config unblock --task "crypto price quote"
`,
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.unblock', this, async (ctx) =>
        (await rules()).runConfigUnblock(targetFlags(o), ctx),
      );
    });

  targetOptions(addGlobalFlags(config.command('reset')), ['task', 'provider', 'service', 'source'])
    .summary('remove one saved rule, or all of them')
    .description(
      'Remove exactly the rule named, offline. --preference removes a task preference (with --task) or the account-wide one (--global), or with --source one account from it. --restriction removes the only rules for a task or --global, or with --dimension just one. --capabilities removes the global task allowlist. --all removes every saved routing rule. Blocks, spending limits and your accounts stay.',
    )
    .option('--global', 'the account-wide preference, or the global restrictions')
    .option('--preference', 'reset a preference')
    .option('--restriction', 'reset only rules')
    .option(
      '--dimension <dimension>',
      'with --restriction: capability, provider, seller or service',
    )
    .option('--capabilities', 'reset which tasks Tenjin may do')
    .option('--all', 'reset every saved routing rule')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config reset --task "web research" --preference
  $ tenjin config reset --source apify --preference
  $ tenjin config reset --task "web research" --restriction
  $ tenjin config reset --task "web research" --restriction --dimension provider
  $ tenjin config reset --global --capabilities
  $ tenjin config reset --all
`,
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.reset', this, async (ctx) =>
        (await rules()).runConfigReset(
          {
            ...targetFlags(o),
            ...(o.global === true ? { global: true } : {}),
            ...(o.preference === true ? { preference: true } : {}),
            ...(o.restriction === true ? { restriction: true } : {}),
            ...(o.capabilities === true ? { capabilities: true } : {}),
            ...(o.all === true ? { all: true } : {}),
            ...(typeof o.dimension === 'string' ? { dimension: o.dimension } : {}),
          },
          ctx,
        ),
      );
    });

  addGlobalFlags(config.command('replacement <state>'))
    .summary("turn Run Tenjin's picks automatically on or off")
    .description(
      "Run Tenjin's picks automatically: on lets a host that supports it run Tenjin's pick in place of your agent's web search or page fetch, within your limits, instead of offering it first. on needs --provider (repeatable) or --all-providers; off keeps a saved provider choice. It never changes what is allowed or which service is picked first.",
    )
    .option('--provider <name>', 'only when Tenjin picks this provider (repeatable)', collect)
    .option('--all-providers', 'for any allowed provider')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config replacement on --provider exa
  $ tenjin config replacement on --all-providers
  $ tenjin config replacement off
`,
    )
    .action(async function (this: Command, state: string) {
      const o = this.opts();
      await runCommand('config.replacement', this, async (ctx) =>
        (await rules()).runConfigReplacement(
          {
            state,
            ...(Array.isArray(o.provider) ? { provider: o.provider as string[] } : {}),
            ...(o.allProviders === true ? { allProviders: true } : {}),
          },
          ctx,
        ),
      );
    });
}

import { homedir } from 'node:os';
import { Option, type Command } from 'commander';
import { CliError } from '../lib/errors';
import { PERMISSIONS_DOC_URL } from '../lib/permissions';
import { HARNESSES, type Harness } from '../router/names';
import { SETUP, WALLET, collect, type Registration } from './registration';
import { installOutput } from '../router/install-output';

/**
 * The core product: setting this machine up, the wallet, and the one standard
 * x402 verb. Every other verb belongs to a product module beside this one, so
 * what a release ships is the list of `register*` calls in `cli.ts`.
 */
export function registerCore(reg: Registration): void {
  const { runCommand, leaf, addGlobalFlags } = reg;

  leaf(SETUP, 'install', 'set up Tenjin for Claude Code or Codex')
    .description(
      'Install the Tenjin plugin, create a local wallet if needed, and choose spending limits. Your agent sets itself up; a terminal detects Claude Code and Codex and lets you choose when both are present. Funding is optional. Codex supports user scope only.',
    )
    .addOption(hostOverride())
    .option('--project', 'register the plugin for this project only')
    .option('--no-wallet', 'create no wallet')
    .option('--refresh', 'bring the plugin this machine already has up to this version')
    .option('--yes', 'accept the defaults ($5 daily budget shared across chats, $0.25 a call)')
    .option('--session-budget <usd|none>', 'your own daily budget shared across chats, or none')
    .option('--max-auto-spend <usd>', 'your own per-call limit, at least 0.25 (the default)')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin install
  $ tenjin install --project
  $ tenjin install --max-auto-spend 0.50 --session-budget 10

The daily budget is shared across chats. Its spending counter resets 24 hours after its window starts;
opening a new chat does not reset it. The per-call limit bounds each call, and the wallet balance is
the hard stop. To disable Tenjin requests and automatic routing here:
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
        // A bare `--refresh` refreshes the Codex plugin (`refreshCodexPlugin`).
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
        const { fundingOncePerRun, finishTerminalFunding } =
          await import('../router/install-funding');
        const funding = fundingOncePerRun();
        // Both hosts run from the same runtime: it is set up, and said, once.
        const runtime = (await import('../router/install')).runtimeOncePerRun();
        const installAll = () =>
          runEach(hosts, async (host) => {
            const one =
              host === 'codex'
                ? await (
                    await import('../router/codex-install')
                  ).runCodexInstall(codexArgs(o), ctx, { runtime, funding })
                : await (
                    await import('../router/install')
                  ).runRouterInstall(
                    {
                      ...(o.project === true ? { project: true } : {}),
                      ...(o.refresh === true ? { refresh: true } : {}),
                      ...(o.yes === true ? { yes: true } : {}),
                      ...(o.wallet === false ? { noWallet: true } : {}),
                      ...(typeof o.maxAutoSpend === 'string'
                        ? { maxAutoSpend: o.maxAutoSpend }
                        : {}),
                      ...(typeof o.sessionBudget === 'string'
                        ? { sessionBudget: o.sessionBudget }
                        : {}),
                    },
                    ctx,
                    { runtime, funding },
                  );
            if (o.refresh !== true) await recordInstalledHost(ctx.dataDir, host);
            return one;
          });
        if (o.refresh !== true || harness !== undefined) {
          const result = await installAll();
          const finished =
            o.refresh === true
              ? result
              : await finishTerminalFunding(result, ctx, { yes: o.yes === true });
          const note = await otherHostNote(hostArgs, ctx.dataDir);
          return installOutput(withNote(finished, note), ctx, o.refresh === true);
        }
        // `tenjin update` runs this refresh in the new build: a Codex that
        // already has the plugin gets the new hooks too, whatever Claude Code's
        // refresh found.
        const { alongsideCodexRefresh, refreshCodexPlugin } =
          await import('../router/codex-install');
        return alongsideCodexRefresh(installAll, () => refreshCodexPlugin(ctx));
      });
    });

  leaf(SETUP, 'uninstall', 'remove what install wrote; the wallet is kept')
    .description(
      'Remove Tenjin from this project, or from your agent when there is no project install. Keep your wallet, funds, spending history and config. Shared runtime files stay while another Tenjin install needs them. Run this before `npm uninstall -g tenjin-cli`.',
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

  leaf(SETUP, 'doctor', 'show setup status and routing readiness')
    .description(
      'Check the agents Tenjin installed, without making a paid call. Show setup status, session evidence and routing readiness, followed by diagnostics and fixes. Codex checks plugin hooks only; it does not verify the current chat, wallet or funds. A required failure shows its error and fix instead of the summary, and exits nonzero. An unknown check remains a warning. Use --json for structured results.',
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
    "Print every effective config value and your settings, read and write one value, or change what Tenjin may use: prefer, only, block, unblock, reset, speed, and whether Tenjin's picks run automatically. Values are stored in config.json under your Tenjin data dir (~/.tenjin by default), on this machine only. Each change answers with what it saved, what it covers and the command that undoes it. " +
      'maxAutoSpend caps automatic router spending per call; sessionBudget is the daily budget shared across chats. ' +
      'An unset sendMaxAmount blocks tenjin wallet send until you set a cap; only an explicit none allows uncapped sends. ' +
      'router.improve is "Help improve routing", off by default: true lets Tenjin keep the secret-masked text of the turns the router sees, to grade its offers, and false turns it off and deletes what was kept.',
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
  $ tenjin config set router.improve false

What Tenjin may use (saved on this machine, not synced):
  $ tenjin config prefer --task "web research" --provider exa
  $ tenjin config prefer --source apify
  $ tenjin config prefer --task "local leads" --source apify
  $ tenjin config prefer --category images --source fal
  $ tenjin config only --task "web research" --provider exa
  $ tenjin config only --global --category images
  $ tenjin config only --global --task "web research" --task "read an exact page"
  $ tenjin config block --provider firecrawl
  $ tenjin config block --service exa-contents
  $ tenjin config block --task "crypto price quote"
  $ tenjin config block --category images
  $ tenjin config block --source tenjin
  $ tenjin config unblock --provider firecrawl
  $ tenjin config unblock --task "crypto price quote"
  $ tenjin config reset --task "web research" --preference
  $ tenjin config reset --source apify --preference
  $ tenjin config reset --task "web research" --restriction
  $ tenjin config reset --task "web research" --restriction --dimension provider
  $ tenjin config reset --global --capabilities
  $ tenjin config reset --all
  $ tenjin config speed on
  $ tenjin config speed off
  $ tenjin config replacement on --provider exa
  $ tenjin config replacement on --all-providers
  $ tenjin config replacement off

"Use my fal account for images" and "only use my account for images" are the
same preference: prefer --category images --source fal. "Turn off all of
Tenjin's tools" is block --source tenjin. A block or only rule governs what
Tenjin offers and picks on its own; you or your agent can still ask for any
tool by name. Speed: Tenjin also offers paid tools
where they are as accurate as your agent's own and faster. Replacement is "Run
Tenjin's picks automatically", off by default. A name is the catalog's name or
id ("Exa" or exa); an unclear or unknown name saves nothing and lists what it
could mean. Showing, unblocking, resetting and pausing work offline. To pause
Tenjin:
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

  // The two everyday money commands, by their plain names. `tenjin wallet
  // fund` and `tenjin wallet balance` stay, the same commands under the group.
  fundCommand(
    leaf(WALLET, 'fund [amountUsd]', 'add funds in your browser, and watch them land'),
    'fund',
    runCommand,
  );
  balanceCommand(
    leaf(WALLET, 'balance', 'show your balance and spending limits', ['--timeout']),
    'balance',
    runCommand,
  );

  // Group-level flags so `tenjin wallet --json show` parses like the config group.
  const wallet = leaf(
    WALLET,
    'wallet',
    'create, show, fund, repair and send from the local wallet',
  ).description(
    'Manage the local x402 payment wallet the router and `tenjin pay` spend from. The private key is generated on this machine, stored encrypted, and never printed.',
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
    .summary('save the wallet passphrase so your agent can unlock it')
    .description(
      'Check the passphrase locally and save it in the OS keychain, or a file only you can read where no keychain is available. The wallet address stays the same. Enter the passphrase in the terminal prompt, never in chat. Start a new agent session afterwards and check it with doctor.',
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
  balanceCommand(
    addGlobalFlags(wallet.command('balance'), ['--timeout']).summary(
      'show your balance and spending limits (same as `tenjin balance`)',
    ),
    'wallet.balance',
    runCommand,
  );
  fundCommand(
    addGlobalFlags(wallet.command('fund [amountUsd]')).summary(
      'add funds in your browser (same as `tenjin fund`)',
    ),
    'wallet.fund',
    runCommand,
  );

  // The funds-out ESCAPE HATCH: human-invoked only. Deliberately absent from the
  // router's MCP tools (src/router/mcp.ts) and the plugin's skill; no
  // model-facing surface gains a send trigger. It lives under `wallet` with
  // every other verb that operates on the wallet.
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
    .option(
      '-X, --method <method>',
      'GET (default), POST (implied by a body), PUT, PATCH or DELETE',
    )
    .option('-d, --data <json>', 'JSON request body (sent as application/json)')
    .option('--data-raw <text>', "request body sent byte for byte; needs -H 'Content-Type: <type>'")
    .option('--max-price <usd>', 'hard price cap in decimal USD (never bypassed by --yes)')
    .option('--yes', 'bypass the interactive confirm only (not the price cap)')
    .option(
      '--ignore-warnings',
      'acknowledge direct-payment registry warnings only; all payment checks still apply',
    )
    .option('--print-body', 'print the full body instead of the capped preview')
    .option(
      '--quote',
      'probe only: report the 402 terms and the advertised request shape; opens no wallet, signs nothing',
    )
    .option(
      '-H, --header <line>',
      "a request header the endpoint asks for, as 'Name: value' (repeatable); payment, sign-in and bypass headers are refused",
      collect,
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin pay https://api.example.com/quote --max-price 0.05
  $ tenjin pay https://api.example.com/quote --json --max-price 0.05 --ignore-warnings --yes
  $ tenjin pay https://api.example.com/quote -d '{"symbol":"ETH"}' --yes
  $ tenjin pay https://api.example.com/search -d '{"q":"x"}' --quote
  $ tenjin pay https://api.example.com/search -d '{"q":"x"}' -H 'X-Api-Beta: 2026-08-28' --yes
  $ tenjin pay https://api.example.com/items/7 -X PATCH -d '{"name":"y"}' --max-price 0.05 --yes
  $ tenjin pay https://api.example.com/form --data-raw 'a=1' -H 'Content-Type: application/x-www-form-urlencoded' --quote
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
            ...(typeof o.dataRaw === 'string' ? { dataRaw: o.dataRaw } : {}),
            ...(typeof o.maxPrice === 'string' ? { maxPrice: o.maxPrice } : {}),
            ...(o.yes === true ? { yes: true } : {}),
            ...(o.printBody === true ? { printBody: true } : {}),
            ...(o.ignoreWarnings === true ? { ignoreWarnings: true } : {}),
            ...(o.quote === true ? { quote: true } : {}),
            ...(Array.isArray(o.header) && o.header.length > 0
              ? { header: o.header as string[] }
              : {}),
          },
          ctx,
        );
      });
    });
}

/**
 * `tenjin fund` and `tenjin wallet fund`. A checkout link moves no money; the
 * person completes payment in the browser, and the command watches for it.
 */
function fundCommand(cmd: Command, name: string, runCommand: Registration['runCommand']): void {
  cmd
    .description(
      'Open checkout in your browser to add funds, then watch the payment land: the page opening, the payment, and the new balance. Confirm the amount and any fee in the browser. Ctrl-C stops watching; it does not cancel checkout. With --usdc, show the address to send USDC to instead.',
    )
    .option('--no-open', 'print the checkout link without opening a browser')
    .option('--no-qr', 'no QR code, even when no browser can open the link')
    .option(
      '--no-wait',
      'return once the link is issued instead of watching for the payment (already the default when not at a terminal)',
    )
    .option('--usdc', 'send USDC from a crypto wallet instead: shows the address and its QR code')
    .option('--for <label>', 'what the money is for, shown on the checkout page (with --price)')
    .option('--price <usd>', 'the price of that call in USD (with --for)')
    .addOption(
      new Option('--source <where>', 'where the link was asked for')
        .choices(['install', 'agent', 'terminal'])
        .hideHelp(),
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin fund
  $ tenjin fund 10
  $ tenjin fund 5 --for "X post read" --price 0.006
  $ tenjin fund --usdc
`,
    )
    .action(async function (this: Command, amountUsd: string | undefined) {
      await runCommand(name, this, async (ctx) => {
        const o = this.opts();
        const { runFund } = await import('../commands/fund');
        return runFund(ctx, {
          ...(amountUsd !== undefined ? { amountUsd } : {}),
          ...(o.open === false ? { open: false } : {}),
          ...(o.qr === false ? { qr: false } : {}),
          ...(o.wait === false ? { wait: false } : {}),
          ...(o.usdc === true ? { usdc: true } : {}),
          ...(typeof o.for === 'string' ? { forLabel: o.for } : {}),
          ...(typeof o.price === 'string' ? { priceUsd: o.price } : {}),
          ...(typeof o.source === 'string'
            ? { source: o.source as import('../commands/fund').FundSource }
            : {}),
        });
      });
    });
}

/**
 * `tenjin balance` and `tenjin wallet balance`. Its `--timeout` is the wait's,
 * as a duration, in place of the global request timeout.
 */
function balanceCommand(cmd: Command, name: string, runCommand: Registration['runCommand']): void {
  cmd
    .description(
      'Show your Tenjin balance and the spending limits your agent works within. It is a read: no key is unlocked and nothing is spent. With --wait, watch until funds arrive, then print what was added: what your agent runs in the background after opening checkout.',
    )
    .option('--wait', 'wait until the balance rises, then print what arrived')
    // Shown here for its meaning with --wait; the root's --timeout takes the
    // value wherever it is placed, and parses the duration (cli.ts).
    .option('--timeout <duration>', 'with --wait, how long to wait, like 15m or 90s (default 15m)')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin balance
  $ tenjin balance --wait
  $ tenjin balance --wait --timeout 30m
`,
    )
    .action(async function (this: Command) {
      await runCommand(name, this, async (ctx) => {
        const o = this.opts();
        const { runBalance } = await import('../commands/balance');
        // A --timeout someone typed bounds the wait; the request default does not.
        const typed = this.getOptionValueSourceWithGlobals('timeout') === 'cli';
        return runBalance(ctx, {
          ...(o.wait === true ? { wait: true } : {}),
          ...(o.wait === true && typed ? { waitMs: ctx.flags.timeout } : {}),
        });
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
function targetFlags(o: Record<string, unknown>): Partial<Record<TargetKindFlag, string[]>> {
  const out: Partial<Record<TargetKindFlag, string[]>> = {};
  for (const key of Object.keys(TARGET_FLAGS) as TargetKindFlag[]) {
    if (Array.isArray(o[key])) out[key] = o[key] as string[];
  }
  return out;
}

/**
 * THE SETTINGS OPERATIONS, under `tenjin config` (plan 36). Each answers with
 * what it saved in the user's words and the command that undoes it, so an
 * agent reports the readback rather than assuming the write worked.
 */
function registerConfigRules(config: Command, reg: Registration): void {
  const { runCommand, addGlobalFlags } = reg;
  const rules = () => import('../commands/config-rules');
  const all: TargetKindFlag[] = ['task', 'category', 'provider', 'seller', 'service', 'source'];

  targetOptions(addGlobalFlags(config.command('prefer')), [
    'task',
    'category',
    'provider',
    'service',
    'source',
  ])
    .summary('set the order Tenjin tries allowed services in')
    .description(
      'Prefer providers, services or your accounts, in order. With --task or --category the preference is for that scope; with --source alone it is account-wide, and a task or category preference comes first. Repeating it replaces the list at that scope. Other allowed services stay available when a preferred one cannot meet a request: use only to forbid them. "Use my fal account for images" and "only use my account for images" are both prefer --category images --source fal.',
    )
    .option('--global', 'the account-wide preference (with --source)')
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config prefer --task "web research" --provider exa
  $ tenjin config prefer --task "web research" --provider exa --provider tavily
  $ tenjin config prefer --category images --source fal
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
    .summary("limit Tenjin's own picks to what you name")
    .description(
      'Limit what Tenjin picks on its own to what you name. --global with --category or --task limits which tasks Tenjin offers tools for; --task with --provider, --seller or --service limits who it picks for that one task and leaves other tasks alone. Repeating it replaces the set for that scope; blocks and other rules stay. When nothing allowed fits, Tenjin offers nothing on its own; you or your agent can still ask for any tool by name.',
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
    .summary('stop Tenjin offering what you name on its own')
    .description(
      "Block a provider, seller, service, task, category or account from what Tenjin offers and picks on its own; you or your agent can still ask for it by name. A provider block covers reviewed reseller routes through it. A block always wins: a preference or only rule it leaves unusable stays saved and is marked inactive. --source tenjin stops Tenjin offering its own tools, free ones too; jobs no connected account can do go back to your agent's own tools.",
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config block --provider firecrawl
  $ tenjin config block --service exa-contents
  $ tenjin config block --task "crypto price quote"
  $ tenjin config block --category images
  $ tenjin config block --source tenjin
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
  $ tenjin config unblock --source tenjin
`,
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.unblock', this, async (ctx) =>
        (await rules()).runConfigUnblock(targetFlags(o), ctx),
      );
    });

  targetOptions(addGlobalFlags(config.command('reset')), [
    'task',
    'category',
    'provider',
    'service',
    'source',
  ])
    .summary('remove one saved rule, or all of them')
    .description(
      'Remove exactly the rule named, offline. --preference removes a task or category preference (with --task or --category) or the account-wide one (--global), or with --source just that account from it. --restriction removes the only rules for a task or --global, or with --dimension just one. --capabilities removes the global task and category limit. --all removes every saved routing rule, blocks included. Otherwise blocks stay; spending limits, automatic use and your accounts always stay.',
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

  addGlobalFlags(config.command('speed <state>'))
    .summary('offer paid tools that are as accurate and faster: on or off')
    .description(
      "on: Tenjin also offers paid tools for jobs where a measured paid tool is as accurate as your agent's own tools and clearly faster. They cost more; your limits still apply. off (the default): Tenjin offers a paid tool only when your agent's own tools can't do the job as well. It never changes which service is picked. Works offline.",
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin config speed on
  $ tenjin config speed off
`,
    )
    .action(async function (this: Command, state: string) {
      await runCommand('config.speed', this, async (ctx) =>
        (await rules()).runConfigSpeed({ state }, ctx),
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

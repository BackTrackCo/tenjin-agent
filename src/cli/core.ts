import { homedir } from 'node:os';
import { Option, type Command } from 'commander';
import { CliError } from '../lib/errors';
import { PERMISSIONS_DOC_URL, SETTINGS_DOC_URL } from '../lib/permissions';
import { closestNames } from '../lib/name-match';
import { HARNESSES, type Harness } from '../router/names';
import type { TargetKind } from '../router/settings-wire';
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

  const config = leaf(SETUP, 'config', 'your rules, limits and settings')
    // An operand only so a mistyped command gets "Did you mean": commander
    // reads `config blok` as an argument to `config`, not an unknown command.
    .argument('[command]')
    // `config --all`. commander gives a parent option the flag wherever it is
    // placed, so `config reset --all` reaches reset through its parent too.
    .option('--all', 'print every setting with its value, where it comes from and what it does')
    .action(async function (this: Command, typed: string | undefined) {
      await runCommand('config', this, async (ctx) => {
        if (typed !== undefined) throw unknownConfigCommand(typed, this);
        const { runConfigList } = await import('../commands/config');
        return runConfigList(ctx, this.opts().all === true ? { all: true } : {});
      });
    });
  addGlobalFlags(config.command('get <key>'))
    .summary('print one value')
    .description("Print one setting's value as Tenjin uses it, defaults and environment included.")
    .addHelpText('after', configExamples(['get maxAutoSpend', 'get router.enabled'], EVERY_KEY))
    .action(async function (this: Command, key: string) {
      await runCommand('config.get', this, async (ctx) => {
        const { runConfigGet } = await import('../commands/config');
        return runConfigGet({ key }, ctx);
      });
    });
  addGlobalFlags(config.command('set <key> <value>'))
    .summary('set one value')
    .description(
      'Write one setting, checked against its key. Spend keys take decimal USD, such as 0.50.',
    )
    .option(
      '--project',
      "write a router key into this project's .tenjin/config.json, which is committed",
    )
    .option('--local', 'with --project, write .tenjin/config.local.json instead, which is yours')
    .addHelpText(
      'after',
      configExamples(
        ['set maxAutoSpend 0.50', 'set router.improve false', 'set --project router.enabled false'],
        EVERY_KEY,
      ),
    )
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
  addGlobalFlags(config.command('names [word...]'))
    .summary('every name you can use in a rule')
    .description(
      'List every name a rule can use, by kind, with the id to type after its flag. A word filters them; case, spaces and a typo are fine.',
    )
    .option('--kind <kind>', 'only one kind: task, category, provider, seller, service or account')
    .addHelpText(
      'after',
      configExamples(['names', 'names firecrawl', 'names --kind task'], SETTINGS_DOCS),
    )
    // Words unquoted, like `gh search`: `names web search` is one search.
    .action(async function (this: Command, words: string[]) {
      const o = this.opts();
      await runCommand('config.names', this, async (ctx) => {
        const { runConfigNames } = await import('../commands/config-names');
        return runConfigNames(
          {
            ...(words.length > 0 ? { search: words.join(' ') } : {}),
            ...(typeof o.kind === 'string' ? { kind: o.kind } : {}),
          },
          ctx,
        );
      });
    });

  registerConfigRules(config, reg);
  // Set last: commander copies a parent's help settings into each command
  // made after, and the operations keep commander's own layout.
  config.configureHelp({ formatHelp: () => CONFIG_HELP });

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

/**
 * `tenjin config --help`, laid out by hand the way gh and kubectl lay out a
 * command group (clig.dev): what it is in a line, its commands grouped by
 * what they are for, a few examples, and where to learn more. The fine print
 * lives in the settings docs, and each operation's flags in its own --help.
 * cli.test.ts checks that every operation registered here is listed.
 */
const CONFIG_HELP = `Usage: tenjin config [command] [options]

Your rules for what Tenjin offers on its own, plus your limits and settings.

Show
  tenjin config                 your rules, limits and what you changed
  tenjin config --all           every setting, with its default
  tenjin config names [word]    every name you can use in a rule

Change what Tenjin offers on its own
  block / unblock               never offer something, or undo that
  prefer                        try something first
  only                          offer only what you name
  reset                         remove a rule, or --all of them

Switches
  speed on|off                  also offer faster paid tools
  replacement on|off            run Tenjin's picks automatically (Claude Code)
  fallback on|off               use Tenjin's tool when your account refuses

Values
  get <key> / set <key> <value>

Examples
  tenjin config names firecrawl
  tenjin config block --provider firecrawl
  tenjin config prefer --task "web research" --provider exa

A tool you or your agent asks for by name always runs.
Learn more: tenjin config <command> --help · docs: ${SETTINGS_DOC_URL}
`;

/** The last line of an operation's help: where its names, keys or fine print are. */
const FIND_NAMES = 'Find names: tenjin config names <word>';
const EVERY_KEY = 'Every key, with what it does: tenjin config --all';
const SETTINGS_DOCS = `Learn more: ${SETTINGS_DOC_URL}`;

/** A config operation's help tail: two or three examples, then one pointer. */
function configExamples(examples: readonly string[], footer = FIND_NAMES): string {
  return `
Examples:
${examples.map((example) => `  $ tenjin config ${example}`).join('\n')}

${footer}
`;
}

/** `tenjin config blok`: the operations it could mean, like git's "Did you mean". */
function unknownConfigCommand(typed: string, config: Command): CliError {
  const operations = config.commands.map((command) => ({
    id: command.name(),
    label: command.name(),
  }));
  const near = closestNames(operations, typed).map(({ id }) => id);
  return new CliError('USAGE', `tenjin config has no command "${typed}".`, {
    fix: `${near.length > 0 ? `Did you mean: ${near.join(', ')}? ` : ''}See tenjin config --help.`,
  });
}

const TARGET_FLAGS: Record<TargetKind, string> = {
  task: 'a task, such as "web research" (repeatable)',
  category: 'a category of tasks, such as images (repeatable)',
  provider: 'a provider, such as exa (repeatable)',
  seller: 'who sells the call, such as stableenrich (repeatable)',
  service: 'one service, such as exa-search (repeatable)',
  source: "one of your accounts, or tenjin for Tenjin's own tools (repeatable)",
};

/**
 * `scopes` are the kinds this operation takes once, as the rule's scope (a
 * preference is for one task or category), so their help drops "(repeatable)".
 */
function targetOptions(
  cmd: Command,
  kinds: readonly TargetKind[],
  scopes: readonly TargetKind[] = [],
): Command {
  for (const kind of kinds) {
    const help = scopes.includes(kind)
      ? TARGET_FLAGS[kind].replace(' (repeatable)', '')
      : TARGET_FLAGS[kind];
    cmd.option(`--${kind} <name>`, help, collect);
  }
  return cmd;
}

/** The repeatable target flags, as the operations read them. */
function targetFlags(o: Record<string, unknown>): Partial<Record<TargetKind, string[]>> {
  const out: Partial<Record<TargetKind, string[]>> = {};
  for (const key of Object.keys(TARGET_FLAGS) as TargetKind[]) {
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
  const all = Object.keys(TARGET_FLAGS) as TargetKind[];

  targetOptions(
    addGlobalFlags(config.command('prefer')),
    ['task', 'category', 'provider', 'service', 'source'],
    ['task', 'category'],
  )
    .summary('try something first')
    .description(
      'Try what you name first, in order: for one task or category, or with --source alone for every job. Other allowed tools stay the fallback.',
    )
    .option('--global', 'the account-wide preference (with --source)')
    .addHelpText(
      'after',
      configExamples([
        'prefer --task "web research" --provider exa',
        'prefer --category images --source fal',
        'prefer --source apify',
      ]),
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
    .summary('offer only what you name')
    .description(
      'Offer only what you name: with --global, which tasks Tenjin does; with --task, who does that one task. Anything else still runs when asked for by name.',
    )
    .option('--global', 'apply everywhere: with --category or --task, which tasks Tenjin does')
    .addHelpText(
      'after',
      configExamples([
        'only --task "web research" --provider exa',
        'only --global --category images',
        'only --global --task "web research" --task "read an exact page"',
      ]),
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
    .summary('never offer something on its own')
    .description(
      'Never offer what you name on its own: a provider, seller, service, task, category or account. You or your agent can still ask for it by name.',
    )
    .addHelpText(
      'after',
      configExamples([
        'block --provider firecrawl',
        'block --task "crypto price quote"',
        'block --source tenjin',
      ]),
    )
    .action(async function (this: Command) {
      const o = this.opts();
      await runCommand('config.block', this, async (ctx) =>
        (await rules()).runConfigBlock(targetFlags(o), ctx),
      );
    });

  targetOptions(addGlobalFlags(config.command('unblock')), all)
    .summary('undo a block')
    .description('Remove the blocks you name, and nothing else. Works offline.')
    .addHelpText(
      'after',
      configExamples(['unblock --provider firecrawl', 'unblock --source tenjin']),
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
    .summary('remove a rule, or --all of them')
    .description(
      'Remove the one rule you name: a --preference, a --restriction (an only rule), the --capabilities limit, or --all of them, blocks included. Works offline.',
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
      configExamples([
        'reset --task "web research" --preference',
        'reset --task "web research" --restriction --dimension provider',
        'reset --all',
      ]),
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
            ...(o.all === true || this.parent?.opts().all === true ? { all: true } : {}),
            ...(typeof o.dimension === 'string' ? { dimension: o.dimension } : {}),
          },
          ctx,
        ),
      );
    });

  addGlobalFlags(config.command('speed <state>'))
    .summary('also offer faster paid tools: on or off')
    .description(
      "on: also offer paid tools as accurate as your agent's own and clearly faster, within your limits. off (the default): only when your agent's own can't do the job as well.",
    )
    .addHelpText('after', configExamples(['speed on', 'speed off'], SETTINGS_DOCS))
    .action(async function (this: Command, state: string) {
      await runCommand('config.speed', this, async (ctx) =>
        (await rules()).runConfigSpeed({ state }, ctx),
      );
    });

  addGlobalFlags(config.command('replacement <state>'))
    .summary("run Tenjin's picks automatically: on or off")
    .description(
      "Run Tenjin's pick in place of your agent's web search or page fetch, within your limits, instead of offering it first. Claude Code with the Tenjin plugin only; off by default.",
    )
    .option('--provider <name>', 'only when Tenjin picks this provider (repeatable)', collect)
    .option('--all-providers', 'for any allowed provider')
    .addHelpText(
      'after',
      configExamples([
        'replacement on --provider exa',
        'replacement on --all-providers',
        'replacement off',
      ]),
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

  addGlobalFlags(config.command('fallback <state>'))
    .summary("use Tenjin's tool when your account refuses: on or off")
    .description(
      "When one of your accounts refuses a call, on runs Tenjin's own tool in its place, from your Tenjin balance within your limits. off (the default) offers it and asks first.",
    )
    .option('--source <account>', 'the connected account, such as apify', collect)
    .addHelpText(
      'after',
      configExamples(['fallback on --source apify', 'fallback off --source apify']),
    )
    .action(async function (this: Command, state: string) {
      const o = this.opts();
      await runCommand('config.fallback', this, async (ctx) =>
        (await rules()).runConfigFallback(
          { state, ...(Array.isArray(o.source) ? { source: o.source as string[] } : {}) },
          ctx,
        ),
      );
    });
}

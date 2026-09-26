import { Option, type Command } from 'commander';
import { PERMISSIONS_DOC_URL } from '../lib/permissions';
import { SETUP, WALLET, type Registration } from './registration';

/**
 * The core product: setting this machine up, the wallet, and the one standard
 * x402 verb. Every other verb belongs to a product module beside this one, so
 * what a release ships is the list of `register*` calls in `cli.ts`.
 */
export function registerCore(reg: Registration): void {
  const { runCommand, leaf, addGlobalFlags } = reg;

  leaf(SETUP, 'install', 'set up Tenjin for your coding host and create a wallet')
    .addOption(
      new Option('--harness <host>', 'coding host').choices(['claude', 'codex']).default('claude'),
    )
    .description(
      'Set up Claude Code (default) or the Codex plugin (--harness codex), with the existing router and wallet. Codex hook trust is reviewed in /hooks; --approve-request grants its request tool.',
    )
    .option('--project', "write into this project's .claude/settings.json instead of your home one")
    .option('--no-wallet', 'create no wallet')
    .option(
      '--approve-request',
      'approve the Codex plugin request tool under existing wallet limits',
    )
    .option('--refresh', 're-register the hook entries this machine already has; add nothing')
    .option(
      '--status-line <mode>',
      'the live footer: `own` registers it when you have no status line of your own, `compose` appends it to the one you do have, `skip` leaves the setting alone',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ tenjin install
  $ tenjin install --project

Learn more:
  What the router may spend, and what leaves this machine:
  ${PERMISSIONS_DOC_URL}
`,
    )
    .action(async function (this: Command) {
      await runCommand('install', this, async (ctx) => {
        const o = this.opts();
        if (o.harness === 'codex') {
          const { runCodexSetup } = await import('../router/codex-install');
          return runCodexSetup(
            'install',
            {
              project: o.project === true,
              refresh: o.refresh === true,
              noWallet: o.wallet === false,
              approveRequest: o.approveRequest === true,
            },
            ctx,
          );
        }
        const { runRouterInstall } = await import('../router/install');
        const { statusLineMode } = await import('../router/status-line-wiring');
        return runRouterInstall(
          {
            ...(o.project === true ? { project: true } : {}),
            ...(o.refresh === true ? { refresh: true } : {}),
            ...(o.statusLine !== undefined
              ? { statusLine: statusLineMode(String(o.statusLine)) }
              : {}),
            ...(o.wallet === false ? { noWallet: true } : {}),
          },
          ctx,
        );
      });
    });

  leaf(SETUP, 'uninstall', 'remove what install wrote; the wallet is kept')
    .addOption(
      new Option('--harness <host>', 'coding host').choices(['claude', 'codex']).default('claude'),
    )
    .description(
      'Remove the selected host integration. Claude removes its hook entries, permission rule and MCP registration. Codex removes its plugin and keeps user tool policy. Your wallet, spend ledger and config are kept.',
    )
    .option('--project', "remove from this project's .claude/settings.json")
    .action(async function (this: Command) {
      await runCommand('uninstall', this, async (ctx) => {
        const o = this.opts();
        if (o.harness === 'codex') {
          const { runCodexSetup } = await import('../router/codex-install');
          return runCodexSetup('uninstall', { project: o.project === true }, ctx);
        }
        const { runRouterUninstall } = await import('../router/uninstall');
        return runRouterUninstall({ ...(o.project === true ? { project: true } : {}) }, ctx);
      });
    });

  leaf(SETUP, 'doctor', 'check this machine can run a lookup')
    .addOption(
      new Option('--harness <host>', 'coding host').choices(['claude', 'codex']).default('claude'),
    )
    .description(
      'Check Claude lookup readiness, or Codex plugin configuration, hook trust and web qualification (--harness codex). Codex MCP connectivity and payment readiness require a new session and tenjin status. Exits nonzero if a required configuration check fails.',
    )
    .option('--project', "check this project's .claude/settings.json, as --project installed it")
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
        if (this.opts().harness === 'codex') {
          const { runCodexSetup } = await import('../router/codex-install');
          return runCodexSetup('doctor', { project: this.opts().project === true }, ctx);
        }
        const { runRouterDoctor } = await import('../router/doctor');
        return runRouterDoctor(ctx, this.opts().project === true ? { project: true } : {});
      });
    });

  leaf(SETUP, 'update', 'update tenjin-cli to the newest published version')
    .description(
      'Update tenjin-cli to the newest version npm publishes on the latest tag. It then runs `install --refresh` on the new binary, so every profile on this machine gets the skills and hook scripts of the build that just landed.',
    )
    .option('--check', 'report whether a newer version exists without installing it')
    .action(async function (this: Command) {
      await runCommand('update', this, async (ctx) => {
        const { runUpdate } = await import('../commands/update');
        return runUpdate({ check: this.opts().check === true }, ctx);
      });
    });

  const config = leaf(SETUP, 'config', 'read and set config values').description(
    'Print every effective config value, or read and write one. Values are stored in config.json under your Tenjin data dir (~/.tenjin by default).',
  );
  config.addHelpText(
    'after',
    `
Examples:
  $ tenjin config
  $ tenjin config set publish.mode review
  $ tenjin config set maxAutoSpend 0.25
  $ tenjin config set --project router.enabled false
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

  // Group-level flags so `tenjin wallet --json show` parses like the config group.
  const wallet = leaf(
    WALLET,
    'wallet',
    'create, show, fund and send from the local wallet',
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
    .action(async function (this: Command) {
      await runCommand('wallet.create', this, async (ctx) => {
        const o = this.opts();
        const { runWalletCreate } = await import('../commands/wallet');
        return runWalletCreate(ctx, o.replace === true ? { replace: true } : {});
      });
    });
  addGlobalFlags(wallet.command('show'))
    .summary('show the wallet address and key source')
    .description(
      'Print the active wallet address and where its key comes from. The private key is never printed, by any flag.',
    )
    .action(async function (this: Command) {
      await runCommand('wallet.show', this, async (ctx) => {
        const { runWalletShow } = await import('../commands/wallet');
        return runWalletShow(ctx);
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
  // checkout page. The browser open and balance poll below are CLI-only, and
  // both are off unless stdout is a TTY: the link dies in ~5 minutes, so a piped
  // run takes it off stderr immediately rather than off a poll that outlives it.
  addGlobalFlags(wallet.command('fund [amountUsd]'))
    .summary('card-fund this wallet through Coinbase Onramp')
    .description(
      'Mint a Coinbase Onramp checkout link bound to THIS wallet, open it in the browser, and wait for the USDC to land on Base. Minting moves no money: a human completes the payment on pay.coinbase.com.',
    )
    .option('--no-open', 'print the checkout link without opening a browser')
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

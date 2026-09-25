# tenjin

Give Claude Code a wallet so it can pay for what it can't find on its own: web research, reading one exact page, a crypto price, a company profile, an email check, a person lookup, or a hard calculation. It pays each provider a few cents in USDC on Base. No API keys, no accounts.

## Quick start

You need Node.js 24 or newer and Claude Code.

```bash
npm i -g tenjin-cli
tenjin install
tenjin wallet fund
```

`tenjin install` sets up Claude Code and creates your wallet:

```text
✓ Tenjin is set up for Claude Code
✓ Wallet created: 0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf
  Automatic router: up to $0.25 per call; daily limit $5 a day

Next: tenjin wallet fund, then restart Claude Code
```

`tenjin wallet fund` opens a Coinbase checkout for your wallet. You can also send USDC on Base to the address above. Then restart Claude Code.

## Using it

There's nothing else to run. Ask for something your agent can't settle on its own:

```text
Check the BTC and ETH prices.
Research the x402 settlement path, then read that spec page.
Verify whether ada@example.com is deliverable.
Integrate x^2 sin(x) dx from 0 to pi.
```

Each answer says who supplied it and what it cost. Picking a provider is free; you only pay the provider.

## Live status line

While a lookup runs, the bottom of your terminal names it:

```text
x402 · request: calling pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest · {"query":{"symbol":"BTC,ETH"}}
```

`selecting service` while a provider is being picked, then the endpoint actually called with its parameters, then the outcome and the price. Each state stays until the next one, and about ten seconds later the line is `x402 · ready` again. The routing gate has its own states, `x402 · prompt:` and `x402 · search:`, so a turn that stays on your own tools says so. It reads local files only: no network call, no wallet, and nothing it does can affect a lookup or a payment.

`tenjin install` sets it as Claude Code's [status line](https://code.claude.com/docs/en/statusline) only if you do not already have one. If you do, yours is left exactly as it is and the install prints the command that shows both; `tenjin install --status-line compose` writes that command for you, and `--status-line skip` leaves the setting alone.

## Spending limits

A fresh install sets automatic router limits of $0.25 per call and $5 per day, only where no setting exists. The daily budget uses the existing 24 hour ledger window and defaults to $5 even before install. Explicit zero in either limit blocks positive automatic payments; `sessionBudget none` removes only the automatic daily ceiling. Manual `tenjin pay` ignores both limits and always requires consent for the quoted payment, interactively or with `--yes` after explicit user approval. It is never an autonomous workaround for a router refusal. Change automatic limits any time:

```bash
tenjin status                          # what you've spent today
tenjin config set maxAutoSpend 0.10    # per lookup
tenjin config set sessionBudget 10     # per day
tenjin wallet balance
```

Keep this a small wallet: pocket money for your agent. The private key is created and stored encrypted on your machine, and never leaves it.

## Update or remove

```bash
tenjin update      # newest version; your wallet and settings stay
tenjin uninstall   # removes the Claude Code setup; your wallet stays
```

Use `tenjin install --project` to set it up for one project instead of your whole machine.

When refreshing from home, Tenjin uses the existing user MCP registration if
present, or preserves a project-only registration. With neither registration,
it defaults to user scope. This also applies when home is reached through a
symlink; `tenjin install --refresh --project` explicitly selects project scope.

If updating to `0.1.0-alpha.18` caused Claude Code to ask about a new project
MCP server named `x402`, that release could accidentally register it in
`~/.mcp.json` while refreshing your user install. After upgrading to a release
with the fix, inspect that file. If its `x402` entry runs `tenjin mcp` and you
did not intentionally install it at project scope in your home directory,
remove just that registration:

```bash
(cd ~ && claude mcp remove x402 -s project)
```

This keeps other MCP entries and the user registration in `~/.claude.json`.
Run `tenjin install` to ensure the user setup is present, then restart Claude
Code. Do not use `tenjin uninstall --project` from home for this cleanup: its
settings path is also the user settings path.

To keep it installed and stop it, `tenjin config set router.enabled false` stops the router on this machine, and `tenjin config set --project router.enabled false` stops it in this repository.

## More

- [How a lookup runs, what it sends, and what install writes](./docs/agent-permissions.md)
- [Safety model](./docs/safety-model.md)
- `tenjin pay <url>` pays any x402 endpoint you name, under the same limits.
- Pass `--json` to any command for machine-readable output. Exit codes: `0` success, `1` runtime or network failure, `2` usage error, `3` policy refusal, `4` payment failure.

## Developing

Before submitting a contribution, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the
contributor agreement and acceptance instructions.

```bash
pnpm install
pnpm run githooks   # once, to use the repo's git hooks
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run lint
```

Release notes live in [RELEASING.md](./RELEASING.md).

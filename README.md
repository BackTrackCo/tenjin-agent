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
  Spends at most $0.25 a lookup, $5 a day

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

`routing` while a provider is being picked, then the endpoint actually called with its parameters, then the outcome and the price. Idle it reads `x402 · ready`. It reads local files only: no network call, no wallet, and nothing it does can affect a lookup or a payment.

`tenjin install` sets it as Claude Code's [status line](https://code.claude.com/docs/en/statusline) only if you do not already have one. If you do, yours is left exactly as it is and the install prints the command that shows both; `tenjin install --status-line compose` writes that command for you, and `--status-line skip` leaves the setting alone.

## Spending limits

Out of the box, a single lookup can cost at most $0.25 and everything together at most $5 a day, with no prompts under that. Change them any time:

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

## More

- [How a lookup runs, what it sends, and what install writes](./docs/agent-permissions.md)
- [Safety model](./docs/safety-model.md)
- `tenjin pay <url>` pays any x402 endpoint you name, under the same limits.
- Pass `--json` to any command for machine-readable output. Exit codes: `0` success, `1` runtime or network failure, `2` usage error, `3` policy refusal, `4` payment failure.

## Developing

```bash
pnpm install
pnpm run githooks   # once, to use the repo's git hooks
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run lint
```

Release notes live in [RELEASING.md](./RELEASING.md).

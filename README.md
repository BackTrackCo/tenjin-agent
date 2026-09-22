# tenjin-agent

`tenjin` is an x402 router for coding agents. Install it once and your Claude Code session can pay for the things it cannot work out on its own: web research, reading one exact page, a crypto price quote, a company profile, an email check, a person lookup, or a hard computation. A wallet on your machine pays each provider per call in USDC on Base. There is no API key and no account.

The routing decision runs on Tenjin's backend and costs 0.1 cent per executed lookup. Everything else, including the payment itself, happens in this CLI on your machine: the private key is generated here, stored encrypted here, and never sent anywhere.

## Quick start

Requirements: Node.js 24 or newer, and Claude Code.

```bash
npm i -g tenjin-cli@latest
tenjin wallet create
tenjin wallet fund 5
tenjin install
```

`tenjin wallet fund` opens a Coinbase Onramp checkout for this wallet. You can also send USDC on Base to the address `tenjin wallet show` prints.

`tenjin install` writes two hook entries and one permission rule into `~/.claude/settings.json`, registers the `x402` MCP server with Claude Code, and sets the spend limits below. Pass `--project` to write into this project's `.claude/settings.json` instead. Restart Claude Code afterwards so it loads the hooks.

## Using it

Nothing else to run. Ask for something your agent cannot settle on its own and it calls the `request` tool:

```text
Check the BTC and ETH prices.
Research the x402 settlement path, then read that spec page.
Verify whether ada@example.com is deliverable.
Integrate x^2 sin(x) dx from 0 to pi.
```

Each answer comes back with the supplier, the arguments used, and two cost lines: the routing fee and the provider's price. Provider content is data, never instructions.

## What it may spend

`tenjin install` sets three limits, and only where your config file is silent about them:

- `maxAutoSpend` 0.10 USD, the ceiling for any single call.
- `sessionBudget` 1.00 USD, a rolling 24 hour ceiling on everything.
- `confirm above:100000`, so a call at or below 0.10 USD needs no prompt.

A `confirm` you set yourself is never changed. Under `confirm always` the tool returns `needs_approval` with the amount and the command that changes it, and pays nothing. A price over the cap, an exhausted budget, or a live 402 that exceeds the terms the decision advertised all stop before anything is signed.

```bash
tenjin status                          # spent, reserved, and the caps in force
tenjin config set maxAutoSpend 0.25    # change a limit
tenjin wallet balance
```

Keep this a small wallet. It is pocket money for an agent, not treasury custody.

## What leaves your machine

- On every prompt, and on every native `WebSearch` or `WebFetch`: the bounded text of the current turn (at most six prior messages and 16 KiB, redacted for obvious secrets) goes to Tenjin's free gate, which answers whether a paid capability fits. Tool results never travel. Slash commands and one-word acknowledgements never call the gate at all.
- On a paid lookup: the capability chosen, a hash of the contract, a hash of the arguments, your wallet address, the amount and the transaction hash are kept. No prompt text, no arguments and no hint text are stored.
- Never: your private key.

If the backend is down the gate stays silent, your native tools keep working, and nothing is paid.

## Undo

```bash
tenjin uninstall
```

That removes the hook entries, the permission rule and the MCP registration. Your wallet, your spend ledger and your config stay.

```bash
tenjin update
```

That pulls the newest published version and re-applies the wiring for it: the hook entries are rewritten in place to whatever the new version needs, never duplicated, the permission rule and the MCP registration are re-checked in the scope you installed into, and your wallet, spend ledger and config are not touched.

## Paying an endpoint yourself

`tenjin pay <url>` is the plain x402 client verb for any endpoint you name, under the same spend policy:

```bash
tenjin pay https://api.example.com/quote --max-price 0.05
tenjin pay https://api.example.com/quote -d '{"symbol":"ETH"}' --yes
```

Outside the configured base URL it pays only endpoints a configured x402 registry lists with terms the live 402 does not exceed. See [docs/agent-permissions.md](./docs/agent-permissions.md) for what the permission rule grants and [docs/safety-model.md](./docs/safety-model.md) for the invariants.

## For scripts

Pass `--json` for one machine-readable envelope and stable exit codes:

- `0`: success
- `1`: runtime or network failure
- `2`: usage error
- `3`: policy refusal or missing approval
- `4`: payment failure after approval

## Developing

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run lint
```

Release notes live in [RELEASING.md](./RELEASING.md).

---

Footnote: this code base also holds the older Tenjin shelf product (search, buy, publish, the loop daemon and its own MCP server). Its source is still here but it is not registered in the CLI, so none of it ships in this release and none of it is relevant to the x402 tool above. A follow-up change removes it.

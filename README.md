<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo-light.svg" alt="Tenjin" width="220">
  </picture>
</p>

<h3 align="center">The tool router for coding agents. Tenjin picks the right tool when your agent needs one, and one wallet pays for every call.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/tenjin-cli"><img src="https://img.shields.io/npm/v/tenjin-cli?color=C85A3B&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-1C1A17" alt="Works with Claude Code">
  <img src="https://img.shields.io/badge/payments-x402-8C9A7E" alt="Payments via x402">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-it-can-do">Tools</a> ·
  <a href="#wallet-and-payments">Wallet &amp; payments</a> ·
  <a href="#request-a-tool">Request a tool</a>
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="Tenjin in Claude Code: research, live crypto prices, company lookup, email verification, and computation" width="720">
</p>

---

## Why

Giving your agent good tools is a chore today:

- **A key for every tool.** Sign up, pick a plan, paste an API key into a config file. Five tools, five accounts.
- **MCP servers crowd the context.** Every server you install loads its tool definitions into every session, needed or not.
- **Your agent forgets anyway.** It reaches for plain web search out of habit, so you write rules to remind it, and it still slips.
- **Some tools you need once.** Installing something permanent for a one-off lookup isn't worth the setup.

Tenjin handles all of it. Install it once and keep working. The Tenjin router watches the moments where a tool could help: your prompt, your agent's web searches and page fetches, the tasks it hands to subagents, and the questions it asks you. When a curated tool beats what your agent was about to do, the router suggests it and your agent calls it. Your wallet pays for each call through [x402](#wallet-and-payments), so you manage no keys and install nothing new.

## Quick start

Requires Node.js 24 or newer and [Claude Code](https://code.claude.com). Codex support is on the way.

```bash
npm i -g tenjin-cli
tenjin install          # sets up Claude Code and creates your wallet
tenjin wallet fund 2    # optional: add $2 with a card, via Coinbase
```

```text
✓ Tenjin is set up for Claude Code
✓ Wallet created: 0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf
  Automatic router: up to $0.25 per call; daily limit $5 a day

Next: tenjin wallet fund, then restart Claude Code
```

Restart Claude Code. That's it.

Then work as usual. Try:

```text
> What are BTC and ETH trading at?
> How do I paginate list results with the Stripe Node SDK?
> Is ada@example.com a deliverable address?
> Integrate x^2 sin(x) dx from 0 to pi.
```

Each answer names the provider and the price. Your agent keeps its own tools, and the router steps in only when it has something better.

## What it can do

The router picks from a catalog we curate and maintain. When nothing in it fits, it can point your agent at a reviewed third-party pay-per-call service from the [Tenjin list](#tenjin-list-and-experimental-bazaar), and your agent decides whether to use it or to ask you first. Routing is free: you pay the provider's price and nothing else.

| Tool                                                           | What your agent gets                                                                      | Price per call |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| **Docs lookup** · [Context7](https://context7.com)             | Current, version-specific docs for a library or API                                       | **Free**       |
| **Web research** · [Exa](https://exa.ai)                       | Search results with the page content, not just links                                      | $0.007         |
| **Read a page** · [Firecrawl](https://firecrawl.dev)           | One exact page as clean text, even when a plain fetch fails                               | $0.01          |
| **Crypto prices** · [CoinMarketCap](https://coinmarketcap.com) | Live quotes for any coin                                                                  | $0.01          |
| **Compute** · [Wolfram Alpha](https://www.wolframalpha.com)    | Math, unit conversions, science and data questions                                        | $0.02          |
| **Email check** · [Hunter](https://hunter.io)                  | Whether an address is real and deliverable                                                | $0.008         |
| **Person lookup** · [Apollo](https://www.apollo.io)            | A professional profile and work email from a name and company, a LinkedIn URL or an email | $0.01          |
| **Company profile** · [Apollo](https://www.apollo.io)          | Industry, headcount, revenue and funding from a domain                                    | $0.01          |
| **Company match** · [CompanyEnrich](https://companyenrich.com) | The company behind a name or a social URL                                                 | $0.01225       |
| **X posts** · [glim](https://glim.sh)                          | Posts matching a search, or one post with its thread                                      | $0.005         |
| **Reddit** · [glim](https://glim.sh)                           | Posts matching a search, or one thread with its comments                                  | $0.01 / $0.005 |

Every tool, including the Tenjin list, with current prices: [tenjin.sh/tools](https://tenjin.sh/tools). More are added by demand: [tell us what you want](#request-a-tool).

### Tenjin list and experimental Bazaar

**The Tenjin list is on by default.** When nothing in the catalog fits a step (such as generating a sound effect), the router may suggest one third-party pay-per-call x402 service that Tenjin has reviewed. The suggestion names the seller, the URL, the price and the input it takes, and your agent judges whether to use it or to ask you first. It is paid like any lookup, under your spend limits.

**The open Bazaar is experimental and off by default.** Turn it on with:

```sh
tenjin config set experimental.bazaar on
```

With it on, the router may also suggest sellers from Coinbase's open x402 Bazaar, and to find them, short snippets of your prompts are sent to Coinbase's public Bazaar search. Those sellers are unreviewed third parties, matches can be noisy, prices can vary with the input, and payments are real, under your spend limits. `tenjin config` and `tenjin doctor` show both settings. Turn it off with `tenjin config set experimental.bazaar off`.

## How it works

```mermaid
flowchart LR
    A["Your prompt,<br>a web search,<br>or a subagent task"] --> B{"Tenjin<br>router"}
    B -- "a tool fits" --> C["Agent calls it<br>through x402"]
    C --> D["Wallet pays the provider,<br>result comes back"]
    B -- "nothing better" --> E["Agent carries on"]
```

The Tenjin router hooks into Claude Code at your prompt, before each web search or page fetch, when your agent hands work to a subagent, and around a question your agent asks you. At each point it asks Jev, a decision model from [TypeSafe](https://typesafe.ai), whether a tool in the catalog fits. When none does, Jev may pick one third-party service from a short list matching the step (the Tenjin list, plus the open Bazaar if you turned it on), or none. Either way Jev only chooses from a list, so it never writes a call or an instruction for your agent; a third-party listing's description is the seller's own, and your agent judges it.

When one fits, your agent sees a one-line suggestion with the tool and its price, and calls it through Tenjin's `x402` MCP server: the offer's id alone shows the tool's inputs, an example and what it returns, and the id with the agent's input runs it. Tenjin builds the call, pays the provider from your wallet, within your limits, and hands back the result. Your status line shows the call as it happens:

```text
x402 · request: calling pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest · {"query":{"symbol":"BTC,ETH"}}
```

To pick a tool, the router sends your prompt and recent messages with secrets masked, plus the searches, URLs, subagent tasks and questions it routes; tool results stay on your machine. [What it sends, and everything install writes →](./docs/agent-permissions.md#what-the-hooks-send)

## Wallet and payments

Tenjin pays for tools with [x402](https://www.x402.org), an open standard that builds payments into HTTP. A paid endpoint answers `402 Payment Required` with its price, the client signs a payment for that amount, and the endpoint returns the result. Neither side needs an account or an API key. Read more: [x402.org](https://www.x402.org) · [whitepaper](https://www.x402.org/x402-whitepaper.pdf) · [Coinbase docs](https://docs.cdp.coinbase.com/x402/welcome) · [spec and SDKs](https://github.com/coinbase/x402).

### Your wallet

`tenjin install` creates a wallet on your machine that holds [USDC](https://www.circle.com/usdc) on [Base](https://base.org). Tenjin encrypts the private key, unlocks it through your OS keychain, and never sends it anywhere. Tenjin never holds or moves your funds. Paying a provider costs no gas.

### Limits

| Limit      | Default | Change it                             |
| ---------- | ------- | ------------------------------------- |
| Per lookup | $0.25   | `tenjin config set maxAutoSpend 0.10` |
| Per day    | $5      | `tenjin config set sessionBudget 2`   |

`tenjin install` asks you to approve these limits, or tells your agent to ask you when the agent runs it. [How the limits work →](./docs/agent-permissions.md#what-bounds-a-payment)

### Funding

`tenjin wallet fund 2` opens a Coinbase Onramp checkout for your wallet: pay by card, or Apple Pay where your region supports it. Sign in to Coinbase or create an account during checkout. You can also send USDC on Base to the address `tenjin wallet show` prints.

$1–2 goes a long way. $2 covers about 280 web searches, 200 page reads or 100 Wolfram Alpha answers.

### Withdrawing

`tenjin wallet send <amount> USDC <address>` sends funds to any address. It's a regular onchain transfer, so it needs a little ETH on Base for gas.

## Everyday commands

```bash
tenjin status                  # what you've spent today
tenjin wallet balance          # what's left
tenjin wallet fund 5           # top up
tenjin payments reconcile      # settle paid lookups whose settlement was unknown
tenjin update                  # newest version; wallet and settings stay
tenjin config set router.enabled false             # pause the router on this machine
tenjin config set --project router.enabled false   # ...or just in this repo
tenjin uninstall               # remove the Claude Code setup; your wallet stays
```

Use `tenjin install --project` to set it up for a single project. Add `--json` to any command for machine-readable output.

Every paid lookup is recorded on your machine, with the files and full results it returned. [Where they live, and what `payments reconcile` does →](./docs/agent-permissions.md#what-a-paid-lookup-leaves-on-your-machine)

<details>
<summary>Status line: keeping your own</summary>

`tenjin install` sets Claude Code's [status line](https://code.claude.com/docs/en/statusline) only if you don't already have one. If you do, yours is left alone and the install prints a command that shows both; `tenjin install --status-line compose` writes it for you, and `--status-line skip` leaves the setting untouched. The status line reads local files only: no network, no wallet, and it can't affect a lookup or a payment.

</details>

<details>
<summary>Spending limits: the fine print</summary>

Limits are set only where no setting exists yet, so an update never overwrites yours. The daily budget is a rolling 24-hour window. Setting either limit to `0` blocks automatic payments; `tenjin config set sessionBudget none` removes the daily ceiling only.

`tenjin pay <url>` pays any x402 endpoint you name. It ignores the automatic limits and always asks for your consent to the quoted price, interactively or with `--yes`. It is never used as a workaround when the router refuses. See the [safety model](./docs/safety-model.md).

</details>

## Request a tool

Tenjin is in alpha, and the catalog grows with what people ask for. Missing a service your agent keeps needing? Hit a lookup that went to the wrong place? We want to hear it.

- **[Request a tool →](https://github.com/BackTrackCo/tenjin-agent/issues/new?title=Tool%20request%3A%20&labels=enhancement)**
- **[Report a bug →](https://github.com/BackTrackCo/tenjin-agent/issues/new?labels=bug)**

## Learn more

- [How a lookup runs, what it sends, and what install writes](./docs/agent-permissions.md)
- [Safety model](./docs/safety-model.md)
- [Troubleshooting](./docs/troubleshooting.md), including a stray `x402` server in `~/.mcp.json` after `0.1.0-alpha.18`

## Developing

Before contributing, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the contributor agreement.

```bash
pnpm install
pnpm run githooks   # once, to use the repo's git hooks
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run lint
```

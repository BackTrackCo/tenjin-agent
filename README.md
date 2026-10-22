<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo-light.svg" alt="Tenjin" width="220">
  </picture>
</p>

<h3 align="center">The tool router for coding agents.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/tenjin-cli"><img src="https://img.shields.io/npm/v/tenjin-cli?color=C85A3B&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-1C1A17" alt="Works with Claude Code">
  <img src="https://img.shields.io/badge/payments-x402-8C9A7E" alt="Payments via x402">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#wallet-and-limits">Wallet and limits</a>
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="Tenjin in Claude Code: research, live crypto prices, company lookup, email verification, and computation" width="720">
</p>

## Why

Giving your coding agent good tools is a chore:

- **A key for every tool.** Sign up, pick a plan, paste an API key. Five tools, five accounts.
- **MCP servers crowd the context.** Each one loads its tool list into every session, needed or not.
- **Your agent forgets anyway.** It reaches for plain web search, so you write rules, and it still slips.
- **Some tools you need once.** A one-off lookup isn't worth the setup.

With Tenjin, you install once and keep working. The router suggests the right tool when it helps, and your wallet pays per call. No keys, no extra servers, no rules.

## Install

Paste this into Claude Code:

```text
Install Tenjin from tenjin.sh
```

Your agent asks before it installs or spends anything, then sets everything up. Start a new session, and the router is on.

Or from a terminal:

```bash
npm i -g tenjin-cli
tenjin install          # adds the plugin and creates your wallet
tenjin wallet fund 5    # optional: add $5 with a card, via Coinbase
```

Needs Claude Code 2.1.287+ and Node.js 22+. Codex support is on the way.

Then work as usual. Try:

```text
> What are BTC and ETH trading at?
> How do I paginate list results with the Stripe Node SDK?
> Is ada@example.com a deliverable address?
> Integrate x^2 sin(x) dx from 0 to pi.
```

## Tools

| Your agent needs                                   | Provider                       |
| -------------------------------------------------- | ------------------------------ |
| Web research                                       | Exa                            |
| A page's contents                                  | Firecrawl                      |
| Current library docs                               | Context7                       |
| Math and computation                               | Wolfram Alpha                  |
| Live crypto prices                                 | CoinMarketCap                  |
| People, companies and emails                       | Apollo, CompanyEnrich, Hunter  |
| X and Reddit                                       | glim                           |
| Images, video, voice, papers, SEC filings and more | Reviewed pay-per-call services |

Most lookups cost a cent or two. [Every tool and its price →](https://tenjin.sh/tools) · [Request a tool](https://github.com/BackTrackCo/tenjin-agent/issues/new?title=Tool%20request%3A%20&labels=enhancement)

## How it works

1. The router watches the moments a tool could help: your prompt, each web search or page fetch, each task handed to a subagent, and each question your agent asks you.
2. Jev, a decision model from [TypeSafe](https://typesafe.ai), picks one tool from the catalog, or none. Your agent sees one line naming the tool and its price.
3. Your agent calls it through the plugin's `request` tool, and your wallet pays the provider. When nothing fits, your agent carries on with its own tools.

The router sees your prompt and up to six earlier messages, with secrets masked, and never sees tool results. [What the hooks send →](./docs/agent-permissions.md#what-the-hooks-send)

## Wallet and limits

`tenjin install` creates a wallet on your machine that holds USDC on Base. Its key never leaves your machine, and Tenjin never holds your funds. Payments run over [x402](https://www.x402.org) ([whitepaper](https://www.x402.org/x402-whitepaper.pdf), [Coinbase docs](https://docs.cdp.coinbase.com/x402/welcome)).

| Limit    | Default | Change it                             |
| -------- | ------- | ------------------------------------- |
| Per day  | $5      | `tenjin config set sessionBudget 2`   |
| Per call | $0.25   | `tenjin config set maxAutoSpend 0.50` |

A call over a limit pays nothing until you say yes. Routing costs $0.003 a call. [How the limits and the fee work →](./docs/agent-permissions.md#what-bounds-a-payment)

Add funds with `tenjin wallet fund 5`, or send USDC on Base to the address `tenjin wallet address` prints.

## Commands

```bash
tenjin status                          # spent today, and your limits
tenjin wallet balance                  # what's left
tenjin payments                        # paid lookups from this machine
tenjin doctor                          # check that a lookup can run
tenjin update                          # newest version; wallet and settings stay
tenjin config set router.enabled false # pause the router
tenjin uninstall                       # remove the plugin; your wallet stays
```

## Learn more

- [Permissions, hooks, and what install writes](./docs/agent-permissions.md)
- [Safety model](./docs/safety-model.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Contributing](./CONTRIBUTING.md)

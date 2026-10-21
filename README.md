<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo-light.svg" alt="Tenjin" width="220">
  </picture>
</p>

<h3 align="center">The Tenjin router picks the right tool when your coding agent needs one, and one wallet pays for every call.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/tenjin-cli"><img src="https://img.shields.io/npm/v/tenjin-cli?color=C85A3B&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code-1C1A17" alt="Works with Claude Code">
  <img src="https://img.shields.io/badge/payments-x402-8C9A7E" alt="Payments via x402">
</p>

<p align="center">
  <img src="./assets/demo.gif" alt="Tenjin in Claude Code: research, live crypto prices, company lookup, email verification, and computation" width="720">
</p>

---

Giving a coding agent good tools is a chore. Every tool wants its own account and API key. Every MCP server you add loads its tool definitions into every session, whether the session needs them or not. You write rules so the agent remembers to use them, and it reaches for plain web search anyway. And some tools you need once, for a single lookup that isn't worth the setup.

The Tenjin router replaces all of that with one install. It watches the moments where a tool could help, suggests the one that fits, and your wallet pays the provider per call. You keep no API keys, and one plugin stands in for every tool in the catalog.

## Install

Paste this into Claude Code or Claude Desktop:

```text
Install Tenjin from tenjin.sh
```

Your agent asks one question, "Use the defaults ($5 a day, $0.25 a call) or set your own limits", then installs the plugin and creates a wallet. If the wallet is empty, it asks whether to add $5 now. Type `/reload-plugins` or start a new session, and the router is on. It needs Claude Code 2.1.287 or newer.

From a terminal, with Node.js 22 or newer:

```bash
npm i -g tenjin-cli
tenjin install          # asks about limits, adds the plugin, creates your wallet
tenjin wallet fund 5    # add $5 with a card, through Coinbase
```

`tenjin install --project` sets it up for one project only.

## How it works

The router hooks into Claude Code where a tool could help: your prompt, each web search or page fetch (before it runs, and again if it comes back short), each task your agent hands to a subagent, and each question it asks you. At each one, Jev, a decision model from [TypeSafe](https://typesafe.ai), picks a tool from the catalog or none. It only picks: it never writes the call or an instruction for your agent.

When a tool fits, your agent sees one line naming it and its price, and calls it through the plugin's `request` tool. Tenjin checks the input against the tool's spec, pays the provider from your wallet within your limits, and hands back the result. When nothing fits, your agent carries on with its own tools. A search for a library's documentation runs as written, with current docs from Context7 added above the results.

To decide, the router sends your current prompt and up to six earlier messages, with secrets masked, plus the search, URL, task or question it is routing. It never sends tool results. [What the hooks send, and everything install writes →](./docs/agent-permissions.md#what-the-hooks-send)

## Tools

The catalog covers web research (Exa), page reads (Firecrawl), library docs (Context7), computation (Wolfram Alpha), live crypto prices (CoinMarketCap), people, company and email lookups (Apollo, CompanyEnrich, Hunter), and X and Reddit (glim), plus reviewed pay-per-call services for images, video, voiceovers, music, transcription, academic papers, SEC filings, PDFs, screenshots and more. Most lookups cost a cent or two. [Every tool and its current price →](https://tenjin.sh/tools)

Missing one your agent keeps needing? [Request a tool](https://github.com/BackTrackCo/tenjin-agent/issues/new?title=Tool%20request%3A%20&labels=enhancement) or [report a bug](https://github.com/BackTrackCo/tenjin-agent/issues/new?labels=bug).

**Experimental:** `tenjin config set experimental.bazaar on` lets the router also suggest unreviewed sellers from Coinbase's open x402 Bazaar. To find them, short snippets of your prompts go to Coinbase's public Bazaar search. It is off by default.

## Wallet and limits

`tenjin install` creates a wallet on your machine that holds USDC on Base. The CLI encrypts its private key, unlocks it through your OS keychain, and never sends it anywhere. Tenjin never holds your funds. Payments run over [x402](https://www.x402.org) ([whitepaper](https://www.x402.org/x402-whitepaper.pdf), [Coinbase docs](https://docs.cdp.coinbase.com/x402/welcome)), and paying a provider costs no gas.

| Limit    | Default | Change it                             |
| -------- | ------- | ------------------------------------- |
| Per day  | $5      | `tenjin config set sessionBudget 2`   |
| Per call | $0.25   | `tenjin config set maxAutoSpend 0.50` |

The daily budget, over a rolling 24 hours, is the control. The per-call limit is the runaway guard, and it cannot go below $0.25, the routing deposit. The wallet balance is the hard stop. A call over either limit pays nothing on its own: your agent tells you the price, Claude Code asks through its own permission prompt, and the call runs once you say yes.

Routing costs $0.003 a call, paid from channel deposits of up to $0.25 that stay yours until spent. Each deposit counts against your limits, so approving the limits at install approves the fee. When a routing call can't be paid, Claude Code tells you why once per session, and `tenjin doctor` names the fix. [How the limits and the fee work →](./docs/agent-permissions.md#what-bounds-a-payment)

`tenjin wallet fund 5` opens a Coinbase checkout for your wallet: Apple Pay or Google Pay with no Coinbase account in the US, your Coinbase account elsewhere. You can also send USDC on Base to the address `tenjin wallet address` prints. To move funds out, `tenjin wallet send <amount> USDC <address>` needs a per-send cap (`tenjin config set sendMaxAmount <usd>`) and a little ETH on Base for gas.

## Everyday commands

```bash
tenjin status            # spent today, and the limits in force
tenjin wallet balance    # what's left
tenjin payments          # the paid lookups this machine made
tenjin doctor            # check that this machine can run a lookup
tenjin update            # newest version; wallet and settings stay
tenjin config set router.enabled false             # pause the router
tenjin config set --project router.enabled false   # ...or only in this repo
tenjin uninstall         # remove the plugin; your wallet stays
```

The CLI checks npm at most once a day for a newer version and never updates itself; `tenjin config set update.mode off` stops the check.

## Learn more

- [Permissions, hooks, and what install writes](./docs/agent-permissions.md)
- [Safety model](./docs/safety-model.md)
- [Troubleshooting](./docs/troubleshooting.md)

## Developing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first for the contributor agreement.

```bash
pnpm install
pnpm run githooks   # once, to use the repo's git hooks
pnpm run build
pnpm run test
```

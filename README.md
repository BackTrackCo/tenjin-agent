<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo-light.svg" alt="Tenjin" width="220">
  </picture>
</p>

<h3 align="center">The tool router for coding agents.</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/tenjin-cli"><img src="https://img.shields.io/npm/v/tenjin-cli?color=C85A3B&label=npm" alt="npm version"></a>
</p>

Tenjin suggests tools when they can help your agent, and one local wallet pays per call. Your agent can also browse the catalog and choose a tool directly. Available tools cover research, company data, images, video, voice and more. [Browse tools and current prices →](https://tenjin.sh/tools)

## Install

Ask Claude Code or Codex:

```text
Install Tenjin from tenjin.sh
```

Setup briefly explains context sharing, asks about spending limits and offers **Add $5 / Not now**. Funding is optional. Follow the activation step, then continue your task. Optional improvement-data collection stays off unless explicitly enabled.

Or use a terminal; Node and npm are not required:

```sh
(
  tenjin_install_dir="$(mktemp -d ./.tenjin-install.XXXXXXXX)" || exit
  trap 'rm -f "$tenjin_install_dir/install.sh"; rmdir "$tenjin_install_dir"' EXIT
  curl -fsSL https://tenjin.sh/install.sh -o "$tenjin_install_dir/install.sh" &&
    sh "$tenjin_install_dir/install.sh"
)
```

Windows PowerShell:

```powershell
irm https://tenjin.sh/install.ps1 | iex
```

Already use npm? Run `npm i -g tenjin-cli`, then `tenjin install`.

Supports macOS 13.5+, Windows and glibc Linux 2.28+ on x64/arm64. Claude Code needs 2.1.287+. Codex support is experimental. Tenjin installs its own verified Node runtime, so changing your system Node does not stop it. [Setup, activation and permissions →](./docs/agent-permissions.md)

## Try it

Continue your work, or ask for a specific tool-backed task:

```text
Use Tenjin to look up Zod object schemas in Context7.
Use Tenjin to generate a hero image of plum blossoms in ukiyo-e style.
Use Tenjin to make a 10-second welcome voiceover.
```

The Context7 lookup runs without funds. Image and voice tools need funds and obey your spending policy. The agent can follow a router suggestion or browse, inspect and run a catalog tool. Browsing and inspection are free; provider prices and routing fees are separate. [How calls work →](./docs/router-reference.md#request-tool)

## Wallet and limits

| Automatic spending               | Default |
| -------------------------------- | ------- |
| Daily budget shared across chats | $5      |
| Per-call limit                   | $0.25   |

A new chat does not reset the daily budget. A routing decision has a separate fee quoted by the server, never above $0.003. Funds set aside for routing remain yours until spent and count toward the budget once. [Limits and approval →](./docs/agent-permissions.md#what-bounds-a-payment)

```bash
tenjin wallet fund 5    # open checkout; payment is confirmed in the browser
tenjin wallet balance   # confirm available funds before paying again
tenjin status           # spending and limits
tenjin doctor           # setup and readiness diagnostics; unchecked is not success
tenjin update           # update the CLI and its runtime
tenjin uninstall        # remove the integration; keep your wallet
```

## Privacy and help

Routing sends relevant task context to Tenjin, with known secrets masked. Tool-result bodies are excluded. The wallet key stays local. [What is sent and retained →](./docs/agent-permissions.md#what-the-hooks-send)

- [Setup and permissions](./docs/agent-permissions.md): installation, activation, spending and sharing.
- [Troubleshooting](./docs/troubleshooting.md): a failed install, locked wallet or missing tool.
- [Router reference](./docs/router-reference.md): request forms, payments and host details.
- [Safety model](./docs/safety-model.md): trust boundaries and remaining limitations.
- [Request a tool](https://github.com/BackTrackCo/tenjin-agent/issues/new?title=Tool%20request%3A%20&labels=enhancement) or [report a bug](https://github.com/BackTrackCo/tenjin-agent/issues).

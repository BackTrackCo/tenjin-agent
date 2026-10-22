# Troubleshooting

## Tenjin cannot unlock the wallet

Claude Code's message line, the session's first message or `tenjin doctor` says Tenjin cannot use its wallet, and names one of these reasons. Until it is fixed, Tenjin lookups take the free path and paid lookups do not run; your assistant's own tools keep working.

- **`no saved wallet passphrase can be reached`.** The passphrase was never saved where Claude Code can read it, or the file Tenjin saved it in is gone. Before 0.1.0-alpha.31, a passphrase typed at a prompt, or given in `TENJIN_WALLET_PASSPHRASE` for one command, was not saved when no keychain answered. Run `tenjin wallet repair` (below).
- **`the saved wallet passphrase does not open the wallet`.** The keychain or the passphrase file holds a passphrase, but not this wallet's. Run `tenjin wallet repair` (below).
- **`TENJIN_WALLET_PASSPHRASE is set but does not open the wallet`.** The variable in the environment Claude Code starts from is wrong, and no saved passphrase opens the wallet either. Remove the variable (below), or run `tenjin wallet repair`.
- **`the keychain holding the wallet passphrase is locked or did not answer`.** The passphrase is saved, but the keychain did not hand it over. Unlock your keychain (or log in to the desktop session) and retry. Nothing needs repairing, and Tenjin never switches to another passphrase on its own.

### Run `tenjin wallet repair`

Run it yourself, in a terminal: it asks for the passphrase (or uses `TENJIN_WALLET_PASSPHRASE` when that opens the wallet). Never paste the passphrase into chat, and never put it on a command line. It is not pre-approved for your assistant, which should ask you to run it and never ask for the passphrase.

```bash
tenjin wallet repair
```

It checks that the passphrase opens this wallet, saves it the way `tenjin wallet create` does (see [Wallet passphrase storage](./agent-permissions.md#wallet-passphrase-storage)), and never rewrites `wallet.json`. Then restart Claude Code. Saving is not the proof: the next session says "Tenjin wallet unlocked." on its first prompt, or why not, and `tenjin doctor` shows what that session's router saw.

### Remove a wrong `TENJIN_WALLET_PASSPHRASE`

Only when a message says the variable is wrong (`TENJIN_WALLET_PASSPHRASE is set but wrong; remove it.`, the reason above, or repair's own line), remove it from the environment Claude Code starts from, and delete the line that exports it from your shell startup file (repair names the file and line):

```bash
unset TENJIN_WALLET_PASSPHRASE
```

Then restart Claude Code. A correct variable still wins: it is used before any saved passphrase, so leave one that works.

### A lost passphrase

If nobody has the passphrase any more, nothing can open the wallet, and USDC sent to it stays there. `tenjin wallet create --replace` archives the old wallet only when it can open it, so it refuses here rather than strand those funds unannounced. To start over, move `~/.tenjin/wallet.json` aside (keep the file, in case the passphrase turns up) and run `tenjin wallet create`.

## Claude Code asks about a new project MCP server named `x402`

Updating to `0.1.0-alpha.18` could accidentally register the server in `~/.mcp.json` while refreshing a user install. After upgrading to a release with the fix, check that file. If its `x402` entry runs `tenjin mcp` and you didn't install at project scope in your home directory on purpose, remove just that registration:

```bash
(cd ~ && claude mcp remove x402 -s project)
```

This keeps your other MCP entries and the user registration in `~/.claude.json`. Run `tenjin install`, then restart Claude Code. Don't use `tenjin uninstall --project` from home for this: its settings path is also the user settings path.

When refreshing from home, Tenjin keeps the existing user registration if there is one, or preserves a project-only registration; with neither, it defaults to user scope. `tenjin install --refresh --project` selects project scope explicitly.

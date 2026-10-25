# Troubleshooting

## Tenjin cannot unlock the wallet

Claude Code's message line, the session's first message or `tenjin doctor` says Tenjin cannot use its wallet, and names one of these reasons. Until it is fixed, Tenjin does not route lookups and paid lookups do not run; your assistant's own tools keep working.

- **`no saved wallet passphrase can be reached`.** The passphrase was never saved where Claude Code can read it, or the file Tenjin saved it in is gone. Before 0.1.0-alpha.31, a passphrase given in `TENJIN_WALLET_PASSPHRASE` when the wallet was created was never saved, and one typed at the create prompt was not saved either (create prompted only when no keychain answered). Run `tenjin wallet repair` (below).
- **`the saved wallet passphrase does not open the wallet`.** The keychain or the passphrase file holds a passphrase, but not this wallet's. Run `tenjin wallet repair` (below).
- **`TENJIN_WALLET_PASSPHRASE is set but does not open the wallet`.** The variable in the environment Claude Code starts from is wrong, and no saved passphrase opens the wallet either, so removing the variable alone does not unlock it. Run `tenjin wallet repair` (below) first, then remove the variable (below).
- **`the keychain holding the wallet passphrase is locked or did not answer`.** The passphrase is saved, but the keychain did not hand it over. Unlock your keychain (or log in to the desktop session) and retry. Nothing needs repairing, and Tenjin never switches to another passphrase on its own.

### Run `tenjin wallet repair`

Run it yourself, in a terminal: it asks for the passphrase (or uses `TENJIN_WALLET_PASSPHRASE` when that opens the wallet). Never paste the passphrase into chat, and never put it on a command line. It is not pre-approved for your assistant, which should ask you to run it and never ask for the passphrase.

```bash
tenjin wallet repair
```

It checks that the passphrase opens this wallet, saves it the way `tenjin wallet create` does (see [Wallet passphrase storage](./agent-permissions.md#wallet-passphrase-storage)), and never rewrites `wallet.json`. Then start a new Claude Code session. Saving is not the proof: the next session says "Tenjin wallet unlocked." on its first prompt, or why not, and `tenjin doctor` shows what that session's router saw.

### Remove a wrong `TENJIN_WALLET_PASSPHRASE`

Only when a message says the variable is wrong (`TENJIN_WALLET_PASSPHRASE is set but wrong; remove it.`, or repair's own line), remove it from the environment Claude Code starts from, and delete the line that exports it from your shell startup file (repair names the file and line). When the reason is `TENJIN_WALLET_PASSPHRASE is set but does not open the wallet`, run `tenjin wallet repair` first: no saved passphrase opens the wallet until it does.

```bash
unset TENJIN_WALLET_PASSPHRASE
```

Then quit Claude Code fully and start a new session from that shell: a running Claude Code keeps the environment it started with. A correct variable still wins: it is used before any saved passphrase, so leave one that works.

### A lost passphrase

If nobody has the passphrase any more, nothing can open the wallet, and USDC sent to it stays there. `tenjin wallet create --replace` archives the old wallet only when it can open it, so it refuses here rather than strand those funds unannounced. To start over, move `~/.tenjin/wallet.json` aside (keep the file, in case the passphrase turns up) and run `tenjin wallet create`.

## Tenjin stopped after a Node upgrade (`Executable not found`, `cache-miss`)

The router fails to start in Claude Code or shows `cache-miss`, a terminal says `tenjin: command not found`, or `tenjin doctor` cannot run at all.

Before this release, Tenjin ran from npm's global folder, which belongs to one Node version. mise, nvm, fnm, asdf and Volta keep one such folder per version, so removing that Node, or running `npm rm -g tenjin-cli`, deleted the files the plugin ran.

Ask your agent to reinstall it:

```text
Install Tenjin from tenjin.sh
```

Or follow the [official installation instructions](https://tenjin.sh/agents); the installer includes Node and needs no npm or working `tenjin` command. For a project-only installation, pass `--project` to the installer from that project folder. Follow the installer's activation instruction. From this release on, Tenjin runs from `~/.tenjin/runtime` on its own Node, so a Node upgrade or `npm rm -g tenjin-cli` no longer stops it. Your wallet, spend ledger and settings stay where they were.

### The launcher says the runtime is missing

`tenjin: Tenjin's runtime is missing (…)` means the files in `~/.tenjin/runtime` that the `tenjin` command runs are gone. Use the same official installer above, keeping `--project` for a project-only installation, then follow its activation instruction.

### `tenjin` not found in a terminal

Install puts the `tenjin` command in `~/.local/bin`, and says so when that folder is not on your PATH. Add it for zsh:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

or for bash (`~/.bash_profile` on macOS):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

Then open a new terminal. Inside Claude Code, the plugin's own `tenjin` is at the end of the Bash tool's PATH, so your assistant finds it when nothing earlier on PATH is named `tenjin`.

### Removing Tenjin

Run `tenjin uninstall --all` first, then `npm uninstall -g tenjin-cli`. Uninstall removes the plugin, the runtime and the launcher, and keeps your wallet. If npm went first, `~/.local/bin/tenjin uninstall --all` still works.

## Claude Code asks about a new project MCP server named `x402`

Updating to `0.1.0-alpha.18` could accidentally register the server in `~/.mcp.json` while refreshing a user install. After upgrading to a release with the fix, check that file. If its `x402` entry runs `tenjin mcp` and you didn't install at project scope in your home directory on purpose, remove just that registration:

```bash
(cd ~ && claude mcp remove x402 -s project)
```

This keeps your other MCP entries and the user registration in `~/.claude.json`. Run `tenjin install`. Then start a new Claude Code session. Don't use `tenjin uninstall --project` from home for this: its settings path is also the user settings path.

When refreshing from home, Tenjin keeps the existing user registration if there is one, or preserves a project-only registration; with neither, it defaults to user scope. `tenjin install --refresh --project` selects project scope explicitly.

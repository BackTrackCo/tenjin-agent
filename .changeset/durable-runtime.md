---
'tenjin-cli': patch
---

Tenjin keeps working after a Node upgrade. Install copies Tenjin into `~/.tenjin/runtime` with its own pinned Node 24, downloaded from nodejs.org and checked against the SHA-256 the build carries, and Claude Code runs the plugin's hooks and server from there by absolute path. Removing the Node that installed it, switching versions with mise, nvm, fnm, asdf or Volta, or running `npm rm -g tenjin-cli` no longer stops the router. On a platform with no pinned Node (musl, or glibc older than 2.28), under a non-default `TENJIN_DATA_DIR`, or when setting up the runtime fails, Tenjin runs from the npm package as before and says why.

The `tenjin` command is now a launcher in `~/.local/bin` (`tenjin.cmd` too on Windows), and the plugin carries the same launcher in its `bin/`, which Claude Code puts at the end of the Bash tool's PATH. When the runtime is gone, the launcher says so and names the fix: `npx -y tenjin-cli@latest install`, then start a new Claude Code session. Install says when `~/.local/bin` is not on your PATH and gives the line to add, and leaves a `tenjin` there that is not its own.

`tenjin update` no longer needs npm. It downloads the new version from the npm registry, checks it against the registry's SHA-512, and has the new build check itself on its own Node before it switches anything; a failed check keeps the version you had. The previous version stays in the runtime, and older ones are removed only once nothing runs from them. An older build never replaces a newer one; to go back, run `tenjin uninstall`, then install the older version.

Codex runs Tenjin from the same runtime: install adds the Codex plugin from `~/.tenjin/runtime/codex`, whose hooks and server run the runtime's launcher, so a Node upgrade no longer breaks Tenjin in Codex. Run `tenjin install` once in Codex to move an existing install; Codex asks you to review the changed hooks.

Tenjin now updates itself in the background, at most once a day, at the start of a Claude Code or Codex session, where its runtime is set up. It uses `tenjin update`'s checks, never npm. Claude Code runs the new version from its next session; in Codex the hooks run it as soon as it switches, and the server from the next session. `tenjin config set update.mode nudge` only reports a newer version; `off` turns the check off.

`tenjin doctor` checks the runtime Claude Code starts, and names an older `tenjin` first on your PATH, or a plugin an older build moved back to its npm folder.

Existing installs move to the runtime on their next `tenjin install` or `tenjin update`, project installs included. The wallet, the passphrase, the spend ledger and the config stay where they are.

`tenjin uninstall` removes the install for where you are, from any folder: the project install for this folder or the nearest one above it, or else the user install. `--project <path>` removes another project's install, and `--all` removes every one. A run is all or nothing: when a removal fails, the marketplace, the runtime and the launcher stay, and it names what was removed and what is left. It ends by saying what it kept (your wallet and its address, the spend ledger, the config, where the passphrase is saved) and to run `npm uninstall -g tenjin-cli` after it, never before.

A wallet that will not open no longer uses up an approved quote: the `approve` call opens the wallet first, so the quote waits for a second yes after `tenjin wallet repair`. `tenjin status` shows the wallet's USDC balance, and `tenjin status` and `tenjin wallet balance` say how to fund a wallet at $0.

Every fix now says the same thing: start a new Claude Code session. Fixes to an environment variable say to quit Claude Code fully and start a new session, since a running Claude Code keeps the environment it started with.

New troubleshooting entry: "Tenjin stopped after a Node upgrade (`Executable not found`, `cache-miss`)".

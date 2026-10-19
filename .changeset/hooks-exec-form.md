---
'tenjin-cli': patch
---

The Claude Code plugin now runs on Windows: every command it carries is exec form, started with no shell, so Git Bash and PowerShell no longer parse it, and none needs PATH. `tenjin install` renders the plugin into `~/.tenjin/claude-plugin` and registers that folder, with every command pinned to the absolute path of the Node binary that ran it and of the package's `dist/index.js`, never the `tenjin` npm shim. A Claude Code started before Node's installer edited PATH, which finds neither `tenjin` nor `node`, now starts the plugin's server and hooks. The plugin's server re-renders the folder after an npm upgrade. `tenjin doctor` reports the hook form, fails when a pinned path is gone, and names the directories a stale PATH lacks (on Windows, read from the saved user and machine PATH). The settings-install remover also recognizes those entries in exec form or behind a Windows path.

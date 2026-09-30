# Local executor infrastructure

Local executors use client-owned package identities and validated arguments. A router response never selects an npm package, version, command, filesystem root, or permission grant.

`prepareNpmRuntime` keeps a reviewed artifact at a stable content-addressed path and retains the npm cache under the active Tenjin data directory's `runtimes` directory. Cache identity includes package, exact release or artifact hash, OS, architecture and Node major. Concurrent preparation uses the existing file lock; cached artifacts are verified before use and corruption or symlinks are refused. npm owns its package-cache operations. Releases must be qualified by the calling executor before preparation.

Runtime packages and npm cache survive a run. Credentials, HOME, XDG configuration/cache, npm configuration and working files are temporary and removed on close. Ambient provider credentials and npm settings are not inherited. Install scripts remain disabled; a package needing them requires separate qualification. `npx` fetches missing dependencies and runs code with the OS user's privileges; it is not a sandbox. Cache reuse avoids repeated package setup, but does not promise no network traffic or offline availability.

`runBoundedCommand` accepts a fixed npx argument vector, cancellation signal and output-byte limit. It stops owned subprocesses and observed descendants on cancellation or output overflow. MCP session shutdown and request cancellation propagate to the execution layer. Each executor supplies its own permissions, operation limits and result interpretation.

Durable run accounting uses the existing wallet ledger and lock. Reserved and signed exposure survives the rolling budget window; request keys cannot be signed again and a run cannot change its ceiling. Unresolved signed exposure stays charged and cannot be released as if nothing was sent. A signed reservation whose provider response validated settles into the current window and stops charging later windows; settled records older than the window fold into one per run. Chain settlement reconciliation is not implemented. All processes sharing a wallet directory must use this ledger-aware build before durable payments; old binaries cannot preserve the new fields.

This layer adds no enabled executor, repository disclosure, provider, generic command-running MCP tool, or routing fee. Removing a package cache does not revoke grants or clear payment accounting. Disable the calling executor to withdraw its capability; retain unresolved payment records during rollback.

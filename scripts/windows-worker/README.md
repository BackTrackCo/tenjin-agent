# Windows worker launcher prototype

This launcher is for qualification with a real Windows host and a disposable standard account. The production CLI does not call it.

The controller launches the executable with direct piped stdio:

```text
tenjin-windows-worker.exe --worker-sid <sid> --parent-pid <pid> --cwd <local-absolute-path> -- <absolute-native-exe> <native-arguments>
```

The account must be distinct from the controller and already provisioned. Use its SID and a Generic credential named `Tenjin.WindowsWorker` in the controller logon session's Credential Manager. The username is unqualified or `.\username` and the secret is the UTF-16 password. The launcher reads and clears the password in memory. It never passes the password through command arguments, shell commands, or environment variables.

Pass a loopback-only `ANTHROPIC_BASE_URL` and the temporary bridge authentication in `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The launcher loads the standard account's own profile, passes through only explicitly allowed bridge settings from the controller, and gives the SDK the worker's stdin, stdout, and stderr. The job object owns process cleanup and grants no file or network access. The operator supplies a workspace and native executable the standard account can reach through ordinary Windows access rules. Keep controller data, credentials, and signing files under the controller's own account.

Build with Go 1.25 or newer. From this directory, run `go test ./...` and then `go build -trimpath -o tenjin-windows-worker.exe .` on Windows. Mac and Linux can run the protocol tests and cross-build with `GOOS=windows`, `GOARCH=amd64` or `arm64`, and `CGO_ENABLED=0`. Cross-builds verify compilation. Actual Windows qualification needs the alternate account, inherited pipes, ACL checks, and an observed process-tree drain.

For the process probe, run `node process-probe.mjs <absolute-launcher-path> <worker-sid> <shared-workspace>` on Windows. The fixture account needs read access to the script and execute access to Node. The probe checks that the corrected profile and piped input reach the child, verifies its detached grandchild is present, and waits for both to exit after direct cancellation and after the immediate controller disappears.

For the real Claude Code SDK probe, run `node qualify.mjs <launcher.exe> <claude.exe> <worker-sid> <shared-workspace> <private-canary> <Bash|PowerShell>`. Put exactly `SYNTHETIC_TENJIN_PRIVATE_FIXTURE` with no newline in a parent-only file outside the shared workspace. Use Claude Code 2.1.325 or newer and the checkout's locked SDK. The fixture verifies that inference waits for acceptance, a native `PreToolUse` hook blocks a command, and the shell can read the workspace while Windows denies the private canary. The manual CI job provisions only disposable fixtures and runs both probes.

Test interruption during alternate-account process creation separately before using this launcher in production. The Windows process creation API returns a suspended process that the launcher then assigns to its job. A hard kill between those two operations has no verified cleanup guarantee.

Windows APIs used by the launcher are [Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw), [alternate-account process creation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw), and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

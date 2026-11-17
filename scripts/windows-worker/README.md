# Windows DeepSeek worker

Tenjin uses this launcher to run native Claude Code tools under a standard local Windows account. The shell runs with that account’s file and network permissions.

## Setup

1. Provision a standard local account for the worker and note its SID. Add a Generic credential named `Tenjin.WindowsWorker` in Windows Credential Manager under the controller’s sign-in. Enter `.\username` and the worker account’s password.
2. Build the launcher and install it alongside a native Claude Code executable, version 2.1.325 or newer, in a trusted directory. The worker account needs read and execute access. Keep the executables and their containing paths protected against replacement by the worker account.
3. Grant the worker account access to the intended workspace and prepare a shared Claude configuration directory with the settings and instructions to use. Keep controller credentials and Tenjin data in its private home. Start the parent Claude Code session with `CLAUDE_CONFIG_DIR` set to the shared directory. Its active `claude.exe` must be the executable used below.
4. Enable the Windows worker for the repository from the controller account.

For the parent session, supply Claude Code credentials through its own environment. A Claude Console API key or a subscription token created with `claude setup-token` can be used this way. Keep `.credentials.json`, keys and tokens out of the shared profile. Tenjin gives the worker its own scoped inference credential. [Claude Code authentication](https://code.claude.com/docs/en/authentication)

```powershell
tenjin config subagents on --repository "C:\src\project" --max-job 1 `
  --windows-worker-sid "<worker SID>" `
  --windows-launcher "C:\Program Files\Tenjin\tenjin-windows-worker.exe" `
  --windows-claude "C:\Program Files\Tenjin\claude.exe" `
  --windows-config-dir "C:\src\shared-claude" --accept-windows-shell-access
```

`tenjin config subagents off` revokes the worker grant. On each launch the worker checks its Windows access to the controller data and settings and refuses to start if it can read or change them. It also checks its ability to replace the launcher or Claude binary. A launch refusal can follow an already-paid routing fee.

## Launcher and qualification

The controller launches the executable with direct piped stdio:

```text
tenjin-windows-worker.exe --worker-sid <sid> --parent-pid <pid> --cwd <local-absolute-path> --cancel-file <owner-private-path> -- <absolute-native-exe> <native-arguments>
```

The account must be distinct from the controller and already provisioned. Use its SID and a Generic credential named `Tenjin.WindowsWorker` in the controller logon session's Credential Manager. The username is unqualified or `.\username` and the secret is the UTF-16 password. The launcher reads and clears the password in memory. It never passes the password through command arguments, shell commands, or environment variables.

Pass a loopback-only `ANTHROPIC_BASE_URL` and the temporary bridge authentication in `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The launcher starts the alternate account's profile, passes through only explicitly allowed bridge settings from the controller, and gives the SDK the worker's stdin, stdout, and stderr. The job object owns process cleanup. The operator supplies a workspace and native executable the standard account can reach through ordinary Windows access rules. Keep controller data, credentials, and signing files under the controller's own account.

Spawn the launcher with `detached: true`, piped stdio, and no Node spawn abort signal. Give each launch its own absent cancellation marker in an owner-private directory. To cancel, create the marker and wait for the launcher to exit before removing it. The launcher holds the real controller process handle, so it can also finish cleanup if the controller dies. Keep the launcher alive during alternate-account logon. If logon returns after cancellation or controller loss, the launcher terminates and waits for the suspended process before assigning the job or resuming the worker.

Build with Go 1.25 or newer. From this directory, run `go test ./...` and then `go build -trimpath -o tenjin-windows-worker.exe .` on Windows. Mac and Linux can run the protocol tests and cross-build with `GOOS=windows`, `GOARCH=amd64` or `arm64`, and `CGO_ENABLED=0`. Cross-builds verify compilation. Actual Windows qualification needs the alternate account, inherited pipes, ACL checks, and an observed process-tree drain.

For the process probe, run `node process-probe.mjs <absolute-launcher-path> <worker-sid> <shared-workspace> [<absolute-test-launcher-path>]` on Windows. The fixture account needs read access to the script and execute access to Node. The probe checks the alternate profile, piped input, and termination of the worker and its detached grandchild after cancellation or loss of the immediate controller.

Build the optional test launcher with `go test -c -o tenjin-windows-worker-test.exe .` and give the fixture account execute access. The probe then also interrupts a real alternate-account launch while its suspended process is held before job assignment. It exercises both cooperative cancellation and controller death, verifies that the launcher survives to reap the suspended process, and checks that the worker executes no fixture code.

For the real Claude Code SDK probe, run `node qualify.mjs <launcher.exe> <claude.exe> <worker-sid> <shared-workspace> <private-canary> <Bash|PowerShell>`. Put exactly `SYNTHETIC_TENJIN_PRIVATE_FIXTURE` with no newline in a parent-only file outside the shared workspace. Use Claude Code 2.1.325 or newer and the checkout's locked SDK. The fixture verifies that inference waits for acceptance, a native `PreToolUse` hook blocks a command, and the shell can read the workspace while Windows denies the private canary. The manual CI job provisions only disposable fixtures and runs both probes.

The same workflow runs `qualify-offer.mjs` through the production Tenjin offer tool with a local fixture endpoint. It checks an accepted native Read and verifies that a veto or revoked Windows grant drains the worker without an inference request.

An external hard kill of the launcher itself while Windows creates the suspended process falls outside cooperative cancellation. Microsoft documents creation-time job assignment with extended startup information for `CreateProcessW`. The [unprivileged alternate-account API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw) documents the basic startup structure.

Windows APIs used by the launcher are [Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw), [alternate-account process creation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw), and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

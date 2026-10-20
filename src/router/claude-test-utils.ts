import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A FAKE `claude` BINARY for the install, update, uninstall and doctor tests:
 * a POSIX shell script that records each command line it receives, and the
 * `CLAUDE_CONFIG_DIR` it was run with, and answers from files the test
 * controls. The real code path runs: the binary is found on PATH or through
 * `CLAUDE_CODE_EXECPATH`, and spawned without a shell.
 */

export type FakeKey =
  | 'version'
  | 'mkt-list'
  | 'mkt-add'
  | 'mkt-remove'
  | 'install'
  | 'update'
  | 'uninstall'
  | 'list'
  | 'mcp-remove'
  | 'mcp-get';

const SCRIPT = `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
printf '%s\\n' "$*" >> "$d/calls.log"
printf '%s\\n' "\${CLAUDE_CONFIG_DIR:-unset}" >> "$d/config-dirs.log"
case "$*" in
  --version) key=version;;
  "plugin marketplace list"*) key=mkt-list;;
  "plugin marketplace add"*) key=mkt-add;;
  "plugin marketplace remove"*) key=mkt-remove;;
  "plugin install"*) key=install;;
  "plugin update"*) key=update;;
  "plugin uninstall"*) key=uninstall;;
  "plugin list"*) key=list;;
  "mcp remove"*) key=mcp-remove;;
  "mcp get"*) key=mcp-get;;
  *) key=unknown;;
esac
[ -f "$d/$key.out" ] && /bin/cat "$d/$key.out"
code=0
[ -f "$d/$key.code" ] && code=$(/bin/cat "$d/$key.code")
exit $code
`;

const DEFAULTS: Record<FakeKey, string> = {
  version: '2.1.296 (Claude Code)\n',
  'mkt-list': '[]\n',
  'mkt-add':
    '{"command":"marketplace-add","outcome":"ok","marketplace":"tenjin","message":"Successfully added marketplace: tenjin"}\n',
  'mkt-remove': '{"command":"marketplace-remove","outcome":"ok","marketplace":"tenjin"}\n',
  install:
    '{"command":"install","outcome":"ok","plugin":"tenjin@tenjin","pluginId":"tenjin@tenjin","scope":"user"}\n',
  update:
    '{"command":"update","outcome":"ok","plugin":"tenjin@tenjin","updateOutcome":"updated"}\n',
  uninstall: '{"command":"uninstall","outcome":"ok","plugin":"tenjin@tenjin"}\n',
  list: '[]\n',
  'mcp-remove': 'Removed MCP server x402\n',
  'mcp-get': 'plugin:tenjin:router:\n  Scope: Dynamic config\n  Status: ✔ Connected\n',
};

export interface FakeClaude {
  /** The script's absolute path. */
  bin: string;
  /** A PATH that holds only the script's directory. */
  pathDir: string;
  /** The env a run needs: the script's PATH and where it keeps its state. */
  env: Record<string, string>;
  /** Set what one command prints and its exit code. */
  respond(key: FakeKey, out: string, code?: number): Promise<void>;
  /** Every command line received, in order. */
  calls(): Promise<string[]>;
  /** The `CLAUDE_CONFIG_DIR` each command ran with. */
  configDirs(): Promise<string[]>;
}

export async function fakeClaude(root: string): Promise<FakeClaude> {
  const dir = join(root, 'fake-claude');
  const pathDir = join(dir, 'bin');
  await mkdir(pathDir, { recursive: true });
  const bin = join(pathDir, 'claude');
  await writeFile(bin, SCRIPT);
  await chmod(bin, 0o755);
  for (const [key, out] of Object.entries(DEFAULTS)) await writeFile(join(dir, `${key}.out`), out);
  const lines = async (file: string) =>
    (await readFile(join(dir, file), 'utf8').catch(() => ''))
      .split('\n')
      .filter((l) => l.length > 0);
  return {
    bin,
    pathDir,
    env: { PATH: pathDir, FAKE_CLAUDE_DIR: dir },
    async respond(key, out, code = 0) {
      await writeFile(join(dir, `${key}.out`), out);
      await writeFile(join(dir, `${key}.code`), String(code));
    },
    calls: () => lines('calls.log'),
    configDirs: () => lines('config-dirs.log'),
  };
}

/** One `claude plugin list --json` row. */
export function listed(id: string, version: string, enabled = true): string {
  return `${JSON.stringify([{ id, version, scope: 'user', enabled }])}\n`;
}

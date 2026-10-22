import { join } from 'node:path';
import { codexRulesPath, removeCodexGrant } from '../lib/codex-rules';
import { inspectCodexGrant, wireCodexGrant } from '../lib/harness-permissions';
import { readCodexTrust, trustCodexHooks } from '../lib/codex-trust';
import type { HarnessAdapter, Registrar } from './types';

import { decode, encode, SHELL_TOOL, PATCH_TOOL } from './codex-wire';
export { decode, encode, patchPaths } from './codex-wire';

import { codexHome } from '../lib/codex-home';
export { codexHome } from '../lib/codex-home';

function commandHandler(shimPath: string, timeoutSeconds: number) {
  return {
    type: 'command',
    command: `node ${JSON.stringify(shimPath)} --harness codex`,
    timeout: timeoutSeconds,
  };
}

export const registrar: Registrar = {
  configPath(home, env) {
    return join(codexHome(home, env), 'hooks.json');
  },
  /**
   * Seven `command` entries, every one through the shim: a Codex handler
   * carries no URL or token, so the daemon is ensured on each fire and the
   * entry holds nothing worth protecting. The matchers are the two hooked
   * tool names the arms read; a child's fires arrive through the same entries.
   */
  plan({ shimPath, timeoutSeconds }) {
    const command = [commandHandler(shimPath, timeoutSeconds)];
    return [
      { event: 'SessionStart', hooks: command },
      { event: 'UserPromptSubmit', hooks: command },
      { event: 'PreToolUse', matcher: `${SHELL_TOOL}|${PATCH_TOOL}`, hooks: command },
      { event: 'PostToolUse', matcher: SHELL_TOOL, hooks: command },
      { event: 'SubagentStart', hooks: command },
      { event: 'SubagentStop', hooks: command },
      { event: 'Stop', hooks: command },
    ];
  },
  /**
   * Codex reads hooks once, at session start. `install` now trusts the entries
   * it writes through Codex's own supported path (lib/codex-trust.ts), so the
   * `/hooks` walkthrough this used to carry is gone; what is left is the one
   * fact no installer can change, which is that the session already open still
   * has the hook set it started with (tenjin-agent#343).
   */
  activation() {
    return ['Start a new Codex session: hooks are read at session start.'];
  },
  grant: {
    path: codexRulesPath,
    inspect: inspectCodexGrant,
    write: wireCodexGrant,
    remove: removeCodexGrant,
  },
  trust: {
    ensure: trustCodexHooks,
    read: readCodexTrust,
  },
};

export const codexAdapter: HarnessAdapter = { id: 'codex', decode, encode, registrar };

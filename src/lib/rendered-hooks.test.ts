import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import {
  dispatchHookScript,
  sessionPrimerHookScript,
  stopHookScript,
  websearchHookScript,
} from './hook-scripts';
import {
  pushContextHookScript,
  pushFailureHookScript,
  pushPromptHookScript,
  pushSubagentHookScript,
} from './push-scripts';

/**
 * A NAME THAT NO LONGER EXISTS IS A SILENT HOOK, and nothing else in this suite
 * can see it.
 *
 * The eight scripts are assembled from template literals, so `tsc` never looks
 * inside them: a constant renamed or removed in the TypeScript around them
 * leaves a live `ReferenceError` in the emitted JavaScript. The hooks catch
 * their own throws and exit 0 with empty stdout and empty stderr, which is the
 * same observable behaviour as an arm that legitimately decided to say nothing.
 * Two of those shipped into this stack while it was being rebased onto main
 * (`TEAM_SHORT_OPENER` in the child pointer, `judgeLeg` in the replay), and
 * neither `node --check` nor a test asserting silence could tell either one from
 * correct behaviour.
 *
 * So the guarantee is structural rather than behavioural: every identifier the
 * rendered script reads must be declared in it or be a runtime global. That is
 * `no-undef`, run over the emitted text.
 */
const RUNTIME_GLOBALS = [
  'AbortController',
  'AbortSignal',
  'Array',
  'BigInt',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Set',
  'String',
  'TextEncoder',
  'URL',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'globalThis',
  'process',
  'setTimeout',
  'structuredClone',
] as const;

const SCRIPTS: Record<string, (dataDir: string) => string> = {
  'tenjin-websearch': websearchHookScript,
  'tenjin-dispatch': dispatchHookScript,
  'tenjin-session-primer': sessionPrimerHookScript,
  'tenjin-stop': stopHookScript,
  'tenjin-push-prompt': pushPromptHookScript,
  'tenjin-push-failure': pushFailureHookScript,
  'tenjin-push-subagent': pushSubagentHookScript,
  'tenjin-push-context': pushContextHookScript,
};

describe('the rendered hook scripts', () => {
  it.each(Object.keys(SCRIPTS))('%s reads no undeclared name', (name) => {
    const source = SCRIPTS[name]!('/tmp/tenjin-render-check');
    const messages = new Linter().verify(source, {
      languageOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        globals: Object.fromEntries(RUNTIME_GLOBALS.map((g) => [g, 'readonly' as const])),
      },
      rules: { 'no-undef': 'error' },
    });
    // The message itself, not just the count: a name is the only useful failure
    // here, and it is what a reader needs to find the rename that dropped it.
    expect(messages.map((m) => `${m.line}: ${m.message}`)).toEqual([]);
  });

  /** The other half: a script that does not parse is not a hook either, and a
   *  character class written singly inside a template literal emits as a
   *  literal and still parses, so this is a floor and not a ceiling. */
  it.each(Object.keys(SCRIPTS))('%s parses', (name) => {
    const source = SCRIPTS[name]!('/tmp/tenjin-render-check');
    const messages = new Linter().verify(source, {
      languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    });
    expect(messages.filter((m) => m.fatal)).toEqual([]);
  });
});

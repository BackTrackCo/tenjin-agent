import type { HookTool } from '../../adapters/types';
import { deliver } from '../deliver';
import { failureQuestionKey, RESOLVE_KEYS_MAX, testKey } from '../failure/keys';
import { allowedHeads, errorLine } from '../failure/signature';
import { testFailuresOf, type TestFailure } from '../failure/test-identity';
import { keysLeg, searchLeg, teamOrigin } from '../legs/shelf';
import { question } from '../question';
import { stripAnsi } from '../text';
import type { Arm, Leg, Question } from '../types';

/**
 * The failure arm (13-pr-d-local-arms.md, "failure"; tenjin-agent#350). An
 * agent's command fails, and the arm asks about it in two rounds.
 *
 * ROUND ONE IS THE FAILING TESTS' NAMES: `test:<file> > <suite> > <test>` for
 * every test the output names, at most {@link RESOLVE_KEYS_MAX}, in one resolve
 * request. A name is a key anyone can derive without this machine's output,
 * which the hash of a rendered error line it replaces never was.
 *
 * ROUND TWO ASKS THE SAME SHELF IN WORDS: the error line as the runner printed
 * it, with the failing test's name beside it, and it runs only when round one
 * answered nothing (`ask.ts` stops at the first stage that answers). A key
 * resolves a failure somebody already published under that name; a teammate's
 * write-up about the same error in prose carries no name at all.
 *
 * THE OUTPUT IS THE ONLY SOURCE. The tenjin vitest reporter prints each
 * failure's name and first line as an `::error` line after vitest's summary,
 * so an agent's `2>&1 | tail -30` keeps them even where its pipe cut the
 * assertion (`vitest-reporter.ts`); without the reporter, vitest's `FAIL`
 * header and the per-line picker (`signature.ts`) read the console. Nothing is
 * read off disk, so nothing has to be found, dated or owned.
 *
 * THE TEAM SHELF IS THE ONLY ONE ASKED, in either round. There is no public
 * leg: the marketplace holds none of this team's errors, and every hit in a
 * 150-search census of this shelf came from the team side.
 *
 * THE ARM ONLY ASKS. It writes nothing about the failure, so a fire that finds
 * nothing leaves its ledger row and no other trace. That row IS the record: it
 * already carries the composed question key and the masked question, which is
 * what the turn-end ask reads back to name the failure (`capture.ts`), so there
 * is no second store to keep in step with it.
 *
 * `tool.ok` is `decode`'s: false on `PostToolUseFailure` and on a Bash
 * `PostToolUse` whose output carries an error marker (decision 9). The arm
 * never reads text to decide WHETHER something failed, only WHAT.
 */

function commandOf(tool: HookTool | undefined): string {
  return tool?.kind === 'shell' ? tool.command : '';
}

/** Both streams, and the failure string a `PostToolUseFailure` carries. A
 *  runner prints its verdict to STDOUT with an empty stderr. */
function failureText(tool: HookTool | undefined): string {
  const r = tool?.result;
  // COLOUR COMES OFF HERE, ONCE, because everything downstream reads this text
  // by line and every marker that recognizes a diagnostic line is anchored to
  // the start of it. A pty or `FORCE_COLOR` puts an SGR sequence in front of
  // `Error:`, `npm ERR!`, `panic:`, `fatal:` and vitest's own ` FAIL <file> >
  // <test>` header, and the scanners walk past all of them, and whatever line
  // does survive carries `[31m` onto the wire, since `mask` deletes the escape
  // byte and leaves the rest.
  return stripAnsi(
    [r?.stdout, r?.stderr, r?.error, r?.text]
      .filter((t): t is string => typeof t === 'string')
      .join('\n'),
  );
}

function lastOf(
  failures: readonly TestFailure[],
  test: (f: TestFailure) => boolean,
): TestFailure | undefined {
  for (let i = failures.length - 1; i >= 0; i -= 1) {
    const failure = failures[i];
    if (failure !== undefined && test(failure)) return failure;
  }
  return undefined;
}

/**
 * The words round's text: the last named failure's line and its name; failing
 * that, an error no test owns (an import failure, an unhandled rejection); and
 * failing that, the console's own last diagnostic line beside the last test the
 * console named. The name travels with the line because an assertion alone
 * (`expected 2 to be 1`) says nothing about what the code does, and the test's
 * name is where that is written.
 */
function wordsOf(text: string, failures: readonly TestFailure[]): string {
  const named = lastOf(failures, (f) => f.name !== '' && f.line !== '');
  if (named !== undefined) return named.line + ' — ' + named.name;
  const unowned = lastOf(failures, (f) => f.line !== '');
  if (unowned !== undefined) return unowned.line;
  const line = errorLine(text) ?? '';
  const name = lastOf(failures, (f) => f.name !== '')?.name ?? '';
  return [line, name].filter((s) => s !== '').join(' — ');
}

/**
 * What this failure asks, or null when it has nothing to ask with.
 *
 * THE TEXT goes through the same `question()` every other arm goes through:
 * masked, cut, and nothing else.
 *
 * THE KEY IS NOT THE TEXT'S. `question()` keys on the text alone, and the text
 * alone is the same bytes for the same assertion in two tests. Those are two
 * failures, and under one key the second takes the first's cached miss out of
 * the once-per-question gate (`gates.ts`, `Q_PREFIX`) and is never looked up
 * under its own name. So the key composes every test key this failure has with
 * the hash of its text ({@link failureQuestionKey}).
 *
 * THERE IS NO EMPTY FALLBACK: a key of `''` would file every nameless, wordless
 * failure on this machine under one claim, so the first one asked would answer
 * (and then silence) all the others for the life of the session. Null is the
 * arm having nothing at all, which is a `no-question` row and claims nothing.
 */
function questionOf(keys: readonly string[], words: string): Question | null {
  const asked = words === '' ? null : question(words);
  const questionKey = failureQuestionKey({
    keys,
    ...(asked !== null ? { lineKey: asked.questionKey } : {}),
  });
  if (questionKey === '') return null;
  return { text: asked?.text ?? '', questionKey };
}

export const failureArm: Arm = {
  id: 'failure',
  wait: 'tool',
  on: [{ event: 'tool.after', kind: 'shell' }],

  async plan(ctx) {
    const cfg = ctx.deps.config();
    if (!cfg.hooks.failure) return null;
    // Both rounds go to a team origin or nowhere: there is no public resolve,
    // and no public leg by decision. A machine with no team shelf therefore has
    // nothing to ask however the failure reads.
    if (teamOrigin(cfg) === null) return null;
    const tool = ctx.input.tool;
    if (tool?.ok !== false) return null;
    if (allowedHeads(commandOf(tool)).length === 0) return null;
    const text = failureText(tool);
    const failures = testFailuresOf(text);
    // EVERY NAMED TEST, NOT THE LAST ONE: resolve takes several keys in one
    // request, so a teammate's note on the second of three failures costs
    // nothing extra to find. The last ones, when a run names more than resolve
    // takes: the reporter prints the last failures too.
    const names = [...new Set(failures.map((f) => f.name).filter((n) => n !== ''))];
    const keys = names.slice(-RESOLVE_KEYS_MAX).map(testKey);
    const q = questionOf(keys, wordsOf(text, failures));
    if (q === null) return null;

    // A resolve with no keys in it is a request that can only answer nothing,
    // so it is not sent; the words round is what a nameless failure has instead.
    const stages: Leg[][] = [];
    if (keys.length > 0) stages.push([keysLeg(cfg, keys)]);
    if (q.text.length > 0) stages.push([searchLeg('team', 'failure', cfg)]);
    // A plan with no stage in it would run no leg and still be filed as a
    // `no-hit` fire: a miss the ledger records against a shelf nothing was ever
    // asked. Null is the honest `no-question` instead.
    if (stages.length === 0) return null;
    return { question: q, stages };
  },

  deliver(answer) {
    return deliver(answer, answer.shelf);
  },
};

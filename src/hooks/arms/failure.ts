import { basename } from 'node:path';
import type { HookTool } from '../../adapters/types';
import { mask } from '../../lib/redact';
import { deliver } from '../deliver';
import { projectId } from '../failure/keys';
import {
  closeOpenPairings,
  findPairing,
  openPairing,
  pairingAnswer,
  pairingIdOf,
  rememberReplay,
} from '../failure/pairings';
import { allowedHeads, errorLine, filesInError, sigV1, type Signature } from '../failure/signature';
import { sigV1Test, testIdentityOf, type TestSignature } from '../failure/test-identity';
import { getMark } from '../gates';
import { localLeg } from '../legs/local';
import { keysLeg, teamOrigin } from '../legs/shelf';
import type { Arm, FireContext, Leg } from '../types';
import { BASH_START } from './context';

/**
 * The failure arm (13-pr-d-local-arms.md, "failure"). An agent's command
 * fails: in one round, this machine's own error-to-fix record and the team
 * shelf's keys are asked under the failure's fingerprints, the teammate's
 * piece first, the local record as the fallback (decision 13). Nothing is
 * searched in words: the fingerprint is the whole mechanism (`search.md`).
 * Else a pairing opens so this agent's next passing run can close it, and a
 * pass closes whatever this agent had open on the same head under the #269
 * rule.
 *
 * `tool.ok` is `decode`'s: false on `PostToolUseFailure` and on a Bash
 * `PostToolUse` whose output carries an error marker (decision 9). The arm
 * never reads text to decide WHETHER something failed, only WHAT.
 */

/** What `plan` derived, kept for `after` under the same fire: `after` must
 *  write what was ASKED, and the test-identity read is not repeatable. */
interface Failure {
  head: string;
  cwd: string;
  command: string;
  errorLine: string;
  errorFiles: string[];
  sig: Signature | null;
  testSig: TestSignature | null;
}

const planned = new WeakMap<FireContext, Failure>();

function commandOf(tool: HookTool | undefined): string {
  return tool?.kind === 'shell' ? tool.command : '';
}

/** Both streams, and the failure string a `PostToolUseFailure` carries. A
 *  runner prints its verdict to STDOUT with an empty stderr. */
function failureText(tool: HookTool | undefined): string {
  const r = tool?.result;
  return [r?.stdout, r?.stderr, r?.error, r?.text]
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

export const failureArm: Arm = {
  id: 'failure',
  wait: 'tool',
  on: [{ event: 'tool.after', kind: 'shell' }],

  /** A pass: close what this agent had open on the same head. */
  before(ctx) {
    if (!ctx.deps.config().hooks.failure) return;
    const tool = ctx.input.tool;
    if (tool?.ok !== true) return;
    const command = commandOf(tool);
    const heads = allowedHeads(command);
    if (heads.length === 0) return;
    closeOpenPairings(ctx.deps.db, ctx.actor, ctx.input.cwd, command, heads, ctx.deps.clock());
  },

  async plan(ctx) {
    const cfg = ctx.deps.config();
    if (!cfg.hooks.failure) return null;
    const tool = ctx.input.tool;
    if (tool?.ok !== false) return null;
    const command = commandOf(tool);
    const heads = allowedHeads(command);
    const head = heads[heads.length - 1];
    if (head === undefined) return null;
    const { db } = ctx.deps;
    const cwd = ctx.input.cwd;
    const text = failureText(tool);
    const found = errorLine(text);
    const sig = found === null ? null : sigV1(found.line, found.block);
    // The context arm's stamp for THIS call, so a report from the run before
    // it cannot be read as this run's. No stamp, no artifact leg: `Number(null)`
    // is 0, which would accept any report ever written.
    const stamp = getMark(db, ctx.actor, BASH_START);
    const since = stamp === null ? Number.NaN : Number(stamp);
    const identity = await testIdentityOf(
      text,
      cwd,
      Number.isFinite(since) ? since : null,
      command,
    );
    const testSig = identity === null ? null : sigV1Test(identity);
    if (sig === null && testSig === null) return null;
    const project = projectId(cwd);
    planned.set(ctx, {
      head,
      cwd,
      command: mask(command),
      errorLine: found === null ? '' : mask(found.line),
      errorFiles: found === null ? [] : filesInError(found.block),
      sig,
      testSig,
    });

    const local = localLeg('local', () => {
      for (const key of [sig?.key, testSig?.key]) {
        if (key === undefined) continue;
        const match = findPairing(db, project, key);
        if (match !== null) return pairingAnswer(match);
      }
      return null;
    });
    const fine: string[] = [];
    if (sig !== null) fine.push('sig_v1:' + sig.key);
    if (testSig !== null) fine.push('sig_v1_test:' + testSig.key);
    const stages: Leg[][] = teamOrigin(cfg) !== null ? [[local, keysLeg(cfg, fine)]] : [[local]];
    return {
      question: { text: '', questionKey: sig?.key ?? testSig?.key ?? '' },
      stages,
    };
  },

  deliver(answer) {
    return deliver(answer, answer.shelf);
  },

  /**
   * Every local write, on any outcome but `deadline` (which never reaches
   * here). A local hit is remembered so this agent's later pass can be its
   * second closer; a keys hit opens a pairing even with no file, so this
   * machine's later close is recorded too; anything else opens the rows the
   * failure earned. A question another fire of this actor already holds or
   * answered (`asked`, `cached`, `seen`) opened its rows then: a re-run is one
   * problem, not two.
   */
  after(ctx, result, question) {
    const failure = planned.get(ctx);
    if (question === null || failure === undefined) return null;
    const { db, clock } = ctx.deps;
    const now = clock();
    const answer = result.answer;
    if (answer?.shelf === 'local') {
      const id = pairingIdOf(answer.resourceId);
      if (id !== null) rememberReplay(db, ctx.actor, failure.head, id, now);
      return null;
    }
    if (result.reason === 'asked' || result.reason === 'cached' || result.reason === 'seen') {
      return null;
    }
    const post = answer?.shelf === 'keys' ? answer : null;
    const base = {
      session: ctx.actor.session,
      cwd: failure.cwd,
      cmdHead: failure.head,
      cmd: failure.command,
      errorLine: failure.errorLine,
    };
    const opened: number[] = [];
    if (failure.sig !== null && (failure.errorFiles.length > 0 || post !== null)) {
      opened.push(
        openPairing(
          db,
          {
            ...base,
            kind: 'sig_v1',
            key: failure.sig.key,
            errorFiles: failure.errorFiles,
          },
          now,
        ),
      );
    }
    if (failure.testSig !== null) {
      opened.push(
        openPairing(
          db,
          {
            ...base,
            kind: 'sig_v1_test',
            key: failure.testSig.key,
            // The basename: the close rule compares basenames, and the key
            // already keeps the directory apart.
            errorFiles: [basename(failure.testSig.file)],
          },
          now,
        ),
      );
    }
    if (post !== null) {
      for (const id of opened) rememberReplay(db, ctx.actor, failure.head, id, now);
    }
    return null;
  },
};

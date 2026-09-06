import { basename } from 'node:path';
import type { HookTool } from '../../adapters/types';
import { mask } from '../../lib/redact';
import { isTeamShelfOrigin } from '../../lib/settings';
import { tryOriginOf } from '../../lib/url';
import { deliver } from '../deliver';
import {
  closeOpenPairings,
  findPairing,
  linkPost,
  openPairing,
  pairingAnswer,
  pairingIdOf,
  projectOf,
  rememberReplay,
  safeCommand,
} from '../failure/pairings';
import { repoSlugOf } from '../failure/repo';
import {
  allowedHeads,
  errorLine,
  filesInError,
  saltedCoarse,
  sigV1,
  type Signature,
} from '../failure/signature';
import { sigV1Test, testIdentityOf, type TestSignature } from '../failure/test-identity';
import { getMark } from '../gates';
import { localLeg } from '../legs/local';
import { keysLeg } from '../legs/shelf';
import type { Arm, FireContext, KernelConfig, Leg } from '../types';

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

const BASH_START = 'bashstart';

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
  const command = tool?.input.command;
  return typeof command === 'string' ? command : '';
}

/** Both streams, and the failure string a `PostToolUseFailure` carries. A
 *  runner prints its verdict to STDOUT with an empty stderr. */
function failureText(tool: HookTool | undefined): string {
  const r = tool?.result;
  return [r?.stdout, r?.stderr, r?.error, r?.text]
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

/** The team shelf's origin, or null when `baseUrl` is the public marketplace:
 *  keys go to a team shelf only (there is no public resolve). */
function teamOrigin(cfg: KernelConfig): string | null {
  const origin = tryOriginOf(cfg.baseUrl);
  return origin !== null && isTeamShelfOrigin(origin, cfg.publicShelfUrl) ? origin : null;
}

/** The stage-1 leg: a coarse test-identity hit says "same file and suite",
 *  never "same test", and the server does not say which key matched, so its
 *  answer is a pointer and never a fix body. */
function pointerLeg(leg: Leg): Leg {
  return {
    ...leg,
    verdict(result) {
      const answer = leg.verdict(result);
      if (answer === null) return null;
      const { text: body, ...pointer } = answer;
      return body === undefined ? answer : pointer;
    },
  };
}

export const failureArm: Arm = {
  id: 'failure',
  wait: 'tool',
  on: [{ event: 'tool.after', kind: 'shell' }],

  /** A pass: close what this agent had open on the same head. */
  before(ctx) {
    if (ctx.deps.config().hooks.push !== 'on') return;
    const tool = ctx.input.tool;
    if (tool?.ok !== true) return;
    const command = commandOf(tool);
    const heads = allowedHeads(command);
    if (heads.length === 0) return;
    closeOpenPairings(ctx.deps.db, ctx.actor, ctx.input.cwd, command, heads, ctx.deps.clock());
  },

  async plan(ctx) {
    const cfg = ctx.deps.config();
    if (cfg.hooks.push !== 'on') return null;
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
    // it cannot be read as this run's.
    const since = Number(getMark(db, ctx.actor, BASH_START));
    const identity = await testIdentityOf(
      text,
      cwd,
      Number.isFinite(since) ? since : null,
      command,
    );
    const testSig = identity === null ? null : sigV1Test(identity);
    if (sig === null && testSig === null) return null;
    const repo = await repoSlugOf(cwd);
    const project = projectOf(cwd);
    planned.set(ctx, {
      head,
      cwd,
      command: safeCommand(command),
      errorLine: found === null ? '' : mask(found.line),
      errorFiles: found === null ? [] : filesInError(found.block),
      sig,
      testSig,
    });

    const local = localLeg('local', () => {
      if (sig !== null) {
        const match = findPairing(db, project, sig.key, sig.coarseKey);
        if (match !== null) return pairingAnswer(match, true);
      }
      if (testSig !== null) {
        const match = findPairing(db, project, testSig.key, testSig.coarseKey);
        if (match !== null) return pairingAnswer(match, match.key === testSig.key);
      }
      return null;
    });
    // The fine keys travel with or without a git origin; only a coarse key
    // is salted with the repo, and without one it is not sent at all.
    const fine: string[] = [];
    if (sig !== null) fine.push('sig_v1:' + sig.key);
    if (sig !== null && sig.coarseKey !== null && repo.length > 0)
      fine.push('sig_v1c:' + saltedCoarse(sig.coarseKey, repo));
    if (testSig !== null) fine.push('sig_v1_test:' + testSig.key);
    const team = teamOrigin(cfg) !== null;
    const stages: Leg[][] = [team ? [local, keysLeg(cfg, fine)] : [local]];
    if (team && testSig !== null && repo.length > 0) {
      stages.push([
        pointerLeg(keysLeg(cfg, ['sig_v1_test_c:' + saltedCoarse(testSig.coarseKey, repo)])),
      ]);
    }
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
   * second closer; a keys hit opens a pairing even with no file, linked to
   * the post, so this machine's later close can be carried back; anything
   * else opens the rows the failure earned. A question another fire of this
   * actor already holds or answered (`asked`, `cached`, `seen`) opened its
   * rows then: a re-run is one problem, not two.
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
            coarseKey: failure.sig.coarseKey,
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
            coarseKey: failure.testSig.coarseKey,
            // The basename: the close rule compares basenames, and the key
            // already keeps the directory apart.
            errorFiles: [basename(failure.testSig.file)],
          },
          now,
        ),
      );
    }
    if (post !== null) {
      const origin = teamOrigin(ctx.deps.config()) ?? '';
      for (const id of opened) {
        rememberReplay(db, ctx.actor, failure.head, id, now);
        linkPost(db, id, post.resourceId, origin, now);
      }
    }
    return null;
  },
};

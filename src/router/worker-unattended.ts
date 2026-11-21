/**
 * A DEEPSEEK WORKER'S PERMISSION ASKS WHERE NOBODY CAN BE ASKED (auto and bypass
 * modes). A native subagent in those modes has a person behind it for the rare
 * ask; a worker has none, so each ask is answered here, at once.
 *
 * One kind is answered yes, in bypass mode only: the read block's ask about a
 * shell command. `permissions.blockReadsOutsideWorkingDirectories` keeps a worker's reads
 * inside the consented directories. For a shell command it has two layers: the
 * sandbox, which refuses the read itself, and a check of the command's text
 * before it runs, which asks about a command whose paths it cannot work out
 * (such as `cd <worktree> && git status | head && git diff main...HEAD`). A
 * worker's commands always run in the sandbox, so the sandbox is the boundary:
 * such a command runs, and a read outside consent fails at the read, not the
 * whole command. A command that names a path outside consent stays refused.
 *
 * In auto mode the same ask is refused. A yes here runs the whole command with
 * no verdict from the mode's classifier, and the command can hold more than the
 * read: `cd <worktree> && git status && git push` has this ask's shape too. So
 * the worker is told how to send the call in a form the classifier can judge.
 * In bypass mode a native session judges no call either, so nothing is skipped.
 *
 * Every other ask is answered no, in words that do not tell the worker to give
 * the tool up for the rest of the job.
 */

/** What Claude Code tells `canUseTool` about an ask. */
export type WorkerAsk = {
  decisionReason?: string;
  decisionReasonType?: string;
  decisionReasonCode?: string;
  blockedPath?: string;
  matchedAskRule?: unknown;
};

/** Whether an ask is the read block's about a shell command whose paths it could not work out. */
export function readBlockUnchecked(
  tool: string,
  input: Record<string, unknown>,
  ask: WorkerAsk,
): boolean {
  // The shape read from Claude Code 2.1.326: it withholds the text of the read block's
  // own asks from `canUseTool`, and every other safety check keeps its text. A compound
  // command's ask (`subcommandResults`) is not this one: it can stand for a person's own
  // ask rule on one part of the command.
  return (
    tool === 'Bash' &&
    // A command asking to leave the sandbox is never one the sandbox confines.
    input.dangerouslyDisableSandbox !== true &&
    ask.decisionReasonType === 'safetyCheck' &&
    !ask.decisionReason &&
    // The read block found a path outside consent: refused, as the read block means.
    ask.decisionReasonCode === undefined &&
    ask.blockedPath === undefined &&
    ask.matchedAskRule === undefined
  );
}

/** Whether the sandbox alone may judge the ask: only where the mode judges no call itself. */
export function sandboxJudgesRead(
  tool: string,
  input: Record<string, unknown>,
  ask: WorkerAsk,
  mode: string,
): boolean {
  return mode === 'bypassPermissions' && readBlockUnchecked(tool, input, ask);
}

/**
 * What the worker reads for an ask nobody can answer: about this one call, never the
 * tool. `unchecked` is the read block's ask in auto mode, which has a form that runs.
 */
export function unattendedDenial(ask: WorkerAsk, unchecked = false): string {
  const reason =
    ask.decisionReason ||
    (ask.blockedPath ? `it reads ${ask.blockedPath}, outside the working directories` : '') ||
    (unchecked
      ? 'the check that keeps reads inside the working directories could not work out the paths of this command. Send it in a form that can be judged: run each `cd` as its own call, or give the folder to the command itself (`git -C <path> ...`)'
      : '');
  return (
    'This call needs a person to approve it, and nobody can be asked during this job, so it was not run' +
    (reason ? `: ${reason}` : '') +
    '. Only this call was refused: every other call, of this tool too, is still judged on its own. Reach the same result another way if there is one, or go on with the rest of the task and say in your answer what was refused.'
  );
}

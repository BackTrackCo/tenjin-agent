/**
 * A DEEPSEEK WORKER'S PERMISSION ASKS WHERE NOBODY CAN BE ASKED (auto and bypass
 * modes). A native subagent in those modes has a person behind it for the rare
 * ask; a worker has none, so each ask is answered here, at once.
 *
 * One kind is answered yes: the read block's ask about a shell command.
 * `permissions.blockReadsOutsideWorkingDirectories` keeps a worker's reads
 * inside the consented directories. For a shell command it has two layers: the
 * sandbox, which refuses the read itself, and a check of the command's text
 * before it runs, which asks about any command whose paths it cannot work out
 * (`cd "$DIR"`, a pipe into `gh`, `node -e`). A worker's commands always run in
 * the sandbox, so the sandbox is the boundary: such a command runs, and a read
 * outside consent fails at the read, not the whole command.
 *
 * Every other ask is answered no, in words that do not tell the worker to give
 * the tool up for the rest of the job.
 */
const READ_BLOCK = 'permissions.blockReadsOutsideWorkingDirectories';

/** Whether an ask is the read block's about a shell command the sandbox will confine. */
export function sandboxJudgesRead(
  tool: string,
  input: Record<string, unknown>,
  reason: string | undefined,
): boolean {
  return (
    tool === 'Bash' &&
    // A command asking to leave the sandbox is never one the sandbox confines.
    input.dangerouslyDisableSandbox !== true &&
    typeof reason === 'string' &&
    reason.includes(READ_BLOCK) &&
    !/sandbox/i.test(reason)
  );
}

/** What the worker reads for an ask nobody can answer: about this one call, never the tool. */
export function unattendedDenial(reason: string | undefined): string {
  return (
    'This call needs a person to approve it, and nobody can be asked during this job, so it was not run' +
    (reason ? `: ${reason}` : '') +
    '. Only this call was refused: every other call, of this tool too, is still judged on its own. Reach the same result another way if there is one, or go on with the rest of the task and say in your answer what was refused.'
  );
}

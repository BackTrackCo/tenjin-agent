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
 * In auto mode a yes here runs the whole command with no verdict from the mode's
 * classifier, and the command can hold more than the read: `cd <worktree> && git
 * status && git push` has this ask's shape too. A native subagent has no read
 * block, so its classifier judges such a command and lets one that only reads
 * run. The worker does the same for the part it can judge itself: a command made
 * only of commands that read (`cd`, `ls`, `grep`, `git status`, and the rest of
 * `READS`) runs under the sandbox, which confines what it reads. Any other
 * command is still refused, and the worker is told how to send the call in a
 * form the classifier can judge: this callback cannot ask the classifier.
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

/** Commands that read and print, and start nothing else. */
const READS = new Set([
  'cd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'echo',
  'printf',
  'pwd',
  'sort',
  'uniq',
  'cut',
  'tr',
  'find',
  'stat',
  'file',
  'basename',
  'dirname',
  'tree',
  'du',
  'true',
  'test',
]);
/** Git subcommands that read the repository and write nothing. */
const GIT_READS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'describe',
  'merge-base',
  'cat-file',
  'shortlog',
]);
/** Options that make a reading command write a file or start another program. */
const NOT_READING: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/,
  rg: /^--pre(=|$)|^--pre-glob/,
  sort: /^(-o|--output|--compress-program)/,
  git: /^(--output|--ext-diff|--textconv|-O)/,
};

/**
 * Whether a shell command only reads: every command in it is one of `READS` or a
 * reading git subcommand, with nothing that writes, substitutes or starts a program.
 * Deliberately narrow. The text is cut at every separator, inside quotes too, so a
 * quoted separator makes a piece this refuses, never one it passes; a command it does
 * not know is refused, and the worker sends it in a form the classifier can judge.
 */
export function readsOnly(command: string): boolean {
  // The two redirects a listing uses to quiet errors; any other redirect writes or feeds.
  const text = command
    .replace(/\s2>\s?\/dev\/null(?=\s|;|\||&|$)/g, ' ')
    .replace(/\s2>&1(?=\s|;|\||&|$)/g, ' ');
  if (!text.trim() || /[`<>\\]|\$\(|\$\{|(^|[^&])&($|[^&])/.test(text)) return false;
  for (const piece of text.split(/&&|\|\||[;|\n]/)) {
    const words = piece.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    const name = words[0]!;
    // An assignment before a command (`PAGER=x git log`) changes what it runs.
    if (name.includes('=')) return false;
    if (name === 'git') {
      let at = 1;
      while (words[at] === '-C' || words[at] === '--no-pager') at += words[at] === '-C' ? 2 : 1;
      if (!GIT_READS.has(words[at] ?? '')) return false;
    } else if (!READS.has(name)) return false;
    const refused = NOT_READING[name];
    if (refused && words.slice(1).some((word) => refused.test(word))) return false;
  }
  return true;
}

/**
 * Whether the sandbox alone may judge the ask. In bypass mode, where the mode judges no
 * call itself, always. In auto mode, for a command that only reads, as the classifier of
 * a native subagent lets such a command run; anything else keeps its refusal.
 */
export function sandboxJudgesRead(
  tool: string,
  input: Record<string, unknown>,
  ask: WorkerAsk,
  mode: string,
): boolean {
  if (!readBlockUnchecked(tool, input, ask)) return false;
  return (
    mode === 'bypassPermissions' ||
    (mode === 'auto' && typeof input.command === 'string' && readsOnly(input.command))
  );
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
      ? 'the check that keeps reads inside the working directories could not work out the paths of this command, and it does more than read. Send it in a form that can be judged: run each `cd` as its own call, or give the folder to the command itself (`git -C <path> ...`)'
      : '');
  return (
    'This call needs a person to approve it, and nobody can be asked during this job, so it was not run' +
    (reason ? `: ${reason}` : '') +
    '. Only this call was refused: every other call, of this tool too, is still judged on its own. Reach the same result another way if there is one, or go on with the rest of the task and say in your answer what was refused.'
  );
}

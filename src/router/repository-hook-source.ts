import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSnapshotSourcePath } from './jevgrep/snapshot';
import type { RequestToolResult } from './tool';

const exec = promisify(execFile);
const PATH = '((?:"(?:\\\\.|[^"\\\\])*"))';
const BLOCK = new RegExp(
  `^Source block ${PATH} lines ([1-9][0-9]*)-([1-9][0-9]*):\\n\x60\x60\x60[^\\n]*\\n([\\s\\S]+?)\\n\x60\x60\x60(?=\\n|$)`,
  'gm',
);
const LISTED = new RegExp(`^- ${PATH} — [^\\n]+$`, 'gm');

/** Only exact committed source is forwarded; provider prose is not authority. */
export async function repositorySource(
  result: RequestToolResult,
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = AbortSignal.timeout(10_000);
  const verificationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const output = result.envelope.result;
  const snapshot = result.envelope.snapshot as
    { commit?: unknown; files?: unknown; source?: unknown } | undefined;
  if (
    result.isError ||
    result.envelope.status !== 'fulfilled' ||
    result.envelope.executor !== 'jevgrep-search-v1' ||
    typeof output !== 'string' ||
    output.includes('\0') ||
    Buffer.byteLength(output) > 32 * 1024 ||
    !output.trimEnd().endsWith('End context.') ||
    snapshot?.commit !== commit ||
    snapshot.source !== 'git-head-committed-only' ||
    !Number.isSafeInteger(snapshot.files) ||
    (snapshot.files as number) < 1
  )
    return null;
  const count = /^Jevgrep: ([1-9][0-9]*) relevant files\.$/m.exec(output);
  if (!count || Number(count[1]) > (snapshot.files as number)) return null;
  try {
    const listed = [...output.matchAll(LISTED)].map((m) => JSON.parse(m[1]!) as unknown);
    if (
      listed.some((p) => typeof p !== 'string' || !isSnapshotSourcePath(p)) ||
      new Set(listed).size !== Number(count[1])
    )
      return null;
    const blocks = [...output.matchAll(BLOCK)];
    if (blocks.length === 0 || blocks.length > 32) return null;
    const sources: string[] = [];
    const blobs = new Map<string, string>();
    for (const block of blocks) {
      const path = JSON.parse(block[1]!) as string;
      const start = Number(block[2]),
        end = Number(block[3]),
        source = block[4]!;
      if (!listed.includes(path) || !Number.isSafeInteger(end) || start > end || !source.trim())
        return null;
      let blob = blobs.get(path);
      if (blob === undefined) {
        const read = await exec('git', ['-C', root, 'show', `${commit}:${path}`], {
          timeout: 5000,
          maxBuffer: 256 * 1024,
          signal: verificationSignal,
        });
        blob = read.stdout;
        blobs.set(path, blob);
      }
      if (
        blob
          .split('\n')
          .slice(start - 1, end)
          .join('\n') !== source
      )
        return null;
      sources.push(
        `Source block ${JSON.stringify(path)} lines ${start}-${end}:\n\x60\x60\x60\n${source}\n\x60\x60\x60`,
      );
    }
    return (
      `Committed HEAD snapshot ${commit}. Uncommitted and untracked changes omitted.\n` +
      `Relevant file leads (may require native reads):\n${listed.map((p) => `- ${JSON.stringify(p)}`).join('\n')}\n\n` +
      sources.join('\n\n')
    );
  } catch {
    return null;
  }
}

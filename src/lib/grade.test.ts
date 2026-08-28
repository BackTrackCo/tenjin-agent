import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_ID_RE,
  SPAN_WINDOW,
  backtickSpans,
  findAnchor,
  findTranscript,
  firstToolCall,
  gradeInjection,
  gradeRelayed,
  parseSince,
  parseTranscript,
  type GradeTarget,
} from './grade';
import { prelude } from './hook-scripts';

const RES = '0197aaaa-bbbb-cccc-dddd-000000000001';
const URL = 'https://tenjin.blog/p/the-collation-trap';

/** The two attachment rows a main-session injection writes, as the harness
 *  writes them: the hook receipt, then the context the model actually sees. */
function contextRow(text: string): string {
  return JSON.stringify({
    type: 'attachment',
    attachment: { type: 'hook_additional_context', content: [text], hookName: 'PostToolUse' },
  });
}

function hookSuccessRow(): string {
  return JSON.stringify({
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'PostToolUse', stdout: '{}' },
  });
}

function toolUse(name: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}

function assistantText(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function compactSummary(name: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    isCompactSummary: true,
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}

function target(over: Partial<GradeTarget> = {}): GradeTarget {
  return { resourceId: RES, url: URL, title: 'The collation trap', ...over };
}

const INJECTED = [
  'Tenjin found a finding that may apply here: "The collation trap".',
  'Read it free: tenjin read ' + RES,
  'It says the fix is `pnpm db:generate --force` and nothing else.',
].join('\n');

describe('parseTranscript', () => {
  it('keeps context rows and tool inputs in line order, and drops everything else', () => {
    const rows = parseTranscript(
      [
        hookSuccessRow(),
        contextRow('shown'),
        assistantText('I will now do the thing.'),
        toolUse('Bash', { command: 'pnpm test' }),
        'not json at all',
        toolUse('Edit', { file_path: '/a.ts', new_string: 'x' }),
      ].join('\n'),
    );
    expect(rows.map((r) => r.kind)).toEqual(['context', 'tool_use', 'tool_use']);
    expect(rows[0]?.line).toBe(2);
    // One string per call, so a Bash command and an Edit's new text read alike.
    expect(rows[1]?.text).toContain('pnpm test');
    expect(rows[2]?.text).toContain('new_string');
  });

  /** A compaction replays earlier calls into a summary the assistant carries
   *  forward. Counting them would let an injection be "used" by the echo of a
   *  call made before it was ever shown. */
  it('skips a compact summary, however tool-shaped it looks', () => {
    const rows = parseTranscript(
      [contextRow('shown'), compactSummary('Bash', { command: `tenjin read ${RES}` })].join('\n'),
    );
    expect(rows.map((r) => r.kind)).toEqual(['context']);
  });
});

describe('findAnchor', () => {
  it('matches the resource id, then the url, then the title', () => {
    const byId = parseTranscript([contextRow(`see tenjin read ${RES}`)].join('\n'));
    expect(findAnchor(byId, target())).toBe(0);

    const byUrl = parseTranscript([contextRow(`see ${URL}`)].join('\n'));
    expect(findAnchor(byUrl, target({ resourceId: null }))).toBe(0);

    const byTitle = parseTranscript([contextRow('see "The collation trap"')].join('\n'));
    expect(findAnchor(byTitle, target({ resourceId: null, url: null }))).toBe(0);
  });

  it('is -1 when nothing in the transcript names the piece', () => {
    const rows = parseTranscript(
      [contextRow('some other hook said something'), toolUse('Bash', { command: 'ls' })].join('\n'),
    );
    expect(findAnchor(rows, target())).toBe(-1);
  });
});

describe('backtickSpans', () => {
  it('keeps spans of two words or more, deduped, and drops single tokens', () => {
    expect(
      backtickSpans('run `pnpm db:generate --force` after `pnpm` and `pnpm db:generate --force`'),
    ).toEqual(['pnpm db:generate --force']);
  });
});

describe('gradeInjection', () => {
  function grade(lines: string[], opts: { ended: boolean }, t: GradeTarget = target()) {
    const rows = parseTranscript(lines.join('\n'));
    return gradeInjection(rows, findAnchor(rows, t), t, opts);
  }

  it('grades used/read on a later tenjin read of the id', () => {
    const verdict = grade(
      [contextRow(INJECTED), toolUse('Bash', { command: `tenjin read ${RES} --json` })],
      { ended: false },
    );
    expect(verdict).toMatchObject({ outcome: 'used', by: 'read' });
  });

  it('grades used/read on tenjin inspect and on the injected url', () => {
    expect(
      grade([contextRow(INJECTED), toolUse('Bash', { command: `tenjin inspect ${RES}` })], {
        ended: false,
      }),
    ).toMatchObject({ outcome: 'used', by: 'read' });
    expect(
      grade([contextRow(INJECTED), toolUse('WebFetch', { url: URL })], { ended: false }),
    ).toMatchObject({ outcome: 'used', by: 'read' });
  });

  it('grades used/span when a two-word backtick span reappears in a tool input', () => {
    const verdict = grade(
      [contextRow(INJECTED), toolUse('Bash', { command: 'pnpm db:generate --force' })],
      { ended: false },
    );
    expect(verdict).toMatchObject({
      outcome: 'used',
      by: 'span',
      evidence: 'pnpm db:generate --force',
    });
  });

  /** One word is what the agent was going to type anyway. */
  it('does not take a one-word span as evidence', () => {
    const verdict = grade(
      [contextRow('Try `pnpm` when this fails.'), toolUse('Bash', { command: 'pnpm test' })],
      { ended: true },
      target({ resourceId: null, url: null, title: 'Try' }),
    );
    expect(verdict).toMatchObject({ outcome: 'rejected' });
  });

  it('reports read rather than span when both appear', () => {
    const verdict = grade(
      [
        contextRow(INJECTED),
        toolUse('Bash', { command: 'pnpm db:generate --force' }),
        toolUse('Bash', { command: `tenjin read ${RES}` }),
      ],
      { ended: false },
    );
    expect(verdict).toMatchObject({ outcome: 'used', by: 'read' });
  });

  /** A copied command is only evidence while the injection is still in view; a
   *  bought piece is evidence whenever it is bought. */
  it('expires span evidence after the window, but never the explicit id', () => {
    const filler = Array.from({ length: SPAN_WINDOW }, (_, i) =>
      toolUse('Bash', { command: `echo ${i}` }),
    );
    const late = grade(
      [contextRow(INJECTED), ...filler, toolUse('Bash', { command: 'pnpm db:generate --force' })],
      { ended: true },
    );
    expect(late).toMatchObject({ outcome: 'rejected' });

    const lateRead = grade(
      [contextRow(INJECTED), ...filler, toolUse('Bash', { command: `tenjin read ${RES}` })],
      { ended: true },
    );
    expect(lateRead).toMatchObject({ outcome: 'used', by: 'read' });
  });

  it('rejects with the next three tool inputs as evidence once the session has ended', () => {
    const verdict = grade(
      [
        contextRow(INJECTED),
        toolUse('Bash', { command: 'a' }),
        toolUse('Bash', { command: 'b' }),
        toolUse('Bash', { command: 'c' }),
        toolUse('Bash', { command: 'd' }),
      ],
      { ended: true },
    );
    expect(verdict.outcome).toBe('rejected');
    expect((verdict as { evidence: string[] }).evidence).toHaveLength(3);
  });

  /**
   * A running session has not said no, it has said nothing yet. Writing
   * `rejected` here would post a verdict the very next tool call could
   * contradict, and the server keeps the first verdict per (lookup, post).
   */
  it('leaves a row open when nothing matched and the session is still running', () => {
    const verdict = grade([contextRow(INJECTED), toolUse('Bash', { command: 'ls' })], {
      ended: false,
    });
    expect(verdict.outcome).toBeNull();
  });

  it('is unobserved when there is no anchor to grade from', () => {
    const rows = parseTranscript([toolUse('Bash', { command: 'ls' })].join('\n'));
    expect(gradeInjection(rows, -1, target(), { ended: true })).toEqual({
      outcome: 'unobserved',
      by: 'none',
    });
  });
});

/**
 * A relayed finding has no anchor row anywhere — the subagent arm hands the text
 * to the child as its opening context and neither transcript records it — so the
 * child's FIRST tool call is already evidence.
 */
describe('gradeRelayed', () => {
  function relayed(lines: string[], opts: { ended: boolean }, t: GradeTarget = target()) {
    return gradeRelayed(parseTranscript(lines.join('\n')), t, opts);
  }

  it('counts the first tool call itself as evidence', () => {
    const verdict = relayed([toolUse('Bash', { command: `tenjin read ${RES}` })], { ended: false });
    expect(verdict).toMatchObject({ outcome: 'used', by: 'read' });
  });

  it('takes the url anywhere later, but a title span only inside the window', () => {
    const idle = Array.from({ length: SPAN_WINDOW }, () => toolUse('Bash', { command: 'ls' }));
    expect(
      relayed([...idle, toolUse('Bash', { command: `curl ${URL}` })], { ended: true }),
    ).toMatchObject({ outcome: 'used', by: 'read' });

    // The title is the ONLY injected text a relayed row leaves on disk, so it is
    // the only place its spans can come from.
    const titled = target({
      resourceId: null,
      url: null,
      title: 'Run `pnpm db:generate --force` first',
    });
    const copied = toolUse('Bash', { command: 'pnpm db:generate --force' });
    expect(relayed([copied], { ended: true }, titled)).toMatchObject({
      outcome: 'used',
      by: 'span',
    });
    expect(relayed([...idle, copied], { ended: true }, titled).outcome).toBe('rejected');
  });

  it('rejects with the next tool inputs once the child has ended, and stays open otherwise', () => {
    const lines = [
      toolUse('Bash', { command: 'a' }),
      toolUse('Bash', { command: 'b' }),
      toolUse('Bash', { command: 'c' }),
      toolUse('Bash', { command: 'd' }),
    ];
    const ended = relayed(lines, { ended: true });
    expect(ended.outcome).toBe('rejected');
    expect((ended as { evidence: string[] }).evidence).toHaveLength(3);
    expect(relayed(lines, { ended: false }).outcome).toBeNull();
  });

  it('rejects a child that made no tool calls once it has ended', () => {
    expect(relayed([assistantText('thinking about it')], { ended: true })).toEqual({
      outcome: 'rejected',
      by: 'none',
      evidence: [],
    });
    expect(relayed([assistantText('thinking about it')], { ended: false }).outcome).toBeNull();
  });

  it('finds the first tool call, or says there is none', () => {
    expect(
      firstToolCall(
        parseTranscript(
          [contextRow('unrelated'), assistantText('hm'), toolUse('Bash', { command: 'ls' })].join(
            '\n',
          ),
        ),
      ),
    ).toBe(1);
    expect(firstToolCall(parseTranscript(assistantText('hm')))).toBe(-1);
  });
});

describe('parseSince', () => {
  it('accepts days, hours and minutes', () => {
    expect(parseSince('7d')).toBe(7 * 24 * 60 * 60_000);
    expect(parseSince('24h')).toBe(24 * 60 * 60_000);
    expect(parseSince('30m')).toBe(30 * 60_000);
  });

  it('refuses anything else rather than defaulting silently', () => {
    for (const bad of ['7', 'd', '7w', '0d', '-1d', '', 'seven days']) {
      expect(() => parseSince(bad), bad).toThrowError(expect.objectContaining({ code: 'USAGE' }));
    }
  });
});

describe('findTranscript', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tenjin-grade-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('finds the session file under whichever project directory holds it', async () => {
    const project = join(home, '.claude', 'projects', '-Users-someone-repo');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${RES}.jsonl`), '');
    expect(await findTranscript(home, RES)).toEqual({
      kind: 'found',
      path: join(project, `${RES}.jsonl`),
    });
  });

  /**
   * A LISTED directory with no file for this session is a fact about the
   * session, and the caller is allowed to settle a verdict on it. It is the one
   * negative answer that may.
   */
  it('reports absent when the projects directory was read and holds no such file', async () => {
    await mkdir(join(home, '.claude', 'projects', '-Users-someone-repo'), { recursive: true });
    expect(await findTranscript(home, '0197aaaa-bbbb-cccc-dddd-000000000099')).toEqual({
      kind: 'absent',
    });
  });

  /** The id becomes a filename, so it is checked like one before it is joined.
   *  An id that cannot be a filename names no transcript anywhere, ever, which
   *  is absence rather than a fault of this run. */
  it('refuses a session id that is not one', async () => {
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    expect(await findTranscript(home, '../../../etc/passwd')).toEqual({ kind: 'absent' });
    expect(await findTranscript(home, '')).toEqual({ kind: 'absent' });
  });

  /**
   * NOT ABSENT. Nothing was listed, so nothing is known about the session — and
   * the caller must not turn "this machine could not look" into a permanent
   * `unobserved` on every open row.
   */
  it('reports unreadable, with a reason, when there is no projects directory at all', async () => {
    expect(await findTranscript(home, RES)).toMatchObject({
      kind: 'unreadable',
      reason: 'ENOENT',
    });
  });

  it('reports unreadable when the projects path cannot be listed', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'projects'), 'not a directory');
    expect(await findTranscript(home, RES)).toMatchObject({ kind: 'unreadable' });
  });

  /**
   * A subagent's tool calls are in NO parent file, so a row stamped with an
   * agent id is answered by the child's own transcript or by nothing.
   */
  it('finds a child transcript under <session>/subagents/agent-<id>.jsonl when given an agent id', async () => {
    const project = join(home, '.claude', 'projects', '-Users-someone-repo');
    const child = join(project, RES, 'subagents');
    await mkdir(child, { recursive: true });
    await writeFile(join(project, `${RES}.jsonl`), '');
    await writeFile(join(child, 'agent-a1.jsonl'), '');
    expect(await findTranscript(home, RES, 'a1')).toEqual({
      kind: 'found',
      path: join(child, 'agent-a1.jsonl'),
    });
  });

  /** The parent file existing says nothing about the child: they are different
   *  files and the parent holds none of the child's calls. */
  it('reports absent for a child id that has no file, even when the parent file exists', async () => {
    const project = join(home, '.claude', 'projects', '-Users-someone-repo');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${RES}.jsonl`), '');
    expect(await findTranscript(home, RES, 'a1')).toEqual({ kind: 'absent' });
  });

  it('refuses an agent id that is not one', async () => {
    await mkdir(join(home, '.claude', 'projects', '-Users-someone-repo'), { recursive: true });
    expect(await findTranscript(home, RES, '../x')).toEqual({ kind: 'absent' });
    expect(await findTranscript(home, RES, '')).toEqual({ kind: 'absent' });
  });

  /**
   * The arms record an agent id under one bound and this reads a file under
   * another; an id one side accepts and the other refuses is a row that can
   * never be graded, so the two are pinned to the same literal.
   */
  it('bounds the agent id exactly as the hook accessor that recorded it does', () => {
    expect(prelude('/tmp/data', 1000)).toContain(`/${AGENT_ID_RE.source}/.test(id)`);
  });

  /** One project directory this run cannot stat into could be the one holding
   *  the file, so the sweep can no longer claim it is absent. Skipped as root,
   *  where the mode bits do not deny anything. */
  it.skipIf(process.getuid?.() === 0)(
    'reports unreadable when a project directory blocks the lookup',
    async () => {
      const readable = join(home, '.claude', 'projects', '-Users-someone-repo');
      const blocked = join(home, '.claude', 'projects', '-Users-someone-other');
      await mkdir(readable, { recursive: true });
      await mkdir(blocked, { recursive: true });
      await chmod(blocked, 0o000);
      try {
        expect(await findTranscript(home, RES)).toMatchObject({ kind: 'unreadable' });
      } finally {
        // Restored before teardown, which would otherwise fail to rm it.
        await chmod(blocked, 0o700);
      }
    },
  );
});

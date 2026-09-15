import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMark } from '../gates';
import type { LoopDb } from '../store';
import type { HookTool } from '../../adapters/types';
import type { Actor, KernelConfig } from '../types';
import { contextArm } from './context';
import {
  CHILD,
  LEAD,
  cleanup,
  fireContext,
  freshDb,
  hookInput,
  kernelConfig,
  toolInput,
} from './test-support';

/**
 * The mechanical lane, which asks nothing. What is under test is the marks the
 * publish arm reads — per actor, so a subagent's edit is the subagent's — and
 * the absence of everything else: no plan, no question, no lookup, and no mark
 * at all for a shell call.
 */

const ON = kernelConfig();

let db: LoopDb;

beforeEach(() => {
  db = freshDb();
});

afterEach(cleanup);

/** The mark key the arm derives from a path, computed here rather than
 *  imported: the rule under test is "sha256 of the whole path", not whatever
 *  the arm happens to do. */
function key(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32);
}

function ctxFor(
  event: 'tool.before' | 'tool.after',
  tool: HookTool,
  actor: Actor = LEAD,
  config: KernelConfig = ON,
) {
  return fireContext({
    db,
    arm: contextArm,
    actor,
    config,
    input: hookInput({
      event,
      native: { event: event === 'tool.before' ? 'PreToolUse' : 'PostToolUse' },
      tool,
    }),
  });
}

function fire(
  event: 'tool.before' | 'tool.after',
  tool: HookTool,
  actor: Actor = LEAD,
  config: KernelConfig = ON,
): void {
  contextArm.before?.(ctxFor(event, tool, actor, config));
}

function edit(path: string, actor: Actor = LEAD): void {
  fire('tool.before', toolInput('edit', { paths: [path] }), actor);
}

function marksOf(actor: Actor): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM marks WHERE session = ? AND agent = ?')
    .get(actor.session, actor.agent) as { n: number };
  return row.n;
}

describe('an edit that names several paths', () => {
  it('marks every path in one fire, under this actor, each with its own key', () => {
    const paths = ['/p/a.ts', '/p/b.ts', '/p/c/renamed.ts'];
    fire('tool.before', toolInput('edit', { paths }), CHILD);
    for (const path of paths) expect(getMark(db, CHILD, `edited:${key(path)}`)).toBe(path);
    expect(getMark(db, LEAD, `edited:${key(paths[0]!)}`)).toBeNull();
  });

  it('an edit with no path marks nothing, and never the activity of a child', () => {
    fire('tool.before', toolInput('edit', { paths: [] }), CHILD);
    expect(db.prepare('SELECT count(*) AS n FROM marks WHERE agent = ?').get(CHILD.agent)).toEqual({
      n: 0,
    });
  });
});

describe('the context arm registration', () => {
  it('is one tool-wait arm on two (event, kind) pairs, and never on a shell call', () => {
    expect(contextArm.id).toBe('context');
    expect(contextArm.wait).toBe('tool');
    expect(contextArm.on).toEqual([
      { event: 'tool.before', kind: 'edit' },
      { event: 'tool.after', kind: 'read' },
    ]);
  });

  it('has no plan, no delivery and no after: a fire on it is `no-question`', () => {
    expect(contextArm.plan).toBeUndefined();
    expect(contextArm.deliver).toBeUndefined();
    expect(contextArm.after).toBeUndefined();
  });
});

describe('the marks the publish arm reads', () => {
  it('marks nothing for a shell call, and above all not the activity that arms the ask', () => {
    // Registration keeps a shell call away from this arm; `before` refuses one
    // too, because falling through here would stamp `activity:mutation` on
    // every Bash call the lead makes and arm its publish ask with no work done.
    fire('tool.before', toolInput('shell', { command: 'pnpm vitest run x' }));
    expect(getMark(db, LEAD, 'activity:mutation')).toBeNull();
    expect(marksOf(LEAD)).toBe(0);
  });

  it('marks every edited path whatever its extension, with the path as the value', () => {
    const path = '/p/drizzle.config.toml';
    edit(path);
    // Nothing reads the value — the publish arm's evidence test asks only
    // whether the prefix is there — so this is the one place it is checked.
    expect(getMark(db, LEAD, `edited:${key(path)}`)).toBe(path);
  });

  it('strips control characters from the path it stores', () => {
    const path = `/p/${'n'.repeat(120)}[2K.ts`;
    edit(path);
    expect(getMark(db, LEAD, `edited:${key(path)}`)).not.toContain('');
  });

  it('keys on the whole path, so a 300-character path is one file', () => {
    const path = `/${'nested/'.repeat(50)}deep.ts`;
    expect(path.length).toBeGreaterThan(300);
    edit(path);
    expect(getMark(db, LEAD, `edited:${key(path)}`)).not.toBeNull();
  });

  it('keys on the whole path: two files sharing a tail are two files', () => {
    // Keyed on a tail, these are one mark, and one file's edit is another's.
    const tail = `/${'nested/'.repeat(50)}deep.ts`;
    const one = `/one${tail}`;
    const two = `/two${tail}`;
    expect(one.slice(-200)).toBe(two.slice(-200));
    edit(one);
    expect(key(one)).not.toBe(key(two));
    expect(getMark(db, LEAD, `edited:${key(one)}`)).not.toBeNull();
    expect(getMark(db, LEAD, `edited:${key(two)}`)).toBeNull();
  });

  it('marks activity for the lead only, split inspection from mutation', () => {
    edit('/p/a.ts');
    fire('tool.after', toolInput('read', { paths: ['/p/b.ts'] }));
    expect(getMark(db, LEAD, 'activity:mutation')).not.toBeNull();
    expect(getMark(db, LEAD, 'activity:inspection')).not.toBeNull();
    edit('/p/c.ts', CHILD);
    expect(getMark(db, CHILD, 'activity:mutation')).toBeNull();
  });

  it('marks each actor’s edits under that actor', () => {
    const path = '/p/shared.ts';
    edit(path);
    edit(path, CHILD);
    expect(getMark(db, LEAD, `edited:${key(path)}`)).not.toBeNull();
    expect(getMark(db, CHILD, `edited:${key(path)}`)).not.toBeNull();
  });

  it('counts nothing: no edit tally survives a second edit of one file', () => {
    // The fourth-edit lookup is gone, and so is the counter that fed it.
    const path = '/p/checkout.test.ts';
    for (let i = 0; i < 4; i += 1) edit(path);
    expect(getMark(db, LEAD, `edits:${key(path)}`)).toBeNull();
  });

  it('writes nothing at all while the publish arm, the one it keeps books for, is off', () => {
    const off = kernelConfig({ publish: false });
    const path = '/p/d.ts';
    fire('tool.before', toolInput('edit', { paths: [path] }), LEAD, off);
    fire('tool.after', toolInput('read', { paths: ['/p/e.ts'] }), LEAD, off);
    expect(marksOf(LEAD)).toBe(0);
  });
});

describe('the context arm never asks', () => {
  it('marks a Read and looks nothing up about what the file imports', () => {
    fire('tool.after', toolInput('read', { paths: ['/p/one.ts'] }));
    expect(getMark(db, LEAD, 'activity:inspection')).not.toBeNull();
    expect(getMark(db, LEAD, 'package:zod')).toBeNull();
  });
});

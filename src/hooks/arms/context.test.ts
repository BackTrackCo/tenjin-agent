import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMark } from '../gates';
import type { LoopDb } from '../store';
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
 * The mechanical lane, which asks nothing. What is under test is the marks PR
 * D's arms read — per actor, so a subagent's edit is the subagent's — and the
 * absence of everything else: no plan, no question, no lookup.
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
  kind: 'edit' | 'shell' | 'read',
  input: Record<string, unknown>,
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
      tool: toolInput(kind, input),
    }),
  });
}

function fire(
  event: 'tool.before' | 'tool.after',
  kind: 'edit' | 'shell' | 'read',
  input: Record<string, unknown>,
  actor: Actor = LEAD,
  config: KernelConfig = ON,
): void {
  contextArm.before?.(ctxFor(event, kind, input, actor, config));
}

function edit(path: string, actor: Actor = LEAD): void {
  fire('tool.before', 'edit', { file_path: path }, actor);
}

describe('the context arm registration', () => {
  it('is one tool-wait arm on three (event, kind) pairs', () => {
    expect(contextArm.id).toBe('context');
    expect(contextArm.wait).toBe('tool');
    expect(contextArm.on).toEqual([
      { event: 'tool.before', kind: 'edit' },
      { event: 'tool.before', kind: 'shell' },
      { event: 'tool.after', kind: 'read' },
    ]);
  });

  it('has no plan, no delivery and no after: a fire on it is `no-question`', () => {
    expect(contextArm.plan).toBeUndefined();
    expect(contextArm.deliver).toBeUndefined();
    expect(contextArm.after).toBeUndefined();
  });
});

describe('the marks PR D reads', () => {
  it('stamps bashstart on a shell call', () => {
    fire('tool.before', 'shell', { command: 'pnpm vitest run x' });
    expect(getMark(db, LEAD, 'bashstart')).not.toBeNull();
    // A Bash call is not activity: only a read or an edit is.
    expect(getMark(db, LEAD, 'activity:mutation')).toBeNull();
  });

  it('marks every edited path whatever its extension, with the path as the value', () => {
    const path = '/p/drizzle.config.toml';
    edit(path);
    // The close rule asks whether the path is under the checkout and compares
    // its basename with the files the error named; the time is `marks.at`.
    expect(getMark(db, LEAD, `edited:${key(path)}`)).toBe(path);
  });

  it('strips control characters from the path it stores', () => {
    const path = `/p/${'n'.repeat(120)}\u001b[2K.ts`;
    edit(path);
    expect(getMark(db, LEAD, `edited:${key(path)}`)).not.toContain('\u001b');
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
    fire('tool.after', 'read', { file_path: '/p/b.ts' });
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

  it('writes nothing at all while both arms it keeps books for are off', () => {
    const off = kernelConfig({ failure: false, publish: false });
    const path = '/p/d.ts';
    fire('tool.before', 'edit', { file_path: path }, LEAD, off);
    fire('tool.before', 'shell', { command: 'ls' }, LEAD, off);
    expect(getMark(db, LEAD, `edited:${key(path)}`)).toBeNull();
    expect(getMark(db, LEAD, 'bashstart')).toBeNull();
  });
});

describe('the context arm never asks', () => {
  it('marks a Read and looks nothing up about what the file imports', () => {
    fire('tool.after', 'read', { file_path: '/p/one.ts' });
    expect(getMark(db, LEAD, 'activity:inspection')).not.toBeNull();
    expect(getMark(db, LEAD, 'package:zod')).toBeNull();
  });
});

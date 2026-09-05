import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMark } from '../gates';
import type { LoopDb } from '../store';
import type { Actor, KernelConfig, Plan, Reason } from '../types';
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
 * The mechanical lane. Two things are under test: the marks PR D's arms will
 * read (per actor, so a subagent's edit is the subagent's), and the two
 * questions this arm asks without ever speaking.
 */

const PUSH_ON = kernelConfig({ push: 'on' });

let dir: string;
let db: LoopDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tenjin-c-context-'));
  db = freshDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

function sourceFile(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function ctxFor(
  event: 'tool.before' | 'tool.after',
  kind: 'edit' | 'shell' | 'read',
  input: Record<string, unknown>,
  actor: Actor = LEAD,
  config: KernelConfig = PUSH_ON,
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

/**
 * One whole fire's worth of the arm: the marks, the question, and the end the
 * kernel reached. `reason` is that end, because the package mark is written in
 * `after` — and `fire.ts` does not call `after` at all on a deadline.
 */
function fire(
  event: 'tool.before' | 'tool.after',
  kind: 'edit' | 'shell' | 'read',
  input: Record<string, unknown>,
  actor: Actor = LEAD,
  config: KernelConfig = PUSH_ON,
  reason: Reason = 'no-hit',
): Plan | null {
  const ctx = ctxFor(event, kind, input, actor, config);
  contextArm.before?.(ctx);
  const plan = (contextArm.plan?.(ctx) ?? null) as Plan | null;
  if (reason !== 'deadline') contextArm.after?.(ctx, { reason });
  return plan;
}

function edit(path: string, actor: Actor = LEAD): Plan | null {
  return fire('tool.before', 'edit', { file_path: path }, actor);
}

function read(path: string, actor: Actor = LEAD, reason: Reason = 'no-hit'): Plan | null {
  return fire('tool.after', 'read', { file_path: path }, actor, PUSH_ON, reason);
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
});

describe('the marks PR D reads', () => {
  it('stamps bashstart on a shell call and asks nothing', () => {
    expect(fire('tool.before', 'shell', { command: 'pnpm vitest run x' })).toBeNull();
    expect(getMark(db, LEAD, 'bashstart')).not.toBeNull();
    // A Bash call is not activity: only a read or an edit is.
    expect(getMark(db, LEAD, 'activity:mutation')).toBeNull();
  });

  it('marks every edited path whatever its extension, and counts it', () => {
    const path = join(dir, 'drizzle.config.toml');
    edit(path);
    expect(getMark(db, LEAD, `edited:${path.slice(-200)}`)).not.toBeNull();
    expect(getMark(db, LEAD, `edits:${path}`)).toBe('1');
  });

  it('keys `edits:` and `edited:` on the same tail, so one long path is one file', () => {
    // A path longer than the tail: keyed whole, `edits:` and `edited:` would
    // name the same file two different ways.
    const path = `/${'nested/'.repeat(50)}deep.ts`;
    expect(path.length).toBeGreaterThan(300);
    edit(path);
    const tail = path.slice(-200);
    expect(getMark(db, LEAD, `edited:${tail}`)).not.toBeNull();
    expect(getMark(db, LEAD, `edits:${tail}`)).toBe('1');
  });

  it('marks activity for the lead only, split inspection from mutation', () => {
    edit(sourceFile('a.ts', 'const a = 1;\n'));
    read(sourceFile('b.ts', 'const b = 1;\n'));
    expect(getMark(db, LEAD, 'activity:mutation')).not.toBeNull();
    expect(getMark(db, LEAD, 'activity:inspection')).not.toBeNull();
    edit(sourceFile('c.ts', 'const c = 1;\n'), CHILD);
    expect(getMark(db, CHILD, 'activity:mutation')).toBeNull();
  });

  it('counts one agent’s edits separately from another’s: churn is per worker', () => {
    const path = sourceFile('shared.ts', 'const s = 1;\n');
    edit(path);
    edit(path);
    edit(path, CHILD);
    expect(getMark(db, LEAD, `edits:${path}`)).toBe('2');
    expect(getMark(db, CHILD, `edits:${path}`)).toBe('1');
  });

  it('writes nothing at all while push is off', () => {
    const off = kernelConfig({ push: 'off' });
    const path = sourceFile('d.ts', "import { z } from 'zod';\n");
    expect(fire('tool.before', 'edit', { file_path: path }, LEAD, off)).toBeNull();
    expect(fire('tool.before', 'shell', { command: 'ls' }, LEAD, off)).toBeNull();
    expect(getMark(db, LEAD, `edits:${path}`)).toBeNull();
    expect(getMark(db, LEAD, 'bashstart')).toBeNull();
  });
});

describe('the read question', () => {
  it('asks about the first package this actor has not asked about', () => {
    const path = sourceFile('one.ts', "import { z } from 'zod';\nimport pg from 'pg';\n");
    const plan = read(path);
    expect(plan?.question.text).toBe('zod gotcha bug workaround');
    expect(getMark(db, LEAD, 'package:zod')).not.toBeNull();
  });

  it('defers the second import to the next Read: one fire, one question', () => {
    const path = sourceFile('two.ts', "import { z } from 'zod';\nimport pg from 'pg';\n");
    expect(read(path)?.question.text).toBe('zod gotcha bug workaround');
    expect(read(path)?.question.text).toBe('pg gotcha bug workaround');
    // And then there is nothing left to ask about this file.
    expect(read(path)).toBeNull();
  });

  it('spends the package only on a fire that ended somewhere', () => {
    // The mark is this actor's one chance at that import. A fire that ran out
    // of clock asked nobody anything, so the next Read asks again; a fire that
    // came back empty asked, and that import is spent.
    const path = sourceFile('deadline.ts', "import { z } from 'zod';\n");
    expect(read(path, LEAD, 'deadline')?.question.text).toBe('zod gotcha bug workaround');
    expect(getMark(db, LEAD, 'package:zod')).toBeNull();
    expect(read(path, LEAD, 'no-hit')?.question.text).toBe('zod gotcha bug workaround');
    expect(getMark(db, LEAD, 'package:zod')).not.toBeNull();
    expect(read(path)).toBeNull();
  });

  it('dedupes per actor, not per session: a child asks its own questions', () => {
    const path = sourceFile('three.ts', "import { z } from 'zod';\n");
    expect(read(path)?.question.text).toBe('zod gotcha bug workaround');
    expect(read(path, CHILD)?.question.text).toBe('zod gotcha bug workaround');
  });

  it('reads source files only: a config file is marked, never asked about', () => {
    const path = sourceFile('pyproject.toml', "requires = ['zod']\n");
    expect(read(path)).toBeNull();
  });

  it('is silent for a file with no third-party imports', () => {
    expect(read(sourceFile('bare.ts', "import { join } from 'node:path';\n"))).toBeNull();
  });
});

describe('the churn question', () => {
  it('fires on exactly the fourth edit of one file by one agent', () => {
    const path = sourceFile('checkout.test.ts', 'const c = 1;\n');
    expect(edit(path)).toBeNull();
    expect(edit(path)).toBeNull();
    expect(edit(path)).toBeNull();
    expect(edit(path)?.question.text).toBe('checkout test');
    // Four is the trigger, not a cap that then stays spent: the fifth edit is
    // silent because it is not the fourth.
    expect(edit(path)).toBeNull();
  });

  it('a non-source file never churns, however often it is edited', () => {
    const path = join(dir, 'Dockerfile');
    for (let i = 0; i < 5; i += 1) expect(edit(path)).toBeNull();
    expect(getMark(db, LEAD, `edits:${path}`)).toBe('5');
  });
});

describe('the context arm never speaks', () => {
  it('delivers `log` with the resource id and no text', () => {
    const ctx = ctxFor('tool.after', 'read', { file_path: '/p/a.ts' });
    const delivery = contextArm.deliver?.(
      { shelf: 'team', strength: 'strong', resourceId: 'r-9', text: 'the whole finding' },
      ctx,
    );
    expect(delivery).toEqual({ mode: 'log', resourceId: 'r-9' });
  });
});

describe('what the context arm puts on the wire', () => {
  async function wireBody(plan: Plan): Promise<Record<string, unknown>> {
    let captured: Promise<Record<string, unknown>> | null = null;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      captured = new Request(String(input), init).json() as Promise<Record<string, unknown>>;
      return new Response(
        JSON.stringify({
          schemaVersion: 3,
          searchId: '11111111-1111-4111-8111-111111111111',
          calibration: 'hybrid-v1',
          items: [],
          matched: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const leg = plan.stages[0]?.[0];
    await leg?.request(plan.question, 1000, new AbortController().signal);
    if (captured === null) throw new Error('the leg made no request');
    return captured;
  }

  it('a read rides as trigger `read`, with no appliesTo filter', async () => {
    const path = sourceFile('four.ts', "import { z } from 'zod';\n");
    const plan = read(path);
    expect(plan).not.toBeNull();
    const body = await wireBody(plan as Plan);
    expect(body.trigger).toBe('read');
    expect(body.query).toBe('zod gotcha bug workaround');
    // 93 of 106 shelf posts have no card, so the filter matched nothing in 78
    // fires and the arm never produced a number. `filters` is omitted whole
    // when nothing narrows, so there is no empty `appliesTo` on the wire.
    expect(body.filters).toBeUndefined();
  });

  it('a churn rides as trigger `churn`', async () => {
    const path = sourceFile('cart.helper.ts', 'const c = 1;\n');
    let plan: Plan | null = null;
    for (let i = 0; i < 4; i += 1) plan = edit(path);
    expect(plan).not.toBeNull();
    const body = await wireBody(plan as Plan);
    expect(body.trigger).toBe('churn');
    expect(body.query).toBe('cart helper');
  });
});

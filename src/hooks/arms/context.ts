import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { mask } from '../../lib/redact';
import { getMark, setMark } from '../gates';
import { packagesInSource } from '../packages';
import { clean } from '../text';
import { lookupArm } from './lookup';
import type { Arm, FireContext } from '../types';

/**
 * The context arm: the mechanical lane (09-pr-c-lookup-arms.md).
 *
 * IT LOOKS THINGS UP AND NEVER SPEAKS. `deliver: 'log'` is the whole point — it
 * exists to earn a precision number against real work, and injecting in front
 * of every Read and every edit would be the loop shouting. What it DOES say
 * out loud, it says through the arms a person aimed: prompt, research, fetch.
 *
 * TWO QUESTIONS, ONE ARM, because they share every field but the trigger:
 *  - a Read of a source file asks about the first package this agent has not
 *    asked about yet — a dedupe, not a cap, so a file with three new imports is
 *    asked about one of them here and the others at the next Read, and the
 *    package is only counted as asked once the fire came back with something;
 *  - the FOURTH edit of one file by one agent asks about the file itself. Four
 *    is the trigger, not a ration: edits one to three are work, edit four is
 *    stuck (tenjin-agent#195).
 *
 * And it writes the marks the arms of PR D read: `bashstart` (the failure arm's
 * test-identity clock), `edited:` (its close rule) and `activity:` (the capture
 * ask's team gate). All under THIS actor, which is what the old code faked with
 * an `agentKey()` prefix: a subagent's edit is the subagent's.
 */

/** Only these are asked about. Everything else is edited and marked, never
 *  looked up: a `.toml` or a Dockerfile is a fix, not a topic. */
const SOURCE_RE = /\.(m?[jt]sx?|cjs|py)$/;

/** The fourth edit of one file by one agent is the stuck signal. */
const CHURN_EDITS = 4;

/** Enough of a file to hold its import block, and a bound on the read: this
 *  runs in front of the agent's next step. */
const HEAD_BYTES = 20_000;
const FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The key the `edited:` and `edits:` marks share. A path is operator text and a
 * mark key is not a place to keep it, so the key is a HASH OF THE WHOLE PATH —
 * sha256, hex, first 16 bytes, the shape `question.ts` keys a question on.
 *
 * OF THE WHOLE PATH, because a tail is not a file: two deep paths under
 * different roots share their last 200 characters often enough in a monorepo,
 * and one file's fourth edit would then be another file's.
 */
function pathKey(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 32);
}

const BASH_START = 'bashstart';
const EDITED_PREFIX = 'edited:';
const EDITS_PREFIX = 'edits:';
const PACKAGE_PREFIX = 'package:';
const ACTIVITY_PREFIX = 'activity:';

/** A basename's own bound once it is words. */
const CHURN_QUERY_CHARS = 300;

function filePathOf(ctx: FireContext): string {
  const value = ctx.input.tool?.input.file_path;
  return typeof value === 'string' && value.length <= 4096 ? value : '';
}

/** The head of a file, or '' for anything unreadable or implausibly large. */
function fileHead(path: string): string {
  try {
    if (statSync(path).size > FILE_MAX_BYTES) return '';
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString('utf8', 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** One statement, so two concurrent edit hooks cannot both read N and both
 *  write N+1 — which would step over the Nth edit this arm triggers on. */
function bump(ctx: FireContext, key: string): number {
  const { db, clock } = ctx.deps;
  const now = clock();
  const n = Number(getMark(db, ctx.actor, key) ?? '0') + 1;
  setMark(db, ctx.actor, key, String(n), now);
  return n;
}

/**
 * The read question's wording, in one place: `text` builds it from the package
 * and `after` reads the package back out of the question that was asked. The
 * package name IS the question, so the rest is the boilerplate that makes it
 * one.
 */
const PACKAGE_TAIL = ' gotcha bug workaround';

function packageQuestion(pkg: string): string {
  return pkg + PACKAGE_TAIL;
}

/** The package a built question asked about, or null for anything else. */
function packageAsked(text: string): string | null {
  return text.endsWith(PACKAGE_TAIL) ? text.slice(0, -PACKAGE_TAIL.length) : null;
}

/**
 * The first package in this file the actor has not asked about. READ-ONLY: the
 * mark is set in `after`, once the fire has actually spent the lookup, so a
 * deadline or an error does not burn this actor's one chance at the package.
 * Two concurrent Read fires cannot both spend a lookup on it either way — the
 * kernel's once-per-question claim is what stops that, not this mark.
 */
function unaskedPackage(ctx: FireContext, path: string): string | null {
  for (const pkg of packagesInSource(fileHead(path))) {
    if (getMark(ctx.deps.db, ctx.actor, PACKAGE_PREFIX + pkg) === null) return pkg;
  }
  return null;
}

/**
 * The file's own name as words. MASKED FIRST, before the separators go: a
 * `sk_live_...` in a basename stops looking like a token the moment its
 * underscores are spaces, and the spec's `[mask]` runs after this. The
 * extension is stripped after masking for the same reason.
 */
function churnQuery(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? '';
  const name = mask(base).replace(/\.[^.]+$/, '');
  return clean(name.replace(/[-_.]/g, ' ').replace(/\s+/g, ' '), CHURN_QUERY_CHARS);
}

export const contextArm: Arm = lookupArm({
  id: 'context',
  wait: 'tool',
  on: [
    { event: 'tool.before', kind: 'edit' },
    { event: 'tool.before', kind: 'shell' },
    { event: 'tool.after', kind: 'read' },
  ],
  trigger: (input) => (input.event === 'tool.after' ? 'read' : 'churn'),
  enabled: (cfg) => cfg.hooks.push === 'on',
  /**
   * The local writes, before anything is asked. EVERY edited path is marked
   * whatever its extension — the close rule asks "did a tracked file change
   * since this pairing opened", and a hook cannot ask git that in front of a
   * tool call — while the lookups below still only care about source files.
   */
  before(ctx) {
    const { db, clock } = ctx.deps;
    const kind = ctx.input.tool?.kind;
    if (kind === 'shell') {
      // One stamp per Bash call, per agent, so parallel subagents cannot
      // clobber each other's. PR D's failure arm reads it back to decide
      // whether a test report could be about THIS command.
      setMark(db, ctx.actor, BASH_START, String(clock()), clock());
      return;
    }
    const path = filePathOf(ctx);
    if (kind === 'edit' && path.length > 0) {
      // Upserted, so a re-edit moves the timestamp and nothing else: the close
      // rule reads these back by time.
      const key = pathKey(path);
      setMark(db, ctx.actor, EDITED_PREFIX + key, String(clock()), clock());
      bump(ctx, EDITS_PREFIX + key);
    }
    // Content-free, and the LEAD's only: one mark for inspection and one for
    // mutation, never the path, the tool input or a growing counter. Subagent
    // work is captured at its own boundary and must not make the parent
    // eligible here.
    if (ctx.actor.agent === '') {
      const activity = ctx.input.event === 'tool.after' ? 'inspection' : 'mutation';
      setMark(db, ctx.actor, ACTIVITY_PREFIX + activity, String(clock()), clock());
    }
  },
  text(input, ctx) {
    const path = filePathOf(ctx);
    if (path.length === 0 || !SOURCE_RE.test(path)) return null;
    if (input.event === 'tool.after') {
      const pkg = unaskedPackage(ctx, path);
      // No `appliesTo` filter rides with it — 93 of 106 shelf posts have no
      // card, so the filter matched nothing in 78 fires.
      return pkg === null ? null : packageQuestion(pkg);
    }
    if (input.tool?.kind !== 'edit') return null;
    // Read back, not bumped: `before` already counted this edit.
    const n = Number(getMark(ctx.deps.db, ctx.actor, EDITS_PREFIX + pathKey(path)) ?? '0');
    if (n !== CHURN_EDITS) return null;
    const query = churnQuery(path);
    return query.length === 0 ? null : query;
  },
  shape: [mask],
  shelves: ['team', 'public'],
  deliver: 'log',
  /**
   * The package mark, written only once the fire reached a definite end. It is
   * this actor's one chance at that import, and a fire that timed out, errored
   * or never asked has not spent it — `after` does not run at all on a
   * deadline or on a fire the harness abandoned, and the three reasons below
   * are the ones that mean the question was actually settled.
   *
   * THE MARK IS THE PACKAGE THIS FIRE ASKED ABOUT, read back off `question`
   * and never re-derived from the file. Two Reads by one actor run in
   * parallel: asking the file again here would hand the second fire the NEXT
   * unasked import, marking one that was never asked and leaving the one that
   * was to be asked all over again.
   */
  after(ctx, result, question) {
    if (ctx.input.event !== 'tool.after' || question === null) return null;
    if (result.reason !== 'hit' && result.reason !== 'no-hit' && result.reason !== 'cached') {
      return null;
    }
    const pkg = packageAsked(question.text);
    if (pkg !== null && pkg.length > 0) {
      const { db, clock } = ctx.deps;
      setMark(db, ctx.actor, PACKAGE_PREFIX + pkg, String(clock()), clock());
    }
    return null;
  },
});

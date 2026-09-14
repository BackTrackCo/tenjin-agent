import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPushGrade } from './commands/push';
import { openStore, STORE_SQL } from './lib/state-store';
import type { CommandContext } from './context';

const NOW = Date.UTC(2026, 0, 20, 12);
const RESOURCE = '019b1111-2222-7333-8444-555555555555';

function transcript(read: boolean) {
  return [
    JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_additional_context',
        content: [`Tenjin found the fixture note. Read it: tenjin read ${RESOURCE}.`],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: read ? `tenjin read ${RESOURCE}` : 'ls src' },
          },
        ],
      },
    }),
  ].join('\n');
}

describe('injection grading reads the intended worker', () => {
  it.each([false, true])(
    'uses child evidence when child read is %s and parent is opposite',
    async (childRead) => {
      const dir = await mkdtemp(join(tmpdir(), 'bench3-grade-'));
      try {
        const store = await openStore(dir);
        if (!store) throw new Error('SQLite unavailable');
        try {
          // Missing attribution is a task defect, explicitly asserted before a
          // query requiring the new column; never confuse it with SQL setup failure.
          const columns = store
            .all('PRAGMA table_info(injections)', [])
            .map((column) => column.name);
          expect(columns, 'injections must retain their intended actor').toContain('agent_id');
          store.run(STORE_SQL.touchSession, [
            'conversation',
            null,
            '/synthetic',
            NOW - 20_000,
            'fixture',
          ]);
          store.run(STORE_SQL.endSession, ['conversation', NOW - 1000, NOW - 1000, 'fixture']);
          store.run(
            'INSERT INTO injections (uid, at, session, machine, hook, shelf, resource_id, title, action, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              'injection-child',
              NOW - 5000,
              'conversation',
              'fixture',
              'prompt',
              'public',
              RESOURCE,
              'Fixture note',
              'injected',
              'child-worker',
            ],
          );
        } finally {
          store.close();
        }
        const sink = { write: () => true } as unknown as NodeJS.WritableStream;
        const ctx: CommandContext = {
          flags: { json: true, timeout: 1000 },
          dataDir: dir,
          io: { stdout: sink, stderr: sink, isTTY: false },
        };
        const located: Array<string | null> = [];
        const result = await runPushGrade(
          ctx,
          {},
          {
            homeDir: '/synthetic-home',
            now: () => NOW,
            fetchImpl: async () => {
              throw new Error('oracle must not post');
            },
            findTranscript: async (_home, _session, actor = null) => {
              located.push(actor);
              return { kind: 'found', path: actor ?? 'parent' };
            },
            transcriptText: async (path) =>
              transcript(path === 'child-worker' ? childRead : !childRead),
            transcriptIdle: async () => false,
          },
        );
        expect(located).toEqual(['child-worker']);
        expect(result.data).toMatchObject({
          graded: { used: childRead ? 1 : 0, rejected: childRead ? 0 : 1 },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

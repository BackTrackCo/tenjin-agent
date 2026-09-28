import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runRouterStatus } from '../status';
import type { CommandContext } from '../../context';
it('reports durable signed and reserved exposure separately after the window rolls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevgrep-status-'));
  try {
    await writeFile(
      join(dir, 'spend.json'),
      JSON.stringify({
        schemaVersion: 2,
        windowStartMs: 0,
        committedAtomic: '0',
        automaticCommittedAtomic: '0',
        reservations: [],
        durable: [
          {
            id: 's',
            requestKey: 's',
            runId: 'r',
            runMaxAtomic: '50000',
            amountAtomic: '1000',
            atMs: 0,
            state: 'signed',
          },
          {
            id: 'r',
            requestKey: 'r',
            runId: 'r',
            runMaxAtomic: '50000',
            amountAtomic: '1000',
            atMs: 0,
            state: 'reserved',
          },
        ],
      }),
    );
    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    const ctx: CommandContext = {
      dataDir: dir,
      flags: { json: true, timeout: 5000 },
      io: { stdout: sink, stderr: sink, isTTY: false },
    };
    expect((await runRouterStatus(ctx)).data).toMatchObject({
      window: { automaticExposure: { atomic: '2000' } },
      localRetrieval: {
        reserved: { atomic: '1000' },
        unknownSignedExposure: { atomic: '1000' },
        reconciliationRequired: true,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

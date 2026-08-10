import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeInstallReceipt } from '../lib/install-receipt';
import { runNoticeAcknowledge } from './notice';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-notice-command-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    dataDir: dir,
    flags: { json: true, timeout: 1000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

async function pending() {
  return writeInstallReceipt(dir, {
    harnesses: ['hermes'],
    execution: {
      surface: 'machine',
      harnessApprovalMode: 'unknown',
      humanPresenceProven: false,
      sameUserUnrestrictedAgentContained: false,
    },
    policy: { publishMode: { value: 'auto', source: 'profile:hermes' } },
    changedPaths: [],
    warnings: [],
    undoCommands: [],
  });
}

describe('notice acknowledge', () => {
  it('dismisses reminders while explicitly refusing a human-proof claim', async () => {
    const stored = await pending();
    const result = await runNoticeAcknowledge(stored.receipt.id, ctx());
    expect(result.data).toMatchObject({
      notice: { status: 'acknowledged', acknowledgementProven: false },
      receipt: { notice: { status: 'acknowledged', acknowledgementProven: false } },
    });
    expect(result.humanLines?.join('\n')).toMatch(/does not prove a human/i);
  });

  it('refuses to acknowledge a stale or invented id', async () => {
    await pending();
    const err = (await runNoticeAcknowledge('00000000-0000-4000-8000-000000000000', ctx()).catch(
      (cause) => cause,
    )) as CliError;
    expect(err.code).toBe('USAGE');
    expect(err.fix).toContain('tenjin notice acknowledge');
  });
});

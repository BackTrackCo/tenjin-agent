import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectHooksFile } from './hooks-file';

let dir: string;
let settingsPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-file-'));
  settingsPath = join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('inspectHooksFile', () => {
  it('refuses an event whose entries are not a list, and names it', async () => {
    // Copied through, this event would silently swallow its share of a write
    // while the receipt still counted it.
    await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: 'oops' } }));
    const found = await inspectHooksFile(settingsPath);
    expect(found).toMatchObject({ refusal: { reason: 'unexpected-shape' } });
    expect('refusal' in found && found.refusal.message).toContain('hooks.PreToolUse');
  });
});

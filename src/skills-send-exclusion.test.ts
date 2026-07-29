import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The skills-side twin of the MCP-toolset pin in mcp/server.test.ts: `tenjin
 * send` is a human-invoked escape hatch and no model-facing skill may teach it.
 * The vendored skills/tenjin/SKILL.md is synced byte-for-byte from
 * tenjin.blog/skills.md by CI (skill-drift.yml), which checks drift but not
 * content, so a remote edit mentioning send would otherwise land here silently.
 */
describe('skill adapters never teach the send verb', () => {
  it('no SKILL.md mentions tenjin send (or tenjin_send / tenjin-send)', async () => {
    const skillsDir = fileURLToPath(new URL('../skills', import.meta.url));
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const name of skillDirs) {
      const body = await readFile(join(skillsDir, name, 'SKILL.md'), 'utf8');
      // \s+ catches "tenjin send" wrapped across lines; _ and - catch the
      // tool-name and branch-name spellings (tenjin_send, tenjin-send).
      expect(body, `skills/${name}/SKILL.md must not mention the send verb`).not.toMatch(
        /\btenjin[\s_-]+send\b/i,
      );
    }
  });
});

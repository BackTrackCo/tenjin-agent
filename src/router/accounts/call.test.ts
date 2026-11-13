import { describe, expect, it } from 'vitest';
import { readNamedResult, readResult } from './call';

/**
 * A NAMED TOOL'S ANSWER, READ WHOLE. MCP content can be text, media, an
 * embedded resource or a link to one; a tool that answers with a resource or
 * a link and no structured result must come back with them, never as an
 * empty fulfilled result.
 */
describe("a named tool's content", () => {
  it('keeps an embedded resource and a resource link', () => {
    // A1igator review: only text, image and audio were kept, so this answer
    // came back as an empty fulfilled result.
    const read = readNamedResult({
      content: [
        {
          type: 'resource',
          resource: { uri: 'file:///report.md', mimeType: 'text/markdown', text: '# Report' },
        },
        { type: 'resource_link', uri: 'https://files.example.test/a.csv', name: 'a.csv' },
        {
          type: 'resource',
          resource: { uri: 'file:///chart.png', mimeType: 'image/png', blob: 'iVBORw0K' },
        },
      ],
    });
    expect(read).toMatchObject({
      text: '# Report\na.csv: https://files.example.test/a.csv',
      value: '# Report\na.csv: https://files.example.test/a.csv',
      media: [{ contentType: 'image/png' }],
    });
    // A map's content answer reads them the same way.
    expect(
      readResult({ content: [{ type: 'resource_link', uri: 'https://x.test/r' }] }, 'content'),
    ).toMatchObject({ text: 'https://x.test/r' });
  });
});

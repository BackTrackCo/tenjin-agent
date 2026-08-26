import { describe, it, expect } from 'vitest';
import { materializeSkillMarkdown, materializeTransform } from './skill-materialize';
import { CliError } from './errors';

const SOURCE = [
  '# Skill',
  'always here',
  '<!-- tenjin:when bazaarPay -->',
  'only when on',
  '<!-- /tenjin:when -->',
  'tail',
].join('\n');

describe('materializeSkillMarkdown', () => {
  it('keeps the block content and drops the marker lines when the flag is on', () => {
    expect(materializeSkillMarkdown(SOURCE, { bazaarPay: true })).toBe(
      ['# Skill', 'always here', 'only when on', 'tail'].join('\n'),
    );
  });

  it('drops the whole block when the flag is off', () => {
    expect(materializeSkillMarkdown(SOURCE, { bazaarPay: false })).toBe(
      ['# Skill', 'always here', 'tail'].join('\n'),
    );
  });

  it('treats an unknown flag as off', () => {
    expect(materializeSkillMarkdown(SOURCE, {})).toBe(
      ['# Skill', 'always here', 'tail'].join('\n'),
    );
  });

  it('is the identity on marker-free text', () => {
    const plain = '# Skill\nno markers here\n';
    expect(materializeSkillMarkdown(plain, { bazaarPay: true })).toBe(plain);
  });

  it('tolerates whitespace and CRLF around markers', () => {
    const crlf = '  <!-- tenjin:when x -->\r\ninner\r\n <!-- /tenjin:when --> \r\ntail';
    expect(materializeSkillMarkdown(crlf, { x: true })).toBe('inner\r\ntail');
  });

  it('handles two independent blocks with different flags', () => {
    const two = [
      '<!-- tenjin:when a -->',
      'A',
      '<!-- /tenjin:when -->',
      '<!-- tenjin:when b -->',
      'B',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(materializeSkillMarkdown(two, { a: true, b: false })).toBe('A');
  });

  // Each guard asserts its OWN message, not just CliError: nesting removed still
  // throws, as `unopened` two lines later, so a bare toThrow(CliError) here passed
  // with the nesting check deleted and pinned nothing.
  it('fails closed on an unclosed block', () => {
    expect(() => materializeSkillMarkdown('<!-- tenjin:when a -->\nx', {})).toThrow(
      /unclosed tenjin:when "a"/,
    );
  });

  it('fails closed on an unopened close', () => {
    expect(() => materializeSkillMarkdown('x\n<!-- /tenjin:when -->', {})).toThrow(
      /unopened \/tenjin:when at line 2/,
    );
  });

  it('fails closed on nesting', () => {
    const nested = [
      '<!-- tenjin:when a -->',
      '<!-- tenjin:when b -->',
      '<!-- /tenjin:when -->',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(() => materializeSkillMarkdown(nested, { a: true, b: true })).toThrow(
      /nested tenjin:when at line 2 \(already inside "a"\)/,
    );
  });

  it('throws CliError, not a bare Error, on every malformed shape', () => {
    expect(() => materializeSkillMarkdown('<!-- tenjin:when a -->\nx', {})).toThrow(CliError);
  });

  // Both name the line the author actually mistyped. Before, trailing content fell
  // through as ordinary text and the parse blamed whichever marker was left
  // unbalanced, which is never the line that needs editing.
  it('blames the open marker itself when it carries trailing content', () => {
    const text = ['<!-- tenjin:when a --> oops', 'x', '<!-- /tenjin:when -->'].join('\n');
    expect(() => materializeSkillMarkdown(text, { a: true })).toThrow(
      /malformed tenjin:when marker at line 1/,
    );
  });

  it('blames the close marker itself when it carries a flag name', () => {
    const text = ['<!-- tenjin:when a -->', 'x', '<!-- /tenjin:when a -->'].join('\n');
    expect(() => materializeSkillMarkdown(text, { a: true })).toThrow(
      /malformed tenjin:when marker at line 3/,
    );
  });
});

describe('materializeTransform', () => {
  it('shapes .md files and passes every other file through byte-for-byte', () => {
    const transform = materializeTransform({});
    const md = Buffer.from(SOURCE, 'utf8');
    const bin = Buffer.from([0xff, 0x00, 0x81]);
    expect(transform('SKILL.md', md).toString('utf8')).not.toContain('only when on');
    expect(transform('logo.png', bin)).toBe(bin);
  });
});

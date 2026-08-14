import { describe, it, expect } from 'vitest';
import {
  markerFlagsIn,
  matchesSomeVariant,
  materializeSkillMarkdown,
  materializeTransform,
} from './skill-materialize';
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

  it('fails closed on an unclosed block', () => {
    expect(() => materializeSkillMarkdown('<!-- tenjin:when a -->\nx', {})).toThrow(CliError);
  });

  it('fails closed on an unopened close', () => {
    expect(() => materializeSkillMarkdown('x\n<!-- /tenjin:when -->', {})).toThrow(CliError);
  });

  it('fails closed on nesting', () => {
    const nested = [
      '<!-- tenjin:when a -->',
      '<!-- tenjin:when b -->',
      '<!-- /tenjin:when -->',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(() => materializeSkillMarkdown(nested, { a: true, b: true })).toThrow(CliError);
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

describe('markerFlagsIn', () => {
  it('lists each referenced flag once, in order', () => {
    const text = [
      '<!-- tenjin:when b -->',
      '<!-- /tenjin:when -->',
      '<!-- tenjin:when a -->',
      '<!-- /tenjin:when -->',
      '<!-- tenjin:when b -->',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(markerFlagsIn(text)).toEqual(['b', 'a']);
    expect(markerFlagsIn('plain')).toEqual([]);
  });
});

describe('matchesSomeVariant', () => {
  it('recognizes both materializations of a one-flag source', () => {
    const on = Buffer.from(materializeSkillMarkdown(SOURCE, { bazaarPay: true }), 'utf8');
    const off = Buffer.from(materializeSkillMarkdown(SOURCE, { bazaarPay: false }), 'utf8');
    expect(matchesSomeVariant(SOURCE, on)).toBe(true);
    expect(matchesSomeVariant(SOURCE, off)).toBe(true);
  });

  it('rejects edited bytes', () => {
    expect(matchesSomeVariant(SOURCE, Buffer.from('someone else wrote this', 'utf8'))).toBe(false);
  });

  it('reads false past the flag cap and on malformed markers', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      [`<!-- tenjin:when f${i} -->`, 'x', '<!-- /tenjin:when -->'].join('\n'),
    ).join('\n');
    expect(matchesSomeVariant(many, Buffer.from('x', 'utf8'))).toBe(false);
    expect(matchesSomeVariant('<!-- tenjin:when a -->', Buffer.from('', 'utf8'))).toBe(false);
  });
});

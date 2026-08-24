import { describe, it, expect } from 'vitest';
import {
  SKILL_CONTENT_FLAG_NAMES,
  markerFlagsIn,
  materializeSkillMarkdown,
  materializeTransform,
  renderSkillMarkdown,
  skillContentFlags,
  skillMaterialize,
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

/**
 * The `else` arm, which is what makes this a REPLACEMENT seam. The property worth
 * pinning is not "else works" but that the two arms are MUTUALLY EXCLUSIVE by
 * construction: no flag value can leak both, and none can drop both. That is the
 * guarantee the skills lean on when a team-mode render replaces a public rule
 * rather than appending a rider to it.
 */
const PAIR = [
  'head',
  '<!-- tenjin:when teamMode -->',
  'team arm',
  '<!-- tenjin:else -->',
  'public arm',
  '<!-- /tenjin:when -->',
  'tail',
].join('\n');

describe('materializeSkillMarkdown: the else arm', () => {
  it('keeps the first arm and drops the second when the flag is on', () => {
    expect(materializeSkillMarkdown(PAIR, { teamMode: true })).toBe(
      ['head', 'team arm', 'tail'].join('\n'),
    );
  });

  it('keeps the second arm and drops the first when the flag is off', () => {
    expect(materializeSkillMarkdown(PAIR, { teamMode: false })).toBe(
      ['head', 'public arm', 'tail'].join('\n'),
    );
  });

  it('renders exactly one arm for every flag value, never both and never neither', () => {
    for (const flags of [{ teamMode: true }, { teamMode: false }, {}]) {
      const out = materializeSkillMarkdown(PAIR, flags);
      expect(
        [out.includes('team arm'), out.includes('public arm')].filter(Boolean),
        `both or neither arm rendered for ${JSON.stringify(flags)}`,
      ).toHaveLength(1);
    }
  });

  it('an empty arm is legal, so a pair can delete a region rather than swap it', () => {
    const deleting = [
      '<!-- tenjin:when teamMode -->',
      '<!-- tenjin:else -->',
      'public only',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(materializeSkillMarkdown(deleting, { teamMode: true })).toBe('');
    expect(materializeSkillMarkdown(deleting, { teamMode: false })).toBe('public only');
  });

  it('resolves two pairs on the same flag consistently, not by position', () => {
    const two = [PAIR, PAIR].join('\n');
    const team = materializeSkillMarkdown(two, { teamMode: true });
    expect(team).not.toContain('public arm');
    expect(team.match(/team arm/g)).toHaveLength(2);
  });

  it('fails closed on an else outside any block', () => {
    expect(() => materializeSkillMarkdown('x\n<!-- tenjin:else -->', {})).toThrow(
      /unopened tenjin:else at line 2/,
    );
  });

  // Without this the third arm's fate turns on parity of the else count, which is
  // never what the author meant: one of the two was supposed to be the close.
  it('fails closed on a second else in one block', () => {
    const twice = [
      '<!-- tenjin:when a -->',
      'one',
      '<!-- tenjin:else -->',
      'two',
      '<!-- tenjin:else -->',
      'three',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(() => materializeSkillMarkdown(twice, { a: true })).toThrow(
      /second tenjin:else at line 5 in "a"/,
    );
  });

  it('blames the else marker itself when it carries a flag name', () => {
    const text = [
      '<!-- tenjin:when a -->',
      'x',
      '<!-- tenjin:else a -->',
      'y',
      '<!-- /tenjin:when -->',
    ].join('\n');
    expect(() => materializeSkillMarkdown(text, { a: true })).toThrow(
      /malformed tenjin:when marker at line 3/,
    );
  });

  it('an else does not reopen a closed block', () => {
    const after = [
      '<!-- tenjin:when a -->',
      'x',
      '<!-- /tenjin:when -->',
      '<!-- tenjin:else -->',
    ].join('\n');
    expect(() => materializeSkillMarkdown(after, { a: true })).toThrow(
      /unopened tenjin:else at line 4/,
    );
  });
});

/**
 * The one mapping from machine facts to flags. Its value is that no call site
 * builds a record inline: an omitted flag resolves OFF, which for a when/else pair
 * is a silently rendered mode rather than an error anybody would notice.
 */
describe('skillContentFlags and its wrappers', () => {
  it('maps teamMode straight through, both ways', () => {
    expect(skillContentFlags({ teamMode: true })).toEqual({ teamMode: true });
    expect(skillContentFlags({ teamMode: false })).toEqual({ teamMode: false });
  });

  it('names every flag in SKILL_CONTENT_FLAG_NAMES, so the pin has a closed set', () => {
    expect(Object.keys(skillContentFlags({ teamMode: false })).sort()).toEqual(
      [...SKILL_CONTENT_FLAG_NAMES].sort(),
    );
  });

  it('renderSkillMarkdown and skillMaterialize agree on the same facts', () => {
    for (const teamMode of [true, false]) {
      const rendered = renderSkillMarkdown(PAIR, { teamMode });
      const written = skillMaterialize({ teamMode })('SKILL.md', Buffer.from(PAIR, 'utf8'));
      expect(written.toString('utf8')).toBe(rendered);
    }
  });
});

describe('markerFlagsIn', () => {
  it("reports the open markers' flags in source order, and nothing for a clean file", () => {
    expect(markerFlagsIn(PAIR)).toEqual(['teamMode']);
    expect(
      markerFlagsIn(['<!-- tenjin:when b -->', '<!-- /tenjin:when -->', PAIR].join('\n')),
    ).toEqual(['b', 'teamMode']);
    expect(markerFlagsIn('# Skill\nnothing here\n')).toEqual([]);
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

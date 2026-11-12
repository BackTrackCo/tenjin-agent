import { describe, expect, it } from 'vitest';
import { protectedJobsOf, taskPart } from './agent-job';

describe('the task part of a brief', () => {
  it('drops a Markdown rules section up to the next heading', () => {
    const brief = [
      'Summarise the cache module.',
      '## Hard rules',
      '- Keep wallet material out of it.',
      'Anything here is a rule too.',
      '## Report',
      'Under 200 words.',
    ].join('\n');
    expect(taskPart(brief)).toBe('Summarise the cache module.\n## Report\nUnder 200 words.');
  });

  it('drops a bold or plain rules title, a plain one only up to its blank line', () => {
    const brief = [
      '**Working rules**',
      'Ask before any payment.',
      '',
      'Still rules after a blank line under a bold title.',
      'Rules:',
      '- credentials stay local',
      '',
      'Read the router and list its entry points.',
    ].join('\n');
    expect(taskPart(brief)).toBe('\nRead the router and list its entry points.');
  });

  it.each([
    'Never push to main.',
    '- Do not open the .env file.',
    "* Don't print any key.",
    '1. You must not read the wallet.',
    'Agents never merge.',
    'No commits, no pushes.',
    'Rules unchanged: no Jev call, no key read.',
  ])('drops the prohibition line %j', (line) => {
    expect(taskPart(`Fix the parser.\n${line}`)).toBe('Fix the parser.');
  });

  it('keeps task lines that only resemble a prohibition', () => {
    const brief = 'Now list the wallet helpers.\nNote which ones sign.\nNotify me of the result.';
    expect(taskPart(brief)).toBe(brief);
  });
});

describe('the protected jobs a task does', () => {
  it.each([
    ['review', undefined, 'Use review-tenjin on PR 553.'],
    ['review', undefined, 'Re-review the diff after the last push.'],
    ['review', 'code-reviewer', 'Look at the change.'],
    ['security', undefined, 'Run a security review of the hook.'],
    ['design', undefined, 'Run plan-tenjin for the fund page.'],
    ['design', 'Plan', 'Work out the steps.'],
    ['migration', undefined, 'Generate the drizzle migration that adds the column.'],
  ] as const)('%s', (job, type, task) => {
    expect(protectedJobsOf(type, task)).toEqual([job]);
  });

  it.each([
    'Address the review feedback on PR 553.',
    'Implement the change the plan specifies.',
    'Read the migrations folder and summarise it.',
    'Search for every caller of the signer.',
  ])('none for mechanical work: %j', (task) => {
    expect(protectedJobsOf('general-purpose', task)).toEqual([]);
  });
});

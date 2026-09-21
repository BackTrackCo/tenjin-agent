import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/cdp-gtm-resources.json';
import { auditResources } from './catalog';
import { buildRequest, compileResource, validateArguments } from './contracts';

function contract(suffix: string) {
  const source = fixtures.resources.find((resource) => resource.resource.endsWith(suffix));
  expect(source).toBeDefined();
  const result = compileResource(source);
  if (result.status !== 'supported') throw new Error(result.reasons.join('; '));
  return result.contract;
}

describe('raw CDP GTM catalog records', () => {
  it('compiles four unchanged listings without claiming provider execution', () => {
    const report = auditResources(fixtures.resources);
    expect(report).toMatchObject({ total: 4, contractValidated: 4, unsupported: 0 });
    for (const row of report.rows) {
      expect(row).toMatchObject({
        fixtureExecuted: false,
        quoteChecked: false,
        livePaidVerified: false,
      });
    }
  });

  it('requires the Hunter lookup input and never fills it from listing examples', () => {
    const company = contract('/hunter/company-enrichment');
    const email = contract('/hunter/email-verifier');
    expect(validateArguments(company, { body: {} }).valid).toBe(false);
    expect(validateArguments(email, { body: {} }).valid).toBe(false);
    expect(buildRequest(company, { body: { domain: 'stripe.com' } })).toMatchObject({
      url: 'https://hunter.x402.paywithlocus.com/hunter/company-enrichment',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"domain":"stripe.com"}',
    });
    expect(buildRequest(email, { body: { email: 'sales@example.com' } }).body).toBe(
      '{"email":"sales@example.com"}',
    );
  });

  it('preserves Apollo alternative identity constraints and CompanyEnrich enums', () => {
    const person = contract('/apollo/people-enrichment');
    expect(validateArguments(person, { body: {} }).valid).toBe(false);
    expect(validateArguments(person, { body: { first_name: 'Tim' } }).valid).toBe(false);
    expect(
      buildRequest(person, {
        body: { first_name: 'Tim', last_name: 'Cook', domain: 'apple.com' },
      }).body,
    ).toBe('{"first_name":"Tim","last_name":"Cook","domain":"apple.com"}');
    expect(validateArguments(person, { body: { email: 'sales@example.com' } }).valid).toBe(true);
    const company = contract('/companyenrich/properties-enrich');
    expect(buildRequest(company, { body: { name: 'Stripe' } }).body).toBe('{"name":"Stripe"}');
    expect(validateArguments(company, { body: { name: 'Stripe', expand: 'all' } }).valid).toBe(
      false,
    );
  });
});

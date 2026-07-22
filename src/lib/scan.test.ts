import { describe, it, expect } from 'vitest';
import { scan, type ScanFinding } from './scan';

function checks(text: string): string[] {
  return scan(text).map((f) => f.check);
}
function find(text: string, check: string): ScanFinding | undefined {
  return scan(text).find((f) => f.check === check);
}

// A representative secret for each block detector, plus a benign near-miss the
// detector must NOT fire on.
const HEX64 = 'a'.repeat(64);
const HEX40 = 'b'.repeat(40);

describe('scan — block detectors', () => {
  it('flags a PEM private-key block and echoes only the header marker', async () => {
    const text = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const f = find(text, 'pem-private-key');
    expect(f?.severity).toBe('block');
    expect(f?.line).toBe(1);
    expect(f?.excerpt).toBe('-----BEGIN RSA PRIVATE KEY-----');
    expect(f?.excerpt).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('flags a 0x-prefixed 64-hex raw key, not a 40-hex address', async () => {
    expect(checks(`key = 0x${HEX64}`)).toContain('raw-private-key');
    expect(checks(`key = 0x${HEX64}`)).not.toContain('wallet-address');
  });

  it('flags an AWS access key id', async () => {
    expect(checks('aws = AKIAIOSFODNN7EXAMPLE')).toContain('aws-access-key');
  });

  it('flags a JWT', async () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOiJhYmMxMjM0.SflKxwRJSMeKKF2QT4';
    expect(checks(jwt)).toContain('jwt');
  });

  it('flags GitHub, Slack, and Stripe token prefixes', async () => {
    expect(checks(`t=ghp_${'A'.repeat(36)}`)).toContain('github-token');
    expect(checks('t=xoxb-123456789012-abcdefghij')).toContain('slack-token');
    expect(checks(`t=sk_live_${'A'.repeat(24)}`)).toContain('stripe-token');
  });

  it('flags OpenAI, Anthropic, Google, and npm keys', async () => {
    expect(checks(`key=sk-${'a'.repeat(48)}`)).toContain('openai-key');
    expect(checks(`key=sk-proj-${'B'.repeat(40)}`)).toContain('openai-key');
    expect(checks(`key=sk-ant-api03-${'C'.repeat(30)}`)).toContain('anthropic-key');
    expect(checks(`key=sk-ant-api03-${'C'.repeat(30)}`)).not.toContain('openai-key');
    expect(checks(`key=AIza${'d'.repeat(35)}`)).toContain('google-key');
    expect(checks(`secret=GOCSPX-${'e'.repeat(28)}`)).toContain('google-key');
    expect(checks(`token=npm_${'f'.repeat(36)}`)).toContain('npm-token');
  });

  it('flags a DB connection URI with an embedded password, masking the password', async () => {
    const f = find('postgres://admin:s3cr3tpass@db.example.com:5432/app', 'db-connection-uri');
    expect(f?.severity).toBe('block');
    expect(f?.excerpt).toContain('postgres://admin:[redacted]@db.example.com');
    expect(f?.excerpt).not.toContain('s3cr3tpass');
  });

  it('flags Authorization: Bearer with a live token, but not a placeholder', async () => {
    const f = find('Authorization: Bearer abc123def456ghi789', 'bearer-token');
    expect(f?.severity).toBe('block');
    expect(f?.excerpt).not.toContain('abc123def456ghi789');
    expect(checks('Authorization: Bearer <token>')).not.toContain('bearer-token');
  });

  it('does not flag benign near-misses', async () => {
    expect(checks('the total was 0x1234 wei')).not.toContain('raw-private-key'); // short hex
    expect(checks('AKIALOOKSLIKE but lowercase tail')).not.toContain('aws-access-key');
    expect(checks('a normal sentence with no keys')).toEqual([]);
    expect(checks('COUNT=42')).not.toContain('secret-assignment'); // not secret-named
  });
});

describe('scan — 0x-64-hex is a key or a hash by context', () => {
  it('demotes a tx hash inside a basescan URL to a warn, not a block', async () => {
    const url = `https://basescan.org/tx/0x${HEX64}`;
    const found = scan(url);
    expect(found.map((f) => f.check)).toContain('hex32-value');
    expect(found.map((f) => f.check)).not.toContain('raw-private-key');
    const f = found.find((x) => x.check === 'hex32-value');
    expect(f?.severity).toBe('warn');
    expect(f?.excerpt).not.toContain(HEX64);
  });

  it('demotes a labelled hash (txHash:, hash =) to a warn', async () => {
    expect(checks(`txHash: 0x${HEX64}`)).toContain('hex32-value');
    expect(checks(`txHash: 0x${HEX64}`)).not.toContain('raw-private-key');
    expect(checks(`blockhash = 0x${HEX64}`)).toContain('hex32-value');
  });

  it('blocks a bare, uncontextualized 64-hex as a raw private key', async () => {
    const found = scan(`0x${HEX64}`);
    const f = found.find((x) => x.check === 'raw-private-key');
    expect(f?.severity).toBe('block');
    expect(f?.excerpt).not.toContain(HEX64);
    expect(found.map((x) => x.check)).not.toContain('hex32-value');
  });

  it('still blocks a 64-hex assigned to a secret-named key', async () => {
    const found = scan(`PRIVATE_KEY=0x${HEX64}`);
    // raw-private-key (no hash context) blocks; secret-assignment also fires (warn).
    const raw = found.find((f) => f.check === 'raw-private-key');
    expect(raw?.severity).toBe('block');
    expect(raw?.excerpt).not.toContain(HEX64);
  });
});

describe('scan — secret-assignment is a warn, not a hard block', () => {
  it('reports a real-looking assignment as a masked warn (forces confirmation)', async () => {
    const f = find('API_KEY=supersecretvalue123', 'secret-assignment');
    expect(f?.severity).toBe('warn');
    expect(f?.excerpt).not.toContain('supersecretvalue123');
    expect(f?.excerpt).toContain('[redacted');
  });

  it('does not hard-block benign config or prose (regression: review round 1)', async () => {
    for (const line of [
      'SECRET_NAME=prod-db-credentials',
      'MYSQL_ROOT_PASSWORD=password',
      'Password: correcthorsebatterystaple',
    ]) {
      const blocks = scan(line).filter((x) => x.severity === 'block');
      expect(blocks).toEqual([]);
    }
  });

  it('skips structural values (paths, URLs, regex literals) entirely', async () => {
    expect(checks('PRIVATE_KEY_PATH=/etc/ssl/server.key')).not.toContain('secret-assignment');
    expect(checks('AUTH_TOKEN_URL=https://example.com/callback')).not.toContain(
      'secret-assignment',
    );
    expect(checks('PASSWORD_REGEX=^[A-Z]{3}[0-9]+$')).not.toContain('secret-assignment');
  });

  it('skips placeholder values', async () => {
    for (const line of [
      'API_KEY=<your-key>',
      'PASSWORD=${DB_PASSWORD}',
      'SECRET=changeme',
      'API_KEY=your-key-here',
      'AUTH_TOKEN=xxxxxx',
      'AUTH_TOKEN=example-value',
    ]) {
      expect(checks(line)).not.toContain('secret-assignment');
    }
  });

  it('broadened keys (camelCase, token, credential) and quoted values with spaces', async () => {
    expect(checks('apiKey=liveSecret12345')).toContain('secret-assignment');
    expect(checks('accessToken: aVeryRealToken99')).toContain('secret-assignment');
    expect(checks('db_credential=realvalue123')).toContain('secret-assignment');
    const f = find('API_KEY="R3al Secret W1th Spaces"', 'secret-assignment');
    expect(f?.severity).toBe('warn');
    expect(f?.excerpt).not.toContain('R3al Secret W1th Spaces');
  });
});

describe('scan — warn detectors', () => {
  it('flags a 40-hex wallet address as warn, abbreviated', async () => {
    const f = find(`send to 0x${HEX40}`, 'wallet-address');
    expect(f?.severity).toBe('warn');
    expect(f?.excerpt).toMatch(/^0x.+….+$/);
    expect(f?.excerpt).not.toContain(HEX40);
  });

  it('flags CONFIDENTIAL / INTERNAL ONLY markers', async () => {
    expect(checks('This document is CONFIDENTIAL.')).toContain('confidential-marker');
    expect(checks('for INTERNAL ONLY use')).toContain('confidential-marker');
  });

  it('flags internal hostnames', async () => {
    expect(checks('db.prod.internal is the host')).toContain('internal-hostname');
    expect(checks('ssh build.corp for access')).toContain('internal-hostname');
    expect(checks('visit https://example.com/docs')).not.toContain('internal-hostname');
  });

  it('flags emails (PII, subsuming corp emails)', async () => {
    expect(checks('reach me at alice@corp.example')).toContain('email');
    expect(checks('no address here')).not.toContain('email');
  });

  it('flags phone numbers', async () => {
    expect(checks('call +1 415-555-0132 today')).toContain('phone');
    expect(checks('call (415) 555-0132 today')).toContain('phone');
    expect(checks('order number 1234567 shipped')).not.toContain('phone');
  });

  it('flags a long fenced block as verbatim, not a short one', async () => {
    const long = ['```', Array.from({ length: 90 }, (_, i) => `word${i}`).join(' '), '```'].join(
      '\n',
    );
    expect(checks(long)).toContain('long-verbatim-quote');
    const short = ['```', 'const x = 1;', '```'].join('\n');
    expect(checks(short)).not.toContain('long-verbatim-quote');
  });

  it('flags a long blockquote run', async () => {
    const quote = Array.from({ length: 90 }, (_, i) => `> word${i}`).join('\n');
    expect(checks(quote)).toContain('long-verbatim-quote');
  });
});

describe('scan — secrets are never echoed verbatim', () => {
  it('masks every secret finding so the matched secret does not appear in its excerpt', async () => {
    const secrets: Array<[string, string]> = [
      [`0x${HEX64}`, `0x${HEX64}`],
      ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
      [`ghp_${'Z'.repeat(36)}`, `ghp_${'Z'.repeat(36)}`],
      ['xoxb-123456789012-secrettail99', 'xoxb-123456789012-secrettail99'],
      [`sk_live_${'Q'.repeat(24)}`, `sk_live_${'Q'.repeat(24)}`],
      [`sk-${'a'.repeat(48)}`, `sk-${'a'.repeat(48)}`],
      [`sk-ant-api03-${'C'.repeat(30)}`, `sk-ant-api03-${'C'.repeat(30)}`],
      [`AIza${'d'.repeat(35)}`, `AIza${'d'.repeat(35)}`],
      [`npm_${'f'.repeat(36)}`, `npm_${'f'.repeat(36)}`],
      ['postgres://admin:s3cr3tpass@db.example.com', 's3cr3tpass'],
      ['Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789'],
      // secret-assignment is a warn now, but its value is still masked.
      ['API_KEY=topsecretvalue999', 'topsecretvalue999'],
    ];
    for (const [text, secret] of secrets) {
      const masked = scan(text).filter(
        (x) => x.severity === 'block' || x.check === 'secret-assignment',
      );
      expect(masked.length).toBeGreaterThan(0);
      for (const f of masked) expect(f.excerpt).not.toContain(secret);
    }
  });
});

describe('scan — determinism', () => {
  it('is a pure function of its input', async () => {
    const text = ['send to 0x' + HEX40, 'API_KEY=abcdef123456', 'CONFIDENTIAL notes'].join('\n');
    expect(scan(text)).toEqual(scan(text));
  });

  it('sorts findings by line then column', async () => {
    const text = ['CONFIDENTIAL and alice@corp.example', 'INTERNAL ONLY'].join('\n');
    const found = scan(text);
    const lines = found.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    // Line 1 has two findings, ordered by start column.
    const line1 = found.filter((f) => f.line === 1);
    expect(line1[0]!.span[0]).toBeLessThan(line1[1]!.span[0]);
  });
});

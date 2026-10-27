import { describe, it, expect } from 'vitest';
import { mask } from './redact';

/** The text no longer carries `secret` once masked. */
const hides = (text: string, secret: string): boolean => !mask(text).includes(secret);
/** Masking leaves the text byte-identical. */
const keeps = (text: string): boolean => mask(text) === text;

const HEX64 = 'a'.repeat(64);

describe('the vendor-format rows', () => {
  it('mask each vendor key shape', () => {
    // Bodies are base62 and carry a digit (real keys are high-entropy).
    const body = `${'a'.repeat(24)}7${'b'.repeat(12)}`;
    for (const secret of [
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOi.eyJzdWIiOiJhYmMxMjM0.SflKxwRJSMeKKF2QT4',
      `ghp_${'A'.repeat(36)}`,
      'xoxb-123456789012-abcdefghij',
      `sk_live_${'A'.repeat(24)}`,
      `sk-${body}`,
      `sk-proj-${body}`,
      `sk-svcacct-${body}`,
      `sk-admin-${body}`,
      `sk-ant-api03-${'C'.repeat(30)}`,
      `AIza${'d'.repeat(35)}`,
      `GOCSPX-${'e'.repeat(28)}`,
      `npm_${'f'.repeat(36)}`,
      `sbp_${'a1b2c3d4'.repeat(5)}`,
      `SK${'0f1e2d3c'.repeat(4)}`,
      `SG.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      `hf_${'Qw3rTy'.repeat(6)}`,
      `vercel_blob_rw_${'A1b2C3d4'.repeat(4)}`,
      `vcp_${'A1b2C3d4'.repeat(4)}`,
      `ntn_12345678901${'A1b2C'.repeat(7)}`,
      `lin_api_${'A1b2C3d4'.repeat(5)}`,
      `figd_${'A1b2C3d4'.repeat(6)}`,
      `glpat-${'A1b2C3d4'.repeat(4)}`,
      `dckr_pat_${'A1b2C3d4'.repeat(3)}abc`,
      `cfut_${'A1b2C3d4'.repeat(5)}0f1e2d3c`,
      `dapi${'0f1e2d3c'.repeat(4)}`,
    ]) {
      expect(hides(`deploy failed with ${secret} in the env`, secret), secret).toBe(true);
    }
  });

  it('leaves sk- kebab identifiers alone (review round 3)', () => {
    // No digit + hyphen separators: not an OpenAI key.
    expect(keeps('sk-provider-config-loader-instance-factory-x')).toBe(true);
    expect(keeps('the sk-user-profile-updated-successfully-now handler')).toBe(true);
  });

  it('masks an underscore-adjacent openai key (review round 4)', () => {
    // The base62 run terminates at `_` (a word char \b would not catch).
    expect(hides('sk-proj-abc123DEF456ghi789JKL012_mno', 'abc123DEF456ghi789JKL012')).toBe(true);
  });

  it('masks a repeated-letter key body: a boring body is still a live shape', () => {
    expect(hides(`t=ghp_${'Z'.repeat(36)}`, 'Z'.repeat(36))).toBe(true);
    expect(hides(`0x${HEX64}`, HEX64)).toBe(true);
  });

  it('masks an otpauth TOTP URI and keeps its scheme', () => {
    const uri = 'otpauth://totp/Tenjin:ops?secret=JBSWY3DPEHPK3PXP&issuer=Tenjin';
    expect(mask(uri)).toContain('otpauth://totp/');
    expect(hides(uri, 'JBSWY3DPEHPK3PXP')).toBe(true);
  });

  it('leaves benign near-misses alone', () => {
    for (const text of [
      'the total was 0x1234 wei',
      'AKIALOOKSLIKE but lowercase tail',
      'a normal sentence with no keys',
      'COUNT=42',
    ]) {
      expect(keeps(text), text).toBe(true);
    }
  });
});

describe('connection URIs and bearer tokens', () => {
  it('masks a DB password and keeps the rest of the URI, but not an example password', () => {
    expect(mask('postgres://admin:s3cr3tpass@db.example.com:5432/app')).toContain(
      'postgres://admin:[redacted]@db.example.com',
    );
    expect(hides('postgres://admin:S3cretP4ss99@db.example.com', 'S3cretP4ss99')).toBe(true);
    // Example/default and placeholder passwords stay (review round 2).
    expect(keeps('postgres://postgres:postgres@localhost:5432/db')).toBe(true);
    expect(keeps('mongodb://admin:changeme@mongo')).toBe(true);
    expect(keeps('postgres://user:<password>@host:5432/db')).toBe(true);
  });

  it('masks a live bearer token, but not a placeholder', () => {
    expect(hides('Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789')).toBe(true);
    expect(keeps('Authorization: Bearer <token>')).toBe(true);
  });

  /**
   * The placeholder test is anchored to the WHOLE captured value, never a
   * substring of it: real passwords routinely carry `<`, `>`, `{`, `}` or a
   * letter run, and a connection string is one of the commonest ways a live
   * credential reaches a transcript.
   */
  it('masks a live secret whose value merely CONTAINS a placeholder shape', () => {
    for (const [text, secret] of [
      ['postgres://appuser:Str0ng<Pw>Value@prod-db.acme.com:5432/main', 'Str0ng<Pw>Value'],
      ['mysql://root:Pa{{ss}}w0rd99@10.2.3.4:3306/app', 'Pa{{ss}}w0rd99'],
      ['postgres://appuser:realpwxxxxxx99@prod-db.acme.com/main', 'realpwxxxxxx99'],
      ['Authorization: Bearer ghp_realtokenxxxxxx0123456789abcdef', 'realtokenxxxxxx0123456789'],
      ['redis://cache:yourkeyR3al99Value@cache.acme.com:6379', 'yourkeyR3al99Value'],
      [`the docs show ghp_${'x'.repeat(36)} as the shape`, 'x'.repeat(36)],
    ] as const) {
      expect(hides(text, secret), text).toBe(true);
    }
  });
});

describe('0x-64-hex is a key or a hash by context', () => {
  it('keeps a tx hash inside a basescan URL', () => {
    expect(keeps(`https://basescan.org/tx/0x${HEX64}`)).toBe(true);
  });

  it('keeps a labelled hash (txHash:, hash =)', () => {
    expect(keeps(`txHash: 0x${HEX64}`)).toBe(true);
    expect(keeps(`blockhash = 0x${HEX64}`)).toBe(true);
  });

  /**
   * The shapes an advisory replay over 389 published posts found (tenjin#723):
   * every key-shaped hit in the live catalog was a public hex constant the old
   * window missed.
   */
  it('keeps a label separated from the value by up to two tokens', () => {
    expect(keeps(`the committee hash was 0x${HEX64}`)).toBe(true);
    expect(keeps(`source_id = 0x${HEX64}`)).toBe(true);
  });

  // Hashes are written as inline code, so the path from label to value runs
  // through markdown and quote punctuation. Separators are permissive; the
  // label SET is not.
  it('keeps a hash across backticks and quotes between the label and the value', () => {
    expect(keeps(`the committee hash was \`0x${HEX64}\``)).toBe(true);
    expect(keeps(`"id": "0x${HEX64}"`)).toBe(true);
    expect(keeps(`the root is “0x${HEX64}”`)).toBe(true);
  });

  it('keeps the widened identifier label set', () => {
    for (const label of ['salt', 'id', 'topic0', 'root', 'digest', 'commitment']) {
      expect(keeps(`${label}: 0x${HEX64}`), label).toBe(true);
    }
  });

  it('keeps a universal public constant carrying no label at all', () => {
    const topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    expect(keeps(`emitted ${topic0} first`)).toBe(true);
  });

  it('keeps the floor: the window widened, it did not open', () => {
    for (const text of [
      // Four tokens between label and value is out of window.
      `the hash of the private key is 0x${HEX64}`,
      // Words merely ENDING in a label are not labels.
      `the grid 0x${HEX64}`,
      `a valid 0x${HEX64}`,
      `PRIVATE_KEY=0x${HEX64}`,
      // Separator tolerance cannot invent a label.
      `PRIVATE_KEY=\`0x${HEX64}\``,
      `the wallet key is "0x${HEX64}"`,
    ]) {
      expect(hides(text, HEX64), text).toBe(true);
    }
  });
});

describe('secret-assignment', () => {
  it('masks a real-looking assignment, quoted values with spaces included', () => {
    for (const [text, secret] of [
      ['API_KEY=supersecretvalue123', 'supersecretvalue123'],
      ['apiKey=liveSecret12345', 'liveSecret12345'],
      ['accessToken: aVeryRealToken99', 'aVeryRealToken99'],
      ['db_credential=realvalue123', 'realvalue123'],
      ['API_KEY="R3al Secret W1th Spaces"', 'R3al Secret W1th Spaces'],
      // A quoted literal is a value, not code, even if it reads like an identifier.
      ['API_KEY="clientSecret"', 'clientSecret'],
    ] as const) {
      expect(hides(text, secret), text).toBe(true);
      expect(mask(text)).toContain('[redacted');
    }
  });

  it('leaves structural values (paths, URLs, regex literals) as written', () => {
    expect(keeps('PRIVATE_KEY_PATH=/etc/ssl/server.key')).toBe(true);
    expect(keeps('AUTH_TOKEN_URL=https://example.com/callback')).toBe(true);
    expect(keeps('PASSWORD_REGEX=^[A-Z]{3}[0-9]+$')).toBe(true);
  });

  it('leaves placeholder values as written', () => {
    for (const line of [
      'API_KEY=<your-key>',
      'PASSWORD=${DB_PASSWORD}',
      'SECRET=changeme',
      'API_KEY=your-key-here',
      'AUTH_TOKEN=xxxxxx',
      'AUTH_TOKEN=example-value',
    ]) {
      expect(keeps(line), line).toBe(true);
    }
  });

  it('leaves code-expression right-hand sides, not literals (review round A1)', () => {
    for (const line of [
      'password = user.password',
      'client_secret: config.clientSecret',
      'password=hashAndSalt(input)',
      'password = adminpassword',
    ]) {
      expect(keeps(line), line).toBe(true);
    }
    const ts = [
      'export const config = {',
      '  apiKey: process.env.API_KEY,',
      '  clientSecret: settings.clientSecret,',
      '  password: hashPassword(rawInput),',
      '};',
    ].join('\n');
    const py = [
      'DATABASE_PASSWORD = os.environ.get("DB_PASSWORD")',
      'api_key = credentials.api_key',
      'secret = derive_secret(seed)',
    ].join('\n');
    expect(keeps(ts)).toBe(true);
    expect(keeps(py)).toBe(true);
  });

  it('masks real secrets a prefix-anchored placeholder rule used to let through (review round A1)', () => {
    for (const [text, secret] of [
      ['PASSWORD=mySecretP@ss123', 'mySecretP@ss123'],
      ['API_KEY=yourCompanyProdKey_abc123', 'yourCompanyProdKey_abc123'],
      ['SECRET=exampleRealKey99', 'exampleRealKey99'],
      ['DB_PASSWORD=dummyButRealValue', 'dummyButRealValue'],
    ] as const) {
      expect(hides(text, secret), text).toBe(true);
    }
    for (const p of ['API_KEY=your-api-key', 'SECRET=changeme', 'PASSWORD=<your-password>']) {
      expect(keeps(p), p).toBe(true);
    }
  });

  it('masks a flag or header value in credential position (#281), but never bare hex', () => {
    expect(
      mask('Failed: curl --api-key 3f9a1c77b2e04d5a8c6b1e2f9d0a4b7c https://api.acme.io'),
    ).toBe('Failed: curl --api-key=[redacted 32 chars] https://api.acme.io');
    expect(
      hides(
        "curl -H 'X-Api-Key: 9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c' https://api.acme.io",
        '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
      ),
    ).toBe(true);
    // A commit SHA still syncs.
    expect(keeps('Fixed in 9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c on main')).toBe(true);
  });
});

describe('BIP-39 recovery phrases', () => {
  const SEED =
    'abandon ability able about above absent absorb abstract absurd abuse access accident';

  it('leaves prose built from wordlist words, and eleven of them, as written', () => {
    // Punctuation breaks the run: a sentence is not a phrase.
    expect(
      keeps('We abandon the ability to absorb abstract risk, then access the accident report.'),
    ).toBe(true);
    expect(keeps(SEED.split(' ').slice(0, 11).join(' '))).toBe(true);
  });
});

describe('mask() carries the key, PEM, seed-phrase and URL credential rows (#388)', () => {
  const KEY = `0x${'7e'.repeat(32)}`;
  const SEED =
    'abandon ability able about above absent absorb abstract absurd abuse access accident';

  it('masks a bare 0x key to its prefix and length', () => {
    expect(mask(`import ${KEY} into the wallet`)).toBe(
      'import 0x…[redacted 64 chars] into the wallet',
    );
  });

  it('leaves a labelled tx hash as written', () => {
    const text = `settled, txHash: ${KEY}`;
    expect(mask(text)).toBe(text);
  });

  it('masks a PEM block through its END line, or to the end when there is none', () => {
    const block =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo\n-----END RSA PRIVATE KEY-----';
    const masked = mask(`before\n${block}\nafter`);
    expect(masked).toMatch(
      /^before\n-----BEGIN RSA PRIVATE KEY-----…\[redacted \d+ chars\]\nafter$/,
    );
    expect(mask('key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC')).toBe(
      'key:\n-----BEGIN PRIVATE KEY-----…[redacted 33 chars]',
    );
  });

  it('masks a 12-word recovery phrase', () => {
    expect(mask(`restore with ${SEED} and stop`)).toBe(
      'restore with [redacted 12-word BIP-39 recovery phrase] and stop',
    );
  });

  it('keeps a wordlist run longer than any recovery phrase, but masks a 24-word one', () => {
    const long = `find the flake ${'detail '.repeat(25)}then say why`;
    expect(mask(long)).toBe(long);
    const phrase = `${SEED} ${SEED}`;
    expect(mask(`restore ${phrase} and stop`)).toBe(
      'restore [redacted 24-word BIP-39 recovery phrase] and stop',
    );
  });

  it('masks a valid phrase inside a longer wordlist run, and only the phrase', () => {
    // The BIP-39 all-zero test vectors, 12 and 24 words, each followed by more
    // wordlist words so the run is longer than any phrase.
    const twelve = `${'abandon '.repeat(11)}about`;
    const twentyFour = `${'abandon '.repeat(23)}art`;
    expect(mask(`${twelve} ${'detail '.repeat(14)}then`)).toBe(
      `[redacted 12-word BIP-39 recovery phrase] ${'detail '.repeat(14)}then`,
    );
    expect(mask(`use ${twentyFour} then please check`)).toBe(
      'use [redacted 24-word BIP-39 recovery phrase] then please check',
    );
  });

  it('masks a credential query value and keeps the parameter name', () => {
    expect(mask('https://files.acme.io/f/report.pdf?sig=Zx81QpLm0aTe&page=2')).toBe(
      'https://files.acme.io/f/report.pdf?sig=[redacted 12 chars]&page=2',
    );
  });

  it('leaves a long mixed path segment in a query', () => {
    const url = 'https://hooks.acme.io/services/x9Y8z7W6v5U4t3S2r1Q0p9O8nM';
    expect(mask(url)).toBe(url);
  });

  it('leaves ordinary URLs untouched', () => {
    const text =
      'https://docs.acme.io/list?page=2 and https://github.com/acme/app/blob/main/README.md';
    expect(mask(text)).toBe(text);
  });
});

describe('the #296 credential shapes', () => {
  it('masks a quoted secret name with a quoted value, not config keys or numbers', () => {
    expect(mask('{"user":"dana","password":"hunter2secret"}')).toBe(
      '{"user":"dana","password=[redacted 13 chars]}',
    );
    const config = '{"max_tokens": "8k4096", "tokenizer": "cl100k_base", "password": "123456"}';
    expect(mask(config)).toBe(config);
  });

  it('masks an Authorization: Basic credential and keeps the header', () => {
    expect(mask('Authorization: Basic ZGFuYTpodW50ZXIyc2VjcmV0')).toBe(
      'Authorization: Basic …[redacted 24 chars]',
    );
  });

  it('masks the password of curl -u and keeps the user', () => {
    expect(mask('curl -u dana:hunter2secret https://api.acme.io')).toBe(
      'curl -u dana=[redacted 13 chars] https://api.acme.io',
    );
  });

  it('masks an empty-user connection URI on a single-label host', () => {
    expect(mask('ECONNREFUSED redis://:hunter2secret@cache:6379')).toBe(
      'ECONNREFUSED redis://:[redacted]@cache:6379',
    );
  });

  it('counts a seed phrase whose words sit inside quotes', () => {
    const text =
      'MNEMONIC="abandon ability able about above absent absorb abstract absurd abuse access accident"';
    expect(mask(text)).toContain('[redacted 12-word BIP-39 recovery phrase]');
    expect(mask(text)).not.toContain('abandon');
  });
});

describe('webhook tokens in a query (#489)', () => {
  // Split so the committed bytes carry no contiguous webhook URL for a scanner.
  const SLACK = ['x9Y8z7W6v5U4', 't3S2r1Q0p9O8'].join('');
  const DISCORD = [
    'Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St0Uv1Wx',
    'Yz2Ab4Cd6Ef8Gh0Jk2Lm4Np6Qr8St0Uv1WxYz2A',
  ].join('');

  it('masks a Slack and a Discord webhook token', () => {
    expect(mask(`post to https://hooks.slack.com/services/T0A1B2C3D/B0E4F5G6H/${SLACK}`)).toBe(
      'post to https://hooks.slack.com/services/T0A1B2C3D/B0E4F5G6H/…[redacted 24 chars]',
    );
    expect(mask(`post to https://discord.com/api/webhooks/123456789012345678/${DISCORD}`)).toBe(
      `post to https://discord.com/api/webhooks/123456789012345678/…[redacted ${DISCORD.length} chars]`,
    );
  });

  it('leaves a public underscore slug alone', () => {
    const url =
      'https://www.reddit.com/r/rust/comments/1dh773j/report_on_the_rustnl_2024_unconference/';
    expect(mask(url)).toBe(url);
  });
});

describe('the #388 follow-up shapes', () => {
  const HEX = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const SHA40 = '3f9a1c77b2e04d5a8c6b1e2f9d0a4b7c3f9a1c77';

  it('masks a 40-hex node key in a URL path, but not a commit on a git path or host', () => {
    expect(mask(`https://my-node.base-mainnet.quiknode.pro/${SHA40}/`)).toBe(
      'https://my-node.base-mainnet.quiknode.pro/…[redacted 40 chars]/',
    );
    for (const url of [
      `https://github.com/acme/app/commit/${SHA40}`,
      `https://git.acme.io/acme/app/-/tree/${SHA40}/src`,
      `https://github.com/acme/app/pull/12/files/${SHA40}`,
    ]) {
      expect(mask(url)).toBe(url);
    }
  });

  it('masks a bare 64-hex key unless a hash label or a URL makes it a hash', () => {
    expect(mask(`import ${HEX} now`)).toBe('import …[redacted 64 chars] now');
    for (const text of [
      `sha256: ${HEX}`,
      `the tx is ${HEX}`,
      `checksum ${HEX}`,
      `**sha256**\n- before upload: \`${HEX}\``,
      `https://explorer.acme.io/search?q=${HEX}`,
    ]) {
      expect(mask(text)).toBe(text);
    }
  });

  it('keeps a 0x key after a hash label as a hash, as designed', () => {
    const text = `txHash: 0x${HEX}`;
    expect(mask(text)).toBe(text);
  });

  it('masks a key split 32+32 by one space or newline, but not a list of three', () => {
    const [a, b] = [HEX.slice(0, 32), HEX.slice(32)];
    expect(mask(`key 0x${a} ${b} end`)).toBe('key …[redacted 67 chars] end');
    expect(mask(`key\n${a}\n${b}\nend`)).toBe('key\n…[redacted 65 chars]\nend');
    const md5s = `${a}\n${b}\n${a}`;
    expect(mask(md5s)).toBe(md5s);
  });

  it('masks a Solana secret key as base58 or as a keygen array, not a public key', () => {
    const secret =
      '5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviUkauRiTMD8DrESdrNjN8zd9mTmVhRvBJeg5vhyvgrAhG';
    expect(mask(`key ${secret}`)).toBe('key …[redacted 88 chars]');
    const bytes = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    expect(mask(`id.json: ${JSON.stringify(bytes)}`)).toMatch(
      /^id\.json: \[…\[redacted \d+ chars\]$/,
    );
    const pubkey = 'send to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    expect(mask(pubkey)).toBe(pubkey);
    const short = `[${bytes.slice(0, 63).join(',')}]`;
    expect(mask(short)).toBe(short);
  });

  it('masks a checksum-valid phrase written in any case, with commas or across lines', () => {
    const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const phrase = '[redacted 12-word BIP-39 recovery phrase]';
    const capitalized = words.replace(/\b\w/g, (c) => c.toUpperCase());
    expect(mask(`seed: ${capitalized}.`)).toBe(`seed: ${phrase}.`);
    expect(mask(`seed: ${words.split(' ').join(', ')}`)).toBe(`seed: ${phrase}`);
    const lines = words.split(' ');
    expect(mask(`${lines.slice(0, 6).join(' ')}\n${lines.slice(6).join(' ')}`)).toBe(phrase);
    // Twelve wordlist words that are not a phrase stay as written.
    const list =
      'Abandon, Ability, Able, About, Above, Absent, Absorb, Abstract, Absurd, Abuse, Access, Accident';
    expect(mask(list)).toBe(list);
  });
});

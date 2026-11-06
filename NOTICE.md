# Third-Party Notices

## BlockRun MCP

Portions of this project are adapted from
[BlockRun MCP](https://github.com/BlockRunAI/blockrun-mcp) (MIT), by way of the
archived `BackTrackCo/tenjin-mcp` prototype, including:

- the local wallet lifecycle and safety model (lazily created key file with
  mode `0600`, fund-small posture);
- the buy-safety flow: hard price ceiling plus explicit confirmation, with a
  fresh challenge re-fetch and refusal to sign if the live price increased;
- the `wallet export --yes` gate (printing a private key requires an explicit
  extra flag);
- the wallet-key leak scanner concept (warn about keys pasted into agent
  configs without echoing them);
- MCP client install snippets and the skill-doc language treating purchased
  content as untrusted data, never instructions.

BlockRun MCP is licensed under the MIT License:

> MIT License
>
> Copyright (c) 2025 BlockRun AI
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## gitleaks

The provider secret-token shape patterns in the CLI's secret redaction rules are
adapted from the [gitleaks](https://github.com/gitleaks/gitleaks) ruleset (MIT),
by Zachary Rice: AWS access keys, GitHub classic and fine-grained tokens,
Slack/Stripe/npm/Anthropic/OpenAI/Google/Supabase/Twilio/SendGrid/Hugging Face
tokens, JWTs, and the PEM private-key marker. They live as data in
`src/lib/redact-rules.json`, one entry per detector, each naming its gitleaks rule
in its `source` field; `src/lib/redact.ts` compiles that data. The regexes are
vendored and adapted, not imported: gitleaks is not a runtime dependency (the
scan is pure and offline by design).

Nothing in this scan derives from TruffleHog, which is AGPL-licensed.

gitleaks is licensed under the MIT License:

> MIT License
>
> Copyright (c) 2019 Zachary Rice
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## secretlint

The gitleaks port above was diffed against
[secretlint](https://github.com/secretlint/secretlint)'s
`@secretlint/secretlint-rule-preset-recommend` (MIT), by azu. Eight token shapes
present there and absent from the gitleaks subset are adapted from its rule
packages, each credited in its `source` field in `src/lib/redact-rules.json`:
Vercel platform tokens, Notion, Linear, Figma, GitLab, Docker Hub, Cloudflare,
and Databricks. secretlint is not a runtime dependency.

secretlint is licensed under the MIT License:

> MIT License
>
> Copyright (c) 2020 azu
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## BIP-39 English wordlist

`src/lib/bip39-wordlist.json` vendors the 2048-word English wordlist from
[BIP-0039](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt), as
distributed by [@scure/bip39](https://github.com/paulmillr/scure-bip39) (MIT,
Copyright (c) 2022 Paul Miller). It is data for the `bip39-seed-phrase`
detector; no BIP-39 implementation is used or bundled.

## tenjin-mcp

This repository absorbs, with credit, patterns from the archived
[`BackTrackCo/tenjin-mcp`](https://github.com/BackTrackCo/tenjin-mcp)
standalone MCP server (MIT), whose Tenjin-specific modifications are
Copyright (c) 2026 Tenjin contributors.

Tenjin-specific code in this repository is Copyright (c) 2026 BackTrackCo and
Tenjin contributors.

## hash-wasm

The wallet derivation worker bundles hash-wasm 4.12.0 (MIT), including its
scrypt implementation by Colin Percival and SHA-256 implementation by Aleksey
Kravchenko. Their notices are reproduced below.

MIT License

Copyright (c) 2020 Dani Biró

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### scrypt

Copyright 2009 Colin Percival
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.

This file was originally written by Colin Percival as part of the Tarsnap
online backup system.

Modified for hash-wasm by Dani Biró

### SHA-256

sha256.c - an implementation of SHA-256/224 hash functions
based on FIPS 180-3 (Federal Information Processing Standart).

Copyright (c) 2010, Aleksey Kravchenko <rhash.admin@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

Modified for hash-wasm by Dani Biró

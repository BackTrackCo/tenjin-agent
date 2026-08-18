---
'tenjin-cli': patch
---

Publish-safety scan hardening. Twenty new detectors, and the rule corpus moves
out of code into `src/lib/scan-rules.json` as data (detector id, tier, pattern,
description, attribution) so the same corpus can be enforced server-side.

Block tier: BIP-39 seed phrases (twelve or more consecutive wordlist words) and
`otpauth://` TOTP URIs close the wallet-shaped gap a hex-key-only scanner had;
OpenSSH private keys pasted without PEM framing; and Supabase, Twilio, SendGrid,
Hugging Face, Vercel, Notion, Linear, Figma, GitLab, Docker Hub, Cloudflare, and
Databricks token shapes. Warn tier: RFC1918/loopback endpoints, collaboration
workspace links (Google Docs/Drive, Notion, Figma, Slack archives, Linear,
Jira), cloud resource ids (AWS ARNs, GCP resource names, Azure subscription
paths, bucket URIs), pasted `.env` blocks, and a generic Shannon-entropy
catch-all for unknown credential formats.

Placeholder suppression drops docs-shaped matches (`sk-xxxx`, `<YOUR_KEY>`,
`user@example.com`) before they reach the findings list, so a documentation
sample cannot teach an operator to skim findings. Warn tier only: the block tier
stays non-bypassable, and its own suppressions are anchored to the captured
secret value rather than matched as a substring, so a live password containing
`<`, `>`, `{`, `}` or an `x` run still blocks.

The `raw-private-key` to `hex32-value` demotion widens, so quoting a public
32-byte value no longer refuses a publish: the label set gains `salt`, `id`,
`topic`, `root`, `digest`, and `commitment`, a label may now sit up to two short
tokens before the value (`the committee hash was 0x…`, `source_id = 0x…`), and
well-known public constants such as the ERC-20 `Transfer` event topic0 are
recognized from a data list. Demotion is to warn only. An unlabeled bare 64-hex
still blocks, and a real key mislabeled `hash` still surfaces for review.

A labeled fixture corpus (`src/lib/scan-corpus.json`, positives and benign
lookalikes for every detector, plus an adversarial transcript-shaped sample)
holds per-detector precision and recall at 1.0 in CI, so a detector edit shows
its false-positive cost. The same suite enforces the redaction invariant — a
finding carries a detector id, a tier, offsets, and a masked excerpt, never the
matched secret — and a ReDoS budget against transcript-scale input, which caught
and fixed four quadratic paths (`email`, `internal-hostname`,
`db-connection-uri`, and the hash-label lookback).

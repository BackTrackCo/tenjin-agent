---
'tenjin-cli': minor
---

`tenjin pay`, `tenjin discover`, and the `bazaarPay` toggle: the standard x402
client verb, for every paid endpoint instead of only marketplace pieces.

`tenjin pay <url> [-X GET|POST] [-d <json>] [--max-price <usd>] [--yes]` probes,
delivers a 2xx free, and pays a 402 through the same money gates as `buy`
(spend policy, price cap, session budget, confirm; `--yes` clears only the
confirm), signing with `buildExactPayment`'s existing exact-scheme,
canonical-USDC-on-Base pin. No SIWX ever rides this verb, redirects fail closed
on both legs, and there is deliberately no library dedupe: every paid call
pays, and the session budget and `--max-price` are the brakes. The configured
base URL is always payable, which covers Tenjin's paid `/api/answer` and
`/api/phone-lookup` today and every future paid route without a CLI release.

Any other https origin is the Bazaar lane, off by default. It opens only when
the operator turns the new `bazaarPay` config key on (`tenjin install` asks
once, default no, both answers remembered; headless installs never enable it)
AND a configured registry (`bazaarRegistries`, default CDP's Bazaar and
UltraVioleta, both verified keyless) publicly lists the exact resource with
terms the live 402 does not exceed: same scheme, network, asset, and payTo,
live amount at most the advertised one, looked up by the live payTo so a
tampered 402 finds nothing. A mismatch is the new `REGISTRY_MISMATCH` refusal
(exit 3) before anything is signed; unreachable registries fail the lane
closed. This is provenance, not endorsement: listings are settlement-derived
and unvetted, and the spend policy still bounds the money.

`tenjin discover [query]` lists or searches those registries via the SDK's own
bazaar client: free, keyless, wallet-untouched, available with the toggle off
(a stderr hint says the lane is off), MCP-type listings counted but not shown.
Because `bazaarPay` is a skill-shaping key, the installed skill mentions the
lane only while it is on: `config set bazaarPay` re-materializes the installed
skills immediately, the hosted mirror included. `tenjin pay` joins the opt-in
permission tier beside `buy`, with the same never-a-spend-grant caveats.

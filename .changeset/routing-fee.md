---
'tenjin-cli': patch
---

The client side of the routing fee. Once Tenjin's server answers its paid routing
path, each routing call costs a flat $0.003 over x402 `batch-settlement`, paid by
`tenjin mcp` through `@x402/fetch`'s `wrapFetchWithPayment` with the stock
`BatchSettlementEvmScheme`. The wallet has one routing channel, kept in the SDK's own
file storage. When the channel cannot cover the next fee, the call carries a deposit of
up to $0.25, sized down to `maxAutoSpend` while that still covers ten fees. The fee
is the spend and the deposit is channel funding: each fee is reserved in the spend
ledger before it is signed, so `maxAutoSpend`, `sessionBudget` and `allowlistCreators`
apply to it, and `tenjin status` shows it. The deposit stays yours until spent, so only
`maxAutoSpend`, `allowlistCreators` and the wallet's balance bound it. `tenjin install`
names the fee and its deposits in its spend-limit question, and approving the limits
approves the fee. An install whose limits were approved before this release pays the
fee inside those same limits ($0.25 a call and $5 a day by default), and `tenjin update`
names the fee when it runs.

A routing call that cannot be paid takes the free path: a wallet below the deposit, a
wallet `tenjin mcp` cannot unlock without a prompt, a limit that refuses the fee or the deposit, a
failed payment, or another session's call on the channel at that moment. The first such
call in a session shows you one line with the reason and the fix (`tenjin wallet fund
0.25`, `TENJIN_WALLET_PASSPHRASE`, or `tenjin doctor`), and `tenjin doctor` names the
same reasons. The native tools are never blocked for it. While the router charges no
fee, the wallet is not touched and nothing is said.

The router's hook entries are now Claude Code `mcp_tool` hooks that call the new
`hook` tool of the session's `x402` server, so every routing step runs in the one
process that holds the wallet; `tenjin install --refresh` (which `tenjin update` runs)
rewrites the older `tenjin hook` command entries into them. Install and refresh also
write `mcp__x402__hook` into `permissions.deny`, which hides that tool from the model
while the hook calls still run, and the tool reads only a transcript under Claude
Code's projects directory (`$CLAUDE_CONFIG_DIR/projects` when set) named for its
session. `tenjin hook <kind>` stays for hosts with no MCP server, on the free path.

The `@x402/*` SDK moves to 2.28.0, and `@x402/fetch` 2.28.0 is added. With it, every
provider payment carries Tenjin's builder code in the SDK's own `builder-code`
extension, also to sellers that never asked for one, and the SDK's per-payment cap is
set to the amount your spend policy authorized, so a payment you approved above the
SDK's $1 default still signs.

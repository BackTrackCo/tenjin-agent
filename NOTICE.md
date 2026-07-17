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

## tenjin-mcp

This repository absorbs, with credit, patterns from the archived
[`BackTrackCo/tenjin-mcp`](https://github.com/BackTrackCo/tenjin-mcp)
standalone MCP server (MIT), whose Tenjin-specific modifications are
Copyright (c) 2026 Tenjin contributors.

Tenjin-specific code in this repository is Copyright (c) 2026 BackTrackCo and
Tenjin contributors, licensed under this project's MIT License.

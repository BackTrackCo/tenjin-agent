# Working on the Tenjin CLI

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for development and PR guidance.

Read the [safety model](./docs/safety-model.md) before changing permissions, payments or data sharing. Keep scan, spend, routing-packet redaction and ownership checks intact when fixing tests. A DeepSeek worker's forwarded tool results are deliberately not masked, as a native subagent's are not; what stays is the by-value removal of the job's own tokens and the wallet key and passphrase, the keychain and wallet walls, and the consent text that says so. Do not widen or drop them to fix a test.

import type { Address, Hex, TransactionSerializable, TypedDataDefinition } from 'viem';

/**
 * The wallet seam. Commands resolve a WalletProvider and never touch a raw key:
 * `describe()` is enough for `show`/`balance` (address + posture, no signing),
 * and `getSigner()` returns a structural signer only when a command needs to
 * sign (B2+). Local and explicitly connected external signers are adapters that
 * implement these interfaces, not forks of the command callers.
 */

/**
 * Where a provider's key material lives. Local and ClawRouter providers report
 * `file` or `env`; `keychain`/`remote` exist so a hosted or OS-keychain signer
 * can describe its true source honestly instead of masquerading as `env`.
 */
export type CredentialSource = 'file' | 'env' | 'keychain' | 'remote';

/**
 * `client-only`: guardrails (spend limits, allowlist) are enforced in this
 * process and any local caller can bypass them. `provider`: the signer refuses
 * out-of-policy requests server-side. `describe()` reports this so agents and
 * humans see the honest custody posture. B1's `local` provider is `client-only`.
 */
export type PolicyEnforcement = 'client-only' | 'provider';

export interface WalletDescription {
  address: Address;
  provider: string;
  credentialSource: CredentialSource;
  policyEnforcement: PolicyEnforcement;
}

/**
 * Provider-owned custody diagnostics for `show`/`doctor`. Each provider reports its
 * OWN warnings and path: the local provider knows about file perms and an env key
 * shadowing its file, a remote provider has none of that. Callers render exactly
 * what the active provider returns, so a remote provider's output can never be
 * contaminated by a stale local wallet file. `walletPath` is present only when the
 * provider is backed by an on-disk file that exists.
 */
export interface WalletDiagnostics {
  walletPath?: string;
  /**
   * Human description of how the key is protected at rest, e.g.
   * "encrypted (keystore v3, scrypt)". Present only for an on-disk encrypted
   * wallet; a remote or env-only credential has no at-rest file to describe.
   */
  keyStorage?: string;
  /**
   * Where the decryption passphrase resolves from, when it is cheap and
   * side-effect-free to know (the env passphrase). Omitted when reporting it
   * would require a keychain or TTY probe — `show` must never trigger one.
   */
  passphraseSource?: string;
  /**
   * Addresses of wallets parked by `wallet create --replace` (their keystores
   * live at wallet.<address>.json.bak beside the active wallet, with their
   * passphrases preserved per-address in the OS store). A recovery hint only —
   * the single-active-wallet model is unchanged and nothing else reads these.
   * Present only when at least one archive exists; discovered by a cheap dir
   * scan, never a keychain probe.
   */
  archivedWallets?: string[];
  warnings: string[];
}

/**
 * Structural signer. All methods are async because a remote signer can require
 * network authorization and can refuse by policy — the local provider just wraps
 * a viem account, but callers must not assume signing is synchronous or free.
 *
 * `signTransaction` is the ONLY door to a raw signed transaction (the `tenjin
 * send` escape hatch); there is deliberately no second signing path outside this
 * seam. A hosted provider whose backend cannot produce a raw signed transaction
 * (or refuses one by policy) must throw a coded error here rather than sign
 * through some other channel.
 */
export interface TenjinSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
  signTypedData(args: TypedDataDefinition): Promise<Hex>;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
}

/**
 * Whether the credential can actually produce a signature, as far as the provider
 * can tell WITHOUT prompting anyone.
 *
 * `unverified` is the honest third answer and the reason this type is not a
 * boolean: a keystore whose passphrase is only reachable through a TTY prompt is
 * neither proven good nor proven bad, and reporting either would be a guess.
 */
export type WalletVerification =
  | { status: 'verified'; detail: string }
  | { status: 'unverified'; detail: string }
  | { status: 'broken'; detail: string; fix: string };

export interface WalletProvider {
  id: string;
  describe(): Promise<WalletDescription>;
  getSigner(): Promise<TenjinSigner>;
  /** Provider-owned custody warnings; keyless, safe for `show`/`doctor`. */
  diagnostics(): Promise<WalletDiagnostics>;
  /**
   * Prove the credential can sign, for `doctor` only (#70: a keystore whose
   * passphrase is gone reported `wallet: ok` until the first signing failed).
   *
   * Two hard constraints, because `doctor` is an allowlisted verb an unattended
   * agent runs on its own: it MUST NOT prompt, and it MUST NOT mutate anything
   * (no legacy-slot re-key, no cache write) — a diagnostic that changes the thing
   * it is diagnosing is not one. A provider that cannot answer under those terms
   * omits the method entirely, and `doctor` reports the wallet as present but
   * unverified rather than inventing a verdict for it.
   */
  verify?(): Promise<WalletVerification>;
}

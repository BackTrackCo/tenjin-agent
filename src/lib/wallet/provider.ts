import type { Address, Hex, TransactionSerializable, TypedDataDefinition } from 'viem';
import type { DurableStore, SigningSource, UnlockReason } from '../wallet-unlock';

/**
 * The wallet seam. Commands resolve a WalletProvider and never touch a raw key:
 * `describe()` is enough for `show`/`balance`, and `getSigner()` returns a
 * signer only when a command signs. A hosted signer would be another adapter
 * for these interfaces, not a change to the callers.
 */

/**
 * Where a provider's key material lives. The `local` provider reports `file`
 * or `env`; `keychain`/`remote` let another signer name its true source.
 */
export type CredentialSource = 'file' | 'env' | 'keychain' | 'remote';

/**
 * `client-only`: guardrails (spend limits, allowlist) are enforced in this
 * process and any local caller can bypass them. `provider`: the signer refuses
 * out-of-policy requests server-side. The `local` provider is `client-only`.
 */
export type PolicyEnforcement = 'client-only' | 'provider';

export interface WalletDescription {
  address: Address;
  provider: string;
  credentialSource: CredentialSource;
  policyEnforcement: PolicyEnforcement;
}

/**
 * Provider-owned custody diagnostics for `show`/`doctor`. Callers render only
 * what the active provider returns, so a stale local wallet file never leaks
 * into another provider's output.
 */
export interface WalletDiagnostics {
  /** Present only when the provider is backed by an on-disk file that exists. */
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
   * Addresses of wallets parked by `wallet create --replace` as
   * `wallet.<address>.json.bak`. A recovery hint only, found by a dir scan,
   * never a keychain probe.
   */
  archivedWallets?: string[];
  /**
   * Where the passphrase sidecar (`passphrase-store.json`) says this wallet's
   * passphrase was saved. A file read, never a store probe, so `show` stays
   * free of keychain prompts. Absent when there is no record for the wallet.
   */
  passphraseStore?: DurableStore;
  warnings: string[];
}

/**
 * Structural signer. Every method is async because a remote signer can need
 * network authorization or refuse by policy.
 *
 * `signTransaction` is the only door to a raw signed transaction (`tenjin
 * send`). A provider that cannot or will not produce one throws a coded error
 * here rather than sign through another channel.
 */
export interface TenjinSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
  signTypedData(args: TypedDataDefinition): Promise<Hex>;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
}

/**
 * Whether the credential can produce a signature, as far as the provider can
 * tell without prompting anyone. `unverified` covers a keystore whose
 * passphrase only a TTY prompt can reach: neither proven good nor bad.
 *
 * `reason` is the same {@link UnlockReason} the signing path throws.
 * `unverified` with `keychain_locked` or `unlock_timeout` is unknown; with
 * `passphrase_missing` it is definite. `source` and `warning` on `verified` say
 * what opened the wallet, and that a wrong TENJIN_WALLET_PASSPHRASE was skipped.
 */
export type WalletVerification =
  | { status: 'verified'; detail: string; source?: SigningSource; warning?: string }
  | { status: 'unverified'; detail: string; reason?: UnlockReason }
  | { status: 'broken'; detail: string; fix: string; reason?: UnlockReason };

export interface WalletProvider {
  id: string;
  describe(): Promise<WalletDescription>;
  getSigner(): Promise<TenjinSigner>;
  /** Provider-owned custody warnings; keyless, safe for `show`/`doctor`. */
  diagnostics(): Promise<WalletDiagnostics>;
  /**
   * Prove the credential can sign, for `doctor` only. An unattended agent runs
   * `doctor`, so this must not prompt and must not mutate anything (no re-key,
   * no cache write). A provider that cannot answer on those terms omits it, and
   * `doctor` reports the wallet as unverified.
   */
  verify?(): Promise<WalletVerification>;
}

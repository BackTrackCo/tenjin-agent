import type { Address, Hex, TypedDataDefinition } from 'viem';

/**
 * The wallet seam. Commands resolve a WalletProvider and never touch a raw key:
 * `describe()` is enough for `show`/`balance` (address + posture, no signing),
 * and `getSigner()` returns a structural signer only when a command needs to
 * sign (B2+). B1 ships exactly one provider (`local`); a hosted signer later is
 * an adapter that implements these interfaces, not a refactor of the callers.
 */

/**
 * Where a provider's key material lives. B1's `local` provider only ever reports
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
  warnings: string[];
}

/**
 * Structural signer. All methods are async because a remote signer can require
 * network authorization and can refuse by policy — the local provider just wraps
 * a viem account, but callers must not assume signing is synchronous or free.
 */
export interface TenjinSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
  signTypedData(args: TypedDataDefinition): Promise<Hex>;
}

export interface WalletProvider {
  id: string;
  describe(): Promise<WalletDescription>;
  getSigner(): Promise<TenjinSigner>;
  /** Provider-owned custody warnings; keyless, safe for `show`/`doctor`. */
  diagnostics(): Promise<WalletDiagnostics>;
}

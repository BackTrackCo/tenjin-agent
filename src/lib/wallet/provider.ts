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

/**
 * One proposed spend, evaluated by the provider BEFORE any signing happens.
 * Policy enforcement lives here (D35): the local provider evaluates the config
 * guardrails, and a hosted provider can refuse server-side through the same
 * seam. `explicitApproval` marks a caller-carried human/agent approval
 * (`--yes`), which substitutes for the confirm step but never for the budget.
 */
export interface SpendRequest {
  amountAtomic: string;
  creatorHandle?: string;
  resourceId?: string;
  title?: string;
  explicitApproval: boolean;
}

export interface SpendDecision {
  /**
   * `allow`: within policy, proceed with no prompt. `confirm`: out of the quiet
   * policy but permissible with an interactive confirmation. `refuse`: never
   * proceed (budget exhausted), regardless of confirmation.
   */
  decision: 'allow' | 'confirm' | 'refuse';
  reasons: string[];
}

/** Handle for a ledger entry written by reserveSpend, releasable if no money moves. */
export interface SpendReservation {
  id: string;
}

export interface WalletProvider {
  id: string;
  describe(): Promise<WalletDescription>;
  getSigner(): Promise<TenjinSigner>;
  /** Provider-owned custody warnings; keyless, safe for `show`/`doctor`. */
  diagnostics(): Promise<WalletDiagnostics>;
  /** Evaluate a proposed spend against policy. Never signs, never prompts. */
  authorizeSpend(req: SpendRequest): Promise<SpendDecision>;
  /**
   * Atomically re-check the session budget and append a ledger entry, BEFORE any
   * payment is signed. Concurrent buys serialize on the ledger lock here, so the
   * budget cannot be overshot by parallel invocations racing an unlocked read.
   * Throws REFUSED when the budget would be exceeded. The entry stays if money
   * moves (or might have); releaseSpend undoes it when payment definitely
   * did not settle.
   */
  reserveSpend(req: { amountAtomic: string; resourceId?: string }): Promise<SpendReservation>;
  /** Remove a reservation whose payment is KNOWN not to have settled. */
  releaseSpend(reservation: SpendReservation): Promise<void>;
}

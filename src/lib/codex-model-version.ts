/** These exact builds passed the native MCP, execpolicy and sandbox proofs.
 * A new release, including another prerelease, requires qualification first. */
export const QUALIFIED_CODEX_MODEL_VERSIONS = ['0.163.0', '0.167.0-alpha.4.1'] as const;

export function isQualifiedCodexModelVersion(value: unknown): boolean {
  return (
    typeof value === 'string' && QUALIFIED_CODEX_MODEL_VERSIONS.some((version) => version === value)
  );
}

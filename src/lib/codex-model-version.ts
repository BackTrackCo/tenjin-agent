/** Native MCP, execpolicy and sandbox qualification is version-specific. */
export const QUALIFIED_CODEX_MODEL_VERSIONS = ['0.163.0', '0.167.0-alpha.4.1'] as const;

export function isQualifiedCodexModelVersion(value: unknown): boolean {
  return (
    typeof value === 'string' && QUALIFIED_CODEX_MODEL_VERSIONS.some((version) => version === value)
  );
}

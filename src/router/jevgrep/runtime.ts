/** Exact npm releases qualified for the local native-evaluation bridge. */
export const QUALIFIED_JEVGREP_RELEASES = Object.freeze(['0.7.0'] as const);
export function isQualifiedJevgrepRelease(
  version: string,
): version is (typeof QUALIFIED_JEVGREP_RELEASES)[number] {
  return QUALIFIED_JEVGREP_RELEASES.some((qualified) => qualified === version);
}

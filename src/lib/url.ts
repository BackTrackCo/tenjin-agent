/** Drop trailing slashes from a base URL so `${base}/path` never doubles a slash. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

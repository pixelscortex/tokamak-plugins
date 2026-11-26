/** The last part of a path, as shown in rows and chips: ~/code/invoices-app → invoices-app. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * A folder must be a full path on the sender's computer: `/…`, `~/…` or a
 * Windows drive. A relative path would depend on where a program happens to start.
 */
export function isFullPath(path: string): boolean {
  return /^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(path.trim());
}

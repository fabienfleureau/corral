// Cache headers for web/dist. Vite hashes everything under /assets/, so those
// files can be cached forever; the shell and the service worker must be
// revalidated every time so a deploy is picked up.

export function cacheControlFor(urlPath: string): string {
  // Only Vite's content-hashed bundles live here — a same-named file never
  // changes content.
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

/** Cheap strong validator: size + mtime of the file on disk. */
export function etagFor(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`;
}

/** Does an If-None-Match header match this ETag? Handles lists and W/ prefixes. */
export function isFresh(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = etag.replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

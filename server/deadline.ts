// Bounded waits for calls a page load depends on. A page must always answer:
// when a dependency (worker backend, quota API) stalls, the handler serves its
// last-known value instead of hanging the request until the browser gives up.

export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
